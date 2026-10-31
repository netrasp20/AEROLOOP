"""Socket.IO mission handlers, ported from backend/src/socket/mission.socket.ts.

One mission = HOME -> WP1..WPn -> RTL -> HOME -> "mission completed". The auto
RTL handler is registered here so telemetryManager can trigger it when the
last waypoint is reached.

All blocking MAVLink waits run via asyncio.to_thread so the ASGI event loop
stays free while heartbeats continue to flow; socket emits are thread-safe.
"""

import asyncio
from typing import Any, Callable, Dict, Optional

import socketio

from core.state import telemetry, vehicle_state
from mavlink import telemetry_manager as tm
from mavlink.command_service import (
    arm_vehicle,
    get_safe_arm_mode,
    is_mode_armable,
    send_command_long,
    set_mission_current,
    set_mode,
)
from mavlink.connection_manager import manager
from services.mission_download_service import (
    download_mission_from_ardupilot,
    get_mission_count_from_ardupilot,
    verify_mission,
)
from services.mission_start_service import start_mission, validate_start
from services.mission_upload_service import upload_mission, validate_mission
from services.rtl_service import return_to_launch, validate_rtl
from sio import server as sio_server

MAV_CMD_DO_SET_MISSION_CURRENT = 224


def _emit(sid: str, event: str, data: Any) -> None:
    sio_server.emit_to(event, data, sid)


def _first_mission_item_seq() -> int:
    return 1


# ------------------------------------------------------------------
# RTL helper (parity with runRtlOnSocket)
# ------------------------------------------------------------------
def _run_rtl_on_socket(sid: str, source: str) -> Dict[str, Any]:
    _emit(
        sid,
        "mission:rtl:progress",
        {
            "step": "switching",
            "message": "Switching to RTL mode...",
            "distanceM": telemetry["distanceToHome"],
            "auto": source == "auto",
        },
    )

    def on_progress(message: str, distance_m: float) -> None:
        _emit(
            sid,
            "mission:rtl:progress",
            {
                "step": "returning",
                "message": message,
                "distanceM": distance_m,
                "auto": source == "auto",
            },
        )

    result = return_to_launch(on_progress)

    if result["success"]:
        _emit(
            sid,
            "mission:rtl:success",
            {
                "message": result["message"],
                "distanceM": telemetry["distanceToHome"],
                "auto": source == "auto",
            },
        )
    else:
        _emit(
            sid,
            "mission:rtl:error",
            {
                "message": result["message"],
                "statusText": result.get("statusText"),
                "auto": source == "auto",
            },
        )

    return {"success": result["success"], "message": result["message"]}


# ------------------------------------------------------------------
# mission:upload
# ------------------------------------------------------------------
def _upload_flow(sid: str, payload: Dict[str, Any]) -> None:
    print("========================================")
    print("[MISSION] Upload requested - starting validation")
    home = (payload or {}).get("home")
    waypoints = (payload or {}).get("waypoints") or []
    print(f"[MISSION] Waypoints received: {len(waypoints)}")
    for i, wp in enumerate(waypoints):
        print(
            f"[MISSION]   WP{wp.get('sequence')}: lat={wp.get('lat')} lon={wp.get('lng')} "
            f"alt={wp.get('altitude')} hover={wp.get('hoverTime')}"
        )
    home_str = f"lat={home['lat']} lon={home['lng']}" if home else "NOT SET"
    print(f"[MISSION] Home: {home_str}")

    validation = validate_mission(home, waypoints)
    if not validation["valid"]:
        print(f"[MISSION] Validation FAILED: {', '.join(validation['errors'])}")
        print("========================================")
        _emit(
            sid,
            "mission:error",
            {"message": "Mission validation failed.", "errors": validation["errors"]},
        )
        return

    print("[MISSION] Validation PASSED - starting upload")

    def on_progress(
        phase: str, current: int, total: int, message: Optional[str] = None
    ) -> None:
        _emit(
            sid,
            "mission:progress",
            {"phase": phase, "current": current, "total": total, "message": message},
        )

    try:
        on_progress("connecting", 0, len(waypoints))

        print(
            "[MISSION] Sending "
            f"{len(waypoints)} waypoints as MAVLink mission items "
            "(seq 0 = HOME reserved by ArduPilot; seq 1 = first real command: "
            "waypoint for ground vehicles, NAV_TAKEOFF for air vehicles)"
        )
        uploaded = upload_mission(home, waypoints, on_progress)
        uploaded_items = uploaded["items"]
        ack_code = uploaded["ackCode"]
        print(f"[MISSION] Upload complete - MISSION_ACK={ack_code} (ACCEPTED)")

        on_progress("verifying", 0, len(waypoints))
        print("[MISSION] Verifying upload — downloading mission from ArduPilot...")

        download = download_mission_from_ardupilot()
        if not download.success:
            msg = f"Upload verification failed: {download.error}"
            print(f"[MISSION] {msg}")
            raise RuntimeError(msg)

        verification = verify_mission(uploaded_items, download.items)
        if not verification["match"]:
            diff_str = "; ".join(verification["differences"])
            msg = (
                "Upload verification FAILED — mission on ArduPilot does not match "
                f"uploaded mission: {diff_str}"
            )
            print(f"[MISSION] {msg}")
            raise RuntimeError(msg)

        print(f"[MISSION] Verification PASSED — {len(uploaded_items)} items match ArduPilot")

        vehicle_state["missionUploaded"] = True
        vehicle_state["missionCompleted"] = False
        vehicle_state["missionRunning"] = False
        vehicle_state["missionTotalWaypoints"] = len(waypoints)
        telemetry["missionCurrent"] = 0
        telemetry["missionReached"] = 0
        telemetry["missionRunning"] = False
        telemetry["missionCompleted"] = False
        tm.set_active_mission_waypoints(
            [
                {"seq": wp["sequence"], "lat": wp["lat"], "lng": wp["lng"]}
                for wp in waypoints
            ]
        )
        sio_server.broadcast_vehicle_status()

        try:
            send_command_long(MAV_CMD_DO_SET_MISSION_CURRENT, param1=0)
            print("[MISSION] DO_SET_MISSION_CURRENT seq=0 sent — current waypoint reset to HOME")
        except Exception as err:  # noqa: BLE001
            print(f"[MISSION] DO_SET_MISSION_CURRENT failed (non-fatal): {err}")

        on_progress("done", len(waypoints), len(waypoints))

        print(
            f"[MISSION] Emitting mission:success ({len(waypoints)} waypoints uploaded and verified)"
        )
        _emit(
            sid,
            "mission:success",
            {
                "message": "Mission uploaded successfully.",
                "waypointCount": len(waypoints),
                "verifiedCount": download.count,
                "vehicleMode": vehicle_state["mode"],
            },
        )

        if not telemetry["atHome"]:
            print(
                f"[MISSION] Vehicle is away from home (distanceToHome={telemetry['distanceToHome']:.1f}m) — auto RTL"
            )
            rtl_result = _run_rtl_on_socket(sid, "auto")
            if rtl_result["success"]:
                print("[MISSION] Auto-RTL complete — vehicle is at home")
        else:
            print("[MISSION] Vehicle is already at home — no RTL needed")
            _emit(
                sid,
                "mission:rtl:success",
                {
                    "message": "Vehicle is already at home.",
                    "distanceM": telemetry["distanceToHome"],
                    "auto": True,
                },
            )
    except Exception as err:  # noqa: BLE001
        msg = str(err)
        print(f"[MISSION] Upload FAILED: {msg}")
        _emit(sid, "mission:error", {"message": msg, "errors": [msg]})
    print("========================================")


async def _on_mission_upload(sid: str, data: Dict[str, Any]) -> None:
    await asyncio.to_thread(_upload_flow, sid, data or {})


# ------------------------------------------------------------------
# mission:verify
# ------------------------------------------------------------------
def _verify_flow(sid: str) -> None:
    print("[MISSION] Verification requested from frontend")
    result = download_mission_from_ardupilot()
    _emit(
        sid,
        "mission:verify:result",
        {
            "success": result.success,
            "count": result.count,
            "error": result.error,
            "items": result.items,
        },
    )


async def _on_mission_verify(sid: str, _data: Any = None) -> None:
    await asyncio.to_thread(_verify_flow, sid)


# ------------------------------------------------------------------
# mission:start
# ------------------------------------------------------------------
def _start_flow(sid: str) -> None:
    print("========================================")
    print("[MISSION] Start requested — validating preconditions")
    print(
        f"[MISSION]   connected={vehicle_state['connected']} "
        f"uploaded={vehicle_state['missionUploaded']} "
        f"armed={vehicle_state['armed']} mode={vehicle_state['mode']}"
    )

    ap_count = get_mission_count_from_ardupilot()
    print(f"[MISSION] ArduPilot mission count: {ap_count}")
    if ap_count <= 0:
        msg = "Cannot start mission — no mission stored on ArduPilot (mission count = 0). Upload a mission first."
        print(f"[MISSION] Start rejected: {msg}")
        _emit(sid, "mission:start:error", {"message": msg})
        print("========================================")
        return

    validation = validate_start()
    if not validation["success"]:
        print(f"[MISSION] Start rejected: {validation['message']}")
        print("========================================")
        _emit(sid, "mission:start:error", {"message": validation["message"]})
        return

    try:
        if manager.connection is None:
            print("[MISSION] Start rejected: No transport available")
            _emit(sid, "mission:start:error", {"message": "No transport available."})
            return

        first_seq = _first_mission_item_seq()
        print(
            f"[MISSION] Setting active waypoint to seq={first_seq} (first executable command)..."
        )
        set_cur_result = set_mission_current(first_seq)
        if not set_cur_result["success"]:
            print(
                f"[MISSION] Warning: could not set mission current (non-fatal): {set_cur_result['message']}"
            )

        print("[MISSION] Sending MAV_CMD_MISSION_START...")
        result = start_mission()

        if result["success"]:
            print("[MISSION] Mission STARTED successfully")
            tm.set_mission_running(True)
            sio_server.broadcast_vehicle_status()
            _emit(sid, "mission:start:success", {"message": result["message"]})
        else:
            print(f"[MISSION] Start FAILED: {result['message']}")
            _emit(
                sid,
                "mission:start:error",
                {
                    "message": result["message"],
                    "ackCode": result.get("ackCode"),
                    "ackLabel": result.get("ackLabel"),
                },
            )
    except Exception as err:  # noqa: BLE001
        msg = str(err)
        print(f"[MISSION] Start EXCEPTION: {msg}")
        _emit(sid, "mission:start:error", {"message": msg})
    print("========================================")


async def _on_mission_start(sid: str, _data: Any = None) -> None:
    await asyncio.to_thread(_start_flow, sid)


# ------------------------------------------------------------------
# mission:start:auto
# ------------------------------------------------------------------
def _auto_flow(sid: str) -> None:
    print("=============================================")
    print("[MISSION:AUTO] START MISSION clicked")
    print(f"[MISSION:AUTO] connected={vehicle_state['connected']}")
    print(f"[MISSION:AUTO] missionUploaded={vehicle_state['missionUploaded']}")
    print(f"[MISSION:AUTO] mode={vehicle_state['mode']}")
    print(f"[MISSION:AUTO] armed={vehicle_state['armed']}")
    print(f"[MISSION:AUTO] gpsFix={vehicle_state['gpsFix']}")
    print(f"[MISSION:AUTO] satellites={vehicle_state['satellites']}")
    print("=============================================")

    if not vehicle_state["connected"]:
        print("[MISSION:AUTO] FAILED: Vehicle not connected")
        _emit(sid, "mission:auto:error", {"message": "Vehicle not connected.", "step": "connected"})
        return
    print("[MISSION:AUTO] PASS: Vehicle connected")

    if not vehicle_state["missionUploaded"]:
        print("[MISSION:AUTO] FAILED: No mission uploaded")
        _emit(sid, "mission:auto:error", {"message": "Please upload a mission first.", "step": "uploaded"})
        return
    print("[MISSION:AUTO] PASS: Mission uploaded")

    ap_count = get_mission_count_from_ardupilot()
    print(f"[MISSION:AUTO] ArduPilot mission count: {ap_count}")
    if ap_count <= 0:
        msg = "No uploaded mission found on ArduPilot (mission count = 0). Upload a mission first."
        print(f"[MISSION:AUTO] FAILED: {msg}")
        _emit(sid, "mission:auto:error", {"message": msg, "step": "uploaded"})
        return
    print(f"[MISSION:AUTO] PASS: ArduPilot has {ap_count} mission items")

    if not telemetry["atHome"]:
        _emit(
            sid,
            "mission:auto:progress",
            {"step": "rtl", "message": "Vehicle is away from home — returning to launch (RTL)..."},
        )
        print(
            f"[MISSION:AUTO] Vehicle away from home ({telemetry['distanceToHome']:.1f}m) — running RTL first"
        )
        rtl_result = _run_rtl_on_socket(sid, "auto")
        if not rtl_result["success"]:
            print(f"[MISSION:AUTO] FAILED at RTL: {rtl_result['message']}")
            _emit(sid, "mission:auto:error", {"message": rtl_result["message"], "step": "rtl"})
            return
        print("[MISSION:AUTO] PASS: Vehicle is at home")
    else:
        print("[MISSION:AUTO] PASS: Vehicle already at home")

    if not is_mode_armable(vehicle_state["mode"]):
        safe_mode = get_safe_arm_mode()
        _emit(
            sid,
            "mission:auto:progress",
            {
                "step": "mode",
                "message": f"Switching from {vehicle_state['mode']} to {safe_mode} before arming...",
            },
        )
        print(
            f"[MISSION:AUTO] Current mode {vehicle_state['mode']} is not armable — switching to {safe_mode}"
        )
        mode_fix = set_mode(safe_mode)
        if not mode_fix["success"]:
            reason = (
                mode_fix.get("statusText")
                or mode_fix.get("message")
                or f"Failed to switch to {safe_mode}."
            )
            print(f"[MISSION:AUTO] FAILED to switch to {safe_mode}: {reason}")
            _emit(sid, "mission:auto:error", {"message": reason, "step": "mode"})
            return
        print(f"[MISSION:AUTO] PASS: Switched to {safe_mode} (armable)")

    _emit(sid, "mission:auto:progress", {"step": "arm", "message": "Arming vehicle..."})
    if vehicle_state["armed"]:
        print("[MISSION:AUTO] Vehicle already armed — skipping ARM command")
        _emit(
            sid,
            "mission:auto:progress",
            {"step": "arm", "message": "Vehicle already armed — skipping ARM."},
        )
    else:
        print("[MISSION:AUTO] Attempting to ARM...")
        try:
            arm_result = arm_vehicle()
            print(
                f"[MISSION:AUTO] Arm result: success={arm_result['success']} "
                f'message="{arm_result["message"]}" ackLabel={arm_result.get("ackLabel")}'
            )
            if not arm_result["success"]:
                reason = (
                    arm_result.get("statusText")
                    or arm_result.get("message")
                    or "Arm command rejected."
                )
                print(f"[MISSION:AUTO] FAILED at ARM: {reason}")
                _emit(sid, "mission:auto:error", {"message": reason, "step": "arm"})
                return
        except Exception as err:  # noqa: BLE001
            msg = str(err)
            print(f"[MISSION:AUTO] FAILED at ARM (exception): {msg}")
            _emit(sid, "mission:auto:error", {"message": msg, "step": "arm"})
            return
    print("[MISSION:AUTO] PASS: Vehicle armed")

    first_seq = _first_mission_item_seq()
    print(f"[MISSION:AUTO] Setting active waypoint to seq={first_seq} (first executable command)...")
    try:
        set_cur_result = set_mission_current(first_seq)
        if not set_cur_result["success"]:
            print(
                f"[MISSION:AUTO] Warning: could not set mission current (non-fatal): {set_cur_result['message']}"
            )
    except Exception as err:  # noqa: BLE001
        print(f"[MISSION:AUTO] Warning: exception setting mission current (non-fatal): {err}")

    _emit(sid, "mission:auto:progress", {"step": "mode", "message": "Switching to AUTO mode..."})
    print("[MISSION:AUTO] Attempting mode change to AUTO...")
    try:
        mode_result = set_mode("AUTO")
        print(
            f"[MISSION:AUTO] Mode change result: success={mode_result['success']} "
            f'message="{mode_result["message"]}" ackLabel={mode_result.get("ackLabel")}'
        )
        if not mode_result["success"]:
            reason = mode_result.get("message") or "Failed to set AUTO mode."
            print(f"[MISSION:AUTO] FAILED at AUTO: {reason}")
            _emit(sid, "mission:auto:error", {"message": reason, "step": "mode"})
            return
    except Exception as err:  # noqa: BLE001
        msg = str(err)
        print(f"[MISSION:AUTO] FAILED at AUTO (exception): {msg}")
        _emit(sid, "mission:auto:error", {"message": msg, "step": "mode"})
        return
    print("[MISSION:AUTO] PASS: AUTO mode confirmed (COMMAND_ACK=ACCEPTED)")

    _emit(sid, "mission:auto:progress", {"step": "start", "message": "Starting mission..."})
    print("[MISSION:AUTO] Sending MAV_CMD_MISSION_START...")
    try:
        if manager.connection is None:
            print("[MISSION:AUTO] FAILED: No transport")
            _emit(sid, "mission:auto:error", {"message": "No transport available.", "step": "start"})
            return

        result = start_mission()
        print(
            f"[MISSION:AUTO] Mission start result: success={result['success']} "
            f'message="{result["message"]}" ackLabel={result.get("ackLabel")}'
        )
        if result["success"]:
            print("[MISSION:AUTO] SUCCESS: Mission started")
        else:
            print(
                f"[MISSION:AUTO] MAV_CMD_MISSION_START returned {result.get('ackLabel')} "
                "— vehicle is already in AUTO mode, mission is running"
            )
        tm.set_mission_running(True)
        sio_server.broadcast_vehicle_status()
        _emit(sid, "mission:auto:success", {"message": "Mission Started Successfully."})
    except Exception as err:  # noqa: BLE001
        msg = str(err)
        print(f"[MISSION:AUTO] FAILED (exception): {msg}")
        _emit(sid, "mission:auto:error", {"message": msg, "step": "start"})

    print("=============================================")


async def _on_mission_start_auto(sid: str, _data: Any = None) -> None:
    await asyncio.to_thread(_auto_flow, sid)


# ------------------------------------------------------------------
# mission:rtl
# ------------------------------------------------------------------
def _rtl_flow(sid: str) -> None:
    print("=============================================")
    print("[MISSION:RTL] Return-to-Launch requested")
    validation = validate_rtl()
    if not validation["success"]:
        print(f"[MISSION:RTL] Rejected: {validation['message']}")
        _emit(sid, "mission:rtl:error", {"message": validation["message"]})
        print("=============================================")
        return
    result = _run_rtl_on_socket(sid, "manual")
    print(f'[MISSION:RTL] Result: success={result["success"]} message="{result["message"]}"')
    print("=============================================")


async def _on_mission_rtl(sid: str, _data: Any = None) -> None:
    await asyncio.to_thread(_rtl_flow, sid)


# ------------------------------------------------------------------
# mission:set-current
# ------------------------------------------------------------------
def _set_current_flow(sid: str, seq: Any) -> None:
    print(f"[MISSION] Setting current waypoint to seq={seq}")
    try:
        if manager.connection is None:
            _emit(sid, "mission:error", {"message": "No transport."})
            return
        send_command_long(MAV_CMD_DO_SET_MISSION_CURRENT, param1=int(seq))
        print(f"[MISSION] DO_SET_MISSION_CURRENT seq={seq} sent")
        _emit(sid, "mission:status", {"message": f"Jumped to waypoint {seq}"})
    except Exception as err:  # noqa: BLE001
        _emit(sid, "mission:error", {"message": str(err)})


async def _on_mission_set_current(sid: str, data: Any) -> None:
    await asyncio.to_thread(_set_current_flow, sid, data)


# ------------------------------------------------------------------
# Registration
# ------------------------------------------------------------------
def register_mission_handlers(sio: socketio.AsyncServer) -> None:
    """Register the mission event handlers (once) and the auto-RTL hook."""
    tm.set_auto_rtl_on_completion(return_to_launch)

    sio.on("mission:upload")(_on_mission_upload)
    sio.on("mission:verify")(_on_mission_verify)
    sio.on("mission:start")(_on_mission_start)
    sio.on("mission:start:auto")(_on_mission_start_auto)
    sio.on("mission:rtl")(_on_mission_rtl)
    sio.on("mission:set-current")(_on_mission_set_current)
