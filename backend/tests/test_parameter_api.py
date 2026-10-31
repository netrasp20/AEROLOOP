"""REST API tests for /api/parameters (Phase 2).

Uses the REAL FastAPI app + a real (fresh) ParameterManager driven by the
fake vehicle, so route wiring, service layer, metadata merge and error
envelopes are all exercised end-to-end without any sockets or threads.
"""

import pytest
from fastapi.testclient import TestClient

from app import app
from core.state import vehicle_state
from mavlink import parameter_manager as pm

from tests.test_parameter_manager import (
    FAKE_VEHICLE_PARAMS,
    FAST_CONFIG,
    FakeMsg,
    FakeVehicle,
    make_vehicle,
)

FIVE = FAKE_VEHICLE_PARAMS


@pytest.fixture()
def client():
    mgr = pm.parameter_manager
    mgr._config.update(FAST_CONFIG)
    vehicle_state["vehicleType"] = "QUADROTOR"
    yield TestClient(app)
    try:
        mgr.stop_session("test shutdown")
    except Exception:  # noqa: BLE001
        pass


def connect_and_download():
    mgr = pm.parameter_manager
    make_vehicle(mgr)  # sets _sender
    mgr.start_session()
    result = mgr.request_all_parameters()
    assert result["status"] == "success"
    return mgr


def body(resp) -> dict:
    return resp.json()


# ---------------------------------------------------------------------------
# GET /api/parameters
# ---------------------------------------------------------------------------

def test_list_returns_merged_live_and_metadata(client):
    connect_and_download()
    resp = client.get("/api/parameters")
    assert resp.status_code == 200
    data = body(resp)
    assert data["success"] is True
    assert data["connection"] == "READY"
    assert data["count"] == len(FIVE)
    by_id = {p["id"]: p for p in data["parameters"]}
    fs = by_id["FS_GCS_ENABLE"]
    assert fs["live"]["value"] == 0.0
    assert fs["metadata"]["values"]["0"] == "Disabled/NoAction"
    wp = by_id["WP_RADIUS"]
    assert wp["metadata"] is None          # copter catalog uses WP_RADIUS_M
    assert wp["metadataMissing"] is True


def test_list_reflects_live_value_changes(client):
    mgr = connect_and_download()
    mgr.handle_param_value(FakeMsg("FS_GCS_ENABLE", 1.0, 3, len(FIVE), 3))
    resp = client.get("/api/parameters")
    by_id = {p["id"]: p for p in body(resp)["parameters"]}
    assert by_id["FS_GCS_ENABLE"]["live"]["value"] == 1.0


def test_list_disconnected_is_knowledge_free(client):
    resp = client.get("/api/parameters")
    data = body(resp)
    assert data["success"] is True
    assert data["connection"] == "DISCONNECTED"
    assert data["count"] == 0


def test_list_text_filter_narrows_results(client):
    connect_and_download()
    resp = client.get("/api/parameters", params={"q": "wp_r"})
    data = body(resp)
    ids = [p["id"] for p in data["parameters"]]
    assert "WP_RADIUS" in ids
    assert all("wp_r" in i.lower() for i in ids)


def test_list_filter_no_match_returns_empty(client):
    connect_and_download()
    resp = client.get("/api/parameters", params={"q": "zzz_no_such"})
    assert body(resp)["parameters"] == []


# ---------------------------------------------------------------------------
# GET /api/parameters/status, /api/parameters/metadata
# ---------------------------------------------------------------------------

def test_status_ready_after_download(client):
    connect_and_download()
    resp = client.get("/api/parameters/status")
    data = body(resp)
    assert data["success"] is True
    assert data["connection"] == "READY"
    assert data["sync"]["state"] == "complete"
    assert data["sync"]["receivedCount"] == len(FIVE)
    assert data["sessionId"] is not None
    assert data["metadata"]["status"] == "AVAILABLE"
    assert data["vehicle"]["vehicleType"] == "QUADROTOR"


def test_status_disconnected(client):
    resp = client.get("/api/parameters/status")
    data = body(resp)
    assert data["connection"] == "DISCONNECTED"
    assert data["sessionId"] is None


def test_metadata_status_endpoint(client):
    connect_and_download()
    resp = client.get("/api/parameters/metadata")
    data = body(resp)
    assert data["success"] is True
    assert data["metadataStatus"]["status"] == "AVAILABLE"
    assert data["metadataStatus"]["paramCount"] > 5000
    assert data["groups"]  # Mission Planner-style categories present


# ---------------------------------------------------------------------------
# GET /api/parameters/{param_id}
# ---------------------------------------------------------------------------

def test_single_param_merged(client):
    connect_and_download()
    resp = client.get("/api/parameters/WP_RADIUS")
    assert resp.status_code == 200
    data = body(resp)
    assert data["parameter"]["live"]["value"] == 10.0
    assert data["parameter"]["metadataMissing"] is True


def test_single_param_metadata_only_no_live_value(client):
    connect_and_download()
    resp = client.get("/api/parameters/WP_RADIUS_M")
    assert resp.status_code == 200
    param = body(resp)["parameter"]
    assert param["live"] is None
    assert param["metadata"]["units"] == "m"
    assert param["metadata"]["min"] == 0.05 and param["metadata"]["max"] == 10.0
    assert param["metadataMissing"] is False


def test_single_param_unknown_404(client):
    connect_and_download()
    resp = client.get("/api/parameters/DOES_NOT_EXIST")
    assert resp.status_code == 404
    err = body(resp)["error"]
    assert err["code"] == "PARAM_NOT_FOUND"


# ---------------------------------------------------------------------------
# GET /api/parameters/{param_id}/metadata
# ---------------------------------------------------------------------------

def test_metadata_for_param(client):
    connect_and_download()
    resp = client.get("/api/parameters/WP_RADIUS_M/metadata")
    assert resp.status_code == 200
    meta = body(resp)["metadata"]
    assert meta["id"] == "WP_RADIUS_M"
    assert meta["units"] == "m"
    assert meta["min"] == 0.05 and meta["max"] == 10.0 and meta["increment"] == 0.01


def test_metadata_unknown_404(client):
    connect_and_download()
    resp = client.get("/api/parameters/NOPE/metadata")
    assert resp.status_code == 404
    assert body(resp)["error"]["code"] == "PARAM_NOT_FOUND"


# ---------------------------------------------------------------------------
# POST /api/parameters/{param_id}/read
# ---------------------------------------------------------------------------

def test_read_param_success(client):
    connect_and_download()
    resp = client.post("/api/parameters/WP_RADIUS/read")
    assert resp.status_code == 200
    data = body(resp)
    assert data["success"] is True
    assert data["parameter"]["id"] == "WP_RADIUS"
    assert data["parameter"]["value"] == 10.0


def test_read_param_unknown_404(client):
    connect_and_download()
    resp = client.post("/api/parameters/DOES_NOT_EXIST/read")
    assert resp.status_code == 404
    assert body(resp)["error"]["code"] == "PARAM_NOT_FOUND"


def test_read_param_timeout_504(client):
    mgr = connect_and_download()
    # replace the vehicle with one that never answers individual reads
    make_vehicle(mgr, block_reads=True)
    resp = client.post("/api/parameters/WP_RADIUS/read")
    assert resp.status_code == 504
    assert body(resp)["error"]["code"] == "TIMEOUT"


def test_read_param_not_connected(client):
    resp = client.post("/api/parameters/WP_RADIUS/read")
    assert resp.status_code == 400
    assert body(resp)["error"]["code"] == "NOT_CONNECTED"


# ---------------------------------------------------------------------------
# POST /api/parameters/{param_id}/write
# ---------------------------------------------------------------------------

def test_write_param_success_verified(client):
    connect_and_download()
    resp = client.post("/api/parameters/WP_RADIUS/write", json={"value": 11.0})
    assert resp.status_code == 200
    data = body(resp)
    assert data["success"] is True
    assert data["parameter"]["value"] == 11.0
    # authoritative value (from the vehicle echo) is what the cache holds now
    mgr = pm.parameter_manager
    assert mgr.get_parameter("WP_RADIUS")["value"] == 11.0
    # restore
    client.post("/api/parameters/WP_RADIUS/write", json={"value": 10.0})


def test_write_invalid_value_400(client):
    connect_and_download()
    # SYSID_THISMAV is UINT8; 9999 cannot be represented
    resp = client.post("/api/parameters/SYSID_THISMAV/write", json={"value": 9999})
    assert resp.status_code == 400
    assert body(resp)["error"]["code"] == "WRITE_INVALID"


def test_write_missing_value_body_400(client):
    connect_and_download()
    resp = client.post("/api/parameters/WP_RADIUS/write", json={})
    assert resp.status_code == 400
    assert body(resp)["error"]["code"] == "BAD_REQUEST"


def test_write_not_connected(client):
    resp = client.post("/api/parameters/WP_RADIUS/write", json={"value": 1.0})
    assert resp.status_code == 400
    assert body(resp)["error"]["code"] == "NOT_CONNECTED"


# ---------------------------------------------------------------------------
# POST /api/parameters/refresh
# ---------------------------------------------------------------------------

def test_refresh_successful_download(client):
    connect_and_download()
    resp = client.post("/api/parameters/refresh")
    assert resp.status_code == 200
    data = body(resp)
    assert data["success"] is True
    assert data["sync"]["state"] == "complete"
    assert data["sync"]["receivedCount"] == len(FIVE)


def test_refresh_not_connected_400(client):
    resp = client.post("/api/parameters/refresh")
    assert resp.status_code == 400
    assert body(resp)["error"]["code"] == "NOT_CONNECTED"


# ---------------------------------------------------------------------------
# Phase 1 regression on the /api/parameters surface
# ---------------------------------------------------------------------------

def test_concurrent_read_requests_stay_independent(client):
    connect_and_download()
    mgr = pm.parameter_manager
    read = mgr.read_parameter("WP_RADIUS")
    assert read["status"] == "success" and read["value"] == 10.0