"""Power Setup service (QGC-style) for ArduCopter — Phase 8F.

Single backend authority for SETUP -> Power. Everything is derived from the
live vehicle, never fabricated:

  * battery telemetry    -> mavlink.telemetry_manager (real SYS_STATUS /
                            BATTERY_STATUS frames)
  * freshness tracking   -> update timestamp + ageMs (stale after BATTERY_STALE_MS)
  * battery instances    -> detected dynamically from parameter cache (BATT_*, BATT2_*, etc.)
  * configuration params -> downloaded PARAM_VALUE cache (BATT_MONITOR, BATT_CAPACITY,
                            BATT_LOW_VOLT, BATT_CRT_VOLT, BATT_LOW_MAH, BATT_CRT_MAH,
                            BATT_LOW_TIMER, BATT_FS_LOW_ACT, BATT_FS_CRT_ACT,
                            BATT_VOLT_MULT, BATT_AMP_PERVLT, etc.)
  * metadata             -> official ArduPilot parameter metadata (definitions, ranges, units,
                            reboot requirements, enum values)

ArduCopter-only. Writes go through the shared verified parameter pipeline.
Never confirms a write until the vehicle echoes PARAM_VALUE.
"""

import time
from typing import Any, Dict, List, Optional, Tuple

from core.state import get_vehicle_status, telemetry
from mavlink.parameter_manager import parameter_manager
from mavlink.telemetry_manager import (
    BATTERY_STALE_MS,
    get_all_battery_telemetry,
    get_battery_telemetry,
)
from services.parameter_metadata import metadata_provider

COPTER_VEHICLE_TYPES = {
    "QUADROTOR", "TRICOPTER", "HEXAROTOR", "OCTOROTOR", "COAXIAL",
    "HELICOPTER", "VTOL_QUADROTOR", "VTOL_TILTROTOR", "VTOL_RESERVED2",
    "VTOL_RESERVED3", "VTOL_RESERVED4", "VTOL_RESERVED5",
}

# 10 explicit Power page states
STATE_WAITING = "WAITING"
STATE_CONNECTING = "CONNECTING"
STATE_SYNCING = "SYNCING"
STATE_READY = "READY"
STATE_MONITOR_DISABLED = "MONITOR_DISABLED"
STATE_NO_BATTERY_TELEMETRY = "NO_BATTERY_TELEMETRY"
STATE_STALE_TELEMETRY = "STALE_TELEMETRY"
STATE_CONNECTION_LOST = "CONNECTION_LOST"
STATE_UNSUPPORTED = "UNSUPPORTED"
STATE_ERROR = "ERROR"


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
            f"Power setup is available only for ArduCopter in this version ({identity['vehicleType']} detected).",
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


def _param_meta(param_id: str, generic_fallback_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    meta = metadata_provider.lookup(param_id, "copter")
    if meta is None:
        metadata_provider.load_for("QUADROTOR")
        meta = metadata_provider.lookup(param_id, "copter")
    if meta is None and generic_fallback_id:
        meta = metadata_provider.lookup(generic_fallback_id, "copter")
    return meta


def _decode_enum(val: Optional[float], meta: Optional[Dict[str, Any]]) -> Optional[str]:
    if val is None or not meta or not meta.get("values"):
        return None
    int_str = str(int(val))
    return meta["values"].get(int_str)


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


def _build_param_field(
    param_id: str,
    generic_id: str,
    expected_units: Optional[str] = None,
    is_enum: bool = False,
    override_reboot: Optional[bool] = None,
) -> Dict[str, Any]:
    val = _param_value(param_id)
    present = _param_entry(param_id) is not None
    meta = _param_meta(param_id, generic_id)

    units = (meta.get("units") if meta else None) or expected_units
    desc = meta.get("description") if meta else None
    name = (meta.get("name") if meta else None) or param_id
    reboot = override_reboot if override_reboot is not None else (meta.get("rebootRequired", False) if meta else False)

    field: Dict[str, Any] = {
        "id": param_id,
        "supported": present,
        "value": val,
        "name": name,
        "description": desc,
        "units": units,
        "rebootRequired": reboot,
    }

    if is_enum:
        field["decoded"] = _decode_enum(val, meta)
        field["options"] = _enum_options(meta)

    if meta:
        if meta.get("min") is not None:
            field["min"] = meta["min"]
        if meta.get("max") is not None:
            field["max"] = meta["max"]
        if meta.get("increment") is not None:
            field["increment"] = meta["increment"]

    return field


def _evaluate_health_status(
    monitor_val: Optional[float],
    telem: Dict[str, Any],
    low_volt: Optional[float],
    crt_volt: Optional[float],
    low_mah: Optional[float],
    crt_mah: Optional[float],
    capacity: Optional[float],
) -> Tuple[str, str]:
    """Derive UI health status strictly from vehicle thresholds and real telemetry."""
    if monitor_val is None or int(monitor_val) == 0:
        return "DISABLED", "Battery monitor disabled"

    v = telem.get("voltage")
    if v is None:
        return "UNAVAILABLE", "Battery telemetry unavailable"

    if telem.get("stale", True):
        return "STALE", "Battery telemetry stale"

    cs = telem.get("chargeState")
    if cs in ("CRITICAL", "EMERGENCY", "FAILED"):
        return "CRITICAL", f"Vehicle reported {cs} charge state"
    if cs == "LOW":
        return "LOW", "Vehicle reported LOW charge state"
    if cs == "CHARGING":
        return "CHARGING", "Battery charging"

    if crt_volt is not None and crt_volt > 0 and v <= crt_volt:
        return "CRITICAL", f"Voltage ({v:.2f}V) below critical threshold ({crt_volt:.1f}V)"

    consumed = telem.get("consumedMah")
    if crt_mah is not None and crt_mah > 0 and capacity is not None and consumed is not None:
        rem_mah = max(0.0, capacity - consumed)
        if rem_mah <= crt_mah:
            return "CRITICAL", f"Remaining capacity ({int(rem_mah)}mAh) below critical threshold ({int(crt_mah)}mAh)"

    if low_volt is not None and low_volt > 0 and v <= low_volt:
        return "LOW", f"Voltage ({v:.2f}V) below low threshold ({low_volt:.1f}V)"

    if low_mah is not None and low_mah > 0 and capacity is not None and consumed is not None:
        rem_mah = max(0.0, capacity - consumed)
        if rem_mah <= low_mah:
            return "LOW", f"Remaining capacity ({int(rem_mah)}mAh) below low threshold ({int(low_mah)}mAh)"

    return "NORMAL", "Battery operating within configured limits"


def _detect_instances() -> List[int]:
    """Detect battery instances from the live parameter set and telemetry.

    Primary (BATT_*) is always considered. Additional instances appear only
    when the vehicle actually exposes a nonzero BATTN_MONITOR (i.e. monitoring
    is configured) or a BATTERY_STATUS frame for that id. A present but
    disabled (0) monitor slot is not a real battery, so it is never shown.
    """
    found = {1}
    for i in range(2, 16):
        mon = _param_value(f"BATT{i}_MONITOR")
        if mon is not None and int(mon) != 0:
            found.add(i)
    for bat in get_all_battery_telemetry():
        telem_id = bat.get("id")
        if isinstance(telem_id, int) and telem_id >= 1:
            found.add(telem_id)
        elif isinstance(bat.get("instance"), int):
            found.add(int(bat["instance"]) + 1)
    return sorted(found)


def _build_instance_data(instance_num: int) -> Dict[str, Any]:
    prefix = "BATT_" if instance_num == 1 else f"BATT{instance_num}_"

    monitor = _build_param_field(f"{prefix}MONITOR", "BATT_MONITOR", is_enum=True, override_reboot=True)
    capacity = _build_param_field(f"{prefix}CAPACITY", "BATT_CAPACITY", expected_units="mAh")
    low_volt = _build_param_field(f"{prefix}LOW_VOLT", "BATT_LOW_VOLT", expected_units="V")
    crt_volt = _build_param_field(f"{prefix}CRT_VOLT", "BATT_CRT_VOLT", expected_units="V")
    low_mah = _build_param_field(f"{prefix}LOW_MAH", "BATT_LOW_MAH", expected_units="mAh")
    crt_mah = _build_param_field(f"{prefix}CRT_MAH", "BATT_CRT_MAH", expected_units="mAh")
    low_timer = _build_param_field(f"{prefix}LOW_TIMER", "BATT_LOW_TIMER", expected_units="s")

    # Safety failsafe actions (contextual display only, marked "Configured in Safety")
    fs_low_act = _build_param_field(f"{prefix}FS_LOW_ACT", "BATT_FS_LOW_ACT", is_enum=True)
    fs_low_act["readOnlyNotice"] = "Configured in Safety"
    fs_crt_act = _build_param_field(f"{prefix}FS_CRT_ACT", "BATT_FS_CRT_ACT", is_enum=True)
    fs_crt_act["readOnlyNotice"] = "Configured in Safety"

    # Calibration parameters
    volt_mult = _build_param_field(f"{prefix}VOLT_MULT", "BATT_VOLT_MULT")
    amp_per_vlt = _build_param_field(f"{prefix}AMP_PERVLT", "BATT_AMP_PERVLT", expected_units="A/V")
    amp_offset = _build_param_field(f"{prefix}AMP_OFFSET", "BATT_AMP_OFFSET", expected_units="V")
    vlt_offset = _build_param_field(f"{prefix}VLT_OFFSET", "BATT_VLT_OFFSET", expected_units="V")

    # Advanced parameters starting with this instance's prefix
    primary_pids = {
        f"{prefix}MONITOR", f"{prefix}CAPACITY", f"{prefix}LOW_VOLT", f"{prefix}CRT_VOLT",
        f"{prefix}LOW_MAH", f"{prefix}CRT_MAH", f"{prefix}LOW_TIMER", f"{prefix}FS_LOW_ACT",
        f"{prefix}FS_CRT_ACT", f"{prefix}VOLT_MULT", f"{prefix}AMP_PERVLT",
        f"{prefix}AMP_OFFSET", f"{prefix}VLT_OFFSET",
    }
    advanced: List[Dict[str, Any]] = []
    all_cached = parameter_manager.get_all_parameters()
    for entry in all_cached:
        pid = entry.get("id", "")
        if pid.startswith(prefix) and pid not in primary_pids:
            meta = _param_meta(pid)
            advanced.append({
                "id": pid,
                "value": entry.get("value"),
                "name": meta.get("name") if meta else pid,
                "description": meta.get("description") if meta else None,
                "units": meta.get("units") if meta else None,
                "rebootRequired": meta.get("rebootRequired", False) if meta else False,
            })
    advanced.sort(key=lambda a: a["id"])

    # Live telemetry for this instance
    telem = get_battery_telemetry(instance_num - 1)
    if telem is None:
        telem = {
            "instance": instance_num - 1,
            "id": instance_num,
            "voltage": None,
            "current": None,
            "consumedMah": None,
            "remaining": None,
            "temperature": None,
            "cellVoltages": [],
            "chargeState": "UNDEFINED",
            "receivedAt": None,
            "ageMs": None,
            "stale": True,
            "source": None,
        }

    health_status, health_detail = _evaluate_health_status(
        monitor.get("value"),
        telem,
        low_volt.get("value"),
        crt_volt.get("value"),
        low_mah.get("value"),
        crt_mah.get("value"),
        capacity.get("value"),
    )

    return {
        "instance": instance_num,
        "label": f"Battery {instance_num}",
        "prefix": prefix,
        "monitor": monitor,
        "capacity": capacity,
        "thresholds": {
            "lowVolt": low_volt,
            "crtVolt": crt_volt,
            "lowMah": low_mah,
            "crtMah": crt_mah,
            "lowTimer": low_timer,
            "fsLowAct": fs_low_act,
            "fsCrtAct": fs_crt_act,
        },
        "calibration": {
            "voltMult": volt_mult,
            "ampPerVlt": amp_per_vlt,
            "ampOffset": amp_offset,
            "vltOffset": vlt_offset,
        },
        "advanced": advanced,
        "telemetry": telem,
        "health": {
            "status": health_status,
            "detail": health_detail,
        },
    }


def _determine_state(identity: Dict[str, Any], supported: bool, instances: List[Dict[str, Any]]) -> str:
    if not identity["connected"]:
        return STATE_CONNECTION_LOST if identity.get("disconnectReason") else STATE_WAITING

    if identity["connectionState"] == "connecting":
        return STATE_CONNECTING

    if not supported:
        return STATE_UNSUPPORTED

    sync = parameter_manager.get_synchronization_state()
    if sync.get("state") in ("requesting", "receiving"):
        return STATE_SYNCING

    if sync.get("state") == "failed":
        return STATE_ERROR

    if not sync.get("complete", False) and (not instances or not instances[0]["monitor"]["supported"]):
        return STATE_SYNCING

    if not instances:
        return STATE_ERROR

    primary = instances[0]
    monitor_val = primary.get("monitor", {}).get("value")
    if monitor_val is None or int(monitor_val) == 0:
        return STATE_MONITOR_DISABLED

    telem = primary.get("telemetry", {})
    if telem.get("voltage") is None and telem.get("current") is None and telem.get("remaining") is None:
        return STATE_NO_BATTERY_TELEMETRY

    if telem.get("stale", True):
        return STATE_STALE_TELEMETRY

    return STATE_READY


def get_power_info() -> Dict[str, Any]:
    """Live Power Setup page snapshot."""
    identity = _identity()
    supported, unsupported_reason = _is_supported(identity)

    instances_data: List[Dict[str, Any]] = []
    if identity["connected"] and supported:
        instance_ids = _detect_instances()
        for idx in instance_ids:
            instances_data.append(_build_instance_data(idx))

    state = _determine_state(identity, supported, instances_data)
    sync = parameter_manager.get_synchronization_state()
    sync_out = dict(sync)
    sync_out["complete"] = sync.get("state") == "complete"

    return {
        "success": True,
        **identity,
        "supported": supported,
        "unsupportedReason": unsupported_reason,
        "state": state,
        "sync": sync_out,
        "staleThresholdMs": BATTERY_STALE_MS,
        "instances": instances_data,
        "instanceCount": len(instances_data),
        "timestamp": int(time.time() * 1000),
    }


def calculate_voltage_multiplier(
    current_multiplier: float,
    measured_voltage: float,
    sensor_voltage: float,
) -> Dict[str, Any]:
    """Safe voltage multiplier calculation helper.

    New multiplier = current_multiplier * (measured_multimeter_voltage / sensor_voltage)
    """
    if sensor_voltage <= 0:
        return {"success": False, "message": "Sensor voltage must be greater than 0."}
    if measured_voltage <= 0:
        return {"success": False, "message": "Measured voltage must be greater than 0."}
    if current_multiplier <= 0:
        return {"success": False, "message": "Current multiplier must be greater than 0."}

    new_mult = current_multiplier * (measured_voltage / sensor_voltage)
    return {
        "success": True,
        "calculatedMultiplier": round(new_mult, 6),
        "message": f"Calculated new multiplier: {new_mult:.6f}",
    }


def calculate_amps_per_volt(
    current_amps_per_volt: float,
    measured_current: float,
    sensor_current: float,
) -> Dict[str, Any]:
    """Safe amps-per-volt calculation helper.

    New amps/volt = current_amps_per_volt * (measured_current / sensor_current)
    """
    if sensor_current <= 0:
        return {"success": False, "message": "Sensor current must be greater than 0."}
    if measured_current <= 0:
        return {"success": False, "message": "Measured current must be greater than 0."}
    if current_amps_per_volt <= 0:
        return {"success": False, "message": "Current amps per volt must be greater than 0."}

    new_apv = current_amps_per_volt * (measured_current / sensor_current)
    return {
        "success": True,
        "calculatedAmpsPerVolt": round(new_apv, 6),
        "message": f"Calculated new amps per volt: {new_apv:.6f}",
    }
