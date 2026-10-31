"""Unit tests for the MAVLink Parameter Manager (Phase 1).

Everything runs against the real ``ParameterManager`` with an injected fake
sender + fabricated PARAM_VALUE messages — no sockets, no threads, hermetic.

The fake vehicle mirrors ArduPilot behavior:
  * PARAM_REQUEST_LIST  -> streams one PARAM_VALUE per parameter (index/count)
  * PARAM_REQUEST_READ  -> replies with that parameter's PARAM_VALUE
  * PARAM_SET           -> echoes the new value (write) or new-then-old (read-only)

Fast, deterministic timing via the overridable ``config`` argument.
"""

import threading

import pytest

from mavlink.parameter_manager import (
    MAV_PARAM_TYPE_INT16,
    MAV_PARAM_TYPE_INT32,
    MAV_PARAM_TYPE_REAL32,
    MAV_PARAM_TYPE_UINT8,
    RESULT_DISCONNECTED,
    RESULT_INVALID_PARAMETER,
    RESULT_INVALID_VALUE,
    RESULT_MISMATCH,
    RESULT_REJECTED,
    RESULT_SUCCESS,
    RESULT_TIMEOUT,
    STATE_COMPLETE,
    STATE_FAILED,
    STATE_IDLE,
    normalize_value,
    values_match,
)
from mavlink.parameter_manager import ParameterManager, ParameterError

# Fast, deterministic timing for tests.
FAST_CONFIG = {
    "download_start_timeout_s": 0.4,
    "download_quiet_s": 0.05,
    "download_missing_retries": 2,
    "download_missing_retry_delay_s": 0.01,
    "read_timeout_s": 0.3,
    "read_retries": 2,
    "write_timeout_s": 0.3,
    "write_retries": 2,
    "write_echo_grace_s": 0.05,
    "float_rel_tol": 1e-6,
    "float_abs_tol": 1e-7,
}

FAKE_VEHICLE_PARAMS = {
    # id: (value, type)
    "WP_RADIUS": (10.0, MAV_PARAM_TYPE_REAL32),
    "WPNAV_SPEED": (500.0, MAV_PARAM_TYPE_INT16),
    "SYSID_THISMAV": (1, MAV_PARAM_TYPE_UINT8),
    "FS_GCS_ENABLE": (0, MAV_PARAM_TYPE_UINT8),
    "ATC_ACCEL_MAX": (110000.0, MAV_PARAM_TYPE_INT32),
}


class FakeMsg:
    """Pymavlink-shaped PARAM_VALUE carrier (msgid 22)."""

    def __init__(self, param_id: str, param_value: float, param_type: int,
                 param_count: int, param_index: int) -> None:
        self.param_id = param_id
        self.param_value = param_value
        self.param_type = param_type
        self.param_count = param_count
        self.param_index = param_index

    def get_msgId(self):
        return 22


class FakeVehicle:
    """Accumulates sends and answers them like ArduPilot would."""

    def __init__(self, manager: ParameterManager,
                 params: dict = FAKE_VEHICLE_PARAMS,
                 block_reads: bool = False) -> None:
        self.manager = manager
        self.params = dict(params)
        self.block_reads = block_reads
        self.calls = []
        self.index_of = {pid: i for i, pid in enumerate(self.params)}

    def sender(self, kind: str, fields: dict) -> None:
        self.calls.append((kind, dict(fields)))
        f = fields
        if kind == "param_request_list":
            for pid, (value, ptype) in self.params.items():
                self._inject(pid, value, ptype, self.index_of[pid])
        elif kind == "param_request_read":
            if not self.block_reads:
                pid = f.get("param_id") or list(self.params)[f["param_index"]]
                if pid in self.params:
                    self._inject(pid, self.params[pid][0], self.params[pid][1],
                                 self.index_of[pid])
        elif kind == "param_set":
            pid = f["param_id"]
            if pid in self.params:
                self._inject(pid, f["param_value"], f["param_type"],
                             self.index_of[pid])

    def _inject(self, pid: str, value: float, ptype: int, index: int) -> None:
        self.manager.handle_param_value(
            FakeMsg(pid, value, ptype, len(self.params), index)
        )

    def kinds(self) -> list:
        return [c[0] for c in self.calls]

    def reads(self) -> list:
        return [c for c in self.calls if c[0] == "param_request_read"]

    def sets(self) -> list:
        return [c for c in self.calls if c[0] == "param_set"]


def make_vehicle(manager: ParameterManager, **kwargs) -> FakeVehicle:
    vehicle = FakeVehicle(manager, **kwargs)
    manager._sender = vehicle.sender
    return vehicle


def make_manager(config: dict | None = None) -> ParameterManager:
    m = ParameterManager(config=dict(FAST_CONFIG, **(config or {})))
    m.start_session()
    return m


def inject(manager: ParameterManager, pid: str, value: float, ptype: int,
           index: int = 0, count: int = 1) -> None:
    manager.handle_param_value(FakeMsg(pid, value, ptype, count, index))


# ---------------------------------------------------------------------------
# Download (PARAM_REQUEST_LIST)
# ---------------------------------------------------------------------------


def test_request_list_sent_with_target_ids():
    m = make_manager()
    v = make_vehicle(m)
    result = m.request_all_parameters()
    assert result["status"] == RESULT_SUCCESS
    assert len(v.calls) == 1
    kind, f = v.calls[0]
    assert kind == "param_request_list"
    assert f["target_system"] == 1
    assert f["target_component"] == 1


def test_download_populates_cache_by_id():
    m = make_manager()
    make_vehicle(m)
    result = m.request_all_parameters()
    assert result["status"] == RESULT_SUCCESS
    snap = m.get_parameter("WP_RADIUS")
    assert snap["value"] == 10.0
    assert snap["type"] == MAV_PARAM_TYPE_REAL32
    assert snap["index"] == 0
    assert snap["count"] == len(FAKE_VEHICLE_PARAMS)
    # all params downloaded, none expected to be stale
    assert all(p["received"] for p in m.get_all_parameters())


def test_download_state_complete_and_count_matches():
    m = make_manager()
    make_vehicle(m)
    m.request_all_parameters()
    sync = m.get_synchronization_state()
    assert sync["state"] == STATE_COMPLETE
    assert sync["receivedCount"] == len(FAKE_VEHICLE_PARAMS)
    assert sync["expectedCount"] == len(FAKE_VEHICLE_PARAMS)
    assert sync["missingIds"] == []


def test_duplicate_param_value_updates_single_entry():
    m = make_manager()
    inject(m, "WP_SPEED", 100.0, MAV_PARAM_TYPE_INT16, 0, 1)
    inject(m, "WP_SPEED", 115.0, MAV_PARAM_TYPE_INT16, 0, 1)
    assert m.get_parameter("WP_SPEED")["value"] == 115.0
    assert len(m._cache) == 1


def test_param_id_is_identity_not_index():
    m = make_manager()
    # Same id at a new index (hidden param exposed): still ONE entry.
    inject(m, "HIDDEN_A", 5.0, MAV_PARAM_TYPE_INT16, 10, 20)
    inject(m, "HIDDEN_A", 6.0, MAV_PARAM_TYPE_INT16, 3, 20)
    entry = m.get_parameter("HIDDEN_A")
    assert entry is not None and entry["index"] == 3
    assert len(m._cache) == 1
    # Different ids -> separate entries even with the same index.
    inject(m, "B", 7.0, MAV_PARAM_TYPE_INT16, 3, 20)
    assert len(m._cache) == 2


def test_download_start_timeout_when_no_response():
    m = make_manager()
    make_vehicle(m, params={})  # list request answered with nothing
    result = m.request_all_parameters()
    assert result["status"] == RESULT_TIMEOUT
    assert m.get_synchronization_state()["state"] == STATE_FAILED


def test_download_incomplete_reports_missing_ids():
    m = make_manager()

    def bare_sender(kind, fields):
        if kind == "param_request_list":
            # announce 3 params but stream only 2; index 2 is never delivered
            inject(m, "A", 1.0, MAV_PARAM_TYPE_INT16, 0, 3)
            inject(m, "B", 2.0, MAV_PARAM_TYPE_INT16, 1, 3)

    m._sender = bare_sender
    result = m.request_all_parameters()
    assert result["status"] == RESULT_SUCCESS  # best-effort complete
    assert "missing" in result
    assert result["missing"] == [2]  # the index the vehicle never streamed


def test_gap_fill_requests_missing_index():
    m = make_manager()

    def sender(kind, fields):
        if kind == "param_request_list":
            inject(m, "A", 1.0, MAV_PARAM_TYPE_INT16, 0, 3)
            inject(m, "B", 2.0, MAV_PARAM_TYPE_INT16, 1, 3)
            # index 2 (C) is never streamed initially
        elif kind == "param_request_read":
            index = fields["param_index"]
            if fields.get("param_id"):
                inject(m, fields["param_id"], 3.0, MAV_PARAM_TYPE_INT16, index, 3)
            else:
                inject(m, "C", 3.0, MAV_PARAM_TYPE_INT16, index, 3)

    m._sender = sender
    result = m.request_all_parameters()
    assert result["status"] == RESULT_SUCCESS
    # The gap-fill must have requested index 2 by name of the missing id.
    m._cache  # cache populated
    assert m.get_parameter("C")["value"] == 3.0
    assert m.get_synchronization_state()["missingIds"] == []


def test_refresh_marks_unseen_entries_stale():
    m = make_manager()
    v = make_vehicle(m)
    m.request_all_parameters()
    # Vehicle now hides WPNAV_SPEED (subsystem disabled).
    v.params.pop("WPNAV_SPEED")
    result = m.refresh_parameters()
    assert result["status"] == RESULT_SUCCESS
    stale = m.get_parameter("WPNAV_SPEED")
    assert stale is not None and stale["received"] is False
    fresh = m.get_parameter("WP_RADIUS")
    assert fresh["received"] is True


def test_count_change_sets_needs_refresh():
    m = make_manager()
    inject(m, "A", 1.0, MAV_PARAM_TYPE_INT16, 0, 10)
    inject(m, "A", 1.0, MAV_PARAM_TYPE_INT16, 0, 15)
    assert m._needs_refresh is True


def test_cancel_download():
    m = make_manager()

    def silent(kind, fields):
        pass

    m._sender = silent
    thread_result = {}

    def run():
        thread_result["result"] = m.request_all_parameters()

    t = threading.Thread(target=run)
    t.start()
    # Give the download a moment to start, then cancel it.
    t.join(timeout=0.05)
    m.cancel_download()
    t.join(timeout=2)
    assert thread_result["result"]["status"] == RESULT_DISCONNECTED  # cancelled path
    assert m._download_active is False
    assert m.get_synchronization_state()["state"] == STATE_IDLE


# ---------------------------------------------------------------------------
# Reads (PARAM_REQUEST_READ)
# ---------------------------------------------------------------------------


def test_individual_read_returns_value():
    m = make_manager()
    v = make_vehicle(m)
    m.request_all_parameters()
    result = m.read_parameter("WP_RADIUS")
    assert result["status"] == RESULT_SUCCESS
    assert result["value"] == 10.0
    reads = v.reads()
    assert len(reads) == 1
    assert reads[0][1]["param_id"] == "WP_RADIUS"
    assert reads[0][1]["param_index"] == -1


def test_read_is_correlated_by_param_id():
    m = make_manager()
    make_vehicle(m, params={"A": (1.0, MAV_PARAM_TYPE_INT16),
                            "B": (2.0, MAV_PARAM_TYPE_INT16)})
    m.request_all_parameters()
    result = m.read_parameter("A")
    assert result["status"] == RESULT_SUCCESS and result["value"] == 1.0


def test_read_value_comes_from_vehicle_authority():
    m = make_manager()
    make_vehicle(m)
    m.request_all_parameters()
    result = m.read_parameter("FS_GCS_ENABLE")
    assert result["status"] == RESULT_SUCCESS and result["value"] == 0


def test_read_unknown_parameter_fails_without_sending():
    m = make_manager()
    v = make_vehicle(m)
    result = m.read_parameter("NOPE_DOES_NOT_EXIST")
    assert result["status"] == RESULT_INVALID_PARAMETER
    assert v.reads() == []


def test_read_empty_id_fails():
    m = make_manager()
    result = m.read_parameter("")
    assert result["status"] == RESULT_INVALID_PARAMETER


def test_read_timeout_is_bounded_by_retries():
    m = make_manager()
    v = make_vehicle(m)
    m.request_all_parameters()
    v.block_reads = True
    result = m.read_parameter("WP_RADIUS")
    assert result["status"] == RESULT_TIMEOUT
    assert len(v.reads()) == 3  # 1 initial + 2 retries


# ---------------------------------------------------------------------------
# Writes (PARAM_SET) with echo verification
# ---------------------------------------------------------------------------


def test_set_sends_correct_fields():
    m = make_manager()
    v = make_vehicle(m)
    m.request_all_parameters()
    m.set_parameter("WPNAV_SPEED", 600)
    sets = v.sets()
    assert len(sets) == 1
    kind, f = sets[0]
    assert kind == "param_set"
    assert f["target_system"] == 1
    assert f["target_component"] == 1
    assert f["param_id"] == "WPNAV_SPEED"
    assert f["param_value"] == 600.0
    assert f["param_type"] == MAV_PARAM_TYPE_INT16


def test_set_echo_confirms_success_and_updates_cache():
    m = make_manager()
    make_vehicle(m)
    m.request_all_parameters()
    result = m.set_parameter("WP_RADIUS", 12.5)
    assert result["status"] == RESULT_SUCCESS
    assert result["value"] == 12.5
    entry = m.get_parameter("WP_RADIUS")
    assert entry["value"] == 12.5
    assert entry["writeState"] == "verified"


def test_set_mismatch_reported():
    m = make_manager()
    make_vehicle(m)
    m.request_all_parameters()

    def sender(kind, fields):
        if kind == "param_set":
            inject(m, "WP_RADIUS", 42.0, MAV_PARAM_TYPE_REAL32, 0, 1)

    m._sender = sender
    result = m.set_parameter("WP_RADIUS", 12.5)
    assert result["status"] == RESULT_MISMATCH


def test_set_readonly_double_echo_is_rejected():
    m = make_manager()
    make_vehicle(m)
    m.request_all_parameters()

    def sender(kind, fields):
        if kind == "param_set":
            # documented read-only pattern: new value, then original value
            inject(m, "SYSID_THISMAV", 99.0, MAV_PARAM_TYPE_UINT8, 0, 1)
            inject(m, "SYSID_THISMAV", 1.0, MAV_PARAM_TYPE_UINT8, 0, 1)

    m._sender = sender
    result = m.set_parameter("SYSID_THISMAV", 99)
    assert result["status"] == RESULT_REJECTED
    # cache must reflect the vehicle's real (unchanged) value
    assert m.get_parameter("SYSID_THISMAV")["value"] == 1.0


def test_set_unchanged_echo_is_rejected():
    m = make_manager()
    make_vehicle(m)
    m.request_all_parameters()

    def sender(kind, fields):
        if kind == "param_set":
            inject(m, "WP_RADIUS", 10.0, MAV_PARAM_TYPE_REAL32, 0, 1)  # old value

    m._sender = sender
    result = m.set_parameter("WP_RADIUS", 12.5)
    assert result["status"] == RESULT_REJECTED


def test_set_timeout_is_bounded_by_retries():
    m = make_manager()
    make_vehicle(m)
    m.request_all_parameters()
    calls = []

    def spy(kind, fields):
        calls.append(kind)

    m._sender = spy
    result = m.set_parameter("WP_RADIUS", 12.5)
    assert result["status"] == RESULT_TIMEOUT
    assert calls.count("param_set") == 3  # 1 initial + 2 retries


def test_set_unknown_parameter_fails_without_sending():
    m = make_manager()
    calls = []

    def spy(kind, fields):
        calls.append(kind)

    m._sender = spy
    result = m.set_parameter("NOPE", 5)
    assert result["status"] == RESULT_INVALID_PARAMETER
    assert calls == []


# ---------------------------------------------------------------------------
# Value normalization / comparison
# ---------------------------------------------------------------------------


def test_normalize_integer_bounds():
    assert normalize_value(5.9, MAV_PARAM_TYPE_INT16) == 6.0
    assert normalize_value(255, MAV_PARAM_TYPE_UINT8) == 255.0
    with pytest.raises(ParameterError) as e:
        normalize_value(256, MAV_PARAM_TYPE_UINT8)
    assert e.value.code == "INVALID_PARAMETER_VALUE"


def test_normalize_rejects_bad_values():
    for bad in (float("nan"), float("inf"), "abc", None, True, [1]):
        with pytest.raises(ParameterError):
            normalize_value(bad, MAV_PARAM_TYPE_INT16)


def test_invalid_type_code_from_set():
    m = make_manager()
    make_vehicle(m)
    m.request_all_parameters()
    result = m.set_parameter("WP_RADIUS", "not-a-number")
    assert result["status"] == RESULT_INVALID_VALUE


def test_values_match_real32_tolerance():
    assert values_match(0.1, 0.1, MAV_PARAM_TYPE_REAL32, 1e-6, 1e-7)
    assert not values_match(1.0, 2.0, MAV_PARAM_TYPE_REAL32, 1e-6, 1e-7)


def test_values_match_integer_exact():
    assert values_match(10, 10.0, MAV_PARAM_TYPE_INT16, 1e-6, 1e-7)
    assert values_match(10.4, 10, MAV_PARAM_TYPE_INT16, 1e-6, 1e-7)
    assert not values_match(10, 11, MAV_PARAM_TYPE_INT16, 1e-6, 1e-7)


def test_unknown_type_fallback_exact():
    assert values_match(5, 5.0, 999, 1e-6, 1e-7)
    assert not values_match(5, 6.0, 999, 1e-6, 1e-7)


# ---------------------------------------------------------------------------
# Session lifecycle
# ---------------------------------------------------------------------------


def test_disconnect_resolves_pending_and_clears_cache():
    m = make_manager()
    v = make_vehicle(m)
    m.request_all_parameters()
    assert len(m._cache) == len(FAKE_VEHICLE_PARAMS)

    v.block_reads = True
    thread_result = {}

    def reader():
        thread_result["result"] = m.read_parameter("ATC_ACCEL_MAX")

    t = threading.Thread(target=reader)
    t.start()
    m.stop_session("test")
    t.join(timeout=2)
    assert thread_result["result"]["status"] == RESULT_DISCONNECTED
    assert m.get_all_parameters() == []


def test_start_session_clears_stale_state():
    m = make_manager()
    make_vehicle(m)
    m.request_all_parameters()
    assert len(m._cache) == len(FAKE_VEHICLE_PARAMS)
    m.stop_session("test")
    m.start_session()
    assert m.get_all_parameters() == []
    assert m.is_connected() is True


def test_handle_param_value_ignored_when_not_connected():
    m = ParameterManager()
    m.handle_param_value(FakeMsg("A", 1.0, MAV_PARAM_TYPE_INT16, 1, 0))
    assert m.get_parameter("A") is None


def test_connection_manager_binds_handler_without_side_effects(capsys):
    import mavlink.connection_manager as cm

    assert "PARAM_VALUE" in cm.HANDLERS
    captured = capsys.readouterr()
    assert "PARAM" not in captured.out