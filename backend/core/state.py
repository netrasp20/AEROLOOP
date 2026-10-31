"""In-memory vehicle + telemetry state, mirroring Node src/mavlink/vehicleState.ts
and src/mavlink/telemetry.ts exactly (field names and initial values)."""

from typing import Any, Dict

# ---------------------------------------------------------------
# VehicleState (vehicleState.ts)
# ---------------------------------------------------------------

vehicle_state: Dict[str, Any] = {
    "connected": False,
    "connectionState": "disconnected",
    "disconnectReason": None,
    "lastHeartbeat": 0,
    "systemId": 0,
    "componentId": 0,
    "vehicleType": "UNKNOWN",
    "autopilot": "UNKNOWN",
    "mode": "DISCONNECTED",
    "armed": False,
    "gpsFix": 0,
    "satellites": 0,
    "missionUploaded": False,
    "missionRunning": False,
    "missionCompleted": False,
    "lastArmStatusText": "",
    "serialPortOpen": False,
    "udpConnected": False,
    "missionStartTime": 0,
    "missionPrevLat": 0,
    "missionPrevLon": 0,
    "missionDistanceInitialized": False,
    "missionTotalDistance": 0,
    "missionMaxSpeed": 0,
    "missionWaypointsVisited": 0,
    "missionTotalWaypoints": 0,
    "missionEndTime": 0,
}

# ---------------------------------------------------------------
# TelemetryData (telemetry.ts)
# ---------------------------------------------------------------

telemetry: Dict[str, Any] = {
    "connected": False,
    "systemId": 0,
    "componentId": 0,
    "vehicleType": "UNKNOWN",
    "autopilot": "UNKNOWN",
    "mode": "DISCONNECTED",
    "armed": False,
    "latitude": 0,
    "longitude": 0,
    "altitude": 0,
    "relativeAltitude": 0,
    "homeLatitude": 0,
    "homeLongitude": 0,
    "homeAltitude": 0,
    "groundSpeed": 0,
    "airSpeed": 0,
    "verticalSpeed": 0,
    "heading": 0,
    "roll": 0,
    "pitch": 0,
    "yaw": 0,
    "batteryVoltage": 0,
    "batteryCurrent": 0,
    "batteryRemaining": 0,
    "gpsFix": 0,
    "satellites": 0,
    "hdop": 0,
    "distance": 0,
    "distanceToHome": 0,
    "atHome": False,
    "missionCurrent": 0,
    "missionReached": 0,
    "missionRunning": False,
    "missionCompleted": False,
    "missionTotalDistance": 0,
    "statusText": "",
    "fenceBreachStatus": 0,
    "fenceBreachCount": 0,
    "fenceBreachType": 0,
    "rcChannels": [],
    "rcSignal": "UNKNOWN",
    "rcChannelCount": 0,
    "rcRssi": 0,
    "rcReceivedAt": 0,
    "timestamp": 0,
}

# Connection-type label (mirrors getVehicleStatus: SERIAL/TCP/UDP/NONE)
_tcp_connected = False


def set_tcp_connected(value: bool) -> None:
    global _tcp_connected
    _tcp_connected = value


def is_tcp_connected() -> bool:
    return _tcp_connected


def reset_mission_stats() -> None:
    """Mirrors resetMissionStats(); keeps missionTotalWaypoints intentionally."""
    for key in (
        "missionStartTime",
        "missionPrevLat",
        "missionPrevLon",
        "missionDistanceInitialized",
        "missionTotalDistance",
        "missionMaxSpeed",
        "missionWaypointsVisited",
        "missionEndTime",
    ):
        vehicle_state[key] = 0 if isinstance(vehicle_state[key], (int, float)) else False


def is_vehicle_connected() -> bool:
    """Mirrors isVehicleConnected()."""
    transport_ready = (
        vehicle_state["serialPortOpen"]
        or vehicle_state["udpConnected"]
        or is_tcp_connected()
    )
    if not transport_ready:
        return False
    if vehicle_state["lastHeartbeat"] == 0:
        return False
    import time

    if (time.time() * 1000 - vehicle_state["lastHeartbeat"]) > 10000:
        return False
    return True


# ---------------------------------------------------------------
# Public snapshot helpers (vehicle.service.ts / telemetry.service.ts)
# ---------------------------------------------------------------

def get_vehicle_status() -> Dict[str, Any]:
    from core.config import CONNECTION_TIMEOUT_MS  # noqa: F401 (kept for parity docs)

    if vehicle_state["serialPortOpen"]:
        connection_type = "SERIAL"
    elif is_tcp_connected():
        connection_type = "TCP"
    elif vehicle_state["udpConnected"]:
        connection_type = "UDP"
    else:
        connection_type = "NONE"

    return {
        "success": True,
        "connected": vehicle_state["connected"],
        "connectionState": vehicle_state["connectionState"],
        "disconnectReason": vehicle_state.get("disconnectReason"),
        "armed": vehicle_state["armed"],
        "mode": vehicle_state["mode"],
        "systemId": vehicle_state["systemId"],
        "componentId": vehicle_state["componentId"],
        "vehicleType": vehicle_state["vehicleType"],
        "autopilot": vehicle_state["autopilot"],
        "gpsFix": vehicle_state["gpsFix"],
        "satellites": vehicle_state["satellites"],
        "lastHeartbeat": vehicle_state["lastHeartbeat"],
        "connectionType": connection_type,
    }


def get_telemetry_data() -> Dict[str, Any]:
    return dict(telemetry)


def reset_telemetry() -> None:
    """Mirrors resetTelemetry(): keep field names, zero them (except identity/UNKNOWN)."""
    telemetry["connected"] = False
    telemetry["systemId"] = 0
    telemetry["componentId"] = 0
    telemetry["vehicleType"] = "UNKNOWN"
    telemetry["autopilot"] = "UNKNOWN"
    telemetry["mode"] = "DISCONNECTED"
    telemetry["armed"] = False
    telemetry["latitude"] = 0
    telemetry["longitude"] = 0
    telemetry["altitude"] = 0
    telemetry["relativeAltitude"] = 0
    telemetry["homeLatitude"] = 0
    telemetry["homeLongitude"] = 0
    telemetry["homeAltitude"] = 0
    telemetry["groundSpeed"] = 0
    telemetry["airSpeed"] = 0
    telemetry["verticalSpeed"] = 0
    telemetry["heading"] = 0
    telemetry["roll"] = 0
    telemetry["pitch"] = 0
    telemetry["yaw"] = 0
    telemetry["rcChannels"] = []
    telemetry["rcChannelCount"] = 0
    telemetry["rcRssi"] = 0
    telemetry["rcReceivedAt"] = 0
    telemetry["rcSignal"] = "NO_SIGNAL"
    telemetry["batteryVoltage"] = 0
    telemetry["batteryCurrent"] = 0
    telemetry["batteryRemaining"] = 0
    telemetry["gpsFix"] = 0
    telemetry["satellites"] = 0
    telemetry["hdop"] = 0
    telemetry["distance"] = 0
    telemetry["distanceToHome"] = 0
    telemetry["atHome"] = False
    telemetry["missionCurrent"] = 0
    telemetry["missionReached"] = 0
    telemetry["missionRunning"] = False
    telemetry["missionCompleted"] = False
    telemetry["missionTotalDistance"] = 0
    telemetry["statusText"] = ""
    telemetry["timestamp"] = 0