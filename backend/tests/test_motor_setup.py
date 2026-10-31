"""Phase 8H read-only motor, servo output and ESC backend tests."""

import time
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app import app
from core.state import telemetry, vehicle_state
from mavlink.connection_manager import HANDLERS
from mavlink.parameter_manager import parameter_manager
from mavlink import telemetry_manager as tm
from services import motor_setup_service as service

client = TestClient(app)


@pytest.fixture(autouse=True)
def clean_state():
    state = dict(vehicle_state)
    telem = dict(telemetry)
    tm.reset_actuator_telemetry()
    yield
    vehicle_state.clear()
    vehicle_state.update(state)
    telemetry.clear()
    telemetry.update(telem)
    tm.reset_actuator_telemetry()


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
    meta = metadata or {}
    with patch.object(parameter_manager, "get_all_parameters", return_value=entries), \
         patch.object(parameter_manager, "get_synchronization_state", return_value=sync_data), \
         patch.object(service, "_meta", side_effect=lambda key: meta.get(key)):
        yield


@pytest.mark.parametrize("connection_state,reason,sync,expected", [
    ("disconnected", None, "idle", "WAITING"),
    ("connecting", None, "idle", "CONNECTING"),
    ("connected", None, "requesting", "SYNCING"),
    ("connected", None, "receiving", "SYNCING"),
    ("connected", None, "failed", "ERROR"),
    ("disconnected", "heartbeat_timeout", "idle", "CONNECTION_LOST"),
])
def test_states(connection_state, reason, sync, expected):
    connected(connection_state=connection_state, reason=reason)
    with params({}, sync=sync):
        assert service.get_motor_setup()["state"] == expected


@pytest.mark.parametrize("vehicle,autopilot", [
    ("GROUND_ROVER", "ARDUPILOTMEGA"),
    ("QUADROTOR", "PX4"),
])
def test_unsupported(vehicle, autopilot):
    connected(vehicle, autopilot)
    with params({"SERVO1_FUNCTION": 33}):
        result = service.get_motor_setup()
    assert result["state"] == "UNSUPPORTED"
    assert result["channels"] == []


def motor_metadata(label="Motor 1"):
    return {"SERVO1_FUNCTION": {"name": "Servo output function", "description": "Official definition", "values": {"33": label}}}


def test_ready_and_motor_from_metadata_label_not_id_table():
    connected()
    with params({"SERVO1_FUNCTION": 999}, metadata={"SERVO1_FUNCTION": {"values": {"999": "Motor 12"}}}):
        result = service.get_motor_setup()
    assert result["state"] == "READY"
    assert result["motors"][0]["motorNumber"] == 12
    assert result["motors"][0]["functionId"] == 999


@pytest.mark.parametrize("channel", [1, 2, 8, 16, 24, 32])
def test_dynamic_channel_discovery_1_to_32(channel):
    connected()
    with params({f"SERVO{channel}_MIN": 1010}):
        result = service.get_motor_setup()
    assert result["channelCount"] == 1
    assert result["channels"][0]["channel"] == channel


def test_out_of_range_and_unrelated_parameters_are_not_channels():
    connected()
    with params({"SERVO0_FUNCTION": 33, "SERVO33_FUNCTION": 33, "MOT_PWM_TYPE": 6}):
        assert service.get_motor_setup()["channels"] == []


def test_all_servo_fields_are_live_values_and_metadata_enriched():
    connected()
    values = {"SERVO1_FUNCTION": 33, "SERVO1_MIN": 1001, "SERVO1_TRIM": 1502,
              "SERVO1_MAX": 1999, "SERVO1_REVERSED": 1}
    metadata = motor_metadata()
    metadata.update({key: {"units": "PWM", "min": 800.0, "max": 2200.0} for key in
                     ("SERVO1_MIN", "SERVO1_TRIM", "SERVO1_MAX")})
    with params(values, metadata=metadata):
        fields = service.get_motor_setup()["channels"][0]["fields"]
    assert {name: field["value"] for name, field in fields.items()} == {
        "function": 33, "min": 1001, "trim": 1502, "max": 1999, "reversed": 1}
    assert fields["min"]["units"] == "PWM"


def test_absent_servo_fields_are_not_defaulted():
    connected()
    with params({"SERVO4_FUNCTION": 0}, metadata={"SERVO4_FUNCTION": {"values": {"0": "Disabled"}}}):
        fields = service.get_motor_setup()["channels"][0]["fields"]
    assert set(fields) == {"function"}


def test_unknown_function_preserves_raw_without_description():
    connected()
    with params({"SERVO1_FUNCTION": 777}, metadata=motor_metadata()):
        channel = service.get_motor_setup()["channels"][0]
    assert channel["functionId"] == 777
    assert channel["functionLabel"] is None
    assert channel["functionDescription"] is None
    assert channel["isMotor"] is False


@pytest.mark.parametrize("label,is_motor", [("Motor1", True), ("Motor 9", True), ("Motor 13", False), ("TiltMotorFrontLeft", False)])
def test_motor_detection_is_metadata_driven_and_limited(label, is_motor):
    connected()
    with params({"SERVO1_FUNCTION": 33}, metadata=motor_metadata(label)):
        assert service.get_motor_setup()["channels"][0]["isMotor"] is is_motor


def test_configuration_contains_only_present_parameters():
    connected()
    values = {"SERVO1_FUNCTION": 0, "MOT_PWM_TYPE": 6, "RC_SPEED": 490}
    metadata = {"MOT_PWM_TYPE": {"values": {"6": "DShot600"}}, "RC_SPEED": {"units": "Hz"}}
    with params(values, metadata=metadata):
        config = service.get_motor_setup()["configuration"]
    assert [field["id"] for field in config] == ["MOT_PWM_TYPE", "RC_SPEED"]
    assert config[0]["decoded"] == "DShot600"
    assert config[1]["units"] == "Hz"


def test_servo_output_real_sparse_values_and_units():
    tm.handle_servo_output_raw(SimpleNamespace(servo1_raw=1000, servo2_raw=0, servo3_raw=1750))
    snapshot = tm.get_servo_output_snapshot()
    assert [(item["channel"], item["pwm"]) for item in snapshot["channels"]] == [(1, 1000), (3, 1750)]
    assert snapshot["channels"][0]["stale"] is False
    assert snapshot["channels"][0]["ageMs"] < 1000


@pytest.mark.parametrize("handler,first,last", [
    (tm.handle_esc_telemetry_1_to_4, 1, 4),
    (tm.handle_esc_telemetry_5_to_8, 5, 8),
    (tm.handle_esc_telemetry_9_to_12, 9, 12),
])
def test_esc_groups_and_conversions(handler, first, last):
    msg = SimpleNamespace(temperature=[20, 21, 22, 23], voltage=[1200, 1210, 1220, 1230],
                          current=[100, 200, 300, 400], totalcurrent=[10, 20, 30, 40],
                          rpm=[1000, 2000, 3000, 4000], count=[1, 2, 3, 4])
    handler(msg)
    escs = tm.get_esc_telemetry_snapshot()["escs"]
    assert [esc["channel"] for esc in escs] == list(range(first, last + 1))
    assert escs[0]["voltage"] == 12.0
    assert escs[0]["current"] == 1.0
    assert escs[0]["totalCurrentMah"] == 10
    assert escs[0]["status"] is None


def test_esc_sentinels_are_null_and_fully_unavailable_channel_is_sparse():
    msg = SimpleNamespace(temperature=[255] * 4, voltage=[65535] * 4, current=[65535] * 4,
                          totalcurrent=[65535] * 4, rpm=[65535] * 4, count=[65535] * 4)
    tm.handle_esc_telemetry_1_to_4(msg)
    assert tm.get_esc_telemetry_snapshot()["escs"] == []
    msg.temperature[0] = 30
    tm.handle_esc_telemetry_1_to_4(msg)
    esc = tm.get_esc_telemetry_snapshot()["escs"][0]
    assert esc["temperature"] == 30.0
    assert esc["voltage"] is None and esc["rpm"] is None


@pytest.mark.parametrize("store,getter", [
    ("servo", tm.get_servo_output_snapshot),
    ("esc", tm.get_esc_telemetry_snapshot),
])
def test_stale_after_three_seconds(store, getter):
    if store == "servo":
        tm.handle_servo_output_raw(SimpleNamespace(servo1_raw=1500))
        tm._servo_outputs[1]["receivedAt"] -= 4
        item = getter()["channels"][0]
    else:
        tm.handle_esc_telemetry_1_to_4(SimpleNamespace(temperature=[20], voltage=[], current=[], totalcurrent=[], rpm=[], count=[]))
        tm._esc_telemetry[1]["receivedAt"] -= 4
        item = getter()["escs"][0]
    assert item["stale"] is True
    assert item["ageMs"] >= 3000


def test_reset_clears_and_emits_both_empty_snapshots():
    tm.handle_servo_output_raw(SimpleNamespace(servo1_raw=1500))
    tm.handle_esc_telemetry_1_to_4(SimpleNamespace(temperature=[20], voltage=[], current=[], totalcurrent=[], rpm=[], count=[]))
    with patch.object(tm.sio_server, "emit") as emit:
        tm.reset_actuator_telemetry()
    assert tm.get_servo_output_snapshot()["channels"] == []
    assert tm.get_esc_telemetry_snapshot()["escs"] == []
    assert {call.args[0] for call in emit.call_args_list} == {"servo-output:update", "esc-telemetry:update"}


def test_disconnect_reset_path_clears_actuator_snapshots():
    tm.handle_servo_output_raw(SimpleNamespace(servo1_raw=1500))
    tm.reset_telemetry()
    assert tm.get_servo_output_snapshot()["channels"] == []


def test_handlers_registered():
    assert HANDLERS["SERVO_OUTPUT_RAW"] is tm.handle_servo_output_raw
    assert HANDLERS["ESC_TELEMETRY_1_TO_4"] is tm.handle_esc_telemetry_1_to_4
    assert HANDLERS["ESC_TELEMETRY_5_TO_8"] is tm.handle_esc_telemetry_5_to_8
    assert HANDLERS["ESC_TELEMETRY_9_TO_12"] is tm.handle_esc_telemetry_9_to_12


@pytest.mark.parametrize("route,view", [
    ("/api/setup/motors", "motors"),
    ("/api/setup/servo-outputs", "servo-outputs"),
    ("/api/setup/esc", "esc"),
])
def test_read_only_api_routes(route, view):
    connected()
    with params({"SERVO1_FUNCTION": 33}, metadata=motor_metadata()):
        response = client.get(route)
    assert response.status_code == 200
    assert response.json()["view"] == view
    assert response.json()["readOnly"] is True


def test_motors_api_contract_matches_frontend():
    connected()
    with params({"SERVO1_FUNCTION": 33}, metadata=motor_metadata()):
        payload = client.get("/api/setup/motors").json()
    assert payload["outputCount"] == 1
    assert payload["outputs"] == [{
        "output": 1, "motorNumber": 1, "motorLabel": "Motor 1",
        "functionId": 33, "functionLabel": "Motor 1", "configured": True,
        "source": "SERVO1_FUNCTION",
        # No FRAME_CLASS metadata in this fixture: mapping and telemetry stay
        # honestly unknown rather than being invented.
        "frameMapped": None,
        "frameMappingReason": "Frame class does not imply a motor count; motor position unknown.",
        "pwm": None, "receivedAt": None, "ageMs": None, "freshness": "UNAVAILABLE",
    }]


def test_servo_outputs_api_contract_merges_live_pwm():
    connected()
    tm.handle_servo_output_raw(SimpleNamespace(servo1_raw=1512))
    values = {"SERVO1_FUNCTION": 33, "SERVO1_MIN": 1000, "SERVO1_TRIM": 1500,
              "SERVO1_MAX": 2000, "SERVO1_REVERSED": 1}
    with params(values, metadata=motor_metadata()):
        output = client.get("/api/setup/servo-outputs").json()["outputs"][0]
    assert output["output"] == 1
    assert (output["min"], output["trim"], output["max"]) == (1000, 1500, 2000)
    assert output["reversed"] is True
    assert output["pwm"] == 1512
    assert output["freshness"] == "AVAILABLE"


def test_esc_api_contract_maps_real_telemetry_and_config():
    connected()
    tm.handle_esc_telemetry_1_to_4(SimpleNamespace(
        temperature=[30], voltage=[1200], current=[250], totalcurrent=[42], rpm=[5000], count=[1]))
    with params({"SERVO1_FUNCTION": 33, "MOT_PWM_TYPE": 6}, metadata={
        **motor_metadata(), "MOT_PWM_TYPE": {"name": "PWM type", "values": {"6": "DShot600"}},
    }):
        payload = client.get("/api/setup/esc").json()
    assert payload["escCount"] == 1
    assert payload["telemetry"][0]["index"] == 1
    assert payload["telemetry"][0]["voltage"] == 12.0
    assert payload["telemetry"][0]["consumptionMah"] == 42
    assert payload["config"][0]["decoded"] == "DShot600"


def test_explicit_unavailable_servo_value_clears_previous_sample():
    tm.handle_servo_output_raw(SimpleNamespace(servo1_raw=1500))
    tm.handle_servo_output_raw(SimpleNamespace(servo1_raw=0))
    assert tm.get_servo_output_snapshot()["channels"] == []


def test_explicit_unavailable_esc_group_clears_previous_sample():
    tm.handle_esc_telemetry_1_to_4(SimpleNamespace(
        temperature=[30], voltage=[1200], current=[250], totalcurrent=[42], rpm=[5000], count=[1]))
    tm.handle_esc_telemetry_1_to_4(SimpleNamespace(
        temperature=[255] * 4, voltage=[65535] * 4, current=[65535] * 4,
        totalcurrent=[65535] * 4, rpm=[65535] * 4, count=[65535] * 4))
    assert tm.get_esc_telemetry_snapshot()["escs"] == []


def test_motor_actuator_routes_are_test_and_reverse_only():
    """Phase 8H functionality adds motor-test + reverse config routes only.

    Servo outputs / ESC stay strictly GET. No DO_SET_SERVO / DO_SET_RELAY /
    arm-style actuator route is introduced.
    """
    motor_routes = {(method, route.path) for route in app.routes for method in getattr(route, "methods", set())
                    if route.path.startswith("/api/setup/motors")}
    assert motor_routes == {
        ("GET", "/api/setup/motors"),
        ("GET", "/api/setup/motors/test"),
        ("POST", "/api/setup/motors/test"),
        ("POST", "/api/setup/motors/test/stop"),
        ("GET", "/api/setup/motors/reverse"),
        ("POST", "/api/setup/motors/reverse"),
    }
    other_routes = {(method, route.path) for route in app.routes for method in getattr(route, "methods", set())
                    if route.path.startswith("/api/setup/servo-outputs") or route.path.startswith("/api/setup/esc")}
    assert other_routes == {("GET", "/api/setup/servo-outputs"), ("GET", "/api/setup/esc")}



# ---------------------------------------------------------------------------
# Frame-aware motor mapping (Phase 3) and real telemetry (Phase 10)
# ---------------------------------------------------------------------------

FRAME_METADATA = {
    "SERVO1_FUNCTION": {"name": "Servo output function", "values": {"33": "Motor 1"}},
    "SERVO2_FUNCTION": {"name": "Servo output function", "values": {"34": "Motor 2"}},
    "FRAME_CLASS": {
        "name": "Frame class",
        "description": "Defined multi-rotor frame class",
        "values": {"0": "Undefined", "1": "Quad", "2": "Hexa", "4": "OctaQuad", "6": "Heli"},
    },
    "FRAME_TYPE": {
        "name": "Frame type",
        "description": "Frame geometry",
        "values": {"0": "Plus", "1": "X", "4": "V-Tail"},
    },
}


def test_frame_identity_is_decoded_from_firmware_metadata():
    connected()
    with params({"SERVO1_FUNCTION": 33, "FRAME_CLASS": 1, "FRAME_TYPE": 1},
                metadata=FRAME_METADATA):
        frame = client.get("/api/setup/motors").json()["frame"]
    assert frame["class"] == 1
    assert frame["type"] == 1
    assert frame["classLabel"] == "Quad"
    assert frame["typeLabel"] == "X"
    assert frame["label"] == "Quad (X)"
    assert frame["configured"] is True
    assert frame["source"] == "firmware-metadata"
    assert frame["armCount"] == 4
    assert frame["armCountSource"] == "frame-class-label"


def test_frame_geometry_is_reported_unavailable_not_invented():
    connected()
    with params({"SERVO1_FUNCTION": 33, "FRAME_CLASS": 1, "FRAME_TYPE": 1},
                metadata=FRAME_METADATA):
        frame = client.get("/api/setup/motors").json()["frame"]
    assert frame["geometryAvailable"] is False
    assert "do not encode motor positions" in frame["geometryReason"]


def test_motor_within_frame_arm_count_is_mapped():
    connected()
    with params({"SERVO1_FUNCTION": 33, "SERVO2_FUNCTION": 34,
                 "FRAME_CLASS": 1, "FRAME_TYPE": 1}, metadata=FRAME_METADATA):
        outputs = client.get("/api/setup/motors").json()["outputs"]
    assert [o["frameMapped"] for o in outputs] == [True, True]
    assert all(o["frameMappingReason"] is None for o in outputs)


def test_motor_beyond_frame_arm_count_is_not_mapped():
    connected()
    with params({"SERVO1_FUNCTION": 33, "SERVO2_FUNCTION": 34,
                 "FRAME_CLASS": 6, "FRAME_TYPE": 0}, metadata=FRAME_METADATA):
        payload = client.get("/api/setup/motors").json()
    # Helicopter: no arm layout, so the count stays unknown rather than guessed.
    assert payload["frame"]["armCount"] is None
    assert all(o["frameMapped"] is None for o in payload["outputs"])
    assert all("does not imply a motor count" in o["frameMappingReason"] for o in payload["outputs"])


def test_undefined_frame_class_is_not_treated_as_configured():
    connected()
    with params({"SERVO1_FUNCTION": 33, "FRAME_CLASS": 0, "FRAME_TYPE": 0},
                metadata=FRAME_METADATA):
        frame = client.get("/api/setup/motors").json()["frame"]
    assert frame["configured"] is False
    assert frame["armCount"] is None


def test_frame_absent_from_parameter_cache_reports_unavailable():
    connected()
    with params({"SERVO1_FUNCTION": 33}, metadata=FRAME_METADATA):
        frame = client.get("/api/setup/motors").json()["frame"]
    assert frame["class"] is None
    assert frame["classLabel"] is None
    assert frame["source"] == "unavailable"
    assert frame["armCount"] is None


def test_motors_view_reuses_real_servo_telemetry_without_inventing_values():
    connected()
    tm.handle_servo_output_raw(SimpleNamespace(servo1_raw=1200))
    with params({"SERVO1_FUNCTION": 33}, metadata=motor_metadata()):
        output = client.get("/api/setup/motors").json()["outputs"][0]
    assert output["pwm"] == 1200
    assert output["freshness"] == "AVAILABLE"
    assert output["receivedAt"] is not None
    assert output["ageMs"] is not None


def test_motors_view_reports_missing_telemetry_as_unavailable():
    connected()
    with params({"SERVO1_FUNCTION": 33}, metadata=motor_metadata()):
        output = client.get("/api/setup/motors").json()["outputs"][0]
    assert output["pwm"] is None
    assert output["freshness"] == "UNAVAILABLE"
    assert output["receivedAt"] is None
