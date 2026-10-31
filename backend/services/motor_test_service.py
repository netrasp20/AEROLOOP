"""Functional Motors Setup backend for ArduCopter (QGC workflow, SITL-first).

Reproduces the QGroundControl Motors *workflow* — discover the vehicle's motor
outputs from ``SERVOx_FUNCTION``, map motor number -> physical output, run an
individual motor test, and stage/apply the per-output reverse configuration —
while adapting it to ArduCopter and this project's existing infrastructure.

Safety model (enforced here, not only in the UI):

* The single existing MAVLink transport / command path is reused
  (:mod:`mavlink.command_service`); no second connection is created.
* Actuator commands (motor test) and parameter writes (reverse) are enabled only
  when the link is positively identified as a SITL/test environment: the
  transport is not serial *and* the live parameter cache contains ArduPilot
  ``SIM_*`` parameters.  A physical Pixhawk (serial, or any link without SITL
  evidence) is READ-ONLY.
* Motor-test values are bounded (throttle %, timeout) so no arbitrary output is
  possible.
* ArduPilot's ``DO_MOTOR_TEST`` is self-terminating: the firmware stops the
  motor after ``timeout`` seconds and there is no MAVLink abort.  Cancellation
  is therefore GCS-side session clearing plus a bounded firmware timeout.
* Configured direction (``SERVOx_REVERSED``) is never reported as *physically
  verified*; that requires physical observation.
"""

import threading
import time
from typing import Any, Dict, List, Optional

from core.state import get_vehicle_status
from mavlink import command_service
from mavlink.parameter_manager import parameter_manager
from sio import server as sio_server

# MAV_CMD_DO_MOTOR_TEST (common.xml). Params:
#   1 instance (motor number, 1-based)   2 throttle type (0 = percent)
#   3 throttle (percent)                 4 timeout (s)
#   5 motor count                        6 test order
MAV_CMD_DO_MOTOR_TEST = 209
MOTOR_TEST_THROTTLE_PERCENT = 0

# Aligned with the QGC-style state vocabulary.
IDLE = "IDLE"
READY = "READY"
TESTING = "TESTING"
STOPPING = "STOPPING"
STOPPED = "STOPPED"
ERROR = "ERROR"
DISCONNECTED = "DISCONNECTED"
UNAVAILABLE = "UNAVAILABLE"

# Bounded SITL test range — never arbitrary unlimited output.
THROTTLE_PCT_MIN = 0.0
THROTTLE_PCT_MAX = 20.0
THROTTLE_PCT_DEFAULT = 5.0
TIMEOUT_S_MIN = 1
TIMEOUT_S_MAX = 10
TIMEOUT_S_DEFAULT = 3

_EVENT = "motor:test"

_lock = threading.RLock()
_state = IDLE
_active_motor: Optional[int] = None
_active_throttle: Optional[float] = None
_active_timeout: Optional[int] = None
_deadline: Optional[float] = None
_timer: Optional[threading.Timer] = None
_last_result: Optional[Dict[str, Any]] = None


# ------------------------------------------------------------------
# Environment / capability
# ------------------------------------------------------------------

def _transport() -> Optional[str]:
    from mavlink.connection_manager import manager

    return manager.connection_type


def _sitl_evidence() -> bool:
    """Positive SITL identification: non-serial transport + live SIM_* params.

    A physical autopilot is never assumed to be testable just because it is
    connected (including a hardware link tunnelled over UDP/TCP telemetry):
    SITL is confirmed only by ArduPilot's own simulation parameters.
    """
    transport = _transport()
    if transport not in ("udp", "tcp"):
        return False
    for entry in parameter_manager.get_all_parameters():
        if str(entry.get("id", "")).startswith("SIM_"):
            return True
    return False


def _environment() -> str:
    from mavlink.connection_manager import manager

    if not get_vehicle_status().get("connected"):
        return "NONE"
    return "SITL" if _sitl_evidence() else "HARDWARE"


def capability() -> Dict[str, Any]:
    """Report whether functional motor testing is available and why."""
    status = get_vehicle_status()
    reasons: List[str] = []
    connected = bool(status.get("connected")) and status.get("connectionState") == "connected"
    if not connected:
        reasons.append("No vehicle connected.")
    if status.get("autopilot") != "ARDUPILOTMEGA":
        reasons.append("Motor setup requires ArduPilot.")
    from services.motor_setup_service import COPTER_VEHICLE_TYPES

    if status.get("vehicleType") not in COPTER_VEHICLE_TYPES:
        reasons.append("Motor setup is available only for ArduCopter in this version.")
    sync = parameter_manager.get_synchronization_state()
    if sync.get("state") != "complete":
        reasons.append("Parameter synchronisation is not complete.")
    environment = _environment()
    if environment != "SITL":
        reasons.append(
            "Motor testing is enabled in the SITL/test environment only; "
            "the connected physical vehicle is read-only."
        )

    supported = not reasons
    with _lock:
        state = _state
    return {
        "supported": supported,
        "environment": environment,
        "readOnly": not supported,
        "reasons": reasons,
        "state": state,
        "bounds": {
            "throttlePctMin": THROTTLE_PCT_MIN,
            "throttlePctMax": THROTTLE_PCT_MAX,
            "throttlePctDefault": THROTTLE_PCT_DEFAULT,
            "timeoutSMin": TIMEOUT_S_MIN,
            "timeoutSMax": TIMEOUT_S_MAX,
            "timeoutSDefault": TIMEOUT_S_DEFAULT,
        },
    }


# ------------------------------------------------------------------
# Discovery (single source of truth: the live SERVOx_FUNCTION cache)
# ------------------------------------------------------------------

def discover_motors() -> List[Dict[str, Any]]:
    """Return the live motor channels (motor number -> output) from the params."""
    from services.motor_setup_service import get_motor_setup

    return list(get_motor_setup("motors").get("motors", []))


def _find_motor(motor_number: int) -> Optional[Dict[str, Any]]:
    for motor in discover_motors():
        if motor.get("motorNumber") == motor_number:
            return motor
    return None


# ------------------------------------------------------------------
# Snapshot / state
# ------------------------------------------------------------------

def _snapshot_locked() -> Dict[str, Any]:
    remaining_ms = None
    if _deadline is not None:
        remaining_ms = max(0, int((_deadline - time.time()) * 1000))
    return {
        "state": _state,
        "activeMotor": _active_motor,
        "activeThrottlePct": _active_throttle,
        "activeTimeoutS": _active_timeout,
        "remainingMs": remaining_ms,
        "lastResult": _last_result,
    }


def snapshot() -> Dict[str, Any]:
    with _lock:
        return {**capability(), **_snapshot_locked()}


def _emit() -> None:
    try:
        sio_server.emit(_EVENT, snapshot())
    except Exception:  # noqa: BLE001 - events must never break the request path
        pass


def _set_result(success: bool, message: str, **extra: Any) -> Dict[str, Any]:
    global _last_result
    _last_result = {"success": success, "message": message, **extra}
    return _last_result


def _cancel_timer_locked() -> None:
    global _timer
    if _timer is not None:
        try:
            _timer.cancel()
        except Exception:  # noqa: BLE001
            pass
        _timer = None


def _clear_active_locked() -> None:
    global _active_motor, _active_throttle, _active_timeout, _deadline
    _active_motor = None
    _active_throttle = None
    _active_timeout = None
    _deadline = None


# ------------------------------------------------------------------
# Individual motor test
# ------------------------------------------------------------------

def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def start_test(motor_number: int, throttle_pct: Optional[float] = None,
               timeout_s: Optional[int] = None) -> Dict[str, Any]:
    """Validate, then issue a bounded ArduCopter DO_MOTOR_TEST for one motor."""
    global _state, _active_motor, _active_throttle, _active_timeout, _deadline, _timer

    cap = capability()
    if not cap["supported"]:
        with _lock:
            _state = UNAVAILABLE if cap["environment"] == "HARDWARE" else _state
            result = _set_result(False, cap["reasons"][0] if cap["reasons"] else "Motor testing unavailable.")
            _emit()
        return {**cap, **result, "success": False}

    status = get_vehicle_status()
    if status.get("armed"):
        with _lock:
            result = _set_result(False, "Vehicle is armed; motor testing requires a disarmed vehicle.")
            _state = ERROR
            _emit()
        return {**cap, **result}

    motor = _find_motor(int(motor_number))
    if motor is None:
        with _lock:
            result = _set_result(False, f"Motor {motor_number} is not present in the connected configuration.")
            _emit()
        return {**cap, **result}

    throttle = _clamp(
        float(throttle_pct) if throttle_pct is not None else THROTTLE_PCT_DEFAULT,
        THROTTLE_PCT_MIN, THROTTLE_PCT_MAX,
    )
    timeout = int(_clamp(
        float(timeout_s) if timeout_s is not None else TIMEOUT_S_DEFAULT,
        TIMEOUT_S_MIN, TIMEOUT_S_MAX,
    ))

    with _lock:
        if _state == TESTING:
            return {**cap, "success": False, "message": "A motor test is already running."}
        _state = TESTING
        _active_motor = int(motor_number)
        _active_throttle = throttle
        _active_timeout = timeout
        _deadline = None
    _emit()

    # Reuse the existing command path + ACK correlation. No second MAVLink
    # connection and no custom command.
    ack = command_service.wait_for_command_ack(
        MAV_CMD_DO_MOTOR_TEST,
        send_fn=lambda: command_service.send_command_long(
            MAV_CMD_DO_MOTOR_TEST,
            float(motor_number),          # param1 instance (motor number)
            float(MOTOR_TEST_THROTTLE_PERCENT),  # param2 throttle type
            float(throttle),              # param3 throttle %
            float(timeout),               # param4 timeout s
            1.0,                          # param5 motor count
            0.0,                          # param6 test order
        ),
    )

    if not ack.get("success"):
        with _lock:
            _cancel_timer_locked()
            _clear_active_locked()
            _state = ERROR
            result = _set_result(
                False,
                f"Motor test command rejected: {ack.get('ackLabel', 'UNKNOWN')}",
                ackCode=ack.get("ackCode"), ackLabel=ack.get("ackLabel"),
            )
            _emit()
        return {**cap, **snapshot(), **result}

    with _lock:
        _deadline = time.time() + timeout
        _cancel_timer_locked()
        _timer = threading.Timer(timeout + 0.5, _auto_stop)
        _timer.daemon = True
        _timer.start()
        result = _set_result(
            True,
            f"Motor {motor_number} test running at {throttle:g}% for {timeout}s.",
            motor=motor_number, output=motor.get("channel"), throttlePct=throttle, timeoutS=timeout,
        )
        _emit()
    return {**cap, **snapshot(), **result}


def _auto_stop() -> None:
    """Firmware timeout elapsed: return to STOPPED and notify."""
    global _state
    with _lock:
        if _state != TESTING:
            return
        _cancel_timer_locked()
        _clear_active_locked()
        _state = STOPPED
        _set_result(True, "Motor test completed (firmware timeout).")
        _emit()


def stop_test() -> Dict[str, Any]:
    """GCS-side stop. ArduPilot has no DO_MOTOR_TEST abort, so the bounded
    firmware timeout ends the output; this clears the tracked session."""
    global _state
    with _lock:
        if _state != TESTING:
            return {**snapshot(), "success": False, "message": "No motor test is running."}
        _state = STOPPING
        _cancel_timer_locked()
        _clear_active_locked()
        _state = STOPPED
        _set_result(True, "Motor test stopped.")
        _emit()
        return {**snapshot(), "success": True, "message": "Motor test stopped."}


def set_reverse(motor_number: int, reversed_on: bool) -> Dict[str, Any]:
    """Stage/apply SERVOx_REVERSED for one motor's output (SITL only).

    The write goes through the existing parameter manager (PARAM_SET +
    PARAM_VALUE echo verification).  Physical direction is never claimed as
    verified.
    """
    cap = capability()
    if not cap["supported"]:
        return {**cap, "success": False,
                "message": cap["reasons"][0] if cap["reasons"] else "Reverse configuration is read-only."}
    motor = _find_motor(int(motor_number))
    if motor is None:
        return {**cap, "success": False,
                "message": f"Motor {motor_number} is not present in the connected configuration."}

    param_id = f"SERVO{int(motor['channel'])}_REVERSED"
    result = parameter_manager.set_parameter(param_id, 1 if reversed_on else 0)
    success = result.get("status") == "success"
    _emit()
    return {
        **cap,
        "success": success,
        "motor": int(motor_number),
        "output": motor.get("channel"),
        "paramId": param_id,
        "configured": bool(reversed_on) if success else None,
        "configuredValue": result.get("value") if success else None,
        "physicallyVerified": False,
        "message": result.get("message", ""),
        "parameterStatus": result.get("status"),
    }


def reverse_states() -> List[Dict[str, Any]]:
    """Read SERVOx_REVERSED for each discovered motor (configuration only)."""
    out: List[Dict[str, Any]] = []
    for motor in discover_motors():
        param_id = f"SERVO{int(motor['channel'])}_REVERSED"
        entry = parameter_manager.get_parameter(param_id)
        value = entry.get("value") if entry else None
        out.append({
            "motor": motor.get("motorNumber"),
            "output": motor.get("channel"),
            "paramId": param_id,
            "configured": None if value is None else bool(int(value)),
            "physicallyVerified": False,
        })
    return out


# ------------------------------------------------------------------
# Connection lifecycle hooks (called by the connection manager)
# ------------------------------------------------------------------

def notify_connection_lost(reason: str = "connection_lost") -> None:
    global _state
    with _lock:
        _cancel_timer_locked()
        _clear_active_locked()
        _state = DISCONNECTED
        _set_result(False, "Connection lost during motor testing.")
        _emit()


def reset_for_fresh_link() -> None:
    """Fresh link: return to IDLE; motor outputs are rediscovered on demand."""
    global _state, _last_result
    with _lock:
        _cancel_timer_locked()
        _clear_active_locked()
        _state = IDLE
        _last_result = None


def reset_state_for_tests() -> None:
    global _state, _last_result
    with _lock:
        _cancel_timer_locked()
        _clear_active_locked()
        _state = IDLE
        _last_result = None
