"""FastAPI application (app.ts + server.ts).

Mounts the same routers under the same prefixes as the Node backend, enables CORS
for all origins (app.use(cors())), and attaches the python-socketio ASGI server
(socket.ts) so `vehicleStatus` / `telemetry:update` events reach the frontend.

Served by uvicorn via the top-level `asgi_app` (socketio.ASGIApp wrapping this app).
"""

import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api import mission as mission_api
from api import parameters as parameters_api
from api import schedule as schedule_api
from api import telemetry as telemetry_api
from api import vehicle as vehicle_api
from api import video as video_api
from api import fence as fence_api
from api import ftp as ftp_api
from api import setup as setup_api
from sio import server as sio_server


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Capture the running asyncio loop so the MAVLink reader thread can emit
    # Socket.IO events thread-safely via asyncio.run_coroutine_threadsafe.
    await sio_server.capture_loop()

    # Start the mission schedule timer (checks every 2s for due missions).
    from services.schedule_executor import execute_scheduled_mission
    from services.schedule_service import start_timer, stop_timer
    from sio import server as _sio

    def _emit_schedule(event: str, data):
        _sio.emit(event, data)

    start_timer(execute_fn=execute_scheduled_mission, emit_fn=_emit_schedule)
    print("[APP] Mission schedule timer started")

    # QGC-style serial auto-connect: watch for a plugged Pixhawk USB device and
    # connect automatically without a CONNECT click.
    from mavlink import serial_autodetect

    serial_autodetect.start()

    yield

    serial_autodetect.stop()
    stop_timer()

    # Shutdown cleanup: close the MAVLink link and every live camera/recording
    # (finalizing any in-progress .mp4 files) so a restart starts clean.
    from mavlink.connection_manager import manager
    from services.video_service import video_service

    try:
        manager.stop()
    except Exception:  # noqa: BLE001
        pass

    try:
        stream_ids = list(video_service._streams.keys())
        for stream_id in stream_ids:
            video_service.stop(stream_id)
    except Exception:  # noqa: BLE001
        pass
    print("[APP] Shutdown cleanup complete")


app = FastAPI(
    title="Yantrayug GCS Python Backend",
    version="0.2.0-alpha",
    lifespan=lifespan,
)

# CORS: allow any origin/header/method, matching Express cors() defaults.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(telemetry_api.router, prefix="/api/telemetry", tags=["telemetry"])
app.include_router(vehicle_api.router, prefix="/api/vehicle", tags=["vehicle"])
app.include_router(mission_api.router, prefix="/api/mission", tags=["mission"])
app.include_router(schedule_api.router, prefix="/api/schedule", tags=["schedule"])
app.include_router(video_api.router, prefix="/api/video", tags=["video"])
app.include_router(parameters_api.router, prefix="/api/parameters", tags=["parameters"])
app.include_router(fence_api.router, prefix="/api/fence", tags=["fence"])
app.include_router(ftp_api.router, prefix="/api/ftp", tags=["ftp"])
app.include_router(setup_api.router, prefix="/api/setup", tags=["setup"])


@app.get("/")
def root():
    return {"service": "yantrayug-gcs-backend", "stack": "python", "status": "ok"}


# Socket.IO ASGI application wrapping the FastAPI app (server.ts initializeSocket).
asgi_app = sio_server.init_socket(app)
