"""API tests for the accelerometer calibration endpoints (`/api/setup/accel-cal`)."""

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client():
    from app import app

    return TestClient(app)


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
    import time

    from core.state import vehicle_state

    vehicle_state["serialPortOpen"] = True
    vehicle_state["udpConnected"] = False
    vehicle_state["connected"] = True
    vehicle_state["lastHeartbeat"] = int(time.time() * 1000)
    vehicle_state["armed"] = False
    vehicle_state["systemId"] = 1
    vehicle_state["componentId"] = 1


def _make_cmd_long(param1: float):
    from unittest.mock import MagicMock

    msg = MagicMock()
    msg.get_type.return_value = "COMMAND_LONG"
    msg.get_msgId.return_value = 76
    msg.get_srcSystem.return_value = 1
    msg.get_srcComponent.return_value = 1
    msg.command = 42429
    msg.param1 = param1
    return msg


class TestAccelCalStatusEndpoint:
    def test_status_when_idle(self, client):
        response = client.get("/api/setup/accel-cal/status")
        assert response.status_code == 200
        body = response.json()
        assert body["success"] is True
        assert body["active"] is False


class TestAccelCalStartEndpoint:
    def test_start_requires_connection(self, client):
        from core.state import set_tcp_connected

        set_tcp_connected(False)
        response = client.post("/api/setup/accel-cal/start")
        assert response.status_code == 400
        assert "not connected" in response.json()["detail"].lower()

    def test_start_runs_wizard(self, client):
        from unittest.mock import patch

        from services import calibration_service as cs

        _mock_connected_state()

        def fake_wait(command_id, send_fn=None):
            if send_fn is not None:
                cs._handle_accelcal_command(_make_cmd_long(1))
            return {"success": True, "ackLabel": "ACCEPTED"}

        with patch.object(cs, "_command_long", return_value=None), \
             patch.object(cs, "wait_for_command_ack", fake_wait):
            response = client.post("/api/setup/accel-cal/start")

        assert response.status_code == 200
        body = response.json()
        assert body["success"] is True
        assert body["active"] is True
        assert body["step"] == 1

    def test_start_rejected_returns_400(self, client):
        from unittest.mock import patch

        from services import calibration_service as cs

        _mock_connected_state()

        with patch.object(cs, "_command_long", return_value=None), \
             patch.object(cs, "wait_for_command_ack", return_value={"success": False, "ackLabel": "FAILED"}):
            response = client.post("/api/setup/accel-cal/start")

        assert response.status_code == 400
        assert "gyro" in response.json()["detail"].lower()


class TestAccelCalConfirmEndpoint:
    def test_confirm_position(self, client):
        from unittest.mock import patch

        from services import calibration_service as cs

        _mock_connected_state()

        def fake_wait(command_id, send_fn=None):
            if send_fn is not None:
                cs._handle_accelcal_command(_make_cmd_long(1))
            send_fn()
            return {"success": True, "ackLabel": "ACCEPTED"}

        with patch.object(cs, "_command_long", return_value=None), \
             patch.object(cs, "wait_for_command_ack", fake_wait):
            start_response = client.post("/api/setup/accel-cal/start")
            assert start_response.status_code == 200

            response = client.post("/api/setup/accel-cal/confirm", json={"position": 1})

        assert response.status_code == 200
        assert response.json()["success"] is True

    def test_confirm_rejects_mismatch(self, client):
        from unittest.mock import patch

        from services import calibration_service as cs

        _mock_connected_state()

        with patch.object(cs, "_command_long", return_value=None), \
             patch.object(cs, "wait_for_command_ack", return_value={"success": False, "ackLabel": "FAILED"}):
            # start is rejected, so nothing running -> confirm must 400
            response = client.post("/api/setup/accel-cal/confirm", json={"position": 1})

        assert response.status_code == 400
        assert "no accelerometer calibration" in response.json()["detail"].lower()


class TestAccelCalCancelEndpoint:
    def test_cancel_requires_running(self, client):
        response = client.post("/api/setup/accel-cal/cancel")
        assert response.status_code == 400

    def test_cancel_stops_wizard(self, client):
        from unittest.mock import patch

        from services import calibration_service as cs

        _mock_connected_state()

        def fake_wait(command_id, send_fn=None):
            if send_fn is not None:
                cs._handle_accelcal_command(_make_cmd_long(1))
            return {"success": True, "ackLabel": "ACCEPTED"}

        with patch.object(cs, "_command_long", return_value=None), \
             patch.object(cs, "wait_for_command_ack", fake_wait):
            client.post("/api/setup/accel-cal/start")

        response = client.post("/api/setup/accel-cal/cancel")
        assert response.status_code == 200
        assert response.json()["success"] is True

        status = client.get("/api/setup/accel-cal/status").json()
        assert status["active"] is False