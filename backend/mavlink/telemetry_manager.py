"""MAVLink → telemetry pipeline, ported from backend/src/mavlink/telemetryManager.ts.

Handles inbound MAVLink messages, updates the shared `telemetry` and
`vehicleState` dicts, and broadcasts `telemetry:update` only when a value has
actually changed (delta-based emit), plus `vehicleStatus`.
"""

import math
import re
import threading
import time
from typing import Any, Callable, Dict, List, Optional

from core.state import telemetry, vehicle_state, reset_mission_stats
from sio import server as sio_server

# ------------------------------------------------------------------
# Constants (parity with telemetryManager.ts)
# ------------------------------------------------------------------
HOME_REACHED_THRESHOLD_M = 2
LANDING_ALT_THRESHOLD_M = 1.0
LANDING_TIMEOUT_MS = 60000
LANDING_POLL_MS = 500
WAYPOINT_REACHED_THRESHOLD_M = 6

# ------------------------------------------------------------------
# Mode maps (parity)
# ------------------------------------------------------------------
MODE_MAPS: Dict[str, Dict[int, str]] = {
    "ROVER": {
        0: "MANUAL", 1: "ACRO", 3: "STEERING", 4: "HOLD",
        5: "LOITER", 6: "FOLLOW", 7: "SIMPLE", 10: "AUTO",
        11: "RTL", 12: "SMART_RTL", 15: "GUIDED", 16: "INITIALISING",
    },
    # ArduCopter Mode::Number enum -- ArduCopter/mode.h:77-109, which matches the
    # @Values map of the FLTMODE1 parameter (ArduCopter/Parameters.cpp:153).
    # Codes 8, 10 and 12 do not exist; 30/127 are reserved for offboard / Skybrush
    # and are deliberately absent. Codes 26-30 were previously legacy helicopter
    # numbering (HELI_STABILIZE/HELI_ACRO/HELI_CH8/HELI_GUIDED/HELI_AUTOROTATE),
    # which is wrong for ArduPilot 4.x and mislabelled real Copter modes.
    "COPTER": {
        0: "STABILIZE", 1: "ACRO", 2: "ALT_HOLD", 3: "AUTO",
        4: "GUIDED", 5: "LOITER", 6: "RTL", 7: "CIRCLE",
        9: "LAND", 11: "DRIFT", 13: "SPORT", 14: "FLIP",
        15: "AUTOTUNE", 16: "POSHOLD", 17: "BRAKE", 18: "THROW",
        19: "AVOID_ADSB", 20: "GUIDED_NOGPS", 21: "SMART_RTL",
        22: "FLOWHOLD", 23: "FOLLOW", 24: "ZIGZAG", 25: "SYSTEMID",
        26: "AUTOROTATE", 27: "AUTO_RTL", 28: "TURTLE",
    },
    "PLANE": {
        0: "MANUAL", 1: "CIRCLE", 2: "STABILIZE", 3: "TRAINING",
        4: "ACRO", 5: "FBWA", 6: "FBWB", 7: "CRUISE",
        8: "AUTOTUNE", 10: "AUTO", 11: "RTL", 12: "LOITER",
        14: "AVOID_LAND", 15: "GUIDED", 16: "INITIALISING",
        17: "QSTABILIZE", 18: "QHOVER", 19: "QLOITER",
        20: "QLAND", 21: "QRTL", 22: "QAUTOTUNE", 23: "QACRO",
        24: "THERMAL", 25: "LOITER_ALT", 26: "LOITER_ALT_QLAND",
    },
}

VEHICLE_NAMES: Dict[int, str] = {
    0: "GENERIC", 1: "FIXED_WING", 2: "QUADROTOR", 3: "COAXIAL",
    4: "HELICOPTER", 5: "ANTENNA_TRACKER", 6: "GCS", 7: "AIRSHIP",
    8: "FREE_BALLOON", 9: "ROCKET", 10: "GROUND_ROVER", 11: "SURFACE_BOAT",
    12: "SUBMARINE", 13: "HEXAROTOR", 14: "OCTOROTOR", 15: "TRIROTOR",
    16: "QUADROTOR", 17: "ONBOARD_CONTROLLER", 18: "GIMBAL", 19: "ADSB",
    20: "PARAFOIL", 21: "VTOL_DUOROTOR", 22: "VTOL_QUADROTOR",
    23: "VTOL_TILTROTOR", 24: "VTOL_FIXEDROTOR", 25: "VTOL_TAILSITTER",
    26: "VTOL_TILTWING", 27: "VTOL_TAILSITTER_DUOROTOR",
    28: "VTOL_TAILSITTER_QUADROTOR", 29: "VTOL_TILTROTOR_DUOROTOR",
    30: "VTOL_FUSION", 31: "OCTOROTOR", 32: "VTOL_RESERVED_5", 33: "VTOL_RESERVED_6",
}

AUTOPILOT_NAMES: Dict[int, str] = {
    0: "GENERIC", 1: "RESERVED", 2: "SLUGS", 3: "ARDUPILOTMEGA",
    4: "OPENPILOT", 5: "GENERIC_WAYPOINTS_ONLY", 6: "GENERIC_WAYPOINTS_AND_SIMPLE_NAVIGATION_ONLY",
    7: "GENERIC_MISSION_FULL", 8: "INVALID", 9: "PPZ", 10: "UAVDB", 11: "FP",
    12: "PX4", 13: "SMACCMPILOT", 14: "AUTOQUAD", 15: "ARMAZILA", 16: "AEROB",
    17: "ASLUAV", 18: "SMARTAP", 19: "AIRRAILS", 20: "REFLEX",
}

ARM_RELEVANT_KEYWORDS = [
    "PreArm", "Arm", "ARM",
    "Failsafe",
    "GPS",
    "EKF",
    "Safety",
    "Battery",
    "RC",
]
ARM_RELEVANT_PATTERN = re.compile("|".join(ARM_RELEVANT_KEYWORDS), re.IGNORECASE)
REACHED_WAYPOINT_PATTERN = re.compile(r"^Reached waypoint #(\d+)")

# ------------------------------------------------------------------
# Delta-based emit (parity: only broadcast when a value changed)
# ------------------------------------------------------------------
_previous: tuple = ()
_emit_counter: int = 0
_last_reached_seq: int = 0
_last_reached_time: int = 0
_home_position_captured: bool = False
_gp_counter: int = 0
_gps_raw_counter: int = 0
_active_mission_waypoints: List[Dict[str, Any]] = []


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    dlat = (lat2 - lat1) * math.pi / 180
    dlon = (lon2 - lon1) * math.pi / 180
    a = math.sin(dlat / 2) ** 2 + math.cos(lat1 * math.pi / 180) * math.cos(
        lat2 * math.pi / 180
    ) * math.sin(dlon / 2) ** 2
    return r * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    return _haversine_km(lat1, lon1, lat2, lon2) * 1000


def set_active_mission_waypoints(waypoints: List[Dict[str, Any]]) -> None:
    global _active_mission_waypoints
    _active_mission_waypoints = waypoints


def clear_active_mission_waypoints() -> None:
    global _active_mission_waypoints
    _active_mission_waypoints = []


def _emit(payload: Dict[str, Any]) -> None:
    global _emit_counter
    _emit_counter += 1
    sio_server.emit("telemetry:update", payload)
    if _emit_counter <= 20 or _emit_counter % 10 == 1:
        print(
            f"[EMIT] #{_emit_counter} lat={payload.get('latitude', 0):.6f} "
            f"lon={payload.get('longitude', 0):.6f} connected={payload.get('connected')} "
            f"armed={payload.get('armed')}"
        )


def emit_if_changed() -> None:
    global _previous
    telemetry["timestamp"] = int(time.time() * 1000)
    snapshot = tuple(telemetry.get(k) for k in sorted(telemetry))
    if snapshot == _previous:
        return
    _previous = snapshot
    _emit(telemetry)


def update_telemetry(updates: Dict[str, Any]) -> None:
    for key, value in updates.items():
        telemetry[key] = value
    emit_if_changed()


def get_telemetry() -> Dict[str, Any]:
    return telemetry


def print_telemetry() -> None:
    print(
        f"[TELEMETRY] Mode:{telemetry['mode']} Armed:{telemetry['armed']} "
        f"Lat:{telemetry['latitude']:.6f} Lon:{telemetry['longitude']:.6f} "
        f"Alt:{telemetry['altitude']:.1f}m GS:{telemetry['groundSpeed']:.1f}m/s "
        f"HDG:{telemetry['heading']:.0f}° Bat:{telemetry['batteryRemaining']}% "
        f"Sats:{telemetry['satellites']} Fix:{telemetry['gpsFix']}"
    )


def reset_home_position() -> None:
    global _home_position_captured
    _home_position_captured = False
    telemetry["homeLatitude"] = 0
    telemetry["homeLongitude"] = 0
    telemetry["homeAltitude"] = 0


def reset_telemetry() -> None:
    global _last_reached_seq, _last_reached_time
    for key in (
        "connected", "systemId", "componentId", "mode", "modeCode", "armed", "gpsFix",
        "satellites", "statusText", "batteryRemaining", "batteryVoltage",
        "batteryCurrent", "missionRunning", "missionCompleted",
        "rcChannels", "rcChannelCount", "rcRssi", "rcReceivedAt", "rcSignal",
    ):
        telemetry[key] = {
            "connected": False,
            "systemId": 0,
            "componentId": 0,
            "mode": "DISCONNECTED",
            # Raw HEARTBEAT.custom_mode. Exposed so consumers can resolve the mode
            # name authoritatively from vehicle parameter metadata instead of
            # trusting the best-effort `mode` string above.
            "modeCode": 0,
            "armed": False,
            "gpsFix": 0,
            "satellites": 0,
            "statusText": "",
            "batteryRemaining": 0,
            "batteryVoltage": 0,
            "batteryCurrent": 0,
            "missionRunning": False,
            "missionCompleted": False,
            "rcChannels": [],
            "rcChannelCount": 0,
            "rcRssi": 0,
            "rcReceivedAt": 0,
            "rcSignal": "NO_SIGNAL",
        }[key]

    for key in (
        "mode", "modeCode", "armed", "missionRunning", "systemId", "componentId",
        "gpsFix", "satellites",
    ):
        vehicle_state[key] = {
            "mode": "DISCONNECTED",
            "modeCode": 0,
            "armed": False,
            "missionRunning": False,
            "systemId": 0,
            "componentId": 0,
            "gpsFix": 0,
            "satellites": 0,
        }[key]

    telemetry["rcChannels"] = []
    telemetry["rcSignal"] = "UNKNOWN"
    telemetry["rcChannelCount"] = 0
    telemetry["rcRssi"] = 0
    telemetry["rcReceivedAt"] = 0
    telemetry["fenceBreachStatus"] = 0

    reset_battery_telemetry()
    reset_actuator_telemetry()
    reset_gimbal_telemetry()
    reset_mission_stats()
    reset_home_position()
    reset_stream_requested()
    _emit(telemetry)


# ------------------------------------------------------------------
# Mission running helpers (parity subset used by telemetry pipeline)
# ------------------------------------------------------------------
_completion_detection_on = False


def set_mission_running(value: bool) -> None:
    global _completion_detection_on
    vehicle_state["missionRunning"] = value
    telemetry["missionRunning"] = value
    if value:
        vehicle_state["missionCompleted"] = False
        telemetry["missionCompleted"] = False
        telemetry["missionCurrent"] = 0
        telemetry["missionReached"] = 0
        global _last_reached_seq, _last_reached_time
        _last_reached_seq = 0
        _last_reached_time = 0
        reset_mission_stats()
        vehicle_state["missionStartTime"] = int(time.time() * 1000)
        start_completion_detection()
        print("[MISSION] Mission is now RUNNING")
    else:
        stop_completion_detection()
        print("[MISSION] Mission is no longer running")
    emit_if_changed()


def mission_item_to_waypoint_seq(mav_seq: int) -> int:
    vt = telemetry["vehicleType"] or ""
    is_air = not (vt.startswith("GROUND") or vt == "SURFACE_BOAT")
    return (mav_seq - 1 if mav_seq >= 2 else 0) if is_air else mav_seq


def _distance_to_waypoint_m(seq: int) -> Optional[float]:
    for wp in _active_mission_waypoints:
        if wp["seq"] == seq:
            return _haversine_m(
                telemetry["latitude"], telemetry["longitude"], wp["lat"], wp["lng"]
            )
    return None


def mark_waypoint_reached(seq: int) -> None:
    global _last_reached_seq, _last_reached_time
    if not vehicle_state["missionRunning"]:
        return
    if seq > vehicle_state["missionWaypointsVisited"] + 1:
        print(
            f"[MISSION] Ignoring stale reached waypoint seq={seq} "
            f"(current visited={vehicle_state['missionWaypointsVisited']}, "
            f"expected ≤{vehicle_state['missionWaypointsVisited'] + 1})"
        )
        return
    if seq > telemetry["missionReached"]:
        dist = _distance_to_waypoint_m(seq)
        if dist is not None and dist > WAYPOINT_REACHED_THRESHOLD_M:
            print(
                f"[MISSION] Ignoring premature reached waypoint seq={seq} "
                f"(rover {dist:.1f}m from WP{seq})"
            )
            return
    update_telemetry({"missionReached": seq})
    if seq > vehicle_state["missionWaypointsVisited"]:
        vehicle_state["missionWaypointsVisited"] = seq
    if seq != _last_reached_seq:
        _last_reached_seq = seq
        _last_reached_time = int(time.time() * 1000)
    print(
        f"[MISSION] Waypoint Reached (arrival): {seq} "
        f"(total visited: {vehicle_state['missionWaypointsVisited']})"
    )


# ------------------------------------------------------------------
# Auto-RTL + landing gate (parity) — RTL command wiring arrives in Phase D.
# ------------------------------------------------------------------
auto_rtl_on_completion: Optional[Callable] = None
_completion_rtl_in_progress = False


def set_auto_rtl_on_completion(fn: Optional[Callable]) -> None:
    global auto_rtl_on_completion
    auto_rtl_on_completion = fn


def _wait_for_landing(emit_progress: Optional[Callable] = None):
    started_at = int(time.time() * 1000)
    while True:
        landed = (not vehicle_state["armed"]) or (
            telemetry["relativeAltitude"] <= LANDING_ALT_THRESHOLD_M
        )
        if landed:
            print(
                f"[MISSION] Vehicle landed (relAlt={telemetry['relativeAltitude']:.2f}m, "
                f"armed={vehicle_state['armed']}) — completing mission"
            )
            return
        if int(time.time() * 1000) - started_at > LANDING_TIMEOUT_MS:
            print("[MISSION] Landing wait timed out — completing mission anyway.")
            return
        if emit_progress:
            emit_progress("Vehicle reached home — descending to land...", telemetry["distanceToHome"])
        time.sleep(LANDING_POLL_MS / 1000.0)


def _trigger_auto_rtl_and_complete() -> None:
    global _completion_rtl_in_progress
    if _completion_rtl_in_progress:
        return
    _completion_rtl_in_progress = True

    def emit_progress(message: str, distance_m: float) -> None:
        sio_server.emit(
            "mission:rtl:progress",
            {"step": "returning", "message": message, "distanceM": distance_m, "auto": True},
        )

    def _run() -> None:
        # Runs on a dedicated thread so the MAVLink reader keeps consuming
        # heartbeats/telemetry while the blocking RTL + landing wait polls.
        global _completion_rtl_in_progress
        try:
            emit_progress(
                "All waypoints reached — returning to launch (RTL)...",
                telemetry["distanceToHome"],
            )

            if auto_rtl_on_completion is not None:
                result = auto_rtl_on_completion(emit_progress)
            else:
                result = {"success": True, "message": "No RTL handler registered."}

            if result.get("success"):
                sio_server.emit(
                    "mission:rtl:success",
                    {
                        "message": result.get("message"),
                        "distanceM": telemetry["distanceToHome"],
                        "auto": True,
                    },
                )
                _wait_for_landing(emit_progress)
            else:
                sio_server.emit(
                    "mission:rtl:error",
                    {"message": result.get("message"), "auto": True},
                )
                print(f"[MISSION] Auto-RTL after mission finished failed: {result.get('message')}")

            complete_mission()
        finally:
            _completion_rtl_in_progress = False

    threading.Thread(target=_run, daemon=True, name="auto-rtl-complete").start()


def complete_mission() -> None:
    if not vehicle_state["missionRunning"]:
        return
    vehicle_state["missionCompleted"] = True
    telemetry["missionCompleted"] = True
    vehicle_state["missionEndTime"] = int(time.time() * 1000)
    set_mission_running(False)

    elapsed = vehicle_state["missionEndTime"] - vehicle_state["missionStartTime"]
    avg_speed = (
        vehicle_state["missionTotalDistance"] / (elapsed / 1000) if elapsed > 0 else 0
    )
    waypoints_visited = max(
        vehicle_state["missionWaypointsVisited"],
        vehicle_state["missionTotalWaypoints"],
    )
    summary = {
        "startTime": vehicle_state["missionStartTime"],
        "endTime": vehicle_state["missionEndTime"],
        "elapsedMs": elapsed,
        "totalDistance": round(vehicle_state["missionTotalDistance"]),
        "avgSpeed": round(avg_speed * 10) / 10,
        "maxSpeed": round(vehicle_state["missionMaxSpeed"] * 10) / 10,
        "waypointsVisited": waypoints_visited,
        "status": "success",
    }
    sio_server.emit("mission:completed", summary)
    print("[MISSION] Mission COMPLETED", summary)
    sio_server.broadcast_vehicle_status()


def _check_stuck_at_last_waypoint() -> None:
    global _last_reached_seq, _last_reached_time
    if not vehicle_state["missionRunning"]:
        return
    if _last_reached_seq == 0:
        return
    if vehicle_state["missionWaypointsVisited"] <= 0:
        return
    if vehicle_state["missionWaypointsVisited"] < vehicle_state["missionTotalWaypoints"]:
        return
    stuck_ms = int(time.time() * 1000) - _last_reached_time
    if stuck_ms > 4000 and vehicle_state["missionRunning"]:
        gs = telemetry["groundSpeed"]
        if gs < 0.1:
            print(
                f"[MISSION] Detected mission completion — last WP {_last_reached_seq} "
                f"reached {stuck_ms}ms ago, speed={gs}"
            )
            _trigger_auto_rtl_and_complete()


_completion_check_interval = None


def start_completion_detection() -> None:
    """Start a 1s background thread emulating Node's setInterval.

    Parity with telemetryManager.ts (checkStuckAtLastWaypoint, 1000ms). This
    must run on its own thread: tying it to the reader-loop tick only fires on
    idle gaps, but ArduPilot streams telemetry continuously, so the tick never
    runs and the stuck-at-last-waypoint check (and mission:completed) would
    never trigger.
    """
    global _completion_check_interval
    if _completion_check_interval is not None:
        return

    def _run() -> None:
        while True:
            time.sleep(1.0)
            if _completion_check_interval is None:
                return
            try:
                completion_tick()
            except Exception as err:  # noqa: BLE001
                print(f"[MISSION] completion check error: {err}")

    _completion_check_interval = True
    threading.Thread(target=_run, daemon=True, name="mission-completion-check").start()


def stop_completion_detection() -> None:
    global _completion_check_interval
    _completion_check_interval = None


def completion_tick() -> None:
    """Called once per second to emulate the 1s setInterval."""
    _check_stuck_at_last_waypoint()


# ------------------------------------------------------------------
# Battery telemetry tracking (Phase 8F — ArduCopter / Pixhawk)
# ------------------------------------------------------------------
BATTERY_STALE_MS = 3000
ACTUATOR_TELEMETRY_STALE_MS = 3000

MAV_BATTERY_CHARGE_STATE_MAP = {
    0: "UNDEFINED",
    1: "OK",
    2: "LOW",
    3: "CRITICAL",
    4: "EMERGENCY",
    5: "FAILED",
    6: "UNHEALTHY",
    7: "CHARGING",
}

_batteries: Dict[int, Dict[str, Any]] = {}
_servo_outputs: Dict[int, Dict[str, Any]] = {}
_esc_telemetry: Dict[int, Dict[str, Any]] = {}


def _fresh_snapshot(records: Dict[int, Dict[str, Any]], key: str) -> Dict[str, Any]:
    now = time.time()
    values = []
    for channel in sorted(records):
        item = dict(records[channel])
        received = item.get("receivedAt")
        age_ms = int((now - received) * 1000) if received is not None else None
        item["ageMs"] = age_ms
        item["stale"] = age_ms is None or age_ms > ACTUATOR_TELEMETRY_STALE_MS
        values.append(item)
    return {key: values, "timestamp": int(now * 1000), "staleThresholdMs": ACTUATOR_TELEMETRY_STALE_MS}


def get_servo_output_snapshot() -> Dict[str, Any]:
    return _fresh_snapshot(_servo_outputs, "channels")


def get_esc_telemetry_snapshot() -> Dict[str, Any]:
    return _fresh_snapshot(_esc_telemetry, "escs")


# ------------------------------------------------------------------
# Gimbal devices and on-board log entries (Phase 8I, read-only)
#
# Only genuine vehicle frames populate these records:
#   * GIMBAL_DEVICE_INFORMATION  (259) device identity / capability flags
#   * GIMBAL_DEVICE_ATTITUDE_STATUS (285) reported attitude
#   * LOG_ENTRY (117)           on-board dataflash log list
#
# Nothing is synthesised, no command is ever sent and a device that never
# transmits simply stays absent, which the Setup page reports as unavailable.
# ------------------------------------------------------------------

GIMBAL_TELEMETRY_STALE_MS = 3000

# MAVLink2 GIMBAL_DEVICE_INFORMATION.cap_flags (GIMBAL_DEVICE_CAP_FLAGS)
GIMBAL_CAP_FLAGS = (
    (1 << 0, "GIMBAL_DEVICE_CAP_FLAGS_HAS_RETRACT"),
    (1 << 1, "GIMBAL_DEVICE_CAP_FLAGS_HAS_NEUTRAL"),
    (1 << 2, "GIMBAL_DEVICE_CAP_FLAGS_HAS_ROLL_AXIS"),
    (1 << 3, "GIMBAL_DEVICE_CAP_FLAGS_HAS_ROLL_FOLLOW"),
    (1 << 4, "GIMBAL_DEVICE_CAP_FLAGS_HAS_ROLL_LOCK"),
    (1 << 5, "GIMBAL_DEVICE_CAP_FLAGS_HAS_PITCH_AXIS"),
    (1 << 6, "GIMBAL_DEVICE_CAP_FLAGS_HAS_PITCH_FOLLOW"),
    (1 << 7, "GIMBAL_DEVICE_CAP_FLAGS_HAS_PITCH_LOCK"),
    (1 << 8, "GIMBAL_DEVICE_CAP_FLAGS_HAS_YAW_AXIS"),
    (1 << 9, "GIMBAL_DEVICE_CAP_FLAGS_HAS_YAW_FOLLOW"),
    (1 << 10, "GIMBAL_DEVICE_CAP_FLAGS_HAS_YAW_LOCK"),
    (1 << 11, "GIMBAL_DEVICE_CAP_FLAGS_SUPPORTS_INFINITE_YAW"),
)

# MAVLink2 GIMBAL_DEVICE_ATTITUDE_STATUS.flags (GIMBAL_DEVICE_FLAGS)
GIMBAL_STATUS_FLAGS = (
    (1 << 0, "ROLL_LOCK"),
    (1 << 1, "PITCH_LOCK"),
    (1 << 2, "YAW_LOCK"),
    (1 << 3, "YAW_IN_VEHICLE_FRAME"),
    (1 << 4, "YAW_IN_EARTH_FRAME"),
    (1 << 5, "AC_QUIET"),
    (1 << 6, "AC_LOCK"),
    (1 << 7, "AC_FOLLOW"),
)

# GIMBAL_DEVICE_CAP_FLAGS / GIMBAL_DEVICE_FAIL_FLAGS share this bit layout.
GIMBAL_FAILURE_FLAGS = (
    (1 << 0, "AT_ROLL_LIMIT"),
    (1 << 1, "AT_PITCH_LIMIT"),
    (1 << 2, "AT_YAW_LIMIT"),
    (1 << 3, "ENCODER_ERROR"),
    (1 << 4, "POWER_ERROR"),
    (1 << 5, "MOTOR_ERROR"),
    (1 << 6, "SOFTWARE_ERROR"),
    (1 << 7, "COMMS_ERROR"),
    (1 << 8, "CALIBRATION_RUNNING"),
    (1 << 9, "NO_MANAGER"),
    (1 << 10, "SET_STARTUP_DELAY"),
)

_gimbals: Dict[int, Dict[str, Any]] = {}
_log_entries: Dict[int, Dict[str, Any]] = {}


def _decode_flags(value: Optional[int], table) -> List[str]:
    if value is None:
        return []
    try:
        raw = int(value)
    except (TypeError, ValueError):
        return []
    return [label for bit, label in table if raw & bit]


def _text(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, (bytes, bytearray)):
        try:
            value = value.decode("utf-8", "replace")
        except Exception:  # noqa: BLE001
            return None
    text = str(value).strip().strip("\x00").strip()
    return text or None


def _number(value: Any) -> Optional[float]:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    return None


def _fresh_gimbal_snapshot() -> Dict[str, Any]:
    now = time.time()
    devices = []
    for device_id in sorted(_gimbals):
        item = dict(_gimbals[device_id])
        received = item.get("receivedAt")
        age_ms = int((now - received) * 1000) if received is not None else None
        item["ageMs"] = age_ms
        item["stale"] = age_ms is None or age_ms > GIMBAL_TELEMETRY_STALE_MS
        item["freshness"] = "STALE" if item["stale"] else "AVAILABLE"
        attitude_received = item.get("attitudeReceivedAt")
        attitude_age = int((now - attitude_received) * 1000) if attitude_received is not None else None
        item["attitudeAgeMs"] = attitude_age
        item["attitudeFreshness"] = (
            "UNAVAILABLE" if attitude_age is None
            else "STALE" if attitude_age > GIMBAL_TELEMETRY_STALE_MS
            else "AVAILABLE"
        )
        devices.append(item)
    return {
        "devices": devices,
        "deviceCount": len(devices),
        "timestamp": int(now * 1000),
        "staleThresholdMs": GIMBAL_TELEMETRY_STALE_MS,
    }


def get_gimbal_snapshot() -> Dict[str, Any]:
    """Gimbal devices the vehicle has actually reported, with freshness."""
    return _fresh_gimbal_snapshot()


def get_log_entry_snapshot() -> Dict[str, Any]:
    """On-board dataflash log entries the vehicle has actually listed."""
    now = time.time()
    entries = []
    for log_id in sorted(_log_entries):
        item = dict(_log_entries[log_id])
        received = item.get("receivedAt")
        age_ms = int((now - received) * 1000) if received is not None else None
        item["ageMs"] = age_ms
        item["stale"] = age_ms is None or age_ms > GIMBAL_TELEMETRY_STALE_MS
        item["freshness"] = "STALE" if item["stale"] else "AVAILABLE"
        entries.append(item)
    entries.sort(key=lambda row: (-(row.get("timeUtc") or 0), row.get("id") or 0))
    return {
        "entries": entries,
        "entryCount": len(entries),
        "numLogs": next((row.get("numLogs") for row in entries if row.get("numLogs") is not None), None),
        "lastLogNum": next((row.get("lastLogNum") for row in entries if row.get("lastLogNum") is not None), None),
        "timestamp": int(now * 1000),
        "staleThresholdMs": GIMBAL_TELEMETRY_STALE_MS,
    }


def reset_gimbal_telemetry() -> None:
    _gimbals.clear()
    _log_entries.clear()
    sio_server.emit("gimbal-telemetry:update", get_gimbal_snapshot())
    sio_server.emit("log-entries:update", get_log_entry_snapshot())


def reset_actuator_telemetry() -> None:
    _servo_outputs.clear()
    _esc_telemetry.clear()
    sio_server.emit("servo-output:update", get_servo_output_snapshot())
    sio_server.emit("esc-telemetry:update", get_esc_telemetry_snapshot())


def get_battery_telemetry(battery_id: int = 0) -> Optional[Dict[str, Any]]:
    bat = _batteries.get(battery_id)
    if not bat:
        return None
    now = time.time()
    entry = dict(bat)
    rec = entry.get("receivedAt") or 0
    age_ms = int((now - rec) * 1000) if rec > 0 else None
    entry["ageMs"] = age_ms
    entry["stale"] = (age_ms is None) or (age_ms > BATTERY_STALE_MS)
    return entry


def get_all_battery_telemetry() -> List[Dict[str, Any]]:
    now = time.time()
    result: List[Dict[str, Any]] = []
    for b_id in sorted(_batteries.keys()):
        bat = dict(_batteries[b_id])
        rec = bat.get("receivedAt") or 0
        age_ms = int((now - rec) * 1000) if rec > 0 else None
        bat["ageMs"] = age_ms
        bat["stale"] = (age_ms is None) or (age_ms > BATTERY_STALE_MS)
        result.append(bat)
    return result


def get_battery_telemetry_snapshot() -> Dict[str, Any]:
    return {
        "batteries": get_all_battery_telemetry(),
        "timestamp": int(time.time() * 1000),
    }


def reset_battery_telemetry() -> None:
    global _batteries
    _batteries = {}
    sio_server.emit("battery:update", {"batteries": [], "timestamp": int(time.time() * 1000)})


# ------------------------------------------------------------------
# Battery estimate (parity)
# ------------------------------------------------------------------
def _estimate_battery_remaining(voltage: float) -> int:
    if voltage <= 0:
        return 0
    cells = min(8, max(1, round(voltage / 3.7)))
    full = 4.2 * cells
    empty = 3.3 * cells
    pct = ((voltage - empty) / (full - empty)) * 100
    return min(100, max(0, round(pct)))


def _refresh_battery_estimate() -> None:
    if telemetry["batteryRemaining"] > 0:
        return
    if telemetry["batteryVoltage"] > 0:
        telemetry["batteryRemaining"] = _estimate_battery_remaining(telemetry["batteryVoltage"])


# ------------------------------------------------------------------
# MAVLink message handlers (parity with telemetryManager.ts)
# ------------------------------------------------------------------
def handle_heartbeat(msg: Any) -> bool:
    """Process an inbound HEARTBEAT.

    Returns True only when the heartbeat came from the actual vehicle. GCS
    consoles (e.g. MAVProxy) announce themselves with MAV_TYPE_GCS /
    MAV_AUTOPILOT_INVALID on the same link — those must never overwrite the
    vehicle identity (they previously flickered vehicleType/autopilot/mode and
    could even resolve the connect promise)."""
    base_mode = getattr(msg, "base_mode", 0)
    armed = bool(base_mode & 128)
    mtype = getattr(msg, "type", 0)
    ap = getattr(msg, "autopilot", 0)

    if ap == 8 or mtype == 6:  # MAV_AUTOPILOT_INVALID / MAV_TYPE_GCS
        return False

    vehicle_type = VEHICLE_NAMES.get(mtype, f"TYPE_{mtype}")
    autopilot = AUTOPILOT_NAMES.get(ap, f"AP_{ap}")

    mode_number = getattr(msg, "custom_mode", 0)
    vt = vehicle_type
    if vt.startswith("GROUND") or vt == "SURFACE_BOAT":
        vehicle_key = "ROVER"
    elif (
        vt.startswith("QUAD") or vt.startswith("HEXA") or vt.startswith("OCTO")
        or vt.startswith("TRI") or vt.startswith("HELI") or vt.startswith("COAX")
        or vt.startswith("VTOL")
    ):
        vehicle_key = "COPTER"
    elif vt == "FIXED_WING" or vt.startswith("FLAPPING"):
        vehicle_key = "PLANE"
    else:
        vehicle_key = ""

    maps: List[Dict[int, str]] = []
    if vehicle_key:
        maps.append(MODE_MAPS[vehicle_key])
    maps += [MODE_MAPS["ROVER"], MODE_MAPS["COPTER"], MODE_MAPS["PLANE"]]

    mode_name = f"MODE_{mode_number}"
    for m in maps:
        if mode_number in m:
            mode_name = m[mode_number]
            break

    telemetry["connected"] = True
    telemetry["systemId"] = vehicle_state["systemId"]
    telemetry["componentId"] = vehicle_state["componentId"]
    telemetry["vehicleType"] = vehicle_type
    telemetry["autopilot"] = autopilot
    telemetry["mode"] = mode_name
    # Raw custom_mode so consumers can resolve the authoritative mode name from
    # the vehicle's own FLTMODE parameter metadata. The `mode` string above is
    # best-effort: when the vehicle type is unrecognised it falls back through
    # other vehicle maps, whose mode numbers do not agree.
    telemetry["modeCode"] = int(mode_number)
    telemetry["armed"] = armed

    vehicle_state["connected"] = True
    vehicle_state["lastHeartbeat"] = int(time.time() * 1000)
    vehicle_state["vehicleType"] = vehicle_type
    vehicle_state["autopilot"] = autopilot
    vehicle_state["mode"] = mode_name
    vehicle_state["armed"] = armed

    _emit(telemetry)
    print(
        "✅ Heartbeat received —", vehicle_type, autopilot, mode_name,
        "ARMED" if armed else "DISARMED"
    )
    return True

def handle_sys_status(msg: Any) -> None:
    v_raw = getattr(msg, "voltage_battery", 65535)
    c_raw = getattr(msg, "current_battery", -1)
    r_raw = getattr(msg, "battery_remaining", -1)

    v_val: Optional[float] = (v_raw / 1000.0) if (v_raw != 65535 and v_raw is not None and v_raw > 0) else None
    c_val: Optional[float] = (c_raw / 100.0) if (c_raw != -1 and c_raw is not None) else None
    r_val: Optional[int] = int(r_raw) if (r_raw is not None and 0 <= r_raw <= 100) else None

    now = time.time()
    existing = _batteries.get(0)
    if existing and existing.get("source") == "BATTERY_STATUS" and (now - (existing.get("receivedAt") or 0)) < 1.5:
        if v_val is not None and existing.get("voltage") is None:
            existing["voltage"] = v_val
        if c_val is not None and existing.get("current") is None:
            existing["current"] = c_val
        if r_val is not None and existing.get("remaining") is None:
            existing["remaining"] = r_val
    else:
        _batteries[0] = {
            "instance": 0,
            "id": 1,
            "voltage": v_val,
            "current": c_val,
            "consumedMah": existing.get("consumedMah") if existing else None,
            "remaining": r_val,
            "temperature": existing.get("temperature") if existing else None,
            "cellVoltages": existing.get("cellVoltages", []) if existing else [],
            "chargeState": existing.get("chargeState", "UNDEFINED") if existing else "UNDEFINED",
            "receivedAt": now,
            "source": "SYS_STATUS",
        }

    update_telemetry(
        {
            "batteryVoltage": v_val if v_val is not None else 0,
            "batteryCurrent": c_val if c_val is not None else 0,
            "batteryRemaining": r_val if r_val is not None else 0,
        }
    )
    _refresh_battery_estimate()
    emit_if_changed()
    sio_server.emit("battery:update", get_battery_telemetry_snapshot())


def handle_home_position(msg: Any) -> None:
    global _home_position_captured
    lat = getattr(msg, "latitude", 0) / 1e7
    lon = getattr(msg, "longitude", 0) / 1e7
    alt = getattr(msg, "altitude", 0) / 1000
    if lat == 0 and lon == 0:
        return
    _home_position_captured = True
    print(f"[HOME] ArduPilot HOME_POSITION: lat={lat:.6f} lon={lon:.6f} alt={alt:.1f}m")
    update_telemetry({"homeLatitude": lat, "homeLongitude": lon, "homeAltitude": alt})


def handle_global_position_int(msg: Any) -> None:
    global _gp_counter, _home_position_captured
    _gp_counter += 1
    lat = getattr(msg, "lat", 0) / 1e7
    lon = getattr(msg, "lon", 0) / 1e7
    alt = getattr(msg, "alt", 0) / 1000
    hdg = getattr(msg, "hdg", 0) / 100
    vx = getattr(msg, "vx", 0) / 100
    vy = getattr(msg, "vy", 0) / 100
    gs = math.sqrt(vx ** 2 + vy ** 2)

    if not _home_position_captured and (lat != 0 or lon != 0):
        _home_position_captured = True
        telemetry["homeLatitude"] = lat
        telemetry["homeLongitude"] = lon
        telemetry["homeAltitude"] = alt
        print(f"[HOME] Captured vehicle home: lat={lat:.6f} lon={lon:.6f} alt={alt:.1f}m")

    distance_to_home = 0
    if telemetry["homeLatitude"] != 0 or telemetry["homeLongitude"] != 0:
        distance_to_home = _haversine_m(
            telemetry["homeLatitude"], telemetry["homeLongitude"], lat, lon
        )
    at_home = distance_to_home <= HOME_REACHED_THRESHOLD_M

    if vehicle_state["missionRunning"]:
        if gs > vehicle_state["missionMaxSpeed"]:
            vehicle_state["missionMaxSpeed"] = gs
        if vehicle_state["missionDistanceInitialized"]:
            d_km = _haversine_km(
                vehicle_state["missionPrevLat"], vehicle_state["missionPrevLon"], lat, lon
            )
            vehicle_state["missionTotalDistance"] += d_km * 1000
        else:
            vehicle_state["missionDistanceInitialized"] = True
        vehicle_state["missionPrevLat"] = lat
        vehicle_state["missionPrevLon"] = lon
        telemetry["missionTotalDistance"] = vehicle_state["missionTotalDistance"]

    if _gp_counter <= 20 or _gp_counter % 10 == 1:
        print(f"[GPS] #{_gp_counter} lat={lat:.6f} lon={lon:.6f} hdg={hdg:.1f}° alt={alt:.1f}m")

    update_telemetry(
        {
            "latitude": lat,
            "longitude": lon,
            "altitude": alt,
            "relativeAltitude": getattr(msg, "relative_alt", 0) / 1000,
            "heading": hdg,
            "groundSpeed": gs,
            "distanceToHome": distance_to_home,
            "atHome": at_home,
        }
    )


def handle_gps_raw_int(msg: Any) -> None:
    global _gps_raw_counter
    _gps_raw_counter += 1
    lat = getattr(msg, "lat", 0) / 1e7
    lon = getattr(msg, "lon", 0) / 1e7
    cog = getattr(msg, "cog", 0) / 100
    alt = getattr(msg, "alt", 0) / 1000

    updates: Dict[str, Any] = {
        "gpsFix": getattr(msg, "fix_type", 0),
        "satellites": getattr(msg, "satellites_visible", 0),
        "hdop": getattr(msg, "eph", 0) / 100,
    }
    if lat != 0 or lon != 0:
        updates["latitude"] = lat
        updates["longitude"] = lon
        updates["altitude"] = alt
        # NOTE: GPS course-over-ground is NOT vehicle heading. It is 0/undefined
        # whenever the vehicle is stationary, so it must never overwrite the
        # real heading published by GLOBAL_POSITION_INT/VFR_HUD/ATTITUDE.
    if _gps_raw_counter <= 20 or _gps_raw_counter % 10 == 1:
        print(
            f"[GPS RAW] #{_gps_raw_counter} lat={lat:.6f} lon={lon:.6f} "
            f"cog={cog:.1f}° fix={updates['gpsFix']} sats={updates['satellites']}"
        )
    update_telemetry(updates)
    vehicle_state["gpsFix"] = updates["gpsFix"]
    vehicle_state["satellites"] = updates["satellites"]


def handle_attitude(msg: Any) -> None:
    yaw = getattr(msg, "yaw", 0)
    # ATTITUDE.yaw is the vehicle's real heading relative to north (radians,
    # -pi..pi). Publish it as `heading` so the HUD heading tape and the DATA
    # heading card stay correct even when no GPS-derived heading is available.
    heading = (yaw * 180.0 / math.pi) % 360.0 if yaw else telemetry["heading"]
    update_telemetry(
        {
            "roll": getattr(msg, "roll", 0),
            "pitch": getattr(msg, "pitch", 0),
            "yaw": yaw,
            "heading": heading,
        }
    )


def handle_vfr_hud(msg: Any) -> None:
    update_telemetry(
        {
            "airSpeed": getattr(msg, "airspeed", 0),
            "groundSpeed": getattr(msg, "groundspeed", 0),
            "heading": getattr(msg, "heading", 0),
            "altitude": getattr(msg, "alt", 0),
            "verticalSpeed": getattr(msg, "climb", 0),
        }
    )


def handle_battery_status(msg: Any) -> None:
    b_id = int(getattr(msg, "id", 0) or 0)
    voltages_raw = getattr(msg, "voltages", None) or []
    valid = [v for v in voltages_raw if v != 0xFFFF and v != 65535 and v > 0]
    pack_mv = sum(valid) if len(valid) > 1 else (valid[0] if valid else None)
    v_val: Optional[float] = (pack_mv / 1000.0) if pack_mv is not None else None

    c_raw = getattr(msg, "current_battery", -1)
    c_val: Optional[float] = (c_raw / 100.0) if (c_raw != -1 and c_raw is not None) else None

    cons_raw = getattr(msg, "current_consumed", -1)
    cons_val: Optional[float] = float(cons_raw) if (cons_raw is not None and cons_raw >= 0) else None

    rem_raw = getattr(msg, "battery_remaining", -1)
    rem_val: Optional[int] = int(rem_raw) if (rem_raw is not None and 0 <= rem_raw <= 100) else None

    temp_raw = getattr(msg, "temperature", 32767)
    temp_val: Optional[float] = (temp_raw / 100.0) if (temp_raw is not None and temp_raw not in (32767, -32768)) else None

    cs_raw = getattr(msg, "charge_state", 0)
    charge_state = MAV_BATTERY_CHARGE_STATE_MAP.get(cs_raw, "UNDEFINED")

    now = time.time()
    _batteries[b_id] = {
        "instance": b_id,
        "id": b_id + 1,
        "voltage": v_val,
        "current": c_val,
        "consumedMah": cons_val,
        "remaining": rem_val,
        "temperature": temp_val,
        "cellVoltages": [cv / 1000.0 for cv in valid],
        "chargeState": charge_state,
        "receivedAt": now,
        "source": "BATTERY_STATUS",
    }

    if b_id == 0:
        update_telemetry(
            {
                "batteryVoltage": v_val if v_val is not None else 0,
                "batteryCurrent": c_val if c_val is not None else 0,
                "batteryRemaining": rem_val if rem_val is not None else 0,
            }
        )
        _refresh_battery_estimate()
        emit_if_changed()

    sio_server.emit("battery:update", get_battery_telemetry_snapshot())


def handle_mission_current(msg: Any) -> None:
    if not vehicle_state["missionRunning"]:
        return
    seq = getattr(msg, "seq", 0)
    update_telemetry({"missionCurrent": mission_item_to_waypoint_seq(seq)})
    if seq == 0 and telemetry["missionReached"] > 0:
        print("[MISSION] ArduPilot reported seq=0 — mission ended")
        _trigger_auto_rtl_and_complete()
    print(
        f"[MISSION] Current Waypoint : {seq} "
        f"(running={vehicle_state['missionRunning']} reached={telemetry['missionReached']})"
    )


def handle_mission_item_reached(msg: Any) -> None:
    mark_waypoint_reached(mission_item_to_waypoint_seq(getattr(msg, "seq", 0)))


def handle_status_text(msg: Any) -> None:
    text = (getattr(msg, "text", "") or "").split("\0")[0].strip()
    if not text:
        return
    update_telemetry({"statusText": text})

    reached_match = REACHED_WAYPOINT_PATTERN.match(text)
    if reached_match:
        mark_waypoint_reached(
            mission_item_to_waypoint_seq(int(reached_match.group(1)))
        )
    if ARM_RELEVANT_PATTERN.search(text):
        vehicle_state["lastArmStatusText"] = text
        print(f"[ARM STATUS] {text}")


def handle_local_position_ned(msg: Any) -> None:
    update_telemetry({"verticalSpeed": -getattr(msg, "vz", 0)})


def handle_rc_channels(msg: Any) -> None:
    """Real RC receiver telemetry (RC_CHANNELS — raw PWM per channel).

    Only genuine values from the vehicle are stored; nothing is synthesised.
    ``chan[i] == 0`` means the channel is inactive/unassigned. ``rssi == 0``
    means ArduPilot reports "no valid remote control signal" (MAV_RSSI_MAX
    semantics inverted here: 0 = no valid RC link). Freshness is tracked via
    ``rcReceivedAt`` (monotonic epoch seconds); consumers downgrade a stale
    reading to NO_SIGNAL rather than ever showing old data as current.
    """
    raw = getattr(msg, "chan", None)
    channels = [int(c) for c in (raw or [])][:18]
    rssi = int(getattr(msg, "rssi", 0) or 0)
    chancount = int(getattr(msg, "chancount", 0) or 0)
    if chancount <= 0:
        chancount = len(channels)
    update_telemetry(
        {
            "rcChannels": channels,
            "rcChannelCount": chancount,
            "rcRssi": rssi,
            "rcReceivedAt": time.time(),
            "rcSignal": "RECEIVING" if rssi > 0 else "NO_SIGNAL",
        }
    )


def handle_servo_output_raw(msg: Any) -> None:
    """Store only output channels genuinely present and available in the frame."""
    now = time.time()
    for channel in range(1, 17):
        raw = getattr(msg, f"servo{channel}_raw", None)
        if isinstance(raw, (int, float)) and raw > 0:
            _servo_outputs[channel] = {"channel": channel, "pwm": int(raw), "receivedAt": now}
        elif isinstance(raw, (int, float)):
            _servo_outputs.pop(channel, None)
    sio_server.emit("servo-output:update", get_servo_output_snapshot())


def handle_esc_telemetry(msg: Any, first_channel: int) -> None:
    """Parse one ArduPilot ESC_TELEMETRY_* group using MAVLink wire units."""
    now = time.time()
    arrays = {name: list(getattr(msg, name, None) or []) for name in
              ("temperature", "voltage", "current", "totalcurrent", "rpm", "count")}
    for offset in range(4):
        raw = {name: values[offset] if offset < len(values) else None for name, values in arrays.items()}
        if all(value in (None, 255, 65535) for value in raw.values()):
            _esc_telemetry.pop(first_channel + offset, None)
            continue
        def valid(name: str, sentinel: int = 65535):
            value = raw[name]
            return None if value is None or value == sentinel else value
        channel = first_channel + offset
        temperature = valid("temperature", 255)
        voltage = valid("voltage")
        current = valid("current")
        _esc_telemetry[channel] = {
            "channel": channel,
            "temperature": float(temperature) if temperature is not None else None,
            "voltage": voltage / 100.0 if voltage is not None else None,
            "current": current / 100.0 if current is not None else None,
            "totalCurrentMah": valid("totalcurrent"),
            "rpm": valid("rpm"),
            "count": valid("count"),
            "status": None,
            "receivedAt": now,
        }
    sio_server.emit("esc-telemetry:update", get_esc_telemetry_snapshot())


def handle_esc_telemetry_1_to_4(msg: Any) -> None:
    handle_esc_telemetry(msg, 1)


def handle_esc_telemetry_5_to_8(msg: Any) -> None:
    handle_esc_telemetry(msg, 5)


def handle_esc_telemetry_9_to_12(msg: Any) -> None:
    handle_esc_telemetry(msg, 9)


# ------------------------------------------------------------------
# Gimbal device telemetry (Phase 8I, strictly read-only)
#
# GIMBAL_DEVICE_INFORMATION (259) and GIMBAL_DEVICE_ATTITUDE_STATUS (285)
# are broadcast by the vehicle. We only decode what arrived; no mount
# control message, no attitude request and no gimbal command is ever sent.
# ------------------------------------------------------------------

def _gimbal_record(msg: Any) -> Dict[str, Any]:
    device_id = getattr(msg, "gimbal_device_id", None)
    key = int(device_id) if isinstance(device_id, (int, float)) else 0
    return _gimbals.setdefault(key, {"deviceId": key})


def handle_gimbal_device_information(msg: Any) -> None:
    """Device identity and capability flags as reported by the gimbal itself."""
    record = _gimbal_record(msg)
    cap_flags = getattr(msg, "cap_flags", None)
    now = time.time()
    record.update({
        "deviceId": record.get("deviceId", 0),
        "vendorName": _text(getattr(msg, "vendor_name", None)),
        "productName": _text(getattr(msg, "product_name", None)),
        "firmwareVersion": _text(getattr(msg, "firmware_version", None)),
        "hardwareUid": _text(getattr(msg, "hardware_uid", None)),
        "customName": _text(getattr(msg, "custom_name", None)),
        "capFlags": int(cap_flags) if isinstance(cap_flags, (int, float)) else None,
        "capabilities": _decode_flags(cap_flags, GIMBAL_CAP_FLAGS),
        "gimbalManager": getattr(msg, "gimbal_manager", None),
        "informationReceivedAt": now,
        "receivedAt": now,
    })
    sio_server.emit("gimbal-telemetry:update", get_gimbal_snapshot())


def handle_gimbal_device_attitude_status(msg: Any) -> None:
    """Reported gimbal attitude, rates and lock state (never commanded)."""
    record = _gimbal_record(msg)
    quaternion = list(getattr(msg, "q", None) or [])
    if len(quaternion) < 4:
        quaternion = []
    flags = getattr(msg, "flags", None)
    failure_flags = getattr(msg, "failure_flags", None)
    record.update({
        "quaternion": [float(value) for value in quaternion] or None,
        "rollDeg": _degrees(getattr(msg, "roll", None)),
        "pitchDeg": _degrees(getattr(msg, "pitch", None)),
        "yawDeg": _degrees(getattr(msg, "yaw", None)),
        "angularVelocityX": _number(getattr(msg, "angular_velocity_x", None)),
        "angularVelocityY": _number(getattr(msg, "angular_velocity_y", None)),
        "angularVelocityZ": _number(getattr(msg, "angular_velocity_z", None)),
        "deltaYawDeg": _degrees(getattr(msg, "delta_yaw", None)),
        "deltaYawVelocityDegS": _degrees(getattr(msg, "delta_yaw_velocity", None)),
        "elevationDeg": _degrees(getattr(msg, "elevation", None)),
        "elevationRateDegS": _degrees(getattr(msg, "elevation_rate", None)),
        "flags": int(flags) if isinstance(flags, (int, float)) else None,
        "statusFlags": _decode_flags(flags, GIMBAL_STATUS_FLAGS),
        "failureFlags": int(failure_flags) if isinstance(failure_flags, (int, float)) else None,
        "failures": _decode_flags(failure_flags, GIMBAL_FAILURE_FLAGS),
        "timeBootMs": getattr(msg, "time_boot_ms", None),
        "attitudeReceivedAt": time.time(),
        "receivedAt": time.time(),
    })
    sio_server.emit("gimbal-telemetry:update", get_gimbal_snapshot())


def _degrees(value: Any) -> Optional[float]:
    """MAVLink gimbals report degrees; keep the payload honest and explicit."""
    number = _number(value)
    return round(number, 2) if number is not None else None


def handle_log_entry(msg: Any) -> None:
    """On-board dataflash log list (LOG_ENTRY, message id 117).

    ArduPilot broadcasts this whenever it enumerates the SD card. It is a
    read-only listing used to show what logging has actually produced.
    """
    log_id = getattr(msg, "id", None)
    if not isinstance(log_id, (int, float)):
        return
    time_utc = getattr(msg, "time_utc", None)
    size = getattr(msg, "size", None)
    num_logs = getattr(msg, "num_logs", None)
    last_log_num = getattr(msg, "last_log_num", None)
    _log_entries[int(log_id)] = {
        "id": int(log_id),
        "timeUtc": int(time_utc) if isinstance(time_utc, (int, float)) else None,
        "sizeBytes": int(size) if isinstance(size, (int, float)) else None,
        "numLogs": int(num_logs) if isinstance(num_logs, (int, float)) else None,
        "lastLogNum": int(last_log_num) if isinstance(last_log_num, (int, float)) else None,
        "receivedAt": time.time(),
    }
    sio_server.emit("log-entries:update", get_log_entry_snapshot())


def handle_raw_imu(_msg: Any) -> None:
    pass


def handle_fence_status(msg: Any) -> None:
    breach_status = getattr(msg, "breach_status", 0)
    breach_count = getattr(msg, "breach_count", 0)
    breach_type = getattr(msg, "breach_type", 0)
    update_telemetry({
        "fenceBreachStatus": breach_status,
        "fenceBreachCount": breach_count,
        "fenceBreachType": breach_type,
    })
    if breach_status > 0:
        print(f"[FENCE] Breach detected: status={breach_status} count={breach_count} type={breach_type}")


# ------------------------------------------------------------------
# Stream-request reset hook (defined here to avoid circular imports)
# ------------------------------------------------------------------
def reset_stream_requested() -> None:
    from mavlink.stream_requester import reset_requested

    reset_requested()
