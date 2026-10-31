"""Sequential, verified batch parameter writes (Phase 5).

This layer is the ONLY place a "Write Params" batch may be created. It keeps a
single-writer invariant over the Phase 1 ParameterManager (never a second
MAVLink connection/reader) and turns a frontend snapshot of staged changes
into a deterministic, sequentially verified write queue:

    pre-flight (ALL items, none written yet)
        -> conflict detection (current live vs the original baseline)
        -> explicit acknowledgement for conflicts
        -> sequential PARAM_SET via the existing single-write authority
        -> stop on first failure; remaining items stay NOT written
        -> disconnect/session change aborts instantly, never writing across
           a session boundary

Every success is derived from the vehicle's PARAM_VALUE echo (Phase 1
``set_parameter`` already enforces: verify param_id + value, bounded timeout
/retry, read-only double-echo detection). This layer therefore NEVER marks an
item written merely because a PARAM_SET was transmitted.

Semantics that tests and the frontend rely on:

  * pre-flight errors  -> HTTP 400, ``error.code`` + per-item ``items[]``,
                          zero PARAM_SET sent.
  * conflicts          -> HTTP 409, ``conflicts[]`` with current/original/
                          staged; zero PARAM_SET sent until acknowledged.
  * execution finish   -> HTTP 200 transaction summary. ``status`` is
                          ``success`` (all), ``partial_failure`` (one+
                          failed, later items not attempted), or
                          ``interrupted`` (disconnect/session change).
"""

import threading
import time
import uuid
from typing import Any, Dict, List, Optional

from mavlink import parameter_manager as pm
from services.parameter_metadata import metadata_provider

# Transaction states.
TXN_PENDING = "pending"
TXN_RUNNING = "running"
TXN_SUCCESS = "success"
TXN_PARTIAL = "partial_failure"
TXN_INTERRUPTED = "interrupted"
TXN_FAILED = "failed"

# Item states.
ITEM_SUCCESS = "success"
ITEM_FAILED = "failed"
ITEM_NOT_ATTEMPTED = "not_attempted"

# Stable error codes (Phase 5 spec section 21).
CODE_NOT_CONNECTED = "NOT_CONNECTED"
CODE_DISCONNECTED = "DISCONNECTED"
CODE_PARAM_NOT_FOUND = "PARAM_NOT_FOUND"
CODE_READ_ONLY = "READ_ONLY"
CODE_WRITE_IN_PROGRESS = "WRITE_IN_PROGRESS"
CODE_OUT_OF_RANGE = "OUT_OF_RANGE"
CODE_INVALID_INCREMENT = "INVALID_INCREMENT"
CODE_INVALID_ENUM = "INVALID_ENUM"
CODE_INVALID_BITMASK = "INVALID_BITMASK"
CODE_INVALID_VALUE = "INVALID_VALUE"
CODE_SESSION_CHANGED = "SESSION_CHANGED"
CODE_CONFLICT = "CONFLICT"
CODE_BAD_REQUEST = "BAD_REQUEST"

_EPSILON = 1e-6


def _num(value: Any) -> Optional[float]:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
        return number if number == number else None
    return None


def _is_multiple(base: float, step: float, candidate: float) -> bool:
    if step <= 0:
        return True
    quotient = (candidate - base) / step
    return abs(quotient - round(quotient)) < _EPSILON


def validate_against_metadata(meta: Optional[Dict[str, Any]],
                              value: float,
                              param_type: int) -> Optional[tuple]:
    """Server-side value validation mirroring Phase 4 's frontend rules.

    Returns ``None`` when valid, else ``(code, message)`` matching the Phase 5
    error vocabulary. Parameters without official metadata are NOT rejected
    here — Phase 1's ``normalize_value`` already enforces type/width bounds so
    a metadata-less parameter can be written safely when its live type is
    available (a clear INVALID_VALUE is raised if it cannot be represented).
    """
    if meta is None:
        return None

    if meta.get("readOnly"):
        return (CODE_READ_ONLY, "Parameter is read-only on the vehicle.")

    # Integer type rule (mirror frontend "NOT_INTEGER").
    if pm.is_integer_type(param_type) and not _is_integer(value):
        return (CODE_INVALID_VALUE, "Value must be an integer.")

    rng_min = meta.get("min")
    rng_max = meta.get("max")
    if rng_min is not None and value < rng_min:
        bound = (f"between {rng_min} and {rng_max}"
                 if rng_max is not None else f"at least {rng_min}")
        return (CODE_OUT_OF_RANGE, f"Value must be {bound}.")
    if rng_max is not None and value > rng_max:
        bound = (f"between {rng_min} and {rng_max}"
                 if rng_min is not None else f"at most {rng_max}")
        return (CODE_OUT_OF_RANGE, f"Value must be {bound}.")

    increment = meta.get("increment")
    if (increment not in (None, 0) and rng_min is not None
            and not _is_multiple(float(rng_min), float(increment), value)):
        return (CODE_INVALID_INCREMENT,
                f"Value must be a multiple of the increment {increment} "
                f"(from {rng_min}).")

    values = meta.get("values")
    if values:
        allowed = {float(code) for code in values.keys()}
        if not any(abs(code - value) < _EPSILON for code in allowed):
            return (CODE_INVALID_ENUM,
                    "Value is not one of the allowed options.")

    if meta.get("bitmask") and value < 0:
        return (CODE_INVALID_BITMASK, "Bitmask value cannot be negative.")

    return None


def _is_integer(value: float) -> bool:
    return abs(value - round(value)) < _EPSILON


class WriteTransaction:
    """One sequential write batch. Immutable request snapshot; mutable result."""

    __slots__ = (
        "transactionId", "sessionId", "startedAt", "completedAt",
        "items", "status", "interruptedReason",
    )

    def __init__(self, transaction_id: str, session_id: str,
                 items: List[Dict[str, Any]]) -> None:
        self.transactionId = transaction_id
        self.sessionId = session_id
        self.startedAt = time.time()
        self.items = items  # [{paramId, requestedValue, originalValue}]
        self.completedAt: Optional[float] = None
        self.status = TXN_PENDING
        self.interruptedReason: Optional[str] = None

    # ------------------------------------------------------------------
    def snapshot(self, include_results: bool = True) -> Dict[str, Any]:
        succeeded = sum(1 for i in self.items if i["status"] == ITEM_SUCCESS)
        failed = sum(1 for i in self.items if i["status"] == ITEM_FAILED)
        not_attempted = sum(
            1 for i in self.items if i["status"] == ITEM_NOT_ATTEMPTED)
        return {
            "transactionId": self.transactionId,
            "sessionId": self.sessionId,
            "status": self.status,
            "interruptedReason": self.interruptedReason,
            "total": len(self.items),
            "succeeded": succeeded,
            "failed": failed,
            "notAttempted": not_attempted,
            "startedAt": self.startedAt,
            "completedAt": self.completedAt,
            "results": [self._item_snapshot(i) for i in self.items]
            if include_results else None,
        }

    @staticmethod
    def _item_snapshot(item: Dict[str, Any]) -> Dict[str, Any]:
        out = {
            "paramId": item["paramId"],
            "requestedValue": item["requestedValue"],
            "originalValue": item["originalValue"],
            "status": item["status"],
        }
        if item.get("verifiedValue") is not None:
            out["verifiedValue"] = item["verifiedValue"]
        if item.get("code"):
            out["code"] = item["code"]
        if item.get("message"):
            out["message"] = item["message"]
        return out


class WriteTransactionManager:
    """Single-writer authority for parameter batch writes.

    No MAVLink connection/reader is created here: every item is delegated to
    the existing ParameterManager via the parameter service.
    """

    def __init__(self, service: Any, events: Optional[Any] = None) -> None:
        self._service = service
        self._events = events
        self._manager = service._manager
        self._lock = threading.Lock()
        self._active: Optional[WriteTransaction] = None
        self._last: Optional[WriteTransaction] = None

    # ------------------------------------------------------------------
    # Status queries
    # ------------------------------------------------------------------
    def is_active(self) -> bool:
        return self._active is not None

    def active_transaction(self) -> Optional[Dict[str, Any]]:
        txn = self._active
        return txn.snapshot(include_results=False) if txn else None

    def last_transaction(self) -> Optional[Dict[str, Any]]:
        txn = self._last
        return txn.snapshot() if txn else None

    # ------------------------------------------------------------------
    # Batch write
    # ------------------------------------------------------------------
    def start_batch(self,
                    items: List[Dict[str, Any]],
                    acknowledged: Optional[List[str]] = None) -> Dict[str, Any]:
        """Run a sequential verified write batch.

        ``items`` is the frontend snapshot: ``{paramId, value, originalValue}``.
        ``acknowledged`` lists conflicted paramIds the user explicitly chose to
        write anyway.
        """
        if not items:
            return self._bad_request("At least one parameter is required.")

        acknowledged = set(acknowledged or [])

        # ---- single-writer guard (duplicate batch rejection) ----------
        with self._lock:
            if self._active is not None:
                return self._error(
                    CODE_WRITE_IN_PROGRESS, "A parameter write is already in progress.",
                    extra={"activeTransactionId": self._active.transactionId},
                )
            txn_id = uuid.uuid4().hex[:12]

        if not self._manager.is_connected():
            return self._error(CODE_NOT_CONNECTED,
                               "Not connected to the flight controller.")

        session_id = self._manager.get_session_id()
        if not session_id:
            return self._error(CODE_NOT_CONNECTED, "No active parameter session.")

        # ---- pre-flight (before ANY PARAM_SET) ------------------------
        prepared = self._preflight(items, acknowledged, session_id)

        conflicts = [i for i in prepared if i.get("conflict")]
        rejected = [i for i in prepared if not i.get("ok")]
        if conflicts and not acknowledged.intersection(
                {c["paramId"] for c in conflicts}):
            return {
                "success": False,
                "error": {
                    "code": CODE_CONFLICT,
                    "message": ("Some parameters changed on the vehicle after "
                                "your edits were staged. Review before writing."),
                },
                "conflicts": [{
                    "paramId": c["paramId"],
                    "currentValue": c["currentValue"],
                    "originalValue": c["originalValue"],
                    "stagedValue": c["requestedValue"],
                } for c in conflicts],
            }
        if rejected:
            return {
                "success": False,
                "error": {
                    "code": rejected[0]["code"],
                    "message": "Some parameters failed pre-flight validation.",
                },
                "items": [{
                    "paramId": r["paramId"],
                    "code": r["code"],
                    "message": r["message"],
                } for r in rejected],
            }

        txn = WriteTransaction(txn_id, session_id, prepared)
        with self._lock:
            if self._active is not None:  # re-check under the lock
                return self._error(CODE_WRITE_IN_PROGRESS,
                                   "A parameter write is already in progress.")
            self._active = txn

        self._emit_batch_start(txn)
        try:
            self._execute(txn)
        finally:
            with self._lock:
                self._active = None
            self._last = txn

        self._emit_batch_complete(txn)
        return {"success": True, "transaction": txn.snapshot()}

    # ------------------------------------------------------------------
    # Pre-flight
    # ------------------------------------------------------------------
    def _preflight(self, items: List[Dict[str, Any]], acknowledged: set,
                   session_id: str) -> List[Dict[str, Any]]:
        prepared: List[Dict[str, Any]] = []
        vehicle_key = self._vehicle_key()
        for item in items:
            param_id = str(item.get("paramId") or "").strip()
            value = _num(item.get("value"))
            original = _num(item.get("originalValue"))
            if not param_id:
                prepared.append({
                    "paramId": param_id, "requestedValue": value,
                    "originalValue": original, "status": ITEM_NOT_ATTEMPTED,
                    "ok": False, "code": CODE_BAD_REQUEST,
                    "message": "paramId must be a non-empty string."})
                continue
            if value is None:
                prepared.append({
                    "paramId": param_id, "requestedValue": value,
                    "originalValue": original, "status": ITEM_NOT_ATTEMPTED,
                    "ok": False, "code": CODE_INVALID_VALUE,
                    "message": "Value must be a real number."})
                continue

            live = self._manager.get_parameter(param_id)
            if live is None:
                prepared.append({
                    "paramId": param_id, "requestedValue": value,
                    "originalValue": original, "status": ITEM_NOT_ATTEMPTED,
                    "ok": False, "code": CODE_PARAM_NOT_FOUND,
                    "message": f"Parameter '{param_id}' is not known to the "
                               "connected vehicle."})
                continue

            param_type = live["type"]
            try:
                normalized = pm.normalize_value(value, param_type)
            except pm.ParameterError as err:
                prepared.append({
                    "paramId": param_id, "requestedValue": value,
                    "originalValue": original, "status": ITEM_NOT_ATTEMPTED,
                    "ok": False, "code": CODE_INVALID_VALUE,
                    "message": err.message or "Invalid value for this type."})
                continue

            meta = None
            if vehicle_key:
                meta = metadata_provider.lookup(param_id, vehicle_key)
            validation = validate_against_metadata(meta, normalized, param_type)
            if validation is not None:
                code, message = validation
                prepared.append({
                    "paramId": param_id, "requestedValue": value,
                    "originalValue": original, "status": ITEM_NOT_ATTEMPTED,
                    "ok": False, "code": code, "message": message})
                continue

            rel = self._manager._config["float_rel_tol"]
            abs_ = self._manager._config["float_abs_tol"]
            live_value = float(live["value"])
            original_norm = (float(original) if original is not None
                             else live_value)
            drifted = not pm.values_match(live_value, original_norm,
                                          param_type, rel, abs_)
            already_satisfied = pm.values_match(live_value, normalized,
                                                param_type, rel, abs_)

            prepared.append({
                "paramId": param_id,
                "requestedValue": value,
                "normalizedValue": normalized,
                "originalValue": original_norm,
                "currentValue": live_value,
                "status": ITEM_NOT_ATTEMPTED,
                "ok": True,
                "conflict": bool(drifted and not already_satisfied),
            })
        return prepared

    # ------------------------------------------------------------------
    # Execution (sequential, verified)
    # ------------------------------------------------------------------
    def _execute(self, txn: WriteTransaction) -> None:
        txn.status = TXN_RUNNING
        completed = 0
        total = len(txn.items)

        for item in txn.items:
            if not self._session_still_valid(txn):
                remainder = " ".join(
                    sorted({i["paramId"] for i in txn.items[completed:]}))
                reason = self._interruption_reason()
                txn.interruptedReason = reason
                self._mark_remaining_not_attempted(txn, completed, reason)
                txn.status = TXN_INTERRUPTED
                break

            result = self._service.write_parameter(
                item["paramId"], item["requestedValue"])
            completed += 1

            if result.get("success"):
                item["status"] = ITEM_SUCCESS
                item["verifiedValue"] = result.get("parameter", {}).get("value")
                item["code"] = None
                item["message"] = None
            else:
                error = result.get("error", {})
                item["status"] = ITEM_FAILED
                item["code"] = error.get("code") or "WRITE_FAILED"
                item["message"] = (error.get("message")
                                   or f"Write failed for '{item['paramId']}'.")
                # Stop at the first failure; later items remain NOT written
                # (identical to the documented partial-failure contract).
                self._mark_remaining_not_attempted(txn, completed,
                                                   "previous write failed")
                txn.status = TXN_PARTIAL
                break

            self._emit_batch_item(txn, item)
            self._emit_batch_progress(txn, completed, total,
                                      item["paramId"])

        if txn.status == TXN_RUNNING:
            txn.status = TXN_SUCCESS
        txn.completedAt = time.time()

    def _session_still_valid(self, txn: WriteTransaction) -> bool:
        return (self._manager.is_connected()
                and self._manager.get_session_id() == txn.sessionId)

    def _interruption_reason(self) -> str:
        if not self._manager.is_connected():
            return CODE_DISCONNECTED
        return CODE_SESSION_CHANGED

    def _mark_remaining_not_attempted(self, txn: WriteTransaction,
                                      completed: int,
                                      reason: str) -> None:
        for item in txn.items[completed:]:
            if item["status"] in (ITEM_SUCCESS, ITEM_FAILED):
                continue
            item["status"] = ITEM_NOT_ATTEMPTED
            item["code"] = txn.interruptedReason or reason
            item["message"] = "Not written."

    # ------------------------------------------------------------------
    # Events
    # ------------------------------------------------------------------
    def _emit_batch_start(self, txn: WriteTransaction) -> None:
        if self._events is not None:
            self._events.emit_batch_write_start(txn.snapshot(include_results=False))

    def _emit_batch_progress(self, txn: WriteTransaction, completed: int,
                             total: int, current_param_id: str) -> None:
        if self._events is not None:
            self._events.emit_batch_write_progress({
                "transactionId": txn.transactionId,
                "total": total,
                "completed": completed,
                "currentParamId": current_param_id,
            })

    def _emit_batch_item(self, txn: WriteTransaction, item: Dict[str, Any]) -> None:
        if self._events is not None:
            self._events.emit_batch_write_item({
                "transactionId": txn.transactionId,
                "paramId": item["paramId"],
                "requestedValue": item["requestedValue"],
                "status": item["status"],
                "verifiedValue": item.get("verifiedValue"),
                "code": item.get("code"),
                "message": item.get("message"),
            })

    def _emit_batch_complete(self, txn: WriteTransaction) -> None:
        if self._events is not None:
            summary = txn.snapshot()
            self._events.emit_batch_write_complete(summary)

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------
    def _vehicle_key(self) -> Optional[str]:
        try:
            from core.state import get_vehicle_status
            vehicle_type = (get_vehicle_status() or {}).get("vehicleType")
        except Exception:  # pragma: no cover - defensive
            vehicle_type = None
        return metadata_provider._resolve_key(vehicle_type)

    def _bad_request(self, message: str) -> Dict[str, Any]:
        return self._error(CODE_BAD_REQUEST, message)

    def _error(self, code: str, message: str,
               extra: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        payload = {"success": False,
                   "error": {"code": code, "message": message}}
        if extra:
            payload.update(extra)
        return payload


def _make_write_transaction():
    from services.parameter_service import parameter_service
    from sio import parameter_events as pe

    return WriteTransactionManager(parameter_service, pe.events_bridge)


write_transaction_manager = _make_write_transaction()