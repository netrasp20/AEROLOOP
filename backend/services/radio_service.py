"""Radio Setup service (QGC-style) for ArduCopter — Phase 8E.

Single backend authority for SETUP -> Radio. Everything is derived from the
live vehicle, never fabricated:

  * RC receiver telemetry  -> mavlink.telemetry_manager rcChannels (real
                              RC_CHANNELS frames, raw PWM per channel)
  * signal state           -> rssi + fresh frame arrival (a MAVLink connection
                              is NOT proof of an RC link)
  * channel endpoints      -> the downloaded PARAM_VALUE cache
                              (RCn_MIN / RCn_TRIM / RCn_MAX / RCn_REVERSED)
  * main control mapping   -> real RCMAP_ROLL/PITCH/THROTTLE/YAW parameters
                              (never assumed to be CH1..4)

ArduCopter-only. Writes for per-channel configuration (and the calibration
finish) go through parameter_service.write_parameter — the SAME verified
pipeline used everywhere else (PARAM_SET -> PARAM_VALUE echo -> cache ->
socket emit). This service never confirms a write itself.
"""

import time
from typing import Any, Dict, List, Optional, Tuple

from core.state import telemetry, vehicle_state
from mavlink.parameter_manager import parameter_manager

# A stale RC frame (no fresh RC_CHANNELS in this window) means NO_SIGNAL.
# QGC-class channel monitors call this "No RC signal" even while the MAVLink
# link itself is healthy.
RC_STALE_MS = 2000

# Main control functions -> the ArduPilot parameters that map them to channels.
MAIN_CONTROL_PARAMS: List[Tuple[str, str]] = [
    ("RCMAP_ROLL", "Roll"),
    ("RCMAP_PITCH", "Pitch"),
    ("RCMAP_THROTTLE", "Throttle"),
    ("RCMAP_YAW", "Yaw"),
]

# Copied from setup_service to keep this module self-contained; mirrors the
# ArduPilot vehicle types that present as an ArduCopter flight stack.
COPTER_VEHICLE_TYPES = {
    "QUADROTOR", "TRICOPTER", "HEXAROTOR", "OCTOROTOR", "COAXIAL",
    "HELICOPTER", "VTOL_QUADROTOR", "VTOL_TILTROTOR", "VTOL_RESERVED2",
    "VTOL_RESERVED3", "VTOL_RESERVED4", "VTOL_RESERVED5",
}

_MAX_CHANNELS = 16

# Only used while connected but before ConnectionManager has recorded a type.
# The authoritative labels come from setup_service._CONNECTION_LABELS.
_CONNECTION_TYPE_FALLBACK = {"SERIAL": "USB", "UDP": "UDP", "TCP": "TCP"}


def _active_transport(status: Dict[str, Any]) -> str:
    """The transport actually in use, taken from the connection manager.

    ``manager.connection_type`` is the authoritative record of the transport the
    link was actually opened with (set by ConnectionManager._start only once the
    pymavlink connection object exists).

    ``get_vehicle_status()["connectionType"]`` is deliberately NOT trusted: it is
    a proxy derived from three independent booleans in core/state.py, and it
    checks ``serialPortOpen`` FIRST. A serial flag left behind by an earlier
    session therefore reports "USB" for a live TCP link, which is exactly the bug
    this replaces. The proxy is used only as a last-resort fallback while
    connected and before the manager has recorded a type.

    The previous session's transport is never carried across a disconnect, so the
    page cannot keep advertising USB after the link is gone.
    """
    from mavlink.connection_manager import manager
    from services.setup_service import _CONNECTION_LABELS

    # "connecting" is set before the handshake, while `connected` is still False,
    # so it has to be tested first.
    if status["connectionState"] == "connecting":
        return "CONNECTING"
    if not status["connected"]:
        return "DISCONNECTED"

    connection_type = manager.connection_type
    if connection_type:
        return _CONNECTION_LABELS.get(connection_type, connection_type.upper())
    return _CONNECTION_TYPE_FALLBACK.get(status["connectionType"], "UNKNOWN")


def _identity() -> Dict[str, Any]:
    from core.state import get_vehicle_status

    status = get_vehicle_status()
    return {
        "connected": status["connected"],
        "connectionState": status["connectionState"],
        "disconnectReason": status.get("disconnectReason"),
        "armed": status["armed"],
        "mode": status["mode"],
        "systemId": status["systemId"],
        "componentId": status["componentId"],
        "vehicleType": status["vehicleType"],
        "autopilot": status["autopilot"],
        "transport": _active_transport(status),
    }


def _is_supported(identity: Dict[str, Any]) -> Tuple[bool, str]:
    if not identity["connected"]:
        return False, "No vehicle connected."
    if identity["autopilot"] != "ARDUPILOTMEGA":
        return False, f"Unsupported autopilot: {identity['autopilot'] or 'UNKNOWN'}"
    if identity["vehicleType"] not in COPTER_VEHICLE_TYPES:
        return (
            False,
            f"Radio setup is ArduCopter-only ({identity['vehicleType']} detected).",
        )
    return True, ""


def _last_rc_age_ms() -> float:
    received = telemetry.get("rcReceivedAt") or 0
    if not received:
        return float("inf")
    return (time.time() - received) * 1000.0


def _signal_state(identity: Dict[str, Any]) -> str:
    """Signal is about the RC *receiver*, never MAVLink connectivity.

    WAITING        — connected but no RC_CHANNELS frame has ever arrived
    RECEIVING      — fresh frame AND rssi > 0 (ArduPilot: 0 = no valid RC link)
    NO_SIGNAL      — fresh telemetry but rssi == 0, OR frames gone stale
    """
    if not identity["connected"]:
        return "NO_SIGNAL"
    channels = telemetry.get("rcChannels") or []
    if not channels:
        return "WAITING"
    if _last_rc_age_ms() > RC_STALE_MS:
        return "NO_SIGNAL"
    if telemetry.get("rcRssi", 0) <= 0:
        return "NO_SIGNAL"
    return "RECEIVING"


def _channels():
    channels = telemetry.get("rcChannels")
    if not channels:
        return []
    count = telemetry.get("rcChannelCount") or 0
    if count <= 0:
        count = len(channels)
    out: List[Dict[str, Any]] = []
    for idx, value in enumerate(channels[: min(count, _MAX_CHANNELS)]):
        out.append(
            {
                "channel": idx + 1,
                "value": int(value or 0),
                "active": int(value or 0) > 0,
            }
        )
    return out


def _param_entry(param_id: str) -> Optional[Dict[str, Any]]:
    entry = parameter_manager.get_parameter(param_id)
    return entry if isinstance(entry, dict) else None


def _param_value(param_id: str) -> Optional[float]:
    entry = _param_entry(param_id)
    if entry is None or entry.get("value") is None:
        return None
    try:
        return float(entry["value"])
    except (TypeError, ValueError):
        return None


def _param_options(param_id: str) -> List[Dict[str, Any]]:
    """Real enum choices for a parameter, straight from the vehicle's metadata.

    ArduCopter exposes the aux/param channel function assignment as
    ``RCn_OPTION`` with a genuine enumerated value list. Nothing here is
    hardcoded: if the firmware does not publish the parameter, or publishes it
    without an enum, the capability is reported unsupported rather than faked.

    The enumeration comes from the existing parameter metadata provider (the
    same source ``GET /parameters/{id}/metadata`` serves). It deliberately does
    *not* come from ``ParameterManager.get_parameter()``: that snapshot carries
    only the live value and never includes metadata.
    """
    if _param_entry(param_id) is None:
        return []
    try:
        from services.parameter_service import parameter_service as _psvc

        result = _psvc.get_metadata(param_id)
    except Exception:  # noqa: BLE001 - capability detection must never raise
        return []
    if not result.get("success"):
        return []
    metadata = result.get("metadata") or {}
    values = metadata.get("values")
    if not isinstance(values, dict) or not values:
        return []
    options: List[Dict[str, Any]] = []
    for raw_key, label in values.items():
        try:
            numeric = int(raw_key)
        except (TypeError, ValueError):
            continue
        options.append({"value": numeric, "label": str(label)})
    options.sort(key=lambda item: item["value"])
    return options


#: The ArduPilot parameters that assign a non-main channel to a vehicle
#: function. ArduCopter names these ``RCn_OPTION`` (the older ``CHn_OPT`` name is
#: also accepted so the capability is detected on either firmware generation).
AUX_FUNCTION_PARAMS: Tuple[str, ...] = ("RC{channel}_OPTION", "RC{channel}_OPT")


def _aux_channels(main_channels: List[int]) -> Dict[str, Any]:
    """Capability-driven aux / parameter-channel assignment.

    Every entry is backed by a parameter that genuinely exists on the connected
    firmware and carries a genuine enum from the vehicle's own metadata. A
    channel with no such parameter is reported ``supported: false`` so the UI can
    say "Unavailable on this firmware" instead of inventing a control.
    """
    supported_any = False
    rows: List[Dict[str, Any]] = []
    for channel in range(1, _MAX_CHANNELS + 1):
        param_id = None
        options: List[Dict[str, Any]] = []
        for template in AUX_FUNCTION_PARAMS:
            candidate = template.format(channel=channel)
            found = _param_options(candidate)
            if found:
                param_id = candidate
                options = found
                break
        is_main = channel in main_channels
        entry = _param_entry(param_id) if param_id else None
        supported = bool(param_id and options)
        if supported and not is_main:
            supported_any = True
        rows.append(
            {
                "channel": channel,
                "param": param_id,
                "label": param_id,
                "supported": supported,
                "isMainControl": is_main,
                "value": (
                    int(float(entry["value"]))
                    if supported and entry and entry.get("value") is not None
                    else None
                ),
                "options": options if supported else [],
                "unavailableReason": (
                    None
                    if supported
                    else "This firmware does not publish a function-assignment "
                    "parameter for this channel."
                ),
            }
        )
    return {"supported": supported_any, "channels": rows}


def _rssi_report() -> Dict[str, Any]:
    """Report RSSI honestly.

    MAVLink uses 255 as the "RSSI not known" sentinel and ArduPilot reports 0 as
    "no valid RC link". Neither is a meaningful signal strength, so both are
    converted into an explicit unavailable state instead of being rendered as a
    number.
    """
    raw = telemetry.get("rcRssi")
    try:
        value = int(raw) if raw is not None else None
    except (TypeError, ValueError):
        value = None
    available = value is not None and 0 < value < 255
    if available:
        reason = None
    elif not telemetry.get("rcReceivedAt"):
        # Telemetry resets rcRssi to 0 when the link drops, so before the first
        # frame the honest explanation is "no frame yet", not "RSSI 0".
        reason = "No RC_CHANNELS frame has been received from the vehicle yet."
    elif value is None:
        reason = "The vehicle has not reported any RC_CHANNELS frame."
    elif value == 255:
        reason = "The vehicle reports RSSI as unknown (255)."
    else:
        reason = "The vehicle reports no valid RC link (RSSI 0)."
    return {
        "value": value if available else None,
        "raw": value,
        "available": available,
        "unavailableReason": reason,
    }


def _rc_state(identity: Dict[str, Any]) -> str:
    """Explicit connection/RC state for the page header.

    DISCONNECTED / CONNECTING / CONNECTED describe the link; WAITING_FOR_RC,
    RC_ACTIVE and RC_STALE describe the receiver. They are separate axes on
    purpose: a healthy MAVLink link is not evidence of a working RC link.
    """
    if not identity["connected"]:
        state = identity.get("connectionState")
        # core/state.py stores connectionState lowercase ("connecting").
        return "CONNECTING" if state == "connecting" else "DISCONNECTED"
    channels = telemetry.get("rcChannels") or []
    if not channels:
        return "WAITING_FOR_RC"
    if _last_rc_age_ms() > RC_STALE_MS:
        return "RC_STALE"
    if (telemetry.get("rcRssi") or 0) in (0, 255):
        return "RC_STALE"
    return "RC_ACTIVE"


def _calibration_stage(calibration: Dict[str, Any], identity: Dict[str, Any]) -> str:
    """Normalize the calibration state onto the documented stage names.

    Delegates to the machine's own mapping so the snapshot and the calibration
    status endpoint can never disagree about what stage the wizard is in. Only
    the disconnected case is decided here, because that depends on the link
    rather than on the machine.
    """
    if not identity["connected"]:
        return "DISCONNECTED"
    from services.radio_calibration import _stage_for

    return _stage_for(calibration.get("state"))


def _main_controls() -> Dict[str, Any]:
    supported = False
    mappings: List[Dict[str, Any]] = []
    for param, label in MAIN_CONTROL_PARAMS:
        value = _param_value(param)
        if value is not None:
            supported = True
            mappings.append(
                {
                    "function": label,
                    "param": param,
                    "channel": int(value),
                }
            )
        else:
            mappings.append({"function": label, "param": param, "channel": None})
    return {
        "supported": supported,
        "mappings": mappings,
        "channels": [m["channel"] for m in mappings if m["channel"] is not None],
    }


def _channel_configs() -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for channel in range(1, _MAX_CHANNELS + 1):
        pid_min = f"RC{channel}_MIN"
        pid_max = f"RC{channel}_MAX"
        pid_trim = f"RC{channel}_TRIM"
        pid_rev = f"RC{channel}_REVERSED"
        mn, mx, tr, rev = (
            _param_value(pid_min),
            _param_value(pid_max),
            _param_value(pid_trim),
            _param_value(pid_rev),
        )
        present = mn is not None or mx is not None or tr is not None or rev is not None
        if not present:
            continue
        out.append(
            {
                "channel": channel,
                "min": mn,
                "max": mx,
                "trim": tr,
                "reversed": int(rev) if rev is not None else 0,
                "supported": {
                    "min": mn is not None,
                    "trim": tr is not None,
                    "max": mx is not None,
                    "reversed": rev is not None,
                },
            }
        )
    return out


def validate_endpoints(
    min_value: float, trim_value: float, max_value: float
) -> Dict[str, Any]:
    """Reject impossible channel endpoints BEFORE a write is attempted.

    ArduPilot mandates MIN < TRIM < MAX (raw PWM). Returns success True or an
    explicit failure the UI can surface.
    """
    for label, value in (("MIN", min_value), ("TRIM", trim_value), ("MAX", max_value)):
        if not (900 <= value <= 2200):
            return {
                "success": False,
                "message": f"RC {label} value {value} is outside the valid 900–2200 range.",
            }
    if not (min_value < trim_value):
        return {
            "success": False,
            "message": f"MIN ({min_value}) must be less than TRIM ({trim_value}).",
        }
    if not (trim_value < max_value):
        return {
            "success": False,
            "message": f"TRIM ({trim_value}) must be less than MAX ({max_value}).",
        }
    return {"success": True, "message": ""}


# ---------------------------------------------------------------------------
# Snapshot
# ---------------------------------------------------------------------------

def get_radio_info() -> Dict[str, Any]:
    """Live Radio page snapshot — channel monitor, signal, controls, config."""
    identity = _identity()
    supported, unsupported_reason = _is_supported(identity)

    rssi = _rssi_report()
    rc_payload: Dict[str, Any] = {
        "channelCount": telemetry.get("rcChannelCount") or 0,
        "rssi": telemetry.get("rcRssi", 0),
        "rssiReport": rssi,
        "receivedAt": telemetry.get("rcReceivedAt", 0),
        "ageMs": int(_last_rc_age_ms()) if telemetry.get("rcReceivedAt") else None,
        "stale": bool(
            telemetry.get("rcReceivedAt")
            and _last_rc_age_ms() > RC_STALE_MS
        ),
        "channels": _channels(),
    }

    from services.radio_calibration import get_calibration_machine_status

    calibration = get_calibration_machine_status()
    controls = _main_controls()

    return {
        "success": True,
        **identity,
        "supported": supported,
        "unsupportedReason": unsupported_reason,
        "signal": _signal_state(identity),
        "rcState": _rc_state(identity),
        "rc": rc_payload,
        "mainControls": controls,
        "auxChannels": _aux_channels(controls["channels"]),
        "channelConfig": _channel_configs(),
        "calibration": calibration,
        "calibrationStage": _calibration_stage(calibration, identity),
    }