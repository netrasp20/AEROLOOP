"""Fence upload/download/clear service for ArduCopter.

Uses the MAVLink mission protocol with mission_type=1 (FENCE) to upload
and download polygon/circular fence geometry.

Fence points are uploaded as MISSION_ITEM_INT messages with:
- MAV_CMD_NAV_FENCE_POLYGON_VERTEX_INCLUSION (5001) for polygon inclusion
- MAV_CMD_NAV_FENCE_POLYGON_VERTEX_EXCLUSION (5002) for polygon exclusion
- MAV_CMD_NAV_FENCE_CIRCLE_INCLUSION (5003) for circular inclusion
- MAV_CMD_NAV_FENCE_CIRCLE_EXCLUSION (5004) for circular exclusion
- MAV_CMD_NAV_FENCE_RETURN_POINT (5000) for the return point
"""

import threading
from typing import Any, Callable, Dict, List, Optional

from core.state import is_tcp_connected, vehicle_state
from mavlink import packet_bus
from mavlink.connection_manager import manager
from mavlink.mission_command import (
    MAV_CMD_NAV_FENCE_CIRCLE_EXCLUSION,
    MAV_CMD_NAV_FENCE_CIRCLE_INCLUSION,
    MAV_CMD_NAV_FENCE_POLYGON_VERTEX_EXCLUSION,
    MAV_CMD_NAV_FENCE_POLYGON_VERTEX_INCLUSION,
    MAV_CMD_NAV_FENCE_RETURN_POINT,
    MAV_FRAME_GLOBAL_RELATIVE_ALT,
    MAV_MISSION_TYPE_FENCE,
    MSGID_MISSION_ACK,
    MSGID_MISSION_COUNT,
    MSGID_MISSION_REQUEST,
    MSGID_MISSION_REQUEST_INT,
    get_ack_result_message,
    parse_mission_ack_result,
    parse_mission_count,
    parse_mission_item,
    send_mission_count,
    send_mission_item_int,
)

# Fence item structure for the frontend
class FencePoint:
    def __init__(self, lat: float, lng: float, command: int, param1: float = 0, param2: float = 0):
        self.lat = lat
        self.lng = lng
        self.command = command
        self.param1 = param1
        self.param2 = param2

    def to_dict(self) -> Dict[str, Any]:
        return {
            "lat": self.lat,
            "lng": self.lng,
            "command": self.command,
            "param1": self.param1,
            "param2": self.param2,
        }


# Upload lock (serializes with mission upload)
_fence_upload_lock = threading.Lock()

FENCE_UPLOAD_REQUEST_TIMEOUT_MS = 10000
FENCE_ACK_TIMEOUT_MS = 10000
FENCE_DOWNLOAD_TIMEOUT_MS = 10000
# Real boards (Pixhawk 4.7) activate fence uploads asynchronously after ACK;
# poll download until the module exposes the new geometry (SITL 4.8 is instant).
FENCE_ACTIVATION_SETTLE_S = 3.0

UploadProgressCallback = Callable[[str, int, int], None]


def to_upload_items(points: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Convert frontend fence points to MISSION_ITEM_INT dictionaries.

    ArduPilot's fence protocol (see AC_PolyFence_loader::validate_fence):
    - Polygon vertices  -> param1 = vertex_count of that polygon (all vertices
      of one polygon are consecutive items with the same command, each carrying
      the count for that polygon).
    - Circles            -> param1 = radius (m), must be > 0.
    - Return point       -> at most one, command 5000.

    Frontend points carry {lat, lng, command, param1, param2}.
    """
    cmd_polygon = {MAV_CMD_NAV_FENCE_POLYGON_VERTEX_INCLUSION,
                   MAV_CMD_NAV_FENCE_POLYGON_VERTEX_EXCLUSION}

    # Compute polygon runs: consecutive vertices of the same polygon command
    # form one polygon; its vertex count goes into each vertex's param1.
    counts: Dict[int, int] = {}
    run_end: Dict[int, int] = {}
    i = 0
    n = len(points)
    while i < n:
        cmd = int(points[i].get("command", MAV_CMD_NAV_FENCE_POLYGON_VERTEX_INCLUSION))
        if cmd in cmd_polygon:
            j = i
            while j < n and int(points[j].get("command", -1)) == cmd:
                j += 1
            count = j - i
            cnt = len(counts)
            for k in range(i, j):
                counts[k] = count
                run_end[k] = j
            i = j - 1
        i += 1

    items: List[Dict[str, Any]] = []
    for i, pt in enumerate(points):
        command = int(pt.get("command", MAV_CMD_NAV_FENCE_POLYGON_VERTEX_INCLUSION))
        param1 = float(pt.get("param1", 0))
        if command in cmd_polygon:
            param1 = float(counts.get(i, param1))
        items.append({
            "seq": i,
            "frame": MAV_FRAME_GLOBAL_RELATIVE_ALT,
            "command": command,
            "current": 0,
            "autocontinue": 0,
            "param1": param1,
            "param2": float(pt.get("param2", 0)),
            "param3": 0,
            "param4": 0,
            "x": float(pt["lat"]),
            "y": float(pt["lng"]),
            "z": 0,
            "mission_type": MAV_MISSION_TYPE_FENCE,
        })
    return items


def to_frontend_points(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Convert MISSION_ITEM_INT dicts back to frontend fence points."""
    points: List[Dict[str, Any]] = []
    for it in items:
        points.append({
            "lat": it["x"],
            "lng": it["y"],
            "command": it["command"],
            "param1": it["param1"],
            "param2": it["param2"],
            "seq": it["seq"],
        })
    return points


def upload_fence(
    points: List[Dict[str, Any]],
    on_progress: Optional[UploadProgressCallback] = None,
) -> Dict[str, Any]:
    """Upload fence geometry to the vehicle.

    A zero-length list clears the fence on the vehicle (MISSION_COUNT=0).
    """
    with _fence_upload_lock:
        result = _upload_fence_impl(points, on_progress)
        _wait_for_fence_activation(result.get("count", 0))
        return result


def _wait_for_fence_activation(expected_count: int) -> None:
    """Settle until ArduPilot exposes the just-uploaded fence count.

    Real boards (verified Pixhawk 4.7) send MISSION_ACK before AC_PolyFence
    finishes activating the new geometry, so an immediate request_list can
    report the old count (e.g. 0). SITL 4.8 activates synchronously, so this
    returns on the first probe. Gives up politely within the settle window.
    """
    import time

    start = time.monotonic()
    deadline = start + FENCE_ACTIVATION_SETTLE_S
    while time.monotonic() < deadline:
        time.sleep(0.25)
        try:
            probe = download_fence()
            if len(probe.get("points", [])) == expected_count:
                break
        except Exception:  # noqa: BLE001
            pass
    settle = time.monotonic() - start
    if settle > 0.5:
        print(f"[FENCE UPLOAD] Fence active after {settle:.1f}s settle")


def _upload_fence_impl(
    points: List[Dict[str, Any]],
    on_progress: Optional[UploadProgressCallback] = None,
) -> Dict[str, Any]:
    if not (
        vehicle_state["serialPortOpen"]
        or vehicle_state["udpConnected"]
        or is_tcp_connected()
    ):
        raise RuntimeError("No transport available for fence upload.")

    sys_id = vehicle_state["systemId"] or 1
    comp_id = vehicle_state["componentId"] or 1

    items = to_upload_items(points) if points else []
    total = len(items)

    print(f"[FENCE UPLOAD] Uploading {total} fence points (mission_type={MAV_MISSION_TYPE_FENCE})")
    for it in items:
        print(
            f"[FENCE UPLOAD]   Point {it['seq']}: lat={it['x']:.7f} lon={it['y']:.7f} "
            f"cmd={it['command']} p1={it['param1']}"
        )

    if on_progress:
        on_progress("uploading", 0, total)

    send_mission_count(total, sys_id, comp_id, MAV_MISSION_TYPE_FENCE)

    for i in range(total):
        done = threading.Event()

        def on_request_int(msg: Any, seq: int = i) -> None:
            if done.is_set():
                return
            if getattr(msg, "seq", None) == seq:
                print(f"[FENCE UPLOAD] <<< MISSION_REQUEST_INT seq={seq}")
                done.set()

        def on_request(msg: Any, seq: int = i) -> None:
            if done.is_set():
                return
            if getattr(msg, "seq", None) == seq:
                print(f"[FENCE UPLOAD] <<< MISSION_REQUEST (legacy) seq={seq}")
                done.set()

        unsub_int = packet_bus.on_packet(MSGID_MISSION_REQUEST_INT, on_request_int)
        unsub_legacy = packet_bus.on_packet(MSGID_MISSION_REQUEST, on_request)
        try:
            got = done.wait(FENCE_UPLOAD_REQUEST_TIMEOUT_MS / 1000.0)
            if not got:
                print(f"[FENCE UPLOAD] Timeout waiting for MISSION_REQUEST seq={i} — sending anyway")
        finally:
            unsub_int()
            unsub_legacy()

        item = items[i]
        print(f"[FENCE UPLOAD] >>> Sending MISSION_ITEM_INT #{item['seq']} cmd={item['command']}")
        send_mission_item_int(item, sys_id, comp_id)
        if on_progress:
            on_progress("uploading", i + 1, total)

    print("[FENCE UPLOAD] All items sent. Waiting for MISSION_ACK...")
    ack_done = threading.Event()
    box: Dict[str, Any] = {}

    def on_ack(msg: Any) -> None:
        if ack_done.is_set():
            return
        code = parse_mission_ack_result(msg)
        if code is not None:
            box["code"] = code
            ack_done.set()

    unsub_ack = packet_bus.on_packet(MSGID_MISSION_ACK, on_ack)
    try:
        got = ack_done.wait(FENCE_ACK_TIMEOUT_MS / 1000.0)
        if not got:
            raise RuntimeError("Timeout waiting for MISSION_ACK after fence upload")
    finally:
        unsub_ack()

    ack_code = box.get("code")
    if ack_code != 0:
        raise RuntimeError(f"Fence upload rejected: {get_ack_result_message(ack_code)}")

    print("[FENCE UPLOAD] MISSION_ACK accepted — fence uploaded successfully")
    if on_progress:
        on_progress("done", total, total)

    return {"items": items, "ackCode": ack_code, "count": total}


def download_fence(timeout_s: Optional[float] = None) -> Dict[str, Any]:
    """Download fence geometry from the vehicle.

    Sends MISSION_REQUEST_LIST with mission_type=FENCE, then collects
    MISSION_ITEM_INT per seq. Returns fence points in frontend format.
    """
    if not (
        vehicle_state["serialPortOpen"]
        or vehicle_state["udpConnected"]
        or is_tcp_connected()
    ):
        raise RuntimeError("No transport available for fence download.")

    timeout_s = timeout_s or (FENCE_DOWNLOAD_TIMEOUT_MS / 1000.0)
    sys_id = vehicle_state["systemId"] or 1
    comp_id = vehicle_state["componentId"] or 1

    conn = manager.connection
    if conn is None:
        raise RuntimeError("No transport available.")

    print("[FENCE DOWNLOAD] >>> Sending MISSION_REQUEST_LIST (fence type)")
    manager.enqueue(lambda: conn.mav.mission_request_list_send(sys_id, comp_id, MAV_MISSION_TYPE_FENCE))

    # Wait for MISSION_COUNT
    count_done = threading.Event()
    count_box: Dict[str, Any] = {}

    def on_count(msg: Any) -> None:
        if count_done.is_set():
            return
        parsed = parse_mission_count(msg)
        if parsed is not None:
            count_box["count"] = parsed["count"]
            count_done.set()

    unsub_count = packet_bus.on_packet(MSGID_MISSION_COUNT, on_count)
    try:
        got = count_done.wait(timeout_s)
        if not got:
            print("[FENCE DOWNLOAD] Timeout waiting for MISSION_COUNT — assuming fence empty")
            return {"success": True, "points": [], "count": 0}
    finally:
        unsub_count()

    total = count_box.get("count", 0)
    print(f"[FENCE DOWNLOAD] Vehicle reports {total} fence items")

    if total == 0:
        return {"success": True, "points": [], "count": 0}

    items: List[Dict[str, Any]] = []
    for seq in range(total):
        done = threading.Event()
        item_box: Dict[str, Any] = {}

        def on_item(msg: Any, expected: int = seq) -> None:
            if done.is_set():
                return
            item = parse_mission_item(msg)
            if item is None or item["seq"] != expected:
                return
            item_box["item"] = item
            done.set()

        unsub_item = packet_bus.on_packet(73, on_item)
        try:
            print(f"[FENCE DOWNLOAD] >>> Requesting item seq={seq}")
            manager.enqueue(lambda s=seq: conn.mav.mission_request_int_send(sys_id, comp_id, s, MAV_MISSION_TYPE_FENCE))
            got = done.wait(timeout_s)
            if not got:
                print(f"[FENCE DOWNLOAD] Timeout waiting for fence item seq={seq}")
                break
        finally:
            unsub_item()

        if "item" not in item_box:
            break
        items.append(item_box["item"])

    # Acknowledge the fence transfer so ArduPilot stops sending.
    manager.enqueue(lambda: conn.mav.mission_ack_send(sys_id, comp_id, 0, MAV_MISSION_TYPE_FENCE))

    points = to_frontend_points(items)
    print(f"[FENCE DOWNLOAD] Downloaded {len(points)} fence points")
    return {"success": True, "points": points, "count": len(points)}


def clear_fence() -> Dict[str, Any]:
    """Clear all fence geometry from the vehicle (upload empty list)."""
    return upload_fence([])


def verify_fence(
    points: List[Dict[str, Any]],
    on_progress: Optional[UploadProgressCallback] = None,
) -> Dict[str, Any]:
    """Upload fence geometry and download it back to verify the round-trip.

    Compares command, lat, lng and param1 per point (ArduPilot preserves the
    vertex-count in param1 for polygon vertices and the radius for circles).
    """
    upload_fence(points, on_progress)

    try:
        downloaded = download_fence()
    except Exception as err:  # noqa: BLE001
        raise RuntimeError(f"Verify failed: fence downloaded incorrectly — {err}") from err

    got = downloaded.get("points", [])
    uploadable = to_upload_items(points)

    if len(got) != len(uploadable):
        raise RuntimeError(
            f"Verify failed: point count mismatch (uploaded={len(uploadable)} downloaded={len(got)})"
        )

    differences: List[str] = []
    for i, (up, dl) in enumerate(zip(uploadable, got)):
        dl_lat = float(dl.get("lat", dl.get("x", 0)))
        dl_lng = float(dl.get("lng", dl.get("y", 0)))
        dl_cmd = int(dl["command"])
        dl_p1 = float(dl.get("param1", 0))
        if up["command"] != dl_cmd:
            differences.append(f"Item {i} command: uploaded={up['command']} downloaded={dl_cmd}")
        if abs(up["x"] - dl_lat) > 0.0000005:
            differences.append(f"Item {i} lat: uploaded={up['x']} downloaded={dl_lat}")
        if abs(up["y"] - dl_lng) > 0.0000005:
            differences.append(f"Item {i} lon: uploaded={up['y']} downloaded={dl_lng}")
        if abs(up["param1"] - dl_p1) > 0.01:
            differences.append(f"Item {i} param1: uploaded={up['param1']} downloaded={dl_p1}")

    if differences:
        raise RuntimeError(f"Verify failed: {len(differences)} difference(s) — " + "; ".join(differences))

    print(f"[FENCE VERIFY] PASSED — all {len(got)} fence points match ArduPilot")
    return {"success": True, "count": len(got), "points": got}