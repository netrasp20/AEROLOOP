"""API tests for CompassMot and compass configuration endpoints."""

import time

import pytest
from fastapi.testclient import TestClient
from unittest.mock import patch


@pytest.fixture
def client():
    from app import app

    return TestClient(app)


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


class TestCompassMotEndpoints:
    def test_capability_disconnected_reports_no_support(self, client):
        with _patch_params({}):
            response = client.get("/api/setup/compassmot/capability")
        assert response.status_code == 200
        body = response.json()
        assert body["success"] is True
        assert body["supported"] is False

    def test_start_requires_connection(self, client):
        response = client.post("/api/setup/compassmot/start", json={})
        assert response.status_code == 400
        assert "disabled for safety" in response.json()["detail"].lower()

    def test_start_is_disabled_without_actuator_commands(self, client):
        from services import calibration_service as cs

        _mock_connected_state()

        with _patch_params({"COMPASS_PMOT_EN": 0.0}), \
             patch.object(cs, "_command_long", return_value=None) as cmd:
            response = client.post(
                "/api/setup/compassmot/start",
                json={"motor": 1, "throttle": 45},
            )

        assert response.status_code == 400
        assert "disabled for safety" in response.json()["detail"].lower()
        cmd.assert_not_called()

    def test_start_unsupported_firmware(self, client):
        from services import calibration_service as cs

        _mock_connected_state()
        with _patch_params({}), \
             patch.object(cs, "_command_long") as cmd:
            response = client.post("/api/setup/compassmot/start", json={})

        cmd.assert_not_called()
        assert response.status_code == 400
        assert "disabled for safety" in response.json()["detail"].lower()

    def test_cancel_without_actuator_session(self, client):
        response = client.post("/api/setup/compassmot/cancel")
        assert response.status_code == 400
        assert "No compass motor test" in response.json()["detail"]

    def test_cancel_without_session(self, client):
        response = client.post("/api/setup/compassmot/cancel")
        assert response.status_code == 400
        assert "No compass motor test" in response.json()["detail"]

    def test_status(self, client):
        with _patch_params({"COMPASS_PMOT_EN": 0.0}):
            response = client.get("/api/setup/compassmot/status")
        assert response.status_code == 200
        body = response.json()
        assert body["active"] is False
        assert "throttle" in body
        assert "interference" in body


class TestCompassConfigurationEndpoints:
    def test_reports_detected_devices(self, client):
        values = {
            "COMPASS_DEV_ID": 97539.0,
            "COMPASS_USE": 1.0,
            "COMPASS_ORIENT": 0.0,
            "COMPASS_EXTERNAL": 0.0,
            "COMPASS_PRIO1_ID": 97539.0,
            "COMPASS_CAL_FIT": 72.0,
            "AHRS_ORIENTATION": 0.0,
            "COMPASS_ENABLE": 1.0,
        }
        with _patch_params(values):
            response = client.get("/api/setup/compass/configuration")

        assert response.status_code == 200
        body = response.json()
        assert body["success"] is True
        assert body["detected"] == 1
        assert body["devices"][0]["name"] == "Internal Compass 1"
        assert body["primaryFit"] == 72.0
        assert body["orientation"]["value"] == 0.0
        assert body["enabled"] == 1.0
