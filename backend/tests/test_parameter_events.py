"""Socket.IO parameter-event bridge tests (Phase 2).

A recorder replaces sio_server.emit; a fresh ParameterManager drives events.
Covers: session lifecycle, throttled sync progress, flood suppression of
parameter:updated during sync, single-complete guarantee, read/write events,
error codes, and hard guarantees that an observer can never break MAVLink.
"""

import pytest

from mavlink.parameter_manager import ParameterManager
from sio.parameter_events import PROGRESS_CHUNK, ParameterEventsBridge, events_bridge

from tests.test_parameter_manager import (
    FAKE_VEHICLE_PARAMS,
    FAST_CONFIG,
    FakeMsg,
    FakeVehicle,
    make_vehicle,
)


class Recorder:
    def __init__(self) -> None:
        self.events = []

    def emit(self, event: str, payload: dict) -> None:
        self.events.append((event, payload))

    def by_event(self, event: str) -> list:
        return [(e, p) for e, p in self.events if e == event]


@pytest.fixture()
def bridge():
    manager = ParameterManager(config=dict(FAST_CONFIG))
    rec = Recorder()
    br = ParameterEventsBridge(emit_fn=rec.emit)
    br.bind(manager)
    return manager, rec, br


def test_session_connect_and_disconnect_events():
    m = ParameterManager(config=dict(FAST_CONFIG))
    r = Recorder()
    b = ParameterEventsBridge(emit_fn=r.emit)
    b.bind(m)
    m.start_session()
    session = r.by_event("parameter:session")
    assert session and session[0][1]["connection"] == "connected"
    assert session[0][1]["sessionId"] is not None
    m.stop_session("link down")
    sessions = r.by_event("parameter:session")
    assert sessions[-1][1]["connection"] == "disconnected"
    assert sessions[-1][1]["reason"] == "link down"
    assert sessions[-1][1]["sessionId"] is None


def test_sync_start_progress_complete_and_suppression():
    params = {f"PARAM_{i:03d}": (float(i), 8) for i in range(500)}
    m = ParameterManager(config=dict(FAST_CONFIG))
    v = FakeVehicle(m, params=params)
    m._sender = v.sender
    rec = Recorder()
    b = ParameterEventsBridge(emit_fn=rec.emit)
    b.bind(m)
    m.start_session()
    m.request_all_parameters()

    starts = rec.by_event("parameter:sync:start")
    progress = rec.by_event("parameter:sync:progress")
    completes = rec.by_event("parameter:sync:complete")
    updates = rec.by_event("parameter:updated")

    assert len(starts) == 1
    assert len(completes) == 1
    assert 1 <= len(progress) <= (len(params) // PROGRESS_CHUNK) + 2
    assert progresses_are_monotonic(progress)
    # flood suppression: ZERO value-change events during the sync
    assert updates == []

    complete = completes[0][1]
    assert complete["status"] == "complete"
    assert complete["complete"] is True
    assert complete["receivedCount"] == len(params)
    assert complete["expectedCount"] == len(params)
    assert complete["missing"] == []


def progresses_are_monotonic(progress: list) -> bool:
    seen = [p["receivedCount"] for _, p in progress]
    return all(a <= b for a, b in zip(seen, seen[1:]))


def test_value_update_emitted_only_once_after_sync():
    m = ParameterManager(config=dict(FAST_CONFIG))
    v = make_vehicle(m)
    rec = Recorder()
    b = ParameterEventsBridge(emit_fn=rec.emit)
    b.bind(m)
    m.start_session()
    m.request_all_parameters()  # sync completes, updates suppressed

    m.handle_param_value(FakeMsg("FS_GCS_ENABLE", 1.0, 3, 5, 3))
    updates = rec.by_event("parameter:updated")
    assert len(updates) == 1
    assert updates[0][1]["id"] == "FS_GCS_ENABLE"
    assert updates[0][1]["value"] == 1.0

    # same authoritative value again -> no duplicate event
    m.handle_param_value(FakeMsg("FS_GCS_ENABLE", 1.0, 3, 5, 3))
    assert len(rec.by_event("parameter:updated")) == 1


def test_sync_error_on_timeout_no_complete():
    m = ParameterManager(config=dict(FAST_CONFIG))
    v = make_vehicle(m, params={})  # vehicle never sends anything
    m._sender = v.sender
    rec = Recorder()
    b = ParameterEventsBridge(emit_fn=rec.emit)
    b.bind(m)
    m.start_session()
    result = m.request_all_parameters()
    assert not result.get("status") == "success" or result.get("status") in ("failed", "timeout")
    assert rec.by_event("parameter:sync:complete") == []
    errors = rec.by_event("parameter:sync:error")
    assert len(errors) >= 1
    assert errors[-1][1]["code"] in ("TIMEOUT", "NOT_CONNECTED")


def test_sync_complete_flags_incomplete_when_missing():
    params = {f"PARAM_{i:03d}": (float(i), 8) for i in range(30)}

    class GapVehicle(FakeVehicle):
        def __init__(self, manager, params, missing_pid):
            super().__init__(manager, params=params)
            self.missing_pid = missing_pid

        def sender(self, kind, fields):
            self.calls.append((kind, dict(fields)))
            if kind == "param_request_list":
                for pid, (value, ptype) in self.params.items():
                    if pid == self.missing_pid:
                        continue
                    self._inject(pid, value, ptype, self.index_of[pid])

    m = ParameterManager(config=dict(FAST_CONFIG))
    v = GapVehicle(m, params=params, missing_pid="PARAM_007")
    m._sender = v.sender
    rec = Recorder()
    b = ParameterEventsBridge(emit_fn=rec.emit)
    b.bind(m)
    m.start_session()
    m.request_all_parameters()
    completes = rec.by_event("parameter:sync:complete")
    assert len(completes) == 1
    assert completes[0][1]["complete"] is False
    assert 7 in completes[0][1]["missing"]


def test_read_events():
    m = ParameterManager(config=dict(FAST_CONFIG))
    rec = Recorder()
    b = ParameterEventsBridge(emit_fn=rec.emit)
    b.bind(m)
    m.start_session()

    b.emit_read_start("WP_RADIUS")
    b.emit_read_result("WP_RADIUS", {"status": "success", "value": 10.0})
    asserts = rec.by_event("parameter:read:start")
    assert len(asserts) == 1 and asserts[0][1]["id"] == "WP_RADIUS"
    success = rec.by_event("parameter:read:success")
    assert len(success) == 1 and success[0][1]["value"] == 10.0

    b.emit_read_result("GHOST", {"status": "error", "message": "nope",
                                 "code": "PARAMETER_NOT_FOUND"})
    errors = rec.by_event("parameter:read:error")
    assert len(errors) == 1
    assert errors[0][1]["code"] == "PARAM_NOT_FOUND"


def test_write_event_flow_success_and_rejected():
    m = ParameterManager(config=dict(FAST_CONFIG))
    rec = Recorder()
    b = ParameterEventsBridge(emit_fn=rec.emit)
    b.bind(m)
    m.start_session()

    b.emit_write_start("SYSID_THISMAV", 2)
    b.emit_write_result("SYSID_THISMAV", 2, {"status": "success", "value": 2.0})
    assert len(rec.by_event("parameter:write:start")) == 1
    wins = rec.by_event("parameter:write:success")
    assert len(wins) == 1 and wins[0][1]["value"] == 2.0

    b.emit_write_result("FS_GCS_ENABLE", 5, {"status": "rejected", "message": "read-only"})
    rejected = rec.by_event("parameter:write:error")
    assert rejected and rejected[-1][1]["code"] == "WRITE_REJECTED"

    b.emit_write_result("FS_GCS_ENABLE", 1, {"status": "mismatch", "message": "!"})
    mismatch = rec.by_event("parameter:write:error")
    assert mismatch and mismatch[-1][1]["code"] == "WRITE_MISMATCH"


def test_metadata_status_emitted_on_complete():
    m = ParameterManager(config=dict(FAST_CONFIG))
    v = make_vehicle(m)
    m._sender = v.sender
    rec = Recorder()
    b = ParameterEventsBridge(emit_fn=rec.emit)
    b.bind(m)
    m.start_session()
    m.request_all_parameters()
    statuses = rec.by_event("parameter:metadata:status")
    assert len(statuses) >= 1
    payload = statuses[-1][1]
    assert "status" in payload and "paramCount" in payload


def test_observer_failure_never_breaks_vehicle_io():
    m = ParameterManager(config=dict(FAST_CONFIG))
    v = make_vehicle(m)

    def bad_emit(event, payload):
        raise RuntimeError("boom")

    b = ParameterEventsBridge(emit_fn=bad_emit)
    b.bind(m)              # the manager's listener path catches exceptions
    m.start_session()
    # An exception in the observer must not stop the download loop.
    result = m.request_all_parameters()
    assert result["status"] == "success"
    # And param:received notifications with a throwing listener survive too.
    m.handle_param_value(FakeMsg("FS_GCS_ENABLE", 1.0, 3, 5, 3))


def test_disconnect_clears_bridge_state():
    m = ParameterManager(config=dict(FAST_CONFIG))
    rec = Recorder()
    b = ParameterEventsBridge(emit_fn=rec.emit)
    b.bind(m)
    m.start_session()
    m.stop_session("gone")
    assert b._syncing is False
    assert b._session_id is None
    assert b._last_values == {}


def test_bridge_does_not_emit_when_no_sio():
    """The production-default emit path (sio_server.emit) must no-op safely
    when the socket server / event loop are not initialized (e.g. unit tests)."""
    m = ParameterManager(config=dict(FAST_CONFIG))
    b = ParameterEventsBridge()  # no recorder -> real sio_server.emit
    b.bind(m)
    m.start_session()
    m.stop_session("bye")
    b.emit_write_result("X", 1.0, {"status": "success", "value": 1.0})