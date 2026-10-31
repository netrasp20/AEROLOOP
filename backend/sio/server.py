"""Python Socket.IO server integrated with the FastAPI app via ASGI.

Mirrors backend/src/socket/socket.ts:
- CORS allows any origin (matching Socket.IO cors: { origin: "*" }).
- On connect, emits `vehicleStatus` to the connecting client.
- Provides thread-safe emit helpers (`emit`, `broadcast_vehicle_status`) so the
  MAVLink reader thread can push `telemetry:update` and `vehicleStatus` events.
"""

import asyncio
from typing import Any, Dict, Optional

import socketio

from fastapi import FastAPI

_sio: Optional[socketio.AsyncServer] = None
_sio_app: Optional[socketio.ASGIApp] = None
_event_loop: Optional[asyncio.AbstractEventLoop] = None


def get_sio() -> Optional[socketio.AsyncServer]:
    return _sio


def get_sio_app() -> Optional[socketio.ASGIApp]:
    return _sio_app


def set_event_loop(loop: asyncio.AbstractEventLoop) -> None:
    global _event_loop
    _event_loop = loop


def vehicle_status_payload() -> Dict[str, Any]:
    from core.state import vehicle_state

    return {
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
        "missionUploaded": vehicle_state["missionUploaded"],
        "missionRunning": vehicle_state["missionRunning"],
        "missionCompleted": vehicle_state["missionCompleted"],
    }


def init_socket(app: FastAPI) -> socketio.ASGIApp:
    """Attach an AsyncServer and return the ASGI app to hand to uvicorn."""
    global _sio, _sio_app

    _sio = socketio.AsyncServer(
        async_mode="asgi",
        cors_allowed_origins="*",
    )

    from sio.mission_handlers import register_mission_handlers

    register_mission_handlers(_sio)

    @_sio.event
    async def connect(sid: str, environ: Dict, auth: Any = None):
        print(f"🟢 Frontend Connected: {sid}")
        await _sio.emit("vehicleStatus", vehicle_status_payload(), to=sid)

    @_sio.event
    async def disconnect(sid: str):
        print(f"🔴 Frontend Disconnected: {sid}")

    _sio_app = socketio.ASGIApp(_sio, other_asgi_app=app)
    return _sio_app


def _emit_nowait(event: str, data: Any, to=None):
    """Thread-safe emit. Called from the MAVLink reader thread.
    AsyncServer.emit() broadcasts by default; `to` targets a specific client."""
    if _sio is None or _event_loop is None:
        return
    kwargs: Dict[str, Any] = {}
    if to is not None:
        kwargs["to"] = to
    try:
        coro = _sio.emit(event, data, **kwargs)
        asyncio.run_coroutine_threadsafe(coro, _event_loop)
    except (RuntimeError, asyncio.CancelledError):
        pass


def emit(event: str, data: Any) -> None:
    """Broadcast an event to all clients."""
    _emit_nowait(event, data)


def emit_to(event: str, data: Any, sid: str) -> None:
    _emit_nowait(event, data, to=sid)


def broadcast_vehicle_status() -> None:
    emit("vehicleStatus", vehicle_status_payload())


def broadcast_connection_state(state: str, reason: Optional[str] = None) -> None:
    """Authoritative MAVLink connection-state event.

    state: "CONNECTED" | "CONNECTING" | "DISCONNECTED"
    """
    payload: Dict[str, Any] = {"state": state}
    if reason:
        payload["reason"] = reason
    emit("connection_state", payload)


async def _sio_wait_and_track_loop():
    """No-op helper reserved for capturing the event loop at startup."""
    global _event_loop
    _event_loop = asyncio.get_running_loop()


async def capture_loop() -> None:
    await _sio_wait_and_track_loop()