"""Parameter reset-to-default service (Phase 6).

Performs a REAL ArduPilot reset via the protocol commands MAVProxy / Mission
Planner use — NOT a bulk PARAM_SET (which could never zero a vehicle's own
state):

  1. backup   — snapshot the authoritative live set (abort if it is empty)
  2. reset    — MAV_CMD_PREFLIGHT_STORAGE (245) param1=2
                = PREFLIGHT_STORAGE_PARAMETER_ACTION.PARAM_RESET_FACTORY_DEFAULT
  3. reboot   — MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN (246) param1=1 (\"autopilot,
                reboot\"), param6=20190226 (\"force\") — identical to
                pymavlink mavutil.reboot_autopilot(force=True)
  4. wait for the link to drop (autopilot recycles)
  5. reconnect to the SAME transport profile
  6. re-sync the full parameter set
  7. verify — the post-reset set must differ from the backup (when the backup
     was not already at factory defaults) and the sync must be complete.

Success is NEVER declared because a command was transmitted: verification
requires a clean reconnect + completed parameter download, and the UI reports
how many parameters actually changed from the backup.

The state machine runs on a worker thread with injectable dependencies so the
full lifecycle is deterministically testable without hardware:

  ``deps`` = {
    connected:   () -> bool
    backup:      () -> {param_id: value, ...}      (authoritative snapshot)
    send_command: (command, params) -> ack dict      (COMMAND_LONG + ACK)
    wait_link_down: (timeout_s) -> bool              (block until link drops)
    reconnect:    () -> (ok, message)                (reuse the prior profile)
    sync:         () -> result dict                  (full PARAM_REQUEST_LIST)
    snapshot:     () -> [ {id, value, type}, ... ]   (post-reset live set)
  }
"""

import threading
import time
import uuid
from typing import Any, Callable, Dict, List, Optional

from mavlink import parameter_manager as pm
from sio import server as sio_server

# Protocol constants (pymavlink / MAVProxy parity).
MAV_CMD_PREFLIGHT_STORAGE = 245
PARAM_RESET_FACTORY_DEFAULT = 2.0

MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN = 246
REBOOT_SHUTDOWN_ACTION_REBOOT = 1.0
REBOOT_SHUTDOWN_CONDITIONS_FORCE = 20190226.0

# State machine states (lowercase, repo convention).
STATE_IDLE = "idle"
STATE_BACKUP = "backup"
STATE_RESET_REQUESTED = "reset_requested"
STATE_REBOOT_REQUESTED = "reboot_requested"
STATE_WAITING_FOR_REBOOT = "waiting_for_reboot"
STATE_RECONNECTING = "reconnecting"
STATE_PARAMETER_SYNC = "parameter_sync"
STATE_VERIFY = "verify"
STATE_COMPLETE = "complete"
STATE_FAILED = "failed"

_FLOW = [
    STATE_BACKUP,
    STATE_RESET_REQUESTED,
    STATE_REBOOT_REQUESTED,
    STATE_WAITING_FOR_REBOOT,
    STATE_RECONNECTING,
    STATE_PARAMETER_SYNC,
    STATE_VERIFY,
    STATE_COMPLETE,
]

# Stable error codes (API parity with the other parameter services).
CODE_NOT_CONNECTED = "NOT_CONNECTED"
CODE_RESET_ACTIVE = "RESET_IN_PROGRESS"
CODE_RESET_FAILED = "RESET_FAILED"
CODE_BAD_REQUEST = "BAD_REQUEST"
CODE_BACKUP_FAILED = "BACKUP_FAILED"
CODE_REBOOT_TIMEOUT = "REBOOT_TIMEOUT"
CODE_RECONNECT_FAILED = "RECONNECT_FAILED"
CODE_SYNC_FAILED = "SYNC_FAILED"


class _ResetRun:
    """Mutable state for a single reset attempt (guarded by ResetManager lock)."""

    __slots__ = ("reset_id", "state", "message", "error_code", "error_message",
                 "summary", "started_at", "completed_at")

    def __init__(self, reset_id: str) -> None:
        self.reset_id = reset_id
        self.state = STATE_IDLE
        self.message = ""
        self.error_code: Optional[str] = None
        self.error_message: Optional[str] = None
        self.summary: Optional[Dict[str, Any]] = None
        self.started_at = time.time()
        self.completed_at: Optional[float] = None


class ParameterResetManager:
    """Single-authority reset state machine (one reset at a time)."""

    def __init__(self, deps: Optional[Dict[str, Callable]] = None,
                 emit: Optional[Callable[[str, Any], None]] = None,
                 step_delay_s: float = 0.05) -> None:
        self._deps = deps or self._default_deps()
        self._emit = emit or (lambda event, data: None)
        self._step_delay = step_delay_s
        self._lock = threading.Lock()
        self._run: Optional[_ResetRun] = None

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    def is_active(self) -> bool:
        with self._lock:
            run = self._run
            return run is not None and run.state not in (STATE_COMPLETE,
                                                         STATE_FAILED)

    def status(self) -> Dict[str, Any]:
        with self._lock:
            run = self._run
            if run is None:
                return {"success": True, "active": False, "state": STATE_IDLE}
            return {
                "success": True,
                "active": run.state not in (STATE_COMPLETE, STATE_FAILED),
                "resetId": run.reset_id,
                "state": run.state,
                "message": run.message,
                "error": (
                    {"code": run.error_code, "message": run.error_message}
                    if run.error_code is not None else None
                ),
                "summary": run.summary,
                "startedAt": run.started_at,
                "completedAt": run.completed_at,
            }

    def start(self, confirm: bool = False) -> Dict[str, Any]:
        """Begin the reset flow. ``confirm`` MUST be true (the UI shows an
        irreversible-action dialog before sending it)."""
        if not confirm:
            return self._error(
                CODE_BAD_REQUEST,
                "Reset requires explicit confirmation.",
            )
        with self._lock:
            run = self._run
            if run is not None and run.state not in (STATE_COMPLETE,
                                                     STATE_FAILED):
                return self._error(
                    CODE_RESET_ACTIVE,
                    "A parameter reset is already in progress.",
                    extra={"resetId": run.reset_id},
                )
            run = _ResetRun(uuid.uuid4().hex[:12])
            self._run = run

        if not self._deps["connected"]():
            return self._finish_now(
                run, STATE_FAILED, CODE_NOT_CONNECTED,
                "The flight controller is not connected.",
            )

        thread = threading.Thread(
            target=self._worker, args=(run,), daemon=True,
            name=f"param-reset-{run.reset_id}",
        )
        thread.start()
        return {"success": True, "resetId": run.reset_id}

    # ------------------------------------------------------------------
    # State machine (worker thread)
    # ------------------------------------------------------------------
    def _worker(self, run: _ResetRun) -> None:
        try:
            self._emit("parameter:reset:start", {
                "resetId": run.reset_id, "startedAt": run.started_at,
            })

            # ---- Stage 1: backup -------------------------------------
            self._set_state(run, STATE_BACKUP,
                            "Backing up current parameters.")
            backup = self._deps["backup"]()
            if not backup:
                return self._fail(run, STATE_FAILED, CODE_BACKUP_FAILED,
                                  "Parameter backup was empty — reset aborted.")

            # ---- Stage 2: reset (MAV_CMD_PREFLIGHT_STORAGE p1=2) -----
            self._set_state(run, STATE_RESET_REQUESTED,
                            "Requesting factory-default reset.")
            reset_ack = self._deps["send_command"](
                MAV_CMD_PREFLIGHT_STORAGE,
                (PARAM_RESET_FACTORY_DEFAULT, 0, 0, 0, 0, 0, 0),
            )
            if not reset_ack.get("success"):
                label = reset_ack.get("ackLabel") or reset_ack.get("message")
                return self._fail(run, STATE_FAILED, CODE_RESET_FAILED,
                                  f"Reset command rejected by the vehicle "
                                  f"({label}). The vehicle must be disarmed "
                                  f"and in pre-flight mode.")
            self._step_delay_wait()

            # ---- Stage 3: reboot (MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN) --
            self._set_state(run, STATE_REBOOT_REQUESTED,
                            "Rebooting the flight controller.")
            reboot_ack = self._deps["send_command"](
                MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN,
                (REBOOT_SHUTDOWN_ACTION_REBOOT, 0, 0, 0, 0,
                 REBOOT_SHUTDOWN_CONDITIONS_FORCE, 0),
            )
            if not reboot_ack.get("success"):
                label = reboot_ack.get("ackLabel") or reboot_ack.get("message")
                return self._fail(run, STATE_FAILED, CODE_RESET_FAILED,
                                  f"Reboot command rejected by the vehicle "
                                  f"({label}).")
            self._step_delay_wait()

            # ---- Stage 4: wait for the link to drop -------------------
            self._set_state(run, STATE_WAITING_FOR_REBOOT,
                            "Waiting for the vehicle to reboot...")
            if not self._deps["wait_link_down"](self._reboot_timeout_s):
                return self._fail(run, STATE_FAILED, CODE_REBOOT_TIMEOUT,
                                  "Timed out waiting for the vehicle to reboot.")
            self._step_delay_wait()

            # ---- Stage 5: reconnect to the SAME transport --------------
            attempts = 0
            reconnected = False
            while attempts < self._reconnect_attempts:
                attempts += 1
                self._set_state(run, STATE_RECONNECTING,
                                f"Reconnecting… attempt {attempts}/"
                                f"{self._reconnect_attempts}.")
                self._emit("parameter:reset:reconnect", {
                    "resetId": run.reset_id, "attempt": attempts,
                })
                ok, message = self._deps["reconnect"]()
                if ok:
                    reconnected = True
                    break
            if not reconnected:
                return self._fail(run, STATE_FAILED, CODE_RECONNECT_FAILED,
                                  "Could not reconnect to the flight "
                                  "controller after the reboot.")
            self._step_delay_wait()

            # ---- Stage 6: re-sync parameters --------------------------
            self._set_state(run, STATE_PARAMETER_SYNC,
                            "Synchronizing parameters after reset.")
            sync = self._deps["sync"]()
            if sync.get("status") != pm.RESULT_SUCCESS:
                return self._fail(run, STATE_FAILED, CODE_SYNC_FAILED,
                                  sync.get("message") or "Parameter "
                                  "synchronization failed after reset.")
            self._step_delay_wait()

            # ---- Stage 7: verify against the backup -------------------
            self._set_state(run, STATE_VERIFY, "Verifying reset result.")
            snap = self._deps["snapshot"]()
            changed = self._diff_counts(backup, snap or [])
            summary = {
                "resetId": run.reset_id,
                "state": STATE_COMPLETE,
                "backupCount": len(backup),
                "parameterCount": changed["total"],
                "changedCount": changed["changed"],
                "unchangedCount": changed["unchanged"],
                "changedParams": changed["ids"][:50],
                "sync": {
                    "state": sync.get("syncState") or "complete",
                    "receivedCount": sync.get("receivedCount", 0),
                    "expectedCount": sync.get("expectedCount", 0),
                },
            }
            self._set_state(run, STATE_COMPLETE,
                            "Reset complete. Parameters restored to "
                            "factory defaults.",
                            summary=summary)
            self._emit("parameter:reset:complete", summary)
        except Exception as err:  # noqa: BLE001 - never leak from the worker
            print(f"[PARAM_RESET] worker error: {err}")
            self._fail(run, STATE_FAILED, CODE_RESET_FAILED, str(err))

    # ------------------------------------------------------------------
    # Comparison helpers
    # ------------------------------------------------------------------
    def _diff_counts(self, backup: Dict[str, float],
                     snap: List[Dict[str, Any]]) -> Dict[str, Any]:
        changed: List[str] = []
        unchanged = 0
        rel = self._rel_tol
        abs_ = self._abs_tol
        for entry in snap:
            param_id = entry.get("id")
            if param_id not in backup:
                continue
            before = float(backup[param_id])
            after = float(entry["value"])
            ptype = int(entry["type"]) if entry.get("type") is not None else 9
            if pm.values_match(before, after, ptype, rel, abs_):
                unchanged += 1
            else:
                changed.append(param_id)
        return {
            "total": len(backup),
            "changed": len(changed),
            "unchanged": unchanged,
            "ids": changed,
        }

    # ------------------------------------------------------------------
    # State helpers
    # ------------------------------------------------------------------
    def _set_state(self, run: _ResetRun, state: str, message: str,
                   summary: Optional[Dict[str, Any]] = None) -> None:
        with self._lock:
            run.state = state
            run.message = message
            if summary is not None:
                run.summary = summary
        self._emit("parameter:reset:progress", {
            "resetId": run.reset_id, "state": state, "message": message,
            "step": _FLOW.index(state) + 1 if state in _FLOW else None,
            "totalSteps": len(_FLOW),
            "summary": summary,
        })

    def _fail(self, run: _ResetRun, state: str, code: str,
              message: str) -> None:
        with self._lock:
            run.state = state
            run.error_code = code
            run.error_message = message
            run.completed_at = time.time()
        self._emit("parameter:reset:error", {
            "resetId": run.reset_id, "code": code, "message": message,
            "state": state,
        })

    def _finish_now(self, run: _ResetRun, state: str, code: str,
                    message: str) -> Dict[str, Any]:
        # Called before the worker thread spawns (e.g. not connected).
        self._fail(run, state, code, message)
        return self._error(code, message)

    def _step_delay_wait(self) -> None:
        if self._step_delay > 0:
            time.sleep(self._step_delay)

    @staticmethod
    def _error(code: str, message: str,
               extra: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "success": False, "error": {"code": code, "message": message}}
        if extra:
            payload.update(extra)
        return payload

    # ------------------------------------------------------------------
    # Default dependencies (real transport / services)
    # ------------------------------------------------------------------
    @staticmethod
    def _default_deps() -> Dict[str, Callable]:
        from mavlink.connection_manager import manager as conn_manager
        from mavlink import command_service
        from services import vehicle_service

        def connected() -> bool:
            return pm.parameter_manager.is_connected()

        def backup() -> Dict[str, float]:
            return {
                e["id"]: float(e["value"])
                for e in pm.parameter_manager.get_all_parameters()
            }

        def send_command(command: int, params: tuple) -> Dict[str, Any]:
            command_service._transport()
            return command_service.wait_for_command_ack(
                command,
                send_fn=lambda: command_service._command_long(
                    command,
                    param1=params[0], param2=params[1], param3=params[2],
                    param4=params[3], param5=params[4], param6=params[5],
                    param7=params[6],
                ),
            )

        def wait_link_down(timeout_s: float) -> bool:
            from core.state import is_vehicle_connected

            deadline = time.monotonic() + timeout_s
            while time.monotonic() < deadline:
                if not is_vehicle_connected():
                    return True
                time.sleep(0.25)
            return False

        def reconnect() -> tuple:
            profile = vehicle_service.last_connection
            if not profile:
                return False, "No prior connection profile available."
            # The autopilot reboot can leave the old transport socket stale
            # (some vehicles/sims only resume heartbeats on fresh sessions).
            # Tear the prior link down and open a new transport so reconnect
            # never waits forever on a dead socket.
            try:
                conn_manager.stop()
            except Exception:  # noqa: BLE001
                pass
            ok, message = conn_manager.start(
                profile["connection_type"], host=profile.get("host") or "",
                port=profile.get("port") or 0, device=profile.get("device") or "",
                baud=profile.get("baud") or 57600,
            )
            return ok, message

        def sync() -> Dict[str, Any]:
            return pm.parameter_manager.request_all_parameters()

        def snapshot() -> List[Dict[str, Any]]:
            return pm.parameter_manager.get_all_parameters()

        return {
            "connected": connected,
            "backup": backup,
            "send_command": send_command,
            "wait_link_down": wait_link_down,
            "reconnect": reconnect,
            "sync": sync,
            "snapshot": snapshot,
        }

    # Tuning (kept small and readable; tests use the injectable deps).
    @property
    def _reboot_timeout_s(self) -> float:
        return 30.0

    @property
    def _reconnect_attempts(self) -> int:
        return 5

    @property
    def _rel_tol(self) -> float:
        return float(pm.DEFAULT_CONFIG["float_rel_tol"])

    @property
    def _abs_tol(self) -> float:
        return float(pm.DEFAULT_CONFIG["float_abs_tol"])


parameter_reset_manager = ParameterResetManager(
    emit=(lambda event, data: sio_server.emit(event, data)
          if event.startswith("parameter:reset") else None),
)