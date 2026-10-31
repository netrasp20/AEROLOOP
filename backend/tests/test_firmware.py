"""Tests for Phase 8D firmware identification, capability and connection state.

Covers the enriched AUTOPILOT_VERSION pipeline (vehicle/autopilot/board/system/
connection identity), the honest capability report (identification available,
installation NOT implemented), the unsupported-operation surface (no install
endpoint), the connection-state lifecycle (connecting / connected /
disconnected) that drives the QGC-like firmware page states, and decoding
helpers. All transport access is mocked; real values mirror the live Pixhawk1
(ArduCopter 4.7.0, board_version 589824 = type 0 / rev 9).
"""

import time
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient


@pytest.fixture(autouse=True)
def _clean_state():
    from core.state import vehicle_state

    snapshot = dict(vehicle_state)
    yield
    vehicle_state.clear()
    vehicle_state.update(snapshot)


def _mock_connected_state():
    from core.state import vehicle_state

    vehicle_state["serialPortOpen"] = True
    vehicle_state["udpConnected"] = False
    vehicle_state["connected"] = True
    vehicle_state["connectionState"] = "connected"
    vehicle_state["lastHeartbeat"] = int(time.time() * 1000)
    vehicle_state["armed"] = False
    vehicle_state["systemId"] = 1
    vehicle_state["componentId"] = 1
    vehicle_state["vehicleType"] = "QUADROTOR"
    vehicle_state["autopilot"] = "ARDUPILOTMEGA"
    vehicle_state["mode"] = "STABILIZE"


def _version_msg():
    msg = MagicMock()
    msg.flight_sw_version = 0x040700FF  # 4.7.0 Official Release
    msg.middleware_sw_version = 0
    msg.os_sw_version = 0
    msg.board_version = 0x00090000  # type 0, rev 9 (live Pixhawk1 value 589824)
    msg.flight_custom_version = b"1511f271\0rest"
    msg.vendor_id = 4617
    msg.product_id = 22337
    msg.uid = 0xAABB
    return msg


def _run_firmware_request(msg=None, vehicle_type=None, autopilot=None, no_reply=False):
    """Drive request_firmware_info() deterministically.

    Fake manager captures the AUTOPILOT_VERSION listener, sends the request,
    then delivers the simulated reply so the wait resolves synchronously.
    """
    from services import setup_service

    msg = msg if msg is not None else _version_msg()
    _mock_connected_state()
    if vehicle_type is not None:
        from core.state import vehicle_state

        vehicle_state["vehicleType"] = vehicle_type
    if autopilot is not None:
        from core.state import vehicle_state

        vehicle_state["autopilot"] = autopilot

    class FakeConn:
        def __init__(self):
            self.sent = []

        @property
        def mav(self):
            return SimpleNamespace(command_long_send=lambda *a: self.sent.append(a))

    conn = FakeConn()
    calls = []

    def fake_on_packet(msgid, cb):
        calls.append(("register", cb))
        return lambda: None

    def fake_enqueue(fn):
        calls.append(("send", fn))
        fn()  # sends the MAV_CMD_REQUEST_MESSAGE on the fake connection
        register = next(c for c in calls if c[0] == "register")
        if not no_reply:
            register[1](msg)  # deliver the AUTOPILOT_VERSION reply

    fake_manager = SimpleNamespace(
        connection=conn,
        connection_type="serial",
        enqueue=fake_enqueue,
    )

    with (
        patch("services.setup_service.manager", fake_manager),
        patch("services.setup_service.packet_bus.on_packet", side_effect=fake_on_packet),
    ):
        result = setup_service.request_firmware_info()

    return result, conn


class TestFirmwareRequest:
    def test_disconnected_returns_clean_failure(self):
        from services.setup_service import request_firmware_info

        result = request_firmware_info()
        assert result["success"] is False
        assert "not connected" in result["message"].lower()
        assert result["connected"] is False

    def test_parses_full_identity_payload(self):
        result, conn = _run_firmware_request()

        assert result["success"] is True
        assert result["connected"] is True
        assert result["version"] == "4.7.0 (Official Release)"
        assert result["release"] == "Official Release"
        assert result["flightSwVersion"] == 0x040700FF
        assert result["custom"] == "1511f271"
        assert result["boardVersion"] == 589824
        assert result["boardType"] == 0
        assert result["boardRev"] == 9
        assert result["vendorId"] == 4617
        assert result["productId"] == 22337
        assert result["uid"] == "0xaabb"

    def test_enriches_with_live_vehicle_identity(self):
        result, _ = _run_firmware_request()

        assert result["vehicleType"] == "QUADROTOR"
        assert result["vehicle"] == "ArduCopter"
        assert result["autopilot"] == "ARDUPILOTMEGA"
        assert result["autopilotLabel"] == "ArduPilot"
        assert result["systemId"] == 1
        assert result["componentId"] == 1
        assert result["connectionType"] == "USB"

    def test_arducopter_is_marked_supported(self):
        result, _ = _run_firmware_request()
        assert result["supported"] is True
        assert "unsupportedReason" not in result

    def test_non_copter_vehicle_is_reported_verbatim_and_unsupported(self):
        result, _ = _run_firmware_request(vehicle_type="FIXED_WING")
        assert result["vehicle"] == "FIXED_WING"
        assert result["autopilotLabel"] == "ArduPilot"
        assert result["supported"] is False
        assert "ArduCopter" in result["unsupportedReason"]

    def test_px4_is_reported_unsupported(self):
        result, _ = _run_firmware_request(autopilot="PX4 autopilot")
        assert result["autopilotLabel"] == "PX4 autopilot"
        assert result["supported"] is False
        assert "PX4 autopilot" in result["unsupportedReason"]
        assert "ArduCopter" in result["unsupportedReason"]

    def test_unknown_vehicle_type_is_unsupported(self):
        result, _ = _run_firmware_request(vehicle_type="GENERIC")
        assert result["supported"] is False
        assert "GENERIC" in result["unsupportedReason"]
        assert "ArduCopter" in result["unsupportedReason"]

    def test_timeout_reports_error_without_reply(self):
        with patch("services.setup_service.REQUEST_TIMEOUT_S", 0.01):
            result, _ = _run_firmware_request(no_reply=True)
        assert result["success"] is False
        assert "timed out" in result["message"].lower()
        assert result["connected"] is True

    def test_requery_returns_fresh_payload(self):
        first, _ = _run_firmware_request()
        second, _ = _run_firmware_request(
            msg=SimpleNamespace(
                flight_sw_version=0x040A0040,  # 4.10.0 Beta
                middleware_sw_version=0,
                os_sw_version=0,
                board_version=0x00090000,
                flight_custom_version=b"new-tag\0",
                vendor_id=4617,
                product_id=22337,
                uid=0xCCDD,
            )
        )
        assert first["version"] == "4.7.0 (Official Release)"
        assert second["version"] == "4.10.0 (Beta)"
        assert second["custom"] == "new-tag"
        assert second["uid"] == "0xccdd"

    def test_invalid_all_zero_payload_decodes_to_zero_version(self):
        msg = MagicMock()
        msg.flight_sw_version = 0
        msg.middleware_sw_version = 0
        msg.os_sw_version = 0
        msg.board_version = 0
        msg.flight_custom_version = b""
        msg.vendor_id = 0
        msg.product_id = 0
        msg.uid = 0

        result, _ = _run_firmware_request(msg=msg)
        assert result["success"] is True
        assert result["version"] == "0.0.0 (Development)"
        assert result["boardType"] == 0
        assert result["boardRev"] == 0

    def test_sends_request_message_on_reader_thread(self):
        from services.setup_service import AUTOPILOT_VERSION_MSGID, MAV_CMD_REQUEST_MESSAGE

        _, conn = _run_firmware_request()
        assert len(conn.sent) == 1
        sysid, compid, cmd, _, msgid = conn.sent[0][0], conn.sent[0][1], conn.sent[0][2], conn.sent[0][3], conn.sent[0][4]
        assert cmd == MAV_CMD_REQUEST_MESSAGE
        assert msgid == float(AUTOPILOT_VERSION_MSGID)
        assert sysid == 1
        assert compid == 1


class TestFirmwareDecode:
    def test_decode_board_version(self):
        from services.setup_service import _decode_board_version

        assert _decode_board_version(0x00090000) == (0, 9)
        assert _decode_board_version(0x32010000) == (0x32, 1)
        assert _decode_board_version(0) == (0, 0)

    def test_release_label(self):
        from services.setup_service import _firmware_type_label

        assert _firmware_type_label(0x040700FF) == "Official Release"
        assert _firmware_type_label(0x04100040) == "Beta"
        assert _firmware_type_label(0x04040700) == "Development"


class TestFirmwareCapability:
    def test_identification_available_installation_not_implemented(self):
        from services.setup_service import firmware_capability

        cap = firmware_capability()
        assert cap["success"] is True
        assert cap["firmwareIdentification"] == "available"
        # Installation stays unavailable; the catalogue is now real, so its
        # availability reflects the actual cached manifest rather than a
        # hardcoded "unavailable".
        assert cap["firmwareInstallation"] == "not-available"
        assert cap["releaseCatalog"] in ("available", "unavailable")
        assert "disabled for real hardware validation" in cap["installationMessage"]
        assert cap["installation"]["installationState"] == "BLOCKED"
        assert cap["installation"]["blockedOnHardware"] is True

    def test_supported_targets_are_ardupilot_copter_only(self):
        from services.setup_service import firmware_capability

        cap = firmware_capability()
        assert cap["supportedTargets"] == [{"flightStack": "ArduPilot", "vehicle": "Copter"}]
        text = " ".join(f"{t['flightStack']} {t['vehicle']}" for t in cap["supportedTargets"])
        assert "PX4" not in text
        assert "Plane" not in text
        assert "Rover" not in text


class TestFirmwareAPI:
    @pytest.fixture
    def client(self):
        from app import app

        return TestClient(app)

    def test_capability_endpoint(self, client):
        response = client.get("/api/setup/firmware/capability")
        body = response.json()
        assert body["firmwareIdentification"] == "available"
        assert body["firmwareInstallation"] == "not-available"
        assert body["supportedTargets"][0]["flightStack"] == "ArduPilot"

    def test_firmware_disconnected(self, client):
        from core.state import set_tcp_connected, vehicle_state

        set_tcp_connected(False)
        vehicle_state["serialPortOpen"] = False
        vehicle_state["udpConnected"] = False
        vehicle_state["connected"] = False
        vehicle_state["lastHeartbeat"] = 0

        response = client.get("/api/setup/firmware")
        body = response.json()
        assert body["success"] is False
        assert "not connected" in body["message"].lower()

    def test_install_route_refuses_instead_of_flashing(self, client):
        """Flashing is never exposed: the route exists only to refuse truthfully.

        An earlier design had no route at all (404). It now answers with a
        structured refusal so the block is inspectable rather than a missing
        endpoint, and so the simulation path is reachable with no board attached.
        """
        response = client.post("/api/setup/firmware/install", json={})
        assert response.status_code == 200
        body = response.json()
        # An accepted async request is not an installation result.
        assert body["success"] is not True
        assert body["realInstallationAllowed"] is False
        assert body["versionVerified"] is False
        assert body["terminal"] is False
        assert body["state"] in (
            "DETECTING",
            "BLOCKED",
            "NO_DEVICE",
            "FAILED",
            "CONFIRMATION_REQUIRED",
        )


class TestConnectionState:
    def test_state_in_vehicle_status(self):
        from core.state import get_vehicle_status, vehicle_state

        vehicle_state["connectionState"] = "connecting"
        status = get_vehicle_status()
        assert status["connectionState"] == "connecting"

    def test_state_in_socket_payload(self):
        from core.state import vehicle_state
        from sio.server import vehicle_status_payload

        vehicle_state["connectionState"] = "connecting"
        assert vehicle_status_payload()["connectionState"] == "connecting"

    def test_connect_announces_connecting_then_success_is_connected(self):
        from core.state import vehicle_state
        from mavlink.connection_manager import manager
        from services.vehicle_service import connect_vehicle

        captured = {}

        def fake_start(connection_type, host="", port=0, device="", baud=57600):
            captured["during"] = vehicle_state["connectionState"]
            vehicle_state["connectionState"] = "connected"
            return (True, "Connected. HEARTBEAT received.")

        with patch.object(manager, "start", side_effect=fake_start):
            ok, payload, code = connect_vehicle({"connectionType": "serial"})

        assert captured["during"] == "connecting"
        assert ok is True
        assert payload["connected"] is True
        assert vehicle_state["connectionState"] == "connected"

    def test_connect_failure_returns_to_disconnected(self):
        from core.state import vehicle_state
        from mavlink.connection_manager import manager
        from services.vehicle_service import connect_vehicle

        captured = {}

        def fake_start(connection_type, host="", port=0, device="", baud=57600):
            captured["during"] = vehicle_state["connectionState"]
            return (False, "Connection timeout — no HEARTBEAT received.")

        with patch.object(manager, "start", side_effect=fake_start):
            ok, payload, code = connect_vehicle({"connectionType": "serial"})

        assert captured["during"] == "connecting"
        assert ok is False
        assert vehicle_state["connectionState"] == "disconnected"

    def test_disconnect_marks_disconnected(self):
        from core.state import vehicle_state
        from mavlink.connection_manager import manager
        from services.vehicle_service import disconnect_vehicle

        _mock_connected_state()
        # Simulate an active session so stop() runs the full teardown.
        manager._running = True
        try:
            result = disconnect_vehicle()
            assert result["success"] is True
            assert vehicle_state["connectionState"] == "disconnected"
        finally:
            manager._running = False