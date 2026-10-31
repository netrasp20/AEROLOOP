"""REST handlers for /api/vehicle (vehicle.routes.ts + vehicle.controller.ts).

Mirrors the Node controllers: status/serial-ports/connect/disconnect plus the
Phase D arm/disarm/mode/home endpoints with identical status codes and payloads.
"""

from typing import Dict, Optional

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from services.serial_service import get_available_serial_ports

router = APIRouter()


def _serial_ports():
    try:
        return JSONResponse({"success": True, "ports": get_available_serial_ports()})
    except Exception as err:  # noqa: BLE001 - mirror Node's catch-all JSON error
        return JSONResponse({"success": False, "error": str(err)}, status_code=500)


@router.get("/serial-ports")
def serial_ports():
    return _serial_ports()


@router.get("/status")
def status():
    from core.state import get_vehicle_status

    return JSONResponse(get_vehicle_status())


@router.post("/connect")
def connect(body: Optional[Dict] = None):
    from services.vehicle_service import connect_vehicle

    body = body or {}
    ok, payload, code = connect_vehicle(body)
    return JSONResponse(payload, status_code=code if code else (200 if ok else 503))


@router.post("/disconnect")
def disconnect():
    from services.vehicle_service import disconnect_vehicle

    return JSONResponse(disconnect_vehicle())


# ------------------------------------------------------------------
# Shared guards (parity with vehicle.controller.ts)
# ------------------------------------------------------------------
def _not_connected() -> JSONResponse:
    from core.state import vehicle_state
    from core.config import CONNECTION_TIMEOUT_MS  # noqa: F401 - used for parity docs

    if not vehicle_state["serialPortOpen"]:
        reason = "Serial port is not open"
    elif vehicle_state["lastHeartbeat"] == 0:
        reason = "No HEARTBEAT ever received"
    else:
        import time

        reason = (
            f"Last HEARTBEAT {int(time.time() * 1000 - vehicle_state['lastHeartbeat'])}"
            "ms ago (timeout: 10000ms)"
        )
    print(f"[CTRL] Rejected: {reason}")
    return JSONResponse({"success": False, "message": "Vehicle is not connected."}, status_code=400)


def _is_connected() -> bool:
    from core.state import is_vehicle_connected

    return is_vehicle_connected()


@router.post("/arm")
def arm():
    from mavlink.command_service import arm_vehicle

    print("========== ARM REQUEST ==========")
    print(f"Serial Open: {_get('serialPortOpen')}")
    print(f"Heartbeat Received: {_get('lastHeartbeat') > 0}")
    print(f"Vehicle Connected: {_is_connected()}")
    print(f"System ID: {_get('systemId')}")
    print(f"Component ID: {_get('componentId')}")
    print(f"Current Mode: {_get('mode')}")
    print(f"Current Armed State: {_get('armed')}")
    print("=================================")

    if not _is_connected():
        return _not_connected()

    if not _get("missionUploaded"):
        print("[ARM] Rejected: Mission not uploaded")
        return JSONResponse(
            {"success": False, "message": "Mission not uploaded. Please upload a mission first."},
            status_code=400,
        )

    result = arm_vehicle()

    if result["success"]:
        print("[ARM] SUCCESS — vehicle armed")
        return JSONResponse({"success": True, "message": result["message"]})
    print(f"[ARM] FAILURE — {result['message']}")
    return JSONResponse(
        {
            "success": False,
            "message": result["message"],
            "ackCode": result.get("ackCode"),
            "ackLabel": result.get("ackLabel"),
            "statusText": result.get("statusText"),
        },
        status_code=400,
    )


@router.post("/disarm")
def disarm():
    from mavlink.command_service import disarm_vehicle

    print("========== DISARM REQUEST ==========")
    print(f"Serial Open: {_get('serialPortOpen')}")
    print(f"Heartbeat Received: {_get('lastHeartbeat') > 0}")
    print(f"Vehicle Connected: {_is_connected()}")
    print(f"System ID: {_get('systemId')}")
    print(f"Component ID: {_get('componentId')}")
    print(f"Current Mode: {_get('mode')}")
    print(f"Current Armed State: {_get('armed')}")
    print("====================================")

    if not _is_connected():
        return _not_connected()

    result = disarm_vehicle()

    if result["success"]:
        print("[DISARM] SUCCESS — vehicle disarmed")
        return JSONResponse({"success": True, "message": "Vehicle disarmed successfully"})
    print(f"[DISARM] FAILURE — {result['message']}")
    return JSONResponse(
        {
            "success": False,
            "message": result["message"],
            "ackCode": result.get("ackCode"),
            "ackLabel": result.get("ackLabel"),
        },
        status_code=400,
    )


@router.post("/mode")
def mode(body: Optional[Dict] = None):
    from mavlink.command_service import set_mode

    body = body or {}
    mode_name = body.get("mode")

    print("========== MODE CHANGE REQUEST ==========")
    print(f"Serial Open: {_get('serialPortOpen')}")
    print(f"Heartbeat Received: {_get('lastHeartbeat') > 0}")
    print(f"Vehicle Connected: {_is_connected()}")
    print(f"System ID: {_get('systemId')}")
    print(f"Component ID: {_get('componentId')}")
    print(f"Current Mode: {_get('mode')}")
    print(f"Armed State: {_get('armed')}")
    print("========================================")

    if not _is_connected():
        return _not_connected()

    result = set_mode(mode_name)

    if result["success"]:
        print(f"[MODE] SUCCESS — changed to {mode_name}")
        return JSONResponse({"success": True, "message": f"Mode changed to {mode_name}", "mode": mode_name})
    print(f"[MODE] FAILURE — {result['message']}")
    return JSONResponse(
        {
            "success": False,
            "message": result["message"],
            "ackCode": result.get("ackCode"),
            "ackLabel": result.get("ackLabel"),
        },
        status_code=400,
    )


@router.post("/home")
def home(body: Optional[Dict] = None):
    from mavlink.command_service import set_home

    body = body or {}
    print("========================================")
    print("[HOME] SET HOME requested")

    if not _is_connected():
        print("[HOME] Rejected: vehicle not connected")
        return JSONResponse({"success": False, "message": "Vehicle is not connected."}, status_code=400)

    lat = body.get("lat")
    lon = body.get("lon")
    alt = body.get("alt")

    result = set_home(lat=lat, lon=lon, alt=alt) if lat is not None and lon is not None else set_home()

    if result["success"]:
        print("[HOME] SUCCESS — home set")
        return JSONResponse({"success": True, "message": "Home location set."})
    print(f"[HOME] FAILURE — {result['message']}")
    return JSONResponse(
        {
            "success": False,
            "message": result["message"],
            "ackCode": result.get("ackCode"),
            "ackLabel": result.get("ackLabel"),
        },
        status_code=400,
    )


def _get(key: str):
    from core.state import vehicle_state

    return vehicle_state[key]
