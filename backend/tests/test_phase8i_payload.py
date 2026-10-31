"""Phase 8I gimbal, logging and scripting backend tests.

Covers capability detection, honest unsupported/absent reporting, connection
state handling, real-telemetry decoding and the guarantee that no write,
actuator or script-command route is introduced.
"""

import time
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app import app
from core.state import telemetry, vehicle_state
from mavlink import telemetry_manager as tm
from mavlink.connection_manager import HANDLERS
from mavlink.parameter_manager import parameter_manager
from services import gimbal_service as gimbal
from services import logging_service as logging_page
from services import scripting_service as scripting

client = TestClient(app)


@pytest.fixture(autouse=True)
def clean_state():
    state = dict(vehicle_state)
    telem = dict(telemetry)
    tm.reset_gimbal_telemetry()
    yield
    vehicle_state.clear()
    vehicle_state.update(state)
    telemetry.clear()
    telemetry.update(telem)
    tm.reset_gimbal_telemetry()


def connected(vehicle="QUADROTOR", autopilot="ARDUPILOTMEGA", connection_state="connected", reason=None):
    vehicle_state.update({
        "connected": connection_state == "connected",
        "connectionState": connection_state,
        "disconnectReason": reason,
        "vehicleType": vehicle,
        "autopilot": autopilot,
        "serialPortOpen": True,
        "lastHeartbeat": int(time.time() * 1000) if connection_state == "connected" else 0,
    })


@contextmanager
def params(values, sync="complete", metadata=None):
    entries = [{"id": key, "value": value, "type": "REAL32"} for key, value in values.items()]
    sync_data = {"connected": True, "state": sync, "complete": sync == "complete", "cachedEntries": len(entries)}
    with patch.object(parameter_manager, "get_all_parameters", return_value=entries), \
         patch.object(parameter_manager, "get_parameter", side_effect=lambda pid: next(
             (dict(entry) for entry in entries if entry["id"] == pid), None)), \
         patch.object(parameter_manager, "get_synchronization_state", return_value=sync_data), \
         patch.object(gimbal, "_field", side_effect=lambda pid, entry, writable=True: _field(
             pid, entry, writable, metadata or {})), \
         patch.object(logging_page, "_field", side_effect=lambda pid, entry, writable=True: _field(
             pid, entry, writable, metadata or {})), \
         patch.object(scripting, "_field", side_effect=lambda pid, entry, writable=True: _field(
             pid, entry, writable, metadata or {})):
        yield


def _field(param_id, entry, writable, metadata):
    """Test double for the shared Phase 8I field builder."""
    meta = metadata.get(param_id)
    value = float(entry["value"]) if entry.get("value") is not None else None
    field = {
        "id": param_id,
        "supported": True,
        "value": value,
        "name": (meta or {}).get("name") or param_id,
        "description": (meta or {}).get("description"),
        "units": (meta or {}).get("units"),
        "writable": writable,
        "decoded": None,
        "options": [],
        "rebootRequired": bool((meta or {}).get("rebootRequired", False)),
        "kind": "scalar",
    }
    if meta:
        for key in ("min", "max", "increment"):
            if meta.get(key) is not None:
                field[key] = meta[key]
        if meta.get("values"):
            field["kind"] = "enum"
            field["options"] = [{"code": int(code), "label": label} for code, label in meta["values"].items()]
            if value is not None:
                field["decoded"] = meta["values"].get(str(int(value)))
        if meta.get("bitmask"):
            raw = int(value) if value is not None else 0
            field["kind"] = "bitmask"
            field["bits"] = [
                {"code": int(code), "label": label, "present": bool(raw & (1 << int(code)))}
                for code, label in sorted(meta["bitmask"].items(), key=lambda item: int(item[0]))
            ]
            enabled = sum(1 for bit in field["bits"] if bit["present"])
            field["enabledCount"] = enabled
            field["decoded"] = "Disabled" if enabled == 0 else f"Enabled ({enabled}/{len(field['bits'])})"
    return field


# ------------------------------------------------------------------
# Connection / parameter-sync state machine (all three pages)
# ------------------------------------------------------------------

@pytest.mark.parametrize("call", [gimbal.get_gimbal_setup, logging_page.get_logging_setup, scripting.get_scripting_setup])
@pytest.mark.parametrize("connection_state,reason,sync,expected", [
    ("disconnected", None, "idle", "WAITING"),
    ("connecting", None, "idle", "CONNECTING"),
    ("connected", None, "requesting", "SYNCING"),
    ("connected", None, "receiving", "SYNCING"),
    ("connected", None, "failed", "ERROR"),
    ("disconnected", "heartbeat_timeout", "idle", "CONNECTION_LOST"),
])
def test_state_machine(call, connection_state, reason, sync, expected):
    connected(connection_state=connection_state, reason=reason)
    with params({"LOG_BITMASK": 1.0, "SCR_USER1": 1.0}, sync=sync, metadata={}):
        assert call()["state"] == expected


@pytest.mark.parametrize("call", [gimbal.get_gimbal_setup, logging_page.get_logging_setup, scripting.get_scripting_setup])
def test_ready_only_after_completed_sync_with_own_parameters(call):
    connected()
    with params({"LOG_BITMASK": 1.0, "SCR_USER1": 1.0, "MNT_MODE": 0.0}, metadata={}):
        assert call()["state"] == "READY"


@pytest.mark.parametrize("module,call", [
    (gimbal, "get_gimbal_setup"),
    (logging_page, "get_logging_setup"),
    (scripting, "get_scripting_setup"),
])
@pytest.mark.parametrize("vehicle,autopilot", [
    ("GROUND_ROVER", "ARDUPILOTMEGA"),
    ("QUADROTOR", "PX4"),
])
def test_unsupported_vehicle(module, call, vehicle, autopilot):
    connected(vehicle, autopilot)
    with params({"LOG_BITMASK": 1.0, "SCR_USER1": 1.0}, metadata={}):
        result = getattr(module, call)()
    assert result["state"] == "UNSUPPORTED"
    assert result["config"] == []
    assert result["unsupportedReason"]


@pytest.mark.parametrize("call", [gimbal.get_gimbal_setup, logging_page.get_logging_setup, scripting.get_scripting_setup])
def test_no_vehicle_is_waiting_and_empty(call):
    assert call()["state"] == "WAITING"


# ------------------------------------------------------------------
# Gimbal
# ------------------------------------------------------------------

def test_gimbal_device_frames_are_decoded():
    connected()
    tm.handle_gimbal_device_information(SimpleNamespace(
        gimbal_device_id=1, cap_flags=(1 << 2) | (1 << 10), vendor_name="Acme",
        product_name="Gimbal One", firmware_version="2.4.1", hardware_uid="UID-1",
        custom_name="Camera", gimbal_manager=1))
    tm.handle_gimbal_device_attitude_status(SimpleNamespace(
        gimbal_device_id=1, time_boot_ms=1234, flags=(1 << 0) | (1 << 2), q=[1.0, 0.0, 0.0, 0.0],
        angular_velocity_x=0.01, angular_velocity_y=0.02, angular_velocity_z=0.03,
        failure_flags=(1 << 6), delta_yaw=1.5, delta_yaw_velocity=0.25,
        elevation=10.0, elevation_rate=1.5))
    with params({}, metadata={}):
        device = gimbal.get_gimbal_setup()["devices"][0]
    assert device["deviceId"] == 1
    assert device["productName"] == "Gimbal One"
    assert device["capabilities"] == [
        "GIMBAL_DEVICE_CAP_FLAGS_HAS_ROLL_AXIS", "GIMBAL_DEVICE_CAP_FLAGS_HAS_YAW_LOCK"]
    assert device["statusFlags"] == ["ROLL_LOCK", "YAW_LOCK"]
    assert device["failures"] == ["SOFTWARE_ERROR"]
    assert device["quaternion"] == [1.0, 0.0, 0.0, 0.0]
    assert device["rollDeg"] is None and device["angularVelocityZ"] == 0.03
    assert device["freshness"] == "AVAILABLE"
    assert device["ageMs"] < 1000


def test_gimbal_absent_is_honest_not_an_error():
    connected()
    with params({"LOG_BITMASK": 1.0}, metadata={}):
        result = gimbal.get_gimbal_setup()
    assert result["state"] == "READY"
    assert result["capability"]["gimbalDetected"] is False
    assert result["capability"]["deviceReported"] is False
    assert result["deviceCount"] == 0
    assert result["config"] == []
    assert "no gimbal configuration parameters are present" in result["capability"]["reason"]


def test_gimbal_config_without_device_stays_ready_and_says_so():
    connected()
    with params({"MNT_MODE": 1.0}, metadata={}):
        result = gimbal.get_gimbal_setup()
    assert result["state"] == "READY"
    assert result["capability"]["gimbalDetected"] is True
    assert result["capability"]["deviceReported"] is False
    assert "Gimbal configuration parameters are present" in result["capability"]["reason"]


def test_gimbal_config_and_mount_outputs_discovered_from_real_params():
    connected()
    metadata = {
        "MNT_MODE": {"name": "Mount mode", "values": {"1": "Retract"}},
        "SERVO5_FUNCTION": {"values": {"26": "Mount Yaw"}},
        "SERVO6_FUNCTION": {"values": {"27": "Mount Pitch"}},
        "SERVO7_FUNCTION": {"values": {"33": "Motor 1"}},
    }
    with params({"MNT_MODE": 1.0, "GIMBAL_ROLL_TRIM": 2.0, "MNT_RELAY": 3.0,
                 "SERVO5_FUNCTION": 26.0, "SERVO6_FUNCTION": 27.0, "SERVO7_FUNCTION": 33.0},
                metadata=metadata):
        result = gimbal.get_gimbal_setup()
    assert [field["id"] for field in result["config"]] == ["GIMBAL_ROLL_TRIM", "MNT_MODE", "MNT_RELAY"]
    assert result["config"][1]["decoded"] == "Retract"
    assert result["config"][1]["kind"] == "enum"
    assert [item["output"] for item in result["outputs"]] == [5, 6]
    assert result["outputs"][0]["functionLabel"] == "Mount Yaw"
    assert all(item["source"].endswith("_FUNCTION") for item in result["outputs"])


def test_gimbal_config_fields_are_writable_through_shared_pipeline():
    connected()
    with params({"MNT_MODE": 0.0}, metadata={}):
        result = gimbal.get_gimbal_setup()
    assert result["writePipeline"] == "shared"
    assert result["controlEnabled"] is False
    assert result["readOnly"] is True
    assert result["config"][0]["writable"] is True


def test_gimbal_stale_after_three_seconds_and_reset_clears():
    tm.handle_gimbal_device_information(SimpleNamespace(gimbal_device_id=2, cap_flags=0))
    tm._gimbals[2]["receivedAt"] -= 4
    with params({}, metadata={}):
        assert gimbal.get_gimbal_setup()["devices"][0]["freshness"] == "STALE"
    tm.reset_gimbal_telemetry()
    assert tm.get_gimbal_snapshot()["devices"] == []


def test_gimbal_attitude_freshness_is_tracked_separately():
    tm.handle_gimbal_device_information(SimpleNamespace(gimbal_device_id=3, cap_flags=0))
    with params({}, metadata={}):
        device = gimbal.get_gimbal_setup()["devices"][0]
    assert device["freshness"] == "AVAILABLE"
    assert device["attitudeFreshness"] == "UNAVAILABLE"
    tm.handle_gimbal_device_attitude_status(SimpleNamespace(
        gimbal_device_id=3, time_boot_ms=1, flags=0, q=[1.0, 0.0, 0.0, 0.0],
        angular_velocity_x=0.0, angular_velocity_y=0.0, angular_velocity_z=0.0,
        failure_flags=0, delta_yaw=0.0, delta_yaw_velocity=0.0, elevation=0.0, elevation_rate=0.0))
    tm._gimbals[3]["attitudeReceivedAt"] -= 4
    with params({}, metadata={}):
        device = gimbal.get_gimbal_setup()["devices"][0]
    assert device["freshness"] == "AVAILABLE"
    assert device["attitudeFreshness"] == "STALE"


# ------------------------------------------------------------------
# Logging
# ------------------------------------------------------------------

LOG_METADATA = {
    "LOG_BITMASK": {"name": "Log bitmask", "bitmask": {"0": "IMU", "1": "GPS", "2": "Attitude", "3": "RC"}},
    "LOG_BACKEND_TYPE": {"name": "Log backend", "values": {"0": "File", "1": "MAVLink"}},
    "LOG_BACKEND_RATE": {"name": "Backend rate", "units": "Hz", "min": 1.0, "max": 100.0},
}


def test_logging_config_and_bitmask_decoding():
    connected()
    with params({"LOG_BITMASK": 3.0, "LOG_BACKEND_TYPE": 1.0, "LOG_BACKEND_RATE": 50.0,
                 "LOG_FILE_SIZE": 1048576.0, "LOG_REPLAY": 0.0, "LOG_BUCKETS": 2.0},
                metadata=LOG_METADATA):
        result = logging_page.get_logging_setup()
    assert [field["id"] for field in result["config"]][:5] == [
        "LOG_BITMASK", "LOG_BACKEND_TYPE", "LOG_BACKEND_RATE", "LOG_FILE_SIZE", "LOG_REPLAY"]
    assert result["config"][-1]["id"] == "LOG_BUCKETS"
    bitmask = result["config"][0]
    assert bitmask["kind"] == "bitmask"
    assert [bit["present"] for bit in bitmask["bits"]] == [True, True, False, False]
    assert result["config"][1]["decoded"] == "MAVLink"
    assert result["config"][2]["units"] == "Hz"
    assert result["status"] == "Partially configured"


@pytest.mark.parametrize("value,expected", [
    (0.0, "Disabled"),
    (3.0, "Partially configured"),
    (15.0, "Enabled"),
])
def test_logging_status_is_derived_from_real_bitmask(value, expected):
    connected()
    with params({"LOG_BITMASK": value}, metadata=LOG_METADATA):
        assert logging_page.get_logging_setup()["status"] == expected


def test_logging_status_unknown_without_bitmask_parameter():
    connected()
    with params({"LOG_BACKEND_TYPE": 0.0}, metadata=LOG_METADATA):
        assert logging_page.get_logging_setup()["status"] == "Unknown"


def test_log_entries_come_from_real_log_entry_frames():
    connected()
    tm.handle_log_entry(SimpleNamespace(time_utc=1700000000, size=2048, id=1, num_logs=3, last_log_num=1))
    tm.handle_log_entry(SimpleNamespace(time_utc=1700001000, size=4096, id=2, num_logs=3, last_log_num=2))
    with params({"LOG_BITMASK": 0.0}, metadata=LOG_METADATA):
        result = logging_page.get_logging_setup()
    assert result["logEntryCount"] == 2
    assert [entry["id"] for entry in result["logEntries"]] == [2, 1]
    assert result["logEntries"][0]["sizeBytes"] == 4096
    assert result["numLogs"] == 3
    assert result["lastLogNum"] == 2


def test_logging_without_any_log_parameters_is_unsupported():
    connected()
    with params({"MNT_MODE": 1.0}, metadata={}):
        result = logging_page.get_logging_setup()
    assert result["state"] == "UNSUPPORTED"
    assert "No LOG_* configuration parameters" in result["unsupportedReason"]
    assert result["logEntryCount"] == 0


# ------------------------------------------------------------------
# Scripting
# ------------------------------------------------------------------

def test_scripting_detected_from_real_parameters():
    connected()
    with params({"SCR_USER1": 1.0, "SCR_USER2": 2.0, "SCR_THROTTLE": 0.0},
                metadata={"SCR_USER1": {"name": "Script variable 1"}}):
        result = scripting.get_scripting_setup()
    assert result["state"] == "READY"
    assert result["capability"]["scriptingDetected"] is True
    assert result["userTokens"] == ["SCR_USER1", "SCR_USER2"]
    assert [field["id"] for field in result["config"]] == ["SCR_USER1", "SCR_USER2", "SCR_THROTTLE"]
    assert result["config"][0]["name"] == "Script variable 1"
    assert result["executionEnabled"] is False


def test_scripting_not_detected_is_honest_unsupported():
    connected()
    with params({"MNT_MODE": 1.0}, metadata={}):
        result = scripting.get_scripting_setup()
    assert result["state"] == "UNSUPPORTED"
    assert result["capability"]["scriptingDetected"] is False
    assert "does not expose any SCR_* scripting parameters" in result["unsupportedReason"]
    assert result["userTokens"] == []


# ------------------------------------------------------------------
# Wiring, handlers and safety guarantees
# ------------------------------------------------------------------

def test_handlers_registered():
    assert HANDLERS["GIMBAL_DEVICE_INFORMATION"] is tm.handle_gimbal_device_information
    assert HANDLERS["GIMBAL_DEVICE_ATTITUDE_STATUS"] is tm.handle_gimbal_device_attitude_status
    assert HANDLERS["LOG_ENTRY"] is tm.handle_log_entry


def test_disconnect_reset_clears_gimbal_and_log_snapshots():
    tm.handle_gimbal_device_information(SimpleNamespace(gimbal_device_id=1, cap_flags=0))
    tm.handle_log_entry(SimpleNamespace(time_utc=1, size=1, id=1, num_logs=1, last_log_num=1))
    tm.reset_telemetry()
    assert tm.get_gimbal_snapshot()["devices"] == []
    assert tm.get_log_entry_snapshot()["entries"] == []


@pytest.mark.parametrize("route,key,count_key", [
    ("/api/setup/logging", "status", "logEntryCount"),
    ("/api/setup/scripting", "capability", "configCount"),
])
def test_api_routes_return_phase8i_contract(route, key, count_key):
    connected()
    values = {"LOG_BITMASK": 3.0, "SCR_USER1": 1.0, "MNT_MODE": 0.0}
    with params(values, metadata=LOG_METADATA):
        response = client.get(route)
    assert response.status_code == 200
    payload = response.json()
    assert payload["success"] is True
    assert payload["state"] in {"WAITING", "CONNECTING", "SYNCING", "READY", "UNSUPPORTED",
                                "CONNECTION_LOST", "ERROR"}
    assert key in payload
    assert count_key in payload
    assert payload["writePipeline"] == "shared"
    assert payload["sync"]["complete"] is True


def test_phase8i_routes_are_read_only():
    phase8i = {(method, route.path) for route in app.routes
               for method in getattr(route, "methods", set())
               if route.path in {"/api/setup/gimbal", "/api/setup/logging", "/api/setup/scripting"}}
    assert phase8i == {("GET", "/api/setup/logging"),
                       ("GET", "/api/setup/scripting")}


def test_services_never_send_mavlink_commands():
    import inspect

    for module in (gimbal, logging_page, scripting):
        source = inspect.getsource(module)
        for forbidden in ("command_manager", "connection_manager.send", "MAV_CMD",
                          "do_motor_test", "param_set", "set_mode", "ftp_service"):
            assert forbidden not in source, f"{module.__name__} must not reference {forbidden}"
