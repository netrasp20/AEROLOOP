"""Phase 6 API tests for /api/parameters file/preset/reset routes.

Uses FastAPI's TestClient against the real router. Reset state-machine
behaviour is driven by swapping the global reset manager deps (deterministic
without hardware); file/preset endpoints are exercised against the envelope
(with the live SITL answering when this environment has one connected), plus
the route-ordering guard proving the static Phase 6 routes shadow the dynamic
``/{param_id}`` route.
"""

import time

import pytest
from fastapi.testclient import TestClient

from mavlink import parameter_manager as pm
from services.parameter_reset import (
    CODE_RESET_ACTIVE,
    ParameterResetManager,
)

from app import app as fastapi_app  # noqa: E402  (app imports the router)


@pytest.fixture()
def client():
    with TestClient(fastapi_app) as c:
        yield c


def _happy_deps():
    """Success-path reset dependencies (2 of 3 params change after reset)."""
    snapshot = [
        {"id": "WP_RADIUS", "value": 5.0, "type": pm.MAV_PARAM_TYPE_REAL32},
        {"id": "CRUISE_SPEED", "value": 1.5, "type": pm.MAV_PARAM_TYPE_REAL32},
        {"id": "SYSID_THISMAV", "value": 1.0, "type": pm.MAV_PARAM_TYPE_UINT8},
    ]
    backup = {"WP_RADIUS": 10.0, "CRUISE_SPEED": 2.5, "SYSID_THISMAV": 1.0}
    deps = {
        "connected": lambda: True,
        "backup": lambda: dict(backup),
        "send_command": lambda command, params: {
            "success": True, "ackCode": 0, "ackLabel": "ACCEPTED",
            "message": "Command accepted."},
        "wait_link_down": lambda timeout: True,
        "reconnect": lambda: (True, "Reconnected"),
        "sync": lambda: {"status": pm.RESULT_SUCCESS, "syncState": "complete",
                         "receivedCount": 3, "expectedCount": 3},
        "snapshot": lambda: [dict(e) for e in snapshot],
    }
    return deps


def _install_reset_manager(monkeypatch, **overrides):
    deps = _happy_deps()
    deps.update(overrides)
    manager = ParameterResetManager(deps=deps, step_delay_s=0.001)
    monkeypatch.setattr("api.parameters.parameter_reset_manager", manager)
    return manager


def _wait_status(client, state, timeout=5.0):
    deadline = time.monotonic() + timeout
    body = client.get("/api/parameters/reset/status").json()
    while time.monotonic() < deadline:
        if body.get("state") == state:
            return body
        time.sleep(0.01)
        body = client.get("/api/parameters/reset/status").json()
    return body


# ---------------------------------------------------------------------------
# Route-ordering guard (static routes must NOT hit /{param_id})
# ---------------------------------------------------------------------------

def test_export_route_is_not_the_dynamic_param_route(client):
    resp = client.get("/api/parameters/export", params={"source": "vehicle"})
    body = resp.json()
    if body.get("error", {}).get("code") == "NOT_CONNECTED":
        assert resp.status_code == 400
        assert body["success"] is False
    else:
        assert body["success"] is True
        assert body["content"].startswith("#")


def test_reset_status_route_registered(client):
    resp = client.get("/api/parameters/reset/status")
    assert resp.status_code == 200
    body = resp.json()
    assert body["success"] is True
    assert "active" in body
    assert "state" in body


def test_presets_route_registered(client):
    resp = client.get("/api/parameters/presets")
    assert resp.status_code == 200
    body = resp.json()
    assert body["success"] is True
    assert isinstance(body["presets"], list)
    ids = {p["id"] for p in body["presets"]}
    assert "rover_baseline" in ids


# ---------------------------------------------------------------------------
# File endpoints — envelope + stable error contract
# ---------------------------------------------------------------------------

def test_compare_requires_content(client):
    resp = client.post("/api/parameters/compare", json={})
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "BAD_REQUEST"


def test_compare_rejects_non_object_staged(client):
    resp = client.post("/api/parameters/compare",
                       json={"content": "WP_RADIUS,2\n", "staged": [1, 2]})
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "BAD_REQUEST"


def test_import_responds_with_parse_report(client):
    resp = client.post("/api/parameters/import",
                       json={"content": "WP_RADIUS,2\n", "filename": "t.param"})
    body = resp.json()
    if body.get("error", {}).get("code") == "NOT_CONNECTED":
        assert resp.status_code == 400
        assert body["success"] is False
    else:
        assert body["success"] is True
        assert body["parse"]["valid"] >= 1
        assert "compare" in body


def test_import_rejects_missing_content(client):
    resp = client.post("/api/parameters/import", json={"filename": "t.param"})
    assert resp.json()["error"]["code"] == "BAD_REQUEST"

    resp = client.post("/api/parameters/import", json={"content": None})
    assert resp.json()["error"]["code"] == "BAD_REQUEST"


# ---------------------------------------------------------------------------
# Preset endpoints
# ---------------------------------------------------------------------------

def test_preset_analyze_unknown_preset(client):
    resp = client.post("/api/parameters/presets/no_such_preset/analyze", json={})
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "PRESET_NOT_FOUND"


def test_preset_analyze_vehicle_type_mismatch(client):
    from core.state import vehicle_state

    vehicle_state["vehicleType"] = "QUADROTOR"
    resp = client.post("/api/parameters/presets/rover_baseline/analyze", json={})
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "VEHICLE_TYPE_MISMATCH"
    vehicle_state["vehicleType"] = "QUADROTOR"


# ---------------------------------------------------------------------------
# Reset API (injected deps -> deterministic)
# ---------------------------------------------------------------------------

def test_reset_requires_confirmation(client, monkeypatch):
    _install_reset_manager(monkeypatch)
    resp = client.post("/api/parameters/reset", json={})
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "BAD_REQUEST"


def test_reset_full_flow_via_api(client, monkeypatch):
    _install_reset_manager(monkeypatch)
    resp = client.post("/api/parameters/reset", json={"confirm": True})
    assert resp.status_code == 200
    assert resp.json()["success"] is True

    body = _wait_status(client, "complete")
    assert body["active"] is False
    summary = body["summary"]
    assert summary["backupCount"] == 3
    assert summary["parameterCount"] == 3
    assert summary["changedCount"] == 2
    assert set(summary["changedParams"]) == {"WP_RADIUS", "CRUISE_SPEED"}
    assert body["error"] is None


def test_reset_blocks_or_repeats_after_terminal(client, monkeypatch):
    _install_reset_manager(monkeypatch)
    client.post("/api/parameters/reset", json={"confirm": True})
    resp = client.post("/api/parameters/reset", json={"confirm": True})
    body = resp.json()
    if body.get("error", {}).get("code") == CODE_RESET_ACTIVE:
        assert resp.status_code == 423
    else:
        assert resp.json().get("success") is True


def test_reset_worker_failure_reports_clean_status(client, monkeypatch):
    def boom():
        raise RuntimeError("transport exploded")

    _install_reset_manager(monkeypatch, backup=boom)
    resp = client.post("/api/parameters/reset", json={"confirm": True})
    assert resp.status_code == 200
    body = _wait_status(client, "failed")
    assert body["error"]["code"] == "RESET_FAILED"
    assert body["active"] is False


def test_reset_rejected_when_not_connected(client, monkeypatch):
    _install_reset_manager(monkeypatch, connected=lambda: False)
    resp = client.post("/api/parameters/reset", json={"confirm": True})
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "NOT_CONNECTED"