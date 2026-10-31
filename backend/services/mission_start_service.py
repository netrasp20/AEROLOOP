"""Mission start, ported from backend/src/services/missionStart.service.ts.

Validates preconditions and sends MAV_CMD_MISSION_START with COMMAND_ACK wait.
"""

import threading
from typing import Any, Dict

from core.state import vehicle_state
from mavlink import packet_bus
from mavlink.command_service import get_ack_label
from mavlink.connection_manager import manager

ACK_TIMEOUT_MS = 5000
MAV_CMD_MISSION_START = 300
COMMAND_ACK_MSGID = 77


def validate_start() -> Dict[str, Any]:
    if not vehicle_state["connected"]:
        return {
            "success": False,
            "message": "Cannot start mission. Vehicle is not connected.",
        }

    if not vehicle_state["missionUploaded"]:
        return {
            "success": False,
            "message": "Cannot start mission. Please upload a mission first.",
        }

    if not vehicle_state["armed"]:
        return {
            "success": False,
            "message": "Cannot start mission. Vehicle must be armed first.",
        }

    if vehicle_state["mode"] != "AUTO":
        return {
            "success": False,
            "message": "Cannot start mission. Vehicle must be in AUTO mode.",
        }

    return {"success": True, "message": "Validation passed."}


def wait_for_mission_start_ack(command_id: int) -> Dict[str, Any]:
    done = threading.Event()
    ack: Dict[str, Any] = {}

    def on_ack(msg: Any) -> None:
        if done.is_set():
            return
        if getattr(msg, "command", None) != command_id:
            return
        code = getattr(msg, "result", -1)
        if code == 0:
            done.set()
            ack["success"] = True
            ack["message"] = "Mission started successfully."
            ack["ackCode"] = 0
            ack["ackLabel"] = "ACCEPTED"
        else:
            done.set()
            ack["success"] = False
            ack["message"] = f"Mission Start Failed. Reason: {get_ack_label(code)}"
            ack["ackCode"] = code
            ack["ackLabel"] = get_ack_label(code)

    unsub = packet_bus.on_packet(COMMAND_ACK_MSGID, on_ack)
    try:
        got = done.wait(ACK_TIMEOUT_MS / 1000.0)
    finally:
        unsub()
    if not got:
        return {
            "success": False,
            "message": "Command acknowledgment timeout.",
            "ackCode": -1,
            "ackLabel": "TIMEOUT",
        }
    return ack


def start_mission(
    first_item: int = 0,
    last_item: int = 0,
) -> Dict[str, Any]:
    validation = validate_start()
    if not validation["success"]:
        return validation

    print("[MISSION START] Requested")
    print("[MISSION START] Sending MAV_CMD_MISSION_START")

    conn = manager.connection
    if conn is None:
        return {
            "success": False,
            "message": "Failed to send command: No transport available.",
            "ackCode": -1,
            "ackLabel": "SEND_FAILED",
        }

    try:
        sysid = vehicle_state["systemId"] or 1
        compid = vehicle_state["componentId"] or 1
        manager.enqueue(lambda: conn.mav.command_long_send(
            sysid, compid,
            MAV_CMD_MISSION_START,
            0,
            first_item,
            last_item,
            0,
            0,
            0,
            0,
            0,
        ))
    except Exception as err:
        return {
            "success": False,
            "message": f"Failed to send command: {err}",
            "ackCode": -1,
            "ackLabel": "SEND_FAILED",
        }

    ack = wait_for_mission_start_ack(MAV_CMD_MISSION_START)

    if ack["success"]:
        print("[MISSION START] Mission ACK Received — ACCEPTED")
        print("[MISSION START] Mission Started")
    else:
        print(f"[MISSION START] Mission ACK Received — {ack['ackLabel']}")

    return ack
