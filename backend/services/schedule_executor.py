"""Scheduled-mission executor.

When a scheduled mission is due, this function is invoked by the schedule
service. It REPURPOSES the existing MAVLink mission-upload implementation, so the
exact MISSION_COUNT -> MISSION_REQUEST_INT -> MISSION_ITEM_INT -> MISSION_ACK
handshake (with post-upload verification) is reused — never duplicated.

Scope is intentionally limited to UPLOAD ONLY:
  - It does NOT arm the vehicle.
  - It does NOT switch flight modes.
  - It does NOT send MAV_CMD_MISSION_START / RTL / takeoff.

This respects the project safety rule that an arriving schedule time alone must
not automatically move the vehicle; the first automated operation is sending the
stored mission to the connected flight controller. Arming/mode/motion remain
explicit operator actions.

All progress is broadcast to every connected frontend over Socket.IO.
"""

from typing import Any, Callable, Dict, Optional

from core.state import vehicle_state
from mavlink import telemetry_manager as tm
from services.mission_download_service import download_mission_from_ardupilot, verify_mission
from services.mission_upload_service import upload_mission, validate_mission
from sio import server as sio_server


def _default_emit(event: str, data: Any) -> None:
    sio_server.emit(event, data)


def execute_scheduled_mission(entry: Dict[str, Any], emit: Optional[Callable[[str, Any], None]] = None) -> Dict[str, Any]:
    """Upload the stored scheduled mission to the connected flight controller.

    Raises on any failure (validation, connection, handshake, ack, verification)
    so the schedule service can record the error and keep the mission for retry.
    """
    emit = emit or _default_emit
    sid = entry.get("id", "unknown")
    name = entry.get("name", "Untitled")
    mission = entry.get("mission", {}) or {}
    waypoints = mission.get("waypoints", [])
    home = mission.get("home")

    if not vehicle_state.get("connected"):
        raise RuntimeError(
            "Flight controller is not connected — mission was NOT uploaded. "
            "Connect the flight controller and the pending schedule will run."
        )

    if not waypoints:
        raise RuntimeError("Scheduled mission has no waypoints to upload.")

    validation = validate_mission(home, waypoints)
    if not validation.get("valid"):
        raise RuntimeError(
            f"Mission validation failed: {', '.join(validation.get('errors', []))}"
        )

    def on_progress(phase: str, current: int, total: int, message: Optional[str] = None) -> None:
        emit("schedule:progress", {
            "id": sid,
            "name": name,
            "phase": phase,
            "current": current,
            "total": total,
            "message": message or f"Uploading {current}/{total} waypoints...",
        })

    print("========================================")
    print(f"[SCHEDULE:EXEC] Executing scheduled mission: {name} (id={sid})")
    print(f"[SCHEDULE:EXEC] Waypoints: {len(waypoints)}")
    emit("schedule:executing", {
        "id": sid,
        "name": name,
        "message": f"Uploading scheduled mission: {name}",
    })

    print(f"[SCHEDULE:EXEC] >>> MISSION_COUNT / MISSION_REQUEST_INT / MISSION_ITEM_INT / MISSION_ACK")
    uploaded = upload_mission(home, waypoints, on_progress)
    print(f"[SCHEDULE:EXEC] MISSION_ACK = {uploaded['ackCode']} (ACCEPTED)")

    emit("schedule:progress", {
        "id": sid,
        "name": name,
        "phase": "verifying",
        "message": "Verifying upload with the flight controller...",
    })
    download = download_mission_from_ardupilot()
    if not download.success:
        raise RuntimeError(f"Post-upload verification failed: {download.error}")
    verification = verify_mission(uploaded["items"], download.items)
    if not verification.get("match"):
        diff_str = "; ".join(verification.get("differences", []))
        raise RuntimeError(f"Post-upload verification failed — mission does not match: {diff_str}")

    vehicle_state["missionUploaded"] = True
    vehicle_state["missionCompleted"] = False
    vehicle_state["missionRunning"] = False
    vehicle_state["missionTotalWaypoints"] = len(waypoints)
    tm.set_active_mission_waypoints(
        [{"seq": wp.get("sequence"), "lat": wp.get("lat"), "lng": wp.get("lng")} for wp in waypoints]
    )
    sio_server.broadcast_vehicle_status()

    print(f"[SCHEDULE:EXEC] Uploaded + verified {len(waypoints)} waypoints — success.")
    print("========================================")
    emit("schedule:uploaded", {
        "id": sid,
        "name": name,
        "waypointCount": len(waypoints),
    })
    return {"success": True, "waypointCount": len(waypoints), "ackCode": uploaded["ackCode"]}