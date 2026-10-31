"""MAVLink Parameter Manager (Phase 1 — backend foundation).

Implements the real MAVLink parameter protocol against ArduPilot (documented
in https://mavlink.io/en/services/parameter.html and
https://ardupilot.org/dev/docs/mavlink-get-set-params.html):

    PARAM_REQUEST_LIST  -> vehicle streams PARAM_VALUE for every parameter
    PARAM_REQUEST_READ  -> request one parameter (by name, or index fallback)
    PARAM_SET           -> write one parameter; vehicle echoes PARAM_VALUE
    PARAM_VALUE         -> authoritative vehicle response (read + write)

Design rules that must never regress:

  * The flight controller is the source of truth. The live cache is built ONLY
    from PARAM_VALUE messages. Nothing is guessed or fabricated.
  * `param_id` is the stable identity. `param_index` / `param_count` are
    synchronization metadata only — ArduPilot hides/exposes parameters when
    subsystems are enabled, which changes both count and indexes.
  * A PARAM_SET is NOT "done" because it was sent. It is done only when the
    vehicle's PARAM_VALUE confirms it (new value echoed), or is rejected
    (read-only parameters echo the new value then immediately echo the
    original value), or mismatched/timed out.
  * All blocking waits are bounded; retries are bounded; nothing leaks across
    disconnect/reconnect. Nothing in this module ever runs MAVLink sends
    directly — it requests them via an injectable sender so pymavlink stays
    single-threaded on the central reader (see mission_command.py / enqueue).
"""

import math
import struct
import threading
import time
import uuid
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional

# ---------------------------------------------------------------------------
# Numeric msgids (common.xml)
# ---------------------------------------------------------------------------
MSGID_PARAM_VALUE = 22
MSGID_PARAM_REQUEST_LIST = 21
MSGID_PARAM_REQUEST_READ = 20
MSGID_PARAM_SET = 23

# ---------------------------------------------------------------------------
# MAV_PARAM_TYPE (common.xml) — the only ones ArduPilot supports are
# INT8 / INT16 / INT32 / REAL32.
# ---------------------------------------------------------------------------
MAV_PARAM_TYPE_UINT8 = 1
MAV_PARAM_TYPE_INT8 = 2
MAV_PARAM_TYPE_UINT16 = 3
MAV_PARAM_TYPE_INT16 = 4
MAV_PARAM_TYPE_UINT32 = 5
MAV_PARAM_TYPE_INT32 = 6
MAV_PARAM_TYPE_UINT64 = 7
MAV_PARAM_TYPE_INT64 = 8
MAV_PARAM_TYPE_REAL32 = 9
MAV_PARAM_TYPE_REAL64 = 10

_INTEGER_TYPES = {
    MAV_PARAM_TYPE_UINT8, MAV_PARAM_TYPE_INT8,
    MAV_PARAM_TYPE_UINT16, MAV_PARAM_TYPE_INT16,
    MAV_PARAM_TYPE_UINT32, MAV_PARAM_TYPE_INT32,
    MAV_PARAM_TYPE_UINT64, MAV_PARAM_TYPE_INT64,
}
_FLOAT_TYPES = {MAV_PARAM_TYPE_REAL32, MAV_PARAM_TYPE_REAL64}

# Integer type bounds (protocol/type validation — NOT metadata driven).
_INT_BOUNDS: Dict[int, tuple] = {
    MAV_PARAM_TYPE_UINT8: (0, 255),
    MAV_PARAM_TYPE_INT8: (-128, 127),
    MAV_PARAM_TYPE_UINT16: (0, 65535),
    MAV_PARAM_TYPE_INT16: (-32768, 32767),
    MAV_PARAM_TYPE_UINT32: (0, 4294967295),
    MAV_PARAM_TYPE_INT32: (-2147483648, 2147483647),
    MAV_PARAM_TYPE_UINT64: (0, 18446744073709551615),
    MAV_PARAM_TYPE_INT64: (-9223372036854775808, 9223372036854775807),
}

# ---------------------------------------------------------------------------
# Configurable timing/retry constants (no magic numbers scattered in code).
# All overridable via the ``config`` constructor argument for fast tests.
# ---------------------------------------------------------------------------
DEFAULT_CONFIG: Dict[str, float] = {
    "download_start_timeout_s": 10.0,     # first PARAM_VALUE after request
    "download_quiet_s": 1.5,              # inactivity before declaring done/gap-fill
    "download_missing_retries": 2,        # gap-fill passes for missing indexes
    "download_missing_retry_delay_s": 0.5,
    "read_timeout_s": 3.0,
    "read_retries": 2,                    # additional attempts after the first
    "write_timeout_s": 3.0,
    "write_retries": 2,                   # additional attempts after the first
    "write_echo_grace_s": 0.5,            # wait for a possible 2nd (reversal) echo
    "float_rel_tol": 1e-6,
    "float_abs_tol": 1e-7,
}

# ---------------------------------------------------------------------------
# Download + operation states (lowercase, matching repo conventions)
# ---------------------------------------------------------------------------
STATE_IDLE = "idle"
STATE_REQUESTING = "requesting"
STATE_RECEIVING = "receiving"
STATE_COMPLETE = "complete"
STATE_FAILED = "failed"
STATE_CANCELLED = "cancelled"

# Read/write result codes
RESULT_SUCCESS = "success"
RESULT_TIMEOUT = "timeout"
RESULT_MISMATCH = "mismatch"
RESULT_REJECTED = "rejected"
RESULT_DISCONNECTED = "disconnected"
RESULT_INVALID_PARAMETER = "invalid_parameter"
RESULT_INVALID_VALUE = "invalid_value"
RESULT_ERROR = "error"

# Explicit, useful error message codes (mapping to a human string).
ERROR_MESSAGES: Dict[str, str] = {
    "NOT_CONNECTED": "Not connected to a flight controller.",
    "PARAMETER_NOT_FOUND": "Parameter not found in the downloaded parameter set.",
    "INVALID_PARAMETER_VALUE": "Invalid value for this parameter type.",
    "PARAMETER_READ_TIMEOUT": "Vehicle did not respond to the read request.",
    "PARAMETER_WRITE_TIMEOUT": "Vehicle did not respond to the write request.",
    "PARAMETER_WRITE_MISMATCH": "Vehicle returned a value that did not match the write.",
    "PARAMETER_DOWNLOAD_TIMEOUT": "Vehicle did not send any parameters.",
    "PARAMETER_DOWNLOAD_INCOMPLETE": "Parameter download finished with missing parameters.",
    "MAVLINK_SEND_FAILED": "Unable to send the MAVLink message.",
    "INVALID_PARAM_TYPE": "Unsupported MAVLink parameter type.",
    "DOWNLOAD_ALREADY_ACTIVE": "A parameter download is already in progress.",
}


class ParameterError(Exception):
    """Error carrying a stable machine-readable code."""

    def __init__(self, code: str, message: Optional[str] = None) -> None:
        super().__init__(message or ERROR_MESSAGES.get(code, code))
        self.code = code
        self.message = message or ERROR_MESSAGES.get(code, code)


# ---------------------------------------------------------------------------
# Sending
# ---------------------------------------------------------------------------

# sender(kind, fields) — kind is one of:
#   "param_request_list" {target_system, target_component}
#   "param_request_read" {target_system, target_component, param_id, param_index}
#   "param_set"          {target_system, target_component, param_id,
#                         param_value, param_type}


def _default_sender(kind: str, fields: Dict[str, Any]) -> None:
    """Default sender: route through the central MAVLink send queue.

    pymavlink is not thread-safe, so we enqueue onto the existing reader
    thread (mirrors mission_command.py). No second transport is created.
    """
    from mavlink.connection_manager import manager as conn_manager

    conn = conn_manager.connection
    if conn is None:
        raise ParameterError("MAVLINK_SEND_FAILED")

    sys_id = fields["target_system"]
    comp_id = fields["target_component"]

    def _do_send() -> None:
        if kind == "param_request_list":
            conn.mav.param_request_list_send(sys_id, comp_id)
        elif kind == "param_request_read":
            # pymavlink 2.4.43 packs MAVLink char[16] fields from bytes (str
            # raises a TypeError), and the gap-fill path sends an empty name.
            param_id = fields.get("param_id", "").encode("utf-8")
            conn.mav.param_request_read_send(
                sys_id, comp_id, param_id, int(fields["param_index"])
            )
        elif kind == "param_set":
            param_id = fields.get("param_id", "").encode("utf-8")
            conn.mav.param_set_send(
                sys_id,
                comp_id,
                param_id,
                float(fields["param_value"]),
                int(fields["param_type"]),
            )
        else:  # pragma: no cover - defensive
            raise ValueError(f"Unknown param send kind: {kind}")

    conn_manager.enqueue(_do_send)


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------


@dataclass
class ParameterState:
    """Live state for one parameter. `id` (param_id) is the ONLY identity.

    Metadata (description/units/enums...) is deliberately NOT part of this
    record — it is a separate concern merged in a later phase, keyed by `id`.
    """

    id: str
    value: float
    type: int
    index: int
    count: int
    receivedAt: float
    received: bool = True
    writeState: Optional[str] = None  # internal, for future UI reporting

    def to_snapshot(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "value": self.value,
            "type": self.type,
            "index": self.index,
            "count": self.count,
            "receivedAt": self.receivedAt,
            "received": self.received,
            "writeState": self.writeState,
        }


class _ReadOp:
    __slots__ = ("id", "done", "value", "result", "error")

    def __init__(self, param_id: str) -> None:
        self.id = param_id
        self.done = False
        self.value: Optional[float] = None
        self.result: Optional[str] = None
        self.error: Optional[ParameterError] = None


class _WriteOp:
    __slots__ = ("id", "done", "echoes", "result", "error")

    def __init__(self, param_id: str) -> None:
        self.id = param_id
        self.done = False
        self.echoes: List[tuple] = []  # (value, type, receivedAt)
        self.result: Optional[str] = None
        self.error: Optional[ParameterError] = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def is_integer_type(param_type: int) -> bool:
    return param_type in _INTEGER_TYPES


def is_float_type(param_type: int) -> bool:
    return param_type in _FLOAT_TYPES


def _decode_param_id(raw: Any) -> str:
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", errors="replace")
    if raw is None:
        return ""
    text = str(raw)
    return text.split("\x00", 1)[0].strip()


def _as_float32(value: float) -> float:
    """Round-trip through IEEE-754 float32 so REAL32 comparisons reflect the
    precision the vehicle actually stores."""
    return struct.unpack("<f", struct.pack("<f", float(value)))[0]


def values_match(actual: float, wanted: float, param_type: int,
                 rel_tol: float, abs_tol: float) -> bool:
    """Compare with semantics appropriate to the parameter's MAVLink type.

    Integer parameters compare exactly (integer representation). REAL32
    parameters round-trip through float32 and use tolerance so we never emit
    false mismatches from float transport noise.
    """
    if is_integer_type(param_type):
        return int(round(float(actual))) == int(round(float(wanted)))
    if is_float_type(param_type):
        if param_type == MAV_PARAM_TYPE_REAL32:
            actual = _as_float32(float(actual))
            wanted = _as_float32(float(wanted))
            return math.isclose(actual, wanted, rel_tol=rel_tol, abs_tol=abs_tol)
        return math.isclose(float(actual), float(wanted), rel_tol=rel_tol, abs_tol=abs_tol)
    # Unknown type — fall back to exact float equality on round-tripped value.
    return float(actual) == float(wanted)


def normalize_value(value: Any, param_type: int) -> float:
    """Validate/normalize a user-supplied value for the given MAVLink type.

    Rejects NaN / Infinity / non-numeric. Integer types are quantized to the
    integer representation and checked against their signedness/width bounds
    (protocol-level validation — metadata min/max belongs to a later phase).
    """
    if isinstance(value, bool):
        raise ParameterError("INVALID_PARAMETER_VALUE")
    if not isinstance(value, (int, float)):
        raise ParameterError("INVALID_PARAMETER_VALUE")
    number = float(value)
    if math.isnan(number) or math.isinf(number):
        raise ParameterError("INVALID_PARAMETER_VALUE")

    if is_integer_type(param_type):
        rounded = int(round(number))
        lo, hi = _INT_BOUNDS[param_type]
        if rounded < lo or rounded > hi:
            msg = (
                f"Value {rounded} out of range for MAV_PARAM_TYPE_{param_type} "
                f"[{lo}, {hi}]"
            )
            err = ParameterError("INVALID_PARAMETER_VALUE", msg)
            raise err
        return float(rounded)
    if is_float_type(param_type):
        return number
    raise ParameterError("INVALID_PARAM_TYPE")


def _parse_param_value(msg: Any) -> Optional[Dict[str, Any]]:
    """Extract the fields we need from a PARAM_VALUE message (or None)."""
    if getattr(msg, "get_msgId", lambda: None)() != MSGID_PARAM_VALUE:
        return None
    param_id = _decode_param_id(getattr(msg, "param_id", ""))
    if not param_id:
        return None
    return {
        "id": param_id,
        "value": float(getattr(msg, "param_value", 0.0)),
        "type": int(getattr(msg, "param_type", 0)),
        "count": int(getattr(msg, "param_count", 0)),
        "index": int(getattr(msg, "param_index", 0)),
        "receivedAt": time.time(),
    }


# ---------------------------------------------------------------------------
# Manager
# ---------------------------------------------------------------------------


class ParameterManager:
    """Single backend authority for the live ArduPilot parameter set.

    Threading model: one RLock guards all mutable state; a Condition built on
    it (``self._cond``) lets the reader-thread message handler wake up blocking
    download/read/write operations. Operations that wait never hold the lock
    while sleeping.
    """

    def __init__(self, sender: Optional[Callable[[str, Dict[str, Any]], None]] = None,
                 config: Optional[Dict[str, Any]] = None) -> None:
        self._sender = sender or _default_sender
        self._config = dict(DEFAULT_CONFIG)
        if config:
            self._config.update(config)

        self._lock = threading.RLock()
        self._cond = threading.Condition(self._lock)

        self._cache: Dict[str, ParameterState] = {}
        self._connected = False
        self._session_id: Optional[str] = None
        self._listener: Optional[Callable[[str, Dict[str, Any]], None]] = None

        # Download tracking
        self._download_state = STATE_IDLE
        self._expected_count = 0
        self._seen_indexes: set = set()
        self._received_ids: set = set()
        self._missing_ids: set = set()
        self._download_started_at: Optional[float] = None
        self._download_last_received_at: Optional[float] = None
        self._download_retries = 0
        self._download_active = False
        self._needs_refresh = False

        # Pending operations
        self._read_ops: Dict[str, _ReadOp] = {}
        self._write_op: Optional[_WriteOp] = None

    # ------------------------------------------------------------------
    # Session lifecycle
    # ------------------------------------------------------------------
    def start_session(self) -> None:
        """Associate the manager with a (new) flight-controller session.

        Idempotent. Clears stale state so a different vehicle can never leak
        into the new session. Safe to call on every (re)connect.
        """
        with self._lock:
            self._connected = True
            self._reset_download_tracking()
            self._cache.clear()
            self._read_ops.clear()
            self._write_op = None
            self._download_state = STATE_IDLE
            self._session_id = uuid.uuid4().hex[:12]
            self._cond.notify_all()
        self._notify("session:start", {
            "sessionId": self._session_id,
            "startedAt": time.time(),
        })
        print(f"[PARAM] Session started ({self._session_id}) — parameter cache reset")

    def stop_session(self, reason: str) -> None:
        """Detach from the connection: cancel pending ops, drop state."""
        session_id = self._session_id
        with self._lock:
            self._connected = False
            self._resolve_read_ops(RESULT_DISCONNECTED)
            self._resolve_write_op(RESULT_DISCONNECTED)
            self._download_state = STATE_IDLE
            self._download_active = False
            self._needs_refresh = False
            self._reset_download_tracking()
            self._cache.clear()
            self._session_id = None
            self._cond.notify_all()
        self._notify("session:stop", {"sessionId": session_id, "reason": reason})
        print(f"[PARAM] Session stopped ({reason})")

    def is_connected(self) -> bool:
        with self._lock:
            return self._connected

    # ------------------------------------------------------------------
    # Message ingestion (called from the central reader thread)
    # ------------------------------------------------------------------
    def handle_param_value(self, msg: Any) -> None:
        """Consume one PARAM_VALUE message. Idempotent and non-blocking.

        Registers/adopts the parameter by `param_id`, updates the live cache,
        refreshes synchronization metadata (count/index) and wakes any pending
        read/write/download. A duplicate PARAM_VALUE simply updates the same
        record — it can never create a second entry.
        """
        parsed = _parse_param_value(msg)
        if parsed is None:
            return
        with self._lock:
            if not self._connected:
                return
            self._upsert(parsed)

            # Track synchronization metadata (id-based identity; indexes/count
            # are informational only).
            self._received_ids.add(parsed["id"])
            self._seen_indexes.add(parsed["index"])
            self._download_last_received_at = parsed["receivedAt"]
            if parsed["count"] > self._expected_count:
                if self._expected_count > 0 and parsed["count"] != self._expected_count:
                    self._needs_refresh = True
                    print(
                        f"[PARAM] parameter count changed {self._expected_count} -> "
                        f"{parsed['count']} (new parameters may have been exposed)"
                    )
                self._expected_count = parsed["count"]

            # Wake read/write/download waiters — everyone filters by param_id,
            # so unrelated PARAM_VALUE can never resolve the wrong operation.
            self._resolve_read_op(parsed)
            self._record_write_echo(parsed)
            self._cond.notify_all()

        # Observer notifications (Phase 2 socket sync). `param:received` fires
        # for every authoritative vehicle value; `download:param` additionally
        # marks a value as part of an active synchronization so the consumer
        # can drive progress. Both are additive and must never throw.
        self._notify("param:received", dict(parsed))
        if self._download_active:
            self._notify("download:param", dict(parsed))

    def _upsert(self, parsed: Dict[str, Any]) -> None:
        existing = self._cache.get(parsed["id"])
        if existing is None:
            self._cache[parsed["id"]] = ParameterState(
                id=parsed["id"],
                value=parsed["value"],
                type=parsed["type"],
                index=parsed["index"],
                count=parsed["count"],
                receivedAt=parsed["receivedAt"],
                received=True,
            )
        else:
            existing.value = parsed["value"]
            existing.type = parsed["type"]
            existing.index = parsed["index"]
            existing.count = parsed["count"]
            existing.receivedAt = parsed["receivedAt"]
            existing.received = True

    def _resolve_read_op(self, parsed: Dict[str, Any]) -> None:
        """Complete a pending read whose param_id matches this PARAM_VALUE.

        Correlation is by param_id only — a PARAM_VALUE for any other
        parameter can never resolve a read it wasn't asked for.
        """
        op = self._read_ops.get(parsed["id"])
        if op is not None and not op.done:
            op.value = parsed["value"]
            op.result = RESULT_SUCCESS
            op.done = True

    def _record_write_echo(self, parsed: Dict[str, Any]) -> None:
        """Append a PARAM_VALUE for the pending write's param_id.

        The first echo resolves the wait; later echoes (the read-only
        "new then original" reversal) keep accumulating during the writer's
        grace period so _evaluate_write_echo sees the full sequence.
        """
        op = self._write_op
        if op is not None and op.id == parsed["id"]:
            op.echoes.append((parsed["value"], parsed["type"], parsed["receivedAt"]))
            if not op.done:
                op.done = True

    # ------------------------------------------------------------------
    # Download (PARAM_REQUEST_LIST)
    # ------------------------------------------------------------------
    def request_all_parameters(self) -> Dict[str, Any]:
        """Request the complete parameter list and block until the download
        completes (COMPLETE / FAILED / CANCELLED / DISCONNECTED).

        Completion is decided from PARAM_VALUE metadata: expected count +
        received indexes, inactivity quiet period, and bounded gap-fill
        re-requests of missing indexes via PARAM_REQUEST_READ. This NEVER
        assumes the set is complete just because messages stopped briefly.
        """
        with self._lock:
            if not self._connected:
                return self._result(RESULT_DISCONNECTED, "Not connected.")
            if self._download_active:
                return self._result(RESULT_ERROR, ERROR_MESSAGES["DOWNLOAD_ALREADY_ACTIVE"])

            self._download_active = True
            self._download_state = STATE_REQUESTING
            self._reset_download_tracking()
            self._download_started_at = time.time()
            self._download_last_received_at = time.time()
            self._needs_refresh = False
            self._seen_indexes.clear()
            self._received_ids.clear()
            self._missing_ids = set()
            self._expected_count = 0
            self._download_retries = 0

        print("[PARAM] Requesting full parameter list (PARAM_REQUEST_LIST)")
        self._notify("download:start", {
            "sessionId": self._session_id,
            "startedAt": time.time(),
            "expectedCount": 0,
        })
        self._send_request_list()

        try:
            outcome = self._download_loop()
            sync = self.get_synchronization_state()
            outcome.setdefault("sessionId", self._session_id)
            self._notify("download:complete", {
                "sessionId": self._session_id,
                "status": outcome.get("status") or RESULT_ERROR,
                "syncState": sync["state"],
                "expectedCount": sync["expectedCount"],
                "receivedCount": sync["receivedCount"],
                "missing": sorted(self._missing_ids),
                "result": outcome,
                "completedAt": time.time(),
            })
            return outcome
        finally:
            with self._lock:
                self._download_active = False

    def refresh_parameters(self) -> Dict[str, Any]:
        """Re-synchronize the live parameter set from the flight controller.

        Resets download tracking and requests a fresh download. Existing cache
        entries are kept; entries not seen again during the download are marked
        ``received=False`` (visible-but-stale) rather than deleted, so newly
        hidden parameters are never silently destroyed.
        """
        with self._lock:
            if not self._connected:
                return self._result(RESULT_DISCONNECTED, "Not connected.")
            for entry in self._cache.values():
                entry.received = False
        print("[PARAM] Refresh requested — re-synchronizing parameter set")
        return self.request_all_parameters()

    def _download_loop(self) -> Dict[str, Any]:
        quiet = self._config["download_quiet_s"]
        start_timeout = self._config["download_start_timeout_s"]
        missing_retries = int(self._config["download_missing_retries"])
        missing_delay = self._config["download_missing_retry_delay_s"]

        while True:
            with self._lock:
                if not self._connected or self._download_state == STATE_CANCELLED:
                    self._download_state = STATE_IDLE
                    return self._result(RESULT_DISCONNECTED, "Disconnected during download.")

                got = len(self._received_ids) > 0
                elapsed = time.time() - self._download_started_at

                if not got and elapsed > start_timeout:
                    self._download_state = STATE_FAILED
                    print("[PARAM] Download timeout — no PARAM_VALUE received")
                    return self._result(
                        RESULT_TIMEOUT,
                        ERROR_MESSAGES["PARAMETER_DOWNLOAD_TIMEOUT"],
                    )

                idle_time = time.time() - self._download_last_received_at
                if got and idle_time >= quiet:
                    # Potential end of the stream — gap-fill first.
                    need_retry = self._gap_fill_once()
                    if need_retry:
                        self._download_state = STATE_RECEIVING
                        self._download_last_received_at = time.time()
                        if self._download_retries < missing_retries:
                            self._download_retries += 1
                            self._cond.wait(max(missing_delay, 0.01))
                            continue
                        # Retries exhausted: record the indexes the vehicle
                        # never delivered (names are unknowable — the vehicle
                        # never told us them) so the result can report them.
                        self._missing_ids = {
                            i for i in range(self._expected_count)
                            if i not in self._seen_indexes
                        }
                        print(
                            f"[PARAM] {len(self._missing_ids)} parameter(s) still "
                            "missing after gap-fill retries"
                        )
                else:
                    if self._download_state == STATE_REQUESTING and got:
                        self._download_state = STATE_RECEIVING
                    self._cond.wait(min(quiet, 0.5))
                    continue

                # No more gap-fills needed — declare completion.
                if not self._received_ids:
                    self._download_state = STATE_FAILED
                    return self._result(
                        RESULT_TIMEOUT, ERROR_MESSAGES["PARAMETER_DOWNLOAD_TIMEOUT"]
                    )
                if self._missing_ids:
                    self._download_state = STATE_COMPLETE
                    return self._result(
                        RESULT_SUCCESS,
                        ERROR_MESSAGES["PARAMETER_DOWNLOAD_INCOMPLETE"],
                        missing=sorted(self._missing_ids),
                    )
                self._download_state = STATE_COMPLETE
                print(
                    f"[PARAM] Download complete: {len(self._received_ids)} parameters "
                    f"(expected {self._expected_count})"
                )
                return self._result(RESULT_SUCCESS, "Parameter download complete.")

    def _gap_fill_once(self) -> bool:
        """Request missing indexes once. Returns True if any were missing."""
        count = self._expected_count
        missing = [
            i for i in range(count) if i not in self._seen_indexes
        ] if count > 0 else []
        if not missing:
            return False
        # Bound a single gap-fill pass so a huge hole can't flood the link.
        capped = missing[: min(len(missing), 500)]
        print(f"[PARAM] {len(missing)} missing parameter(s) — re-requesting by index")
        sys_id, comp_id = self._target_ids()
        for index in capped:
            self._send_request_read("", sys_id, comp_id, index)
        return True

    # ------------------------------------------------------------------
    # Individual read (PARAM_REQUEST_READ)
    # ------------------------------------------------------------------
    def read_parameter(self, param_id: str) -> Dict[str, Any]:
        """Read one parameter from the vehicle by param_id.

        Correlated by param_id — a PARAM_VALUE for any other parameter can
        never satisfy this request. Retries are bounded and timeouts are safe.
        """
        param_id = _decode_param_id(param_id)
        if not param_id:
            return self._result(RESULT_INVALID_PARAMETER, "Empty parameter id.")
        with self._lock:
            if not self._connected:
                return self._result(RESULT_DISCONNECTED, "Not connected.")
            try:
                self._get_entry_locked(param_id)
            except ParameterError as err:
                return self._result(RESULT_INVALID_PARAMETER, err.message, code=err.code)

        attempts = int(self._config["read_retries"]) + 1
        timeout = self._config["read_timeout_s"]
        sys_id, comp_id = self._target_ids()

        for attempt in range(attempts):
            op = _ReadOp(param_id)
            with self._lock:
                if not self._connected:
                    return self._result(RESULT_DISCONNECTED, "Disconnected during read.")
                self._read_ops[param_id] = op

            print(f"[PARAM] Read requested: {param_id} (attempt {attempt + 1}/{attempts})")
            self._send_request_read(param_id, sys_id, comp_id, -1)

            with self._lock:
                timed_out = not self._wait_op(op, timeout)
                if op.done:
                    self._read_ops.pop(param_id, None)
                    if op.result == RESULT_SUCCESS:
                        value = op.value
                        return self._result(RESULT_SUCCESS, f"Read {param_id}: {value}",
                                            value=value)
                    return self._result(op.result or RESULT_ERROR,
                                        op.error.message if op.error else "Read failed.")
                # timeout — retry if attempts remain
                self._read_ops.pop(param_id, None)
                if not self._connected:
                    return self._result(RESULT_DISCONNECTED, "Disconnected during read.")
            if attempt < attempts - 1:
                with self._lock:
                    self._cond.wait(timeout=0.2)

        return self._result(
            RESULT_TIMEOUT, ERROR_MESSAGES["PARAMETER_READ_TIMEOUT"], paramId=param_id
        )

    # ------------------------------------------------------------------
    # Write (PARAM_SET) with echo verification
    # ------------------------------------------------------------------
    def set_parameter(self, param_id: str, value: Any) -> Dict[str, Any]:
        """Write one parameter and VERIFY it from the vehicle's PARAM_VALUE.

        Never assumes success because PARAM_SET was sent. The confirmation is
        derived from the echo behavior ArduPilot documents:

          * new value echoed -> verified SUCCESS
          * new value echoed, then original echoed (read-only pattern) -> REJECTED
          * other/unexpected value echoed -> MISMATCH
          * no echo -> TIMEOUT (bounded retry)

        The live cache is updated ONLY from the authoritative echo.
        """
        param_id = _decode_param_id(param_id)
        if not param_id:
            return self._result(RESULT_INVALID_PARAMETER, "Empty parameter id.")

        with self._lock:
            if not self._connected:
                return self._result(RESULT_DISCONNECTED, "Not connected.")
            try:
                entry = self._get_entry_locked(param_id)
            except ParameterError as err:
                return self._result(RESULT_INVALID_PARAMETER, err.message, code=err.code)

        try:
            requested = normalize_value(value, entry.type)
        except ParameterError as err:
            return self._result(RESULT_INVALID_VALUE, err.message, code=err.code)

        old_value = entry.value
        attempts = int(self._config["write_retries"]) + 1
        timeout = self._config["write_timeout_s"]
        grace = self._config["write_echo_grace_s"]
        sys_id, comp_id = self._target_ids()

        for attempt in range(attempts):
            op = _WriteOp(param_id)
            with self._lock:
                if not self._connected:
                    return self._result(RESULT_DISCONNECTED, "Disconnected during write.")
                self._write_op = op

            print(
                f"[PARAM] Write {param_id} = {requested} "
                f"(type={entry.type}, attempt {attempt + 1}/{attempts})"
            )
            self._send_param_set(param_id, requested, entry.type, sys_id, comp_id)

            with self._lock:
                timed_out = not self._wait_op(op, timeout)
                if not self._connected:
                    self._write_op = None
                    return self._result(RESULT_DISCONNECTED, "Disconnected during write.")

                if timed_out:
                    self._write_op = None
                    if attempt < attempts - 1:
                        with self._lock:
                            self._cond.wait(timeout=0.2)
                        continue
                    return self._result(
                        RESULT_TIMEOUT,
                        ERROR_MESSAGES["PARAMETER_WRITE_TIMEOUT"],
                        paramId=param_id,
                    )

                # We have at least one echo. Wait a grace period for a possible
                # second echo (read-only: new value then original value).
                if len(op.echoes) == 1:
                    with self._lock:
                        self._cond.wait(timeout=grace)

                verdict = self._evaluate_write_echo(entry, requested, old_value, op.echoes)
                self._write_op = None

                if verdict == RESULT_SUCCESS:
                    verified = op.echoes[0][0]
                    cached = self._cache.get(param_id)
                    if cached is not None:
                        cached.value = verified
                        cached.receivedAt = time.time()
                        cached.writeState = "verified"
                    print(f"[PARAM] Write confirmed: {param_id} = {verified}")
                    return self._result(RESULT_SUCCESS, f"Write confirmed: {param_id} = {verified}",
                                        value=verified, paramId=param_id)

                if verdict == RESULT_REJECTED:
                    print(f"[PARAM] Write rejected by vehicle: {param_id}")
                    return self._result(RESULT_REJECTED, "Vehicle rejected the write.",
                                        paramId=param_id)

                # MISMATCH / other — bounded retry.
                if attempt < attempts - 1:
                    with self._lock:
                        self._cond.wait(timeout=0.2)
                    continue
                message = (
                    ERROR_MESSAGES["PARAMETER_WRITE_MISMATCH"]
                    if verdict == RESULT_MISMATCH else "Parameter write failed."
                )
                return self._result(verdict or RESULT_ERROR, message, paramId=param_id)

        return self._result(RESULT_ERROR, "Parameter write failed.", paramId=param_id)

    def _evaluate_write_echo(self, entry: ParameterState, requested: float,
                             old_value: float, echoes: List[tuple]) -> str:
        """Classify an echo sequence into success/rejected/mismatch."""
        if not echoes:
            return RESULT_TIMEOUT
        first = echoes[0][0]
        rel = self._config["float_rel_tol"]
        abs_ = self._config["float_abs_tol"]

        if values_match(first, requested, entry.type, rel, abs_):
            # Could still be the documented read-only "new then original"
            # double echo — check for a reversal in later echoes.
            for later_val, _, _ in echoes[1:]:
                if not values_match(later_val, requested, entry.type, rel, abs_):
                    return RESULT_REJECTED
            return RESULT_SUCCESS

        if values_match(first, old_value, entry.type, rel, abs_):
            return RESULT_REJECTED  # unchanged by the vehicle
        return RESULT_MISMATCH

    # ------------------------------------------------------------------
    # Lookup / state
    # ------------------------------------------------------------------
    def get_parameter(self, param_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            entry = self._cache.get(_decode_param_id(param_id))
            return entry.to_snapshot() if entry else None

    def get_all_parameters(self) -> List[Dict[str, Any]]:
        with self._lock:
            return [entry.to_snapshot() for entry in self._cache.values()]

    def get_synchronization_state(self) -> Dict[str, Any]:
        with self._lock:
            return {
                "connected": self._connected,
                "state": self._download_state,
                "expectedCount": self._expected_count,
                "receivedCount": len(self._received_ids),
                "missingIds": sorted(self._missing_ids),
                "cachedEntries": len(self._cache),
                "startedAt": self._download_started_at,
                "lastReceivedAt": self._download_last_received_at,
                "retryCount": self._download_retries,
                "needsRefresh": self._needs_refresh,
            }

    def cancel_download(self) -> None:
        with self._lock:
            if self._download_active:
                self._download_state = STATE_CANCELLED
                self._cond.notify_all()
            print("[PARAM] Download cancelled")

    # ------------------------------------------------------------------
    # Observer hook (Phase 2 socket/API integration — purely additive)
    # ------------------------------------------------------------------
    def set_event_listener(self, listener: Optional[Callable[[str, Dict[str, Any]], None]]) -> None:
        """Register a single observer for manager notifications.

        The listener receives ``(event_name, payload)`` for:
          session:start / session:stop / download:start / download:param /
          download:complete / param:received
        Notifications are fire-and-forget: an exception in the listener is
        caught and logged so observer code can never break MAVLink handling.
        """
        self._listener = listener

    def get_session_id(self) -> Optional[str]:
        with self._lock:
            return self._session_id

    def _notify(self, name: str, payload: Dict[str, Any]) -> None:
        listener = self._listener
        if listener is None:
            return
        try:
            listener(name, payload)
        except Exception as err:  # noqa: BLE001
            print(f"[PARAM] observer error on {name}: {err}")

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------
    def _reset_download_tracking(self) -> None:
        self._expected_count = 0
        self._seen_indexes = set()
        self._received_ids = set()
        self._missing_ids = set()
        self._download_started_at = None
        self._download_last_received_at = None
        self._download_retries = 0
        self._needs_refresh = False

    def _get_entry_locked(self, param_id: str) -> ParameterState:
        entry = self._cache.get(param_id)
        if entry is None:
            raise ParameterError("PARAMETER_NOT_FOUND")
        return entry

    def _target_ids(self) -> tuple:
        from core.state import vehicle_state

        return vehicle_state["systemId"] or 1, vehicle_state["componentId"] or 1

    def _send_request_list(self) -> None:
        sys_id, comp_id = self._target_ids()
        self._sender("param_request_list", {
            "target_system": sys_id,
            "target_component": comp_id,
        })

    def _send_request_read(self, param_id: str, sys_id: int, comp_id: int,
                           param_index: int) -> None:
        try:
            self._sender("param_request_read", {
                "target_system": sys_id,
                "target_component": comp_id,
                "param_id": param_id,
                "param_index": param_index,
            })
        except ParameterError as err:  # surface send failures to the waiter
            self._remote_error(err)

    def _send_param_set(self, param_id: str, value: float, param_type: int,
                        sys_id: int, comp_id: int) -> None:
        try:
            self._sender("param_set", {
                "target_system": sys_id,
                "target_component": comp_id,
                "param_id": param_id,
                "param_value": value,
                "param_type": param_type,
            })
        except ParameterError as err:
            self._remote_error(err)

    def _remote_error(self, err: ParameterError) -> None:
        """Mark any pending op as errored so a send failure can't hang it."""
        with self._lock:
            for op in self._read_ops.values():
                if not op.done:
                    op.done = True
                    op.result = RESULT_ERROR
                    op.error = err
            if self._write_op is not None and not self._write_op.done:
                self._write_op.done = True
                self._write_op.result = RESULT_ERROR
                self._write_op.error = err
            self._cond.notify_all()

    def _wait_op(self, op: Any, timeout: float) -> bool:
        """Wait until `op.done` is set or the timeout elapses. Returns True if
        done. Assumes self._lock is held by the caller."""
        deadline = time.monotonic() + timeout
        while not op.done:
            if not self._connected:
                return False
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return False
            self._cond.wait(max(remaining, 0.001))
        return True

    def _resolve_read_ops(self, result: str) -> None:
        for op in self._read_ops.values():
            if not op.done:
                op.done = True
                op.result = result
                op.error = ParameterError("NOT_CONNECTED")
        self._read_ops.clear()

    def _resolve_write_op(self, result: str) -> None:
        op = self._write_op
        if op is not None and not op.done:
            op.done = True
            op.result = result
            op.error = ParameterError("NOT_CONNECTED")
        self._write_op = None

    def _result(self, status: str, message: str, code: Optional[str] = None,
                **extra: Any) -> Dict[str, Any]:
        result = {"status": status, "message": message}
        if code:
            result["code"] = code
        result.update(extra)
        return result


# Singleton instance used by the MAVLink dispatcher and future API layers.
parameter_manager = ParameterManager()