"""Accelerometer 6-position calibration service for ArduCopter.

Implements the interactive MAVLink wizard (see ArduPilot dev docs
"mavlink-calibration" and AP_AccelCal.cpp):

1. GCS sends MAV_CMD_PREFLIGHT_CALIBRATION (241) with param5 =
   PREFLIGHT_CALIBRATION_ACCELEROMETER_FULL (1). ArduPilot runs a gyro
   calibration internally first — if that fails the command ACKs FAILED and
   no MAV_CMD_ACCELCAL_VEHICLE_POS is ever sent, so the GCS must surface a
   failure instead of hanging on the first orientation.

2. While the wizard runs, ArduPilot streams MAV_CMD_ACCELCAL_VEHICLE_POS
   (42429) as a COMMAND_LONG *to the GCS* with param1 = the position it
   wants next: 1=LEVEL, 2=LEFT, 3=RIGHT, 4=NOSE DOWN, 5=NOSE UP, 6=BACK.

3. The GCS displays the requested orientation and, once the vehicle is
   stationary in that position, sends the same command back with the same
   param1. ArduPilot samples the orientation and moves on.

4. On completion ArduPilot sends MAV_CMD_ACCELCAL_VEHICLE_POS with
   param1 = 16777215 (SUCCESS) or 16777216 (FAILED), then keeps re-sending
   that terminal value until the next calibration starts.

Notes:
- The terminal and repeated position requests are re-sent every ~1s, so the
  service only surfaces a *new* position (or result) to the frontend once.
- There is no MAVLink cancel command for accel calibration (QGC waits for a
  timeout); cancel here clears GCS-side state and stops forwarding requests.
"""

import threading
import time
from typing import Any, Dict, Optional

from core.state import get_vehicle_status, is_vehicle_connected, vehicle_state
from mavlink import packet_bus
from mavlink.command_service import _command_long, wait_for_command_ack
from mavlink.connection_manager import manager
from mavlink.parameter_manager import parameter_manager
from sio import server as sio_server

# ------------------------------------------------------------------
# MAVLink constants
# ------------------------------------------------------------------
MAV_CMD_PREFLIGHT_CALIBRATION = 241
MAV_CMD_ACCELCAL_VEHICLE_POS = 42429

# MAV_CMD_PREFLIGHT_CALIBRATION param5 values
PREFLIGHT_CALIBRATION_ACCELEROMETER_FULL = 1.0
# param1 = gyro, param3 = barometer (1 = run calibration)
PREFLIGHT_CALIBRATION_GYRO = 1.0
PREFLIGHT_CALIBRATION_BAROMETER = 1.0
# param5 = 2 : "board level calibration" (Level Horizon, ArduPilot)
PREFLIGHT_CALIBRATION_BOARD_LEVEL = 2.0

# MAV_CMD_DO_START_MAG_CAL / DO_ACCEPT_MAG_CAL / DO_CANCEL_MAG_CAL (ArduCopter 4.x)
MAV_CMD_DO_START_MAG_CAL = 42424
MAV_CMD_DO_ACCEPT_MAG_CAL = 42425
MAV_CMD_DO_CANCEL_MAG_CAL = 42426

# CompassMot / motor interferences test (hardware-only; SITL supports the
# capability and command handling but cannot measure a physical throttle-curve)
MAV_CMD_DO_MOTOR_TEST = 209
MSGID_COMPASSMOT_STATUS = 177

# MAG_CAL_PROGRESS (191) and MAG_CAL_REPORT (192) message ids
MSGID_MAG_CAL_PROGRESS = 191
MSGID_MAG_CAL_REPORT = 192

# Bounded-timeout message used across every calibration workflow so the UI can
# show an honest "no vehicle response" state instead of hanging forever.
CAL_TIMEOUT_MESSAGE = "Calibration timed out. No response received from vehicle."

MAG_CAL_STATUS: Dict[int, str] = {
    0: "not-started",
    1: "waiting-to-start",
    2: "running-step-one",
    3: "running-step-two",
    4: "success",
    5: "failed",
    6: "bad-orientation",
    7: "bad-radius",
}

MAG_CAL_TERMINAL_STATES = {4, 5, 6, 7}

# ACCELCAL_VEHICLE_POS (param1 of MAV_CMD_ACCELCAL_VEHICLE_POS)
ACCELCAL_VEHICLE_POS_LEVEL = 1
ACCELCAL_VEHICLE_POS_LEFT = 2
ACCELCAL_VEHICLE_POS_RIGHT = 3
ACCELCAL_VEHICLE_POS_NOSEDOWN = 4
ACCELCAL_VEHICLE_POS_NOSEUP = 5
ACCELCAL_VEHICLE_POS_BACK = 6
ACCELCAL_VEHICLE_POS_SUCCESS = 16777215
ACCELCAL_VEHICLE_POS_FAILED = 16777216

ACCELCAL_COMMAND_MSGID = 76  # COMMAND_LONG

ACCELCAL_POSITION_LABELS: Dict[int, str] = {
    ACCELCAL_VEHICLE_POS_LEVEL: "Place the vehicle LEVEL",
    ACCELCAL_VEHICLE_POS_LEFT: "Place the vehicle on its LEFT side",
    ACCELCAL_VEHICLE_POS_RIGHT: "Place the vehicle on its RIGHT side",
    ACCELCAL_VEHICLE_POS_NOSEDOWN: "Place the vehicle NOSE DOWN",
    ACCELCAL_VEHICLE_POS_NOSEUP: "Place the vehicle NOSE UP",
    ACCELCAL_VEHICLE_POS_BACK: "Place the vehicle on its BACK",
}

ACCELCAL_POSITION_ORDER = [
    ACCELCAL_VEHICLE_POS_LEVEL,
    ACCELCAL_VEHICLE_POS_LEFT,
    ACCELCAL_VEHICLE_POS_RIGHT,
    ACCELCAL_VEHICLE_POS_NOSEDOWN,
    ACCELCAL_VEHICLE_POS_NOSEUP,
    ACCELCAL_VEHICLE_POS_BACK,
]

START_ACK_TIMEOUT_MS = 8000
CONFIRM_ACK_TIMEOUT_MS = 8000
POSITION_ATTACK_S = 5.0  # how long to wait for the first position request
POSITION_STALE_S = 8.0   # treat a link as stalled past this gap (informational)

_lock = threading.Lock()
_active = False
_current_step: Optional[int] = None
_result: Optional[str] = None
_last_event_step: Optional[int] = None  # dedup: last step forwarded to frontend
_unsub: Optional[Any] = None

# --- compass (magnetometer) calibration state ---
_mag_active = False
_mag_mask = 0
_mag_cal_status = "idle"
_mag_completion_pct = 0
_mag_result: Optional[str] = None
_mag_unsub_progress: Optional[Any] = None
_mag_unsub_report: Optional[Any] = None


def is_calibration_active() -> bool:
    with _lock:
        return _active


def get_calibration_status() -> Dict[str, Any]:
    with _lock:
        return {
            "active": _active,
            "step": _current_step,
            "label": ACCELCAL_POSITION_LABELS.get(_current_step or 0, None)
            if _current_step else None,
            "result": _result,
        }


def _reset_state() -> None:
    global _active, _current_step, _result, _last_event_step, _unsub
    _active = False
    _current_step = None
    _result = None
    _last_event_step = None
    if _unsub is not None:
        try:
            _unsub()
        except Exception:  # noqa: BLE001
            pass
        _unsub = None


def reset_session() -> None:
    """Called on transport teardown so stale wizards never leak across links."""
    with _lock:
        _reset_state()
        reset_mag_session()
        reset_cmot_session()


def _handle_accelcal_command(msg: Any) -> None:
    """Receive MAV_CMD_ACCELCAL_VEHICLE_POS streamed by the vehicle.

    ArduPilot sends the command as a COMMAND_LONG targeted at the GCS
    (sysid 0 / compid 0); the reader dispatches every COMMAND_LONG to the
    packet bus by msgid, so we filter on the command field.
    """
    if getattr(msg, "command", None) != MAV_CMD_ACCELCAL_VEHICLE_POS:
        return
    position = int(round(getattr(msg, "param1", 0)))

    with _lock:
        global _active, _current_step, _result, _last_event_step
        if not _active:
            return

        if position in ACCELCAL_POSITION_LABELS:
            # Dedup the ~1s repeated request for the same step.
            if position != _last_event_step:
                _last_event_step = position
                _current_step = position
                sio_server.emit("accel_cal:position", {
                    "position": position,
                    "label": ACCELCAL_POSITION_LABELS[position],
                    "order": ACCELCAL_POSITION_ORDER.index(position) + 1,
                    "total": len(ACCELCAL_POSITION_ORDER),
                })
            return

        if position == ACCELCAL_VEHICLE_POS_SUCCESS:
            _result = "success"
            _active = False
            sio_server.emit("accel_cal:result", {"result": "success"})
            _reset_state()
            return

        if position == ACCELCAL_VEHICLE_POS_FAILED:
            _result = "failed"
            _active = False
            sio_server.emit("accel_cal:result", {"result": "failed"})
            _reset_state()
            return


def _subscribe() -> None:
    global _unsub
    if _unsub is None:
        _unsub = packet_bus.on_packet(ACCELCAL_COMMAND_MSGID, _handle_accelcal_command)


def start_accel_calibration() -> Dict[str, Any]:
    """Start the interactive 6-position accelerometer calibration.

    Returns immediately after the start command is accepted and the first
    orientation request is received (so the UI can show "Place vehicle LEVEL").
    """
    if not is_vehicle_connected():
        return {"success": False, "message": "Vehicle is not connected."}

    if vehicle_state["armed"]:
        return {
            "success": False,
            "message": "Disarm the vehicle before calibrating the accelerometer.",
        }

    global _active

    with _lock:
        if _active:
            return {"success": False, "message": "Accelerometer calibration is already running."}
        _reset_state()
        _active = True
        _subscribe()

    print("[ACCEL CAL] >>> Sending MAV_CMD_PREFLIGHT_CALIBRATION param5=FULL")
    ack = wait_for_command_ack(
        MAV_CMD_PREFLIGHT_CALIBRATION,
        send_fn=lambda: _command_long(
            MAV_CMD_PREFLIGHT_CALIBRATION,
            param5=PREFLIGHT_CALIBRATION_ACCELEROMETER_FULL,
        ),
    )

    if not ack["success"]:
        with _lock:
            _reset_state()
        label = ack.get("ackLabel", "REJECTED")
        if label == "FAILED":
            return {
                "success": False,
                "message": (
                    "Calibration start failed — ArduPilot could not calibrate its "
                    "gyros first. Keep the vehicle still and try again."
                ),
            }
        return {
            "success": False,
            "message": f"Calibration start rejected by the vehicle ({label}).",
        }

    print("[ACCEL CAL] Start accepted — waiting for first orientation request")
    # Wait for the first position request so the wizard can show step 1.
    deadline = time.monotonic() + POSITION_ATTACK_S
    while time.monotonic() < deadline:
        with _lock:
            step = _current_step
        if step is not None:
            break
        time.sleep(0.1)

    if step is None:
        with _lock:
            _reset_state()
        return {
            "success": False,
            "message": (
                "Accelerometer calibration started but the vehicle did not request "
                "an orientation. Place the vehicle still and re-run the calibration."
            ),
        }

    return {
        "success": True,
        "message": "Accelerometer calibration started.",
        "active": True,
        "step": step,
        "label": ACCELCAL_POSITION_LABELS[step],
        "order": ACCELCAL_POSITION_ORDER.index(step) + 1,
        "total": len(ACCELCAL_POSITION_ORDER),
    }


def confirm_accel_position(position: int) -> Dict[str, Any]:
    """Confirm the vehicle is in the requested orientation to sample it."""
    global _current_step, _last_event_step

    with _lock:
        if not _active:
            return {"success": False, "message": "No accelerometer calibration is running."}
        current = _current_step

    try:
        position = int(position)
    except (TypeError, ValueError):
        return {"success": False, "message": f"Invalid position: {position!r}"}

    if position not in ACCELCAL_POSITION_LABELS:
        return {"success": False, "message": f"Position {position} is not a valid orientation."}
    if current is not None and position != current:
        return {
            "success": False,
            "message": (
                f"Vehicle is requesting \"{ACCELCAL_POSITION_LABELS[current]}\", "
                f"not position {position}. Confirm the requested orientation."
            ),
        }

    print(f"[ACCEL CAL] >>> Confirming position {position} ({ACCELCAL_POSITION_LABELS[position]})")
    ack = wait_for_command_ack(
        MAV_CMD_ACCELCAL_VEHICLE_POS,
        send_fn=lambda: _command_long(
            MAV_CMD_ACCELCAL_VEHICLE_POS,
            param1=float(position),
        ),
    )

    if not ack["success"]:
        # A rejected confirmation (e.g. vehicle moved) stays in the wizard but
        # must not be forwarded again as a fresh request.
        with _lock:
            _last_event_step = None
        return {
            "success": False,
            "message": f"Position confirmation rejected by the vehicle ({ack.get('ackLabel', 'REJECTED')}).",
        }

    # ArduPilot moves on to the next orientation (or the terminal value); clear
    # the dedup sentinel so the next distinct request is forwarded.
    with _lock:
        _last_event_step = None
        _current_step = None

    return {
        "success": True,
        "message": f"Position {position} sampled.",
    }


def cancel_accel_calibration() -> Dict[str, Any]:
    """Cancel the wizard on the GCS side.

    ArduPilot has no MAVLink cancel for accel calibration; clearing local
    state stops the wizard. A later MAV_CMD_PREFLIGHT_CALIBRATION will either
    restart it or the vehicle times out.
    """
    with _lock:
        if not _active:
            return {"success": False, "message": "No accelerometer calibration is running."}
        _reset_state()
    sio_server.emit("accel_cal:result", {"result": "cancelled"})
    print("[ACCEL CAL] Wizard cancelled (GCS side)")
    return {"success": True, "message": "Accelerometer calibration cancelled."}


# ------------------------------------------------------------------
# Shared guards (used by gyro / baro / level / compass)
# ------------------------------------------------------------------

def _mode_tag() -> str:
    """[HARDWARE] when talking to the real autopilot over serial, else [SITL]."""
    return "[HARDWARE]" if manager.connection_type == "serial" else "[SITL]"


def _require_ready(what: str) -> Optional[Dict[str, Any]]:
    if not is_vehicle_connected():
        return {"success": False, "message": "Vehicle is not connected."}
    if vehicle_state["armed"]:
        return {
            "success": False,
            "message": "Calibration requires the vehicle to be disarmed.",
        }
    return None


def _wait_ack_terminal(command_id: int, send_fn, timeout_s: float) -> Dict[str, Any]:
    """Wait for the final COMMAND_ACK, ignoring intermediate IN_PROGRESS acks.

    ArduPilot acknowledges some long-running calibrations (e.g. gyro) with
    IN_PROGRESS first and a terminal result (ACCEPTED/FAILED/...) afterwards.
    """
    import warnings
    from mavlink.command_service import ACK_TIMEOUT_MS, get_ack_label

    if timeout_s <= 0:
        timeout_s = ACK_TIMEOUT_MS / 1000.0
    done = threading.Event()
    final_ack: Dict[str, Any] = {}
    all_acks: list = []

    def on_ack(msg: Any) -> None:
        if done.is_set():
            return
        if getattr(msg, "command", None) != command_id:
            return
        code = getattr(msg, "result", -1)
        label = get_ack_label(code)
        all_acks.append((code, label))
        if code != 5:  # 5 = IN_PROGRESS: keep waiting for the terminal result
            final_ack["code"] = code
            final_ack["label"] = label
            if code == 0:
                final_ack["success"] = True
                final_ack["message"] = "Command accepted."
            else:
                final_ack["success"] = False
                final_ack["message"] = f"Command rejected: {label}"
            done.set()

    unsub = packet_bus.on_packet(77, on_ack)
    try:
        send_fn()
        got = done.wait(timeout_s)
    finally:
        unsub()

    if not got:
        return {
            "success": False,
            "message": "Command acknowledgment timeout.",
            "ackCode": -1,
            "ackLabel": "TIMEOUT",
            "interimAcks": [{"code": c, "label": l} for c, l in all_acks],
        }
    final_ack["ackCode"] = final_ack.get("code")
    final_ack["ackLabel"] = final_ack.get("label")
    final_ack.pop("code", None)
    final_ack.pop("label", None)
    return dict(final_ack)


def _cal_failure(label: str, noun: str) -> str:
    """Map an ack label to an honest, spec-consistent calibration message."""
    if label == "TIMEOUT":
        return CAL_TIMEOUT_MESSAGE
    return f"{noun} calibration failed: {label}."


# ------------------------------------------------------------------
# Gyroscope calibration
# ------------------------------------------------------------------

def gyro_calibrate() -> Dict[str, Any]:
    """Run MAV_CMD_PREFLIGHT_CALIBRATION param1=1 (gyro calibration)."""
    err = _require_ready("gyro")
    if err:
        return err
    tag = _mode_tag()
    print(f"[GYRO CAL] {tag} >>> Sending MAV_CMD_PREFLIGHT_CALIBRATION param1=GYRO")
    ack = _wait_ack_terminal(
        MAV_CMD_PREFLIGHT_CALIBRATION,
        send_fn=lambda: _command_long(
            MAV_CMD_PREFLIGHT_CALIBRATION,
            param1=PREFLIGHT_CALIBRATION_GYRO,
        ),
        timeout_s=START_ACK_TIMEOUT_MS / 1000.0,
    )
    if not ack["success"]:
        label = ack.get("ackLabel", "REJECTED")
        print(f"[GYRO CAL] {tag} Failed ({label})")
        return {"success": False, "message": _cal_failure(label, "Gyro"), "ackLabel": label}
    print(f"[GYRO CAL] {tag} Completed successfully")
    return {"success": True, "message": "Gyro calibration completed."}


# ------------------------------------------------------------------
# Barometer calibration
# ------------------------------------------------------------------

def baro_calibrate() -> Dict[str, Any]:
    """Run MAV_CMD_PREFLIGHT_CALIBRATION param3=1 (ground pressure / baro)."""
    err = _require_ready("barometer")
    if err:
        return err
    tag = _mode_tag()
    print(f"[BARO CAL] {tag} >>> Sending MAV_CMD_PREFLIGHT_CALIBRATION param3=BAROMETER")
    ack = _wait_ack_terminal(
        MAV_CMD_PREFLIGHT_CALIBRATION,
        send_fn=lambda: _command_long(
            MAV_CMD_PREFLIGHT_CALIBRATION,
            param3=PREFLIGHT_CALIBRATION_BAROMETER,
        ),
        timeout_s=START_ACK_TIMEOUT_MS / 1000.0,
    )
    if not ack["success"]:
        label = ack.get("ackLabel", "REJECTED")
        print(f"[BARO CAL] {tag} Failed ({label})")
        return {"success": False, "message": _cal_failure(label, "Barometer"), "ackLabel": label}
    print(f"[BARO CAL] {tag} Completed successfully")
    return {"success": True, "message": "Barometer calibration completed."}


# ------------------------------------------------------------------
# Level Horizon calibration
# ------------------------------------------------------------------

def level_horizon_calibrate() -> Dict[str, Any]:
    """Run MAV_CMD_PREFLIGHT_CALIBRATION param5=2 (board level / Level Horizon).

    Distinct from the full 6-position accel wizard: ArduPilot performs the
    level calibration directly (single level sample) and ACKs when done.
    """
    err = _require_ready("level horizon")
    if err:
        return err
    tag = _mode_tag()
    print(
        f"[LEVEL CAL] {tag} >>> Sending MAV_CMD_PREFLIGHT_CALIBRATION "
        "param5=BOARD_LEVEL"
    )
    ack = _wait_ack_terminal(
        MAV_CMD_PREFLIGHT_CALIBRATION,
        send_fn=lambda: _command_long(
            MAV_CMD_PREFLIGHT_CALIBRATION,
            param5=PREFLIGHT_CALIBRATION_BOARD_LEVEL,
        ),
        timeout_s=START_ACK_TIMEOUT_MS / 1000.0,
    )
    if not ack["success"]:
        label = ack.get("ackLabel", "REJECTED")
        print(f"[LEVEL CAL] {tag} Failed ({label})")
        if label == "TIMEOUT":
            return {"success": False, "message": CAL_TIMEOUT_MESSAGE, "ackLabel": label}
        if label == "TEMPORARY_REJECTED":
            return {
                "success": False,
                "message": (
                    "Level horizon calibration rejected — the vehicle is not "
                    "level enough to start. Place the vehicle exactly level and "
                    "retry."
                ),
                "ackLabel": label,
            }
        return {
            "success": False,
            "message": f"Level horizon calibration failed: {label}.",
            "ackLabel": label,
        }
    print(f"[LEVEL CAL] {tag} Completed successfully")
    return {"success": True, "message": "Level horizon calibration completed."}


# ------------------------------------------------------------------
# Compass (magnetometer) calibration
# ------------------------------------------------------------------

def _handle_mag_cal_progress(msg: Any) -> None:
    if not _mag_active:
        return
    status = MAG_CAL_STATUS.get(getattr(msg, "cal_status", 0), "unknown")
    pct = getattr(msg, "completion_pct", 0)
    attempt = getattr(msg, "attempt", 0)
    global _mag_cal_status, _mag_completion_pct
    with _lock:
        _mag_cal_status = status
        _mag_completion_pct = pct
    sio_server.emit("compass_cal:progress", {
        "compassId": getattr(msg, "compass_id", 0),
        "calMask": getattr(msg, "cal_mask", 0),
        "status": status,
        "completionPct": pct,
        "attempt": attempt,
        "direction": {
            "x": getattr(msg, "direction_x", 0),
            "y": getattr(msg, "direction_y", 0),
            "z": getattr(msg, "direction_z", 0),
        },
    })
    if status == "success":
        sio_server.emit("compass_cal:result", {
            "result": "ready-to-accept",
            "message": "Calibration finished — accept the result to save it.",
        })


def _handle_mag_cal_report(msg: Any) -> None:
    if not _mag_active:
        return
    status = MAG_CAL_STATUS.get(getattr(msg, "cal_status", 0), "unknown")
    report = {
        "compassId": getattr(msg, "compass_id", 0),
        "calMask": getattr(msg, "cal_mask", 0),
        "status": status,
        "autosaved": bool(getattr(msg, "autosaved", 0)),
        "fitness": getattr(msg, "fitness", 0.0),
        "ofsX": getattr(msg, "ofs_x", 0.0),
        "ofsY": getattr(msg, "ofs_y", 0.0),
        "ofsZ": getattr(msg, "ofs_z", 0.0),
        "scaleFactor": getattr(msg, "scale_factor", 1.0),
    }
    sio_server.emit("compass_cal:report", report)

    terminal = getattr(msg, "cal_status", -1) in MAG_CAL_TERMINAL_STATES
    if terminal:
        global _mag_result
        with _lock:
            _mag_result = "success" if status == "success" else "failed"
            ok = status == "success"
        print(f"[MAG CAL] Report received: {status} for compass {report['compassId']}")
        if ok:
            sio_server.emit("compass_cal:result", {
                "result": "success",
                "message": "Compass calibration saved.",
                "report": report,
            })
        else:
            sio_server.emit("compass_cal:result", {
                "result": "failed",
                "message": f"Compass calibration failed: {status}.",
                "report": report,
            })
        reset_mag_session()


def _subscribe_mag_cal() -> None:
    global _mag_unsub_progress, _mag_unsub_report

    if _mag_unsub_progress is not None:
        return
    _mag_unsub_progress = packet_bus.on_packet(MSGID_MAG_CAL_PROGRESS, _handle_mag_cal_progress)
    _mag_unsub_report = packet_bus.on_packet(MSGID_MAG_CAL_REPORT, _handle_mag_cal_report)


def reset_mag_session() -> None:
    global _mag_active, _mag_mask, _mag_cal_status, _mag_completion_pct, \
        _mag_result, _mag_unsub_progress, _mag_unsub_report
    _mag_active = False
    _mag_mask = 0
    _mag_cal_status = "idle"
    _mag_completion_pct = 0
    _mag_result = None
    for unsub in (_mag_unsub_progress, _mag_unsub_report):
        if unsub is not None:
            try:
                unsub()
            except Exception:  # noqa: BLE001
                pass
    _mag_unsub_progress = None
    _mag_unsub_report = None


def start_compass_calibration(mask: int = 0) -> Dict[str, Any]:
    """Start magnetometer calibration for the requested compasses.

    mask=0 calibrates all detected compasses (ArduPilot standard).
    """
    err = _require_ready("compass")
    if err:
        return err
    tag = _mode_tag()
    global _mag_active, _mag_mask
    with _lock:
        if _mag_active:
            return {"success": False, "message": "Compass calibration is already running."}
        reset_mag_session()
        _mag_active = True
        _mag_mask = int(mask)
        _subscribe_mag_cal()

    print(f"[MAG CAL] {tag} >>> MAV_CMD_DO_START_MAG_CAL mask={_mag_mask}")
    ack = _wait_ack_terminal(
        MAV_CMD_DO_START_MAG_CAL,
        send_fn=lambda: _command_long(MAV_CMD_DO_START_MAG_CAL, param1=float(_mag_mask)),
        timeout_s=START_ACK_TIMEOUT_MS / 1000.0,
    )
    if not ack["success"]:
        print(f"[MAG CAL] {tag} Start failed ({ack.get('ackLabel')})")
        reset_mag_session()
        label = ack.get("ackLabel", "REJECTED")
        if label == "TIMEOUT":
            return {"success": False, "message": CAL_TIMEOUT_MESSAGE, "ackLabel": label}
        message = (
            "Compass calibration is not supported by the connected firmware."
            if label in ("UNSUPPORTED", "COMMAND_UNSUPPORTED_MAV_FRAME")
            else f"Compass calibration start failed: {label}."
        )
        return {"success": False, "message": message, "ackLabel": label}
    print(f"[MAG CAL] {tag} Start accepted — waiting for progress")
    return {
        "success": True,
        "message": "Compass calibration started. Rotate the vehicle slowly.",
        "mask": _mag_mask,
    }


def accept_compass_calibration(mask: int = 0) -> Dict[str, Any]:
    """Save the finished calibration (MAV_CMD_DO_ACCEPT_MAG_CAL)."""
    err = _require_ready("compass")
    if err:
        return err
    tag = _mode_tag()
    if not _mag_active:
        return {"success": False, "message": "No compass calibration is running."}
    print(f"[MAG CAL] {tag} >>> MAV_CMD_DO_ACCEPT_MAG_CAL mask={mask}")
    ack = _wait_ack_terminal(
        MAV_CMD_DO_ACCEPT_MAG_CAL,
        send_fn=lambda: _command_long(MAV_CMD_DO_ACCEPT_MAG_CAL, param1=float(mask)),
        timeout_s=START_ACK_TIMEOUT_MS / 1000.0,
    )
    if not ack["success"]:
        label = ack.get("ackLabel", "REJECTED")
        message = (
            CAL_TIMEOUT_MESSAGE
            if label == "TIMEOUT"
            else f"Accept compass calibration failed: {label}."
        )
        return {
            "success": False,
            "message": message,
            "ackLabel": label,
        }
    print(f"[MAG CAL] {tag} Accepted")
    return {"success": True, "message": "Compass calibration accepted."}


def cancel_compass_calibration(mask: int = 0) -> Dict[str, Any]:
    """Cancel a running calibration (MAV_CMD_DO_CANCEL_MAG_CAL)."""
    err = _require_ready("compass")
    if err:
        return err
    tag = _mode_tag()
    if not _mag_active:
        return {"success": False, "message": "No compass calibration is running."}
    print(f"[MAG CAL] {tag} >>> MAV_CMD_DO_CANCEL_MAG_CAL mask={mask}")
    ack = _wait_ack_terminal(
        MAV_CMD_DO_CANCEL_MAG_CAL,
        send_fn=lambda: _command_long(MAV_CMD_DO_CANCEL_MAG_CAL, param1=float(mask)),
        timeout_s=START_ACK_TIMEOUT_MS / 1000.0,
    )
    reset_mag_session()
    if not ack["success"]:
        label = ack.get("ackLabel", "REJECTED")
        message = (
            CAL_TIMEOUT_MESSAGE
            if label == "TIMEOUT"
            else f"Cancel compass calibration failed: {label}."
        )
        return {
            "success": False,
            "message": message,
            "ackLabel": label,
        }
    print(f"[MAG CAL] {tag} Cancelled")
    sio_server.emit("compass_cal:result", {"result": "cancelled"})
    return {"success": True, "message": "Compass calibration cancelled."}


def get_compass_calibration_status() -> Dict[str, Any]:
    with _lock:
        return {
            "active": _mag_active,
            "mask": _mag_mask,
            "status": _mag_cal_status,
            "completionPct": _mag_completion_pct,
            "result": _mag_result,
        }


# ------------------------------------------------------------------
# Sensor status readback (actual param values from the vehicle)
# ------------------------------------------------------------------

SENSOR_STATUS_PARAMS = {
    "accel": {
        "ids": ["INS_ACC_ID"],
        "offsets": [
            "INS_ACC_OFFSET_X", "INS_ACC_OFFSET_Y", "INS_ACC_OFFSET_Z",
            "INS_ACCOFFS_X", "INS_ACCOFFS_Y", "INS_ACCOFFS_Z",
        ],
    },
    "gyro": {"ids": ["INS_GYR_ID"], "offsets": []},
    "baro": {"ids": ["BARO_PRIMARY"], "offsets": []},
    "compass": {
        "ids": ["COMPASS_DEV_ID", "COMPASS_USE", "COMPASS_ORIENT", "COMPASS_ID"],
        "offsets": ["COMPASS_OFS_X", "COMPASS_OFS_Y", "COMPASS_OFS_Z"],
    },
}

# Device-identity params used to enumerate every detected IMU / baro / compass.
# Each `ids` entry is the primary device id plus any "-n" copies, so the status
# derivation never assumes a fixed number of sensors.
IMU_ACCEL_IDS = ["INS_ACC_ID", "INS_ACC2_ID", "INS_ACC3_ID"]
IMU_GYRO_IDS = ["INS_GYR_ID", "INS_GYR2_ID", "INS_GYR3_ID"]
BARO_DEV_IDS = ["BARO1_DEVID", "BARO2_DEVID", "BARO3_DEVID"]
# COMPASS_DEV_ID, COMPASS_DEV_ID2 ... COMPASS_DEV_ID8
COMPASS_DEV_IDS = [
    "COMPASS_DEV_ID" + ("" if i == 1 else str(i)) for i in range(1, 9)
]
COMPASS_PER_INDEX = {
    1: {"use": "COMPASS_USE", "orient": "COMPASS_ORIENT", "external": "COMPASS_EXTERNAL", "prio": "COMPASS_PRIO1_ID"},
    2: {"use": "COMPASS_USE2", "orient": "COMPASS_ORIENT2", "external": "COMPASS_EXTERN2", "prio": "COMPASS_PRIO2_ID"},
    3: {"use": "COMPASS_USE3", "orient": "COMPASS_ORIENT3", "external": "COMPASS_EXTERN3", "prio": "COMPASS_PRIO3_ID"},
}

COMPASS_CAL_FIT_MIN = 50.0  # ArduPilot documents >= 50% as a healthy fit

COMPASS_ORIENT_NAMES = {
    0: "None", 1: "Yaw45", 2: "Yaw90", 3: "Yaw135", 4: "Yaw180", 5: "Yaw225",
    6: "Yaw270", 7: "Yaw315", 8: "Roll180", 9: "Roll180Yaw45", 10: "Roll180Yaw90",
    11: "Roll180Yaw135", 12: "Pitch180", 13: "Roll180Yaw225", 14: "Roll180Yaw270",
    15: "Roll180Yaw315", 16: "Roll90", 17: "Roll90Yaw45", 18: "Roll90Yaw90",
    19: "Roll90Yaw135", 20: "Roll270", 21: "Roll270Yaw45", 22: "Roll270Yaw90",
    23: "Roll270Yaw135", 24: "Pitch90", 25: "Pitch270", 26: "Pitch180Yaw90",
    27: "Pitch180Yaw270", 28: "Yaw315", 29: "Roll315", 30: "Roll315Yaw45",
    31: "Roll315Yaw90", 32: "Roll315Yaw135", 33: "Pitch90Yaw45", 34: "Pitch90Yaw90",
    35: "Pitch90Yaw135", 36: "Pitch270Yaw45", 37: "Pitch270Yaw90", 38: "Pitch270Yaw135",
}

# Derivations only ever yield one of the spec's differentiated states.
SENSOR_STATUS_NOMENCLATURE = ("calibrated", "not-calibrated", "unsupported", "unknown")


def _read_sensor_params(param_ids: list) -> Dict[str, Any]:
    """Read real parameter values from the vehicle (cached live PARAM_VALUE)."""
    out: Dict[str, Any] = {}
    for pid in param_ids:
        entry = parameter_manager.get_parameter(pid)
        if entry is None:
            out[pid] = {"supported": False, "value": None}
        else:
            out[pid] = {
                "supported": True,
                "value": entry["value"],
                "index": entry["index"],
                "count": entry["count"],
            }
    return out


def _entry_value(entries: Dict[str, Any], pid: str):
    entry = entries.get(pid)
    if entry is None or not entry.get("supported"):
        return None
    return entry.get("value")


def _present_id(entries: Dict[str, Any], ids: list) -> list:
    """Return the device ids that are detected (param supported and non-zero)."""
    present = []
    for pid in ids:
        value = _entry_value(entries, pid)
        if value is not None and float(value) != 0:
            present.append({"paramId": pid, "devid": float(value)})
    return present


def _derive_group_status(ids: list, label: str) -> Dict[str, Any]:
    """Report capability without inventing calibration from device presence."""
    entries = _read_sensor_params(ids)
    supported = [pid for pid in ids if entries.get(pid, {}).get("supported")]
    present = _present_id(entries, ids)
    if not supported:
        status = "unsupported"
    elif present:
        status = "unknown"
    else:
        status = "not-calibrated"
    return {
        "status": status,
        "ids": entries,
        "detected": len(present),
        "devices": present,
    }


def _compass_devices() -> Dict[str, Any]:
    """Enumerate every detected compass from COMPASS_DEV_ID1..8 (never a fixed count)."""
    entries = _read_sensor_params(COMPASS_DEV_IDS)
    devices = []
    for i, pid in enumerate(COMPASS_DEV_IDS, start=1):
        value = _entry_value(entries, pid)
        if value is None or float(value) == 0:
            continue
        extra = COMPASS_PER_INDEX.get(i, {})
        use = _entry_value(_read_sensor_params([extra["use"]]), extra["use"]) if extra else None
        orient = _entry_value(_read_sensor_params([extra["orient"]]), extra["orient"]) if extra else None
        external = _entry_value(_read_sensor_params([extra["external"]]), extra["external"]) if extra else None
        prio = _entry_value(_read_sensor_params([extra["prio"]]), extra["prio"]) if extra else None
        if i <= 3:
            name = f"{'External' if external not in (None, 0) else 'Internal'} Compass {i}"
        else:
            name = f"Extra Compass {i}"
        devices.append({
            "index": i,
            "paramId": pid,
            "devid": float(value),
            "name": name,
            "use": use,
            "useParam": extra.get("use") if extra else None,
            "orient": orient,
            "orientParam": extra.get("orient") if extra else None,
            "orientName": COMPASS_ORIENT_NAMES.get(int(orient), str(orient)) if orient is not None else None,
            "external": external,
            "externalParam": extra.get("external") if extra else None,
            "priority": prio,
            "priorityParam": extra.get("prio") if extra else None,
        })
    return {"entries": entries, "devices": devices, "detected": len(devices)}


def get_compass_configuration() -> Dict[str, Any]:
    """Compass settings + flight controller orientation for the Sensors page.

    Reports only compasses the vehicle actually reported (COMPASS_DEV_IDn != 0),
    plus the live AHRS_ORIENTATION value. Enabling/configuration is written by
    the frontend through the shared verified parameter pipeline, never here.
    """
    identity = get_vehicle_status()
    compass = _compass_devices()
    prio_ids = ["COMPASS_PRIO1_ID", "COMPASS_PRIO2_ID", "COMPASS_PRIO3_ID"]
    prio = _read_sensor_params(prio_ids)
    orientation = _read_sensor_params(["AHRS_ORIENTATION"])
    fit = _entry_value(_read_sensor_params(["COMPASS_CAL_FIT"]), "COMPASS_CAL_FIT")
    return {
        "connected": identity["connected"],
        "enabled": _entry_value(_read_sensor_params(["COMPASS_ENABLE"]), "COMPASS_ENABLE"),
        "devices": compass["devices"],
        "detected": compass["detected"],
        "primaryFit": fit,
        "orientations": prio,
        "orientation": {"supported": orientation["AHRS_ORIENTATION"]["supported"],
                        "value": orientation["AHRS_ORIENTATION"]["value"]},
    }


def get_sensor_status() -> Dict[str, Any]:
    identity = get_vehicle_status()
    sensors: Dict[str, Any] = {}

    accel = _derive_group_status(IMU_ACCEL_IDS, "accelerometer")
    accel["offsets"] = _read_sensor_params(SENSOR_STATUS_PARAMS["accel"]["offsets"])
    sensors["accel"] = accel

    gyro = _derive_group_status(IMU_GYRO_IDS, "gyroscope")
    gyrcal = _entry_value(_read_sensor_params(["INS_GYR_CAL"]), "INS_GYR_CAL")
    gyro["gyroCalFlag"] = gyrcal
    if gyrcal == 1.0:
        gyro["status"] = "calibrated"
    elif gyrcal is not None:
        gyro["status"] = "not-calibrated"
    sensors["gyro"] = gyro

    baro_devs = _raw = _read_sensor_params(BARO_DEV_IDS)
    baro_present = _present_id(baro_devs, BARO_DEV_IDS)
    gnd_press = _entry_value(_read_sensor_params(["BARO1_GND_PRESS"]), "BARO1_GND_PRESS")
    baro = {
        "status": (
            "calibrated"
            if baro_present and gnd_press not in (None, 0.0)
            else "unsupported"
            if not any(baro_devs[pid]["supported"] for pid in BARO_DEV_IDS)
            else "not-calibrated"
        ),
        "ids": baro_devs,
        "offsets": _read_sensor_params(SENSOR_STATUS_PARAMS["baro"]["offsets"]),
        "detected": len(baro_present),
        "gndPress": gnd_press,
    }
    sensors["baro"] = baro

    compass = _compass_devices()
    fit = _entry_value(_read_sensor_params(["COMPASS_CAL_FIT"]), "COMPASS_CAL_FIT")
    ofs = _read_sensor_params(SENSOR_STATUS_PARAMS["compass"]["offsets"])
    has_fit = fit is not None and float(fit) >= COMPASS_CAL_FIT_MIN
    offsets_nonzero = any(
        (_entry_value(ofs, pid) or 0.0) != 0.0 for pid in SENSOR_STATUS_PARAMS["compass"]["offsets"]
    )
    compass_extra = _read_sensor_params(SENSOR_STATUS_PARAMS["compass"]["ids"])
    orient_value = _entry_value(compass_extra, "COMPASS_ORIENT")
    sensors["compass"] = {
        "status": (
            "calibrated"
            if (has_fit or offsets_nonzero)
            else "unsupported"
            if not any(compass_extra[pid]["supported"] for pid in SENSOR_STATUS_PARAMS["compass"]["ids"])
            else "not-calibrated"
        ),
        "ids": compass_extra,
        "offsets": ofs,
        "detected": compass["detected"],
        "devices": compass["devices"],
        "calFit": fit,
        "orientName": COMPASS_ORIENT_NAMES.get(int(orient_value), str(orient_value))
        if orient_value is not None else None,
    }

    trim = _read_sensor_params(["AHRS_TRIM_X", "AHRS_TRIM_Y"])
    trim_x = _entry_value(trim, "AHRS_TRIM_X")
    trim_y = _entry_value(trim, "AHRS_TRIM_Y")
    sensors["level"] = {
        "status": (
            "unsupported"
            if not any(trim[pid]["supported"] for pid in ("AHRS_TRIM_X", "AHRS_TRIM_Y"))
            else "unknown"
        ),
        "ids": trim,
        "offsets": {},
        "trim": {"x": trim_x, "y": trim_y},
    }

    sensors["compassMot"] = compassmot_capability()
    return {
        "connected": identity["connected"],
        "armed": identity["armed"],
        "systemId": identity["systemId"],
        "componentId": identity["componentId"],
        "vehicleType": identity["vehicleType"],
        "autopilot": identity["autopilot"],
        "connectionType": identity["connectionType"],
        "sensors": sensors,
    }


# ------------------------------------------------------------------
# CompassMot (motor interference test, ArduPilot)
# ------------------------------------------------------------------
#
# ArduPilot's COMPASSMOT_STATUS stream + MAV_CMD_DO_MOTOR_TEST are genuine
# MAVLink primitives, but the throttle-vs-magnetic-interference curve can only
# be measured on real hardware. In SITL this implementation performs capability
# detection and command/state handling only — it never claims a physical
# calibration.

_cmot_active = False
_cmot_throttle = 0
_cmot_interference = 0
_cmot_unsub: Optional[Any] = None


def compassmot_capability() -> Dict[str, Any]:
    """Report CompassMot parameters without enabling actuator testing.

    CompassMot requires a physical motor/throttle test. YantraYug deliberately
    does not issue actuator commands from the Sensors page, so availability of
    the firmware parameters is not reported as an executable capability.
    """
    pmot = _read_sensor_params(["COMPASS_PMOT_EN"])
    motct = _read_sensor_params(["COMPASS_MOTCT"])
    enabled = _entry_value(motct, "COMPASS_MOTCT")
    return {
        "supported": False,
        "firmwareSupported": any(e.get("supported") for e in pmot.values()),
        "enabled": enabled,
        "active": _cmot_active,
        "reason": "CompassMot actuator testing is disabled for safety.",
    }


def get_compassmot_status() -> Dict[str, Any]:
    with _lock:
        return {
            **compassmot_capability(),
            "throttle": _cmot_throttle,
            "interference": _cmot_interference,
        }


def _handle_compassmot_status(msg: Any) -> None:
    if not _cmot_active:
        return
    global _cmot_throttle, _cmot_interference
    throttle = getattr(msg, "throttle", 0)
    interference = getattr(msg, "interference", 0)
    with _lock:
        _cmot_throttle = throttle
        _cmot_interference = interference
    sio_server.emit("compassmot:status", {
        "throttle": throttle,
        "interference": interference,
    })


def _subscribe_cmot() -> None:
    global _cmot_unsub
    if _cmot_unsub is None:
        _cmot_unsub = packet_bus.on_packet(MSGID_COMPASSMOT_STATUS, _handle_compassmot_status)


def reset_cmot_session() -> None:
    global _cmot_active, _cmot_throttle, _cmot_interference, _cmot_unsub
    _cmot_active = False
    _cmot_throttle = 0
    _cmot_interference = 0
    if _cmot_unsub is not None:
        try:
            _cmot_unsub()
        except Exception:  # noqa: BLE001
            pass
        _cmot_unsub = None


def conduct_compassmot_test(motor_instance: int = 0, throttle_pct: int = 30) -> Dict[str, Any]:
    """Reject CompassMot rather than issuing an actuator command."""
    return {
        "success": False,
        "message": "CompassMot actuator testing is disabled for safety.",
        "ackLabel": "UNSUPPORTED",
    }


def cancel_compassmot_test() -> Dict[str, Any]:
    """Stop the CompassMot test locally.

    ArduPilot's DO_MOTOR_TEST ramps are self-terminating; there is no MAVLink
    abort, so cancellation clears the GCS-side session and the motor test ends
    on its own timeout.
    """
    with _lock:
        if not _cmot_active:
            return {"success": False, "message": "No compass motor test is running."}
        reset_cmot_session()
    sio_server.emit("compassmot:result", {"result": "cancelled"})
    print("[COMPASSMOT] Test cancelled (GCS side)")
    return {"success": True, "message": "Compass motor test cancelled."}
