"""Tests for the QGC-style serial auto-connect watcher (Pixhawk plug detection).

Covers only the unit entry point ``attempt_auto_connect`` (the daemon loop is a
thin poll/cooldown wrapper around it). Transport-level reconnect over UDP is
already covered by test_connection_loss.py.
"""

import mavlink.connection_manager as connection_manager
from core import config, state
from mavlink import serial_autodetect


class _StubManager:
    def __init__(self, running: bool = False, manual_disconnect: bool = False):
        self.running = running
        self.manual_disconnect_requested = manual_disconnect
        self.calls = []

    def start(self, connection_type: str, **kwargs):
        self.calls.append((connection_type, kwargs))
        return True, "connected"


def _patch(monkeypatch, devices, manager):
    monkeypatch.setattr(serial_autodetect, "scan_serial_devices", lambda: devices)
    monkeypatch.setattr(connection_manager, "manager", manager)


def test_no_devices_is_noop(monkeypatch):
    manager = _StubManager()
    _patch(monkeypatch, [], manager)
    serial_autodetect.attempt_auto_connect()
    assert manager.calls == []


def test_skips_when_transport_running(monkeypatch):
    manager = _StubManager(running=True)
    _patch(monkeypatch, ["/dev/ttyACM0"], manager)
    serial_autodetect.attempt_auto_connect()
    assert manager.calls == []


def test_skips_when_already_connected(monkeypatch):
    manager = _StubManager()
    _patch(monkeypatch, ["/dev/ttyACM0"], manager)
    state.vehicle_state["connected"] = True
    try:
        serial_autodetect.attempt_auto_connect()
    finally:
        state.vehicle_state["connected"] = False
    assert manager.calls == []


def test_skips_after_explicit_manual_disconnect(monkeypatch):
    manager = _StubManager(manual_disconnect=True)
    _patch(monkeypatch, ["/dev/ttyACM0"], manager)
    serial_autodetect.attempt_auto_connect()
    assert manager.calls == []


def test_connects_first_serial_device(monkeypatch):
    manager = _StubManager()
    _patch(monkeypatch, ["/dev/ttyACM0"], manager)
    serial_autodetect.attempt_auto_connect()
    assert len(manager.calls) == 1
    kind, kwargs = manager.calls[0]
    assert kind == "serial"
    assert kwargs["device"] == "/dev/ttyACM0"
    assert kwargs["clear_manual_disconnect"] is False


def test_prefers_first_by_id_stable_device(monkeypatch):
    manager = _StubManager()
    _patch(monkeypatch, ["/dev/serial/by-id/usb-ArduPilot_2", "/dev/ttyACM0"], manager)
    serial_autodetect.attempt_auto_connect()
    assert manager.calls[0][1]["device"] == "/dev/serial/by-id/usb-ArduPilot_2"


def test_start_failure_is_graceful(monkeypatch):
    class _Failing(_StubManager):
        def start(self, connection_type: str, **kwargs):
            raise RuntimeError("permission denied")

    manager = _Failing()
    _patch(monkeypatch, ["/dev/ttyACM0"], manager)
    serial_autodetect.attempt_auto_connect()  # must not raise
    assert manager.calls == []


def test_start_scanner_error_is_graceful(monkeypatch):
    manager = _StubManager()

    def boom():
        raise OSError("no serial dir")

    monkeypatch.setattr(serial_autodetect, "scan_serial_devices", boom)
    monkeypatch.setattr(connection_manager, "manager", manager)
    serial_autodetect.attempt_auto_connect()  # must not raise
    assert manager.calls == []


def test_config_default_is_enabled_but_env_off_in_tests():
    # The pytest conftest sets AUTO_CONNECT_SERIAL=false so the daemon can
    # never hijack transports under test on a Pixhawk-equipped workstation.
    assert config.AUTO_CONNECT_SERIAL is False
