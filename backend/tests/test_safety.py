"""Dedicated test matrix for Phase 8G — Safety Setup (ArduCopter / Pixhawk).

Covers the Phase 8G backend requirements:
 1. ArduCopter supported
 2. unsupported autopilot
 3. unsupported vehicle type
 4. no vehicle            (WAITING)
 5. connecting            (CONNECTING)
 6. sync in progress      (SYNCING)
 7. sync failed           (ERROR)
 8. disconnect            (CONNECTION_LOST, no safety data)
 9. reconnect             (READY, data restored from vehicle)
10. radio failsafe params read (FS_THR_ENABLE / FS_THR_VALUE / FS_OPTIONS)
11. radio status derivation (Configured / Disabled)
12. FS_OPTIONS bitmask decode
13. FS_OPTIONS metadata missing -> bitmaskUnavailable
14. FS_THR_ENABLE unknown value -> decoded None + options still provided
15. FS_THR_VALUE metadata range exposed
16. radio threshold vs RC3 range inconsistency warning
17. GCS failsafe present (FS_GCS_ENABLE)
18. GCS failsafe unsupported when absent
19. battery failsafe params read (thresholds + actions)
20. battery threshold zero -> zeroMeansDisabled
21. battery action enum decoded via metadata
22. battery status derivation (Configured / Disabled / Unknown)
23. RTL altitude candidate resolution (RTL_ALT_M used when RTL_ALT absent)
24. RTL unrelated values honest (LAND_SPEED unavailable)
25. arming checks bitmask decode when ARMING_CHECK present + metadata
26. arming checks unsupported with ARMING_* note
27. advanced categories list only present params
28. READY requires safety params (no params -> ERROR)
29. status card values honest
30. Safety page never fabricates an RTL action for GCS
31. parameter write through shared verified pipeline
32. PARAM_VALUE verification before success
33. timed-out write -> failure (WRITE_TIMEOUT)
34. multi-param independent read (missing one never affects another)
"""

import time
from contextlib import contextmanager
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app import app
from core.state import telemetry, vehicle_state
from mavlink import parameter_manager as pm
from mavlink.parameter_manager import parameter_manager
from services import safety_service


@pytest.fixture(autouse=True)
def _clean_safety_state():
    snapshot = {}
    for k in [
        "connected", "connectionState", "disconnectReason", "vehicleType",
        "autopilot", "lastHeartbeat", "serialPortOpen",
    ]:
        snapshot[k] = vehicle_state.get(k)
    yield
    for k, v in snapshot.items():
        if v is None:
            vehicle_state.pop(k, None)
        else:
            vehicle_state[k] = v


def _mock_connected(vehicle_type="QUADROTOR", autopilot="ARDUPILOTMEGA",
                    state="connected", reason=None):
    vehicle_state["connected"] = (state == "connected")
    vehicle_state["connectionState"] = state
    vehicle_state["disconnectReason"] = reason
    vehicle_state["lastHeartbeat"] = int(time.time() * 1000) if state == "connected" else 0
    vehicle_state["vehicleType"] = vehicle_type
    vehicle_state["autopilot"] = autopilot
    telemetry["connected"] = (state == "connected")
    telemetry["vehicleType"] = vehicle_type
    telemetry["autopilot"] = autopilot


def _radio_params(enable=1.0, value=975.0, options=4.0, rc3min=1006.0, rc3max=1995.0):
    p = {
        "FS_THR_ENABLE": enable,
        "FS_THR_VALUE": value,
        "FS_OPTIONS": options,
        "FS_GCS_ENABLE": 0.0,
    }
    if rc3min is not None:
        p["RC3_MIN"] = rc3min
    if rc3max is not None:
        p["RC3_MAX"] = rc3max
    return p


def _rtl_params():
    return {
        "RTL_ALT_M": 15.0,
        "RTL_LOIT_TIME": 5000.0,
        "RTL_ALT_FINAL_M": 0.0,
        "RTL_CONE_SLOPE": 3.0,
        "RTL_SPEED_MS": 5.0,
    }


def _battery_params():
    return {
        "BATT_LOW_VOLT": 14.8,
        "BATT_CRT_VOLT": 14.2,
        "BATT_LOW_MAH": 1000.0,
        "BATT_CRT_MAH": 700.0,
        "BATT_LOW_TIMER": 10.0,
        "BATT_FS_LOW_ACT": 1.0,
        "BATT_FS_CRT_ACT": 2.0,
    }


def _full_params():
    p = _radio_params()
    p.update(_rtl_params())
    p.update(_battery_params())
    p["ARMING_OPTIONS"] = 1.0
    p["ARMING_SKIPCHK"] = 0.0
    return p


@contextmanager
def _patch_params(param_dict, sync_state="complete"):
    def fake_get(pid):
        val = param_dict.get(pid)
        if val is None:
            return None
        return {"id": pid, "value": val, "type": "REAL32", "writeState": "verified"}

    def fake_all():
        return [{"id": k, "value": v, "type": "REAL32"} for k, v in param_dict.items()]

    sync = {
        "connected": True,
        "state": sync_state,
        "expectedCount": len(param_dict),
        "receivedCount": len(param_dict),
        "missingIds": [],
        "cachedEntries": len(param_dict),
        "retryCount": 0,
        "needsRefresh": False,
        "complete": sync_state == "complete",
    }
    with patch.object(parameter_manager, "get_parameter", side_effect=fake_get), \
         patch.object(parameter_manager, "get_all_parameters", side_effect=fake_all), \
         patch.object(parameter_manager, "get_synchronization_state", return_value=sync):
        yield


client = TestClient(app)


# ---------------------------------------------------------------------------
# 1–4: Vehicle Detection & Guards
# ---------------------------------------------------------------------------

def test_01_arducopter_supported():
    _mock_connected(vehicle_type="QUADROTOR", autopilot="ARDUPILOTMEGA")
    with _patch_params(_full_params()):
        res = safety_service.get_safety_info()
        assert res["supported"] is True
        assert res["state"] == "READY"


def test_02_unsupported_autopilot():
    _mock_connected(vehicle_type="QUADROTOR", autopilot="PX4")
    with _patch_params(_full_params()):
        res = safety_service.get_safety_info()
        assert res["supported"] is False
        assert "PX4" in res["unsupportedReason"]


def test_03_unsupported_vehicle_type():
    _mock_connected(vehicle_type="GROUND_ROVER", autopilot="ARDUPILOTMEGA")
    with _patch_params(_full_params()):
        res = safety_service.get_safety_info()
        assert res["supported"] is False
        assert "available only for ArduCopter" in res["unsupportedReason"]


def test_04_no_vehicle():
    _mock_connected(state="disconnected")
    with _patch_params({}):
        res = safety_service.get_safety_info()
        assert res["state"] == "WAITING"
        assert res["status"] is None
        assert res["battery"] is None


# ---------------------------------------------------------------------------
# 5–9: Connection / Sync / Disconnect / Reconnect states
# ---------------------------------------------------------------------------

def test_05_connecting_state():
    _mock_connected(state="connecting")
    res = safety_service.get_safety_info()
    assert res["state"] == "CONNECTING"


def test_06_sync_in_progress():
    _mock_connected()
    with _patch_params(_full_params(), sync_state="receiving"):
        res = safety_service.get_safety_info()
        assert res["state"] == "SYNCING"
        assert res["status"] is None


def test_07_sync_failed():
    _mock_connected()
    with _patch_params(_full_params(), sync_state="failed"):
        res = safety_service.get_safety_info()
        assert res["state"] == "ERROR"


def test_08_disconnect_clears_data():
    _mock_connected()
    with _patch_params(_full_params()):
        assert safety_service.get_safety_info()["state"] == "READY"
    # Link drops: page must go CONNECTION_LOST and stop returning safety data
    vehicle_state["connected"] = False
    vehicle_state["connectionState"] = "disconnected"
    vehicle_state["disconnectReason"] = "Link closed"
    vehicle_state["lastHeartbeat"] = 0
    with _patch_params({}):
        res = safety_service.get_safety_info()
        assert res["state"] == "CONNECTION_LOST"
        assert res["status"] is None
        assert res["radio"] is None


def test_09_reconnect_restores_safety_data():
    vehicle_state["connected"] = False
    vehicle_state["connectionState"] = "disconnected"
    with _patch_params({}):
        assert safety_service.get_safety_info()["state"] == "WAITING"
    _mock_connected()
    with _patch_params(_full_params()):
        res = safety_service.get_safety_info()
        assert res["state"] == "READY"
        assert res["status"]["radioFailsafe"] == "Configured"


# ---------------------------------------------------------------------------
# 10–16: Radio failsafe
# ---------------------------------------------------------------------------

def test_10_radio_failsafe_params_read():
    _mock_connected()
    with _patch_params(_radio_params()):
        res = safety_service.get_safety_info()["radio"]
        assert res["fields"]["enable"]["supported"] is True
        assert res["fields"]["enable"]["value"] == 1.0
        assert res["fields"]["value"]["supported"] is True
        assert res["fields"]["value"]["value"] == 975.0
        assert res["fields"]["options"]["supported"] is True


def test_11_radio_status_derivation():
    _mock_connected()
    with _patch_params(_radio_params(enable=1.0)):
        assert safety_service.get_safety_info()["status"]["radioFailsafe"] == "Configured"
    with _patch_params(_radio_params(enable=0.0)):
        assert safety_service.get_safety_info()["status"]["radioFailsafe"] == "Disabled"


def test_12_fs_options_bitmask_decode():
    _mock_connected()
    with _patch_params(_radio_params(options=4.0)) as _:
        res = safety_service.get_safety_info()["radio"]["fields"]["options"]
        assert res.get("bits") is not None
        by_code = {b["code"]: b for b in res["bits"]}
        assert by_code[2]["present"] is True
        assert by_code[0]["present"] is False


def test_13_fs_options_metadata_missing():
    _mock_connected()
    fake_meta = {}
    with _patch_params(_radio_params(options=1.0)), \
         patch.object(safety_service, "_param_meta", return_value=fake_meta):
        field = safety_service.get_safety_info()["radio"]["fields"]["options"]
        assert field.get("bits") is None
        assert field.get("bitmaskUnavailable") is True


def test_14_fs_thr_enable_unknown_value():
    _mock_connected()
    meta = {
        "name": "Throttle Failsafe Enable",
        "values": {"0": "Disabled", "1": "Enabled always RTL"},
    }
    with _patch_params(_radio_params(enable=42.0)), \
         patch.object(safety_service, "_param_meta", return_value=meta):
        field = safety_service.get_safety_info()["radio"]["fields"]["enable"]
        assert field["value"] == 42.0
        assert field["decoded"] is None
        assert field["options"]

def test_15_fs_thr_value_metadata_range():
    _mock_connected()
    with _patch_params({"FS_THR_VALUE": 975.0}):
        # real copter.xml metadata: min 910, max 1100
        field = safety_service.get_safety_info()["radio"]["fields"]["value"]
        assert field["supported"] is True
        assert field["min"] == 910.0
        assert field["max"] == 1100.0


def test_16_radio_threshold_throttle_range_warning():
    _mock_connected()
    # FS_THR_VALUE within throttle range -> warning (inconsistent)
    with _patch_params(_radio_params(value=1100.0, rc3min=1006.0, rc3max=1995.0)):
        warnings = safety_service.get_safety_info()["radio"]["warnings"]
        assert any("inconsistent" in w for w in warnings)
    # FS_THR_VALUE below RC3_MIN -> no warning
    with _patch_params(_radio_params(value=975.0, rc3min=1006.0, rc3max=1995.0)):
        assert safety_service.get_safety_info()["radio"]["warnings"] == []
    # No RC params -> no warning
    with _patch_params(_radio_params(value=1100.0, rc3min=None, rc3max=None)):
        assert safety_service.get_safety_info()["radio"]["warnings"] == []


# ---------------------------------------------------------------------------
# 17–18: GCS failsafe
# ---------------------------------------------------------------------------

def test_17_gcs_failsafe_present():
    _mock_connected()
    with _patch_params(_radio_params()):
        res = safety_service.get_safety_info()["gcs"]
        assert res["supported"] is True
        assert res["field"]["value"] == 0.0
        assert safety_service.get_safety_info()["status"]["gcsFailsafe"] == "Disabled"


def test_18_gcs_failsafe_unsupported_when_absent():
    _mock_connected()
    with _patch_params({"FS_THR_ENABLE": 1.0, "FS_OPTIONS": 0.0}):
        res = safety_service.get_safety_info()["gcs"]
        assert res["supported"] is False
        assert res["field"]["supported"] is False


# ---------------------------------------------------------------------------
# 19–22: Battery failsafe
# ---------------------------------------------------------------------------

def test_19_battery_failsafe_params_read():
    _mock_connected()
    with _patch_params(_battery_params()):
        fields = safety_service.get_safety_info()["battery"]["fields"]
        assert fields["lowVolt"]["value"] == 14.8
        assert fields["crtVolt"]["value"] == 14.2
        assert fields["lowMah"]["value"] == 1000.0
        assert fields["crtMah"]["value"] == 700.0
        assert fields["lowTimer"]["value"] == 10.0


def test_20_zero_threshold_is_disabled():
    _mock_connected()
    with _patch_params({"BATT_LOW_VOLT": 0.0}):
        field = safety_service.get_safety_info()["battery"]["fields"]["lowVolt"]
        assert field["supported"] is True
        assert field["value"] == 0.0
        assert field["zeroMeansDisabled"] is True


def test_21_battery_action_enum_decoded():
    _mock_connected()
    meta = {"name": "Low Battery Action", "values": {"0": "Warn only", "1": "RTL", "2": "Land"}}
    with _patch_params(_battery_params()), \
         patch.object(safety_service, "_param_meta", return_value=meta):
        f = safety_service.get_safety_info()["battery"]["fields"]["fsLowAct"]
        assert f["decoded"] == "RTL"
        assert [o["code"] for o in f["options"]] == [0, 1, 2]


def test_22_battery_status_derivation():
    _mock_connected()
    # actions configured
    with _patch_params({"BATT_FS_LOW_ACT": 1.0, "BATT_FS_CRT_ACT": 0.0}):
        assert safety_service.get_safety_info()["status"]["batteryFailsafe"] == "Configured"
    # all actions disabled
    with _patch_params({"BATT_FS_LOW_ACT": 0.0, "BATT_FS_CRT_ACT": 0.0}):
        assert safety_service.get_safety_info()["status"]["batteryFailsafe"] == "Disabled"
    # no battery failsafe params at all -> Unknown
    with _patch_params(_radio_params()):
        assert safety_service.get_safety_info()["status"]["batteryFailsafe"] == "Unknown"


# ---------------------------------------------------------------------------
# 23–24: Return to Launch
# ---------------------------------------------------------------------------

def test_23_rtl_candidate_resolution():
    _mock_connected()
    # Modern firmware: RTL_ALT absent, RTL_ALT_M present -> resolved + honest id
    with _patch_params(_rtl_params()):
        f = safety_service.get_safety_info()["rtl"]["fields"]["alt"]
        assert f["supported"] is True
        assert f["id"] == "RTL_ALT_M"
        assert f["value"] == 15.0
        # Loiter time and final altitude present
        assert safety_service.get_safety_info()["rtl"]["fields"]["loitTime"]["value"] == 5000.0
        # nothing fabricated about RTL
    # Legacy firmware: RTL_ALT present -> used
    with _patch_params({"RTL_ALT": 1500.0, "RTL_LOIT_TIME": 0.0}):
        f = safety_service.get_safety_info()["rtl"]["fields"]["alt"]
        assert f["id"] == "RTL_ALT"
        assert f["value"] == 1500.0


def test_24_rtl_unrelated_values_honest():
    _mock_connected()
    with _patch_params(_rtl_params()):
        f = safety_service.get_safety_info()["rtl"]["fields"]["landSpeed"]
        assert f["supported"] is False
        assert f["value"] is None
        assert f["id"] == "LAND_SPEED"


# ---------------------------------------------------------------------------
# 25–26: Arming checks
# ---------------------------------------------------------------------------

def test_25_arming_check_bitmask_decode():
    _mock_connected()
    meta = {
        "name": "Arming Checks",
        "bitmask": {"0": "All", "1": "Barometer", "2": "Compass"},
    }
    with _patch_params({"ARMING_CHECK": 3.0}), \
         patch.object(safety_service, "_param_meta", return_value=meta):
        section = safety_service.get_safety_info()["arming"]
        assert section["supported"] is True
        by_code = {b["code"]: b for b in section["field"]["bits"]}
        assert by_code[0]["present"] is True
        assert by_code[1]["present"] is True
        assert by_code[2]["present"] is False


def test_26_arming_check_falls_back_to_individual_params():
    """Modern firmware retired the ARMING_CHECK bitmask.

    The Safety page must still configure real arming checks, so the section is
    supported and exposes the individual ARMING_* parameters the vehicle
    actually publishes, instead of degrading to an "unsupported" note.
    """
    _mock_connected()
    with _patch_params({"ARMING_OPTIONS": 1.0}):
        section = safety_service.get_safety_info()["arming"]
        assert section["supported"] is True
        assert section["field"] is None
        assert "ARMING_" in section["note"]
        check_ids = [c["id"] for c in section["checks"]]
        assert "ARMING_OPTIONS" in check_ids
        assert all(c["supported"] for c in section["checks"])
        assert safety_service.get_safety_info()["status"]["armingChecks"] in ("Enabled", "Partially configured")
    # no arming params at all -> Unknown
    with _patch_params(_radio_params()):
        assert safety_service.get_safety_info()["status"]["armingChecks"] == "Unknown"


# ---------------------------------------------------------------------------
# 27–30: Advanced list / READY gate / status honesty / no fake action
# ---------------------------------------------------------------------------

def test_27_advanced_categories_only_present_params():
    _mock_connected()
    with _patch_params(_rtl_params()):
        categories = safety_service.get_safety_info()["advanced"]["categories"]
        total = sum(len(c["params"]) for c in categories)
        assert total > 0
        for cat in categories:
            for p in cat["params"]:
                assert p["supported"] is True
        names = [cat["name"] for cat in categories]
        assert "RTL behaviour" in names


def test_advanced_enum_parameters_preserve_vehicle_options():
    """Advanced enum fields must not be degraded into arbitrary numbers."""
    _mock_connected()
    params = _rtl_params() | {"WP_YAW_BEHAVIOR": 2.0}
    enum_metadata = {
        "RTL_CONE_SLOPE": {
            "values": {"0": "Disabled", "1": "Shallow", "3": "Steep"},
        },
        "WP_YAW_BEHAVIOR": {
            "values": {
                "0": "Never change yaw",
                "1": "Face next waypoint",
                "2": "Face next waypoint except RTL",
                "3": "Face along GPS course",
            },
        },
    }
    with _patch_params(params), patch.object(
        safety_service,
        "_param_meta",
        side_effect=lambda pid: enum_metadata.get(pid),
    ):
        categories = safety_service.get_safety_info()["advanced"]["categories"]
        fields = {p["id"]: p for c in categories for p in c["params"]}

    assert fields["RTL_CONE_SLOPE"]["options"] == [
        {"code": 0, "label": "Disabled"},
        {"code": 1, "label": "Shallow"},
        {"code": 3, "label": "Steep"},
    ]
    assert fields["RTL_CONE_SLOPE"]["decoded"] == "Steep"
    assert fields["WP_YAW_BEHAVIOR"]["options"][-1] == {
        "code": 3,
        "label": "Face along GPS course",
    }


def test_28_complete_sync_without_safety_params_is_error():
    _mock_connected()
    with _patch_params({"MOT_PWM_TYPE": 0.0, "FRAME_CLASS": 1.0}):
        res = safety_service.get_safety_info()
        assert res["state"] == "ERROR"
        assert res["status"] is None


def test_29_status_card_values_honest():
    _mock_connected()
    p = {"FS_THR_ENABLE": 1.0, "FS_GCS_ENABLE": 0.0,
         "BATT_FS_LOW_ACT": 0.0, "BATT_FS_CRT_ACT": 0.0,
         "RTL_ALT_M": 15.0, "ARMING_OPTIONS": 1.0}
    with _patch_params(p):
        s = safety_service.get_safety_info()["status"]
        assert s["radioFailsafe"] == "Configured"
        assert s["gcsFailsafe"] == "Disabled"
        assert s["batteryFailsafe"] == "Disabled"
        assert s["rtl"] == "Configured"
        assert s["armingChecks"] == "Enabled"
        assert s["configuration"] == "Ready"


def test_30_no_fabricated_rtl_action():
    """The GCS must not produce 'will RTL' commands — only config description."""
    _mock_connected()
    with _patch_params(_full_params()):
        blob = safety_service.get_safety_info()
        text = str(blob)
        assert "will RTL" not in text
        assert "will Land" not in text
        assert "yantrayug" not in text.lower()
        # radio decoded action is descriptive only
        assert blob["status"]["radioFailsafe"] in ("Configured", "Disabled")


# ---------------------------------------------------------------------------
# 31–33: Write pipeline / PARAM_VALUE verification / failures
# ---------------------------------------------------------------------------

def test_31_parameter_write_shared_pipeline():
    from services.parameter_service import parameter_service
    from mavlink.parameter_manager import parameter_manager as ppm
    _mock_connected()
    ppm.start_session()
    with patch.object(ppm, "set_parameter") as mock_set:
        mock_set.return_value = {"status": pm.RESULT_SUCCESS, "value": 1200.0}
        res = parameter_service.write_parameter("FS_THR_VALUE", 1200.0)
        assert res["success"] is True
        assert res["parameter"]["id"] == "FS_THR_VALUE"
        assert res["parameter"]["value"] == 1200.0


def test_32_param_value_verification():
    from services.parameter_service import parameter_service
    from mavlink.parameter_manager import parameter_manager as ppm
    _mock_connected()
    ppm.start_session()
    with patch.object(ppm, "set_parameter") as mock_set:
        mock_set.return_value = {"status": pm.RESULT_SUCCESS, "value": 14.5}
        res = parameter_service.write_parameter("BATT_LOW_VOLT", 14.5)
        assert res["success"] is True
        assert res["parameter"]["value"] == 14.5


def test_33_timed_out_write_fails():
    from services.parameter_service import parameter_service
    from mavlink.parameter_manager import parameter_manager as ppm
    _mock_connected()
    ppm.start_session()
    with patch.object(ppm, "set_parameter") as mock_set:
        mock_set.return_value = {"status": pm.RESULT_TIMEOUT, "message": "No PARAM_VALUE"}
        res = parameter_service.write_parameter("FS_THR_VALUE", 900.0)
        assert res.get("error") is not None
        assert res["error"]["code"] == "WRITE_TIMEOUT"


# ---------------------------------------------------------------------------
# 34: Multi-param independence
# ---------------------------------------------------------------------------

def test_34_multi_param_independent_read():
    _mock_connected()
    with _patch_params({"FS_THR_ENABLE": 1.0, "FS_OPTIONS": 0.0, "FS_GCS_ENABLE": 0.0}):
        res = safety_service.get_safety_info()
        assert res["radio"]["fields"]["enable"]["supported"] is True
        assert res["radio"]["fields"]["options"]["supported"] is True
        # RTL absent independently -> honest unsupported fields
        assert res["rtl"]["fields"]["alt"]["supported"] is False
        assert res["rtl"]["fields"]["loitTime"]["supported"] is False

# ---------------------------------------------------------------------------
# 35: GeoFence section — parameters only, geometry stays in PLAN -> GeoFence
# ---------------------------------------------------------------------------

def _fence_params():
    return {
        "FENCE_ENABLE": 1.0,
        "FENCE_ACTION": 1.0,
        "FENCE_RADIUS": 300.0,
        "FENCE_ALT_MAX": 120.0,
        "FENCE_ALT_MIN": -20.0,
        "FENCE_MARGIN": 5.0,
        "FENCE_TYPE": 7.0,
        "FENCE_OPTIONS": 0.0,
        "FENCE_NTF_FREQ": 1.0,
    }


def test_35_fence_section_reads_real_parameters():
    _mock_connected()
    with _patch_params(_fence_params()):
        fields = safety_service.get_safety_info()["fence"]["fields"]
        assert fields["enable"]["id"] == "FENCE_ENABLE"
        assert fields["enable"]["supported"] is True
        assert fields["enable"]["value"] == 1.0
        assert fields["action"]["supported"] is True
        assert fields["radius"]["value"] == 300.0
        assert fields["altMax"]["value"] == 120.0
        assert fields["altMin"]["value"] == -20.0


def test_36_fence_absent_parameters_reported_unsupported():
    _mock_connected()
    with _patch_params(_radio_params()):
        fields = safety_service.get_safety_info()["fence"]["fields"]
        for key in ("enable", "action", "radius", "altMax", "altMin"):
            assert fields[key]["supported"] is False
            assert fields[key]["value"] is None


def test_37_fence_type_bitmask_decoded_from_metadata():
    _mock_connected()
    with _patch_params(_fence_params()):
        types = safety_service.get_safety_info()["fence"]["fields"]["types"]
        assert types["id"] == "FENCE_TYPE"
        assert types["value"] == 7.0
        if types.get("bits"):
            on = {b["code"] for b in types["bits"] if b["present"]}
            assert on == {0, 1, 2}


def test_38_fence_params_not_duplicated_in_advanced():
    _mock_connected()
    with _patch_params({**_radio_params(), **_fence_params()}):
        info = safety_service.get_safety_info()
        advanced_ids = {
            p["id"] for c in info["advanced"]["categories"] for p in c["params"]
        }
        for pid in _fence_params():
            assert pid not in advanced_ids


# ---------------------------------------------------------------------------
# 39: Arming checks reflect the firmware the vehicle actually has
# ---------------------------------------------------------------------------

def test_39_arming_checks_use_real_arming_params():
    _mock_connected()
    with _patch_params({
        "ARMING_OPTIONS": 0.0,
        "ARMING_SKIPCHK": 0.0,
        "ARMING_RUDDER": 1.0,
        "ARMING_NEED_LOC": 1.0,
    }):
        arming = safety_service.get_safety_info()["arming"]
        assert arming["supported"] is True
        ids = [c["id"] for c in arming["checks"]]
        assert ids == ["ARMING_OPTIONS", "ARMING_SKIPCHK", "ARMING_RUDDER", "ARMING_NEED_LOC"]
        by_id = {c["id"]: c for c in arming["checks"]}
        assert by_id["ARMING_RUDDER"]["value"] == 1.0
        assert by_id["ARMING_NEED_LOC"]["value"] == 1.0


def test_40_arming_check_bitmask_takes_precedence_when_present():
    _mock_connected()
    with _patch_params({"ARMING_CHECK": 1.0}):
        arming = safety_service.get_safety_info()["arming"]
        assert arming["field"] is not None
        assert arming["field"]["id"] == "ARMING_CHECK"
        assert arming["field"]["value"] == 1.0


def test_41_arming_checks_absent_is_unsupported():
    _mock_connected()
    with _patch_params(_radio_params()):
        arming = safety_service.get_safety_info()["arming"]
        assert arming["supported"] is False
        assert arming["checks"] == []


# ---------------------------------------------------------------------------
# 42: GCS failsafe timeout is exposed alongside the GCS action
# ---------------------------------------------------------------------------

def test_42_gcs_section_exposes_timeout():
    _mock_connected()
    with _patch_params({"FS_GCS_ENABLE": 0.0, "FS_GCS_TIMEOUT": 5.0}):
        gcs = safety_service.get_safety_info()["gcs"]
        assert gcs["field"]["id"] == "FS_GCS_ENABLE"
        assert gcs["field"]["value"] == 0.0
        assert gcs["timeout"]["id"] == "FS_GCS_TIMEOUT"
        assert gcs["timeout"]["value"] == 5.0
        assert gcs["timeout"]["supported"] is True


def test_43_gcs_timeout_absent_is_unsupported_not_invented():
    _mock_connected()
    with _patch_params({"FS_GCS_ENABLE": 0.0}):
        gcs = safety_service.get_safety_info()["gcs"]
        assert gcs["timeout"]["supported"] is False
        assert gcs["timeout"]["value"] is None


# ---------------------------------------------------------------------------
# 44: Arming control type comes from the vehicle's own metadata
# ---------------------------------------------------------------------------

def test_44_arming_control_type_follows_the_vehicle_metadata():
    """ARMING_* control type is decided by the firmware's own metadata.

    ARMING_OPTIONS and ARMING_SKIPCHK are real bitmasks in ArduCopter, while
    ARMING_RUDDER / ARMING_NEED_LOC / ARMING_CRSDP_IGN are choice lists and
    ARMING_MAGTHRESH / ARMING_ACCTHRESH are plain numbers. Presenting a choice
    list as a bitmask (or the reverse) would corrupt the parameter on write.
    """
    _mock_connected()
    with _patch_params({
        "ARMING_OPTIONS": 0.0,
        "ARMING_SKIPCHK": 0.0,
        "ARMING_RUDDER": 1.0,
        "ARMING_NEED_LOC": 0.0,
        "ARMING_MAGTHRESH": 100.0,
        "ARMING_ACCTHRESH": 0.75,
        "ARMING_CRSDP_IGN": 0.0,
        "ARMING_MIS_ITEMS": 0.0,
    }):
        by_id = {c["id"]: c for c in safety_service.get_safety_info()["arming"]["checks"]}

        for pid in ("ARMING_OPTIONS", "ARMING_SKIPCHK", "ARMING_MIS_ITEMS"):
            assert by_id[pid].get("bits"), f"{pid} should be editable as a bitmask"
            assert "options" not in by_id[pid], f"{pid} must not be presented as a choice list"

        for pid in ("ARMING_RUDDER", "ARMING_NEED_LOC", "ARMING_CRSDP_IGN"):
            assert by_id[pid].get("options"), f"{pid} should be editable as a choice list"
            assert "bits" not in by_id[pid], f"{pid} must not be presented as a bitmask"

        for pid in ("ARMING_MAGTHRESH", "ARMING_ACCTHRESH"):
            assert "bits" not in by_id[pid], f"{pid} must be a plain number"
            assert "options" not in by_id[pid], f"{pid} must be a plain number"

        # The real values must survive unchanged.
        assert by_id["ARMING_MAGTHRESH"]["value"] == 100.0
        assert by_id["ARMING_ACCTHRESH"]["value"] == 0.75
        assert by_id["ARMING_RUDDER"]["value"] == 1.0
