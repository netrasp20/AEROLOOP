"""Mission protocol builders/parsers, ported from
backend/src/mavlink/commands/MissionCommand.ts.

Waypoint -> MAVLink mission item layout (seq=0 HOME reserved by ArduPilot,
seq=1 NAV_TAKEOFF for air vehicles, then real waypoints) plus the
MISSION_COUNT / MISSION_ITEM_INT send helpers and inbound parsers used by the
upload, download and verify flows.
"""

from typing import Any, Dict, List, Optional

from mavlink.connection_manager import manager

# ArduPilot dialect messages that include mission_type extension field
from pymavlink.dialects.v20.ardupilotmega import (
    MAVLink_mission_item_int_message,
    MAVLink_mission_count_message,
)

MAV_MISSION_TYPE_MISSION = 0
MAV_MISSION_TYPE_FENCE = 1
MAV_FRAME_GLOBAL_RELATIVE_ALT = 3
MAV_CMD_NAV_WAYPOINT = 16
MAV_CMD_NAV_TAKEOFF = 22
# MAV_CMD_DO_SET_HOME is intentionally not used in the mission list.
# See waypoints_to_mavlink_items for rationale.

# Fence commands
MAV_CMD_NAV_FENCE_RETURN_POINT = 5000
MAV_CMD_NAV_FENCE_POLYGON_VERTEX_INCLUSION = 5001
MAV_CMD_NAV_FENCE_POLYGON_VERTEX_EXCLUSION = 5002
MAV_CMD_NAV_FENCE_CIRCLE_INCLUSION = 5003
MAV_CMD_NAV_FENCE_CIRCLE_EXCLUSION = 5004

# Numeric msgids used by the parser/waiter helpers.
MSGID_MISSION_COUNT = 44
MSGID_MISSION_REQUEST_INT = 51
MSGID_MISSION_REQUEST = 40
MSGID_MISSION_ACK = 47
MSGID_MISSION_ITEM_INT = 73
MSGID_MISSION_ITEM = 39
MSGID_STATUSTEXT = 253

MAV_MISSION_ACK_MESSAGES: Dict[int, str] = {
    0: "MAV_MISSION_ACCEPTED",
    1: "MAV_MISSION_ERROR",
    2: "MAV_MISSION_UNKNOWN_FRAME",
    3: "MAV_MISSION_UNKNOWN_COMMAND",
    4: "MAV_MISSION_INVALID_SEQUENCE",
    5: "MAV_MISSION_INVALID_PARAM1",
    6: "MAV_MISSION_INVALID_PARAM2",
    7: "MAV_MISSION_INVALID_PARAM3",
    8: "MAV_MISSION_INVALID_PARAM4",
    9: "MAV_MISSION_INVALID_PARAM5_X",
    10: "MAV_MISSION_INVALID_PARAM6_Y",
    11: "MAV_MISSION_INVALID_PARAM7_Z",
    12: "MAV_MISSION_INVALID_SEQUENCE",
    13: "MAV_MISSION_DENIED",
    14: "MAV_MISSION_OPERATION_IN_PROGRESS",
    15: "MAV_MISSION_INVALID_MAV_TYPE",
    16: "MAV_MISSION_INVALID_MISSION_TYPE",
    17: "MAV_MISSION_UNSUPPORTED",
    18: "MAV_MISSION_MAX_COUNT_EXCEEDED",
    19: "MAV_MISSION_INVALID_PROTOCOL_VERSION",
    20: "MAV_MISSION_INVALID_MAV_CAPABILITY",
    21: "MAV_MISSION_COUNT_CHANGED",
}


def get_ack_result_message(code: int) -> str:
    return MAV_MISSION_ACK_MESSAGES.get(code, f"UNKNOWN({code})")


def get_ack_error_message(code: int) -> str:
    return f"MISSION_ACK {get_ack_result_message(code)}"


def waypoints_to_mavlink_items(
    waypoints: List[Dict[str, Any]],
    home_lat: float,
    home_lng: float,
    home_alt: float,
    vehicle_type: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Convert frontend waypoints to MAVLink mission items.

    seq=0 is the HOME item ArduPilot reserves for every vehicle. seq=1 is the
    first real command (NAV_TAKEOFF for air vehicles), then the waypoints.
    """
    is_ground = bool(
        vehicle_type
        and (vehicle_type.startswith("GROUND") or vehicle_type == "SURFACE_BOAT")
    )

    items: List[Dict[str, Any]] = []

    items.append(
        {
            "seq": 0,
            "frame": MAV_FRAME_GLOBAL_RELATIVE_ALT,
            "command": MAV_CMD_NAV_WAYPOINT,
            "current": 0,
            "autocontinue": 1,
            "param1": 0, "param2": 0, "param3": 0, "param4": 0,
            "x": home_lat,
            "y": home_lng,
            "z": 0,
        }
    )

    if not is_ground:
        takeoff_alt = waypoints[0]["altitude"] if waypoints else 10
        items.append(
            {
                "seq": 1,
                "frame": MAV_FRAME_GLOBAL_RELATIVE_ALT,
                "command": MAV_CMD_NAV_TAKEOFF,
                "current": 1,
                "autocontinue": 1,
                "param1": 0, "param2": 0, "param3": 0, "param4": 0,
                "x": home_lat,
                "y": home_lng,
                "z": takeoff_alt,
            }
        )

    for i, wp in enumerate(waypoints):
        seq = i + 1 if is_ground else i + 2
        items.append(
            {
                "seq": seq,
                "frame": MAV_FRAME_GLOBAL_RELATIVE_ALT,
                "command": MAV_CMD_NAV_WAYPOINT,
                "current": 1 if is_ground and i == 0 else 0,
                "autocontinue": 1,
                "param1": wp.get("hoverTime") or 0,
                "param2": 0, "param3": 0, "param4": 0,
                "x": wp["lat"],
                "y": wp["lng"],
                "z": wp.get("altitude") or 10,
            }
        )

    return items


def send_mission_count(count: int, sys_id: int, comp_id: int, mission_type: int = 0) -> None:
    conn = manager.connection
    if conn is None:
        raise RuntimeError("No transport available.")
    msg = MAVLink_mission_count_message(sys_id, comp_id, count, mission_type)
    manager.enqueue(lambda: conn.mav.send(msg))


def create_mission_item_int(item: Dict[str, Any], sys_id: int, comp_id: int) -> Dict[str, Any]:
    """Return the MISSION_ITEM_INT payload fields (sent via mission_item_int_send)."""
    return {
        "target_system": sys_id,
        "target_component": comp_id,
        "seq": item["seq"],
        "frame": item["frame"],
        "command": item["command"],
        "current": item["current"],
        "autocontinue": item["autocontinue"],
        "param1": item["param1"],
        "param2": item["param2"],
        "param3": item["param3"],
        "param4": item["param4"],
        "x": round(item["x"] * 1e7),
        "y": round(item["y"] * 1e7),
        "z": item["z"],
        "mission_type": item.get("mission_type", 0),
    }


def send_mission_item_int(item: Dict[str, Any], sys_id: int, comp_id: int) -> None:
    conn = manager.connection
    if conn is None:
        raise RuntimeError("No transport available.")
    f = create_mission_item_int(item, sys_id, comp_id)
    msg = MAVLink_mission_item_int_message(
        f["target_system"],
        f["target_component"],
        f["seq"],
        f["frame"],
        f["command"],
        f["current"],
        f["autocontinue"],
        f["param1"],
        f["param2"],
        f["param3"],
        f["param4"],
        f["x"],
        f["y"],
        f["z"],
        f.get("mission_type", 0),
    )
    manager.enqueue(lambda: conn.mav.send(msg))


def create_mission_request_list(sys_id: int, comp_id: int, mission_type: int = 0) -> None:
    conn = manager.connection
    if conn is None:
        raise RuntimeError("No transport available.")
    manager.enqueue(lambda: conn.mav.mission_request_list_send(sys_id, comp_id, mission_type))


def create_mission_request_int(sys_id: int, comp_id: int, seq: int, mission_type: int = 0) -> None:
    conn = manager.connection
    if conn is None:
        raise RuntimeError("No transport available.")
    manager.enqueue(lambda: conn.mav.mission_request_int_send(sys_id, comp_id, seq, mission_type))


def parse_mission_request(msg: Any) -> Optional[Dict[str, Any]]:
    if msg.get_msgId() == MSGID_MISSION_REQUEST_INT:
        return {"seq": getattr(msg, "seq", 0)}
    return None


def parse_mission_ack_result(msg: Any) -> Optional[int]:
    if msg.get_msgId() == MSGID_MISSION_ACK:
        return getattr(msg, "type", None)
    return None


def parse_mission_count(msg: Any) -> Optional[Dict[str, Any]]:
    if msg.get_msgId() == MSGID_MISSION_COUNT:
        return {"count": getattr(msg, "count", 0)}
    return None


def parse_mission_item(msg: Any) -> Optional[Dict[str, Any]]:
    """Parse MISSION_ITEM_INT (73) or MISSION_ITEM (39) into a MavlinkMissionItem."""
    msgid = msg.get_msgId()
    is_int = msgid == MSGID_MISSION_ITEM_INT
    if msgid == MSGID_MISSION_ITEM_INT:
        print(
            f"[MISSION_ITEM_INT] RAW seq={msg.seq} frame={msg.frame} command={msg.command} "
            f"x={msg.x} y={msg.y} z={msg.z}"
        )
    elif msgid == MSGID_MISSION_ITEM:
        print(
            f"[MISSION_ITEM] RAW seq={msg.seq} frame={msg.frame} command={msg.command} "
            f"x={msg.x} y={msg.y} z={msg.z}"
        )
    else:
        return None

    if is_int:
        lat = msg.x / 1e7
        lon = msg.y / 1e7
        print(f"[MISSION_ITEM_INT] Converted: lat={lat} lon={lon} alt={msg.z} (x/1e7, y/1e7)")
    else:
        lat = msg.x
        lon = msg.y
        print(f"[MISSION_ITEM] Converted: lat={lat} lon={lon} alt={msg.z} (float, no conversion)")

    return {
        "seq": msg.seq,
        "frame": msg.frame,
        "command": msg.command,
        "current": msg.current,
        "autocontinue": msg.autocontinue,
        "param1": msg.param1,
        "param2": msg.param2,
        "param3": msg.param3,
        "param4": msg.param4,
        "x": lat,
        "y": lon,
        "z": msg.z,
    }
