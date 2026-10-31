"""API tests for gyro / baro / level / compass / sensor-status endpoints."""

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client():
    from app import app

    return TestClient(app)


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
    import time

    from core.state import vehicle_state

    vehicle_state["serialPortOpen"] = True
    vehicle_state["udpConnected"] = False
    vehicle_state["connected"] = True
    vehicle_state["lastHeartbeat"] = int(time.time() * 1000)
    vehicle_state["armed"] = False
    vehicle_state["systemId"] = 1
    vehicle_state["componentId"] = 1


def _ack(success=True, label="ACCEPTED"):
    return {"success": success, "ackCode": 0 if success else 4, "ackLabel": label}


class TestGyroCalEndpoint:
    def test_requires_connection(self, client):
        response = client.post("/api/setup/gyro-cal")
        assert response.status_code == 400
        assert "not connected" in response.json()["detail"].lower()

    def test_requires_disarmed(self, client):
        from unittest.mock import patch

        from services import calibration_service as cs

        _mock_connected_state()
        from core.state import vehicle_state

        vehicle_state["armed"] = True

        with patch.object(cs, "_command_long") as cmd:
            response = client.post("/api/setup/gyro-cal")
        cmd.assert_not_called()
        assert response.status_code == 400
        assert "disarmed" in response.json()["detail"].lower()

    def test_runs(self, client):
        from unittest.mock import patch

        from services import calibration_service as cs

        _mock_connected_state()

        def fake_wait(command_id, send_fn=None, timeout_s=0):
            send_fn()
            return _ack()

        with patch.object(cs, "_command_long", return_value=None), \
             patch.object(cs, "_wait_ack_terminal", fake_wait):
            response = client.post("/api/setup/gyro-cal")

        assert response.status_code == 200
        assert response.json()["success"] is True


class TestBaroCalEndpoint:
    def test_requires_connection(self, client):
        response = client.post("/api/setup/baro-cal")
        assert response.status_code == 400

    def test_runs(self, client):
        from unittest.mock import patch

        from services import calibration_service as cs

        _mock_connected_state()

        def fake_wait(command_id, send_fn=None, timeout_s=0):
            send_fn()
            return _ack()

        with patch.object(cs, "_command_long", return_value=None), \
             patch.object(cs, "_wait_ack_terminal", fake_wait):
            response = client.post("/api/setup/baro-cal")

        assert response.status_code == 200
        assert response.json()["success"] is True


class TestLevelCalEndpoint:
    def test_requires_connection(self, client):
        response = client.post("/api/setup/level-cal")
        assert response.status_code == 400

    def test_runs(self, client):
        from unittest.mock import patch

        from services import calibration_service as cs

        _mock_connected_state()

        def fake_wait(command_id, send_fn=None, timeout_s=0):
            send_fn()
            return _ack()

        with patch.object(cs, "_command_long", return_value=None), \
             patch.object(cs, "_wait_ack_terminal", fake_wait):
            response = client.post("/api/setup/level-cal")

        assert response.status_code == 200
        assert response.json()["success"] is True


class TestCompassCalEndpoint:
    def test_status_idle(self, client):
        response = client.get("/api/setup/compass-cal/status")
        assert response.status_code == 200
        body = response.json()
        assert body["success"] is True
        assert body["active"] is False

    def test_start_requires_connection(self, client):
        response = client.post("/api/setup/compass-cal/start", json={"mask": 0})
        assert response.status_code == 400

    def test_start_accept_cancel_flow(self, client):
        from unittest.mock import patch

        from services import calibration_service as cs

        _mock_connected_state()

        def fake_wait(command_id, send_fn=None, timeout_s=0):
            send_fn()
            return _ack()

        with patch.object(cs, "_command_long", return_value=None), \
             patch.object(cs, "_wait_ack_terminal", fake_wait):
            start = client.post("/api/setup/compass-cal/start", json={"mask": 0})
            assert start.status_code == 200
            assert start.json()["success"] is True

            status = client.get("/api/setup/compass-cal/status").json()
            assert status["active"] is True

            cancel = client.post("/api/setup/compass-cal/cancel", json={"mask": 0})
            assert cancel.status_code == 200

            status = client.get("/api/setup/compass-cal/status").json()
            assert status["active"] is False

    def test_accept_requires_running(self, client):
        from unittest.mock import patch

        from services import calibration_service as cs

        _mock_connected_state()

        with patch.object(cs, "_command_long", return_value=None), \
             patch.object(cs, "_wait_ack_terminal", _ack):
            response = client.post("/api/setup/compass-cal/accept", json={"mask": 0})

        assert response.status_code == 400
        assert "no compass calibration" in response.json()["detail"].lower()


class TestSensorsStatusEndpoint:
    def test_returns_identity_and_sensors(self, client):
        from unittest.mock import patch

        from core.state import vehicle_state
        from services import calibration_service as cs

        _mock_connected_state()
        vehicle_state["vehicleType"] = "QUADROTOR"
        vehicle_state["autopilot"] = "ARDUPILOTMEGA"

        def fake_get(param_id):
            values = {
                "INS_ACC_OFFSET_X": 1.0, "INS_ACC_OFFSET_Y": 2.0,
                "INS_ACC_OFFSET_Z": 3.0, "COMPASS_OFS_X": 4.0,
            }
            if param_id not in values:
                return None
            return {"id": param_id, "value": values[param_id], "type": "FLOAT",
                    "index": 0, "count": 1, "receivedAt": 1, "received": True}

        with patch.object(cs.parameter_manager, "get_parameter", side_effect=fake_get):
            response = client.get("/api/setup/sensors/status")

        assert response.status_code == 200
        body = response.json()
        assert body["success"] is True
        assert body["connected"] is True
        assert body["vehicleType"] == "QUADROTOR"
        accel_ofs = body["sensors"]["accel"]["offsets"]
        assert accel_ofs["INS_ACC_OFFSET_X"]["value"] == 1.0

    def test_sensors_status_when_disconnected(self, client):
        response = client.get("/api/setup/sensors/status")
        assert response.status_code == 200
        body = response.json()
        assert body["connected"] is False