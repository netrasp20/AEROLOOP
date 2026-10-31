"""REST handlers for /api/parameters (Phase 2).

Routes (all under /api/parameters):

  GET    /                      merged live+metadata view (+ optional ?q=)
  GET    /status                synchronization + connection + metadata status
  GET    /metadata              metadata provider status + catalog groups
  GET    /{param_id}            one merged parameter
  GET    /{param_id}/metadata   official definition for one parameter
  POST   /refresh               force a fresh full download (session unchanged)
  POST   /{param_id}/read       individual read (blocking, verified)
  POST   /{param_id}/write      individual write (verified from vehicle echo)

Errors use the project's `success` envelope plus a stable machine-readable
`error.code` (Phase 2 spec section 55).
"""

from typing import Any, Dict, Optional

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from services import parameter_service as ps
from services.parameter_file import ParameterFileError, parameter_file_service
from services.parameter_presets import parameter_preset_service
from services.parameter_reset import (
    CODE_NOT_CONNECTED,
    CODE_RESET_ACTIVE,
    parameter_reset_manager,
)
from services.parameter_service import _BadRequest
from services.write_transaction import write_transaction_manager
from sio import parameter_events as pe

router = APIRouter()


def _json(payload: Dict[str, Any], status: int = 200) -> JSONResponse:
    return JSONResponse(payload, status_code=status)


def _ok(data: Dict[str, Any]) -> JSONResponse:
    return _json(data)


def _fail(code: str, message: str, status: int, extra: Optional[Dict[str, Any]] = None):
    payload: Dict[str, Any] = {"success": False, "error": {"code": code, "message": message}}
    if extra:
        payload.update(extra)
    return _json(payload, status)


def _error_payload(error: Dict[str, Any], fallback_status: int) -> JSONResponse:
    code = (error or {}).get("code") or "ERROR"
    message = (error or {}).get("message") or "Request failed."
    if code == "BAD_REQUEST":
        return _fail(code, message, 400)
    if code == "NOT_CONNECTED":
        return _fail(code, message, 400)
    if code == "PARAM_NOT_FOUND":
        return _fail(code, message, 404)
    if code in ("WRITE_INVALID", "WRITE_REJECTED", "WRITE_MISMATCH"):
        return _fail(code, message, 400)
    if code == "TIMEOUT":
        return _fail(code, message, 504)
    return _fail(code, message, fallback_status)


@router.get("")
def list_parameters(q: Optional[str] = None):
    return _ok(ps.parameter_service.get_all(query=q))


@router.get("/status")
def parameter_status():
    return _ok(ps.parameter_service.get_sync_status())


@router.get("/metadata")
def parameter_metadata_status():
    return _ok(ps.parameter_service.get_metadata_status())


@router.post("/refresh")
def refresh_parameters():
    result = ps.parameter_service.refresh_parameters()
    if not result.get("success"):
        return _error_payload(result.get("error", {}), 500)
    return _ok(result)


# ---------------------------------------------------------------------------
# Phase 6 — parameter files / presets / reset
# NOTE: these static routes MUST stay registered before the ``/{param_id}``
# dynamic route below (GET /export would otherwise resolve as param_id).
# ---------------------------------------------------------------------------

def _file_error(payload: Dict[str, Any], status: int = 400) -> JSONResponse:
    code = (payload.get("error") or {}).get("code") or "ERROR"
    message = (payload.get("error") or {}).get("message") or "Request failed."
    return _fail(code, message, status)


@router.get("/export")
def export_parameters(source: str = "vehicle"):
    """Serialized authoritative live set as a ``.param`` file."""
    pe.events_bridge.emit_file_save_start({"source": source})
    try:
        result = parameter_file_service.export_params(source=source)
    except ParameterFileError as err:
        pe.events_bridge.emit_file_save_error({"code": err.code, "message": err.message})
        return _fail(err.code, err.message, 400)
    if not result.get("success"):
        pe.events_bridge.emit_file_save_error(result.get("error", {}))
        return _file_error(result)
    pe.events_bridge.emit_file_save_complete({
        "success": True, "filename": result["filename"],
        "count": result["count"], "source": source,
    })
    return _ok(result)


@router.post("/import")
def import_parameters(body: Optional[Dict[str, Any]] = None):
    """Parse + validate + review a parameter file against the live vehicle."""
    body = body or {}
    content = body.get("content")
    filename = body.get("filename") or "params.param"
    if content is None:
        return _fail("BAD_REQUEST", 'Body requires a "content" string.', 400)
    pe.events_bridge.emit_file_load_start({"filename": filename})
    try:
        result = parameter_file_service.analyze(content, filename)
    except ParameterFileError as err:
        pe.events_bridge.emit_file_load_error({"code": err.code, "message": err.message})
        return _fail(err.code, err.message, 400)
    if not result.get("success"):
        pe.events_bridge.emit_file_load_error(result.get("error", {}))
        return _file_error(result, 400)
    pe.events_bridge.emit_file_load_complete({
        "success": True, "filename": filename,
        "parse": result["parse"], "counts": result["compare"]["counts"],
    })
    return _ok(result)


@router.post("/compare")
def compare_parameters(body: Optional[Dict[str, Any]] = None):
    """Compare a parameter file (or preset text) against the live vehicle,
    honoring the client's staged map so file-vs-staged conflicts are visible."""
    body = body or {}
    content = body.get("content")
    filename = body.get("filename") or "params.param"
    staged = body.get("staged")
    if content is None:
        return _fail("BAD_REQUEST", 'Body requires a "content" string.', 400)
    if staged is not None and not isinstance(staged, dict):
        return _fail("BAD_REQUEST", '"staged" must be an object.', 400)
    pe.events_bridge.emit_compare_start({"filename": filename})
    try:
        result = parameter_file_service.analyze(content, filename,
                                                staged=staged)
    except ParameterFileError as err:
        pe.events_bridge.emit_compare_error({"code": err.code, "message": err.message})
        return _fail(err.code, err.message, 400)
    if not result.get("success"):
        pe.events_bridge.emit_compare_error(result.get("error", {}))
        return _file_error(result, 400)
    pe.events_bridge.emit_compare_complete({
        "success": True, "filename": filename,
        "compare": result["compare"],
    })
    return _ok(result)


@router.get("/presets")
def list_presets():
    from core.state import get_vehicle_status

    vehicle_type = (get_vehicle_status() or {}).get("vehicleType")
    return _ok(parameter_preset_service.list_presets(vehicle_type))


@router.post("/presets/{preset_id}/analyze")
def preset_analyze(preset_id: str = "", body: Optional[Dict[str, Any]] = None):
    if not preset_id:
        return _fail("BAD_REQUEST", "presetId is required.", 400)
    body = body or {}
    staged = body.get("staged")
    if staged is not None and not isinstance(staged, dict):
        return _fail("BAD_REQUEST", '"staged" must be an object.', 400)
    try:
        result = parameter_preset_service.analyze(preset_id, staged=staged)
    except ParameterFileError as err:
        return _fail(err.code, err.message, 400)
    if not result.get("success"):
        return _file_error(result, 400)
    return _ok(result)


@router.get("/reset/status")
def reset_status():
    return _ok(parameter_reset_manager.status())


@router.post("/reset")
def reset_parameters(body: Optional[Dict[str, Any]] = None):
    """Begin the reset factory-default flow: backup -> reset (MAV_CMD_
    PREFLIGHT_STORAGE p1=2) -> reboot (246) -> reconnect -> re-sync -> verify.

    Runs on the reset worker thread; progress arrives on
    ``parameter:reset:*`` Socket.IO events. ``confirm`` MUST be true.
    """
    body = body or {}
    if write_transaction_manager.is_active():
        return _fail(
            "WRITE_IN_PROGRESS",
            "A parameter write is in progress. Wait for it to finish.",
            423,
        )
    result = parameter_reset_manager.start(confirm=bool(body.get("confirm")))
    if not result.get("success"):
        code = (result.get("error") or {}).get("code")
        if code == CODE_NOT_CONNECTED:
            return _fail(code, "Not connected to the flight controller.", 400)
        if code == CODE_RESET_ACTIVE:
            return _json(result, 423)
        return _fail(code or "BAD_REQUEST", result.get("error", {}).get("message", "Reset failed."), 400)
    return _ok(result)


@router.get("/{param_id}/metadata")
def param_metadata(param_id: str = ""):
    if not param_id:
        return _fail("BAD_REQUEST", "paramId is required.", 400)
    result = ps.parameter_service.get_metadata(param_id)
    if not result.get("success"):
        return _error_payload(result.get("error", {}), 404)
    return _ok(result)


@router.get("/{param_id}")
def get_parameter_detail(param_id: str = ""):
    if not param_id:
        return _fail("BAD_REQUEST", "paramId is required.", 400)
    result = ps.parameter_service.get_one(param_id)
    if not result.get("success"):
        return _error_payload(result.get("error", {}), 404)
    return _ok(result)


@router.post("/{param_id}/read")
def read_parameter(param_id: str = ""):
    if not param_id:
        return _fail("BAD_REQUEST", "paramId is required.", 400)
    result = ps.parameter_service.read_parameter(param_id)
    if not result.get("success"):
        return _error_payload(result.get("error", {}), 500)
    return _ok(result)


@router.post("/{param_id}/write")
def write_parameter(body: Optional[Dict[str, Any]] = None, param_id: str = ""):
    if not param_id:
        return _fail("BAD_REQUEST", "paramId is required.", 400)
    if write_transaction_manager.is_active():
        return _fail(
            "WRITE_IN_PROGRESS",
            "A batch parameter write is already in progress. "
            "Wait for it to finish before writing individually.",
            423,
            extra={"activeTransactionId":
                   (write_transaction_manager.active_transaction()
                    or {}).get("transactionId")},
        )
    value = (body or {}).get("value", ...)
    if value is ...:
        return _fail("BAD_REQUEST", 'Request body requires a "value".', 400)
    try:
        result = ps.parameter_service.write_parameter(param_id, value)
    except _BadRequest as err:
        return _fail("BAD_REQUEST", str(err), 400)
    if not result.get("success"):
        return _error_payload(result.get("error", {}), 500)
    return _ok(result)


@router.get("/write/status")
def batch_write_status():
    """Current/tail of the last write transaction (Phase 5 spec 121)."""
    active = write_transaction_manager.active_transaction()
    last = write_transaction_manager.last_transaction()
    return _ok({
        "success": True,
        "hasActive": active is not None,
        "active": active,
        "last": last,
    })


@router.post("/write")
def batch_write(body: Optional[Dict[str, Any]] = None):
    """Sequential, verified batch write (Phase 5 write-transaction).

    Body: ``{items: [{paramId, value, originalValue}], acknowledged?: [...],
    transactionId?: string}``. A ``transactionId`` that is present but does
    not match any previously started transaction is rejected (stale event
    guard) so a stale client cannot replay a write.
    """
    items = (body or {}).get("items") or []
    if not isinstance(items, list):
        return _fail("BAD_REQUEST", 'Body requires an "items" array.', 400)
    acknowledged = (body or {}).get("acknowledged") or []
    if not isinstance(acknowledged, list):
        return _fail("BAD_REQUEST", '"acknowledged" must be an array.', 400)

    transaction_id = (body or {}).get("transactionId")
    if transaction_id:
        txn = write_transaction_manager.active_transaction()
        if txn is None or txn.get("transactionId") != transaction_id:
            return _fail(
                "SESSION_CHANGED",
                "This write request is stale: no active transaction matches "
                "the supplied transactionId.",
                400,
            )

    result = write_transaction_manager.start_batch(items, acknowledged)
    if not result.get("success"):
        if result.get("conflicts"):
            return _json(result, 409)
        error = result.get("error", {})
        if error.get("code") == "WRITE_IN_PROGRESS":
            return _json(result, 423)
        if error.get("code") == "CONFLICT":
            return _json(result, 409)
        if error.get("items"):
            return _json(result, 400)
        return _json(result, 400)
    return _ok(result)