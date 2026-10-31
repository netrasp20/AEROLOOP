"""Parameter Socket.IO event bridge (Phase 2).

Subscribes to ParameterManager observer notifications and translates them into
Socket.IO events for frontend clients, matching the event-naming convention of
the existing mission/telemetry handlers (``mission:start:success`` etc.):

  parameter:session          — connect/disconnect lifecycle {connection, sessionId}
  parameter:sync:start       — a full synchronization began (PARAM_REQUEST_LIST)
  parameter:sync:progress    — throttled progress {receivedCount, expectedCount}
  parameter:sync:complete    — synchronization finished {status, counts, missing}
  parameter:sync:error       — download failed {code, message}
  parameter:updated          — a parameter's authoritative value changed (only
                               outside an active synchronization, to avoid
                               flooding the client with 1000+ events a second)
  parameter:read:success     — individual read succeeded (service-triggered)
  parameter:read:error       — individual read failed  (service-triggered)
  parameter:write:start      — individual write began   (service-triggered)
  parameter:write:success    — write verified from the vehicle echo
  parameter:write:error      — write failed/rejected/mismatched
  parameter:metadata:status  — metadata availability for the connected vehicle
  parameter:batch-write:start     — a Write Params transaction began
  parameter:batch-write:progress  — one item written and verified {completed, total}
  parameter:batch-write:item     — a single item's verified outcome
  parameter:batch-write:complete — transaction finished {status, counts, results}

Every emit is wrapped so observer code can never break MAVLink handling.
"""

import time
from typing import Any, Callable, Dict, Optional

from mavlink import parameter_manager as pm
from sio import server as sio_server

PROGRESS_CHUNK = 100  # one progress event per N parameters, not per packet


class ParameterEventsBridge:
    """Manager-notification -> Socket.IO translation with progress coalescing."""

    def __init__(self, emit_fn: Optional[Callable[[str, Any], None]] = None) -> None:
        self._emit_fn = emit_fn or sio_server.emit
        self.bind(pm.parameter_manager)
        self.reset()

    def bind(self, manager: pm.ParameterManager) -> None:
        self._manager = manager
        self._manager.set_event_listener(self._on_manager_event)

    def reset(self) -> None:
        self._syncing = False
        self._session_id: Optional[str] = None
        self._last_progress_at = 0
        self._last_values: Dict[str, float] = {}

    # ------------------------------------------------------------------
    # Manager observer
    # ------------------------------------------------------------------
    def _on_manager_event(self, name: str, payload: Dict[str, Any]) -> None:
        try:
            handler = getattr(self, f"_on_{name.replace(':', '_')}", None)
            if handler is not None:
                handler(payload)
        except Exception as err:  # noqa: BLE001
            print(f"[PARAM_SIO] handler error on {name}: {err}")

    def _on_session_start(self, payload: Dict[str, Any]) -> None:
        self.reset()
        self._session_id = payload.get("sessionId")
        self._emit("parameter:session", {
            "connection": "connected",
            "sessionId": self._session_id,
            "startedAt": payload.get("startedAt"),
        })

    def _on_session_stop(self, payload: Dict[str, Any]) -> None:
        self._emit("parameter:session", {
            "connection": "disconnected",
            "sessionId": None,
            "reason": payload.get("reason"),
        })
        self.reset()

    def _on_download_start(self, payload: Dict[str, Any]) -> None:
        self._syncing = True
        self._last_progress_at = 0
        self._emit("parameter:sync:start", {
            "sessionId": self._session_id,
            "startedAt": payload.get("startedAt"),
            "expectedCount": payload.get("expectedCount", 0),
        })

    def _on_download_param(self, payload: Dict[str, Any]) -> None:
        # index+1 = params seen so far (approx; index is informational).
        # count = the total the vehicle reports. Chunk to avoid flooding.
        received = (payload.get("index") or 0) + 1
        if received - self._last_progress_at >= PROGRESS_CHUNK:
            self._last_progress_at = received
            self._emit("parameter:sync:progress", {
                "sessionId": self._session_id,
                "receivedCount": received,
                "expectedCount": payload.get("count", 0),
            })

    def _on_download_complete(self, payload: Dict[str, Any]) -> None:
        status = payload.get("status")
        self._syncing = False
        self._emit("parameter:sync:progress", {
            "sessionId": self._session_id,
            "receivedCount": payload.get("receivedCount", 0),
            "expectedCount": payload.get("expectedCount", 0),
        })
        if status == pm.RESULT_SUCCESS:
            self._emit("parameter:sync:complete", {
                "sessionId": self._session_id,
                "status": "complete",
                "complete": not payload.get("missing"),
                "receivedCount": payload.get("receivedCount", 0),
                "expectedCount": payload.get("expectedCount", 0),
                "missing": payload.get("missing", []),
                "completedAt": payload.get("completedAt"),
            })
            self._emit_metadata_status()
            return
        # Timeout / disconnect / any failure -> sync:error.
        self._emit("parameter:sync:error", {
            "sessionId": self._session_id,
            "code": self._status_to_error_code(status),
            "message": "Parameter synchronization failed.",
            "status": status,
            "missing": payload.get("missing", []),
        })

    def _emit_metadata_status(self) -> None:
        self.emit_metadata_status()

    def _on_param_received(self, payload: Dict[str, Any]) -> None:
        if self._syncing:
            return  # values are broadcast via sync:progress instead
        param_id = payload.get("id")
        value = payload.get("value")
        last = self._last_values.get(param_id)
        if last is not None and last == value:
            return
        self._last_values[param_id] = value
        self._emit("parameter:updated", {
            "sessionId": self._session_id,
            "id": param_id,
            "value": value,
            "type": payload.get("type"),
            "receivedAt": payload.get("receivedAt"),
        })

    # ------------------------------------------------------------------
    # Service-triggered (read/write) events
    # ------------------------------------------------------------------
    def emit_read_start(self, param_id: str) -> None:
        self._emit("parameter:read:start", {"id": param_id})

    def emit_read_result(self, param_id: str, result: Dict[str, Any]) -> None:
        if result.get("status") == pm.RESULT_SUCCESS:
            self._emit("parameter:read:success", {
                "id": param_id,
                "value": result.get("value"),
            })
        else:
            self._emit("parameter:read:error", {
                "id": param_id,
                "code": self._result_to_error_code(result),
                "message": result.get("message"),
            })

    def emit_write_start(self, param_id: str, value: Any) -> None:
        self._emit("parameter:write:start", {"id": param_id, "value": value})

    def emit_write_result(self, param_id: str, value: Any, result: Dict[str, Any]) -> None:
        if result.get("status") == pm.RESULT_SUCCESS:
            self._emit("parameter:write:success", {
                "id": param_id,
                "value": result.get("value"),
            })
        else:
            self._emit("parameter:write:error", {
                "id": param_id,
                "value": value,
                "code": self._result_to_error_code(result),
                "message": result.get("message"),
            })

    def emit_metadata_status(self, status: Optional[Dict[str, Any]] = None) -> None:
        if status is None:
            status = self._metadata_status()
        self._emit("parameter:metadata:status", status)

    # ------------------------------------------------------------------
    # Write-transaction (batch) events (Phase 5)
    # ------------------------------------------------------------------
    def emit_batch_write_start(self, summary: Dict[str, Any]) -> None:
        self._emit("parameter:batch-write:start", summary)

    def emit_batch_write_progress(self, progress: Dict[str, Any]) -> None:
        self._emit("parameter:batch-write:progress", progress)

    def emit_batch_write_item(self, item: Dict[str, Any]) -> None:
        self._emit("parameter:batch-write:item", item)

    def emit_batch_write_complete(self, summary: Dict[str, Any]) -> None:
        self._emit("parameter:batch-write:complete", summary)

    # ------------------------------------------------------------------
    # File / compare / preset events (Phase 6)
    # ------------------------------------------------------------------
    def emit_file_load_start(self, detail: Dict[str, Any]) -> None:
        self._emit("parameter:file:load:start", detail)

    def emit_file_load_complete(self, result: Dict[str, Any]) -> None:
        self._emit("parameter:file:load:complete", result)

    def emit_file_load_error(self, detail: Dict[str, Any]) -> None:
        self._emit("parameter:file:load:error", detail)

    def emit_compare_start(self, detail: Dict[str, Any]) -> None:
        self._emit("parameter:compare:start", detail)

    def emit_compare_complete(self, result: Dict[str, Any]) -> None:
        self._emit("parameter:compare:complete", result)

    def emit_compare_error(self, detail: Dict[str, Any]) -> None:
        self._emit("parameter:compare:error", detail)

    def emit_file_save_start(self, detail: Dict[str, Any]) -> None:
        self._emit("parameter:file:save:start", detail)

    def emit_file_save_complete(self, result: Dict[str, Any]) -> None:
        self._emit("parameter:file:save:complete", result)

    def emit_file_save_error(self, detail: Dict[str, Any]) -> None:
        self._emit("parameter:file:save:error", detail)

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------
    @staticmethod
    def _status_to_error_code(status: Optional[str]) -> str:
        if status == pm.RESULT_TIMEOUT:
            return "TIMEOUT"
        if status == pm.RESULT_DISCONNECTED:
            return "NOT_CONNECTED"
        return "DOWNLOAD_FAILED"

    @staticmethod
    def _result_to_error_code(result: Dict[str, Any]) -> str:
        code = result.get("code")
        if code == "NOT_CONNECTED":
            return "NOT_CONNECTED"
        if code == "PARAMETER_NOT_FOUND":
            return "PARAM_NOT_FOUND"
        if code in ("PARAMETER_READ_TIMEOUT", "PARAMETER_WRITE_TIMEOUT"):
            return "TIMEOUT"
        status = result.get("status")
        if status == pm.RESULT_REJECTED:
            return "WRITE_REJECTED"
        if status == pm.RESULT_MISMATCH:
            return "WRITE_MISMATCH"
        if status == pm.RESULT_INVALID_VALUE:
            return "WRITE_INVALID"
        if status == pm.RESULT_INVALID_PARAMETER:
            return "PARAM_NOT_FOUND"
        return "ERROR"

    def _metadata_status(self) -> Dict[str, Any]:
        from services.parameter_metadata import metadata_provider, STATUS_UNAVAILABLE

        try:
            from core.state import get_vehicle_status

            vehicle_type = (get_vehicle_status() or {}).get("vehicleType")
        except Exception:  # pragma: no cover - defensive
            vehicle_type = None
        status = metadata_provider.status(vehicle_type)
        return status

    def _emit(self, event: str, payload: Dict[str, Any]) -> None:
        try:
            self._emit_fn(event, payload)
        except Exception as err:  # noqa: BLE001
            print(f"[PARAM_SIO] emit failed for {event}: {err}")


events_bridge = ParameterEventsBridge()