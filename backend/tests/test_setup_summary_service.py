"""Tests for the Setup Summary capability matrix and the auto parameter
download.

Covers the four-tone matrix (good / warn / unsupported / unknown), the
regression guarantee that a synced ArduCopter 4.x parameter set is NEVER
reported unsupported, the wait-until-synced behaviour, and the
connection_manager auto-download guards. All transport/parameter access is
mocked; real values mirror the live Pixhawk1 (ArduCopter 4.7.0, 991 params).
"""

import time

import pytest
from unittest.mock import patch


@pytest.fixture(autouse=True)
def _clean_state():
    from core.state import vehicle_state

    snapshot = dict(vehicle_state)
    yield
    vehicle_state.clear()
    vehicle_state.update(snapshot)


def _mock_connected_state(satellites=10):
    from core.state import vehicle_state

    vehicle_state["serialPortOpen"] = True
    vehicle_state["udpConnected"] = False
    vehicle_state["connected"] = True
    vehicle_state["lastHeartbeat"] = int(time.time() * 1000)
    vehicle_state["armed"] = False
    vehicle_state["systemId"] = 1
    vehicle_state["componentId"] = 1
    vehicle_state["vehicleType"] = "QUADROTOR"
    vehicle_state["autopilot"] = "ARDUPILOTMEGA"
    vehicle_state["mode"] = "STABILIZE"
    vehicle_state["satellites"] = satellites


def _sync(**kw):
    state = {
        "connected": True,
        "state": "complete",
        "expectedCount": 991,
        "receivedCount": 991,
        "missingIds": [],
        "cachedEntries": 991,
        "startedAt": time.time(),
        "lastReceivedAt": time.time(),
        "retryCount": 0,
        "needsRefresh": False,
    }
    state.update(kw)
    return state


def _healthy_params():
    """Real ArduCopter live set (insight from the connected Pixhawk)."""
    return {
        "FRAME_CLASS": 4.0,
        "FRAME_TYPE": 0.0,
        "INS_ACC_ID": 1246218.0,
        "INS_GYR_ID": 2163722.0,
        "COMPASS_USE": 1.0,
        "COMPASS_OFS_X": -18.0,
        "COMPASS_OFS_Y": -5.0,
        "COMPASS_OFS_Z": 30.0,
        "BARO1_GND_PRESS": 101325.0,
        "BARO_PRIMARY": 0.0,
        "AHRS_TRIM_X": 0.0,
        "AHRS_TRIM_Y": 0.0,
        "RC1_MIN": 1000.0,
        "RC1_MAX": 2000.0,
        "FLTMODE_CH": 5.0,
        "FLTMODE1": 0.0,
        "FLTMODE2": 1.0,
        "FLTMODE3": 2.0,
        "FLTMODE4": 3.0,
        "FLTMODE5": 4.0,
        "FLTMODE6": 5.0,
        "BATT_MONITOR": 4.0,
        "FS_THR_ENABLE": 1.0,
        "FS_GCS_ENABLE": 0.0,
        "FENCE_ENABLE": 1.0,
        "MOT_PWM_TYPE": 0.0,
        "SERVO1_FUNCTION": 0.0,
        "MNT_TYPE": 1.0,
        "LOG_BITMASK": 180222.0,
        "GPS1_TYPE": 1.0,
    }


class _ParamSet:
    def __init__(self, values):
        self.values = values

    def get_parameter(self, param_id):
        value = self.values.get(param_id)
        if value is None:
            return None
        return {"id": param_id, "value": value, "type": "REAL32",
                "index": 0, "count": 1, "receivedAt": time.time(), "received": True}


def _patch_params(values):
    ps = _ParamSet(values)
    from services import setup_summary_service as sss

    return patch.object(sss.parameter_manager, "get_parameter", side_effect=ps.get_parameter)


def _patch_sync(state):
    from services import setup_summary_service as sss

    return patch.object(sss.parameter_manager, "get_synchronization_state", return_value=state)


def _make_sensor_status(params):
    """Recreate calibration_service.get_sensor_status() shape locally, including
    the per-group `status` derivation (calibrated / not-calibrated / unsupported)."""
    def read(ids):
        out = {}
        for pid in ids:
            value = params.get(pid)
            out[pid] = {"supported": value is not None, "value": value}
        return out

    def group_status(value, supported):
        if not supported:
            return "unsupported"
        return "calibrated" if value not in (None, 0) else "not-calibrated"

    accel_ids = read(["INS_ACC_ID"])
    gyro_ids = read(["INS_GYR_ID"])
    baro_ids = read(["BARO1_DEVID", "BARO2_DEVID", "BARO3_DEVID"])
    compass_ids = read(["COMPASS_DEV_ID", "COMPASS_USE", "COMPASS_ORIENT", "COMPASS_ID"])
    compass_offsets = read(["COMPASS_OFS_X", "COMPASS_OFS_Y", "COMPASS_OFS_Z"])
    trim = read(["AHRS_TRIM_X", "AHRS_TRIM_Y"])

    comp_fit = params.get("COMPASS_CAL_FIT")
    offsets_nonzero = any(params.get(p) not in (None, 0.0) for p in ("COMPASS_OFS_X", "COMPASS_OFS_Y", "COMPASS_OFS_Z"))
    compass_supported = params.get("COMPASS_USE") is not None
    compass_status = (
        "unsupported"
        if not compass_supported
        else "calibrated"
        if (comp_fit is not None and float(comp_fit) >= 50.0) or offsets_nonzero
        else "not-calibrated"
    )

    trim_supported = any(params.get(p) is not None for p in ("AHRS_TRIM_X", "AHRS_TRIM_Y"))
    trim_status = (
        "unsupported"
        if not trim_supported
        else "calibrated"
        if params.get("AHRS_TRIM_X") in (None, 0.0) and params.get("AHRS_TRIM_Y") in (None, 0.0)
        else "not-calibrated"
    )

    return {
        "connected": True,
        "armed": False,
        "systemId": 1,
        "componentId": 1,
        "vehicleType": "QUADROTOR",
        "autopilot": "ARDUPILOTMEGA",
        "connectionType": "SERIAL",
        "sensors": {
            "accel": {
                "status": group_status(params.get("INS_ACC_ID"), accel_ids["INS_ACC_ID"]["supported"]),
                "ids": accel_ids,
                "offsets": read(["INS_ACC_OFFSET_X", "INS_ACC_OFFSET_Y", "INS_ACC_OFFSET_Z",
                                 "INS_ACCOFFS_X", "INS_ACCOFFS_Y", "INS_ACCOFFS_Z"]),
                "detected": 0,
            },
            "gyro": {
                "status": group_status(params.get("INS_GYR_ID"), gyro_ids["INS_GYR_ID"]["supported"]),
                "ids": gyro_ids,
                "offsets": {},
                "detected": 0,
            },
            "baro": {
                "status": (
                    "calibrated"
                    if params.get("BARO1_GND_PRESS") not in (None, 0.0)
                    else "unsupported"
                    if not any(baro_ids[pid]["supported"] for pid in baro_ids)
                    else "not-calibrated"
                ),
                "ids": baro_ids,
                "offsets": {},
                "detected": 0,
                "gndPress": params.get("BARO1_GND_PRESS"),
            },
            "compass": {
                "status": compass_status,
                "ids": compass_ids,
                "offsets": compass_offsets,
                "detected": 0,
            },
            "level": {
                "status": trim_status,
                "ids": trim,
                "offsets": {},
                "trim": {"x": params.get("AHRS_TRIM_X") or 0.0, "y": params.get("AHRS_TRIM_Y") or 0.0},
            },
        },
    }


class TestDisconnected:
    def test_returns_empty_items(self):
        from services.setup_summary_service import get_setup_summary

        summary = get_setup_summary()
        assert summary["connected"] is False
        assert summary["items"] == []
        assert summary["counts"] == {"good": 0, "warn": 0, "unsupported": 0, "unknown": 0, "waiting": 0}


class TestWaitingSync:
    def test_all_items_waiting_until_complete(self):
        from services import setup_summary_service as sss

        _mock_connected_state()
        with _patch_sync(_sync(state="receiving", receivedCount=500)), \
             _patch_params(_healthy_params()):
            summary = sss.get_setup_summary()

        assert summary["connected"] is True
        assert len(summary["items"]) == 14
        assert summary["counts"]["waiting"] == 14
        assert summary["counts"]["good"] == 0
        assert summary["counts"]["unsupported"] == 0
        for item in summary["items"]:
            assert item["tone"] == "waiting"
            assert item["message"] == "Waiting for parameter sync (500/991)"

    def test_syncing_message_when_no_count_yet(self):
        from services import setup_summary_service as sss

        _mock_connected_state()
        with _patch_sync(_sync(state="requesting", expectedCount=0, receivedCount=0)), \
             _patch_params(_healthy_params()):
            summary = sss.get_setup_summary()
        assert summary["items"][0]["message"] == "Syncing parameters…"


class TestSyncedArduCopter:
    def test_healthy_vehicle_never_unsupported(self):
        """Regression: ArduCopter 4.x with INS_ACC_ID/INS_GYR_ID/COMPASS_USE/
        BARO1_GND_PRESS present must NEVER be reported unsupported."""
        from services import setup_summary_service as sss

        _mock_connected_state()
        with _patch_sync(_sync()), \
             _patch_params(_healthy_params()), \
             patch.object(sss, "get_sensor_status", return_value=_make_sensor_status(_healthy_params())):
            summary = sss.get_setup_summary()

        assert summary["counts"]["unsupported"] == 0
        assert len(summary["items"]) == 14
        item_map = {i["id"]: i for i in summary["items"]}
        assert item_map["frame"]["tone"] == "good"
        assert item_map["accelerometer"]["tone"] == "good"
        assert item_map["gyroscope"]["tone"] == "good"
        assert item_map["compass"]["tone"] == "good"
        assert item_map["barometer"]["tone"] == "good"
        assert item_map["radio"]["tone"] == "good"
        assert item_map["flightModes"]["tone"] == "good"
        assert item_map["power"]["tone"] == "good"
        assert item_map["safety"]["tone"] == "good"
        assert item_map["esc"]["tone"] == "good"
        assert item_map["servoOutputs"]["tone"] == "good"
        assert item_map["logging"]["tone"] == "good"
        assert item_map["gps"]["tone"] == "good"
        assert item_map["gps"]["detail"] == "10 satellites tracked"

    def test_counts_sum_matches_items(self):
        from services import setup_summary_service as sss

        _mock_connected_state()
        with _patch_sync(_sync()), \
             _patch_params(_healthy_params()), \
             patch.object(sss, "get_sensor_status", return_value=_make_sensor_status(_healthy_params())):
            summary = sss.get_setup_summary()
        total = sum(summary["counts"].values())
        assert total == len(summary["items"]) == 14

    def test_frame_ships_raw_codes_for_frontend_labels(self):
        from services import setup_summary_service as sss

        _mock_connected_state()
        params = dict(_healthy_params())
        with _patch_sync(_sync()), \
             _patch_params(params), \
             patch.object(sss, "get_sensor_status", return_value=_make_sensor_status(params)):
            summary = sss.get_setup_summary()
        frame = [i for i in summary["items"] if i["id"] == "frame"][0]
        assert frame["meta"]["frameClass"] == 4
        assert frame["meta"]["frameType"] == 0
        assert frame["nav"] == "frame"

    def test_flight_mode_slots_are_decoded_from_live_arducopter_parameters(self):
        from services import setup_summary_service as sss

        _mock_connected_state()
        with _patch_sync(_sync()), \
             _patch_params(_healthy_params()), \
             patch.object(sss, "get_sensor_status", return_value=_make_sensor_status(_healthy_params())):
            summary = sss.get_setup_summary()

        assert [mode["name"] for mode in summary["flightModes"]] == [
            "STABILIZE", "ACRO", "ALT_HOLD", "AUTO", "GUIDED", "LOITER",
        ]

    def test_every_item_has_a_nav_target(self):
        from services import setup_summary_service as sss

        _mock_connected_state()
        with _patch_sync(_sync()), \
             _patch_params(_healthy_params()), \
             patch.object(sss, "get_sensor_status", return_value=_make_sensor_status(_healthy_params())):
            summary = sss.get_setup_summary()
        navs = {i["id"]: i["nav"] for i in summary["items"]}
        assert navs == {
            "frame": "frame",
            "accelerometer": "sensors",
            "gyroscope": "sensors",
            "compass": "sensors",
            "barometer": "sensors",
            "level": "sensors",
            "radio": "radio",
            "flightModes": "modes",
            "power": "power",
            "safety": "safety",
            "esc": "esc",
            "servoOutputs": "servos",
            "logging": "logging",
            "gps": "parameters",
        }


class TestUnsupportedDetection:
    def test_missing_from_live_set_is_unsupported(self):
        """Unsupported only when the sync is complete AND the defining param is
        genuinely absent from the downloaded set."""
        from services import setup_summary_service as sss

        _mock_connected_state()
        params = dict(_healthy_params())
        params.pop("FRAME_CLASS")
        params.pop("FRAME_TYPE")
        with _patch_sync(_sync()), \
             _patch_params(params), \
             patch.object(sss, "get_sensor_status", return_value=_make_sensor_status(params)):
            summary = sss.get_setup_summary()
        frame = [i for i in summary["items"] if i["id"] == "frame"][0]
        assert frame["tone"] == "unsupported"

    def test_one_missing_secondary_param_never_unsupported(self):
        """BATT_FS_* absent on this firmware: safety stays evaluable."""
        from services import setup_summary_service as sss

        _mock_connected_state()
        params = dict(_healthy_params())
        params.pop("FS_THR_ENABLE")
        with _patch_sync(_sync()), \
             _patch_params(params), \
             patch.object(sss, "get_sensor_status", return_value=_make_sensor_status(params)):
            summary = sss.get_setup_summary()
        safety = [i for i in summary["items"] if i["id"] == "safety"][0]
        assert safety["tone"] in ("good", "warn")
        assert safety["tone"] != "unsupported"


class TestWarnValues:
    def test_frame_class_zero_is_warn(self):
        from services import setup_summary_service as sss

        _mock_connected_state()
        params = dict(_healthy_params())
        params["FRAME_CLASS"] = 0.0
        with _patch_sync(_sync()), \
             _patch_params(params), \
             patch.object(sss, "get_sensor_status", return_value=_make_sensor_status(params)):
            summary = sss.get_setup_summary()
        frame = [i for i in summary["items"] if i["id"] == "frame"][0]
        assert frame["tone"] == "warn"
        assert frame["meta"]["frameClass"] == 0

    def test_accel_id_zero_is_warn_not_unsupported(self):
        from services import setup_summary_service as sss

        _mock_connected_state()
        params = dict(_healthy_params())
        params["INS_ACC_ID"] = 0.0
        with _patch_sync(_sync()), \
             _patch_params(params), \
             patch.object(sss, "get_sensor_status", return_value=_make_sensor_status(params)):
            summary = sss.get_setup_summary()
        accel = [i for i in summary["items"] if i["id"] == "accelerometer"][0]
        assert accel["tone"] == "warn"
        assert "Calibration" in accel["message"]


    def test_gps_no_fix_is_warn(self):
        from services import setup_summary_service as sss

        _mock_connected_state(satellites=0)
        with _patch_sync(_sync()), \
             _patch_params(_healthy_params()), \
             patch.object(sss, "get_sensor_status", return_value=_make_sensor_status(_healthy_params())):
            summary = sss.get_setup_summary()
        gps = [i for i in summary["items"] if i["id"] == "gps"][0]
        assert gps["tone"] == "warn"

    def test_flight_modes_reports_slot_count(self):
        from services import setup_summary_service as sss

        _mock_connected_state()
        with _patch_sync(_sync()), \
             _patch_params(_healthy_params()), \
             patch.object(sss, "get_sensor_status", return_value=_make_sensor_status(_healthy_params())):
            summary = sss.get_setup_summary()
        modes = [i for i in summary["items"] if i["id"] == "flightModes"][0]
        assert modes["tone"] == "good"
        assert "6 slots" in modes["detail"]


class TestEscServo:
    def test_esc_present_is_configured(self):
        from services import setup_summary_service as sss

        _mock_connected_state()
        with _patch_sync(_sync()), \
             _patch_params(_healthy_params()), \
             patch.object(sss, "get_sensor_status", return_value=_make_sensor_status(_healthy_params())):
            summary = sss.get_setup_summary()
        esc = [i for i in summary["items"] if i["id"] == "esc"][0]
        assert esc["tone"] == "good"
        assert esc["nav"] == "esc"
        assert "MOT_PWM_TYPE" in esc["detail"]

    def test_summary_excludes_removed_gimbal_page(self):
        """No MNT_* params anywhere in the live set => genuine 'no gimbal',
        reported unsupported (not disable-on-default)."""
        from services import setup_summary_service as sss

        _mock_connected_state()
        params = dict(_healthy_params())
        params.pop("MNT_TYPE")
        with _patch_sync(_sync()), \
             _patch_params(params), \
             patch.object(sss, "get_sensor_status", return_value=_make_sensor_status(params)):
            summary = sss.get_setup_summary()
        assert not any(i["id"] == "gimbal" for i in summary["items"])

    def test_summary_excludes_gimbal_even_when_mount_params_exist(self):
        from services import setup_summary_service as sss

        _mock_connected_state()
        params = dict(_healthy_params())
        params["MNT_TYPE"] = 0.0
        with _patch_sync(_sync()), \
             _patch_params(params), \
             patch.object(sss, "get_sensor_status", return_value=_make_sensor_status(params)):
            summary = sss.get_setup_summary()
        assert not any(i["id"] == "gimbal" for i in summary["items"])

    def test_servo_outputs_absent_is_unsupported(self):
        from services import setup_summary_service as sss

        _mock_connected_state()
        params = dict(_healthy_params())
        for pid in ("SERVO1_FUNCTION", "SERVO1_MIN", "SERVO1_MAX", "SERVO1_TRIM", "RC1_FUNCTION"):
            params.pop(pid, None)
        with _patch_sync(_sync()), \
             _patch_params(params), \
             patch.object(sss, "get_sensor_status", return_value=_make_sensor_status(params)):
            summary = sss.get_setup_summary()
        servo = [i for i in summary["items"] if i["id"] == "servoOutputs"][0]
        assert servo["tone"] == "unsupported"
        assert servo["nav"] == "servos"


class TestRangeConfigOnly:
    def test_radio_param_existence_alone_is_not_configured(self):
        """Merely having RC1_MIN/RC1_MAX is NOT 'configured' — the stored
        channel endpoints (a real QGC-style calibration range) prove it."""
        from services import setup_summary_service as sss

        _mock_connected_state()
        params = dict(_healthy_params())
        params["RC1_MIN"] = 1400.0
        params["RC1_MAX"] = 1600.0
        with _patch_sync(_sync()), \
             _patch_params(params), \
             patch.object(sss, "get_sensor_status", return_value=_make_sensor_status(params)):
            summary = sss.get_setup_summary()
        radio = [i for i in summary["items"] if i["id"] == "radio"][0]
        assert radio["tone"] == "warn"
        assert "RC calibration required" in radio["message"]
        assert radio["nav"] == "radio"


class TestConfigHealth:
    def test_compass_disabled_is_warn(self):
        from services import setup_summary_service as sss

        _mock_connected_state()
        params = dict(_healthy_params())
        params["COMPASS_USE"] = 0.0
        with _patch_sync(_sync()), \
             _patch_params(params), \
             patch.object(sss, "get_sensor_status", return_value=_make_sensor_status(params)):
            summary = sss.get_setup_summary()
        compass = [i for i in summary["items"] if i["id"] == "compass"][0]
        assert compass["tone"] == "warn"
        assert "Disabled" in compass["message"]

    def test_battery_monitor_disabled_is_warn(self):
        from services import setup_summary_service as sss

        _mock_connected_state()
        params = dict(_healthy_params())
        params["BATT_MONITOR"] = 0.0
        with _patch_sync(_sync()), \
             _patch_params(params), \
             patch.object(sss, "get_sensor_status", return_value=_make_sensor_status(params)):
            summary = sss.get_setup_summary()
        power = [i for i in summary["items"] if i["id"] == "power"][0]
        assert power["tone"] == "warn"
        assert "disabled" in power["message"]
        assert power["nav"] == "power"

    def test_logging_disabled_is_warn(self):
        from services import setup_summary_service as sss

        _mock_connected_state()
        params = dict(_healthy_params())
        params["LOG_BITMASK"] = 0.0
        with _patch_sync(_sync()), \
             _patch_params(params), \
             patch.object(sss, "get_sensor_status", return_value=_make_sensor_status(params)):
            summary = sss.get_setup_summary()
        logging = [i for i in summary["items"] if i["id"] == "logging"][0]
        assert logging["tone"] == "warn"
        assert logging["nav"] == "logging"

    def test_mixed_health_counts_are_computed_not_hardcoded(self):
        from services import setup_summary_service as sss

        _mock_connected_state(satellites=0)
        params = dict(_healthy_params())
        params["FRAME_CLASS"] = 0.0
        params["COMPASS_USE"] = 0.0
        with _patch_sync(_sync()), \
             _patch_params(params), \
             patch.object(sss, "get_sensor_status", return_value=_make_sensor_status(params)):
            summary = sss.get_setup_summary()
        assert summary["counts"] == {"good": 11, "warn": 3, "unsupported": 0, "unknown": 0, "waiting": 0}

    def test_indeterminate_sensor_readback_is_unknown_not_unsupported(self):
        """An API readback failure must surface as UNKNOWN — never degraded to
        UNSUPPORTED, which is reserved for genuine capability absence."""
        from services import setup_summary_service as sss

        _mock_connected_state()
        sensors = _make_sensor_status(_healthy_params())
        sensors["sensors"]["compass"]["status"] = None
        with _patch_sync(_sync()), \
             _patch_params(_healthy_params()), \
             patch.object(sss, "get_sensor_status", return_value=sensors):
            summary = sss.get_setup_summary()
        compass = [i for i in summary["items"] if i["id"] == "compass"][0]
        assert compass["tone"] == "unknown"

    def test_level_stored_small_offset_is_good(self):
        """A leveled multirotor stores a small reset offset in AHRS_TRIM — that
        is the healthy calibrated reading, not a calibration failure."""
        from services import setup_summary_service as sss

        _mock_connected_state()
        params = dict(_healthy_params())
        params["AHRS_TRIM_X"] = -0.0036
        params["AHRS_TRIM_Y"] = -0.0011
        with _patch_sync(_sync()), \
             _patch_params(params), \
             patch.object(sss, "get_sensor_status", return_value=_make_sensor_status(params)):
            summary = sss.get_setup_summary()
        level = [i for i in summary["items"] if i["id"] == "level"][0]
        assert level["tone"] == "good"
        assert "Level horizon set" in level["message"]

    def test_level_large_offset_is_warn(self):
        from services import setup_summary_service as sss

        _mock_connected_state()
        params = dict(_healthy_params())
        params["AHRS_TRIM_X"] = 0.04
        params["AHRS_TRIM_Y"] = 0.03
        with _patch_sync(_sync()), \
             _patch_params(params), \
             patch.object(sss, "get_sensor_status", return_value=_make_sensor_status(params)):
            summary = sss.get_setup_summary()
        level = [i for i in summary["items"] if i["id"] == "level"][0]
        assert level["tone"] == "warn"
        assert "Level horizon offset large" in level["message"]
    @pytest.fixture
    def client(self):
        from fastapi.testclient import TestClient
        from app import app

        return TestClient(app)

    def test_returns_summary_shape(self, client):
        from services import setup_summary_service as sss

        _mock_connected_state()
        with _patch_sync(_sync()), \
             _patch_params(_healthy_params()), \
             patch.object(sss, "get_sensor_status", return_value=_make_sensor_status(_healthy_params())):
            response = client.get("/api/setup/summary")

        assert response.status_code == 200
        body = response.json()
        assert body["success"] is True
        assert body["connected"] is True
        assert body["sync"]["state"] == "complete"
        assert len(body["items"]) == 14
        assert set(body["counts"]) == {"good", "warn", "unsupported", "unknown", "waiting"}

    def test_disconnected_endpoint(self, client):
        body = client.get("/api/setup/summary").json()
        assert body["connected"] is False
        assert body["items"] == []


class _FakeThread:
    """Records construction and runs the target synchronously on start()."""
    instances = []

    def __init__(self, **kw):
        self.kw = kw
        self.started = False
        _FakeThread.instances.append(self)

    def start(self):
        self.started = True
        target = self.kw.get("target")
        if target:
            target()


class TestAutoParamDownload:
    def _patch_thread(self):
        _FakeThread.instances = []
        return patch("mavlink.connection_manager.threading.Thread", _FakeThread)

    def _sync(self, **kw):
        state = {"connected": True, "state": "idle",
                 "expectedCount": 0, "receivedCount": 0,
                 "cachedEntries": 0, "startedAt": None,
                 "lastReceivedAt": None, "missingIds": [],
                 "retryCount": 0, "needsRefresh": False}
        state.update(kw)
        return state

    def test_skips_when_disconnected(self):
        from mavlink import connection_manager as cm

        with patch.object(cm.parameter_manager, "get_synchronization_state",
                          return_value=self._sync(connected=False)), \
             patch.object(cm.parameter_manager, "request_all_parameters") as req, \
             self._patch_thread():
            cm.manager._start_auto_param_download()
        req.assert_not_called()
        assert _FakeThread.instances == []

    def test_skips_when_download_already_running(self):
        from mavlink import connection_manager as cm

        for state in ("requesting", "receiving"):
            with patch.object(cm.parameter_manager, "get_synchronization_state",
                              return_value=self._sync(state=state, cachedEntries=20)), \
                 patch.object(cm.parameter_manager, "request_all_parameters") as req, \
                 self._patch_thread():
                cm.manager._start_auto_param_download()
            req.assert_not_called()
            assert _FakeThread.instances == []

    def test_skips_when_already_complete_with_cache(self):
        from mavlink import connection_manager as cm

        with patch.object(cm.parameter_manager, "get_synchronization_state",
                          return_value=self._sync(state="complete", cachedEntries=991,
                                                  expectedCount=991, receivedCount=991)), \
             patch.object(cm.parameter_manager, "request_all_parameters") as req, \
             self._patch_thread():
            cm.manager._start_auto_param_download()
        req.assert_not_called()
        assert _FakeThread.instances == []

    def test_starts_daemon_thread_when_idle(self):
        from mavlink import connection_manager as cm

        with patch.object(cm.parameter_manager, "get_synchronization_state",
                          return_value=self._sync()), \
             patch.object(cm.parameter_manager, "request_all_parameters") as req, \
             self._patch_thread():
            cm.manager._start_auto_param_download()

        assert len(_FakeThread.instances) == 1
        assert _FakeThread.instances[0].kw.get("daemon") is True
        assert _FakeThread.instances[0].kw.get("name") == "param-auto-download"
        req.assert_called_once()

    def test_worker_calls_request_all_parameters(self):
        from mavlink import connection_manager as cm

        with patch.object(cm.parameter_manager, "request_all_parameters") as req:
            cm.manager._auto_param_download_worker()
        req.assert_called_once()

    def test_worker_swallows_unexpected_errors(self):
        from mavlink import connection_manager as cm

        with patch.object(cm.parameter_manager, "request_all_parameters",
                          side_effect=RuntimeError("boom")):
            cm.manager._auto_param_download_worker()  # must not raise
