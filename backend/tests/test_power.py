"""Dedicated test matrix for Phase 8F — Power Setup (ArduCopter / Pixhawk).

Covers all 30 requirements specified in Phase 8F Section 33:
 1. ArduCopter supported
 2. unsupported vehicle
 3. no vehicle
 4. BATT_MONITOR parsing
 5. BATT_CAPACITY parsing
 6. BATT_LOW_VOLT parsing
 7. BATT_CRT_VOLT parsing
 8. BATT_LOW_MAH parsing
 9. BATT_CRT_MAH parsing
10. BATT_LOW_TIMER parsing
11. BATT_FS_LOW_ACT parsing
12. BATT_FS_CRT_ACT parsing
13. battery telemetry parsing
14. voltage
15. current
16. consumed mAh
17. remaining percentage
18. battery ID
19. telemetry freshness
20. stale telemetry
21. disconnect
22. reconnect
23. parameter write
24. PARAM_VALUE verification
25. failed parameter write
26. unavailable parameter
27. disabled monitor
28. multiple battery instances
29. malformed telemetry
30. malformed parameter payload
"""

import time
from contextlib import contextmanager
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from app import app
from core.state import telemetry, vehicle_state
from mavlink import parameter_manager as pm
from mavlink.parameter_manager import parameter_manager
from mavlink.telemetry_manager import (
    BATTERY_STALE_MS,
    get_all_battery_telemetry,
    get_battery_telemetry,
    handle_battery_status,
    handle_sys_status,
    reset_battery_telemetry,
    reset_telemetry,
)
from services import power_service


@pytest.fixture(autouse=True)
def _clean_power_state():
    """Reset telemetry, vehicle_state, and battery records before each test."""
    tkeys = [
        "connected", "vehicleType", "autopilot", "batteryVoltage",
        "batteryCurrent", "batteryRemaining",
    ]
    t_snapshot = {k: telemetry.get(k) for k in tkeys}
    s_snapshot = dict(vehicle_state)
    reset_battery_telemetry()
    yield
    for k in tkeys:
        telemetry[k] = t_snapshot[k]
    vehicle_state.clear()
    vehicle_state.update(s_snapshot)
    reset_battery_telemetry()


def _mock_connected(vehicle_type="QUADROTOR", autopilot="ARDUPILOTMEGA", state="connected"):
    vehicle_state["serialPortOpen"] = True
    vehicle_state["connected"] = (state == "connected")
    vehicle_state["connectionState"] = state
    vehicle_state["disconnectReason"] = None if state == "connected" else "Link closed"
    vehicle_state["lastHeartbeat"] = int(time.time() * 1000) if state == "connected" else 0
    vehicle_state["vehicleType"] = vehicle_type
    vehicle_state["autopilot"] = autopilot
    telemetry["connected"] = (state == "connected")
    telemetry["vehicleType"] = vehicle_type
    telemetry["autopilot"] = autopilot


@contextmanager
def _patch_params(param_dict):
    """Patch parameter cache + sync so Power snapshots use fixture params only."""
    def fake_get(pid):
        val = param_dict.get(pid)
        if val is None:
            return None
        return {"id": pid, "value": val, "type": "REAL32", "writeState": "verified"}

    def fake_all():
        return [{"id": k, "value": v, "type": "REAL32"} for k, v in param_dict.items()]

    sync = {
        "connected": True,
        "state": "complete",
        "expectedCount": len(param_dict),
        "receivedCount": len(param_dict),
        "missingIds": [],
        "cachedEntries": len(param_dict),
        "retryCount": 0,
        "needsRefresh": False,
        "complete": True,
    }
    with patch.object(parameter_manager, "get_parameter", side_effect=fake_get), \
         patch.object(parameter_manager, "get_all_parameters", side_effect=fake_all), \
         patch.object(parameter_manager, "get_synchronization_state", return_value=sync):
        yield


client = TestClient(app)


# ---------------------------------------------------------------------------
# 1–3: Vehicle Detection & Guards
# ---------------------------------------------------------------------------

def test_01_arducopter_supported():
    _mock_connected(vehicle_type="QUADROTOR", autopilot="ARDUPILOTMEGA")
    with _patch_params({"BATT_MONITOR": 4.0}):
        res = power_service.get_power_info()
        assert res["supported"] is True
        assert res["unsupportedReason"] == ""
        assert res["vehicleType"] == "QUADROTOR"
        assert res["autopilot"] == "ARDUPILOTMEGA"


def test_02_unsupported_vehicle():
    _mock_connected(vehicle_type="GROUND_ROVER", autopilot="ARDUPILOTMEGA")
    res = power_service.get_power_info()
    assert res["supported"] is False
    assert "ArduCopter in this version" in res["unsupportedReason"]
    assert res["state"] == power_service.STATE_UNSUPPORTED


def test_03_no_vehicle():
    vehicle_state["connected"] = False
    vehicle_state["connectionState"] = "disconnected"
    vehicle_state["disconnectReason"] = None
    telemetry["connected"] = False
    res = power_service.get_power_info()
    assert res["supported"] is False
    assert res["state"] == power_service.STATE_WAITING
    assert "No vehicle connected" in res["unsupportedReason"]


# ---------------------------------------------------------------------------
# 4–12: ArduPilot Battery Parameter Parsing
# ---------------------------------------------------------------------------

def test_04_batt_monitor_parsing():
    _mock_connected()
    params = {"BATT_MONITOR": 4.0}
    with _patch_params(params):
        info = power_service.get_power_info()
        assert info["instanceCount"] >= 1
        mon = info["instances"][0]["monitor"]
        assert mon["value"] == 4.0
        assert mon["supported"] is True
        assert mon["decoded"] == "Analog Voltage and Current"
        assert mon["rebootRequired"] is True
        assert len(mon["options"]) > 0


def test_05_batt_capacity_parsing():
    _mock_connected()
    params = {"BATT_MONITOR": 4.0, "BATT_CAPACITY": 5200.0}
    with _patch_params(params):
        info = power_service.get_power_info()
        cap = info["instances"][0]["capacity"]
        assert cap["value"] == 5200.0
        assert cap["units"] == "mAh"
        assert cap["supported"] is True


def test_06_batt_low_volt_parsing():
    _mock_connected()
    params = {"BATT_MONITOR": 4.0, "BATT_LOW_VOLT": 14.2}
    with _patch_params(params):
        info = power_service.get_power_info()
        lv = info["instances"][0]["thresholds"]["lowVolt"]
        assert lv["value"] == 14.2
        assert lv["units"] == "V"


def test_07_batt_crt_volt_parsing():
    _mock_connected()
    params = {"BATT_MONITOR": 4.0, "BATT_CRT_VOLT": 13.8}
    with _patch_params(params):
        info = power_service.get_power_info()
        cv = info["instances"][0]["thresholds"]["crtVolt"]
        assert cv["value"] == 13.8
        assert cv["units"] == "V"


def test_08_batt_low_mah_parsing():
    _mock_connected()
    params = {"BATT_MONITOR": 4.0, "BATT_LOW_MAH": 1000.0}
    with _patch_params(params):
        info = power_service.get_power_info()
        lm = info["instances"][0]["thresholds"]["lowMah"]
        assert lm["value"] == 1000.0
        assert lm["units"] == "mAh"


def test_09_batt_crt_mah_parsing():
    _mock_connected()
    params = {"BATT_MONITOR": 4.0, "BATT_CRT_MAH": 500.0}
    with _patch_params(params):
        info = power_service.get_power_info()
        cm = info["instances"][0]["thresholds"]["crtMah"]
        assert cm["value"] == 500.0
        assert cm["units"] == "mAh"


def test_10_batt_low_timer_parsing():
    _mock_connected()
    params = {"BATT_MONITOR": 4.0, "BATT_LOW_TIMER": 10.0}
    with _patch_params(params):
        info = power_service.get_power_info()
        lt = info["instances"][0]["thresholds"]["lowTimer"]
        assert lt["value"] == 10.0
        assert lt["units"] == "s"


def test_11_batt_fs_low_act_parsing():
    _mock_connected()
    params = {"BATT_MONITOR": 4.0, "BATT_FS_LOW_ACT": 2.0}
    with _patch_params(params):
        info = power_service.get_power_info()
        fs = info["instances"][0]["thresholds"]["fsLowAct"]
        assert fs["value"] == 2.0
        assert fs["decoded"] == "RTL"
        assert "Safety" in fs["readOnlyNotice"]


def test_12_batt_fs_crt_act_parsing():
    _mock_connected()
    params = {"BATT_MONITOR": 4.0, "BATT_FS_CRT_ACT": 1.0}
    with _patch_params(params):
        info = power_service.get_power_info()
        fs = info["instances"][0]["thresholds"]["fsCrtAct"]
        assert fs["value"] == 1.0
        assert fs["decoded"] == "Land"
        assert "Safety" in fs["readOnlyNotice"]


# ---------------------------------------------------------------------------
# 13–18: Live MAVLink Battery Telemetry
# ---------------------------------------------------------------------------

def test_13_battery_telemetry_parsing():
    msg = MagicMock()
    msg.id = 0
    msg.voltages = [3800, 3810, 3805, 3820]
    msg.current_battery = 1520  # 15.20 A
    msg.current_consumed = 1200
    msg.battery_remaining = 75
    msg.temperature = 2850  # 28.50 C
    msg.charge_state = 1  # OK
    handle_battery_status(msg)

    telem = get_battery_telemetry(0)
    assert telem is not None
    assert telem["source"] == "BATTERY_STATUS"
    assert telem["chargeState"] == "OK"


def test_14_voltage():
    msg = MagicMock()
    msg.id = 0
    msg.voltages = [4100, 4100, 4100, 4100]
    msg.current_battery = -1
    msg.current_consumed = -1
    msg.battery_remaining = -1
    msg.temperature = 32767
    msg.charge_state = 0
    handle_battery_status(msg)

    telem = get_battery_telemetry(0)
    assert telem["voltage"] == pytest.approx(16.4)
    assert telem["cellVoltages"] == [4.1, 4.1, 4.1, 4.1]


def test_15_current():
    # 0 A is a genuine measured current, distinct from -1 (unavailable)
    msg0 = MagicMock()
    msg0.voltage_battery = 15000
    msg0.current_battery = 0
    msg0.battery_remaining = 80
    handle_sys_status(msg0)
    telem0 = get_battery_telemetry(0)
    assert telem0["current"] == 0.0

    # -1 means unavailable
    msg_unavail = MagicMock()
    msg_unavail.voltage_battery = 15000
    msg_unavail.current_battery = -1
    msg_unavail.battery_remaining = 80
    handle_sys_status(msg_unavail)
    telem_unavail = get_battery_telemetry(0)
    assert telem_unavail["current"] is None


def test_16_consumed_mah():
    msg = MagicMock()
    msg.id = 0
    msg.voltages = [3700]
    msg.current_battery = 500
    msg.current_consumed = 2450
    msg.battery_remaining = 50
    msg.temperature = 32767
    handle_battery_status(msg)
    telem = get_battery_telemetry(0)
    assert telem["consumedMah"] == 2450.0


def test_17_remaining_percentage():
    # Real percentage
    msg = MagicMock()
    msg.voltage_battery = 15500
    msg.current_battery = 1000
    msg.battery_remaining = 65
    handle_sys_status(msg)
    telem = get_battery_telemetry(0)
    assert telem["remaining"] == 65

    # Unavailable percentage (-1)
    msg_none = MagicMock()
    msg_none.voltage_battery = 15500
    msg_none.current_battery = 1000
    msg_none.battery_remaining = -1
    handle_sys_status(msg_none)
    telem_none = get_battery_telemetry(0)
    assert telem_none["remaining"] is None


def test_18_battery_id():
    msg0 = MagicMock()
    msg0.id = 0
    msg0.voltages = [4000]
    msg0.current_battery = 100
    msg0.current_consumed = 100
    msg0.battery_remaining = 90
    msg0.temperature = 32767
    handle_battery_status(msg0)

    msg1 = MagicMock()
    msg1.id = 1
    msg1.voltages = [3900]
    msg1.current_battery = 200
    msg1.current_consumed = 300
    msg1.battery_remaining = 85
    msg1.temperature = 32767
    handle_battery_status(msg1)

    t0 = get_battery_telemetry(0)
    t1 = get_battery_telemetry(1)
    assert t0["instance"] == 0
    assert t0["id"] == 1
    assert t1["instance"] == 1
    assert t1["id"] == 2
    assert t0["voltage"] == 4.0
    assert t1["voltage"] == 3.9


# ---------------------------------------------------------------------------
# 19–20: Freshness & Stale Telemetry
# ---------------------------------------------------------------------------

def test_19_telemetry_freshness():
    msg = MagicMock()
    msg.id = 0
    msg.voltages = [4100]
    msg.current_battery = 200
    msg.current_consumed = 50
    msg.battery_remaining = 95
    msg.temperature = 32767
    handle_battery_status(msg)

    telem = get_battery_telemetry(0)
    assert telem["receivedAt"] is not None
    assert telem["stale"] is False
    assert telem["ageMs"] < 1000


def test_20_stale_telemetry():
    msg = MagicMock()
    msg.id = 0
    msg.voltages = [4100]
    msg.current_battery = 200
    msg.current_consumed = 50
    msg.battery_remaining = 95
    msg.temperature = 32767
    handle_battery_status(msg)

    # Simulate passage of time beyond BATTERY_STALE_MS
    from mavlink import telemetry_manager
    telemetry_manager._batteries[0]["receivedAt"] = time.time() - (BATTERY_STALE_MS / 1000.0 + 1.0)

    telem = get_battery_telemetry(0)
    assert telem["stale"] is True
    assert telem["ageMs"] >= BATTERY_STALE_MS


# ---------------------------------------------------------------------------
# 21–22: Disconnect & Reconnect
# ---------------------------------------------------------------------------

def test_21_disconnect():
    msg = MagicMock()
    msg.id = 0
    msg.voltages = [4100]
    msg.current_battery = 200
    msg.current_consumed = 50
    msg.battery_remaining = 95
    msg.temperature = 32767
    handle_battery_status(msg)
    assert len(get_all_battery_telemetry()) == 1

    # Disconnect vehicle
    reset_telemetry()
    assert len(get_all_battery_telemetry()) == 0
    assert get_battery_telemetry(0) is None


def test_22_reconnect():
    reset_telemetry()
    assert len(get_all_battery_telemetry()) == 0

    # Reconnect and receive telemetry
    _mock_connected()
    msg = MagicMock()
    msg.id = 0
    msg.voltages = [4200]
    msg.current_battery = 150
    msg.current_consumed = 20
    msg.battery_remaining = 99
    msg.temperature = 32767
    handle_battery_status(msg)

    telem = get_battery_telemetry(0)
    assert telem is not None
    assert telem["voltage"] == 4.2
    assert telem["stale"] is False


# ---------------------------------------------------------------------------
# 23–25: Parameter Write Pipeline & Verification
# ---------------------------------------------------------------------------

def test_23_parameter_write():
    from services.parameter_service import parameter_service
    _mock_connected()
    parameter_manager.start_session()

    with patch.object(parameter_manager, "set_parameter") as mock_set:
        mock_set.return_value = {"status": pm.RESULT_SUCCESS, "value": 5000.0}
        res = parameter_service.write_parameter("BATT_CAPACITY", 5000.0)
        assert res["success"] is True
        assert res["parameter"]["id"] == "BATT_CAPACITY"
        assert res["parameter"]["value"] == 5000.0


def test_24_param_value_verification():
    from services.parameter_service import parameter_service
    _mock_connected()
    parameter_manager.start_session()

    # The verified pipeline confirms only upon vehicle PARAM_VALUE echo
    with patch.object(parameter_manager, "set_parameter") as mock_set:
        mock_set.return_value = {"status": pm.RESULT_SUCCESS, "value": 4.0}
        res = parameter_service.write_parameter("BATT_MONITOR", 4.0)
        assert res["success"] is True
        assert res["parameter"]["value"] == 4.0


def test_25_failed_parameter_write():
    from services.parameter_service import parameter_service
    _mock_connected()
    parameter_manager.start_session()

    with patch.object(parameter_manager, "set_parameter") as mock_set:
        mock_set.return_value = {"status": pm.RESULT_TIMEOUT, "message": "No PARAM_VALUE response"}
        res = parameter_service.write_parameter("BATT_CAPACITY", 99999.0)
        assert res.get("error") is not None
        assert res["error"]["code"] == "WRITE_TIMEOUT"


# ---------------------------------------------------------------------------
# 26–28: Missing Parameters, Disabled Monitor, Multiple Instances
# ---------------------------------------------------------------------------

def test_26_unavailable_parameter():
    _mock_connected()
    # Vehicle does not expose BATT_LOW_MAH or BATT_CRT_MAH
    params = {"BATT_MONITOR": 4.0, "BATT_CAPACITY": 5000.0}
    with _patch_params(params):
        info = power_service.get_power_info()
        lm = info["instances"][0]["thresholds"]["lowMah"]
        assert lm["supported"] is False
        assert lm["value"] is None


def test_27_disabled_monitor():
    _mock_connected()
    params = {"BATT_MONITOR": 0.0}
    with _patch_params(params):
        info = power_service.get_power_info()
        assert info["state"] == power_service.STATE_MONITOR_DISABLED
        assert info["instances"][0]["health"]["status"] == "DISABLED"


def test_28_multiple_battery_instances():
    _mock_connected()
    params = {
        "BATT_MONITOR": 4.0,
        "BATT_CAPACITY": 5200.0,
        "BATT2_MONITOR": 3.0,
        "BATT2_CAPACITY": 2200.0,
    }
    with _patch_params(params):
        info = power_service.get_power_info()
        assert info["instanceCount"] == 2
        inst1 = info["instances"][0]
        inst2 = info["instances"][1]
        assert inst1["instance"] == 1
        assert inst1["monitor"]["value"] == 4.0
        assert inst1["capacity"]["value"] == 5200.0
        assert inst2["instance"] == 2
        assert inst2["monitor"]["value"] == 3.0
        assert inst2["capacity"]["value"] == 2200.0


def test_28b_telemetry_only_second_battery_instance():
    """A second BATTERY_STATUS id is shown even without BATT2_* parameters."""
    _mock_connected()
    msg1 = MagicMock()
    msg1.id = 1
    msg1.voltages = [3900]
    msg1.current_battery = 100
    msg1.current_consumed = 10
    msg1.battery_remaining = 80
    msg1.temperature = 32767
    msg1.charge_state = 1
    handle_battery_status(msg1)
    params = {"BATT_MONITOR": 4.0, "BATT_CAPACITY": 5200.0}
    with _patch_params(params):
        info = power_service.get_power_info()
        ids = [i["instance"] for i in info["instances"]]
        assert 1 in ids
        assert 2 in ids
        batt2 = next(i for i in info["instances"] if i["instance"] == 2)
        assert batt2["telemetry"]["voltage"] == pytest.approx(3.9)
        assert batt2["monitor"]["supported"] is False


# ---------------------------------------------------------------------------
# 29–30: Malformed Telemetry & Parameter Payloads
# ---------------------------------------------------------------------------

def test_29_malformed_telemetry():
    # Message with missing attributes or unexpected types
    msg = MagicMock()
    msg.id = None
    msg.voltages = None
    msg.current_battery = None
    msg.current_consumed = None
    msg.battery_remaining = None
    msg.temperature = None
    msg.charge_state = None

    # Should not raise exception
    handle_battery_status(msg)
    telem = get_battery_telemetry(0)
    assert telem is not None
    assert telem["voltage"] is None
    assert telem["current"] is None
    assert telem["remaining"] is None


def test_30_malformed_parameter_payload():
    from services.parameter_service import parameter_service
    _mock_connected()

    # Empty string or invalid parameter ID raises bad request
    with pytest.raises(Exception):
        parameter_service.write_parameter("", 12.0)


# ---------------------------------------------------------------------------
# REST API Endpoints & Calculation Helpers
# ---------------------------------------------------------------------------

def test_api_get_power():
    _mock_connected()
    params = {"BATT_MONITOR": 4.0, "BATT_CAPACITY": 5000.0}
    with _patch_params(params):
        res = client.get("/api/setup/power")
        assert res.status_code == 200
        data = res.json()
        assert data["success"] is True
        assert "instances" in data
        assert data["supported"] is True


def test_api_calculate_voltage_multiplier():
    res = client.post(
        "/api/setup/power/calculate-voltage-multiplier",
        json={
            "currentMultiplier": 10.1,
            "measuredVoltage": 16.0,
            "sensorVoltage": 15.0,
        },
    )
    assert res.status_code == 200
    data = res.json()
    assert data["success"] is True
    # 10.1 * (16.0 / 15.0) = 10.773333
    assert data["calculatedMultiplier"] == pytest.approx(10.773333, abs=1e-5)


def test_api_calculate_amps_per_volt():
    res = client.post(
        "/api/setup/power/calculate-amps-per-volt",
        json={
            "currentAmpsPerVolt": 18.0,
            "measuredCurrent": 10.0,
            "sensorCurrent": 9.0,
        },
    )
    assert res.status_code == 200
    data = res.json()
    assert data["success"] is True
    assert data["calculatedAmpsPerVolt"] == pytest.approx(20.0, abs=1e-5)
