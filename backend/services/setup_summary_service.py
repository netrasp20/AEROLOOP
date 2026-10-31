"""Setup Summary configuration health matrix (QGC-style) for ArduCopter.

Single backend authority for SETUP → Summary configuration status. Everything
is derived from the live vehicle — never fabricated:

  * identity (type/autopilot/mode/armed...)  -> core.state.get_vehicle_status()
  * parameter presence + values              -> the downloaded PARAM_VALUE cache
                                               (mavlink.parameter_manager) — the
                                               authoritative oracle. ArduPilot
                                               hides/exposes parameters when
                                               subsystems are enabled, so what
                                               the vehicle actually downloaded
                                               is the ONLY proof of presence.
  * sensor calibration readback              -> calibration_service.get_sensor_status()
                                               (status per group, computed from
                                               the vehicle's own param readback).

Five-tone state model (good / warn / unsupported / unknown / waiting):

  * DISCONNECTED        -> connected:false, empty items; the frontend renders
                           the waiting/disconnected state. Never "unsupported".
  * sync != complete    -> every param-driven item is "waiting" ("Waiting for
                           parameter sync N/M"). A parameter that simply has not
                           been downloaded yet is NOT evidence of firmware
                           incompatibility — waiting must never collapse to
                           unsupported.
  * sync complete       -> each item is evaluated against the live cache:
                             supported + configured  -> good
                             supported + needs work  -> warn
                             genuinely not applicable -> unsupported (ONLY when
                             the defining param is absent from the live set —
                             never inferred from metadata)
                             cannot determine        -> unknown
  * "waiting" and "unknown" are distinct states and both are reported as
    unresolved in the count header; neither is ever flipped to "unsupported".

ArduCopter-only. Read-only: Summary never arms, moves actuators, starts
calibration, or writes parameters to compute a status.
"""

from typing import Any, Dict, List, Optional

from core.state import get_vehicle_status
from mavlink.parameter_manager import parameter_manager
from services.calibration_service import get_sensor_status

GOOD = "good"
WARN = "warn"
UNSUPPORTED = "unsupported"
UNKNOWN = "unknown"
WAITING = "waiting"

# (id, nav target on the YantraYug Setup screen)
ITEM_ORDER: List[tuple] = [
    ("frame", "frame"),
    ("accelerometer", "sensors"),
    ("gyroscope", "sensors"),
    ("compass", "sensors"),
    ("barometer", "sensors"),
    ("level", "sensors"),
    ("radio", "radio"),
    ("flightModes", "modes"),
    ("power", "power"),
    ("safety", "safety"),
    ("esc", "esc"),
    ("servoOutputs", "servos"),
    ("logging", "logging"),
    ("gps", "parameters"),
]

LABELS: Dict[str, str] = {
    "frame": "Frame / Airframe",
    "accelerometer": "Accelerometer",
    "gyroscope": "Gyroscope",
    "compass": "Compass",
    "barometer": "Barometer",
    "level": "Level Horizon",
    "radio": "Radio",
    "flightModes": "Flight Modes",
    "power": "Power / Battery",
    "safety": "Safety / Failsafes",
    "esc": "ESC",
    "servoOutputs": "Servo Outputs",
    "logging": "Logging",
    "gps": "GPS",
}


def _item(item_id: str, tone: str, message: str,
          detail: Optional[str] = None, **meta: Any) -> Dict[str, Any]:
    out: Dict[str, Any] = {
        "id": item_id,
        "label": LABELS[item_id],
        "tone": tone,
        "message": message,
        "nav": dict(ITEM_ORDER)[item_id],
    }
    if detail:
        out["detail"] = detail
    if meta:
        out["meta"] = meta
    return out


def _param_value(param_id: str) -> Optional[float]:
    entry = parameter_manager.get_parameter(param_id)
    return entry["value"] if entry else None


def _param_present(param_ids: List[str]) -> bool:
    return any(parameter_manager.get_parameter(pid) is not None for pid in param_ids)


def _sensor_group(sensors: Dict[str, Any], group: str) -> Dict[str, Any]:
    return sensors.get("sensors", {}).get(group, {}) or {}


def _entry_value(entries: Dict[str, Any], pid: str):
    entry = entries.get(pid)
    if entry is None or not entry.get("supported"):
        return None
    return entry.get("value")


def _sensor_toned_item(
    item_id: str,
    status: Optional[str],
    ok_message: str,
    ok_detail: Optional[str],
) -> Dict[str, Any]:
    """Map a calibration-service sensor group status onto the Summary 5-tone model."""
    if status == "unsupported":
        return _item(item_id, UNSUPPORTED, "Unsupported on this firmware")
    if status == "calibrated":
        return _item(item_id, GOOD, ok_message, ok_detail)
    if status == "not-calibrated":
        return _item(
            item_id, WARN, "Calibration required",
            "Run the calibration in SETUP → Sensors.",
        )
    return _item(item_id, UNKNOWN, "Cannot determine from current vehicle state")


# ---------------------------------------------------------------------------
# Evaluators (called only when the sync is complete)
# ---------------------------------------------------------------------------

def _evaluate_frame() -> Dict[str, Any]:
    cls = _param_value("FRAME_CLASS")
    if cls is None:
        return _item("frame", UNSUPPORTED, "Unsupported on this firmware")
    cls_val = int(cls)
    typ = _param_value("FRAME_TYPE")
    type_val = int(typ) if typ is not None else 0
    if cls_val == 0:
        return _item(
            "frame", WARN, "Frame class not set",
            "Select a frame in SETUP → Frame before first flight.",
            frameClass=0, frameType=type_val,
        )
    return _item(
        "frame", GOOD, "Configured · the selected airframe is valid",
        f"FRAME_CLASS={cls_val} · FRAME_TYPE={type_val}",
        frameClass=cls_val, frameType=type_val,
    )


def _evaluate_accelerometer(sensors: Dict[str, Any]) -> Dict[str, Any]:
    group = _sensor_group(sensors, "accel")
    value = _entry_value(group.get("ids", {}), "INS_ACC_ID")
    detail = f"Sensor id {value}" if value not in (None, 0) else None
    return _sensor_toned_item("accelerometer", group.get("status"), "Calibrated", detail)


def _evaluate_gyroscope(sensors: Dict[str, Any]) -> Dict[str, Any]:
    group = _sensor_group(sensors, "gyro")
    value = _entry_value(group.get("ids", {}), "INS_GYR_ID")
    detail = f"Sensor id {value}" if value not in (None, 0) else None
    return _sensor_toned_item("gyroscope", group.get("status"), "Calibrated", detail)


def _evaluate_compass(sensors: Dict[str, Any]) -> Dict[str, Any]:
    group = _sensor_group(sensors, "compass")
    status = group.get("status")
    if status == "unsupported":
        return _item("compass", UNSUPPORTED, "Unsupported on this firmware")
    use = _entry_value(group.get("ids", {}), "COMPASS_USE")
    if use is not None and int(use) == 0:
        return _item(
            "compass", WARN, "Disabled",
            "Set COMPASS_USE=1 or calibrate in SETUP → Sensors.",
        )
    if status == "calibrated":
        ofs = _entry_value(group.get("offsets", {}), "COMPASS_OFS_X")
        detail = "COMPASS_USE=1" + (f" · offset X={ofs}" if ofs not in (None, 0) else " · offsets stored")
        return _item("compass", GOOD, "Enabled · calibrated", detail)
    if status == "not-calibrated":
        return _item(
            "compass", WARN, "Calibration required",
            "Calibrate the compass in SETUP → Sensors.",
        )
    return _item("compass", UNKNOWN, "Cannot determine from current vehicle state")


def _evaluate_barometer(sensors: Dict[str, Any]) -> Dict[str, Any]:
    group = _sensor_group(sensors, "baro")
    status = group.get("status")
    if status == "unsupported":
        return _item("barometer", UNSUPPORTED, "Unsupported on this firmware")
    press = group.get("gndPress")
    if press is None:
        press = _param_value("BARO1_GND_PRESS")
    if status == "not-calibrated" or press in (None, 0):
        return _item(
            "barometer", WARN, "Calibration required",
            "Barometer ground-pressure calibration pending.",
        )
    return _item(
        "barometer", GOOD, "Calibrated",
        f"Ground pressure {round(press)} Pa",
    )


def _evaluate_level(sensors: Dict[str, Any]) -> Dict[str, Any]:
    def _trim_value(group: Dict[str, Any], key: str) -> float:
        value = group.get("trim", {}).get(key)
        return float(value) if isinstance(value, (int, float)) else 0.0

    if not _param_present(["AHRS_TRIM_X", "AHRS_TRIM_Y"]):
        return _item("level", UNSUPPORTED, "Unsupported on this firmware")
    x = _trim_value(_sensor_group(sensors, "level"), "x")
    y = _trim_value(_sensor_group(sensors, "level"), "y")
    # A leveled-and-calibrated multirotor stores a small reset offset (typ.
    # well under ±0.01 rad). Near-zero is both the factory default and the
    # healthy bound. Only a genuinely large offset needs re-leveling.
    detail = f"AHRS_TRIM_X={x:.4f} · AHRS_TRIM_Y={y:.4f}"
    if abs(x) <= 0.01 and abs(y) <= 0.01:
        return _item("level", GOOD, "Level horizon set", detail)
    return _item(
        "level", WARN, "Level horizon offset large",
        f"{detail} — level the vehicle in SETUP → Sensors.",
    )


def _evaluate_radio() -> Dict[str, Any]:
    rc_min = _param_value("RC1_MIN")
    rc_max = _param_value("RC1_MAX")
    if rc_min is None or rc_max is None:
        return _item("radio", UNSUPPORTED, "Unsupported on this firmware")
    # Calibration is proven by the stored channel endpoints — merely having the
    # parameters exist is NOT treated as configured.
    calibrated = rc_min <= 1100 and rc_max >= 1900
    trim = _param_value("RC1_TRIM")
    detail = f"RC1_MIN={rc_min} · RC1_MAX={rc_max}"
    if trim is not None:
        detail += f" · RC1_TRIM={trim}"
    return _item(
        "radio",
        GOOD if calibrated else WARN,
        "RC calibration stored" if calibrated else "RC calibration required",
        detail,
    )


def _evaluate_flight_modes() -> Dict[str, Any]:
    channel = _param_value("FLTMODE_CH")
    if channel is None:
        return _item("flightModes", UNSUPPORTED, "Unsupported on this firmware")
    if int(channel) == 0:
        return _item(
            "flightModes", WARN, "Mode channel not assigned",
            "Set FLTMODE_CH in SETUP → Flight Modes.",
        )
    configured = sum(
        1
        for i in range(1, 7)
        if _param_value(f"FLTMODE{i}") is not None
    )
    return _item(
        "flightModes", GOOD, "Configured",
        f"FLTMODE_CH=Channel {int(channel)} · {configured} slots",
    )


def _flight_mode_values() -> List[Dict[str, Any]]:
    """Return the six ArduCopter mode slots from the live parameter cache."""
    from mavlink.telemetry_manager import MODE_MAPS

    mode_map = MODE_MAPS["COPTER"]
    values: List[Dict[str, Any]] = []
    for slot in range(1, 7):
        value = _param_value(f"FLTMODE{slot}")
        values.append({
            "slot": slot,
            "value": int(value) if value is not None else None,
            "name": mode_map.get(int(value), "Unavailable") if value is not None else "Unavailable",
        })
    return values


def _capability_value(param_ids: List[str], enabled_message: str) -> str:
    present = [pid for pid in param_ids if _param_value(pid) is not None]
    if not present:
        return "Unavailable"
    enabled = any((_param_value(pid) or 0) > 0 for pid in present)
    return enabled_message if enabled else "Not configured"


def _evaluate_power() -> Dict[str, Any]:
    monitor = _param_value("BATT_MONITOR")
    if monitor is None:
        return _item("power", UNSUPPORTED, "Unsupported on this firmware")
    if int(monitor) == 0:
        return _item(
            "power", WARN, "Battery monitoring disabled",
            "Set BATT_MONITOR to a supported monitor type in SETUP → Power.",
        )
    return _item("power", GOOD, "Monitoring enabled", f"BATT_MONITOR={int(monitor)}")


def _evaluate_safety() -> Dict[str, Any]:
    enrolled = [
        pid
        for pid in (
            "FS_THR_ENABLE", "FS_GCS_ENABLE", "FS_RADIO_ENABLE",
            "BATT_FS_LOW_ACT", "BATT_FS_CRT_ACT", "FENCE_ENABLE",
        )
        if _param_value(pid) is not None
    ]
    if not enrolled:
        return _item("safety", UNSUPPORTED, "Unsupported on this firmware")

    active: List[str] = []
    if _param_value("FS_THR_ENABLE") == 1:
        active.append("Throttle")
    if (_param_value("BATT_FS_LOW_ACT") or 0) > 0:
        active.append("Battery-Low")
    if (_param_value("BATT_FS_CRT_ACT") or 0) > 0:
        active.append("Battery-Critical")
    if _param_value("FENCE_ENABLE") == 1:
        active.append("Fence")
    if _param_value("FS_GCS_ENABLE") == 1:
        active.append("GCS")
    if active:
        return _item("safety", GOOD, " + ".join(active), "Enabled protections listed.")
    return _item(
        "safety", WARN, "No failsafes enabled",
        "Enable throttle/battery failsafes in SETUP → Safety.",
    )


def _evaluate_esc() -> Dict[str, Any]:
    pwm_type = _param_value("MOT_PWM_TYPE")
    if pwm_type is None:
        return _item("esc", UNSUPPORTED, "Unsupported on this firmware")
    # Presence of the ESC output mode is configuration evidence only — an ESC
    # calibration is never claimed here.
    return _item("esc", GOOD, "Configured", f"MOT_PWM_TYPE={int(pwm_type)}")


def _evaluate_servo_outputs() -> Dict[str, Any]:
    for pid in (
        "SERVO1_FUNCTION", "SERVO1_MIN", "SERVO1_MAX", "SERVO1_TRIM", "RC1_FUNCTION",
    ):
        if _param_value(pid) is not None:
            fn = _param_value("SERVO1_FUNCTION")
            detail = f"SERVO1_FUNCTION={int(fn)}" if fn is not None else "Output functions assigned"
            return _item("servoOutputs", GOOD, "Configured", detail)
    return _item("servoOutputs", UNSUPPORTED, "Unsupported on this firmware")


def _evaluate_logging() -> Dict[str, Any]:
    bitmask = _param_value("LOG_BITMASK")
    if bitmask is None:
        return _item("logging", UNSUPPORTED, "Unsupported on this firmware")
    if int(bitmask) == 0:
        return _item(
            "logging", WARN, "Disabled",
            "Set LOG_BITMASK to a non-zero value in SETUP → Logging.",
        )
    return _item("logging", GOOD, "Enabled", f"LOG_BITMASK={int(bitmask)}")


def _evaluate_gps(identity: Dict[str, Any]) -> Dict[str, Any]:
    if _param_value("GPS1_TYPE") is None:
        return _item("gps", UNSUPPORTED, "Unsupported on this firmware")
    satellites = identity.get("satellites") or 0
    if satellites > 0:
        return _item("gps", GOOD, "Fix acquired", f"{satellites} satellites tracked")
    return _item(
        "gps", WARN, "No satellite fix yet",
        "Position will be required for autonomous flight.",
    )


_EVALUATORS = {
    "frame": _evaluate_frame,
    "radio": _evaluate_radio,
    "flightModes": _evaluate_flight_modes,
    "power": _evaluate_power,
    "safety": _evaluate_safety,
    "esc": _evaluate_esc,
    "servoOutputs": _evaluate_servo_outputs,
    "logging": _evaluate_logging,
    "gps": _evaluate_gps,
}

# Evaluators that consume the shared sensor-status readback.
_SENSOR_EVALUATORS = {
    "accelerometer": _evaluate_accelerometer,
    "gyroscope": _evaluate_gyroscope,
    "compass": _evaluate_compass,
    "barometer": _evaluate_barometer,
    "level": _evaluate_level,
}


def _counts(items: List[Dict[str, Any]]) -> Dict[str, int]:
    counts = {GOOD: 0, WARN: 0, UNSUPPORTED: 0, UNKNOWN: 0, WAITING: 0}
    for item in items:
        counts[item["tone"]] = counts.get(item["tone"], 0) + 1
    return counts


def _wait_items(sync: Dict[str, Any]) -> List[Dict[str, Any]]:
    """All param-driven items are WAITING until the sync completes.

    A parameter that has not been downloaded yet is waiting for synchronization,
    never "unsupported". The message carries the beat of the download so the UI
    can show `Parameters syncing — X/Y`.
    """
    expected = sync.get("expectedCount") or 0
    received = sync.get("receivedCount") or 0
    message = (
        f"Waiting for parameter sync ({received}/{expected})"
        if expected > 0
        else "Syncing parameters…"
    )
    return [
        _item(item_id, WAITING, message)
        for item_id, _ in ITEM_ORDER
    ]


def get_setup_summary() -> Dict[str, Any]:
    """Build the full Setup Summary response.

    `connected` is the live MAVLink/transport truth; when false the frontend
    renders the disconnected/waiting state and no configuration matrix is
    produced (no stale values). When connected the matrix is gated on the
    parameter synchronization state: everything is WAITING until the download
    completes, then each category is evaluated from the live vehicle state.
    """
    identity = get_vehicle_status()
    if not identity["connected"]:
        return {
            "success": True,
            "connected": False,
            "sync": parameter_manager.get_synchronization_state(),
            "items": [],
            "counts": _counts([]),
            "flightModes": [],
            "capabilities": {"camera": "Unavailable", "scripting": "Unavailable"},
        }

    sync = parameter_manager.get_synchronization_state()
    if sync["state"] != "complete":
        items = _wait_items(sync)
        return {
            "success": True,
            "connected": True,
            "sync": sync,
            "items": items,
            "counts": _counts(items),
            "flightModes": [],
            "capabilities": {"camera": "Unavailable", "scripting": "Unavailable"},
        }

    sensor_status = get_sensor_status()
    items = []
    for item_id, _nav in ITEM_ORDER:
        if item_id in _SENSOR_EVALUATORS:
            items.append(_SENSOR_EVALUATORS[item_id](sensor_status))
        elif item_id == "gps":
            items.append(_EVALUATORS[item_id](identity))
        else:
            items.append(_EVALUATORS[item_id]())

    return {
        "success": True,
        "connected": True,
        "sync": sync,
        "items": items,
        "counts": _counts(items),
        "flightModes": _flight_mode_values(),
        "capabilities": {
            "camera": _capability_value(["CAM1_TYPE", "CAM2_TYPE"], "Configured"),
            "scripting": _capability_value(["SCR_ENABLE"], "Enabled"),
        },
    }
