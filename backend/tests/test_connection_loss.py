"""Tests for the Phase 8C heartbeat-loss fix.

Covers the authoritative DISCONNECTED semantics on a heartbeat timeout:
- watchdog flips to fully disconnected (parameter session detached, stale
  telemetry zeroed, calibration wizards reset, `connection_state` event),
- a resumed heartbeat auto-reconnects (param session re-bound, CONNECTED
  event with reason), and
- REST parameter writes stay rejected once the link is lost.

`_check_watchdog` / `_mark_connection_lost` / `_on_heartbeat` are exercised
directly so the 2s watchdog cadence never slows the suite down. HTTP write
rejection reuses the same fake-vehicle harness as test_parameter_api.py.
"""

import time

import pytest
from unittest.mock import patch

from core.state import telemetry, vehicle_state
from mavlink import connection_manager as cm
from mavlink.parameter_manager import parameter_manager
from tests.test_parameter_api import FAST_CONFIG, body
from tests.test_parameter_manager import make_vehicle


@pytest.fixture(autouse=True)
def _clean_state():
    from core.state import reset_telemetry, vehicle_state

    vsnapshot = dict(vehicle_state)
    tsnapshot = dict(telemetry)
    manager = cm.manager
    running = manager._running
    first = manager._first_heartbeat
    was_lost = manager._was_lost
    manager._running = False
    manager._first_heartbeat = True
    manager._was_lost = False
    try:
        yield
    finally:
        reset_telemetry()
        vehicle_state.clear()
        vehicle_state.update(vsnapshot)
        telemetry.clear()
        telemetry.update(tsnapshot)
        manager._running = running
        manager._first_heartbeat = first
        manager._was_lost = was_lost


def _connected_state(stale_ms: int = 0):
    vehicle_state["connected"] = True
    vehicle_state["connectionState"] = "connected"
    vehicle_state["disconnectReason"] = None
    vehicle_state["lastHeartbeat"] = int(time.time() * 1000) - stale_ms
    vehicle_state["mode"] = "STABILIZE"
    vehicle_state["armed"] = False
    vehicle_state["systemId"] = 1
    vehicle_state["componentId"] = 1
    telemetry["connected"] = True
    telemetry["batteryVoltage"] = 16.4
    telemetry["batteryRemaining"] = 87
    telemetry["satellites"] = 10
    telemetry["gpsFix"] = 3
    telemetry["latitude"] = 12.34
    telemetry["longitude"] = 56.78
    telemetry["mode"] = "STABILIZE"
    telemetry["armed"] = False


class TestWatchdogLoss:
    def test_timeout_marks_fully_disconnected(self):
        cm.manager._running = True
        _connected_state(stale_ms=cm.config.CONNECTION_TIMEOUT_MS + 5000)

        with patch.object(cm.sio_server, "broadcast_connection_state") as bcs, \
             patch.object(cm.sio_server, "broadcast_vehicle_status"), \
             patch("services.calibration_service.reset_session") as reset_sess:
            assert cm.manager._check_watchdog() is True

        assert vehicle_state["connected"] is False
        assert vehicle_state["connectionState"] == "disconnected"
        assert vehicle_state["disconnectReason"] == "heartbeat_timeout"
        assert vehicle_state["mode"] == "DISCONNECTED"
        assert vehicle_state["armed"] is False
        assert vehicle_state["gpsFix"] == 0
        assert vehicle_state["satellites"] == 0
        bcs.assert_called_once_with("DISCONNECTED", "heartbeat_timeout")
        reset_sess.assert_called_once()

    def test_timeout_zeroes_stale_telemetry(self):
        cm.manager._running = True
        _connected_state(stale_ms=cm.config.CONNECTION_TIMEOUT_MS + 5000)
        cm.manager._check_watchdog()

        assert telemetry["connected"] is False
        assert telemetry["batteryVoltage"] == 0
        assert telemetry["batteryRemaining"] == 0
        assert telemetry["satellites"] == 0
        assert telemetry["gpsFix"] == 0
        assert telemetry["latitude"] == 0
        assert telemetry["longitude"] == 0
        assert telemetry["mode"] == "DISCONNECTED"
        assert telemetry["timestamp"] == 0

    def test_timeout_detaches_parameter_session(self):
        cm.manager._running = True
        make_vehicle(parameter_manager)
        parameter_manager.start_session()
        parameter_manager.request_all_parameters()
        assert parameter_manager.is_connected() is True

        _connected_state(stale_ms=cm.config.CONNECTION_TIMEOUT_MS + 5000)
        cm.manager._check_watchdog()

        assert parameter_manager.is_connected() is False

    def test_fresh_heartbeat_is_noop(self):
        cm.manager._running = True
        _connected_state(stale_ms=0)
        before = dict(vehicle_state)
        assert cm.manager._check_watchdog() is False
        assert vehicle_state["connected"] is before["connected"]

    def test_not_running_is_noop_even_when_stale(self):
        _connected_state(stale_ms=cm.config.CONNECTION_TIMEOUT_MS + 5000)
        assert cm.manager._check_watchdog() is False
        assert vehicle_state["connected"] is True


class TestAutoReconnect:
    def test_resumed_heartbeat_rebinds_param_session(self):
        # Watchdog already declared the loss (transport kept open).
        cm.manager._running = True
        make_vehicle(parameter_manager)
        parameter_manager.stop_session("heartbeat_timeout")
        assert parameter_manager.is_connected() is False

        vehicle_state["connected"] = True  # handle_heartbeat repopulated this
        with patch.object(cm.manager, "_start_auto_param_download") as download, \
             patch.object(cm.sio_server, "broadcast_connection_state") as bcs:
            cm.manager._first_heartbeat = True
            cm.manager._was_lost = True
            cm.manager._on_heartbeat()

        assert parameter_manager.is_connected() is True
        download.assert_called_once()
        bcs.assert_called_once_with("CONNECTED", reason="reconnected")
        assert cm.manager._was_lost is False
        assert vehicle_state["connectionState"] == "connected"
        assert vehicle_state["disconnectReason"] is None

    def test_first_heartbeat_emits_plain_connected(self):
        cm.manager._running = True
        vehicle_state["connected"] = True
        with patch.object(cm.sio_server, "broadcast_connection_state") as bcs:
            cm.manager._first_heartbeat = False
            cm.manager._heartbeat_event.clear()
            cm.manager._on_heartbeat()

        assert cm.manager._first_heartbeat is True
        assert cm.manager._heartbeat_event.is_set()
        bcs.assert_called_once_with("CONNECTED")
        assert vehicle_state["connectionState"] == "connected"

    def test_watchdog_to_reconnect_roundtrip(self):
        cm.manager._running = True
        make_vehicle(parameter_manager)
        parameter_manager.start_session()
        parameter_manager.request_all_parameters()
        _connected_state(stale_ms=cm.config.CONNECTION_TIMEOUT_MS + 5000)

        cm.manager._check_watchdog()
        assert vehicle_state["connected"] is False
        assert parameter_manager.is_connected() is False

        vehicle_state["connected"] = True
        with patch.object(cm.manager, "_start_auto_param_download"), \
             patch.object(cm.sio_server, "broadcast_connection_state"):
            cm.manager._first_heartbeat = True
            cm.manager._on_heartbeat()

        assert vehicle_state["connected"] is True
        assert vehicle_state["connectionState"] == "connected"
        assert parameter_manager.is_connected() is True


class TestTeardownReason:
    def test_transport_loss_surfaces_reason(self):
        cm.manager._teardown("Transport lost — device unplugged or link reset")
        assert vehicle_state["connected"] is False
        assert vehicle_state["connectionState"] == "disconnected"
        assert vehicle_state["disconnectReason"] == "Transport lost — device unplugged or link reset"
        assert vehicle_state["lastHeartbeat"] == 0
        assert parameter_manager.is_connected() is False

    def test_explicit_stop_surfaces_reason(self):
        cm.manager._teardown("Connection closed")
        assert vehicle_state["disconnectReason"] == "Connection closed"

    def test_explicit_stop_broadcasts_and_zeros_stale_radio_data(self):
        """An explicit disconnect (or an instant transport loss right after a
        heartbeat) must broadcast DISCONNECTED, zero stale RC telemetry and
        reset the radio calibration wizard — never leave a Radio page holding
        stale values as current (Phase 8E disconnect audit)."""
        from services.radio_calibration import get_calibration_machine_status

        _connected_state(stale_ms=0)
        telemetry["rcRssi"] = 73
        telemetry["rcChannels"] = [1500, 1500, 1500]
        from services.radio_calibration import _machine

        with _machine._lock:
            _machine._state = "capturing-center"
            _machine._phase = "center"

        with patch.object(cm.sio_server, "broadcast_connection_state") as bcs, \
             patch.object(cm.sio_server, "broadcast_vehicle_status") as bvs, \
             patch.object(cm.sio_server, "emit") as emit:
            cm.manager._teardown("Connection closed")

        assert vehicle_state["connected"] is False
        assert vehicle_state["connectionState"] == "disconnected"
        assert vehicle_state["disconnectReason"] == "Connection closed"
        assert telemetry["rcRssi"] == 0
        assert telemetry["rcChannels"] == []
        bcs.assert_called_with("DISCONNECTED", "Connection closed")
        bvs.assert_called_once()
        assert any(call.args[0] == "telemetry:update" for call in emit.call_args_list)
        assert get_calibration_machine_status()["state"] == "idle"


class TestHttpWriteRejection:
    @pytest.fixture()
    def client(self):
        from fastapi.testclient import TestClient
        from app import app

        parameter_manager._config.update(FAST_CONFIG)
        vehicle_state["vehicleType"] = "QUADROTOR"
        yield TestClient(app)
        try:
            parameter_manager.stop_session("test shutdown")
        except Exception:  # noqa: BLE001
            pass

    def test_write_rejected_after_heartbeat_loss(self, client):
        make_vehicle(parameter_manager)
        parameter_manager.start_session()
        parameter_manager.request_all_parameters()
        assert parameter_manager.is_connected() is True
        assert client.post("/api/parameters/WP_RADIUS/write",
                           json={"value": 5.0}).status_code == 200

        cm.manager._running = True
        _connected_state(stale_ms=cm.config.CONNECTION_TIMEOUT_MS + 5000)
        cm.manager._check_watchdog()

        resp = client.post("/api/parameters/WP_RADIUS/write", json={"value": 5.0})
        assert resp.status_code == 400
        assert body(resp)["error"]["code"] == "NOT_CONNECTED"