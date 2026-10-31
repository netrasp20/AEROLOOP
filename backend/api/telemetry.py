"""REST handlers for /api/telemetry (telemetry.routes.ts + telemetry.controller.ts)."""

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from core.state import get_telemetry_data

router = APIRouter()


@router.get("")
def get_telemetry():
    return JSONResponse(get_telemetry_data())