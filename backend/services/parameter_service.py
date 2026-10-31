"""Parameter service (Phase 2).

The REST API and the Socket.IO parameter events both consume this single
service layer. It:

  * is the ONLY entry point from web-facing code into Phase 1's
    ParameterManager (which remains the sole MAVLink authority),
  * merges live PARAM_VALUE state with official ArduPilot metadata,
  * keeps the semantic results (ParameterError instances) of Phase 1 intact
    and adds stable error codes on top,
  * is fully synchronous (MAVLink requests are blocking with a timeout, as in
    Phase 1), which keeps the API handlers dumb and testable.

Connection/synchronization semantics come straight from Phase 1; this layer
NEVER invents state and NEVER performs its own MAVLink I/O.
"""

import time
from typing import Any, Dict, List, Optional

from mavlink import parameter_manager as pm
from services.parameter_metadata import (
    STATUS_AVAILABLE,
    MetadataProvider,
    metadata_provider,
)

# Stable, machine-readable error codes (section 55 of the Phase 2 spec).
# These intentionally extend Phase 1's ParameterError values.
ERROR_NOT_CONNECTED = "NOT_CONNECTED"
ERROR_PARAM_NOT_FOUND = "PARAM_NOT_FOUND"
ERROR_READ_FAILED = "READ_FAILED"
ERROR_WRITE_FAILED = "WRITE_FAILED"
ERROR_WRITE_INVALID = "WRITE_INVALID"
ERROR_TIMEOUT = "TIMEOUT"
ERROR_DOWNLOAD_FAILED = "DOWNLOAD_FAILED"
ERROR_BAD_REQUEST = "BAD_REQUEST"

# Phase 1 result short-names -> stable codes above.
_RESULT_TO_CODE = {
    pm.RESULT_DISCONNECTED: ERROR_NOT_CONNECTED,
    pm.RESULT_TIMEOUT: ERROR_TIMEOUT,
    pm.RESULT_REJECTED: ERROR_WRITE_FAILED,
    pm.RESULT_MISMATCH: ERROR_WRITE_FAILED,
    pm.RESULT_INVALID_VALUE: ERROR_WRITE_INVALID,
    pm.RESULT_INVALID_PARAMETER: ERROR_PARAM_NOT_FOUND,
    pm.RESULT_ERROR: None,  # caller picks read/write-specific fallback
}

# ParameterError codes from Phase 1 (ERROR_MESSAGES keys) -> stable codes.
_CODE_TO_ERROR = {
    "NOT_CONNECTED": ERROR_NOT_CONNECTED,
    "PARAMETER_NOT_FOUND": ERROR_PARAM_NOT_FOUND,
    "PARAMETER_READ_TIMEOUT": ERROR_TIMEOUT,
    "PARAMETER_WRITE_TIMEOUT": ERROR_TIMEOUT,
    "PARAMETER_WRITE_MISMATCH": ERROR_WRITE_FAILED,
    "PARAMETER_DOWNLOAD_TIMEOUT": ERROR_TIMEOUT,
    "PARAMETER_DOWNLOAD_INCOMPLETE": ERROR_DOWNLOAD_FAILED,
    "INVALID_PARAMETER_VALUE": ERROR_WRITE_INVALID,
}

_SYNC_STATE_TO_CONNECTION = {
    pm.STATE_IDLE: "CONNECTING",
    pm.STATE_REQUESTING: "SYNCING",
    pm.STATE_RECEIVING: "SYNCING",
    pm.STATE_COMPLETE: "READY",
    pm.STATE_FAILED: "ERROR",
}


def _err(code: str, message: str, **extra: Any) -> Dict[str, Any]:
    payload = {"error": {"code": code, "message": message}}
    payload.update(extra)
    return payload


class ParameterService:
    """Merges Phase 1 live parameter state with official metadata."""

    def __init__(self, manager: pm.ParameterManager, provider: MetadataProvider,
                 events: Optional["object"] = None) -> None:
        self._manager = manager
        self._provider = provider
        self._events = events  # optional socket bridge, injected

    # ------------------------------------------------------------------
    # Internal state
    # ------------------------------------------------------------------
    def _connection_state(self) -> str:
        if not self._manager.is_connected():
            return "DISCONNECTED"
        sync = self._manager.get_synchronization_state()
        return _SYNC_STATE_TO_CONNECTION.get(sync["state"], "CONNECTING")

    def _metadata_status(self) -> Dict[str, Any]:
        vehicle_type = self._vehicle_type()
        return self._provider.status(vehicle_type)

    def _vehicle_type(self) -> Optional[str]:
        from core.state import get_vehicle_status  # runtime import (lazy)
        try:
            status = get_vehicle_status()
        except Exception:  # pragma: no cover - defensive; state API drift
            return None
        return (status or {}).get("vehicleType") or None

    # ------------------------------------------------------------------
    # Public API (consumed by REST handlers and socket bridge)
    # ------------------------------------------------------------------
    def get_all(self, query: Optional[str] = None) -> Dict[str, Any]:
        """Full merged view. Live values never fall back to metadata."""
        vehicle_type = self._vehicle_type()
        key = self._provider._resolve_key(vehicle_type)
        live = self._manager.get_all_parameters()
        metadata_status = self._metadata_status()

        merged = []
        for entry in live:
            param_id = entry["id"]
            meta = self._provider.lookup(param_id, key) if key else None
            merged.append(self._merge(entry, meta))
        return {
            "success": True,
            "connection": self._connection_state(),
            "sync": self._manager.get_synchronization_state(),
            "metadata": metadata_status,
            "metadataMissing": metadata_status.get("status") != STATUS_AVAILABLE,
            "vehicle": {"vehicleType": vehicle_type},
            "count": len(merged),
            "parameters": self._filter(merged, query),
        }

    def get_one(self, param_id: str) -> Dict[str, Any]:
        self._validate_id(param_id)
        vehicle_type = self._vehicle_type()
        key = self._provider._resolve_key(vehicle_type)
        entry = self._manager.get_parameter(param_id)
        if entry is not None:
            meta = self._provider.lookup(param_id, key) if key else None
            return {
                "success": True,
                "parameter": self._merge(entry, meta),
                "metadataStatus": self._provider.status(vehicle_type).get("status"),
            }
        # No live value AND no authoritative definition -> genuinely unknown.
        meta = self._provider.lookup(param_id, key) if key else None
        if meta is not None:
            return {
                "success": True,
                "parameter": {
                    "id": param_id,
                    "live": None,
                    "metadataMissing": False,
                    "metadataStatus": self._provider.status(vehicle_type).get("status"),
                    "metadata": meta,
                },
            }
        return _err(ERROR_PARAM_NOT_FOUND,
                    f"Parameter '{param_id}' is not known to the connected vehicle "
                    "and has no official definition.")

    def get_metadata(self, param_id: str) -> Dict[str, Any]:
        self._validate_id(param_id)
        vehicle_type = self._vehicle_type()
        key = self._provider._resolve_key(vehicle_type)
        if key is None:
            return _err("METADATA_UNAVAILABLE",
                        "No official metadata for this vehicle type.")
        meta = self._provider.lookup(param_id, key)
        if meta is None:
            return _err(ERROR_PARAM_NOT_FOUND,
                        f"No official definition for '{param_id}'.")
        return {"success": True, "vehicle": vehicle_type,
                "metadata": meta}

    def get_metadata_status(self) -> Dict[str, Any]:
        """Metadata provider status + catalog groups for the connected type."""
        vehicle_type = self._vehicle_type()
        status = self._provider.status(vehicle_type)
        key = self._provider._resolve_key(vehicle_type)
        groups = self._provider.groups(vehicle_type) if key else []
        return {
            "success": True,
            "vehicle": vehicle_type,
            "metadataStatus": status,
            "groups": groups,
        }

    def get_sync_status(self) -> Dict[str, Any]:
        return {
            "success": True,
            "connection": self._connection_state(),
            "sync": self._manager.get_synchronization_state(),
            "sessionId": self._manager.get_session_id(),
            "metadata": self._metadata_status(),
            "vehicle": {"vehicleType": self._vehicle_type()},
        }

    def refresh_parameters(self) -> Dict[str, Any]:
        """Force a fresh full download. Session stays identical."""
        if not self._manager.is_connected():
            return _err(ERROR_NOT_CONNECTED, "Not connected to the flight controller.")
        result = self._manager.refresh_parameters()
        return self._download_result(result)

    def read_parameter(self, param_id: str) -> Dict[str, Any]:
        self._validate_id(param_id)
        if not self._manager.is_connected():
            return _err(ERROR_NOT_CONNECTED, "Not connected to the flight controller.")
        if self._events is not None:
            self._events.emit_read_start(param_id)
        result = self._manager.read_parameter(param_id)
        if self._events is not None:
            self._events.emit_read_result(param_id, result)
        if result.get("status") == pm.RESULT_SUCCESS:
            return {"success": True, "parameter": {
                "id": param_id, "value": result.get("value")}}
        return self._err_from_read(result, param_id)

    def write_parameter(self, param_id: str, value: Any) -> Dict[str, Any]:
        self._validate_id(param_id)
        if not self._manager.is_connected():
            return _err(ERROR_NOT_CONNECTED, "Not connected to the flight controller.")
        if self._events is not None:
            self._events.emit_write_start(param_id, value)
        result = self._manager.set_parameter(param_id, value)
        if self._events is not None:
            self._events.emit_write_result(param_id, value, result)
        if result.get("status") == pm.RESULT_SUCCESS:
            return {"success": True, "parameter": {
                "id": param_id, "value": result.get("value")}}
        return self._err_from_write(result, param_id, value)

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------
    def _download_result(self, result: Dict[str, Any]) -> Dict[str, Any]:
        sync = self._manager.get_synchronization_state()
        if result.get("status") == pm.RESULT_SUCCESS:
            return {"success": True, "sync": sync}
        code = self._map_result(result, ERROR_DOWNLOAD_FAILED)
        message = result.get("message") or "Parameter download failed."
        return _err(code, message, sync=sync)

    def _err_from_read(self, result: Dict[str, Any], param_id: str) -> Dict[str, Any]:
        code = self._map_result(result, ERROR_READ_FAILED)
        message = result.get("message") or f"Failed to read parameter '{param_id}'."
        return _err(code, message)

    def _err_from_write(self, result: Dict[str, Any], param_id: str,
                        value: Any) -> Dict[str, Any]:
        """Richer write classification than the shared read/download mapping:
        WRITE_* codes distinguish reject/mismatch/timeout so the Phase 5 batch
        reporter can say exactly why a parameter was not written."""
        code = result.get("code")
        if code in _CODE_TO_ERROR:
            status_code = _CODE_TO_ERROR[code]
            code = {
                "PARAMETER_WRITE_TIMEOUT": "WRITE_TIMEOUT",
                "PARAMETER_WRITE_MISMATCH": "WRITE_MISMATCH",
            }.get(code, status_code)
        else:
            status = result.get("status")
            code = {
                pm.RESULT_DISCONNECTED: ERROR_NOT_CONNECTED,
                pm.RESULT_TIMEOUT: "WRITE_TIMEOUT",
                pm.RESULT_REJECTED: "WRITE_REJECTED",
                pm.RESULT_MISMATCH: "WRITE_MISMATCH",
                pm.RESULT_INVALID_VALUE: ERROR_WRITE_INVALID,
                pm.RESULT_INVALID_PARAMETER: ERROR_PARAM_NOT_FOUND,
            }.get(status, ERROR_WRITE_FAILED)
        message = result.get("message") or f"Failed to write parameter '{param_id}'."
        return _err(code, message)

    def _map_result(self, result: Dict[str, Any], fallback: str) -> str:
        code = result.get("code")
        if code in _CODE_TO_ERROR:
            return _CODE_TO_ERROR[code]
        mapped = _RESULT_TO_CODE.get(result.get("status"))
        return mapped if mapped else fallback

    @staticmethod
    def _merge(entry: Dict[str, Any], meta: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        return {
            "id": entry.get("id"),
            "live": {k: entry.get(k) for k in (
                "value", "type", "index", "count", "receivedAt", "received",
                "writeState")},
            "metadata": meta,
            "metadataMissing": meta is None,
        }

    @staticmethod
    def _filter(merged: List[Dict[str, Any]], query: Optional[str]) -> List[Dict[str, Any]]:
        if not query:
            return merged
        q = query.strip().lower()
        if not q:
            return merged
        out = []
        for item in merged:
            if q in item["id"].lower():
                out.append(item)
                continue
            meta = item.get("metadata")
            if meta and (q in (meta.get("name") or "").lower()
                         or q in (meta.get("description") or "").lower()):
                out.append(item)
        return out

    @staticmethod
    def _validate_id(param_id: str) -> None:
        if not isinstance(param_id, str) or not param_id.strip():
            raise _BadRequest("paramId must be a non-empty string")

    @staticmethod
    def _epoch() -> float:
        return time.time()


class _BadRequest(Exception):
    pass


# Default singleton wired to the live manager/provider/event bridge.
def _make_service() -> ParameterService:
    from sio import parameter_events as pe  # local import avoids cycles
    return ParameterService(pm.parameter_manager, metadata_provider, pe.events_bridge)


parameter_service = _make_service()