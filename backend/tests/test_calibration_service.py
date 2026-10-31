"""Tests for the accelerometer calibration service (backend).

Validates the ArduPilot accel-cal MAVLink handshake implemented in
services/calibration_service.py with mocked command/transport helpers.
"""

import pytest
from unittest.mock import MagicMock, patch


@pytest.fixture(autouse=True)
def _clean_state():
    from core.state import vehicle_state
    from services.calibration_service import _reset_state

    snapshot = dict(vehicle_state)
    _reset_state()
    yield
    _reset_state()
    vehicle_state.clear()
    vehicle_state.update(snapshot)


def _mock_connected_state():
    from core.state import vehicle_state
    import time

    vehicle_state["serialPortOpen"] = True
    vehicle_state["udpConnected"] = False
    vehicle_state["connected"] = True
    vehicle_state["lastHeartbeat"] = int(time.time() * 1000)
    vehicle_state["armed"] = False
    vehicle_state["systemId"] = 1
    vehicle_state["componentId"] = 1


def _make_cmd_long(command: int, param1: float) -> MagicMock:
    msg = MagicMock()
    msg.get_type.return_value = "COMMAND_LONG"
    msg.get_msgId.return_value = 76
    msg.get_srcSystem.return_value = 1
    msg.get_srcComponent.return_value = 1
    msg.command = command
    msg.param1 = param1
    return msg


def _start_active():
    """Call start_accel_calibration under mocks, injecting the first position
    request so the wizard becomes active without waiting for real telemetry."""
    from services import calibration_service as cs
    from services.calibration_service import _handle_accelcal_command

    def fake_wait(command_id, send_fn=None):
        if send_fn is not None:
            _handle_accelcal_command(_make_cmd_long(42429, 1))
        return {"success": True, "message": "accepted", "ackCode": 0, "ackLabel": "ACCEPTED"}

    with patch.object(cs, "_command_long", return_value=None), \
         patch.object(cs, "wait_for_command_ack", fake_wait):
        return cs.start_accel_calibration()


class TestAccelCalStatus:
    def test_inactive_by_default(self):
        from services.calibration_service import get_calibration_status

        status = get_calibration_status()
        assert status["active"] is False
        assert status["result"] is None

    def test_is_calibration_active_false(self):
        from services.calibration_service import is_calibration_active

        assert is_calibration_active() is False


class TestAccelCalStart:
    def test_start_requires_connected_vehicle(self):
        from services.calibration_service import start_accel_calibration
        from core.state import set_tcp_connected

        set_tcp_connected(False)

        result = start_accel_calibration()
        assert result["success"] is False
        assert "not connected" in result["message"].lower()

    def test_start_rejects_when_armed(self):
        from services.calibration_service import start_accel_calibration

        _mock_connected_state()
        from core.state import vehicle_state

        vehicle_state["armed"] = True
        with patch("services.calibration_service.wait_for_command_ack") as w:
            result = start_accel_calibration()
        w.assert_not_called()
        assert result["success"] is False
        assert "disarm" in result["message"].lower()

    def test_start_uses_param5_full(self):
        from services import calibration_service as cs
        from services.calibration_service import start_accel_calibration

        _mock_connected_state()

        def fake_wait(command_id, send_fn=None):
            assert command_id == 241
            send_fn()  # invoke _command_long at least once
            # inject the first position request so the wizard progresses
            cs._handle_accelcal_command(_make_cmd_long(42429, 1))
            return {"success": True, "message": "accepted", "ackCode": 0, "ackLabel": "ACCEPTED"}

        with patch.object(cs, "_command_long", return_value=None), \
             patch.object(cs, "wait_for_command_ack", fake_wait):
            result = start_accel_calibration()

        assert result["success"] is True
        assert result["step"] == 1
        assert result["label"].lower().startswith("place")

    def test_start_surfaces_gyro_failure(self):
        from services import calibration_service as cs
        from services.calibration_service import start_accel_calibration

        _mock_connected_state()

        with patch.object(
            cs,
            "wait_for_command_ack",
            return_value={"success": False, "message": "rejected", "ackCode": 4, "ackLabel": "FAILED"},
        ):
            result = start_accel_calibration()

        assert result["success"] is False
        assert "gyro" in result["message"].lower()
        assert cs.is_calibration_active() is False

    def test_start_rejection_uses_label(self):
        from services import calibration_service as cs
        from services.calibration_service import start_accel_calibration

        _mock_connected_state()

        with patch.object(
            cs,
            "wait_for_command_ack",
            return_value={"success": False, "message": "rejected", "ackCode": 3, "ackLabel": "UNSUPPORTED"},
        ):
            result = start_accel_calibration()

        assert result["success"] is False
        assert "unsupported" in result["message"].lower()


class TestAccelCalPositionStreaming:
    def test_ignores_unrelated_commands(self):
        from services.calibration_service import _handle_accelcal_command, get_calibration_status

        _handle_accelcal_command(_make_cmd_long(400, 1))
        status = get_calibration_status()
        assert status["active"] is False

    def test_ignores_position_when_inactive(self):
        from services.calibration_service import _handle_accelcal_command, get_calibration_status

        _handle_accelcal_command(_make_cmd_long(42429, 1))
        assert get_calibration_status()["result"] is None


class TestAccelCalSteps:
    def test_deduplicates_repeated_position_requests(self):
        from services import calibration_service as cs
        from services.calibration_service import _handle_accelcal_command

        _mock_connected_state()
        result = _start_active()
        assert result["success"] is True

        # Level already requested during start; a duplicate must be ignored
        with patch.object(cs.sio_server, "emit") as emit:
            _handle_accelcal_command(_make_cmd_long(42429, 1))
            _handle_accelcal_command(_make_cmd_long(42429, 1))
            position_events = [c for c in emit.call_args_list if c[0][0] == "accel_cal:position"]
            assert len(position_events) == 0

    def test_new_position_emits_event(self):
        from services import calibration_service as cs
        from services.calibration_service import _handle_accelcal_command

        _mock_connected_state()
        _start_active()

        with patch.object(cs.sio_server, "emit") as emit:
            _handle_accelcal_command(_make_cmd_long(42429, 2))  # vehicle wants RIGHT
            position_events = [c for c in emit.call_args_list if c[0][0] == "accel_cal:position"]
            assert len(position_events) == 1

    def test_position_order_and_confirm_flow(self):
        from services import calibration_service as cs
        from services.calibration_service import (
            _handle_accelcal_command,
            confirm_accel_position,
        )

        _mock_connected_state()
        result = _start_active()
        assert result["success"] is True

        def fake_wait_for_ack(command_id, send_fn=None):
            send_fn()
            return {"success": True, "ackLabel": "ACCEPTED"}

        with patch.object(cs, "_command_long", return_value=None) as cmd:
            with patch.object(cs, "wait_for_command_ack", fake_wait_for_ack) as wfa:
                result = confirm_accel_position(1)
        assert result["success"] is True
        assert cs.is_calibration_active() is True
        # confirm sends MAV_CMD_ACCELCAL_VEHICLE_POS with the confirmed position
        cmd.assert_called_once()
        assert cmd.call_args[0][0] == 42429
        assert cmd.call_args.kwargs["param1"] == 1.0

    def test_confirm_rejects_mismatched_position(self):
        from services import calibration_service as cs
        from services.calibration_service import (
            _handle_accelcal_command,
            confirm_accel_position,
        )

        _mock_connected_state()
        _start_active()
        with patch.object(cs.sio_server, "emit"):
            _handle_accelcal_command(_make_cmd_long(42429, 2))  # vehicle wants RIGHT

        result = confirm_accel_position(1)  # GCS confirms LEVEL — wrong step
        assert result["success"] is False

    def test_confirm_rejects_when_not_running(self):
        from services.calibration_service import confirm_accel_position

        result = confirm_accel_position(1)
        assert result["success"] is False

    def test_confirm_rejects_invalid_position(self):
        from services.calibration_service import confirm_accel_position

        _mock_connected_state()
        _start_active()

        assert confirm_accel_position(99)["success"] is False

    def test_confirm_propagates_vehicle_rejection(self):
        from services import calibration_service as cs
        from services.calibration_service import confirm_accel_position

        _mock_connected_state()
        _start_active()

        with patch.object(cs, "_command_long", return_value=None), \
             patch.object(cs, "wait_for_command_ack", return_value={"success": False, "ackLabel": "FAILED"}):
            result = confirm_accel_position(1)
        assert result["success"] is False


class TestAccelCalResult:
    def test_success_message_ends_wizard(self):
        from services import calibration_service as cs
        from services.calibration_service import _handle_accelcal_command

        _mock_connected_state()
        _start_active()

        with patch.object(cs.sio_server, "emit") as emit:
            _handle_accelcal_command(_make_cmd_long(42429, 16777215))
            result_events = [c for c in emit.call_args_list if c[0][0] == "accel_cal:result"]
            assert result_events and result_events[0][0][1]["result"] == "success"

        assert cs.is_calibration_active() is False

    def test_failure_message_ends_wizard(self):
        from services import calibration_service as cs
        from services.calibration_service import _handle_accelcal_command

        _mock_connected_state()
        _start_active()

        with patch.object(cs.sio_server, "emit") as emit:
            _handle_accelcal_command(_make_cmd_long(42429, 16777216))
            result_events = [c for c in emit.call_args_list if c[0][0] == "accel_cal:result"]
            assert result_events and result_events[0][0][1]["result"] == "failed"

        assert cs.is_calibration_active() is False


class TestAccelCalCancel:
    def test_cancel_when_not_running(self):
        from services.calibration_service import cancel_accel_calibration

        result = cancel_accel_calibration()
        assert result["success"] is False

    def test_cancel_clears_state(self):
        from services import calibration_service as cs
        from services.calibration_service import cancel_accel_calibration

        _mock_connected_state()
        _start_active()
        assert cs.is_calibration_active() is True

        result = cancel_accel_calibration()
        assert result["success"] is True
        assert cs.is_calibration_active() is False


class TestAccelCalReset:
    def test_reset_session_clears_wizard(self):
        from services import calibration_service as cs
        from services.calibration_service import reset_session

        _mock_connected_state()
        _start_active()
        assert cs.is_calibration_active() is True

        reset_session()
        assert cs.is_calibration_active() is False
        assert cs.get_calibration_status()["result"] is None