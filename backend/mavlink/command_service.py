"""MAVLink command service, ported from backend/src/mavlink/command.service.ts.

Arm/disarm, mode change, set-home and set-mission-current using COMMAND_ACK +
HEARTBEAT confirmation, matching the Node implementation's timing, messages and
mode tables exactly.
"""

import threading
import time
from typing import Any, Callable, Dict, Optional

from core.state import telemetry, vehicle_state
from mavlink import packet_bus
from mavlink.connection_manager import manager

# ------------------------------------------------------------------
# Constants (parity with command.service.ts)
# ------------------------------------------------------------------
ACK_TIMEOUT_MS = 8000
HEARTBEAT_CONFIRM_TIMEOUT_MS = 3000
STATUSTEXT_DELAY_MS = 300

MAV_ACK_MESSAGES: Dict[int, str] = {
    0: "ACCEPTED",
    1: "TEMPORARY_REJECTED",
    2: "DENIED",
    3: "UNSUPPORTED",
    4: "FAILED",
    5: "IN_PROGRESS",
    6: "CANCELLED",
    7: "COMMAND_INT_ONLY",
    8: "COMMAND_UNSUPPORTED_MAV_FRAME",
    9: "TIMEOUT",
}

MAV_CMD_COMPONENT_ARM_DISARM = 400
MAV_CMD_DO_SET_HOME = 179
MAV_CMD_DO_SET_MISSION_CURRENT = 224

COMMAND_ACK_MSGID = 77
HEARTBEAT_POLL_S = 0.1


def get_ack_label(code: int) -> str:
    return MAV_ACK_MESSAGES.get(code, f"UNKNOWN({code})")


def _transport() -> Any:
    conn = manager.connection
    if conn is None:
        raise RuntimeError("No transport available — vehicle not connected.")
    return conn


def _command_long(
    command: int,
    param1: float = 0,
    param2: float = 0,
    param3: float = 0,
    param4: float = 0,
    param5: float = 0,
    param6: float = 0,
    param7: float = 0,
) -> None:
    conn = _transport()
    sysid = vehicle_state["systemId"] or 1
    compid = vehicle_state["componentId"] or 1
    manager.enqueue(lambda: conn.mav.command_long_send(
        sysid, compid, command, 0,
        param1, param2, param3, param4, param5, param6, param7,
    ))


def send_command_long(
    command: int,
    param1: float = 0,
    param2: float = 0,
    param3: float = 0,
    param4: float = 0,
    param5: float = 0,
    param6: float = 0,
    param7: float = 0,
) -> None:
    """Fire-and-forget COMMAND_LONG (no ACK wait) — used for non-fatal
    DO_SET_MISSION_CURRENT resets, mirroring mission.socket.ts `send()`."""
    _command_long(
        command,
        param1=param1,
        param2=param2,
        param3=param3,
        param4=param4,
        param5=param5,
        param6=param6,
        param7=param7,
    )


def wait_for_command_ack(command_id: int, send_fn: Optional[Callable[[], None]] = None) -> Dict[str, Any]:
    """Wait for COMMAND_ACK matching `command_id`, resolving on the first one.

    Mirrors waitForCommandAck: register the packet listener BEFORE sending
    the command (matching Node's onPacket-then-send ordering), then wait for
    the response.  If *send_fn* is provided it is called after the listener
    is registered; otherwise the caller is responsible for having already
    sent the command.
    """
    done = threading.Event()
    ack: Dict[str, Any] = {}

    def on_ack(msg: Any) -> None:
        if done.is_set():
            return
        if getattr(msg, "command", None) != command_id:
            return
        code = getattr(msg, "result", -1)
        label = get_ack_label(code)
        print(f"[CMD] COMMAND_ACK received — command={command_id} result={code} ({label})")
        ack["code"] = code
        ack["label"] = label
        if code == 0:
            print("[CMD] Command ACCEPTED")
            ack["success"] = True
            ack["message"] = "Command accepted."
        else:
            print(f"[CMD] Command REJECTED: {label}")
            ack["success"] = False
            ack["message"] = f"Command rejected: {label}"
        done.set()

    unsub = packet_bus.on_packet(COMMAND_ACK_MSGID, on_ack)
    try:
        if send_fn is not None:
            send_fn()
        got = done.wait(ACK_TIMEOUT_MS / 1000.0)
    finally:
        unsub()

    if not got:
        print(f"[CMD] ACK TIMEOUT after {ACK_TIMEOUT_MS}ms for command {command_id}")
        return {
            "success": False,
            "message": "Command acknowledgment timeout.",
            "ackCode": -1,
            "ackLabel": "TIMEOUT",
        }
    return {
        "success": ack["success"],
        "message": ack["message"],
        "ackCode": ack["code"],
        "ackLabel": ack["label"],
    }


def wait_for_heartbeat_arm_state(
    target_armed: bool, timeout_ms: int
) -> Dict[str, Any]:
    """Poll vehicleState.armed until it reflects the requested state."""
    started = time.time()
    while (time.time() - started) * 1000 < timeout_ms:
        if vehicle_state["armed"] == target_armed:
            return {
                "success": True,
                "message": (
                    "Vehicle is armed (confirmed by HEARTBEAT)"
                    if target_armed
                    else "Vehicle is disarmed (confirmed by HEARTBEAT)"
                ),
            }
        time.sleep(HEARTBEAT_POLL_S)
    return {
        "success": False,
        "message": f"Timeout waiting for armed={target_armed} in HEARTBEAT",
    }


def wait_for_heartbeat_mode(target_mode: str, timeout_ms: int) -> Dict[str, Any]:
    started = time.time()
    while (time.time() - started) * 1000 < timeout_ms:
        if vehicle_state["mode"] == target_mode:
            vehicle_state["mode"] = target_mode
            telemetry["mode"] = target_mode
            print(f"[MODE] Mode changed to {target_mode} (confirmed by HEARTBEAT)")
            return {
                "success": True,
                "message": f"Mode changed to {target_mode}",
                "ackCode": 0,
                "ackLabel": "ACCEPTED",
            }
        time.sleep(HEARTBEAT_POLL_S)
    return {
        "success": False,
        "message": f"Timeout waiting for mode={target_mode} in HEARTBEAT",
        "ackCode": -1,
        "ackLabel": "TIMEOUT",
    }


def arm_vehicle() -> Dict[str, Any]:
    print("============================ ARM REQUEST ============================")
    print(f"Vehicle Connected : {vehicle_state['connected']}")
    print(f"Serial Open       : {vehicle_state['serialPortOpen']}")
    hb_age = (
        f"{int(time.time() * 1000) - vehicle_state['lastHeartbeat']}ms"
        if vehicle_state["lastHeartbeat"] > 0
        else "NEVER"
    )
    print(f"Heartbeat Age     : {hb_age}")
    print(f"System ID         : {vehicle_state['systemId']}")
    print(f"Component ID      : {vehicle_state['componentId']}")
    print(f"Mode              : {vehicle_state['mode']}")
    print(f"Armed             : {vehicle_state['armed']}")
    print(f"Vehicle Type      : {vehicle_state['vehicleType']}")
    print(f"Autopilot         : {vehicle_state['autopilot']}")
    print("====================================================================")

    _transport()  # raise if no transport
    vehicle_state["lastArmStatusText"] = ""

    print("[ARM] Sending MAV_CMD_COMPONENT_ARM_DISARM...")
    print(f"[ARM]   targetSystem    = {vehicle_state['systemId'] or 1}")
    print(f"[ARM]   targetComponent = {vehicle_state['componentId'] or 1}")
    print(f"[ARM]   command         = {MAV_CMD_COMPONENT_ARM_DISARM} (MAV_CMD_COMPONENT_ARM_DISARM)")
    print("[ARM]   param1          = 1 (arm)")
    print("[ARM]   param2          = 0 (force)")

    ack_result = wait_for_command_ack(
        MAV_CMD_COMPONENT_ARM_DISARM,
        send_fn=lambda: _command_long(MAV_CMD_COMPONENT_ARM_DISARM, param1=1),
    )
    print("[ARM] COMMAND_ACK received")
    print(f"[ARM]   Result  = {ack_result['ackLabel']}")
    print(f"[ARM]   Code    = {ack_result['ackCode']}")
    print(f"[ARM]   Message = {ack_result['message']}")

    if not ack_result["success"]:
        time.sleep(STATUSTEXT_DELAY_MS / 1000.0)
        reason = vehicle_state["lastArmStatusText"]
        if reason:
            print(f"[ARM] STATUSTEXT: {reason}")
            ack_result["statusText"] = reason
            ack_result["message"] = reason
        else:
            ack_result["message"] = f"Command rejected: {ack_result['ackLabel']}"
        print(f"[ARM] Returning failure: {ack_result['message']}")
        print("====================================================================")
        return ack_result

    print("[ARM] Waiting for HEARTBEAT armed=true...")
    heartbeat_confirm = wait_for_heartbeat_arm_state(True, HEARTBEAT_CONFIRM_TIMEOUT_MS)
    print(f"[ARM] HEARTBEAT confirm: {heartbeat_confirm['message']}")

    if not heartbeat_confirm["success"]:
        print(f"[ARM] HEARTBEAT confirm failed: {heartbeat_confirm['message']}")
        print("====================================================================")
        return {
            "success": False,
            "message": heartbeat_confirm["message"],
            "ackCode": ack_result["ackCode"],
            "ackLabel": ack_result["ackLabel"],
        }

    print("[ARM] Vehicle armed successfully")
    print("====================================================================")
    return {"success": True, "message": "Vehicle armed successfully"}


def disarm_vehicle() -> Dict[str, Any]:
    print("============================ DISARM REQUEST ============================")
    print(f"Vehicle Connected : {vehicle_state['connected']}")
    print(f"Serial Open       : {vehicle_state['serialPortOpen']}")
    hb_age = (
        f"{int(time.time() * 1000) - vehicle_state['lastHeartbeat']}ms"
        if vehicle_state["lastHeartbeat"] > 0
        else "NEVER"
    )
    print(f"Heartbeat Age     : {hb_age}")
    print(f"System ID         : {vehicle_state['systemId']}")
    print(f"Component ID      : {vehicle_state['componentId']}")
    print(f"Mode              : {vehicle_state['mode']}")
    print(f"Armed             : {vehicle_state['armed']}")
    print("=======================================================================")

    _transport()  # raise if no transport

    print("[DISARM] Sending MAV_CMD_COMPONENT_ARM_DISARM...")
    print(f"[DISARM]   targetSystem    = {vehicle_state['systemId'] or 1}")
    print(f"[DISARM]   targetComponent = {vehicle_state['componentId'] or 1}")
    print("[DISARM]   param1          = 0 (disarm)")

    ack_result = wait_for_command_ack(
        MAV_CMD_COMPONENT_ARM_DISARM,
        send_fn=lambda: _command_long(MAV_CMD_COMPONENT_ARM_DISARM, param1=0),
    )
    print("[DISARM] COMMAND_ACK received")
    print(f"[DISARM]   Result  = {ack_result['ackLabel']}")
    print(f"[DISARM]   Code    = {ack_result['ackCode']}")

    if not ack_result["success"]:
        print(f"[DISARM] Disarm failed: {ack_result['ackLabel']}")
        print("=======================================================================")
        return ack_result

    print("[DISARM] Waiting for HEARTBEAT armed=false...")
    heartbeat_confirm = wait_for_heartbeat_arm_state(False, HEARTBEAT_CONFIRM_TIMEOUT_MS)
    print(f"[DISARM] HEARTBEAT confirm: {heartbeat_confirm['message']}")

    if not heartbeat_confirm["success"]:
        print(f"[DISARM] HEARTBEAT confirm failed: {heartbeat_confirm['message']}")
        print("=======================================================================")
        return {
            "success": False,
            "message": heartbeat_confirm["message"],
            "ackCode": ack_result["ackCode"],
            "ackLabel": ack_result["ackLabel"],
        }

    print("[DISARM] Vehicle disarmed successfully")
    print("=======================================================================")
    return {"success": True, "message": "Vehicle disarmed successfully"}


# ------------------------------------------------------------------
# Mode maps (parity with command.service.ts)
# ------------------------------------------------------------------
COPTER_MODES: Dict[str, Dict[str, Any]] = {
    "STABILIZE": {"number": 0, "heartbeatName": "STABILIZE"},
    "ACRO": {"number": 1, "heartbeatName": "ACRO"},
    "ALT_HOLD": {"number": 2, "heartbeatName": "ALT_HOLD"},
    "AUTO": {"number": 3, "heartbeatName": "AUTO"},
    "GUIDED": {"number": 4, "heartbeatName": "GUIDED"},
    "LOITER": {"number": 5, "heartbeatName": "LOITER"},
    "RTL": {"number": 6, "heartbeatName": "RTL"},
    "CIRCLE": {"number": 7, "heartbeatName": "CIRCLE"},
    "LAND": {"number": 9, "heartbeatName": "LAND"},
    "DRIFT": {"number": 11, "heartbeatName": "DRIFT"},
    "SPORT": {"number": 13, "heartbeatName": "SPORT"},
    "POSHOLD": {"number": 16, "heartbeatName": "POSHOLD"},
    "BRAKE": {"number": 17, "heartbeatName": "BRAKE"},
    "GUIDED_NOGPS": {"number": 20, "heartbeatName": "GUIDED_NOGPS"},
    "SMART_RTL": {"number": 21, "heartbeatName": "SMART_RTL"},
    "FLOWHOLD": {"number": 22, "heartbeatName": "FLOWHOLD"},
    "FOLLOW": {"number": 23, "heartbeatName": "FOLLOW"},
    "MANUAL": {"number": 0, "heartbeatName": "STABILIZE"},
    "HOLD": {"number": 2, "heartbeatName": "ALT_HOLD"},
}

ROVER_MODES: Dict[str, Dict[str, Any]] = {
    "MANUAL": {"number": 0, "heartbeatName": "MANUAL"},
    "ACRO": {"number": 1, "heartbeatName": "ACRO"},
    "STEERING": {"number": 3, "heartbeatName": "STEERING"},
    "HOLD": {"number": 4, "heartbeatName": "HOLD"},
    "LOITER": {"number": 5, "heartbeatName": "LOITER"},
    "FOLLOW": {"number": 6, "heartbeatName": "FOLLOW"},
    "SIMPLE": {"number": 7, "heartbeatName": "SIMPLE"},
    "DOCK": {"number": 8, "heartbeatName": "DOCK"},
    "CIRCLE": {"number": 9, "heartbeatName": "CIRCLE"},
    "AUTO": {"number": 10, "heartbeatName": "AUTO"},
    "RTL": {"number": 11, "heartbeatName": "RTL"},
    "SMART_RTL": {"number": 12, "heartbeatName": "SMART_RTL"},
    "GUIDED": {"number": 15, "heartbeatName": "GUIDED"},
    "INITIALISING": {"number": 16, "heartbeatName": "INITIALISING"},
}


def is_air_vehicle() -> bool:
    vt = vehicle_state["vehicleType"]
    return (
        vt.startswith("QUAD")
        or vt.startswith("HEXA")
        or vt.startswith("OCTO")
        or vt.startswith("TRI")
        or vt.startswith("HELI")
        or vt.startswith("COAX")
        or vt.startswith("VTOL")
        or vt == "FIXED_WING"
        or vt.startswith("FLAPPING")
    )


def get_safe_arm_mode() -> str:
    return "STABILIZE" if is_air_vehicle() else "HOLD"


NON_ARMABLE_MODES = {
    "RTL",
    "LAND",
    "SMART_RTL",
    "THROW",
    "BRAKE",
    "AUTOROTATE",
    "AUTO_RTL",
    "GUIDED_NOGPS",
    "INITIALISING",
}


def is_mode_armable(mode: str) -> bool:
    return mode not in NON_ARMABLE_MODES


def set_mode(mode: str) -> Dict[str, Any]:
    table = COPTER_MODES if is_air_vehicle() else ROVER_MODES
    def_ = table.get(mode)
    if def_ is None:
        print(f"[MODE] Unknown mode for vehicle {vehicle_state['vehicleType']}: {mode}")
        return {
            "success": False,
            "message": f"Mode {mode} is not supported on {vehicle_state['vehicleType']}.",
            "ackCode": -1,
            "ackLabel": "INVALID_MODE",
        }
    custom_mode = def_["number"]

    print("============================ MODE CHANGE ============================")
    print(f"Mode Requested    : {mode} (customMode={custom_mode}, heartbeat={def_['heartbeatName']})")
    print(f"Vehicle Connected : {vehicle_state['connected']}")
    print(f"System ID         : {vehicle_state['systemId']}")
    print(f"Component ID      : {vehicle_state['componentId']}")
    print(f"Current Mode      : {vehicle_state['mode']}")
    print(f"Armed             : {vehicle_state['armed']}")
    print(f"Vehicle Type      : {vehicle_state['vehicleType']}")
    print("====================================================================")

    _transport()  # raise if no transport
    conn = manager.connection
    sysid = vehicle_state["systemId"] or 1
    print(f"[MODE] Sending SET_MODE: baseMode=1 customMode={custom_mode} ({mode})")
    manager.enqueue(lambda: conn.mav.set_mode_send(sysid, 1, custom_mode))

    return wait_for_heartbeat_mode(def_["heartbeatName"], HEARTBEAT_CONFIRM_TIMEOUT_MS)


def set_home(lat: Optional[float] = None, lon: Optional[float] = None, alt: Optional[float] = None) -> Dict[str, Any]:
    _transport()  # raise if no transport
    use_current = lat is None or lon is None

    print(f"[HOME] Sending MAV_CMD_DO_SET_HOME (179) — useCurrentPosition={use_current}")
    if not use_current:
        print(f"[HOME]   lat={lat} lon={lon} alt={alt}")

    param5 = 0 if use_current else round(lat * 1e7)
    param6 = 0 if use_current else round(lon * 1e7)
    param7 = 0 if use_current else (alt or 0)

    ack_result = wait_for_command_ack(
        MAV_CMD_DO_SET_HOME,
        send_fn=lambda: _command_long(
            MAV_CMD_DO_SET_HOME,
            param1=1 if use_current else 0,
            param5=param5,
            param6=param6,
            param7=param7,
        ),
    )
    print(f"[HOME] COMMAND_ACK result={ack_result['ackLabel']}")
    return ack_result


def set_mission_current(seq: int) -> Dict[str, Any]:
    _transport()  # raise if no transport
    print(f"[MISSION] Sending MAV_CMD_DO_SET_MISSION_CURRENT seq={seq}")

    ack_result = wait_for_command_ack(
        MAV_CMD_DO_SET_MISSION_CURRENT,
        send_fn=lambda: _command_long(MAV_CMD_DO_SET_MISSION_CURRENT, param1=seq),
    )
    print(f"[MISSION] SET_MISSION_CURRENT ACK result={ack_result['ackLabel']}")
    return ack_result
