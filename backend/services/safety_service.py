"""Safety Setup service (QGC-style) for ArduCopter — Phase 8G.

Single backend authority for SETUP -> Safety. Everything is derived from the
live vehicle, never fabricated:

  * battery failsafe     -> BATT_LOW_VOLT / BATT_CRT_VOLT / BATT_LOW_MAH /
                            BATT_CRT_MAH / BATT_LOW_TIMER / BATT_FS_LOW_ACT /
                            BATT_FS_CRT_ACT / BATT_FS_VOLTSRC (when present)
  * radio failsafe       -> FS_THR_ENABLE / FS_THR_VALUE / FS_OPTIONS
  * GCS failsafe         -> FS_GCS_ENABLE (when present)
  * return to launch     -> RTL_ALT / RTL_LOIT_TIME / RTL_ALT_FINAL /
                            LAND_SPEED / related RTL_* params (when present)
  * arming checks        -> ARMING_CHECK bitmask (when present + metadata),
                            otherwise the ARMING_* params the firmware exposes
  * advanced set         -> actual FS_* / RTL_* / ARMING_* / BATT_FS_* params
                            discovered from the connected vehicle, organised
                            into categories
  * metadata             -> official ArduPilot parameter metadata (definitions,
                            ranges, units, reboot, enum values, bitmasks)

ArduCopter-only. Writes go through the shared verified parameter pipeline.
Never confirms a write until the vehicle echoes PARAM_VALUE.

The GCS only reads and configures the flight controller's failsafe parameters.
It never independently executes RTL / Land / SmartRTL / Brake / disarm /
mode changes or any flight action.
"""

import time
from typing import Any, Dict, List, Optional, Tuple

from core.state import get_vehicle_status
from mavlink.parameter_manager import parameter_manager
from services.parameter_metadata import metadata_provider

COPTER_VEHICLE_TYPES = {
    "QUADROTOR", "TRICOPTER", "HEXAROTOR", "OCTOROTOR", "COAXIAL",
    "HELICOPTER", "VTOL_QUADROTOR", "VTOL_TILTROTOR", "VTOL_RESERVED2",
    "VTOL_RESERVED3", "VTOL_RESERVED4", "VTOL_RESERVED5",
}

STATE_WAITING = "WAITING"
STATE_CONNECTING = "CONNECTING"
STATE_SYNCING = "SYNCING"
STATE_READY = "READY"
STATE_CONNECTION_LOST = "CONNECTION_LOST"
STATE_UNSUPPORTED = "UNSUPPORTED"
STATE_ERROR = "ERROR"

# Logical slots may resolve to a different parameter depending on the firmware
# generation (e.g. modern Copter names RTL altitudes *_M and splits ARMING_CHECK
# into ARMING_*). The first candidate that actually exists is used; the chosen
# param id is returned so the UI can show what it is really reading.
_BATTERY_LOW_VOLT = ["BATT_LOW_VOLT"]
_BATTERY_CRT_VOLT = ["BATT_CRT_VOLT"]
_BATTERY_LOW_MAH = ["BATT_LOW_MAH"]
_BATTERY_CRT_MAH = ["BATT_CRT_MAH"]
_BATTERY_LOW_TIMER = ["BATT_LOW_TIMER"]
_BATT_FS_LOW_ACT = ["BATT_FS_LOW_ACT"]
_BATT_FS_CRT_ACT = ["BATT_FS_CRT_ACT"]
_BATT_FS_VOLTSRC = ["BATT_FS_VOLTSRC"]
_RTL_ALT = ["RTL_ALT", "RTL_ALT_M"]
_RTL_ALT_FINAL = ["RTL_ALT_FINAL", "RTL_ALT_FINAL_M"]
_RTL_LOIT_TIME = ["RTL_LOIT_TIME"]
_LAND_SPEED = ["LAND_SPEED"]
_RTL_CONE_SLOPE = ["RTL_CONE_SLOPE"]
_RTL_CLIMB_MIN = ["RTL_CLIMB_MIN", "RTL_CLIMB_MIN_M"]
_RTL_SPEED = ["RTL_SPEED", "RTL_SPEED_MS"]
_FS_OPTIONS = ["FS_OPTIONS"]
_FS_THR_ENABLE = ["FS_THR_ENABLE"]
_FS_THR_VALUE = ["FS_THR_VALUE"]
_FS_GCS_ENABLE = ["FS_GCS_ENABLE"]
_FS_GCS_TIMEOUT = ["FS_GCS_TIMEOUT"]
_ARMING_CHECK = ["ARMING_CHECK"]
_RC_THROTTLE_MIN = ["RC3_MIN"]
_RC_THROTTLE_MAX = ["RC3_MAX"]

# GeoFence parameters. The Safety page only *configures* these — the actual
# fence geometry still lives in PLAN -> GeoFence, which is unchanged.
_FENCE_ENABLE = ["FENCE_ENABLE"]
_FENCE_ACTION = ["FENCE_ACTION"]
_FENCE_RADIUS = ["FENCE_RADIUS"]
_FENCE_ALT_MAX = ["FENCE_ALT_MAX"]
_FENCE_ALT_MIN = ["FENCE_ALT_MIN"]
_FENCE_MARGIN = ["FENCE_MARGIN"]
_FENCE_TYPE = ["FENCE_TYPE"]
_FENCE_OPTIONS = ["FENCE_OPTIONS"]
_FENCE_NTF_FREQ = ["FENCE_NTF_FREQ"]

# Arming checks. Modern ArduCopter firmware retired the single ARMING_CHECK
# bitmask in favour of individual ARMING_* parameters. We read whichever the
# connected vehicle actually publishes, so the section always reflects reality
# rather than assuming a bitmask exists.
_ARMING_CHECK_CATALOGUE: List[Tuple[str, str, bool]] = [
    # (param, fallback label, treat-as-bitmask)
    ("ARMING_OPTIONS", "Arming options", True),
    ("ARMING_SKIPCHK", "Checks to skip", True),
    ("ARMING_RUDDER", "Rudder arming check", False),
    ("ARMING_NEED_LOC", "Require location to arm", False),
    ("ARMING_MAGTHRESH", "Compass interference threshold", False),
    ("ARMING_ACCTHRESH", "Accelerometer consistency threshold", False),
    ("ARMING_CRSDP_IGN", "Crash dump arming check", False),
    ("ARMING_MIS_ITEMS", "Mission items to skip", False),
]

# Curated advanced catalogue (params are only ever included if present live).
# Categories keep the advanced panel organised instead of dumping every FS_*.
_ADVANCED_CATALOGUE: List[Tuple[str, List[str]]] = [
    ("Failsafe", [
        "FS_RADIO_ENABLE", "FS_RADIO_CHAN", "FS_EKF_ACTION", "FS_EKF_THRESH",
        "FS_CRASH_CHECK", "FS_VIBE_ENABLE", "FS_VIBE_THRESHOLD",
        "FS_BATT_ENABLE", "FS_OPTIONS2", "FS_VIBE_GAIN",
    ]),
    ("RTL behaviour", [
        "RTL_CONE_SLOPE", "RTL_CLIMB_MIN", "RTL_CLIMB_MIN_M",
        "RTL_SPEED", "RTL_SPEED_MS",
    ]),
    ("Arming", [
        "ARMING_CHECK", "ARMING_ACCTHRESH", "ARMING_CRSDP_IGN",
        "ARMING_MAGTHRESH", "ARMING_MIS_ITEMS", "ARMING_NEED_LOC",
        "ARMING_OPTIONS", "ARMING_RUDDER", "ARMING_SKIPCHK",
        "ARMING_SWAP", "ARMING_ACC2_CHECK", "ARMING_GPS_MAX_FIX",
    ]),
    ("GeoFence", [
        "FENCE_TYPE", "FENCE_ENABLE", "FENCE_ACTION", "FENCE_RADIUS",
        "FENCE_ALT_MAX", "FENCE_ALT_MIN", "FENCE_MARGIN", "FENCE_OPTIONS",
        "FENCE_NTF_FREQ",
    ]),
    ("SmartRTL / other", [
        "WP_YAW_BEHAVIOR", "FS_OPTIONS2",
    ]),
]

# Params already exposed in the main sections, excluded from Advanced to avoid
# duplication.
_MAIN_EXPOSED = {
    "BATT_LOW_VOLT", "BATT_CRT_VOLT", "BATT_LOW_MAH", "BATT_CRT_MAH",
    "BATT_LOW_TIMER", "BATT_FS_LOW_ACT", "BATT_FS_CRT_ACT", "BATT_FS_VOLTSRC",
    "RTL_ALT", "RTL_ALT_M", "RTL_ALT_FINAL", "RTL_ALT_FINAL_M",
    "RTL_LOIT_TIME", "LAND_SPEED",
    "FS_OPTIONS", "FS_THR_ENABLE", "FS_THR_VALUE", "FS_GCS_ENABLE",
    "FS_GCS_TIMEOUT", "ARMING_CHECK", "RC3_MIN", "RC3_MAX",
    "FENCE_ENABLE", "FENCE_ACTION", "FENCE_RADIUS", "FENCE_ALT_MAX",
    "FENCE_ALT_MIN", "FENCE_MARGIN", "FENCE_TYPE", "FENCE_OPTIONS",
    "FENCE_NTF_FREQ",
    "ARMING_OPTIONS", "ARMING_SKIPCHK", "ARMING_RUDDER", "ARMING_NEED_LOC",
    "ARMING_MAGTHRESH", "ARMING_ACCTHRESH", "ARMING_CRSDP_IGN", "ARMING_MIS_ITEMS",
}


def _identity() -> Dict[str, Any]:
    status = get_vehicle_status()
    connection = status.get("connectionType", "NONE")
    transport = {"SERIAL": "USB", "UDP": "UDP", "TCP": "TCP"}.get(connection, "NONE")
    return {
        "connected": status.get("connected", False),
        "connectionState": status.get("connectionState", "disconnected"),
        "disconnectReason": status.get("disconnectReason"),
        "armed": status.get("armed", False),
        "mode": status.get("mode", "DISCONNECTED"),
        "systemId": status.get("systemId", 0),
        "componentId": status.get("componentId", 0),
        "vehicleType": status.get("vehicleType", "UNKNOWN"),
        "autopilot": status.get("autopilot", "UNKNOWN"),
        "transport": transport,
    }


def _is_supported(identity: Dict[str, Any]) -> Tuple[bool, str]:
    if not identity["connected"]:
        return False, "No vehicle connected."
    if identity["autopilot"] != "ARDUPILOTMEGA":
        return False, f"Unsupported autopilot: {identity['autopilot'] or 'UNKNOWN'}"
    if identity["vehicleType"] not in COPTER_VEHICLE_TYPES:
        return (
            False,
            f"Safety setup is available only for ArduCopter in this version "
            f"({identity['vehicleType']} detected).",
        )
    return True, ""


def _param_entry(param_id: str) -> Optional[Dict[str, Any]]:
    return parameter_manager.get_parameter(param_id)


def _param_value(param_id: str) -> Optional[float]:
    entry = _param_entry(param_id)
    if entry is None or entry.get("value") is None:
        return None
    try:
        return float(entry["value"])
    except (TypeError, ValueError):
        return None


def _param_meta(param_id: str) -> Optional[Dict[str, Any]]:
    if not param_id:
        return None
    meta = metadata_provider.lookup(param_id, "copter")
    if meta is None:
        metadata_provider.load_for("QUADROTOR")
        meta = metadata_provider.lookup(param_id, "copter")
    return meta


def _resolve(candidates: List[str]) -> Optional[str]:
    """First candidate actually present in the live parameter cache."""
    for pid in candidates:
        if _param_entry(pid) is not None:
            return pid
    return None


def _decode_enum(val: Optional[float], meta: Optional[Dict[str, Any]]) -> Optional[str]:
    if val is None or not meta or not meta.get("values"):
        return None
    return meta["values"].get(str(int(val)))


def _enum_options(meta: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
    if not meta or not meta.get("values"):
        return []
    options = []
    for code, label in meta["values"].items():
        try:
            options.append({"code": int(code), "label": label})
        except (ValueError, TypeError):
            options.append({"code": code, "label": label})
    try:
        options.sort(key=lambda o: int(o["code"]) if isinstance(o["code"], (int, float)) else 9999)
    except Exception:
        pass
    return options


def _build_field(
    candidates: List[str],
    *,
    enum: bool = False,
    bitmask: bool = False,
    zero_means_disabled: bool = False,
    fallback_name: Optional[str] = None,
    read_only: bool = False,
) -> Dict[str, Any]:
    pid = _resolve(candidates)
    supported = pid is not None
    entry = _param_entry(pid) if supported else None
    val = None
    if entry is not None:
        try:
            val = float(entry["value"])
        except (TypeError, ValueError):
            val = None
    meta = _param_meta(pid) if pid else None

    field: Dict[str, Any] = {
        "id": pid or candidates[0],
        "supported": supported,
        "value": val,
        "name": (meta.get("name") if meta else None) or fallback_name or pid or candidates[0],
        "description": meta.get("description") if meta else None,
        "units": meta.get("units") if meta else None,
        "rebootRequired": bool(meta.get("rebootRequired", False)) if meta else False,
        "zeroMeansDisabled": zero_means_disabled,
    }
    if read_only:
        field["readOnly"] = True
    if meta:
        if meta.get("min") is not None:
            field["min"] = meta["min"]
        if meta.get("max") is not None:
            field["max"] = meta["max"]
        if meta.get("increment") is not None:
            field["increment"] = meta["increment"]
    if enum:
        field["decoded"] = _decode_enum(val, meta)
        field["options"] = _enum_options(meta)
    if bitmask:
        bits = meta.get("bitmask") if meta else None
        if bits:
            raw = int(val) if val is not None else 0
            field["bits"] = [
                {
                    "code": int(code),
                    "label": label,
                    "present": bool(raw & (1 << int(code))),
                }
                for code, label in sorted(bits.items(), key=lambda kv: int(kv[0]))
            ]
        else:
            field["bitmaskUnavailable"] = True
    return field


def _has_any(candidates: List[str]) -> bool:
    return _resolve(candidates) is not None


def _derive_status_value(candidates: List[str], configured_value=0) -> str:
    """Configured / Disabled / Unknown based on real parameters."""
    pid = _resolve(candidates)
    if pid is None:
        return "Unknown"
    val = _param_value(pid)
    if val is None:
        return "Unknown"
    return "Configured" if int(val) != configured_value else "Disabled"


# --------------------------------------------------------------------------
# Status card derivations (honest — driven by real params, never the page load)
# --------------------------------------------------------------------------

def _arming_status(identity) -> str:
    pid = _resolve(_ARMING_CHECK)
    if pid is not None:
        val = _param_value(pid)
        if val is None:
            return "Unknown"
        if int(val) == 0:
            return "Disabled"
        bits = None
        meta = _param_meta(pid)
        if meta and meta.get("bitmask"):
            bits = meta["bitmask"]
        if bits:
            on = sum(1 for code in bits if int(val) & (1 << int(code)))
            if on < len(bits):
                return "Partially configured"
        return "Enabled"
    # Newer Copter firmware splits the checks into ARMING_* params.
    any_arming = any(p["id"].startswith("ARMING_") for p in parameter_manager.get_all_parameters())
    return "Enabled" if any_arming else "Unknown"


def _battery_status() -> str:
    if _has_any(_BATT_FS_LOW_ACT) or _has_any(_BATT_FS_CRT_ACT):
        low = _param_value(_resolve(_BATT_FS_LOW_ACT))
        crt = _param_value(_resolve(_BATT_FS_CRT_ACT))
        if (low or 0) > 0 or (crt or 0) > 0:
            return "Configured"
        return "Disabled"
    return "Unknown"


def _radio_status() -> str:
    return _derive_status_value(_FS_THR_ENABLE)


def _gcs_status() -> str:
    return _derive_status_value(_FS_GCS_ENABLE)


def _rtl_status() -> str:
    if _has_any(_RTL_ALT) or _has_any(_RTL_LOIT_TIME) or _has_any(_RTL_ALT_FINAL):
        return "Configured"
    return "Unknown"


# --------------------------------------------------------------------------
# Section builders
# --------------------------------------------------------------------------

def _build_battery_section() -> Dict[str, Any]:
    fields = {
        "lowVolt": _build_field(_BATTERY_LOW_VOLT, zero_means_disabled=True,
                                fallback_name="Low Voltage"),
        "crtVolt": _build_field(_BATTERY_CRT_VOLT, zero_means_disabled=True,
                                fallback_name="Critical Voltage"),
        "lowMah": _build_field(_BATTERY_LOW_MAH, zero_means_disabled=True,
                               fallback_name="Low Capacity"),
        "crtMah": _build_field(_BATTERY_CRT_MAH, zero_means_disabled=True,
                               fallback_name="Critical Capacity"),
        "lowTimer": _build_field(_BATTERY_LOW_TIMER, zero_means_disabled=False,
                                 fallback_name="Low Battery Timer"),
        "fsLowAct": _build_field(_BATT_FS_LOW_ACT, enum=True,
                                 fallback_name="Low Battery Action"),
        "fsCrtAct": _build_field(_BATT_FS_CRT_ACT, enum=True,
                                 fallback_name="Critical Battery Action"),
        "fsVoltSrc": _build_field(_BATT_FS_VOLTSRC, enum=True,
                                  fallback_name="Voltage Source"),
    }
    return {"fields": fields}


def _build_radio_section() -> Dict[str, Any]:
    enable = _build_field(_FS_THR_ENABLE, enum=True, fallback_name="Throttle failsafe action")
    value = _build_field(_FS_THR_VALUE, fallback_name="Throttle failsafe PWM",
                         zero_means_disabled=False)
    options = _build_field(_FS_OPTIONS, bitmask=True, fallback_name="Failsafe options")

    warnings: List[str] = []
    thr_val = value.get("value")
    if thr_val is not None:
        thr_min = _param_value(_resolve(_RC_THROTTLE_MIN))
        thr_max = _param_value(_resolve(_RC_THROTTLE_MAX))
        if thr_min is not None and thr_max is not None:
            if thr_val >= thr_min:
                warnings.append(
                    f"Radio failsafe threshold may be inconsistent with the configured "
                    f"throttle range (RC3_MIN={thr_min:g}, RC3_MAX={thr_max:g})."
                )
    return {
        "fields": {"enable": enable, "value": value, "options": options},
        "warnings": warnings,
    }


def _build_gcs_section() -> Dict[str, Any]:
    field = _build_field(_FS_GCS_ENABLE, enum=True, fallback_name="GCS failsafe action")
    timeout = _build_field(_FS_GCS_TIMEOUT, fallback_name="GCS failsafe timeout")
    return {
        "supported": field["supported"],
        "field": field,
        "timeout": timeout,
    }


def _build_rtl_section() -> Dict[str, Any]:
    alt = _build_field(_RTL_ALT, fallback_name="RTL Return Altitude")
    loit = _build_field(_RTL_LOIT_TIME, fallback_name="RTL Loiter Time")
    alt_final = _build_field(_RTL_ALT_FINAL, fallback_name="RTL Final Altitude")
    land = _build_field(_LAND_SPEED, fallback_name="Landing Descent Speed")
    extra = []
    for candidates, name in [
        (_RTL_CONE_SLOPE, "RTL Cone Slope"),
        (_RTL_CLIMB_MIN, "RTL Climb Minimum"),
        (_RTL_SPEED, "RTL Speed"),
    ]:
        f = _build_field(candidates, fallback_name=name)
        if f.get("supported"):
            extra.append(f)
    return {
        "fields": {"alt": alt, "loitTime": loit, "altFinal": alt_final, "landSpeed": land},
        "extra": extra,
    }


def _build_fence_section() -> Dict[str, Any]:
    """GeoFence *parameters* only — geometry stays in PLAN -> GeoFence."""
    fields = {
        "enable": _build_field(_FENCE_ENABLE, enum=True, fallback_name="Fence enable"),
        "action": _build_field(_FENCE_ACTION, enum=True, fallback_name="Fence breach action"),
        "radius": _build_field(_FENCE_RADIUS, fallback_name="Fence radius"),
        "altMax": _build_field(_FENCE_ALT_MAX, fallback_name="Fence max altitude"),
        "altMin": _build_field(_FENCE_ALT_MIN, fallback_name="Fence min altitude"),
        "margin": _build_field(_FENCE_MARGIN, fallback_name="Fence margin"),
        "types": _build_field(_FENCE_TYPE, bitmask=True, fallback_name="Fence types"),
        "options": _build_field(_FENCE_OPTIONS, bitmask=True, fallback_name="Fence options"),
        "ntfFreq": _build_field(_FENCE_NTF_FREQ, enum=True, fallback_name="Notification frequency"),
    }
    return {"fields": fields}


def _build_arming_section() -> Dict[str, Any]:
    field = _build_field(_ARMING_CHECK, bitmask=True, fallback_name="Arming Checks")

    # Individual arming checks the connected firmware actually publishes. The
    # catalogue flag is only a hint: ARMING_OPTIONS is an enum on ArduCopter
    # while ARMING_SKIPCHK is a real bitmask, so the vehicle's own metadata
    # decides how each one is presented and edited.
    checks: List[Dict[str, Any]] = []
    for pid, label, prefer_bitmask in _ARMING_CHECK_CATALOGUE:
        if _param_entry(pid) is None:
            continue
        meta = _param_meta(pid) or {}
        is_bitmask = bool(meta.get("bitmask")) or (not meta.get("values") and prefer_bitmask)
        is_enum = bool(meta.get("values")) and not is_bitmask
        checks.append(
            _build_field([pid], enum=is_enum, bitmask=is_bitmask, fallback_name=label)
        )

    if field["supported"]:
        return {"supported": True, "field": field, "checks": checks, "note": None}
    if checks:
        return {
            "supported": True,
            "field": None,
            "checks": checks,
            "note": "This firmware splits arming checks into individual ARMING_* "
                    "parameters, shown below.",
        }
    return {"supported": False, "field": None, "checks": [], "note": None}


def _build_advanced_section() -> Dict[str, Any]:
    categories: List[Dict[str, Any]] = []
    for cat_name, candidates in _ADVANCED_CATALOGUE:
        shown: List[Dict[str, Any]] = []
        for pid in candidates:
            if pid in _MAIN_EXPOSED:
                continue
            entry = _param_entry(pid)
            if entry is None:
                continue
            # Advanced parameters still use the connected firmware's metadata
            # to distinguish scalar values, enums, and bitmasks. Leaving an
            # enum as a numeric input bypasses the real option mapping and
            # causes writes to be rejected by pre-flight validation.
            meta = _param_meta(pid)
            field = _build_field(
                [pid],
                enum=bool(meta and meta.get("values")),
                bitmask=bool(meta and meta.get("bitmask")),
                fallback_name=pid,
            )
            shown.append(field)
        if shown:
            categories.append({"name": cat_name, "params": shown})
    return {"categories": categories}


# --------------------------------------------------------------------------
# State
# --------------------------------------------------------------------------

def _any_safety_params() -> bool:
    for p in parameter_manager.get_all_parameters():
        pid = p.get("id", "") or ""
        if (pid.startswith("BATT_FS") or pid.startswith("FS_")
                or pid.startswith("RTL_") or pid.startswith("ARMING")
                or pid.startswith("FENCE_")
                or pid in ("BATT_LOW_VOLT", "BATT_CRT_VOLT", "BATT_LOW_MAH",
                           "BATT_CRT_MAH", "BATT_LOW_TIMER", "LAND_SPEED",
                           "RC3_MIN", "RC3_MAX")):
            return True
    return False


def _determine_state(identity: Dict[str, Any], supported: bool, has_data: bool) -> str:
    if identity["connectionState"] == "connecting":
        return STATE_CONNECTING
    if not identity["connected"]:
        return STATE_CONNECTION_LOST if identity.get("disconnectReason") else STATE_WAITING
    if not supported:
        return STATE_UNSUPPORTED
    sync = parameter_manager.get_synchronization_state()
    if sync.get("state") in ("requesting", "receiving"):
        return STATE_SYNCING
    if sync.get("state") == "failed":
        return STATE_ERROR
    if sync.get("state") == "complete":
        return STATE_READY if has_data else STATE_ERROR
    return STATE_SYNCING


def get_safety_info() -> Dict[str, Any]:
    """Live Safety Setup page snapshot."""
    identity = _identity()
    supported, unsupported_reason = _is_supported(identity)

    status: Optional[Dict[str, Any]] = None
    battery: Optional[Dict[str, Any]] = None
    radio: Optional[Dict[str, Any]] = None
    gcs: Optional[Dict[str, Any]] = None
    fence: Optional[Dict[str, Any]] = None
    rtl: Optional[Dict[str, Any]] = None
    arming: Optional[Dict[str, Any]] = None
    advanced: Optional[Dict[str, Any]] = None

    has_data = False
    sync = parameter_manager.get_synchronization_state()
    sync_complete = sync.get("state") == "complete"
    if identity["connected"] and supported and sync_complete:
        has_data = _any_safety_params()
        if has_data:
            status = {
                "configuration": "Ready",
                "armingChecks": _arming_status(identity),
                "batteryFailsafe": _battery_status(),
                "radioFailsafe": _radio_status(),
                "gcsFailsafe": _gcs_status(),
                "rtl": _rtl_status(),
            }
            battery = _build_battery_section()
            radio = _build_radio_section()
            gcs = _build_gcs_section()
            fence = _build_fence_section()
            rtl = _build_rtl_section()
            arming = _build_arming_section()
            advanced = _build_advanced_section()

    state = _determine_state(identity, supported, has_data)
    sync_out = dict(sync)
    sync_out["complete"] = sync.get("state") == "complete"

    return {
        "success": True,
        **identity,
        "supported": supported,
        "unsupportedReason": unsupported_reason,
        "state": state,
        "sync": sync_out,
        "status": status,
        "battery": battery,
        "radio": radio,
        "gcs": gcs,
        "fence": fence,
        "rtl": rtl,
        "arming": arming,
        "advanced": advanced,
        "timestamp": int(time.time() * 1000),
    }
