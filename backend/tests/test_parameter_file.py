"""Phase 6 tests: parameter file parse / analyze / export + presets.

Everything runs against the real ParameterFileService / ParameterPresetService
with the fake vehicle wired in, so parse, compare, read-only enforcement and
export are exercised end-to-end without sockets or threads.
"""

import pytest

from mavlink import parameter_manager as pm
from services.parameter_file import (
    CAT_CHANGED,
    CAT_INVALID,
    CAT_READ_ONLY,
    CAT_SAME,
    CAT_UNKNOWN,
    ParameterFileService,
    ParameterFileError,
)
from services.parameter_presets import ParameterPresetService

from tests.test_parameter_manager import (
    FAKE_VEHICLE_PARAMS,
    FAST_CONFIG,
    FakeMsg,
    make_vehicle,
)

FIVE = FAKE_VEHICLE_PARAMS


@pytest.fixture()
def manager():
    mgr = pm.ParameterManager(config=dict(FAST_CONFIG))
    mgr.start_session()
    make_vehicle(mgr)
    mgr.request_all_parameters()
    yield mgr
    mgr.stop_session("test teardown")


@pytest.fixture()
def service(manager):
    return ParameterFileService(manager)


# ---------------------------------------------------------------------------
# Parse
# ---------------------------------------------------------------------------

def test_parse_csv_entries(service):
    result = service.parse("WP_RADIUS,2\nWPNAV_SPEED,500\nSYSID_THISMAV,1\n")
    assert result["success"] is True
    assert result["parse"]["valid"] == 3
    assert result["parse"]["malformed"] == 0
    ids = [(e["paramId"], e["value"]) for e in result["parse"]["entries"]]
    assert ids == [("SYSID_THISMAV", 1.0), ("WPNAV_SPEED", 500.0), ("WP_RADIUS", 2.0)]


def test_parse_tab_and_space_separated(service):
    result = service.parse("WP_RADIUS\t2\nWPNAV_SPEED 500\n")
    assert result["parse"]["valid"] == 2
    assert result["parse"]["malformed"] == 0


def test_parse_comments_blank_and_header_skipped(service):
    content = (
        "# ArduPilot param file\n"
        "// MAVProxy export\n"
        "; extra comment\n"
        "\n"
        "WP_RADIUS,2\n"
        "\n"
        "NOT_A_PARAM,oops\n"
    )
    result = service.parse(content)
    assert result["parse"]["valid"] == 1
    assert result["parse"]["commentLines"] == 3
    assert result["parse"]["malformed"] == 1
    assert result["parse"]["malformedLines"] == ["NOT_A_PARAM,oops"]
    assert result["parse"]["entries"] == [{"paramId": "WP_RADIUS", "value": 2.0}]


def test_parse_reports_duplicates_keeping_last(service):
    result = service.parse("WP_RADIUS,1\nWP_RADIUS,2\n")
    assert result["parse"]["duplicate"] == 1
    assert result["parse"]["duplicateParams"] == ["WP_RADIUS"]
    assert result["parse"]["entries"] == [{"paramId": "WP_RADIUS", "value": 2.0}]


def test_parse_allows_negative_and_sci_notation(service):
    result = service.parse("ATC_ACCEL_MAX,-110000\nWP_RADIUS,1e1\n")
    assert result["parse"]["valid"] == 2
    assert dict((e["paramId"], e["value"]) for e in result["parse"]["entries"]) == {
        "ATC_ACCEL_MAX": -110000.0, "WP_RADIUS": 10.0}


def test_parse_empty_content_ok(service):
    result = service.parse("")
    assert result["success"] is True
    assert result["parse"]["valid"] == 0


def test_parse_rejects_non_text_content(service):
    with pytest.raises(ParameterFileError) as exc:
        service.parse(None)
    assert exc.value.code == "BAD_REQUEST"
    with pytest.raises(ParameterFileError) as exc:
        service.parse(1234)
    assert exc.value.code == "BAD_REQUEST"


def test_parse_rejects_oversized_files(service):
    with pytest.raises(ParameterFileError) as exc:
        service.parse("A,B\n" * 300_000)  # 300k lines > 200k limit
    assert exc.value.code == "FILE_TOO_LARGE"
    with pytest.raises(ParameterFileError) as exc:
        service.parse("W" * 2_500_000 + ",1\n")
    assert exc.value.code == "FILE_TOO_LARGE"


# ---------------------------------------------------------------------------
# Analyze / compare against live vehicle
# ---------------------------------------------------------------------------

def test_analyze_categories_changed_same_unknown(service):
    content = (
        "WP_RADIUS,2\n"        # 10 -> file 2 : changed
        "WPNAV_SPEED,500\n"    # same as live
        "ALT_HOLD,1\n"         # unknown (not live)
    )
    result = service.analyze(content, "t.param")
    assert result["success"] is True
    counts = result["compare"]["counts"]
    assert counts[CAT_CHANGED] == 1
    assert counts[CAT_SAME] == 1
    assert counts[CAT_UNKNOWN] == 1
    by_id = {r["paramId"]: r for r in result["compare"]["rows"]}
    assert by_id["WP_RADIUS"]["stageable"] is True
    assert by_id["WPNAV_SPEED"]["stageable"] is False
    assert by_id["ALT_HOLD"]["stageable"] is False
    assert by_id["WP_RADIUS"]["vehicleValue"] == 10.0
    assert by_id["WP_RADIUS"]["fileValue"] == 2.0
    assert result["compare"]["diffCount"] == 1


def test_analyze_float32_tolerance_is_type_aware(service):
    # Live WP_RADIUS is REAL32 (10.0). A file value that differs by a hair
    # below tolerance still counts as "same".
    result = service.analyze("WP_RADIUS,10.0000006\n")
    assert result["compare"]["counts"][CAT_SAME] == 1


def test_analyze_read_only_param_never_stageable(service, manager):
    from core.state import vehicle_state
    from services.parameter_metadata import metadata_provider

    vehicle_state["vehicleType"] = "QUADROTOR"
    metadata_provider.status("QUADROTOR")  # ensure the catalog is loaded
    manager.handle_param_value(
        FakeMsg("ARSPD2_DEVID", 0.0, pm.MAV_PARAM_TYPE_INT32, 6, 5))
    result = service.analyze("ARSPD2_DEVID,99\n")
    row = result["compare"]["rows"][0]
    assert row["category"] == CAT_READ_ONLY
    assert row["stageable"] is False
    assert row["readOnly"] is True
    vehicle_state["vehicleType"] = "QUADROTOR"


def test_analyze_invalid_value_for_type(service):
    # SYSID_THISMAV is UINT8; 99999 exceeds integer width.
    result = service.analyze("SYSID_THISMAV,99999\n")
    row = result["compare"]["rows"][0]
    assert row["category"] == CAT_INVALID
    assert row["stageable"] is False


def test_analyze_not_connected(service):
    service._manager.stop_session("disconnect")
    result = service.analyze("WP_RADIUS,2\n")
    assert result["success"] is False
    assert result["error"]["code"] == "NOT_CONNECTED"


def test_analyze_staged_conflicts(service, manager):
    service._manager.handle_param_value(FakeMsg("WPNAV_SPEED", 500.0,
                                                pm.MAV_PARAM_TYPE_INT16, 5, 1))
    result = service.analyze("WPNAV_SPEED,800\n", staged={"WPNAV_SPEED": 700.0})
    row = result["compare"]["rows"][0]
    assert row["category"] == CAT_CHANGED
    assert row["stagedValue"] == 700.0
    assert row["stagedConflict"] is True

    # Same staged value as the file -> no conflict.
    result = service.analyze("WPNAV_SPEED,800\n", staged={"WPNAV_SPEED": 800.0})
    assert result["compare"]["rows"][0]["stagedConflict"] is False


def test_analyze_rows_sorted_by_param_id(service):
    result = service.analyze("WP_RADIUS,2\nATC_ACCEL_MAX,99000\n"
                             "FS_GCS_ENABLE,1\n")
    ids = [r["paramId"] for r in result["compare"]["rows"]]
    assert ids == sorted(ids)


# ---------------------------------------------------------------------------
# Export (Save)
# ---------------------------------------------------------------------------

def test_export_serializes_authoritative_live_set(service):
    result = service.export_params("vehicle")
    assert result["success"] is True
    assert result["count"] == len(FIVE)
    assert result["content"].startswith("# YantraYug parameter export")
    lines = [ln for ln in result["content"].splitlines() if not ln.startswith("#")]
    by_id = dict(ln.split(",", 1) for ln in lines)
    assert by_id["WP_RADIUS"] == "10"
    assert by_id["WPNAV_SPEED"] == "500"
    assert by_id["SYSID_THISMAV"] == "1"


def test_export_is_round_trippable(service):
    exported = service.export_params("vehicle")
    reparsed = service.parse(exported["content"], exported["filename"])
    assert reparsed["parse"]["valid"] == len(FIVE)
    assert reparsed["parse"]["malformed"] == 0


def test_export_rejects_unknown_source(service):
    with pytest.raises(ParameterFileError) as exc:
        service.export_params("staged")
    assert exc.value.code == "BAD_REQUEST"


def test_export_not_connected(service):
    service._manager.stop_session("disconnect")
    result = service.export_params("vehicle")
    assert result["success"] is False
    assert result["error"]["code"] == "NOT_CONNECTED"


# ---------------------------------------------------------------------------
# Presets
# ---------------------------------------------------------------------------

@pytest.fixture()
def presets(service):
    return ParameterPresetService(service)


def test_presets_list_allowed_for_rover(presets):
    result = presets.list_presets("GROUND")
    assert result["allowed"] is True
    ids = [p["id"] for p in result["presets"]]
    assert "rover_baseline" in ids


def test_presets_list_blocked_for_copter(presets):
    result = presets.list_presets("QUADROTOR")
    assert result["allowed"] is False
    assert result["presets"]


def test_preset_analyze_on_rover_produces_rows(presets, manager):
    # vehicle type must resolve to rover for the guard to pass.
    from core.state import vehicle_state

    vehicle_state["vehicleType"] = "GROUND"
    result = presets.analyze("rover_baseline")
    assert result["success"] is True
    assert result["filename"].startswith("preset:")
    by_id = {r["paramId"]: r for r in result["compare"]["rows"]}
    assert by_id["WP_RADIUS"]["category"] == CAT_CHANGED
    assert by_id["WP_RADIUS"]["fileValue"] == 2.0
    vehicle_state["vehicleType"] = "QUADROTOR"


def test_preset_analyze_vehicle_type_mismatch(presets):
    from core.state import vehicle_state

    vehicle_state["vehicleType"] = "QUADROTOR"
    result = presets.analyze("rover_baseline")
    assert result["success"] is False
    assert result["error"]["code"] == "VEHICLE_TYPE_MISMATCH"


def test_preset_analyze_unknown_preset(presets):
    from core.state import vehicle_state

    vehicle_state["vehicleType"] = "GROUND"
    result = presets.analyze("no_such_preset")
    assert result["success"] is False
    assert result["error"]["code"] == "PRESET_NOT_FOUND"
    vehicle_state["vehicleType"] = "QUADROTOR"


def test_preset_analyze_honors_staged_conflicts(presets):
    from core.state import vehicle_state

    vehicle_state["vehicleType"] = "GROUND"
    result = presets.analyze("rover_baseline",
                             staged={"WP_RADIUS": 5.0})
    row = [r for r in result["compare"]["rows"]
           if r["paramId"] == "WP_RADIUS"][0]
    assert row["stagedConflict"] is True
    vehicle_state["vehicleType"] = "QUADROTOR"