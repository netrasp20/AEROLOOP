"""Tests for the gyro / baro / level / compass / sensor-status calibration.

Covers MAV_CMD_PREFLIGHT_CALIBRATION variants (gyro param1, baro param3,
level param5) and the DO_START/ACCEPT/CANCEL_MAG_CAL compass flow, plus the
sensor-parameter status readback. All transport/parameter access is mocked.
"""

import time

import pytest
from unittest.mock import MagicMock, patch


@pytest.fixture(autouse=True)
def _clean_state():
    from core.state import vehicle_state
    from services.calibration_service import _reset_state, reset_mag_session

    snapshot = dict(vehicle_state)
    _reset_state()
    reset_mag_session()
    yield
    _reset_state()
    reset_mag_session()
    vehicle_state.clear()
    vehicle_state.update(snapshot)


def _mock_connected_state():
    from core.state import vehicle_state

    vehicle_state["serialPortOpen"] = True
    vehicle_state["udpConnected"] = False
    vehicle_state["connected"] = True
    vehicle_state["lastHeartbeat"] = int(time.time() * 1000)
    vehicle_state["armed"] = False
    vehicle_state["systemId"] = 1
    vehicle_state["componentId"] = 1


def _mock_sitl():
    from services.calibration_service import manager

    manager.connection_type = "udp"


def _mock_hardware():
    from services.calibration_service import manager

    manager.connection_type = "serial"


def _ack(success=True, label="ACCEPTED"):
    return {"success": success, "message": "ok", "ackCode": 0 if success else 4, "ackLabel": label}


def _make_mag_progress(status: int, pct: int = 50):
    msg = MagicMock()
    msg.compass_id = 0
    msg.cal_mask = 255
    msg.cal_status = status
    msg.attempt = 1
    msg.completion_pct = pct
    msg.direction_x = 0.1
    msg.direction_y = 0.2
    msg.direction_z = 0.3
    return msg


def _make_mag_report(status: int, ofs_x=1.0):
    msg = MagicMock()
    msg.compass_id = 0
    msg.cal_mask = 255
    msg.cal_status = status
    msg.autosaved = 1
    msg.fitness = 0.71
    msg.ofs_x = ofs_x
    msg.ofs_y = 2.0
    msg.ofs_z = 3.0
    msg.scale_factor = 1.0
    return msg


class TestGyroCal:
    def test_requires_connection(self):
        from services.calibration_service import gyro_calibrate

        result = gyro_calibrate()
        assert result["success"] is False
        assert "not connected" in result["message"].lower()

    def test_requires_disarmed(self):
        from core.state import vehicle_state
        from services.calibration_service import gyro_calibrate

        _mock_connected_state()
        vehicle_state["armed"] = True
        with patch("services.calibration_service._command_long") as cmd:
            result = gyro_calibrate()
        cmd.assert_not_called()
        assert result["success"] is False
        assert "disarmed" in result["message"].lower()

    def test_sends_param1_gyro(self):
        from services import calibration_service as cs
        from services.calibration_service import gyro_calibrate

        _mock_connected_state()
        _mock_hardware()

        def fake_wait(command_id, send_fn=None, timeout_s=0):
            assert command_id == 241
            send_fn()
            return _ack()

        with patch.object(cs, "_command_long", return_value=None) as cmd, \
             patch.object(cs, "_wait_ack_terminal", fake_wait):
            result = gyro_calibrate()

        assert result["success"] is True
        cmd.assert_called_once()
        assert cmd.call_args.kwargs["param1"] == 1.0

    def test_propagates_vehicle_failure(self):
        from services import calibration_service as cs
        from services.calibration_service import gyro_calibrate

        _mock_connected_state()
        _mock_sitl()

        with patch.object(cs, "_wait_ack_terminal", return_value=_ack(success=False, label="FAILED")):
            result = gyro_calibrate()
        assert result["success"] is False
        assert "FAILED" in result["message"]


class TestBaroCal:
    def test_sends_param3_baro(self):
        from services import calibration_service as cs
        from services.calibration_service import baro_calibrate

        _mock_connected_state()

        def fake_wait(command_id, send_fn=None, timeout_s=0):
            assert command_id == 241
            send_fn()
            return _ack()

        with patch.object(cs, "_command_long", return_value=None) as cmd, \
             patch.object(cs, "_wait_ack_terminal", fake_wait):
            result = baro_calibrate()

        assert result["success"] is True
        cmd.assert_called_once()
        assert cmd.call_args.kwargs["param3"] == 1.0

    def test_requires_connection(self):
        from services.calibration_service import baro_calibrate

        assert baro_calibrate()["success"] is False


class TestLevelCal:
    def test_sends_param5_board_level(self):
        from services import calibration_service as cs
        from services.calibration_service import level_horizon_calibrate

        _mock_connected_state()

        def fake_wait(command_id, send_fn=None, timeout_s=0):
            assert command_id == 241
            send_fn()
            return _ack()

        with patch.object(cs, "_command_long", return_value=None) as cmd, \
             patch.object(cs, "_wait_ack_terminal", fake_wait):
            result = level_horizon_calibrate()

        assert result["success"] is True
        cmd.assert_called_once()
        assert cmd.call_args.kwargs["param5"] == 2.0

    def test_requires_disarmed(self):
        from core.state import vehicle_state
        from services.calibration_service import level_horizon_calibrate

        _mock_connected_state()
        vehicle_state["armed"] = True
        assert level_horizon_calibrate()["success"] is False


class _SwapAckWait:
    """Context manager replacing _wait_ack_terminal with a canned sequence."""
    def __init__(self, results):
        self.results = list(results)
        self._patch = None

    def __enter__(self):
        from services import calibration_service as cs
        self._patch = patch.object(cs, "_wait_ack_terminal", side_effect=self.results)
        self._patch.start()
        return self

    def __exit__(self, *exc):
        if self._patch:
            self._patch.stop()


class TestCompassStart:
    def test_requires_connection(self):
        from services.calibration_service import start_compass_calibration

        assert start_compass_calibration()["success"] is False

    def test_start_sends_mag_cal_command(self):
        from services import calibration_service as cs
        from services.calibration_service import start_compass_calibration

        _mock_connected_state()

        def fake_wait(command_id, send_fn=None, timeout_s=0):
            assert command_id == 42424
            send_fn()
            return _ack()

        with patch.object(cs, "_command_long", return_value=None) as cmd, \
             patch.object(cs, "_wait_ack_terminal", fake_wait):
            result = start_compass_calibration(mask=0)

        assert result["success"] is True
        cmd.assert_called_once()
        assert cmd.call_args[0][0] == 42424
        assert cmd.call_args.kwargs["param1"] == 0.0
        assert cs.get_compass_calibration_status()["active"] is True

    def test_start_reports_unsupported_firmware(self):
        from services import calibration_service as cs
        from services.calibration_service import start_compass_calibration

        _mock_connected_state()

        def fake_wait(command_id, send_fn=None, timeout_s=0):
            send_fn()
            return _ack(success=False, label="UNSUPPORTED")

        with patch.object(cs, "_command_long", return_value=None), \
             patch.object(cs, "_wait_ack_terminal", fake_wait):
            result = start_compass_calibration()

        assert result["success"] is False
        assert "not supported" in result["message"].lower()
        assert cs.get_compass_calibration_status()["active"] is False


class TestCompassProgress:
    def _started(self):
        from services import calibration_service as cs

        def fake_wait(command_id, send_fn=None, timeout_s=0):
            send_fn()
            return _ack()

        _mock_connected_state()
        with patch.object(cs, "_command_long", return_value=None), \
             patch.object(cs, "_wait_ack_terminal", fake_wait):
            cs.start_compass_calibration(mask=0)
        return cs

    def test_progress_emits_events(self):
        cs = self._started()
        from services.calibration_service import _handle_mag_cal_progress

        with patch.object(cs.sio_server, "emit") as emit:
            _handle_mag_cal_progress(_make_mag_progress(status=2, pct=50))
            progress_events = [c for c in emit.call_args_list if c[0][0] == "compass_cal:progress"]
            assert len(progress_events) == 1
            payload = progress_events[0][0][1]
            assert payload["completionPct"] == 50
            assert payload["status"] == "running-step-one"

    def test_success_progress_emits_ready(self):
        cs = self._started()
        from services.calibration_service import _handle_mag_cal_progress

        with patch.object(cs.sio_server, "emit") as emit:
            _handle_mag_cal_progress(_make_mag_progress(status=4, pct=100))
            result_events = [c for c in emit.call_args_list if c[0][0] == "compass_cal:result"]
            assert result_events
            assert result_events[0][0][1]["result"] == "ready-to-accept"

    def test_inactive_ignores_progress(self):
        _mock_connected_state()
        from services import calibration_service as cs
        from services.calibration_service import _handle_mag_cal_progress

        with patch.object(cs.sio_server, "emit") as emit:
            _handle_mag_cal_progress(_make_mag_progress(status=2, pct=50))
            assert len(emit.call_args_list) == 0


class TestCompassAcceptCancel:
    def test_accept_sends_mag_cal_command(self):
        from services import calibration_service as cs
        from services.calibration_service import start_compass_calibration, accept_compass_calibration

        def fake_wait(command_id, send_fn=None, timeout_s=0):
            send_fn()
            return _ack()

        accepted_call = {}

        _mock_connected_state()
        with patch.object(cs, "_command_long", return_value=None) as cmd, \
             patch.object(cs, "_wait_ack_terminal", fake_wait):
            assert start_compass_calibration()["success"] is True
            cmd.reset_mock()
            result = accept_compass_calibration(mask=0)
            accepted_call["calls"] = list(cmd.call_args_list)

        assert result["success"] is True
        assert any(c.args and c.args[0] == 42425 for c in accepted_call["calls"])

    def test_cancel_clears_state(self):
        from services import calibration_service as cs
        from services.calibration_service import start_compass_calibration, cancel_compass_calibration

        def fake_wait(command_id, send_fn=None, timeout_s=0):
            send_fn()
            return _ack()

        cancel_call = {}

        _mock_connected_state()
        with patch.object(cs, "_command_long", return_value=None) as cmd, \
             patch.object(cs, "_wait_ack_terminal", fake_wait):
            assert start_compass_calibration()["success"] is True
            cmd.reset_mock()
            result = cancel_compass_calibration(mask=0)
            cancel_call["calls"] = list(cmd.call_args_list)
            active = cs.get_compass_calibration_status()["active"]

        assert result["success"] is True
        assert active is False
        assert any(c.args and c.args[0] == 42426 for c in cancel_call["calls"])

    def test_accept_requires_running(self):
        from services.calibration_service import accept_compass_calibration

        _mock_connected_state()
        assert accept_compass_calibration()["success"] is False


class TestMagCalReportTerminal:
    def test_success_report_emits_result_and_resets(self):
        from services import calibration_service as cs
        from services.calibration_service import (
            start_compass_calibration,
            _handle_mag_cal_report,
        )

        def fake_wait(command_id, send_fn=None, timeout_s=0):
            send_fn()
            return _ack()

        _mock_connected_state()
        with patch.object(cs, "_command_long", return_value=None), \
             patch.object(cs, "_wait_ack_terminal", fake_wait):
            start_compass_calibration()

        assert cs.get_compass_calibration_status()["active"] is True
        with patch.object(cs.sio_server, "emit") as emit:
            _handle_mag_cal_report(_make_mag_report(status=4, ofs_x=12.0))
            result_events = [c for c in emit.call_args_list if c[0][0] == "compass_cal:result"]
            assert result_events and result_events[0][0][1]["result"] == "success"
            assert cs.get_compass_calibration_status()["active"] is False

    def test_failed_report_emits_failure(self):
        from services import calibration_service as cs
        from services.calibration_service import start_compass_calibration, _handle_mag_cal_report

        def fake_wait(command_id, send_fn=None, timeout_s=0):
            send_fn()
            return _ack()

        _mock_connected_state()
        with patch.object(cs, "_command_long", return_value=None), \
             patch.object(cs, "_wait_ack_terminal", fake_wait):
            start_compass_calibration()

        with patch.object(cs.sio_server, "emit") as emit:
            _handle_mag_cal_report(_make_mag_report(status=5))
            result_events = [c for c in emit.call_args_list if c[0][0] == "compass_cal:result"]
            assert result_events and result_events[0][0][1]["result"] == "failed"

    def test_non_terminal_report_keeps_active(self):
        from services import calibration_service as cs
        from services.calibration_service import start_compass_calibration, _handle_mag_cal_report

        def fake_wait(command_id, send_fn=None, timeout_s=0):
            send_fn()
            return _ack()

        _mock_connected_state()
        with patch.object(cs, "_command_long", return_value=None), \
             patch.object(cs, "_wait_ack_terminal", fake_wait):
            start_compass_calibration()

        with patch.object(cs.sio_server, "emit") as emit:
            _handle_mag_cal_report(_make_mag_report(status=1))
        assert cs.get_compass_calibration_status()["active"] is True


class TestSensorStatus:
    def _patch_params(self, values):
        from services import calibration_service as cs

        def fake_get(param_id):
            v = values.get(param_id)
            if v is None:
                return None
            return {"id": param_id, "value": v, "type": "FLOAT",
                    "index": 0, "count": 1, "receivedAt": time.time(), "received": True}

        return patch.object(cs.parameter_manager, "get_parameter", side_effect=fake_get)

    def test_returns_real_offsets(self):
        from services.calibration_service import get_sensor_status

        _mock_connected_state()

        values = {
            "INS_ACC_ID": 11.0, "INS_ACC_OFFSET_X": 1.0, "INS_ACC_OFFSET_Y": 2.0,
            "INS_ACC_OFFSET_Z": 3.0, "INS_GYR_ID": 12.0, "BARO_PRIMARY": 0.0,
            "COMPASS_DEV_ID": 1448800.0, "COMPASS_USE": 1.0, "COMPASS_ORIENT": 0.0,
            "COMPASS_ID": 0.0, "COMPASS_OFS_X": 4.0, "COMPASS_OFS_Y": 5.0,
            "COMPASS_OFS_Z": 6.0,
        }
        with self._patch_params(values):
            status = get_sensor_status()

        assert status["connected"] is True
        accel_ofs = status["sensors"]["accel"]["offsets"]
        assert accel_ofs["INS_ACC_OFFSET_X"]["value"] == 1.0
        assert accel_ofs["INS_ACC_OFFSET_Z"]["value"] == 3.0
        compass_ofs = status["sensors"]["compass"]["offsets"]
        assert compass_ofs["COMPASS_OFS_Y"]["value"] == 5.0
        assert status["sensors"]["compass"]["orientName"] == "None"

    def test_marks_unsupported_params(self):
        from services.calibration_service import get_sensor_status

        _mock_connected_state()

        with self._patch_params({}):
            status = get_sensor_status()

        accel_ids = status["sensors"]["accel"]["ids"]
        assert accel_ids["INS_ACC_ID"]["supported"] is False
        assert accel_ids["INS_ACC_ID"]["value"] is None


class TestWaitAckTerminal:
    def test_tolerates_in_progress_then_accepted(self):
        import threading
        from services import calibration_service as cs

        sent = []
        in_progress = MagicMock()
        in_progress.command = 241
        in_progress.result = 5
        accepted = MagicMock()
        accepted.command = 241
        accepted.result = 0

        def fake_send():
            sent.append(True)

        with patch.object(cs.packet_bus, "on_packet") as on_packet:
            def fake_reg(msgid, cb):
                threading.Thread(target=lambda: (cb(in_progress), cb(accepted)), daemon=True).start()
                return lambda: None
            on_packet.side_effect = fake_reg

            result = cs._wait_ack_terminal(241, fake_send, timeout_s=2.0)

        assert result["success"] is True
        assert result["ackLabel"] == "ACCEPTED"

    def test_timeout_returns_failure(self):
        from services import calibration_service as cs

        with patch.object(cs.packet_bus, "on_packet", return_value=lambda: None):
            result = cs._wait_ack_terminal(241, lambda: None, timeout_s=0.1)

        assert result["success"] is False
        assert result["ackLabel"] == "TIMEOUT"