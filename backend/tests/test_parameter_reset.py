"""Phase 6 tests: parameter reset-to-default state machine.

The full lifecycle (backup -> MAV_CMD_PREFLIGHT_STORAGE -> reboot ->
wait-link-down -> reconnect -> sync -> verify) is exercised with injected
dependencies so no hardware/transport is required, and both success and every
failure branch are covered deterministically.
"""

import time

from services.parameter_reset import (
    CODE_BACKUP_FAILED,
    CODE_NOT_CONNECTED,
    CODE_REBOOT_TIMEOUT,
    CODE_RECONNECT_FAILED,
    CODE_RESET_ACTIVE,
    CODE_RESET_FAILED,
    CODE_SYNC_FAILED,
    MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN,
    MAV_CMD_PREFLIGHT_STORAGE,
    PARAM_RESET_FACTORY_DEFAULT,
    REBOOT_SHUTDOWN_ACTION_REBOOT,
    REBOOT_SHUTDOWN_CONDITIONS_FORCE,
    STATE_BACKUP,
    STATE_COMPLETE,
    STATE_FAILED,
    STATE_PARAMETER_SYNC,
    STATE_RECONNECTING,
    STATE_RESET_REQUESTED,
    STATE_REBOOT_REQUESTED,
    STATE_VERIFY,
    STATE_WAITING_FOR_REBOOT,
    ParameterResetManager,
)
from mavlink import parameter_manager as pm


class FakeResetDeps:
    """Deterministic reset dependencies recording every call."""

    def __init__(self, backup=None, ack_success=True, link_drops=True,
                 reconnect_ok=True, sync_ok=True,
                 snapshot=None, connected=True) -> None:
        self.connected_ = connected
        self.backup_ = backup if backup is not None else {"WP_RADIUS": 10.0}
        self.ack_success = ack_success
        self.reconnect_ok = reconnect_ok
        self.sync_ok = sync_ok
        self.css = []
        self.commands = []
        self.link_wait_requests = []
        self.reconnect_attempts = []
        self.snapshot_ = snapshot if snapshot is not None else [
            {"id": "WP_RADIUS", "value": 2.0, "type": pm.MAV_PARAM_TYPE_REAL32}]
        self.link_drops = link_drops
        self._connected = connected

        self.deps = {
            "connected": lambda: self._connected,
            "backup": lambda: dict(self.backup_),
            "send_command": self._send_command,
            "wait_link_down": self._wait_link_down,
            "reconnect": self._reconnect,
            "sync": self._sync,
            "snapshot": lambda: list(self.snapshot_),
        }

    def _send_command(self, command, params):
        self.commands.append((command, tuple(params)))
        if self.ack_success:
            return {"success": True, "ackCode": 0, "ackLabel": "ACCEPTED",
                    "message": "Command accepted."}
        return {"success": False, "ackCode": 4, "ackLabel": "FAILED",
                "message": "Command failed."}

    def _wait_link_down(self, timeout):
        self.link_wait_requests.append(timeout)
        if self.link_drops:
            self._connected = False
            return True
        return False

    def _reconnect(self):
        self.reconnect_attempts.append(1)
        if self.reconnect_ok:
            self._connected = True
        return (self.reconnect_ok, "Reconnected" if self.reconnect_ok else "failed")

    def _sync(self):
        self.css.append(1)
        if not self.sync_ok:
            return {"status": pm.RESULT_TIMEOUT, "message": "sync timed out",
                    "syncState": "failed"}
        return {"status": pm.RESULT_SUCCESS, "syncState": "complete",
                "receivedCount": 1, "expectedCount": 1}


def make_manager(deps=None, events=None, step=0.0):
    m = ParameterResetManager(deps=(deps or FakeResetDeps()).deps,
                              emit=events, step_delay_s=step)
    return m


def wait_until(predicate, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return False


# ---------------------------------------------------------------------------
# Guards
# ---------------------------------------------------------------------------

def test_reset_requires_confirmation():
    m = make_manager()
    result = m.start(confirm=False)
    assert result["success"] is False
    assert result["error"]["code"] == "BAD_REQUEST"
    assert not m.is_active()


def test_reset_rejected_when_not_connected():
    deps = FakeResetDeps(connected=False)
    m = make_manager(deps)
    result = m.start(confirm=True)
    assert result["success"] is False
    assert result["error"]["code"] == CODE_NOT_CONNECTED
    assert not m.is_active()


def test_reset_rejects_second_active_run():
    deps = FakeResetDeps(ack_success=True, link_drops=True)
    m = make_manager(deps, step=0.01)
    first = m.start(confirm=True)
    assert first["success"] is True
    second = m.start(confirm=True)
    assert second["success"] is False
    assert second["error"]["code"] == CODE_RESET_ACTIVE
    assert wait_until(lambda: m.status()["state"] == STATE_COMPLETE)


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------

def test_happy_path_reaches_complete_with_verify_counts():
    events = []
    deps = FakeResetDeps(backup={"WP_RADIUS": 10.0, "SYSID_THISMAV": 1.0},
                         snapshot=[
                             {"id": "WP_RADIUS", "value": 2.0,
                              "type": pm.MAV_PARAM_TYPE_REAL32},
                             {"id": "SYSID_THISMAV", "value": 1.0,
                              "type": pm.MAV_PARAM_TYPE_UINT8},
                         ])
    m = make_manager(deps, events=lambda ev, data: events.append(ev), step=0.01)
    result = m.start(confirm=True)
    assert result["success"] is True

    assert wait_until(lambda: m.status()["state"] == STATE_COMPLETE)
    status = m.status()
    summary = status["summary"]
    assert summary["changedCount"] == 1
    assert summary["changedParams"] == ["WP_RADIUS"]
    # Commands used are the real protocol commands / params.
    assert deps.commands == [
        (MAV_CMD_PREFLIGHT_STORAGE,
         (PARAM_RESET_FACTORY_DEFAULT, 0, 0, 0, 0, 0, 0)),
        (MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN,
         (REBOOT_SHUTDOWN_ACTION_REBOOT, 0, 0, 0, 0,
          REBOOT_SHUTDOWN_CONDITIONS_FORCE, 0)),
    ]
    assert deps.link_wait_requests[0] > 0
    assert deps.reconnect_attempts == [1]
    # The complete lifecycle emits start/progress/reconnect/complete events.
    assert "parameter:reset:start" in events
    assert "parameter:reset:reconnect" in events
    assert "parameter:reset:complete" in events
    assert not m.is_active()


def test_progress_walks_full_stage_order():
    collected = []
    deps = FakeResetDeps()
    m = make_manager(deps,
                     events=lambda ev, data: collected.append((ev, data)),
                     step=0.001)
    m.start(confirm=True)
    assert wait_until(lambda: m.status()["state"] == STATE_COMPLETE)
    states = [data["state"] for ev, data in collected
              if ev == "parameter:reset:progress"]
    assert states == [
        STATE_BACKUP,
        STATE_RESET_REQUESTED,
        STATE_REBOOT_REQUESTED,
        STATE_WAITING_FOR_REBOOT,
        STATE_RECONNECTING,
        STATE_PARAMETER_SYNC,
        STATE_VERIFY,
        STATE_COMPLETE,
    ]
    steps = [data["step"] for ev, data in collected
             if ev == "parameter:reset:progress"]
    assert steps == [1, 2, 3, 4, 5, 6, 7, 8]


# ---------------------------------------------------------------------------
# Failure branches
# ---------------------------------------------------------------------------

def test_empty_backup_aborts():
    m = make_manager(FakeResetDeps(backup={}), step=0.01)
    m.start(confirm=True)
    assert wait_until(lambda: m.status()["state"] == STATE_FAILED)
    assert m.status()["error"]["code"] == CODE_BACKUP_FAILED
    assert not m.is_active()


def test_reset_ack_rejected_fails():
    m = make_manager(FakeResetDeps(ack_success=False), step=0.01)
    m.start(confirm=True)
    assert wait_until(lambda: m.status()["state"] == STATE_FAILED)
    assert m.status()["error"]["code"] == CODE_RESET_FAILED


def test_reboot_ack_rejected_fails():
    deps = FakeResetDeps()

    def send_command(command, params):
        deps.commands.append((command, tuple(params)))
        ok = command == MAV_CMD_PREFLIGHT_STORAGE
        return ({"success": ok, "ackCode": 4 if not ok else 0,
                 "ackLabel": "FAILED" if not ok else "ACCEPTED",
                 "message": ""})

    deps.deps["send_command"] = send_command
    m = make_manager(deps, step=0.01)
    m.start(confirm=True)
    assert wait_until(lambda: m.status()["state"] == STATE_FAILED)
    assert m.status()["error"]["code"] == CODE_RESET_FAILED


def test_wait_link_down_timeout_fails():
    m = make_manager(FakeResetDeps(link_drops=False), step=0.01)
    m.start(confirm=True)
    assert wait_until(lambda: m.status()["state"] == STATE_FAILED)
    assert m.status()["error"]["code"] == CODE_REBOOT_TIMEOUT


def test_reconnect_failure_fails():
    deps = FakeResetDeps(reconnect_ok=False, link_drops=True)
    m = make_manager(deps, step=0.01)
    m.start(confirm=True)
    assert wait_until(lambda: m.status()["state"] == STATE_FAILED)
    assert m.status()["error"]["code"] == CODE_RECONNECT_FAILED
    assert len(deps.reconnect_attempts) == m._reconnect_attempts


def test_sync_failure_fails():
    deps = FakeResetDeps(sync_ok=False)
    m = make_manager(deps, step=0.01)
    m.start(confirm=True)
    assert wait_until(lambda: m.status()["state"] == STATE_FAILED)
    assert m.status()["error"]["code"] == CODE_SYNC_FAILED


def test_error_event_emitted_on_failure():
    events = []
    deps = FakeResetDeps(sync_ok=False)
    m = make_manager(deps, events=lambda ev, data: events.append(ev), step=0.01)
    m.start(confirm=True)
    assert wait_until(lambda: m.status()["state"] == STATE_FAILED)
    assert "parameter:reset:error" in events


def test_worker_exception_becomes_failed():
    deps = FakeResetDeps()

    def boom():
        raise RuntimeError("transport exploded")

    deps.deps["backup"] = boom
    m = make_manager(deps, step=0.01)
    m.start(confirm=True)
    assert wait_until(lambda: m.status()["state"] == STATE_FAILED)
    assert m.status()["error"]["code"] == CODE_RESET_FAILED