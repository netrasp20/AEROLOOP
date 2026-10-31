"""Phase 8H functional Motors tests: capability gate, state machine, command,
reverse configuration, disconnect/reconnect and the SITL-only safety boundary.
"""

import time
from contextlib import contextmanager
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app import app
from core.state import telemetry, vehicle_state
from mavlink import command_service
from mavlink.connection_manager import manager
from mavlink.parameter_manager import parameter_manager
from services import motor_setup_service
from services import motor_test_service as svc

client = TestClient(app)


MOTORS = [
    {"channel": 1, "motorNumber": 1, "functionId": 33, "isMotor": True},
    {"channel": 2, "motorNumber": 2, "functionId": 34, "isMotor": True},
    {"channel": 3, "motorNumber": 3, "functionId": 35, "isMotor": True},
    {"channel": 4, "motorNumber": 4, "functionId": 36, "isMotor": True},
]


@pytest.fixture(autouse=True)
def clean_state():
    svc.reset_state_for_tests()
    state = dict(vehicle_state)
    telem = dict(telemetry)
    yield
    svc.reset_state_for_tests()
    vehicle_state.clear()
    vehicle_state.update(state)
    telemetry.clear()
    telemetry.update(telem)


def set_vehicle(vehicle="QUADROTOR", autopilot="ARDUPILOTMEGA", connected=True, armed=False):
    vehicle_state.update({
        "connected": connected,
        "connectionState": "connected" if connected else "disconnected",
        "disconnectReason": None,
        "vehicleType": vehicle,
        "autopilot": autopilot,
        "armed": armed,
        "lastHeartbeat": int(time.time() * 1000) if connected else 0,
    })


@contextmanager
def env(transport="tcp", sim=True, sync="complete", motors=MOTORS, reverse_values=None):
    reverse_values = reverse_values or {}
    entries = [{"id": "SIM_SPEEDUP", "value": 1.0} for _ in [0]] if sim else []
    entries += [{"id": f"SERVO{m['channel']}_REVERSED", "value": reverse_values.get(m["channel"], 0)} for m in motors]
    sync_data = {"connected": True, "state": sync, "complete": sync == "complete", "cachedEntries": len(entries)}
    motor_payload = {"motors": motors}
    with patch.object(manager, "connection_type", transport), \
         patch.object(parameter_manager, "get_all_parameters", return_value=entries), \
         patch.object(parameter_manager, "get_synchronization_state", return_value=sync_data), \
         patch.object(parameter_manager, "get_parameter",
                      side_effect=lambda pid: {"id": pid, "value": reverse_values.get(int(pid.split("SERVO")[1].split("_")[0]), 0)}), \
         patch.object(parameter_manager, "set_parameter") as set_param, \
         patch.object(motor_setup_service, "get_motor_setup", return_value=motor_payload):
        yield set_param


@contextmanager
def command_transport(ack=None):
    ack = ack or {"success": True, "ackCode": 0, "ackLabel": "ACCEPTED"}
    sent = []

    def fake_wait(command_id, send_fn=None):
        if send_fn:
            send_fn()
        return ack

    def fake_send(command, *params):
        sent.append((command, params))

    with patch.object(command_service, "wait_for_command_ack", side_effect=fake_wait), \
         patch.object(command_service, "send_command_long", side_effect=fake_send):
        yield sent


# ------------------------------------------------------------------
# Capability gate
# ------------------------------------------------------------------

def test_sitl_tcp_with_sim_params_is_supported():
    set_vehicle()
    with env(transport="tcp", sim=True):
        cap = svc.capability()
    assert cap["supported"] is True
    assert cap["environment"] == "SITL"
    assert cap["readOnly"] is False


def test_serial_hardware_is_read_only():
    set_vehicle()
    with env(transport="serial", sim=True):
        cap = svc.capability()
    assert cap["supported"] is False
    assert cap["environment"] == "HARDWARE"
    assert cap["readOnly"] is True
    assert any("read-only" in r for r in cap["reasons"])


def test_tcp_without_sim_params_is_treated_as_hardware():
    set_vehicle()
    with env(transport="tcp", sim=False):
        cap = svc.capability()
    assert cap["environment"] == "HARDWARE"
    assert cap["supported"] is False


def test_unsupported_vehicle_and_autopilot_are_blocked():
    with env():
        set_vehicle(vehicle="GROUND_ROVER")
        assert svc.capability()["supported"] is False
        set_vehicle(autopilot="PX4")
        assert svc.capability()["supported"] is False


def test_incomplete_sync_blocks_capability():
    set_vehicle()
    with env(sync="receiving"):
        assert svc.capability()["supported"] is False


# ------------------------------------------------------------------
# Hardware safety boundary — no command ever leaves the backend
# ------------------------------------------------------------------

def test_hardware_start_test_sends_no_command():
    set_vehicle()
    with env(transport="serial", sim=True), command_transport() as sent:
        result = svc.start_test(1)
    assert result["success"] is False
    assert sent == []
    assert svc.snapshot()["readOnly"] is True


def test_hardware_reverse_write_sends_no_parameter():
    set_vehicle()
    with env(transport="serial", sim=True) as set_param:
        result = svc.set_reverse(1, True)
    assert result["success"] is False
    set_param.assert_not_called()


# ------------------------------------------------------------------
# Discovery-driven mapping (no hardcoded SERVO index)
# ------------------------------------------------------------------

def test_start_test_rejects_unknown_motor():
    set_vehicle()
    with env(), command_transport() as sent:
        result = svc.start_test(7)
    assert result["success"] is False
    assert sent == []


def test_start_test_uses_discovered_channel_not_index_guess():
    set_vehicle()
    # Motor 2 lives on output 6 in this (hypothetical) live config.
    motors = [{"channel": 6, "motorNumber": 2, "functionId": 34, "isMotor": True}]
    with env(motors=motors), command_transport() as sent:
        result = svc.start_test(2)
    assert result["success"] is True
    assert result["activeMotor"] == 2
    assert sent and sent[0][0] == svc.MAV_CMD_DO_MOTOR_TEST


# ------------------------------------------------------------------
# Command contents + bounds
# ------------------------------------------------------------------

def test_command_parameters_are_bounded_and_correct():
    set_vehicle()
    with env(), command_transport() as sent:
        svc.start_test(3, throttle_pct=999, timeout_s=999)
    command, params = sent[0]
    assert command == 209
    assert params[0] == 3.0                     # instance (motor number)
    assert params[1] == 0.0                     # throttle type percent
    assert params[2] == svc.THROTTLE_PCT_MAX    # clamped
    assert params[3] == float(svc.TIMEOUT_S_MAX)  # clamped
    assert params[4] == 1.0                     # motor count
    assert params[5] == 0.0                     # test order


def test_defaults_are_the_documented_safe_values():
    set_vehicle()
    with env(), command_transport() as sent:
        svc.start_test(1)
    _, params = sent[0]
    assert params[2] == svc.THROTTLE_PCT_DEFAULT
    assert params[3] == float(svc.TIMEOUT_S_DEFAULT)


def test_armed_vehicle_is_rejected_without_command():
    set_vehicle(armed=True)
    with env(), command_transport() as sent:
        result = svc.start_test(1)
    assert result["success"] is False
    assert sent == []


def test_rejected_ack_sets_error_state():
    set_vehicle()
    with env(), command_transport(ack={"success": False, "ackCode": 2, "ackLabel": "DENIED"}):
        result = svc.start_test(1)
    assert result["success"] is False
    assert svc.snapshot()["state"] == svc.ERROR


# ------------------------------------------------------------------
# State machine
# ------------------------------------------------------------------

def test_start_sets_testing_and_emits():
    set_vehicle()
    with env(), command_transport(), patch("services.motor_test_service.sio_server.emit") as emit:
        result = svc.start_test(1, throttle_pct=5, timeout_s=2)
    assert result["success"] is True
    assert svc.snapshot()["state"] == svc.TESTING
    assert emit.called


def test_second_start_while_testing_is_busy():
    set_vehicle()
    with env(), command_transport() as sent:
        svc.start_test(1, timeout_s=5)
        result = svc.start_test(2, timeout_s=5)
    assert result["success"] is False
    assert len(sent) == 1


def test_timeout_returns_to_stopped():
    set_vehicle()
    with env(), command_transport():
        svc.start_test(1, timeout_s=1)
    svc._auto_stop()
    assert svc.snapshot()["state"] == svc.STOPPED
    assert svc.snapshot()["activeMotor"] is None


def test_stop_clears_session():
    set_vehicle()
    with env(), command_transport():
        svc.start_test(1, timeout_s=5)
        result = svc.stop_test()
    assert result["success"] is True
    assert svc.snapshot()["state"] == svc.STOPPED


def test_stop_when_idle_is_noop():
    set_vehicle()
    with env():
        result = svc.stop_test()
    assert result["success"] is False


# ------------------------------------------------------------------
# Disconnect / reconnect
# ------------------------------------------------------------------

def test_connection_loss_sets_disconnected_and_cancels():
    set_vehicle()
    with env(), command_transport():
        svc.start_test(1, timeout_s=5)
        svc.notify_connection_lost("heartbeat_timeout")
    snap = svc.snapshot()
    assert snap["state"] == svc.DISCONNECTED
    assert snap["activeMotor"] is None


def test_fresh_link_resets_to_idle():
    set_vehicle()
    with env(), command_transport():
        svc.start_test(1, timeout_s=5)
        svc.notify_connection_lost("x")
        svc.reset_for_fresh_link()
    assert svc.snapshot()["state"] == svc.IDLE


# ------------------------------------------------------------------
# Reverse configuration
# ------------------------------------------------------------------

def test_reverse_write_targets_discovered_output_and_marks_unverified():
    set_vehicle()
    with env() as set_param:
        set_param.return_value = {"status": "success", "message": "Write confirmed", "value": 1}
        result = svc.set_reverse(3, True)
    set_param.assert_called_once_with("SERVO3_REVERSED", 1)
    assert result["success"] is True
    assert result["configured"] is True
    assert result["physicallyVerified"] is False


def test_reverse_states_read_live_values():
    set_vehicle()
    with env(reverse_values={1: 1, 2: 0, 3: 1, 4: 0}):
        states = svc.reverse_states()
    assert [s["configured"] for s in states] == [True, False, True, False]
    assert all(s["physicallyVerified"] is False for s in states)
    assert states[0]["paramId"] == "SERVO1_REVERSED"


# ------------------------------------------------------------------
# HTTP routes
# ------------------------------------------------------------------

def test_state_route_is_read_only_snapshot():
    set_vehicle()
    with env():
        payload = client.get("/api/setup/motors/test").json()
    assert payload["environment"] == "SITL"
    assert "bounds" in payload


def test_start_route_blocks_hardware():
    set_vehicle()
    with env(transport="serial", sim=True):
        response = client.post("/api/setup/motors/test", json={"motor": 1})
    assert response.status_code == 200
    assert response.json()["success"] is False


def test_reverse_route_contract():
    set_vehicle()
    with env() as set_param:
        set_param.return_value = {"status": "success", "message": "ok", "value": 0}
        response = client.post("/api/setup/motors/reverse", json={"motor": 1, "reversed": False})
    assert response.json()["paramId"] == "SERVO1_REVERSED"
