"""REST handlers for /api/video (video.routes.ts parity).

Serves MJPEG-over-HTTP streams produced by the bundled FFmpeg binary, exactly
like the retired Node rtspProxy.service. The frontend displays them via <img>
(or falls back to WebRTC when MediaMTX/WHEP is configured).
"""

import os
from pathlib import Path
from typing import Dict, Optional

from fastapi import APIRouter
from fastapi.responses import FileResponse, JSONResponse

from services.video_service import RECORDINGS_DIR, is_valid_stream_url, save_recording_file, video_service

router = APIRouter()


@router.post("/start")
async def start(body: Optional[Dict] = None):
    body = body or {}
    stream_id = body.get("id")
    url = body.get("url")

    if not stream_id or not url:
        return JSONResponse({"success": False, "message": "id and url required"}, status_code=400)

    url = str(url).strip()
    if not is_valid_stream_url(url):
        return JSONResponse({"success": False, "message": "Invalid RTSP URL"}, status_code=400)

    result = await video_service.start(stream_id, url)
    return JSONResponse(result)


@router.post("/stop")
def stop(body: Optional[Dict] = None):
    body = body or {}
    video_service.stop(body.get("id", ""))
    return JSONResponse({"success": True, "message": "Stream stopped"})


@router.get("/stream/{stream_id}")
async def stream(stream_id: str):
    response = await video_service.stream(stream_id)
    if response is None:
        return JSONResponse(
            {"success": False, "message": f'Stream "{stream_id}" not found or not running'},
            status_code=404,
        )
    return response


@router.post("/record/start")
async def record_start(body: Optional[Dict] = None):
    body = body or {}
    stream_id, url = body.get("id"), body.get("url")
    if not stream_id or not url:
        return JSONResponse({"success": False, "message": "id and url required"}, status_code=400)

    ok = await video_service.start_recording(stream_id, str(url))
    return JSONResponse(
        {
            "success": ok,
            "message": f'Recording "{stream_id}" started' if ok else f'Already recording "{stream_id}"',
        }
    )


@router.post("/record/stop")
def record_stop(body: Optional[Dict] = None):
    body = body or {}
    file_path = video_service.stop_recording(body.get("id", ""))
    return JSONResponse(
        {
            "success": bool(file_path),
            "filePath": file_path,
            "message": file_path or f'No active recording for "{body.get("id", "")}"',
        }
    )


@router.get("/record/status")
def record_status():
    return JSONResponse({"success": True, "recordings": video_service.list_recordings()})


@router.get("/record/folders")
def record_folders():
    """Common local save locations for the Save As dialog shortcuts."""
    home = Path.home()
    candidates = {
        "home": home,
        "desktop": home / "Desktop",
        "downloads": home / "Downloads",
        "documents": home / "Documents",
    }
    # Honour XDG overrides where present.
    for var, key in (("XDG_DESKTOP_DIR", "desktop"), ("XDG_DOWNLOAD_DIR", "downloads"), ("XDG_DOCUMENTS_DIR", "documents")):
        env_path = os.environ.get(var)
        if env_path:
            value = Path(env_path).expanduser()
            if "~" in env_path or value.is_dir():
                candidates[key] = value
    folders = {}
    for key, value in candidates.items():
        try:
            if value.is_dir():
                folders[key] = str(value)
        except OSError:
            continue
    return JSONResponse({"success": True, "folders": folders})


@router.get("/record/file/{name}")
def record_file(name: str):
    """Download/play a finalized recording stored in RECORDINGS_DIR."""
    safe = Path(name).name  # basename only — no path traversal
    path = RECORDINGS_DIR / safe
    if not path.is_file() or path.parent != RECORDINGS_DIR:
        return JSONResponse({"success": False, "message": "Recording not found."}, status_code=404)
    return FileResponse(path, media_type="video/mp4", filename=safe)


@router.post("/record/save")
def record_save(body: Optional[Dict] = None):
    """Copy a finalized recording to a user-chosen folder + filename."""
    body = body or {}
    source = str(body.get("source", ""))
    dest_dir = str(body.get("destDir", ""))
    dest_name = str(body.get("destName", ""))
    saved = save_recording_file(source, dest_dir, dest_name)
    if not saved:
        return JSONResponse(
            {"success": False, "message": "Could not save to that location."},
            status_code=400,
        )
    return JSONResponse({"success": True, "path": saved})
