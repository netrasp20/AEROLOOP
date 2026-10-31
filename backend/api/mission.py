"""REST handlers for /api/mission (mission.routes.ts + mission.controller.ts +
missionStart.controller.ts).

Mirrors the Node controllers: save/get/clear the in-memory mission and the
POST /start endpoint with identical status codes and payloads.
"""

from typing import Dict, Optional

from fastapi import APIRouter
from fastapi.responses import JSONResponse

router = APIRouter()


@router.post("")
def save_mission_route(body: Optional[Dict] = None):
    from services.mission_service import save_mission

    save_mission(body or {})
    return JSONResponse({"success": True, "message": "Mission saved successfully."})


@router.get("")
def get_mission_route():
    from services.mission_service import get_mission

    return JSONResponse(get_mission())


@router.delete("")
def clear_mission_route():
    from services.mission_service import clear_mission

    clear_mission()
    return JSONResponse({"success": True, "message": "Mission cleared."})


@router.post("/start")
def start_mission_route():
    from services.mission_start_service import start_mission, validate_start

    validation = validate_start()
    if not validation["success"]:
        return JSONResponse({"success": False, "message": validation["message"]}, status_code=400)

    from mavlink.connection_manager import manager

    if manager.connection is None:
        return JSONResponse({"success": False, "message": "No transport available."}, status_code=500)

    result = start_mission()

    if result["success"]:
        return JSONResponse({"success": True, "message": result["message"]})
    return JSONResponse(
        {
            "success": False,
            "message": result["message"],
            "ackCode": result.get("ackCode"),
            "ackLabel": result.get("ackLabel"),
        },
        status_code=500,
    )
