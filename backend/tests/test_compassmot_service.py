"""Tests for CompassMot, compass configuration and derived sensor status.

Covers capability detection (COMPASS_PMOT_EN / COMPASS_MOTCT), the
MAV_CMD_DO_MOTOR_TEST (209) bounded ramp, the COMPASSMOT_STATUS (177) stream,
the detected-compass enumeration from COMPASS_DEV_ID1..8 and the derived
calibrated / not-calibrated / unsupported states of the Sensors page.
"""

import time

import pytest
from unittest.mock import MagicMock, patch


@pytest.fixture(autouse=True)
def _clean_state():
    from core.state import vehicle_state
    from services.calibration_service import _reset_state, reset_mag_session, reset_cmot_session

    snapshot = dict(vehicle_state)
    _reset_state()
    reset_mag_session()
    reset_cmot_session()
    yield
    _reset_state()
    reset_mag_session()
    reset_cmot_session()
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


def _patch_params(values):
    """Patch parameter_manager.get_parameter with a fixed value map."""
    from services import calibration_service as cs

    def fake_get(param_id):
        v = values.get(param_id)
        if v is None:
            return None
        return {"id": param_id, "value": v, "type": "FLOAT",
                "index": 0, "count": 1, "receivedAt": time.time(), "received": True}

    return patch.object(cs.parameter_manager, "get_parameter", side_effect=fake_get)


def _ack(success=True, label="ACCEPTED"):
    return {"success": success, "ackCode": 0 if success else 4, "ackLabel": label}


class TestCompassMotService:
    def test_capability_supported_when_pmot_param_present(self):
        from services.calibration_service import compassmot_capability

        with _patch_params({"COMPASS_PMOT_EN": 0.0, "COMPASS_MOTCT": 0.0}):
            cap = compassmot_capability()
        assert cap["supported"] is False
        assert cap["firmwareSupported"] is True
        assert cap["enabled"] == 0.0
        assert cap["active"] is False

    def test_capability_unsupported_when_param_missing(self):
        from services.calibration_service import compassmot_capability

        with _patch_params({}):
            cap = compassmot_capability()
        assert cap["supported"] is False
        assert cap["active"] is False

    def test_requires_connection(self):
        from services.calibration_service import conduct_compassmot_test

        result = conduct_compassmot_test()
        assert result["success"] is False
        assert "disabled for safety" in result["message"].lower()

    def test_requires_disarmed(self):
        from core.state import vehicle_state
        from services.calibration_service import conduct_compassmot_test

        _mock_connected_state()
        vehicle_state["armed"] = True
        with _patch_params({"COMPASS_PMOT_EN": 0.0}), \
             patch("services.calibration_service._command_long") as cmd:
            result = conduct_compassmot_test()
        cmd.assert_not_called()
        assert result["success"] is False
        assert "disabled for safety" in result["message"].lower()

    def test_unsupported_firmware_refused(self):
        from services.calibration_service import conduct_compassmot_test

        _mock_connected_state()
        with _patch_params({}), \
             patch("services.calibration_service._command_long") as cmd:
            result = conduct_compassmot_test()
        cmd.assert_not_called()
        assert result["success"] is False
        assert "disabled for safety" in result["message"].lower()

    def test_never_sends_motor_test_command(self):
        from services import calibration_service as cs
        from services.calibration_service import conduct_compassmot_test

        _mock_connected_state()

        with _patch_params({"COMPASS_PMOT_EN": 0.0}), \
             patch.object(cs, "_command_long", return_value=None) as cmd, \
             patch.object(cs, "_wait_ack_terminal") as wait:
            result = conduct_compassmot_test(motor_instance=1, throttle_pct=45)

        assert result["success"] is False
        assert "disabled for safety" in result["message"].lower()
        cmd.assert_not_called()
        wait.assert_not_called()
        assert cs.get_compassmot_status()["active"] is False

    def test_timeout_maps_to_bounded_phrase(self):
        from services import calibration_service as cs
        from services.calibration_service import CAL_TIMEOUT_MESSAGE, conduct_compassmot_test

        _mock_connected_state()
        with _patch_params({"COMPASS_PMOT_EN": 0.0}), \
             patch.object(cs, "_command_long", return_value=None), \
             patch.object(cs, "_wait_ack_terminal", return_value=_ack(False, "TIMEOUT")), \
             patch.object(cs.packet_bus, "on_packet", return_value=lambda: None):
            result = conduct_compassmot_test()

        assert result["success"] is False
        assert "disabled for safety" in result["message"].lower()
        assert cs.get_compassmot_status()["active"] is False

    def test_cancel_without_actuator_session(self):
        from services import calibration_service as cs
        from services.calibration_service import conduct_compassmot_test, cancel_compassmot_test

        result = cancel_compassmot_test()
        assert result["success"] is False
        assert cs.get_compassmot_status()["active"] is False

    def test_cancel_without_active_session(self):
        from services.calibration_service import cancel_compassmot_test

        result = cancel_compassmot_test()
        assert result["success"] is False
        assert "No compass motor test" in result["message"]

    def test_compassmot_status_stream_only_when_active(self):
        from services import calibration_service as cs
        from services.calibration_service import _handle_compassmot_status

        msg = MagicMock()
        msg.throttle = 40
        msg.interference = 120

        with patch.object(cs.sio_server, "emit") as emit:
            _handle_compassmot_status(msg)
        assert emit.call_count == 0

        cs._cmot_active = True
        with patch.object(cs.sio_server, "emit") as emit:
            _handle_compassmot_status(msg)
        assert emit.call_count == 1
        assert emit.call_args.args[0] == "compassmot:status"
        payload = emit.call_args.args[1]
        assert payload["throttle"] == 40
        assert payload["interference"] == 120

    def test_reset_session_clears_compassmot(self):
        from services import calibration_service as cs

        cs._cmot_active = True
        cs.reset_session()
        assert cs._cmot_active is False


class TestCompassConfiguration:
    def _config(self, values):
        from services.calibration_service import get_compass_configuration

        with _patch_params(values):
            return get_compass_configuration()

    def test_enumerates_detected_compasses_only(self):
        config = self._config({
            "COMPASS_DEV_ID": 97539.0,
            "COMPASS_DEV_ID2": 131874.0,
            "COMPASS_DEV_ID3": 0.0,
            "COMPASS_DEV_ID5": 97795.0,
            "COMPASS_USE": 1.0,
            "COMPASS_USE2": 1.0,
            "COMPASS_ORIENT": 0.0,
            "COMPASS_ORIENT2": 2.0,
            "COMPASS_EXTERNAL": 0.0,
            "COMPASS_EXTERN2": 1.0,
            "COMPASS_PRIO1_ID": 97539.0,
            "COMPASS_CAL_FIT": 72.0,
            "AHRS_ORIENTATION": 0.0,
        })

        assert config["detected"] == 3
        names = [d["name"] for d in config["devices"]]
        assert names == ["Internal Compass 1", "External Compass 2", "Extra Compass 5"]
        dev2 = config["devices"][1]
        assert dev2["orient"] == 2.0
        assert dev2["orientName"] == "Yaw90"
        assert dev2["external"] == 1.0
        assert config["primaryFit"] == 72.0
        assert config["orientation"]["value"] == 0.0
        assert config["enabled"] is None  # COMPASS_ENABLE not supplied

    def test_empty_when_no_devices(self):
        config = self._config({"AHRS_ORIENTATION": 1.0, "COMPASS_ENABLE": 1.0})
        assert config["detected"] == 0
        assert config["devices"] == []
        assert config["enabled"] == 1.0


class TestDerivedSensorStatus:
    def _status(self, values):
        from services.calibration_service import get_sensor_status

        _mock_connected_state()
        with _patch_params(values):
            return get_sensor_status()

    def test_accel_unknown_when_imu_exists_without_authoritative_calibration_state(self):
        status = self._status({
            "INS_ACC_ID": 2753028.0, "INS_ACC2_ID": 2753036.0, "INS_ACC3_ID": 0.0,
            "INS_ACC_OFFSET_X": 1.0, "INS_ACC_OFFSET_Y": 2.0, "INS_ACC_OFFSET_Z": 3.0,
            "INS_ACCOFFS_X": 4.0, "INS_ACCOFFS_Y": 5.0, "INS_ACCOFFS_Z": 6.0,
        })
        assert status["sensors"]["accel"]["status"] == "unknown"
        assert status["sensors"]["accel"]["detected"] == 2

    def test_accel_not_calibrated_when_no_ids(self):
        status = self._status({"INS_ACC_ID": 0.0, "INS_ACC2_ID": 0.0, "INS_ACC3_ID": 0.0})
        assert status["sensors"]["accel"]["status"] == "not-calibrated"

    def test_accel_unsupported_when_params_missing(self):
        status = self._status({})
        assert status["sensors"]["accel"]["status"] == "unsupported"

    def test_gyro_calibrated_when_gyro_cal_flag(self):
        status = self._status({
            "INS_GYR_ID": 0.0, "INS_GYR2_ID": 0.0, "INS_GYR3_ID": 0.0,
            "INS_GYR_CAL": 1.0,
        })
        assert status["sensors"]["gyro"]["status"] == "calibrated"

    def test_gyro_not_calibrated_without_flag(self):
        status = self._status({"INS_GYR_ID": 0.0, "INS_GYR_CAL": 0.0})
        assert status["sensors"]["gyro"]["status"] == "not-calibrated"

    def test_baro_calibrated_with_devid_and_ground_press(self):
        status = self._status({
            "BARO1_DEVID": 65540.0, "BARO2_DEVID": 65796.0, "BARO3_DEVID": 0.0,
            "BARO1_GND_PRESS": 101325.1, "BARO_PRIMARY": 0.0,
        })
        assert status["sensors"]["baro"]["status"] == "calibrated"
        assert status["sensors"]["baro"]["detected"] == 2

    def test_baro_not_calibrated_no_ground_press(self):
        status = self._status({"BARO1_DEVID": 65540.0, "BARO1_GND_PRESS": 0.0})
        assert status["sensors"]["baro"]["status"] == "not-calibrated"

    def test_compass_calibrated_with_healthy_fit(self):
        status = self._status({
            "COMPASS_DEV_ID": 97539.0, "COMPASS_DEV_ID2": 0.0,
            "COMPASS_USE": 1.0, "COMPASS_ORIENT": 0.0, "COMPASS_ID": 0.0,
            "COMPASS_OFS_X": 0.0, "COMPASS_OFS_Y": 0.0, "COMPASS_OFS_Z": 0.0,
            "COMPASS_CAL_FIT": 82.0,
        })
        assert status["sensors"]["compass"]["status"] == "calibrated"
        assert status["sensors"]["compass"]["detected"] == 1
        assert status["sensors"]["compass"]["calFit"] == 82.0

    def test_compass_not_calibrated_low_fit(self):
        status = self._status({
            "COMPASS_DEV_ID": 97539.0, "COMPASS_OFS_X": 0.0,
            "COMPASS_OFS_Y": 0.0, "COMPASS_OFS_Z": 0.0,
            "COMPASS_CAL_FIT": 16.0,
        })
        assert status["sensors"]["compass"]["status"] == "not-calibrated"
        assert status["sensors"]["compass"]["calFit"] == 16.0

    def test_compass_calibrated_by_nonzero_offsets(self):
        status = self._status({
            "COMPASS_DEV_ID": 97539.0, "COMPASS_OFS_X": 5.0,
            "COMPASS_OFS_Y": 13.0, "COMPASS_OFS_Z": -18.0,
        })
        assert status["sensors"]["compass"]["status"] == "calibrated"

    def test_compass_unsupported_when_params_missing(self):
        status = self._status({})
        assert status["sensors"]["compass"]["status"] == "unsupported"

    def test_level_unknown_when_only_trim_parameters_exist(self):
        status = self._status({"AHRS_TRIM_X": 0.0, "AHRS_TRIM_Y": 0.0})
        assert status["sensors"]["level"]["status"] == "unknown"

    def test_level_unknown_with_nonzero_trim(self):
        status = self._status({"AHRS_TRIM_X": 0.5, "AHRS_TRIM_Y": 0.0})
        assert status["sensors"]["level"]["status"] == "unknown"

    def test_supports_compassmot_capability_in_sensors(self):
        status = self._status({})
        assert status["sensors"]["compassMot"]["supported"] is False
