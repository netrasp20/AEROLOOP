"""Tests for Phase 8E Radio Setup — channel telemetry, signal state, channel
configuration, main-control mapping, validated endpoint writes and the
three-capture calibration machine.

Every assertion is grounded in REAL inputs: RC_CHANNELS telemetry frames, the
ArduPilot parameter cache (RCn_MIN/TRIM/MAX/REVERSED, RCMAP_*), and the
verified parameter write pipeline. Nothing is synthesized.
"""

import time
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient


@pytest.fixture(autouse=True)
def _clean_state():
    from core.state import (
        is_tcp_connected,
        set_tcp_connected,
        telemetry,
        vehicle_state,
    )
    from mavlink.connection_manager import manager
    from services.radio_calibration import _machine

    tkeys = [
        "connected", "vehicleType", "autopilot", "rcChannels", "rcSignal",
        "rcChannelCount", "rcRssi", "rcReceivedAt",
    ]
    t_snapshot = {k: telemetry.get(k) for k in tkeys}
    s_snapshot = dict(vehicle_state)
    # The TCP flag is a core.state module global, not part of vehicle_state, so
    # it has to be snapshotted separately or it leaks between tests.
    tcp_before = is_tcp_connected()
    # manager.connection_type is the authoritative transport and is never reset
    # by the manager, so it must be restored here.
    transport_before = manager.connection_type
    machine_state = {
        "state": _machine._state,
        "busy": _machine._busy,
        "cancel": _machine._cancel,
        "captured": _machine._captured,
        "result": _machine._result,
        "progress": _machine._progress,
    }
    yield
    for k in tkeys:
        telemetry[k] = t_snapshot[k]
    vehicle_state.clear()
    vehicle_state.update(s_snapshot)
    set_tcp_connected(tcp_before)
    manager.connection_type = transport_before
    for k, v in machine_state.items():
        setattr(_machine, "_" + k, v)


@contextmanager
def _mock_transport(connection_type):
    """Pretend the connection manager opened `connection_type`.

    This is the authoritative transport record (ConnectionManager sets
    connection_type once the pymavlink connection object exists). The
    vehicle_state flags are deliberately left in whatever state the test set,
    including a stale serialPortOpen, so the tests prove the reported transport
    comes from the manager and not from the flag-derived proxy.
    """
    from mavlink.connection_manager import manager

    previous = manager.connection_type
    manager.connection_type = connection_type
    try:
        yield
    finally:
        manager.connection_type = previous


def _mock_connected_state(vehicle_type="QUADROTOR", autopilot="ARDUPILOTMEGA"):
    from core.state import telemetry, vehicle_state

    vehicle_state["serialPortOpen"] = True
    vehicle_state["udpConnected"] = False
    vehicle_state["connected"] = True
    vehicle_state["connectionState"] = "connected"
    vehicle_state["lastHeartbeat"] = int(time.time() * 1000)
    vehicle_state["armed"] = False
    vehicle_state["systemId"] = 1
    vehicle_state["componentId"] = 1
    vehicle_state["vehicleType"] = vehicle_type
    vehicle_state["autopilot"] = autopilot
    vehicle_state["mode"] = "STABILIZE"
    telemetry["connected"] = True
    telemetry["vehicleType"] = vehicle_type
    telemetry["autopilot"] = autopilot


def _inject_rc(channels, rssi=255, received_ago=0.0):
    from core.state import telemetry

    telemetry["rcChannels"] = list(channels)
    telemetry["rcChannelCount"] = len(channels)
    telemetry["rcRssi"] = rssi
    telemetry["rcReceivedAt"] = time.time() - received_ago
    telemetry["rcSignal"] = "RECEIVING" if rssi > 0 else "NO_SIGNAL"


class _FakeParamCache:
    """Miniature in-memory PARAM_VALUE cache exposing to_snapshot() entries."""

    def __init__(self):
        self._values = {}

    def set(self, param_id, value):
        self._values[param_id] = value

    def get_parameter(self, param_id):
        value = self._values.get(param_id)
        if value is None:
            return None
        return {"id": param_id, "value": value, "type": "INT32", "writeState": "verified"}


def _fake_rc_frame(channels, rssi=255):
    msg = MagicMock()
    msg.chan = list(channels)
    msg.chancount = len(channels)
    msg.rssi = rssi
    return msg


def _patch_params(values):
    """Patch singleton get_parameter from a param_id -> value dict."""

    def fake(param_id):
        value = values.get(param_id)
        if value is None:
            return None
        return {"id": param_id, "value": value, "type": "INT32"}

    from services.radio_service import parameter_manager

    return patch.object(parameter_manager, "get_parameter", side_effect=fake)


# ---------------------------------------------------------------------------
# RC_CHANNELS telemetry ingestion
# ---------------------------------------------------------------------------


class TestRcChannelTelemetry:
    def test_stores_real_frame_with_signal_receiving(self):
        from mavlink.telemetry_manager import handle_rc_channels
        from core.state import telemetry

        handle_rc_channels(_fake_rc_frame([1500, 1500, 1500, 1500]))
        assert telemetry["rcChannels"] == [1500, 1500, 1500, 1500]
        assert telemetry["rcChannelCount"] == 4
        assert telemetry["rcRssi"] == 255
        assert telemetry["rcSignal"] == "RECEIVING"
        assert telemetry["rcReceivedAt"] > 0

    def test_rssi_zero_means_no_valid_rc_link(self):
        from mavlink.telemetry_manager import handle_rc_channels
        from core.state import telemetry

        handle_rc_channels(_fake_rc_frame([1500, 1500], rssi=0))
        assert telemetry["rcSignal"] == "NO_SIGNAL"

    def test_inactive_channels_are_stored_as_zero(self):
        from mavlink.telemetry_manager import handle_rc_channels
        from core.state import telemetry

        handle_rc_channels(_fake_rc_frame([1500, 0, 1500]))
        assert telemetry["rcChannels"] == [1500, 0, 1500]

    def test_reset_telemetry_clears_rc_state(self):
        from mavlink.telemetry_manager import handle_rc_channels, reset_telemetry
        from core.state import telemetry

        handle_rc_channels(_fake_rc_frame([1500, 1500, 1500]))
        reset_telemetry()
        assert telemetry["rcChannels"] == []
        assert telemetry["rcSignal"] == "UNKNOWN"
        assert telemetry["rcChannelCount"] == 0
        assert telemetry["rcRssi"] == 0
        assert telemetry["rcReceivedAt"] == 0

    def test_stream_requester_requests_rc_channels(self):
        from mavlink.stream_requester import DESIRED_MESSAGES

        rc = next((m for m in DESIRED_MESSAGES if m[0] == 65), None)
        assert rc is not None, "RC_CHANNELS (msgid 65) must be requested"
        assert rc[1] > 0  # a non-zero interval


# ---------------------------------------------------------------------------
# Radio info service
# ---------------------------------------------------------------------------


class TestRadioInfo:
    def test_radio_endpoint_reports_identity_and_support(self, client):
        _mock_connected_state()
        _inject_rc([1500] * 4)

        with _mock_transport("serial"):
            body = client.get("/api/setup/radio").json()
        assert body["success"] is True
        assert body["connected"] is True
        assert body["vehicleType"] == "QUADROTOR"
        assert body["autopilot"] == "ARDUPILOTMEGA"
        assert body["transport"] == "USB"
        assert body["supported"] is True

    def test_disconnected_is_unsupported_not_faked(self, client):
        body = client.get("/api/setup/radio").json()
        assert body["supported"] is False
        assert "No vehicle connected." in body["unsupportedReason"]
        assert body["signal"] == "NO_SIGNAL"


class TestTransportReporting:
    """Transport must come from the connection manager, never from inference.

    Regression: transport used to be derived from
    get_vehicle_status()["connectionType"], which checks serialPortOpen FIRST.
    A serial flag left behind by an earlier session therefore reported "USB"
    for a live TCP link.
    """

    def test_sitl_tcp_reports_tcp(self, client):
        from core.state import set_tcp_connected, vehicle_state

        _mock_connected_state()
        # Stale serial flag left behind by a previous USB session.
        vehicle_state["serialPortOpen"] = True
        set_tcp_connected(True)
        _inject_rc([1500] * 4)

        with _mock_transport("tcp"):
            body = client.get("/api/setup/radio").json()

        assert body["transport"] == "TCP"
        assert body["connected"] is True

    def test_sitl_udp_reports_udp(self, client):
        from core.state import set_tcp_connected, vehicle_state

        _mock_connected_state()
        vehicle_state["serialPortOpen"] = False
        vehicle_state["udpConnected"] = True
        set_tcp_connected(False)
        _inject_rc([1500] * 4)

        with _mock_transport("udp"):
            body = client.get("/api/setup/radio").json()

        assert body["transport"] == "UDP"

    def test_usb_pixhawk_reports_usb(self, client):
        _mock_connected_state()
        _inject_rc([1500] * 4)

        with _mock_transport("serial"):
            body = client.get("/api/setup/radio").json()

        assert body["transport"] == "USB"

    def test_disconnected_reports_disconnected_transport(self, client):
        """No transport is in use, so none may be advertised."""
        with _mock_transport("tcp"):
            body = client.get("/api/setup/radio").json()

        assert body["connected"] is False
        assert body["transport"] == "DISCONNECTED"
        assert body["transport"] not in ("USB", "TCP", "UDP")

    def test_connecting_reports_connecting_transport(self, client):
        from core.state import vehicle_state

        _mock_connected_state()
        vehicle_state["connected"] = False
        vehicle_state["connectionState"] = "connecting"

        body = client.get("/api/setup/radio").json()

        assert body["connected"] is False
        assert body["transport"] == "CONNECTING"

    def test_reconnect_updates_the_transport(self, client):
        """Disconnecting from USB then reconnecting over TCP must report TCP."""
        from core.state import set_tcp_connected, vehicle_state

        _mock_connected_state()  # USB session
        _inject_rc([1500] * 4)
        with _mock_transport("serial"):
            assert client.get("/api/setup/radio").json()["transport"] == "USB"

        # Disconnect: the manager keeps connection_type="serial" internally.
        vehicle_state["connected"] = False
        vehicle_state["connectionState"] = "disconnected"
        vehicle_state["serialPortOpen"] = False
        set_tcp_connected(False)
        with _mock_transport("serial"):
            assert (
                client.get("/api/setup/radio").json()["transport"] == "DISCONNECTED"
            )

        # Reconnect over TCP.
        _mock_connected_state()
        vehicle_state["serialPortOpen"] = False
        set_tcp_connected(True)
        _inject_rc([1500] * 4)
        with _mock_transport("tcp"):
            assert client.get("/api/setup/radio").json()["transport"] == "TCP"

    def test_stale_transport_is_cleared_after_disconnect(self, client):
        """A previous session's transport must not survive the disconnect."""
        from core.state import set_tcp_connected, vehicle_state

        _mock_connected_state()
        vehicle_state["serialPortOpen"] = False
        vehicle_state["udpConnected"] = False
        set_tcp_connected(False)
        _inject_rc([])

        with _mock_transport("tcp"):
            assert client.get("/api/setup/radio").json()["transport"] == "TCP"

            vehicle_state["connected"] = False
            vehicle_state["connectionState"] = "disconnected"
            # Stale serial flag survives the teardown in the real manager.
            vehicle_state["serialPortOpen"] = True
            after = client.get("/api/setup/radio").json()

        assert after["transport"] == "DISCONNECTED"
        assert after["transport"] != "USB"

    def test_unknown_manager_transport_is_not_replaced_with_usb(self, client):
        """An unrecognised transport must surface, never default to USB."""
        _mock_connected_state()
        _inject_rc([1500] * 4)

        with _mock_transport("canbus"):
            body = client.get("/api/setup/radio").json()

        assert body["transport"] == "CANBUS"

    def test_falls_back_to_state_proxy_before_manager_records_a_type(self, client):
        """Connected with no manager record yet: the state proxy is a last resort."""
        from core.state import set_tcp_connected, vehicle_state

        _mock_connected_state()
        vehicle_state["serialPortOpen"] = False
        vehicle_state["udpConnected"] = False
        set_tcp_connected(True)
        _inject_rc([1500] * 4)

        with _mock_transport(None):
            body = client.get("/api/setup/radio").json()

        assert body["connected"] is True
        assert body["transport"] == "TCP"

    def test_non_copter_vehicle_unsupported(self):
        from services.radio_service import get_radio_info

        _mock_connected_state(vehicle_type="FIXED_WING")
        body = get_radio_info()
        assert body["supported"] is False
        assert "ArduCopter" in body["unsupportedReason"]

    def test_signal_waiting_before_any_frame(self, client):
        _mock_connected_state()
        body = client.get("/api/setup/radio").json()
        assert body["signal"] == "WAITING"

    def test_signal_receiving_when_fresh_with_rssi(self, client):
        _mock_connected_state()
        _inject_rc([1500] * 4)
        body = client.get("/api/setup/radio").json()
        assert body["signal"] == "RECEIVING"

    def test_signal_no_signal_when_stale_even_if_connected(self, client):
        _mock_connected_state()
        _inject_rc([1500] * 4, received_ago=10.0)  # older than RC_STALE_MS
        body = client.get("/api/setup/radio").json()
        assert body["signal"] == "NO_SIGNAL"
        assert body["rc"]["ageMs"] > 2000

    def test_signal_no_signal_when_rssi_zero(self, client):
        _mock_connected_state()
        _inject_rc([1500] * 4, rssi=0)
        body = client.get("/api/setup/radio").json()
        assert body["signal"] == "NO_SIGNAL"

    def test_channel_list_matches_live_frames(self, client):
        _mock_connected_state()
        _inject_rc([1500, 0, 1800])
        body = client.get("/api/setup/radio").json()
        channels = body["rc"]["channels"]
        assert [c["value"] for c in channels] == [1500, 0, 1800]
        assert channels[0]["active"] is True
        assert channels[1]["active"] is False

    def test_channel_config_from_param_cache(self, client):
        _inject_params = _patch_params({
            "RC1_MIN": 1100, "RC1_MAX": 1900, "RC1_TRIM": 1500, "RC1_REVERSED": 0,
            "RC2_MIN": 1100, "RC2_MAX": 1900, "RC2_TRIM": 1500, "RC2_REVERSED": 1,
        })
        _mock_connected_state()
        _inject_rc([1500] * 4)
        with _inject_params:
            body = client.get("/api/setup/radio").json()
        row = body["channelConfig"][0]
        assert row["channel"] == 1
        assert row["min"] == 1100
        assert row["max"] == 1900
        assert row["trim"] == 1500
        assert row["reversed"] == 0
        assert row["supported"] == {
            "min": True, "trim": True, "max": True, "reversed": True,
        }
        row2 = body["channelConfig"][1]
        assert row2["reversed"] == 1

    def test_main_controls_derived_from_rcmap(self, client):
        _inject_params = _patch_params({
            "RCMAP_ROLL": 1, "RCMAP_PITCH": 2,
            "RCMAP_THROTTLE": 3, "RCMAP_YAW": 4,
        })
        _mock_connected_state()
        _inject_rc([1500] * 4)
        with _inject_params:
            body = client.get("/api/setup/radio").json()
        controls = body["mainControls"]
        assert controls["supported"] is True
        by_func = {m["function"]: m["channel"] for m in controls["mappings"]}
        assert by_func == {"Roll": 1, "Pitch": 2, "Throttle": 3, "Yaw": 4}

    def test_main_controls_unsupported_when_rcmap_absent(self, client):
        _mock_connected_state()
        _inject_rc([1500] * 4)
        with patch("services.radio_service.parameter_manager.get_parameter",
                   return_value=None):
            body = client.get("/api/setup/radio").json()
        assert body["mainControls"]["supported"] is False
        assert body["mainControls"]["mappings"][0]["channel"] is None

    def test_rcmap_is_never_assumed_to_be_ch1_to_ch4(self, client):
        """A non-standard mapping must be reported verbatim, not normalised."""
        _mock_connected_state()
        _inject_rc([1500] * 8)
        params = _patch_params({
            "RCMAP_ROLL": 12, "RCMAP_PITCH": 3,
            "RCMAP_THROTTLE": 7, "RCMAP_YAW": 9,
        })
        with params:
            body = client.get("/api/setup/radio").json()

        by_func = {m["function"]: m["channel"] for m in body["mainControls"]["mappings"]}
        assert by_func == {"Roll": 12, "Pitch": 3, "Throttle": 7, "Yaw": 9}
        assert sorted(body["mainControls"]["channels"]) == [3, 7, 9, 12]

    def test_rcmap_axis_beyond_channel_8_is_accepted(self, client):
        """CH9..CH16 must not be clamped or rejected."""
        _mock_connected_state()
        _inject_rc([1500] * 16)
        params = _patch_params({
            "RCMAP_ROLL": 15, "RCMAP_PITCH": 16,
            "RCMAP_THROTTLE": 11, "RCMAP_YAW": 13,
        })
        with params:
            body = client.get("/api/setup/radio").json()

        by_func = {m["function"]: m["channel"] for m in body["mainControls"]["mappings"]}
        assert by_func == {"Roll": 15, "Pitch": 16, "Throttle": 11, "Yaw": 13}

    def test_partially_missing_rcmap_reports_null_not_a_default(self, client):
        """An axis with no parameter must be null, never a guessed channel."""
        _mock_connected_state()
        _inject_rc([1500] * 4)

        def fake(param_id):
            if param_id == "RCMAP_ROLL":
                return {"id": param_id, "value": 6, "type": "INT32"}
            return None

        with patch("services.radio_service.parameter_manager.get_parameter",
                   side_effect=fake):
            body = client.get("/api/setup/radio").json()

        mappings = {m["function"]: m["channel"] for m in body["mainControls"]["mappings"]}
        assert mappings["Roll"] == 6
        assert mappings["Pitch"] is None
        assert mappings["Throttle"] is None
        assert mappings["Yaw"] is None
        # Only the axis that genuinely exists is treated as a main control.
        assert body["mainControls"]["channels"] == [6]


# ---------------------------------------------------------------------------
# Endpoint validation (MIN/TRIM/MAX)
# ---------------------------------------------------------------------------


class TestEndpointValidation:
    def test_valid_endpoints_accepted(self):
        from services.radio_service import validate_endpoints

        result = validate_endpoints(1100, 1500, 1900)
        assert result["success"] is True

    def test_min_not_below_trim_rejected(self):
        from services.radio_service import validate_endpoints

        result = validate_endpoints(1600, 1500, 1900)
        assert result["success"] is False
        assert "MIN" in result["message"]

    def test_trim_not_below_max_rejected(self):
        from services.radio_service import validate_endpoints

        result = validate_endpoints(1100, 1900, 1700)
        assert result["success"] is False
        assert "TRIM" in result["message"]

    def test_out_of_range_rejected(self):
        from services.radio_service import validate_endpoints

        assert validate_endpoints(500, 1500, 1900)["success"] is False
        assert validate_endpoints(1100, 1500, 3000)["success"] is False


# ---------------------------------------------------------------------------
# Calibration machine
# ---------------------------------------------------------------------------


def _settle_windows(*extra_instances):
    """Start the calibration windows + any extra patch objects and return all."""
    patchers = [
        patch("services.radio_calibration.CAPTURE_WINDOW_S", 0.06),
        patch("services.radio_calibration.SAMPLER_INTERVAL_S", 0.001),
        patch("services.radio_calibration.MIN_STABLE_FRAMES", 1),
        patch("services.radio_calibration.NO_FRAME_TIMEOUT_S", 9999),
        patch("services.radio_calibration.WRITE_PAUSE_S", 0),
        *extra_instances,
    ]
    for p in patchers:
        p.start()
    return patchers


class TestRadioCalibration:
    def test_start_requires_live_rc_signal(self):
        from services.radio_calibration import start_radio_calibration

        _mock_connected_state()
        # connected but rssi==0 -> NO_SIGNAL
        _inject_rc([1500] * 4, rssi=0)
        result = start_radio_calibration()
        assert result["success"] is False
        assert "live RC signal" in result["message"]

    def test_start_refuses_when_unsupported_vehicle(self):
        from services.radio_calibration import start_radio_calibration

        _mock_connected_state(vehicle_type="FIXED_WING")
        _inject_rc([1500] * 4)
        result = start_radio_calibration()
        assert result["success"] is False
        assert "ArduCopter" in result["message"]

    def test_start_requires_vehicle_connection(self):
        from services.radio_calibration import start_radio_calibration

        result = start_radio_calibration()
        assert result["success"] is False

    def test_start_enters_ready_and_clears_previous_capture(self):
        from services.radio_calibration import _machine, start_radio_calibration

        _mock_connected_state()
        _inject_rc([1500] * 4)
        _machine._captured = {1: {"center": 1500, "min": 1100, "max": 1900}}
        result = start_radio_calibration()
        assert result["success"] is True
        assert result["state"] == "ready"
        assert _machine._captured == {}

    def test_capture_rejects_out_of_order_sequence(self):
        from services.radio_calibration import _machine, capture_radio_phase, start_radio_calibration

        _mock_connected_state()
        _inject_rc([1500] * 4)
        _machine._state = "ready"  # only center is valid from ready
        result = capture_radio_phase("min")
        assert result["success"] is False
        assert "in order" in result["message"]

    def test_capture_rejects_unknown_phase(self):
        from services.radio_calibration import capture_radio_phase

        result = capture_radio_phase("sideways")
        assert result["success"] is False

    def test_capture_requires_start(self):
        from services.radio_calibration import capture_radio_phase

        result = capture_radio_phase("center")
        assert result["success"] is False
        assert "not been started" in result["message"]

    def test_center_capture_records_trim_from_real_frames(self):
        from services.radio_calibration import _machine, capture_radio_phase, start_radio_calibration
        from core.state import telemetry

        _mock_connected_state()
        patchers = _settle_windows()
        try:
            _inject_rc([1500, 1500, 1500, 1500])
            assert start_radio_calibration()["success"] is True
            result = capture_radio_phase("center")
            assert result["success"] is True
            assert result["state"] == "center-done"
            assert _machine._captured[1]["center"] == 1500
            assert _machine._captured[2]["center"] == 1500
        finally:
            for p in patchers:
                p.stop()

    def test_min_then_max_capture_then_verified_write(self):
        from services.radio_calibration import _machine, capture_radio_phase, start_radio_calibration
        from services.parameter_service import parameter_service
        from core.state import telemetry

        _mock_connected_state()
        store = {}
        written = []
        fake_cache = _FakeParamCache()

        def fake_write(pid, value):
            written.append((pid, value))
            store[pid] = value
            fake_cache.set(pid, value)
            return {"success": True, "value": value}

        patchers = _settle_windows(
            patch.object(parameter_service, "write_parameter", side_effect=fake_write),
            patch("services.radio_calibration.parameter_manager", fake_cache),
        )
        try:
            _inject_rc([1500, 1500, 1500, 1500])
            assert start_radio_calibration()["success"] is True
            assert capture_radio_phase("center")["success"] is True

            _inject_rc([1100, 1100, 1100, 1100])
            assert capture_radio_phase("min")["success"] is True
            assert _machine._state == "min-done"

            _inject_rc([1900, 1900, 1900, 1900])
            result = capture_radio_phase("max")
            assert result["success"] is True
            assert result["state"] == "completed"
            assert result["result"]["result"] == "success"
            expected = {
                ("RC1_MIN", 1100), ("RC1_TRIM", 1500), ("RC1_MAX", 1900),
                ("RC2_MIN", 1100), ("RC2_TRIM", 1500), ("RC2_MAX", 1900),
                ("RC3_MIN", 1100), ("RC3_TRIM", 1500), ("RC3_MAX", 1900),
                ("RC4_MIN", 1100), ("RC4_TRIM", 1500), ("RC4_MAX", 1900),
            }
            assert set(written) == expected
        finally:
            for p in patchers:
                p.stop()

    def test_write_failure_preserves_values_and_marks_failed(self):
        from services.radio_calibration import _machine, capture_radio_phase, start_radio_calibration
        from services.parameter_service import parameter_service
        from core.state import telemetry

        _mock_connected_state()
        calls = []

        def failing_write(pid, value):
            calls.append(pid)
            if pid == "RC1_TRIM":
                return {"success": False, "code": "WRITE_TIMEOUT",
                        "message": "No PARAM_VALUE echo received"}
            return {"success": True, "value": value}

        fake_cache = _FakeParamCache()

        patchers = _settle_windows(
            patch.object(parameter_service, "write_parameter", side_effect=failing_write),
            patch("services.radio_calibration.parameter_manager", fake_cache),
        )
        try:
            _inject_rc([1500, 1500, 1500, 1500])
            assert start_radio_calibration()["success"] is True
            capture_radio_phase("center")
            _inject_rc([1100] * 4)
            capture_radio_phase("min")
            _inject_rc([1900] * 4)
            result = capture_radio_phase("max")
            assert result["state"] == "failed"
            assert result["result"]["result"] == "failed"
            assert "Failed to apply parameter RC1_TRIM" in result["message"]
            assert "RC1_TRIM" in calls
            assert "RC1_MAX" not in calls  # write halted at the failure
        finally:
            for p in patchers:
                p.stop()

    def test_validation_rejects_bad_endpoints_before_any_write(self):
        from services.radio_calibration import _machine, capture_radio_phase, start_radio_calibration
        from services.parameter_service import parameter_service
        from core.state import telemetry

        _mock_connected_state()
        written = []

        def fake_write(pid, value):
            written.append(pid)
            return {"success": True, "value": value}

        patchers = _settle_windows(
            patch.object(parameter_service, "write_parameter", side_effect=fake_write),
        )
        try:
            _inject_rc([1500, 1500, 1500, 1500])
            assert start_radio_calibration()["success"] is True
            capture_radio_phase("center")
            # min above trim -> invalid
            _inject_rc([1800, 1500, 1500, 1500])
            capture_radio_phase("min")
            _inject_rc([1900, 1900, 1900, 1900])
            result = capture_radio_phase("max")
            assert result["state"] == "failed"
            assert written == []  # validation gates the writes
        finally:
            for p in patchers:
                p.stop()

    def test_capture_times_out_without_rc_frames(self):
        from services.radio_calibration import capture_radio_phase, start_radio_calibration
        from services.parameter_service import parameter_service
        from core.state import telemetry

        _mock_connected_state()
        patchers = _settle_windows()
        patchers.append(patch.object(parameter_service, "write_parameter",
                                     side_effect=lambda p, v: {"success": True, "value": v}))
        try:
            _inject_rc([1500] * 4)
            assert start_radio_calibration()["success"] is True
            with patch("services.radio_calibration.MIN_STABLE_FRAMES", 100):
                telemetry["rcReceivedAt"] = 0  # no fresh frames at all
                result = capture_radio_phase("center")
            assert result["state"] == "timeout"
        finally:
            for p in patchers:
                p.stop()

    def test_cancel_during_capture(self):
        from services.radio_calibration import (
            cancel_radio_calibration,
            capture_radio_phase,
            get_calibration_machine_status,
            start_radio_calibration,
        )
        from core.state import telemetry

        _mock_connected_state()
        _inject_rc([1500] * 4)
        assert start_radio_calibration()["success"] is True
        with patch("services.radio_calibration.CAPTURE_WINDOW_S", 10.0), \
             patch("services.radio_calibration.SAMPLER_INTERVAL_S", 0.01), \
             patch("services.radio_calibration.MIN_STABLE_FRAMES", 1), \
             patch("services.radio_calibration.NO_FRAME_TIMEOUT_S", 9999):
            import threading

            result_holder = {}
            def run_capture():
                result_holder["r"] = capture_radio_phase("center")
            t = threading.Thread(target=run_capture)
            t.start()
            time.sleep(0.05)
            cancelled = cancel_radio_calibration()
            assert cancelled["success"] is True
            t.join(timeout=2.0)
            assert not t.is_alive()
            final = get_calibration_machine_status()
            assert final["state"] == "cancelled"
            assert result_holder["r"]["success"] is False

    def test_calibration_status_endpoint(self, client):
        _mock_connected_state()
        body = client.get("/api/setup/radio/calibration/status").json()
        assert body["success"] is True
        assert body["state"] in ("idle", "ready")

    def test_calibration_endpoints_return_project_errors(self, client):
        _mock_connected_state()
        # no RC signal -> start fails with 400 and a real message
        response = client.post("/api/setup/radio/calibration/start")
        assert response.status_code == 400
        assert "RC signal" in response.json()["detail"]
        # unknown capture phase -> 400
        response = client.post("/api/setup/radio/calibration/capture",
                               json={"phase": "spin"})
        assert response.status_code == 400


@pytest.fixture
def client():
    from app import app

    return TestClient(app)

# ---------------------------------------------------------------------------
# Honest RSSI reporting
# ---------------------------------------------------------------------------


class TestRssiReport:
    def test_reports_a_real_rssi_value(self):
        from services.radio_service import _rssi_report

        _inject_rc([1500, 1500], rssi=87)
        report = _rssi_report()
        assert report["available"] is True
        assert report["value"] == 87
        assert report["raw"] == 87
        assert report["unavailableReason"] is None

    def test_treats_255_as_unknown_not_a_signal_strength(self):
        from services.radio_service import _rssi_report

        _inject_rc([1500, 1500], rssi=255)
        report = _rssi_report()
        assert report["available"] is False
        assert report["value"] is None
        assert report["raw"] == 255
        assert "unknown" in report["unavailableReason"].lower()

    def test_treats_zero_as_no_valid_link(self):
        from services.radio_service import _rssi_report

        _inject_rc([1500, 1500], rssi=0)
        report = _rssi_report()
        assert report["available"] is False
        assert report["value"] is None
        assert "no valid rc link" in report["unavailableReason"].lower()

    def test_reports_missing_telemetry_honestly(self):
        from core.state import telemetry
        from services.radio_service import _rssi_report

        telemetry["rcRssi"] = None
        report = _rssi_report()
        assert report["available"] is False
        assert report["value"] is None
        assert report["unavailableReason"]

    def test_before_any_frame_the_reason_is_no_frame_not_a_zero_reading(self):
        from core.state import telemetry
        from services.radio_service import _rssi_report

        # A dropped link resets rcRssi to 0, which must not be reported as a
        # measured "no valid RC link" when no frame ever arrived.
        telemetry["rcRssi"] = 0
        telemetry["rcReceivedAt"] = 0
        report = _rssi_report()
        assert report["available"] is False
        assert "no rc_channels frame" in report["unavailableReason"].lower()


# ---------------------------------------------------------------------------
# Capability-driven aux / parameter channel assignment
# ---------------------------------------------------------------------------


def _enum_param_values(labels):
    return {str(i): label for i, label in enumerate(labels)}


@contextmanager
def _patch_params_with_metadata(values):
    """Patch the live-value source and the shared metadata provider.

    The enum values come from ``parameter_service.get_metadata`` (the same
    provider that serves GET /parameters/{id}/metadata), NOT from
    ParameterManager.get_parameter, whose snapshot never carries metadata.
    """

    def fake_value(param_id):
        spec = values.get(param_id)
        if spec is None:
            return None
        # specs are (live_value, {"values": {...}}) pairs
        live = spec[0] if isinstance(spec, tuple) else spec
        return {"id": param_id, "value": live, "type": "INT32"}

    def fake_metadata(param_id):
        spec = values.get(param_id)
        if spec is None:
            return {"success": False}
        enum_values = spec[1]["values"] if isinstance(spec, tuple) else {}
        return {
            "success": True,
            "metadata": {"id": param_id, "values": enum_values},
        }

    from services.parameter_service import parameter_service as _psvc
    from services.radio_service import parameter_manager

    with patch.object(parameter_manager, "get_parameter", side_effect=fake_value), \
            patch.object(_psvc, "get_metadata", side_effect=fake_metadata):
        yield


class TestAuxChannels:
    def test_reports_unsupported_when_firmware_publishes_no_function_params(self):
        from services.radio_service import _aux_channels

        with _patch_params({}):
            result = _aux_channels([1, 2, 3, 4])
        assert result["supported"] is False
        assert all(row["supported"] is False for row in result["channels"])
        assert all(row["param"] is None for row in result["channels"])
        assert all(row["unavailableReason"] for row in result["channels"])

    def test_detects_real_enum_options_from_vehicle_metadata(self):
        from services.radio_service import _aux_channels

        labels = ["Disabled", "Servo", "ServoFunction1"]
        params = {
            f"RC{ch}_OPTION": (
                0 if ch != 5 else 1,
                {"values": _enum_param_values(labels)},
            )
            for ch in (1, 5)
        }
        with _patch_params_with_metadata(params):
            result = _aux_channels([1, 2, 3, 4])

        assert result["supported"] is True
        row5 = next(r for r in result["channels"] if r["channel"] == 5)
        assert row5["supported"] is True
        assert row5["param"] == "RC5_OPTION"
        assert row5["value"] == 1
        assert [o["value"] for o in row5["options"]] == [0, 1, 2]
        assert row5["options"][1]["label"] == "Servo"
        assert row5["isMainControl"] is False

    def test_marks_main_control_channels(self):
        from services.radio_service import _aux_channels

        params = {
            "RC1_OPTION": (0, {"values": _enum_param_values(["Disabled", "Servo"])}),
        }
        with _patch_params_with_metadata(params):
            result = _aux_channels([1, 2, 3, 4])

        row1 = next(r for r in result["channels"] if r["channel"] == 1)
        assert row1["isMainControl"] is True
        # A main control alone does not make the additional-setup capability real.
        assert result["supported"] is False

    def test_parameter_without_enum_is_not_offered_as_a_control(self):
        from services.radio_service import _aux_channels

        with _patch_params_with_metadata({"RC5_OPTION": (3, {"values": {}})}):
            result = _aux_channels([1, 2, 3, 4])

        row5 = next(r for r in result["channels"] if r["channel"] == 5)
        assert row5["supported"] is False
        assert row5["options"] == []
        assert result["supported"] is False


# ---------------------------------------------------------------------------
# RC state and calibration stage normalization
# ---------------------------------------------------------------------------


class TestRcState:
    def _identity(self, **overrides):
        base = {
            "supported": True,
            "connected": True,
            # core/state.py stores connectionState lowercase.
            "connectionState": "connected",
        }
        base.update(overrides)
        return base

    def test_reports_active_when_channels_and_rssi_are_real(self):
        from services.radio_service import _rc_state

        _inject_rc([1500, 1500, 1500, 1500], rssi=90)
        assert _rc_state(self._identity()) == "RC_ACTIVE"

    def test_reports_waiting_when_no_channels_have_arrived(self):
        from services.radio_service import _rc_state

        _inject_rc([], rssi=0)
        assert _rc_state(self._identity()) == "WAITING_FOR_RC"

    def test_reports_disconnected_regardless_of_telemetry(self):
        from services.radio_service import _rc_state

        _inject_rc([1500, 1500, 1500, 1500], rssi=90)
        assert _rc_state(self._identity(connected=False)) == "DISCONNECTED"

    def test_reports_connecting_while_the_link_comes_up(self):
        from services.radio_service import _rc_state

        _inject_rc([1500], rssi=90)
        assert (
            _rc_state(self._identity(connected=False, connectionState="connecting"))
            == "CONNECTING"
        )

    def test_connecting_is_detected_from_the_real_lowercase_state(self):
        """Regression: the state is stored lowercase, so an uppercase compare
        made CONNECTING unreachable in production."""
        from core.state import vehicle_state
        from services import radio_service

        _inject_rc([1500], rssi=90)
        _mock_connected_state()
        vehicle_state["connected"] = False
        vehicle_state["connectionState"] = "connecting"
        identity = radio_service._identity()
        assert identity["connectionState"] == "connecting"
        assert radio_service._rc_state(identity) == "CONNECTING"


class TestCalibrationStage:
    def test_idle_without_rc_reports_waiting_for_rc(self):
        from services.radio_calibration import _stage_for

        _mock_connected_state()
        _inject_rc([], rssi=0)
        assert _stage_for("idle") == "WAITING_FOR_RC"

    def test_idle_with_live_rc_is_ready(self):
        from services.radio_calibration import _stage_for

        _mock_connected_state()
        _inject_rc([1500, 1500, 1500, 1500], rssi=90)
        assert _stage_for("idle") == "IDLE"

    def test_idle_while_disconnected_is_not_reported_as_ready(self):
        from services.radio_calibration import _stage_for

        _inject_rc([1500, 1500, 1500, 1500], rssi=90)
        assert _stage_for("idle") == "WAITING_FOR_RC"

    @pytest.mark.parametrize(
        "machine_state,expected",
        [
            ("ready", "READY"),
            ("capturing-center", "CALIBRATING"),
            ("capturing-min", "CALIBRATING"),
            ("capturing-max", "CALIBRATING"),
            ("validating", "FINALIZING"),
            ("completed", "SUCCESS"),
            ("failed", "FAILED"),
            ("timeout", "FAILED"),
            ("cancelled", "CANCELLED"),
        ],
    )
    def test_maps_internal_states_to_reported_stages(self, machine_state, expected):
        from services.radio_calibration import _stage_for

        _inject_rc([1500, 1500, 1500, 1500], rssi=90)
        assert _stage_for(machine_state) == expected

    def test_snapshot_reports_disconnected_stage(self):
        from services.radio_service import get_radio_info

        _inject_rc([], rssi=0)
        with _patch_params({}):
            info = get_radio_info()
        assert info["rcState"] == "DISCONNECTED"
        assert info["calibrationStage"] == "DISCONNECTED"
