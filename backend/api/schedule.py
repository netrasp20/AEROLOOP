"""REST handlers for /api/schedule — real mission scheduling CRUD.

Enforces that a flight controller must be connected before a mission can be
scheduled, validates the mission payload + future date/time, and stores the full
schedule (including the exact waypoint snapshot) so the backend scheduler can
later execute it through the MAVLink mission-upload flow.
"""

from typing import Any, Dict, Optional

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from core.state import is_vehicle_connected
from services import schedule_service

router = APIRouter()


@router.get("")
def list_schedules():
    schedules = schedule_service.list_schedules()
    return JSONResponse({"success": True, "schedules": schedules})


@router.post("")
def add_schedule(body: Optional[Dict[str, Any]] = None):
    body = body or {}
    entry_id = body.get("id")
    if not entry_id:
        return JSONResponse({"success": False, "message": "Missing schedule id."}, status_code=400)

    if not is_vehicle_connected():
        return JSONResponse(
            {
                "success": False,
                "message": "Connect to the flight controller before scheduling a mission.",
            },
            status_code=400,
        )

    mission = body.get("mission") or {}
    waypoints = mission.get("waypoints") or []
    if not waypoints:
        return JSONResponse(
            {"success": False, "message": "No waypoints to schedule. Add waypoints first."},
            status_code=400,
        )

    # Check for duplicate
    existing = schedule_service.list_schedules()
    if any(s.get("id") == entry_id for s in existing):
        return JSONResponse(
            {"success": False, "message": "Schedule with this id already exists."},
            status_code=409,
        )

    try:
        entry = schedule_service.add_schedule(body)
    except ValueError as err:
        return JSONResponse({"success": False, "message": str(err)}, status_code=400)

    return JSONResponse({"success": True, "schedule": entry})


@router.delete("/{schedule_id}")
def delete_schedule(schedule_id: str):
    removed = schedule_service.remove_schedule(schedule_id)
    if removed:
        return JSONResponse({"success": True, "message": f"Schedule {schedule_id} removed."})
    return JSONResponse({"success": False, "message": "Schedule not found."}, status_code=404)


@router.patch("/{schedule_id}")
def update_schedule(schedule_id: str, body: Optional[Dict[str, Any]] = None):
    body = body or {}
    updated = schedule_service.update_schedule(schedule_id, body)
    if updated:
        return JSONResponse({"success": True, "schedule": updated})
    return JSONResponse({"success": False, "message": "Schedule not found."}, status_code=404)