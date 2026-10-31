"""Vehicle connection orchestration (vehicle.service.ts).

Phase B implements the transports (TCP/UDP/serial) and heartbeat detection; until then
connect returns a clear NotImplemented result so the API contract stays stable.
"""

from typing import Any, Dict, Optional, Tuple

from core.state import get_vehicle_status, is_vehicle_connected, reset_telemetry
from core import config

# Last successful connect profile, captured so the Phase 6 reset flow can
# reconnect to the SAME transport after an autopilot reboot.
last_connection: Dict[str, Any] = {}


def connect_vehicle(body: Dict[str, Any]) -> Tuple[bool, Dict[str, Any], Optional[int]]:
    """Start the pymavlink transport and wait for the first heartbeat.

    Mirrors vehicle.service.ts connectVehicle(): returns success only when a
    HEARTBEAT is received within the connect window (HTTP 200 on success,
    503 otherwise).
    """
    connection_type = body.get("connectionType")

    from mavlink.connection_manager import manager

    print(f"[VEHICLE] connectVehicle called: type={connection_type}")

    host = body.get("host") or ""
    port = body.get("port") or 0
    device = body.get("device") or ""
    baud = body.get("baudRate") or 57600

    # Surface the in-flight connect to the UI immediately (QGC shows
    # "Connecting to flight controller..." while the transport handshake runs).
    from core.state import vehicle_state
    from sio import server as sio_server

    vehicle_state["connectionState"] = "connecting"
    sio_server.broadcast_connection_state("CONNECTING")
    sio_server.broadcast_vehicle_status()

    ok, message = manager.start(
        connection_type,
        host=host,
        port=port,
        device=device,
        baud=baud,
    )

    if ok:
        global last_connection
        last_connection = {
            "connection_type": connection_type,
            "host": host,
            "port": int(port or 0),
            "device": device,
            "baud": int(baud or 0),
        }
        print("[VEHICLE] connect succeeded — HEARTBEAT received")
        return True, {"success": True, "connected": True, "message": message}, None
    # Connect failed: the heartbeat never arrived, so nothing flipped the state.
    vehicle_state["connectionState"] = "disconnected"
    vehicle_state["disconnectReason"] = "connection timeout — no HEARTBEAT received"
    sio_server.broadcast_connection_state("DISCONNECTED", vehicle_state["disconnectReason"])
    sio_server.broadcast_vehicle_status()
    print(f"[VEHICLE] connect failed — {message}")
    return False, {"success": False, "connected": False, "message": message}, None


def disconnect_vehicle() -> Dict[str, Any]:
    from mavlink.connection_manager import manager
    from mavlink import telemetry_manager

    print("[VEHICLE] Disconnecting vehicle")
    manager.stop(manual=True)
    reset_telemetry()
    telemetry_manager.reset_home_position()
    return {"success": True, "connected": False, "message": "Vehicle disconnected."}


def require_connected_or_none() -> Optional[Dict[str, Any]]:
    """Replicates the arm/disarm/mode '400 not connected' guard from vehicle.controller."""
    if not is_vehicle_connected():
        from core.state import vehicle_state

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
        return {"success": False, "message": "Vehicle is not connected.", "reason": reason}
    return None
