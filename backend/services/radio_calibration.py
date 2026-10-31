"""Radio calibration state machine (GCS-side protocol) — Phase 8E.

This is a REAL protocol conductor, never a fake-result generator:

  * Every sample it records comes from the live RC_CHANNELS telemetry on the
    vehicle (raw PWM per channel).
  * The final RCn_MIN/TRIM/MAX parameters are written through
    parameter_service.write_parameter — the verified pipeline (PARAM_SET ->
    PARAM_VALUE echo -> cache -> socket emit). A write is only "confirmed"
    once the vehicle echoes it.
  * Completion is reported ONLY after every captured channel's endpoints have
    been read back from the vehicle parameter system and match what was written.

The wizard is a three-capture sequence mirroring QGC: center sticks (trim),
then minimum, then maximum. Each capture blocks for a live-frame window (or
until the user cancels), so it reflects genuine stick positions.
"""

import time
import threading
from typing import Any, Dict, List, Optional

from mavlink.parameter_manager import parameter_manager

# Capture tuning (module-level so pytest can shrink the windows deterministically).
CAPTURE_WINDOW_S = 4.0  # how long each capture phase samples live frames
SAMPLER_INTERVAL_S = 0.05  # telemetry poll interval during a capture
NO_FRAME_TIMEOUT_S = 2.0  # no fresh RC frame -> TIMEOUT
WRITE_PAUSE_S = 0.02  # small pause between sequential verified writes
MIN_STABLE_FRAMES = 5  # minimum live frames needed to trust a capture stat

_PHASE_ORDER = {"center": "ready", "min": "center-done", "max": "min-done"}

#: Coarse, stable stage vocabulary exposed to the UI. The machine keeps its own
#: precise states; these names are the documented contract the page renders.
_STAGE_BY_STATE = {
    "idle": "IDLE",
    "ready": "READY",
    "center-done": "READY",
    "min-done": "READY",
    "capturing-center": "CALIBRATING",
    "capturing-min": "CALIBRATING",
    "capturing-max": "CALIBRATING",
    "validating": "FINALIZING",
    "completed": "SUCCESS",
    "failed": "FAILED",
    "timeout": "FAILED",
    "cancelled": "CANCELLED",
}


def _stage_for(state: Optional[str]) -> str:
    """Map an internal machine state onto the documented UI stage."""
    if state == "idle":
        # An idle wizard with no live RC stream cannot proceed, and saying so is
        # more honest than a bare "idle". Once RC is streaming the wizard is
        # simply idle, waiting for the operator to start it.
        return "IDLE" if _rc_present() else "WAITING_FOR_RC"
    return _STAGE_BY_STATE.get(state or "", "IDLE")


def _rc_present() -> bool:
    """True only when the vehicle is genuinely streaming live RC_CHANNELS."""
    try:
        from core.state import telemetry, get_vehicle_status

        if not get_vehicle_status()["connected"]:
            return False
        if not telemetry.get("rcChannels"):
            return False
        received = telemetry.get("rcReceivedAt", 0)
        if not received:
            return False
        return (time.time() - received) <= NO_FRAME_TIMEOUT_S
    except Exception:  # noqa: BLE001 - status must never raise
        return False


class _Machine:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._state = "idle"
        self._message = ""
        self._busy = False
        self._cancel = False
        self._phase = None  # "center" | "min" | "max"
        self._captured: Dict[int, Dict[str, Any]] = {}
        self._progress: Dict[str, Any] = {}
        self._result: Optional[Dict[str, Any]] = None

    # ------------------------------------------------------------------
    # Status
    # ------------------------------------------------------------------
    def status(self) -> Dict[str, Any]:
        with self._lock:
            return self._status_locked()

    def _status_locked(self) -> Dict[str, Any]:
        return {
            "state": self._state,
            "stage": _stage_for(self._state),
            "message": self._message,
            "phase": self._phase,
            "progress": dict(self._progress),
            "result": dict(self._result) if self._result else None,
        }

    def _set(self, state: str, message: str = "") -> None:
        with self._lock:
            self._state = state
            self._message = message

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------
    def start(self) -> Dict[str, Any]:
        from services.radio_service import _identity, _is_supported, _signal_state

        identity = _identity()
        supported, reason = _is_supported(identity)
        if not supported:
            return {"success": False, "message": reason or "Not supported."}
        if _signal_state(identity) != "RECEIVING":
            return {
                "success": False,
                "message": (
                    "Radio calibration requires a live RC signal. Move the "
                    "receiver's sticks once, then try again."
                ),
            }
        with self._lock:
            if self._busy:
                return {"success": False, "message": "Calibration already running."}
            self._captured = {}
            self._cancel = False
            self._result = None
        self._set("ready", "Move the sticks to their CENTER position, then press Capture Center.")
        return {"success": True, **self.status()}

    def capture(self, phase: str) -> Dict[str, Any]:
        if phase not in _PHASE_ORDER:
            return {"success": False, "message": f"Unknown capture phase '{phase}'."}

        with self._lock:
            if self._busy:
                status = self._status_locked()
                return {"success": False, **status,
                        "message": "A capture is already in progress."}
            if self._state == "idle":
                status = self._status_locked()
                return {"success": False, **status,
                        "message": "Calibration has not been started."}
            if self._state != _PHASE_ORDER[phase]:
                status = self._status_locked()
                return {
                    "success": False,
                    **status,
                    "message": (
                        f"Cannot capture '{phase}' now (state={self._state}). "
                        "Follow the calibration steps in order."
                    ),
                }
            self._busy = True
            self._cancel = False
            self._phase = phase
            self._progress = {"phase": phase, "frames": 0, "channels": {}}

        self._set(f"capturing-{phase}", self._capture_hint(phase))
        try:
            return self._run_capture(phase)
        finally:
            with self._lock:
                self._busy = False
                self._phase = None

    def cancel(self) -> Dict[str, Any]:
        with self._lock:
            if self._state == "idle":
                message = "Nothing to cancel."
                status = self._status_locked()
            else:
                self._cancel = True
                message = "Calibration cancelled."
                status = self._status_locked()
        return {"success": True, **status, "message": message}

    # ------------------------------------------------------------------
    # Capture internals
    # ------------------------------------------------------------------
    @staticmethod
    def _capture_hint(phase: str) -> str:
        return {
            "center": "Hold the sticks at CENTER while the capture runs…",
            "min": "Hold ALL sticks at their MINIMUM position…",
            "max": "Hold ALL sticks at their MAXIMUM position…",
        }[phase]

    def _fresh_frame(self) -> Optional[List[int]]:
        """Return the latest real RC frame, or None if it has gone stale."""
        from core.state import telemetry

        channels = telemetry.get("rcChannels")
        received = telemetry.get("rcReceivedAt", 0)
        if not channels or not received:
            return None
        if (time.time() - received) > NO_FRAME_TIMEOUT_S:
            return None
        return [int(c) for c in channels[:16]]

    def _run_capture(self, phase: str) -> Dict[str, Any]:
        deadline = time.time() + CAPTURE_WINDOW_S
        interval = SAMPLER_INTERVAL_S
        per_channel: Dict[int, Dict[str, Any]] = {}
        frame_count = 0
        last_emit = 0.0

        while time.time() < deadline:
            with self._lock:
                cancelled = self._cancel
            if cancelled:
                self._set("cancelled", "Calibration cancelled by the user.")
                return {"success": False, "message": "Calibration cancelled.", **self.status()}

            frame = self._fresh_frame()
            if frame is not None:
                frame_count += 1
                for idx, value in enumerate(frame, start=1):
                    if value <= 0:
                        continue
                    stats = per_channel.setdefault(
                        idx, {"frames": 0, "min": 1 << 30, "max": 0, "sum": 0, "n": 0}
                    )
                    stats["frames"] += 1
                    stats["min"] = min(stats["min"], value)
                    stats["max"] = max(stats["max"], value)
                    stats["sum"] += value
                    stats["n"] += 1

            now = time.time()
            if now - last_emit >= 0.25:
                last_emit = now
                self._progress = {
                    "phase": phase,
                    "frames": frame_count,
                    "channels": {
                        str(ch): {k: v for k, v in st.items() if k != "sum"}
                        for ch, st in per_channel.items()
                    },
                }
                _emit_progress(self.status())
            time.sleep(interval)

        if frame_count < MIN_STABLE_FRAMES:
            self._set("timeout", "No continuous RC signal during capture.")
            with self._lock:
                self._result = {
                    "result": "timeout",
                    "message": "RC signal was lost during capture. No parameters changed.",
                }
            return {
                "success": False,
                "message": "RC signal lost during capture — no values were changed.",
                **self.status(),
            }

        self._store_capture(phase, per_channel)
        return {"success": True, **self.status()}

    def _store_capture(self, phase: str, per_channel: Dict[int, Dict[str, Any]]) -> None:
        with self._lock:
            for channel, st in per_channel.items():
                if st["n"] < MIN_STABLE_FRAMES:
                    continue
                entry = self._captured.setdefault(
                    channel, {"center": None, "min": None, "max": None}
                )
                if phase == "center":
                    entry["center"] = st["sum"] / st["n"]
                elif phase == "min":
                    entry["min"] = st["min"]
                elif phase == "max":
                    entry["max"] = st["max"]

            next_state, hint = {
                "center": (
                    "center-done",
                    "Center captured. Hold ALL sticks at their MINIMUM, then press Capture Minimum.",
                ),
                "min": (
                    "min-done",
                    "Minimum captured. Hold ALL sticks at their MAXIMUM, then press Capture Maximum.",
                ),
            }.get(phase, (None, None))
        if next_state:
            self._set(next_state, hint)
        else:
            self._finish_after_max()

    def _finish_after_max(self) -> None:
        self._set("validating", "Capture complete. Writing verified channel endpoints…")
        failures = self._validate_captured()
        if failures:
            with self._lock:
                self._result = {
                    "result": "failed",
                    "message": "; ".join(failures),
                    "failures": failures,
                }
            self._set("failed", "Captured endpoints are invalid — no parameters were changed.")
            return
        write_result = self._write_and_verify()
        if write_result["success"]:
            with self._lock:
                self._result = {
                    "result": "success",
                    "message": "Radio calibration stored and verified on the vehicle.",
                    "values": write_result["written"],
                }
            self._set("completed", write_result["message"])
        else:
            with self._lock:
                self._result = {
                    "result": "failed",
                    "message": write_result["message"],
                }
            self._set("failed", write_result["message"])

    # ------------------------------------------------------------------
    # Validation + verified writes
    # ------------------------------------------------------------------
    def _validate_captured(self) -> List[str]:
        failures: List[str] = []
        with self._lock:
            captured = {
                ch: dict(e) for ch, e in self._captured.items()
            }
        for channel in sorted(captured):
            e = captured[channel]
            if e.get("min") is None or e.get("max") is None or e.get("center") is None:
                failures.append(f"CH{channel} missing a capture phase.")
                continue
            if not (900 <= e["min"] <= 2200 and 900 <= e["max"] <= 2200):
                failures.append(
                    f"CH{channel} captured PWM ({e['min']}/{e['max']}) is outside 900–2200."
                )
            elif not (e["min"] < e["center"] < e["max"]):
                failures.append(
                    f"CH{channel} has MIN {e['min']} not below TRIM {e['center']} "
                    f"not below MAX {e['max']}. Check the stick direction / "
                    "Reversed flag before calibrating."
                )
        return failures

    def _write_and_verify(self) -> Dict[str, Any]:
        from services.parameter_service import parameter_service

        with self._lock:
            captured = dict(self._captured)

        entries = []
        for pid, key in (("RC%d_MIN", "min"), ("RC%d_TRIM", "center"), ("RC%d_MAX", "max")):
            for ch in sorted(captured):
                raw = captured[ch][key]
                entries.append((pid % ch, int(raw)))

        written = []
        for pid, value in entries:
            with self._lock:
                if self._cancel:
                    self._state = "cancelled"
                    self._message = "Calibration cancelled during writes."
                    return {
                        "success": False,
                        "message": "Calibration cancelled during writes.",
                    }
            try:
                result = parameter_service.write_parameter(pid, value)
            except Exception as err:  # transport hiccups must never fake success
                return {
                    "success": False,
                    "message": f"Write {pid} failed: {err}. No further parameters written.",
                }
            if not result.get("success"):
                return {
                    "success": False,
                    "message": (
                        f"Failed to apply parameter {pid}: "
                        f"{result.get('message', result.get('code', 'WRITE_FAILED'))}. "
                        "Previous values were preserved."
                    ),
                }
            written.append({"param": pid, "value": value})
            time.sleep(WRITE_PAUSE_S)

        # Read-back verification: the vehicle must report exactly what we wrote.
        for item in written:
            entry = parameter_manager.get_parameter(item["param"])
            actual = entry.get("value") if entry else None
            try:
                actual_int = int(actual) if actual is not None else None
            except (TypeError, ValueError):
                actual_int = None
            if actual_int != item["value"]:
                return {
                    "success": False,
                    "message": (
                        f"Verification failed: {item['param']} read back "
                        f"{actual} instead of {item['value']}."
                    ),
                }

        return {
            "success": True,
            "message": "Radio calibration stored and verified.",
            "written": written,
        }


def _emit_progress(payload: Dict[str, Any]) -> None:
    try:
        from sio.server import emit as sio_emit

        sio_emit("radio:calibration:progress", payload)
    except Exception:
        pass  # socket layer must never break the calibration


def start_radio_calibration() -> Dict[str, Any]:
    return _machine.start()


def capture_radio_phase(phase: str) -> Dict[str, Any]:
    return _machine.capture(phase)


def cancel_radio_calibration() -> Dict[str, Any]:
    return _machine.cancel()


def get_calibration_machine_status() -> Dict[str, Any]:
    return _machine.status()


def reset_radio_calibration() -> None:
    """Force the wizard back to idle when the link drops.

    A calibration session must never be left mid-capture inside a lost or
    half-open connection; the frontend requires an explicit restart after
    reconnect (same contract as the sensor calibration reset).
    """
    with _machine._lock:
        _machine._state = "idle"
        _machine._message = ""
        _machine._busy = False
        _machine._cancel = False
        _machine._phase = None
        _machine._captured = {}
        _machine._progress = {}
        _machine._result = None


_machine = _Machine()