"""Tests for the SETUP API (`/api/setup`), YantraYug Vehicle Configuration.

Phase 8A scope: firmware identification via AUTOPILOT_VERSION.
"""

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client():
    from app import app

    return TestClient(app)


class TestSetupAPI:
    def test_firmware_endpoint_exists(self, client):
        """GET /api/setup/firmware should exist (not 404)."""

        response = client.get("/api/setup/firmware")
        assert response.status_code != 404

    def test_firmware_returns_clean_payload_when_disconnected(self, client):
        """Without a vehicle the endpoint should fail gracefully, not crash."""
        from core.state import vehicle_state, set_tcp_connected

        set_tcp_connected(False)
        vehicle_state["serialPortOpen"] = False
        vehicle_state["udpConnected"] = False
        vehicle_state["connected"] = False
        vehicle_state["lastHeartbeat"] = 0

        response = client.get("/api/setup/firmware")
        body = response.json()
        assert body["success"] is False
        assert "not connected" in body["message"].lower()


class TestFirmwareVersionDecode:
    def test_decode_official_release(self):
        from services.setup_service import _decode_flight_sw_version

        # 4.5.7 with type 255 (Official)
        assert _decode_flight_sw_version(0x040507FF) == "4.5.7 (Official Release)"

    def test_decode_beta(self):
        from services.setup_service import _decode_flight_sw_version

        assert _decode_flight_sw_version(0x04100040) == "4.16.0 (Beta)"

    def test_decode_development_type(self):
        from services.setup_service import _decode_flight_sw_version

        assert _decode_flight_sw_version(0x04040700) == "4.4.7 (Development)"

    def test_decode_unknown_type(self):
        from services.setup_service import _decode_flight_sw_version

        assert _decode_flight_sw_version(0x030A0A20) == "3.10.10 (Type 32)"