"""Mission upload, ported from backend/src/services/missionUpload.service.ts.

Validates the frontend mission, converts it to MAVLink items, drives the
MISSION_COUNT -> MISSION_ITEM_INT handshake and waits for MISSION_ACK.
"""

import threading
from typing import Any, Callable, Dict, List, Optional

from core.state import is_tcp_connected, telemetry, vehicle_state
from mavlink import packet_bus
from mavlink.mission_command import (
    MSGID_MISSION_ACK,
    MSGID_MISSION_REQUEST,
    MSGID_MISSION_REQUEST_INT,
    MSGID_STATUSTEXT,
    get_ack_result_message,
    parse_mission_ack_result,
    parse_mission_request,
    send_mission_count,
    send_mission_item_int,
    waypoints_to_mavlink_items,
)

LAT_LNG_TOLERANCE = 0.000001
ALT_TOLERANCE = 0.5

UploadProgressCallback = Callable[[str, int, int, Optional[str]], None]

_upload_status_text: List[str] = []

# Serializes manual + scheduled mission uploads: packet_bus one-shot listeners
# (MISSION_REQUEST / MISSION_ACK) must never be registered by two concurrent
# uploads — interleaved listeners would steal each other's packets.
_upload_lock = threading.Lock()


def get_upload_status_text() -> List[str]:
    return _upload_status_text


def clear_upload_status_text() -> None:
    _upload_status_text.clear()


def capture_status_text(msg: Any) -> None:
    text = (getattr(msg, "text", "") or "").split("\0")[0].strip()
    if text:
        _upload_status_text.append(text)
        print(f"[UPLOAD STATUSTEXT] {text}")


def validate_mission(home: Optional[Dict[str, Any]], waypoints: List[Any]) -> Dict[str, Any]:
    print("========== BACKEND MISSION VALIDATION STARTED ==========")

    errors: List[str] = []

    if not vehicle_state["connected"]:
        print("[VALIDATION] FAILED — No vehicle connected")
        errors.append("No vehicle connected.")
        return {"valid": False, "errors": errors}

    if not waypoints or len(waypoints) == 0:
        print("[VALIDATION] FAILED — No waypoints in mission")
        errors.append("No waypoints in mission.")
        return {"valid": False, "errors": errors}

    print(f"[VALIDATION] Waypoint count: {len(waypoints)}")

    for wp in waypoints:
        if not isinstance(wp.get("lat"), (int, float)) or isinstance(wp.get("lat"), bool) or _is_nan(wp.get("lat")):
            print(f"[VALIDATION] FAILED — Waypoint {wp.get('id')} has invalid latitude")
            errors.append(f"Waypoint {wp.get('id')} has invalid latitude.")
            return {"valid": False, "errors": errors}
        if not isinstance(wp.get("lng"), (int, float)) or isinstance(wp.get("lng"), bool) or _is_nan(wp.get("lng")):
            print(f"[VALIDATION] FAILED — Waypoint {wp.get('id')} has invalid longitude")
            errors.append(f"Waypoint {wp.get('id')} has invalid longitude.")
            return {"valid": False, "errors": errors}
        alt = wp.get("altitude")
        if not isinstance(alt, (int, float)) or isinstance(alt, bool) or _is_nan(alt) or alt <= 0:
            print(f"[VALIDATION] FAILED — Waypoint {wp.get('id')} has invalid altitude")
            errors.append(f"Waypoint {wp.get('id')} has invalid altitude.")
            return {"valid": False, "errors": errors}

    if len(waypoints) >= 2:
        for i in range(len(waypoints)):
            for j in range(i + 1, len(waypoints)):
                lat_diff = abs(waypoints[i]["lat"] - waypoints[j]["lat"])
                lng_diff = abs(waypoints[i]["lng"] - waypoints[j]["lng"])
                alt_diff = abs(waypoints[i]["altitude"] - waypoints[j]["altitude"])
                if (
                    lat_diff < LAT_LNG_TOLERANCE
                    and lng_diff < LAT_LNG_TOLERANCE
                    and alt_diff < ALT_TOLERANCE
                ):
                    print(
                        f"[VALIDATION] FAILED — Duplicate waypoints: WP{waypoints[i].get('id')} "
                        f"and WP{waypoints[j].get('id')}"
                    )
                    errors.append("Duplicate waypoints detected.")
                    return {"valid": False, "errors": errors}
        print("[VALIDATION] Duplicate check: PASSED")
    else:
        print("[VALIDATION] Duplicate check: SKIPPED (fewer than 2 waypoints)")

    sorted_wps = sorted(waypoints, key=lambda w: w.get("sequence", 0))
    for i, wp in enumerate(sorted_wps):
        if wp.get("sequence") != i + 1:
            print(
                f"[VALIDATION] FAILED — Invalid sequence at WP{wp.get('id')}: "
                f"expected {i + 1}, got {wp.get('sequence')}"
            )
            errors.append("Waypoint numbering is incorrect.")
            return {"valid": False, "errors": errors}
    print("[VALIDATION] Sequence check: PASSED")

    print("[VALIDATION] PASSED")
    return {"valid": len(errors) == 0, "errors": errors}


def _is_nan(value: Any) -> bool:
    if value is None:
        return True
    try:
        import math

        return math.isnan(float(value))
    except (TypeError, ValueError):
        return True


def wait_for_mission_request(seq: int, timeout_ms: int, send_fn: Optional[Callable[[], None]] = None) -> bool:
    """Wait for MISSION_REQUEST_INT (51) or legacy MISSION_REQUEST (40) for seq.

    Registers the packet listener BEFORE calling send_fn (matching Node's
    onPacket-then-send ordering) so early responses are not missed.
    Returns True if a request was received, False on timeout (the uploader
    sends the item anyway in that case, matching the Node implementation).
    """
    done = threading.Event()

    def on_int(msg: Any) -> None:
        if done.is_set():
            return
        req = parse_mission_request(msg)
        if req is not None and req["seq"] == seq:
            print(f"[UPLOAD] Received MISSION_REQUEST_INT seq={seq}")
            done.set()

    def on_legacy(msg: Any) -> None:
        if done.is_set():
            return
        if getattr(msg, "seq", None) == seq:
            print(f"[UPLOAD] Received MISSION_REQUEST (legacy) seq={seq}")
            done.set()

    unsub_int = packet_bus.on_packet(MSGID_MISSION_REQUEST_INT, on_int)
    unsub_legacy = packet_bus.on_packet(MSGID_MISSION_REQUEST, on_legacy)
    try:
        if send_fn is not None:
            send_fn()
        got = done.wait(timeout_ms / 1000.0)
    finally:
        unsub_int()
        unsub_legacy()
    return got


def wait_for_mission_ack(timeout_ms: int) -> int:
    done = threading.Event()
    box: Dict[str, Any] = {}

    def on_ack(msg: Any) -> None:
        if done.is_set():
            return
        print(f"[UPLOAD] RAW MISSION_ACK packet received (msgid=47)")
        ack_type = parse_mission_ack_result(msg)
        if ack_type is not None:
            print(f"[UPLOAD] MISSION_ACK type={ack_type} ({get_ack_result_message(ack_type)})")
            box["type"] = ack_type
            done.set()

    unsub = packet_bus.on_packet(MSGID_MISSION_ACK, on_ack)
    try:
        got = done.wait(timeout_ms / 1000.0)
    finally:
        unsub()
    if not got:
        raise RuntimeError("Timeout waiting for MISSION_ACK")
    return box["type"]


def upload_mission(
    home: Optional[Dict[str, Any]],
    waypoints: List[Dict[str, Any]],
    on_progress: UploadProgressCallback,
) -> Dict[str, Any]:
    with _upload_lock:
        return _upload_mission_impl(home, waypoints, on_progress)


def _upload_mission_impl(
    home: Optional[Dict[str, Any]],
    waypoints: List[Dict[str, Any]],
    on_progress: UploadProgressCallback,
) -> Dict[str, Any]:
    if not (
        vehicle_state["serialPortOpen"]
        or vehicle_state["udpConnected"]
        or is_tcp_connected()
    ):
        raise RuntimeError("No transport available for mission upload.")

    sys_id = vehicle_state["systemId"] or 1
    comp_id = vehicle_state["componentId"] or 1

    h_lat = (home or {}).get("lat") or telemetry["homeLatitude"] or telemetry["latitude"] or 0
    h_lng = (home or {}).get("lng") or telemetry["homeLongitude"] or telemetry["longitude"] or 0
    h_alt = telemetry["homeAltitude"] or telemetry["altitude"] or 0

    items = waypoints_to_mavlink_items(waypoints, h_lat, h_lng, h_alt, vehicle_state["vehicleType"])

    clear_upload_status_text()
    status_text_unsub = packet_bus.on_packet(MSGID_STATUSTEXT, capture_status_text)

    print(f"[UPLOAD] items.length={len(items)} — these are the waypoints being sent")
    print("========================================")
    print("[UPLOAD] Starting mission upload")
    print(f"[UPLOAD] System ID: {sys_id}, Component ID: {comp_id}")
    print(f"[UPLOAD] Total mission items: {len(items)}")
    for idx, item in enumerate(items):
        print(
            f"[UPLOAD]   Item {idx}: seq={item['seq']} cmd={item['command']} "
            f"frame={item['frame']} lat={item['x']} lon={item['y']} alt={item['z']}"
        )

    on_progress("uploading", 0, len(items))

    print("[UPLOAD] >>> Sending MISSION_COUNT")
    print(f"[UPLOAD] >>>   count={len(items)} missionType=0")

    # Pre-register listener for seq=0 BEFORE sending MISSION_COUNT (matching
    # Node's onPacket-then-send ordering).
    for i in range(len(items)):
        # Register listener first, then send (for seq=0 the send is via send_fn).
        # For subsequent items, the listener is registered here before the
        # previous item's MISSION_ITEM_INT is sent — ensuring the listener
        # is in place when the SITL responds.
        print(f"[UPLOAD] >>> Registering MISSION_REQUEST listener for seq={i}...")
        try:
            received = wait_for_mission_request(i, 10000,
                send_fn=(lambda: send_mission_count(len(items), sys_id, comp_id)) if i == 0 else None)
            if received:
                print(f"[UPLOAD] <<< Got request for seq={i}, sending MISSION_ITEM_INT")
            else:
                print(f"[UPLOAD] <<< Timeout waiting for MISSION_REQUEST seq={i} — sending MISSION_ITEM_INT anyway")
        except Exception as err:
            print(f"[UPLOAD] <<< {err} — sending MISSION_ITEM_INT anyway")

        item = items[i]
        print(f"[UPLOAD] >>> Sending MISSION_ITEM_INT #{item['seq']}")
        print(f"[UPLOAD] >>>   command={item['command']} frame={item['frame']}")
        print(
            f"[UPLOAD] >>>   x(raw)={round(item['x'] * 1e7)} y(raw)={round(item['y'] * 1e7)} "
            f"z={item['z']}"
        )
        print(f"[UPLOAD] >>>   param1={item['param1']} autocontinue={item['autocontinue']}")
        send_mission_item_int(item, sys_id, comp_id)
        on_progress("uploading", i + 1, len(items))

    print("[UPLOAD] All items sent. Waiting for MISSION_ACK...")

    ack_code: int = 0
    try:
        ack_code = wait_for_mission_ack(10000)
        ack_label = get_ack_result_message(ack_code)
        print(f"[UPLOAD] MISSION_ACK final: code={ack_code} label={ack_label}")
    except Exception as err:
        print(f"[UPLOAD] MISSION_ACK timeout: {err}")
        print("[UPLOAD] StatusText during upload:")
        for t in _upload_status_text:
            print(f"[UPLOAD]   {t}")
        raise RuntimeError("Mission upload failed: No MISSION_ACK received from vehicle.") from err
    finally:
        status_text_unsub()

    if ack_code != 0:
        ack_label = get_ack_result_message(ack_code)
        status_context = f" Vehicle reported: {' | '.join(_upload_status_text)}" if _upload_status_text else ""
        msg = f"Mission upload rejected — {ack_label}.{status_context}"
        print(f"[UPLOAD] {msg}")
        raise RuntimeError(msg)

    print("[UPLOAD] MISSION_ACK = MAV_MISSION_ACCEPTED — Mission uploaded successfully")
    on_progress("done", len(items), len(items))

    return {"items": items, "ackCode": ack_code}


def get_ack_error_message(code: int) -> str:
    return f"MISSION_ACK {get_ack_result_message(code)}"
