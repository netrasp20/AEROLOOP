"""Fence API endpoints for ArduCopter.

Provides upload, download, and clear operations for fence geometry.
Also handles FENCE_STATUS telemetry subscription.
"""

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(tags=["fence"])


class FencePoint(BaseModel):
    lat: float
    lng: float
    command: int = 5001  # MAV_CMD_NAV_FENCE_POLYGON_VERTEX_INCLUSION
    param1: float = 0
    param2: float = 0


class FenceUploadRequest(BaseModel):
    points: List[FencePoint]


class FenceUploadResponse(BaseModel):
    success: bool
    points: int = 0
    message: str = ""


class FenceDownloadResponse(BaseModel):
    success: bool
    points: List[Dict[str, Any]] = []
    count: int = 0
    message: str = ""


class FenceClearResponse(BaseModel):
    success: bool
    message: str = ""


class FenceVerifyResponse(BaseModel):
    success: bool
    count: int = 0
    points: List[Dict[str, Any]] = []
    message: str = ""


def _check_connected() -> None:
    from core.state import is_vehicle_connected
    if not is_vehicle_connected():
        raise HTTPException(status_code=400, detail="Vehicle not connected.")


@router.post("/upload")
def upload_fence(body: FenceUploadRequest) -> FenceUploadResponse:
    """Upload fence geometry to the vehicle."""
    _check_connected()
    from services.fence_service import upload_fence
    try:
        points_data = [pt.model_dump() for pt in body.points]
        result = upload_fence(points_data)
        return FenceUploadResponse(
            success=True,
            points=result.get("count", 0),
            message="Fence uploaded successfully.",
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/download")
def download_fence() -> FenceDownloadResponse:
    """Download fence geometry from the vehicle."""
    _check_connected()
    from services.fence_service import download_fence
    try:
        result = download_fence()
        return FenceDownloadResponse(
            success=True,
            points=result.get("points", []),
            count=result.get("count", 0),
            message=f"Downloaded {result.get('count', 0)} fence points.",
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/clear")
def clear_fence() -> FenceClearResponse:
    """Clear all fence points from the vehicle."""
    _check_connected()
    from services.fence_service import clear_fence
    try:
        result = clear_fence()
        return FenceClearResponse(
            success=True,
            message="Fence cleared from vehicle.",
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/verify")
def verify_fence(body: FenceUploadRequest) -> FenceVerifyResponse:
    """Upload fence geometry and download it back to verify the round-trip."""
    _check_connected()
    from services.fence_service import verify_fence
    try:
        points_data = [pt.model_dump() for pt in body.points]
        result = verify_fence(points_data)
        return FenceVerifyResponse(
            success=True,
            count=result.get("count", 0),
            points=result.get("points", []),
            message=f"Verified {result.get('count', 0)} fence points.",
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
