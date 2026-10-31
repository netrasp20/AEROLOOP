"""Phase 8B — Frame / Airframe backend behavior.

Focused backend tests for the ArduCopter Frame setup surface. These cover
only the paths the SETUP → Frame / Airframe page relies on; the general
parameter read/write/metadata machinery is already covered in Phases 2/4/5.

Coverage:
  * FRAME_CLASS / FRAME_TYPE live read (GET + verified POST /read)
  * FRAME_CLASS metadata decoding (enum values + rebootRequired)
  * parameter absence -> PARAM_NOT_FOUND (not fabricated)
  * invalid enum staged write rejected before any MAVLink PARAM_SET
  * two-parameter verified write: sequential order, PARAM_VALUE echo verified
  * first-write failure stops the batch (second not attempted)
  * reconnect: fresh value observed after session restart + re-download
"""

import pytest
from fastapi.testclient import TestClient

from app import app
from core.state import vehicle_state
from mavlink import parameter_manager as pm
from services import parameter_service as ps
from services.parameter_metadata import metadata_provider

from tests.test_parameter_manager import (
    FAKE_VEHICLE_PARAMS,
    FAST_CONFIG,
    FakeMsg,
    FakeVehicle,
    make_vehicle,
)

FRAME_PARAMS = {
    "FRAME_CLASS": (1.0, pm.MAV_PARAM_TYPE_UINT8),
    "FRAME_TYPE": (1.0, pm.MAV_PARAM_TYPE_UINT8),
}

FRAME_METADATA = {
    "FRAME_CLASS": {
        "values": {
            "0": "Undefined",
            "1": "Quad",
            "2": "Hexa",
            "3": "Octa",
            "4": "OctaQuad",
            "5": "Y6",
            "8": "SingleCopter",
            "9": "CoaxCopter",
        },
        "readOnly": False,
        "rebootRequired": True,
        "user": "Standard",
    },
    "FRAME_TYPE": {
        "values": {"0": "Plus", "1": "X", "2": "V"},
        "readOnly": False,
        "rebootRequired": True,
        "user": "Standard",
    },
}


@pytest.fixture()
def mgr():
    m = pm.parameter_manager
    m._config.update(FAST_CONFIG)
    yield m
    try:
        m.stop_session("setup frame teardown")
    except Exception:  # noqa: BLE001
        pass


@pytest.fixture()
def client(mgr):
    yield TestClient(app)


def connect_and_download(mgr, params=None):
    params = params or {**FAKE_VEHICLE_PARAMS, **FRAME_PARAMS}
    vehicle_state["vehicleType"] = "QUADROTOR"
    vehicle = make_vehicle(mgr, params=params)
    mgr.start_session()
    result = mgr.request_all_parameters()
    assert result["status"] == "success"
    return vehicle


def staged(param_id, value, original_value):
    return {"paramId": param_id, "value": value, "originalValue": original_value}


def _patch_frame_metadata(monkeypatch):
    """Route FRAME_CLASS/FRAME_TYPE metadata lookups to the authoritative map."""
    monkeypatch.setattr(
        metadata_provider, "lookup",
        lambda param_id, vehicle_key: FRAME_METADATA.get(param_id),
    )


def _patch_frame_metadata_unknown(monkeypatch):
    """No official definition at all -> truly unknown parameter."""
    monkeypatch.setattr(metadata_provider, "lookup", lambda param_id, vehicle_key: None)


# ---------------------------------------------------------------------------
# Read current values
# ---------------------------------------------------------------------------

class TestFrameRead:
    def test_get_current_frame_class_and_type(self, mgr, client, monkeypatch):
        """GET /api/parameters/FRAME_CLASS and FRAME_TYPE return live values."""
        connect_and_download(mgr)
        _patch_frame_metadata(monkeypatch)

        r = client.get("/api/parameters/FRAME_CLASS")
        assert r.status_code == 200
        param = r.json()["parameter"]
        assert param["live"]["value"] == 1.0

        r = client.get("/api/parameters/FRAME_TYPE")
        param = r.json()["parameter"]
        assert param["live"]["value"] == 1.0

    def test_verified_read_returns_vehicle_echo(self, mgr, client, monkeypatch):
        """POST /read performs a blocking verified read of FRAME_CLASS."""
        connect_and_download(mgr)
        _patch_frame_metadata(monkeypatch)

        r = client.post("/api/parameters/FRAME_CLASS/read", json={})
        assert r.status_code == 200
        data = r.json()
        assert data["success"] is True
        assert data["parameter"]["value"] == 1.0

    def test_param_absent_returns_not_found(self, mgr, client, monkeypatch):
        """No FRAME_CLASS on the firmware -> PARAM_NOT_FOUND, never fabricated."""
        connect_and_download(mgr, params={**FAKE_VEHICLE_PARAMS, "FRAME_TYPE": (1.0, pm.MAV_PARAM_TYPE_UINT8)})
        _patch_frame_metadata_unknown(monkeypatch)

        r = client.get("/api/parameters/FRAME_CLASS")
        assert r.status_code == 404
        assert r.json()["error"]["code"] == ps.ERROR_PARAM_NOT_FOUND

    def test_param_absent_with_official_definition_returns_live_none(self, mgr, client, monkeypatch):
        """Firmware omits FRAME_CLASS but an official definition exists.

        The page shows an 'not exposed on this firmware' field rather than an
        error, so the API reports the live value as None.
        """
        connect_and_download(mgr, params={**FAKE_VEHICLE_PARAMS, "FRAME_TYPE": (1.0, pm.MAV_PARAM_TYPE_UINT8)})
        _patch_frame_metadata(monkeypatch)

        r = client.get("/api/parameters/FRAME_CLASS")
        assert r.status_code == 200
        assert r.json()["parameter"]["live"] is None


# ---------------------------------------------------------------------------
# Metadata decoding
# ---------------------------------------------------------------------------

class TestFrameMetadata:
    def test_frame_metadata_decodes_enum_and_reboot(self, mgr, client, monkeypatch):
        """FRAME_CLASS metadata exposes real enum labels + rebootRequired."""
        connect_and_download(mgr)
        _patch_frame_metadata(monkeypatch)

        r = client.get("/api/parameters/FRAME_CLASS/metadata")
        assert r.status_code == 200
        meta = r.json()["metadata"]
        values = meta["values"]
        assert values["4"] == "OctaQuad"
        assert values["9"] == "CoaxCopter"
        assert meta["rebootRequired"] is True

    def test_frame_type_metadata(self, mgr, client, monkeypatch):
        """FRAME_TYPE metadata exposes supported layouts (X/Plus/V...)."""
        connect_and_download(mgr)
        _patch_frame_metadata(monkeypatch)

        r = client.get("/api/parameters/FRAME_TYPE/metadata")
        assert r.status_code == 200
        values = r.json()["metadata"]["values"]
        assert values["0"] == "Plus"
        assert values["1"] == "X"
        assert values["2"] == "V"


# ---------------------------------------------------------------------------
# Staged write: pre-flight rejection
# ---------------------------------------------------------------------------

class TestFrameWriteRejections:
    def test_invalid_enum_rejected_before_any_param_set(self, mgr, client, monkeypatch):
        """A FRAME_CLASS value outside the enum is rejected pre-flight."""
        vehicle = connect_and_download(mgr)
        _patch_frame_metadata(monkeypatch)
        sets_before = len([c for c in vehicle.calls if c[0] == "param_set"])

        r = client.post("/api/parameters/write", json={
            "items": [staged("FRAME_CLASS", 99.0, 1.0)]
        })
        assert r.status_code == 400
        assert r.json()["items"][0]["code"] == "INVALID_ENUM"
        sets_after = len([c for c in vehicle.calls if c[0] == "param_set"])
        assert sets_after == sets_before  # nothing sent to the vehicle


# ---------------------------------------------------------------------------
# Two-parameter sequential verified write
# ---------------------------------------------------------------------------

class TestFrameSequentialWrite:
    def test_class_and_type_written_sequentially_and_verified(self, mgr, client, monkeypatch):
        """FRAME_CLASS then FRAME_TYPE, each verified by the vehicle echo."""
        vehicle = connect_and_download(mgr)
        _patch_frame_metadata(monkeypatch)

        r = client.post("/api/parameters/write", json={
            "items": [
                staged("FRAME_CLASS", 2.0, 1.0),
                staged("FRAME_TYPE", 0.0, 1.0),
            ]
        })
        assert r.status_code == 200
        txn = r.json()["transaction"]
        assert txn["status"] == "success"
        assert txn["succeeded"] == 2

        # Order: FRAME_CLASS first, FRAME_TYPE second.
        sets = [c[1]["param_id"] for c in vehicle.calls if c[0] == "param_set"]
        assert sets[0] == "FRAME_CLASS"
        assert sets[1] == "FRAME_TYPE"

        # Both results verified with the vehicle's echoed values.
        results = {x["paramId"]: x for x in txn["results"]}
        assert results["FRAME_CLASS"]["verifiedValue"] == 2.0
        assert results["FRAME_TYPE"]["verifiedValue"] == 0.0

        # Live cache reflects the new values.
        assert mgr.get_parameter("FRAME_CLASS")["value"] == 2.0
        assert mgr.get_parameter("FRAME_TYPE")["value"] == 0.0

    def test_first_failure_stops_batch_second_not_attempted(self, mgr, client, monkeypatch):
        """FRAME_CLASS write fails -> FRAME_TYPE not attempted, no false success."""
        vehicle = connect_and_download(mgr)
        _patch_frame_metadata(monkeypatch)
        orig_send = vehicle.sender

        def mismatch_sender(kind, fields):
            if kind == "param_set" and fields["param_id"] == "FRAME_CLASS":
                mgr.handle_param_value(FakeMsg("FRAME_CLASS", 99.0, pm.MAV_PARAM_TYPE_UINT8, 7, 0))
                return
            orig_send(kind, fields)

        mgr._sender = mismatch_sender

        r = client.post("/api/parameters/write", json={
            "items": [
                staged("FRAME_CLASS", 2.0, 1.0),
                staged("FRAME_TYPE", 0.0, 1.0),
            ]
        })
        data = r.json()["transaction"]
        assert data["status"] == "partial_failure"
        results = {x["paramId"]: x for x in data["results"]}
        assert results["FRAME_CLASS"]["status"] == "failed"
        assert results["FRAME_TYPE"]["status"] == "not_attempted"
        mgr._sender = orig_send


# ---------------------------------------------------------------------------
# Reconnect
# ---------------------------------------------------------------------------

class TestFrameReconnect:
    def test_reload_observes_changed_vehicle_value(self, mgr, client, monkeypatch):
        """After disconnect + reload, FRAME_CLASS reads the fresh vehicle value."""
        vehicle = connect_and_download(mgr)
        _patch_frame_metadata(monkeypatch)

        r = client.get("/api/parameters/FRAME_CLASS")
        assert r.json()["parameter"]["live"]["value"] == 1.0

        # The vehicle value changes remotely (e.g. other GCS).
        vehicle.params["FRAME_CLASS"] = (4.0, pm.MAV_PARAM_TYPE_UINT8)

        # Session restart -> full re-download.
        mgr.stop_session("simulated reconnect")
        make_vehicle(mgr, params=vehicle.params)
        mgr.start_session()
        assert mgr.request_all_parameters()["status"] == "success"

        r = client.get("/api/parameters/FRAME_CLASS")
        assert r.status_code == 200
        assert r.json()["parameter"]["live"]["value"] == 4.0


# ---------------------------------------------------------------------------
# Unsupported firmware
# ---------------------------------------------------------------------------

class TestFrameUnsupported:
    def test_missing_both_frame_params_read_not_found(self, mgr, client, monkeypatch):
        """Unknown firmware with neither FRAME_CLASS nor FRAME_TYPE."""
        connect_and_download(mgr, params={**FAKE_VEHICLE_PARAMS})
        _patch_frame_metadata_unknown(monkeypatch)

        for pid in ("FRAME_CLASS", "FRAME_TYPE"):
            r = client.get(f"/api/parameters/{pid}")
            assert r.status_code == 404
            assert r.json()["error"]["code"] == ps.ERROR_PARAM_NOT_FOUND

    def test_both_absent_with_definitions_reports_live_none(self, mgr, client, monkeypatch):
        """Feature-off firmware; official definitions exist -> live None."""
        connect_and_download(mgr, params={**FAKE_VEHICLE_PARAMS})
        _patch_frame_metadata(monkeypatch)

        for pid in ("FRAME_CLASS", "FRAME_TYPE"):
            r = client.get(f"/api/parameters/{pid}")
            assert r.status_code == 200
            assert r.json()["parameter"]["live"] is None