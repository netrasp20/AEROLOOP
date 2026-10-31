"""MAVFTP API — REST endpoints for MAVLink File Transfer Protocol."""
from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter
from pydantic import BaseModel

from services.ftp_service import ftp_service, MavFtpError

router = APIRouter()


def _err(code: str, message: str, status: int = 500) -> Dict[str, Any]:
    return {"success": False, "error": {"code": code, "message": message}}


def _ok(data: Any = None) -> Dict[str, Any]:
    payload: Dict[str, Any] = {"success": True}
    if data is not None:
        payload.update(data)
    return payload


# ---------------------------------------------------------------------------
# List directory
# ---------------------------------------------------------------------------

class ListRequest(BaseModel):
    path: str = "/"


@router.post("/list")
def list_directory(body: ListRequest):
    try:
        entries = ftp_service.list_directory(body.path)
        return _ok({"path": body.path, "entries": entries, "count": len(entries)})
    except MavFtpError as e:
        return _err("FTP_ERROR", str(e), 500)
    except Exception as e:
        return _err("FTP_ERROR", f"FTP list failed: {e}", 500)


# ---------------------------------------------------------------------------
# Read / Download file
# ---------------------------------------------------------------------------

class ReadRequest(BaseModel):
    path: str


@router.post("/read")
def read_file(body: ReadRequest):
    try:
        data = ftp_service.read_file(body.path)
        import base64
        return _ok({
            "path": body.path,
            "size": len(data),
            "data": base64.b64encode(data).decode("ascii"),
        })
    except MavFtpError as e:
        return _err("FTP_ERROR", str(e), 500)
    except Exception as e:
        return _err("FTP_ERROR", f"FTP read failed: {e}", 500)


# ---------------------------------------------------------------------------
# Write / Upload file
# ---------------------------------------------------------------------------

class WriteRequest(BaseModel):
    path: str
    data: str  # base64-encoded


@router.post("/write")
def write_file(body: WriteRequest):
    try:
        import base64
        raw = base64.b64decode(body.data)
        ftp_service.write_file(body.path, raw)
        return _ok({"path": body.path, "size": len(raw)})
    except MavFtpError as e:
        return _err("FTP_ERROR", str(e), 500)
    except Exception as e:
        return _err("FTP_ERROR", f"FTP write failed: {e}", 500)


# ---------------------------------------------------------------------------
# Remove file
# ---------------------------------------------------------------------------

class RemoveRequest(BaseModel):
    path: str


@router.post("/remove")
def remove_file(body: RemoveRequest):
    try:
        ftp_service.remove_file(body.path)
        return _ok({"path": body.path})
    except MavFtpError as e:
        return _err("FTP_ERROR", str(e), 500)
    except Exception as e:
        return _err("FTP_ERROR", f"FTP remove failed: {e}", 500)


# ---------------------------------------------------------------------------
# Create directory
# ---------------------------------------------------------------------------

class MkDirRequest(BaseModel):
    path: str


@router.post("/mkdir")
def create_directory(body: MkDirRequest):
    try:
        ftp_service.create_directory(body.path)
        return _ok({"path": body.path})
    except MavFtpError as e:
        return _err("FTP_ERROR", str(e), 500)
    except Exception as e:
        return _err("FTP_ERROR", f"FTP mkdir failed: {e}", 500)


# ---------------------------------------------------------------------------
# Remove directory
# ---------------------------------------------------------------------------

class RmDirRequest(BaseModel):
    path: str


@router.post("/rmdir")
def remove_directory(body: RmDirRequest):
    try:
        ftp_service.remove_directory(body.path)
        return _ok({"path": body.path})
    except MavFtpError as e:
        return _err("FTP_ERROR", str(e), 500)
    except Exception as e:
        return _err("FTP_ERROR", f"FTP rmdir failed: {e}", 500)


# ---------------------------------------------------------------------------
# Rename
# ---------------------------------------------------------------------------

class RenameRequest(BaseModel):
    old_path: str
    new_path: str


@router.post("/rename")
def rename(body: RenameRequest):
    try:
        ftp_service.rename(body.old_path, body.new_path)
        return _ok({"old_path": body.old_path, "new_path": body.new_path})
    except MavFtpError as e:
        return _err("FTP_ERROR", str(e), 500)
    except Exception as e:
        return _err("FTP_ERROR", f"FTP rename failed: {e}", 500)
