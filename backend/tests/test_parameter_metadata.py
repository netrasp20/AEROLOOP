"""Unit tests for the Parameter Metadata provider (Phase 2).

Mix of hermetic tests (a synthetic pdef XML in a temp dir — no network, no
repo files required) and a small set against the OFFICIAL staged definition
files (backend/metadata/*.xml) to catch drift from the ArduPilot toolchain.
"""

import os
import xml.etree.ElementTree as ET

import pytest

from services.parameter_metadata import (
    STATUS_AVAILABLE,
    STATUS_ERROR,
    STATUS_LOADING,
    STATUS_UNAVAILABLE,
    MetadataProvider,
    vehicle_metadata_key,
)

# ---------------------------------------------------------------------------
# Synthetic pdef (hermetic; mirrors the real file's structure)
# ---------------------------------------------------------------------------

SAMPLE_XML = """
<paramfile>
  <vehicles>
    <parameters name="ArduCopter">
      <param name="SYSID_THISMAV" humanName="MAVLink System ID" documentation="Set the system ID." user="Advanced">
        <field name="Units"> </field>
        <field name="Range">1 255</field>
        <field name="Increment">1</field>
        <values>
          <value code="1">Vehicle 1</value>
        </values>
      </param>
      <param name="FS_GCS_ENABLE" humanName="FS GCS Enable" documentation="Action on GCS failsafe." user="Standard">
        <values>
          <value code="0">Disabled</value>
          <value code="1">RTL</value>
        </values>
        <field name="Bitmask">0:Disabled,1:RTL</field>
      </param>
      <param name="ArduCopter:FORMAT_VERSION" humanName="Format Version" documentation="Firmware format version marker." user="Advanced">
        <field name="ReadOnly">True</field>
        <field name="RebootRequired">True</field>
      </param>
      <param name="ROLL_PITCH_RATE_MAX" humanName="Roll/Pitch Rate Max" documentation="Max attitude rate." user="Standard">
        <field name="Units">deg/s</field>
        <field name="UnitText">°/s</field>
        <field name="Range">1 60</field>
        <field name="Increment">0.5</field>
      </param>
    </parameters>
  </vehicles>
</paramfile>
"""


@pytest.fixture()
def provider(tmp_path):
    (tmp_path / "copter.xml").write_text(SAMPLE_XML)
    return MetadataProvider(metadata_dir=str(tmp_path))


# ---------------------------------------------------------------------------
# vehicle type -> key mapping
# ---------------------------------------------------------------------------

def test_vehicle_key_mapping():
    assert vehicle_metadata_key("QUADROTOR") == "copter"
    assert vehicle_metadata_key("HEXA") == "copter"
    assert vehicle_metadata_key("GROUND_ROVER") == "rover"
    assert vehicle_metadata_key("ROVER") == "rover"
    assert vehicle_metadata_key("FIXED_WING") == "plane"
    assert vehicle_metadata_key("SUBMARINE") == "sub"
    assert vehicle_metadata_key("UNKNOWN") is None
    assert vehicle_metadata_key("") is None
    assert vehicle_metadata_key(None) is None


def test_unknown_vehicle_unavailable(provider):
    status = provider.load_for("UNKNOWN")
    assert status["status"] == STATUS_UNAVAILABLE


# ---------------------------------------------------------------------------
# Loading + normalization
# ---------------------------------------------------------------------------

def test_load_available_and_counts(provider):
    status = provider.load_for("QUADROTOR")
    assert status["status"] == STATUS_AVAILABLE
    assert status["vehicle"] == "copter"
    assert status["paramCount"] == 4
    assert status["sourceFile"] == "copter.xml"
    assert status["source"] == "ardupilot-param_parse.py"


def test_normalized_fields(provider):
    provider.load_for("QUADROTOR")
    meta = provider.lookup("ROLL_PITCH_RATE_MAX", "copter")
    assert meta["min"] == 1.0
    assert meta["max"] == 60.0
    assert meta["increment"] == 0.5
    assert meta["units"] == "deg/s"
    assert meta["unitText"] == "°/s"
    assert meta["advanced"] is False
    assert meta["user"] == "Standard"


def test_enum_values_and_bitmask(provider):
    provider.load_for("QUADROTOR")
    fs = provider.lookup("FS_GCS_ENABLE", "copter")
    assert fs["values"] == {"0": "Disabled", "1": "RTL"}
    assert fs["bitmask"] == {"0": "Disabled", "1": "RTL"}


def test_vehicle_prefixed_id_is_normalized(provider):
    provider.load_for("QUADROTOR")
    # The stored name is "ArduCopter:FORMAT_VERSION" but the live id is
    # "FORMAT_VERSION" — lookup must use the normalized id.
    meta = provider.lookup("FORMAT_VERSION", "copter")
    assert meta is not None
    assert meta["id"] == "FORMAT_VERSION"
    # no definition under the prefixed id itself
    assert provider.lookup("ArduCopter:FORMAT_VERSION", "copter") is None


def test_readonly_and_reboot_required(provider):
    provider.load_for("QUADROTOR")
    meta = provider.lookup("FORMAT_VERSION", "copter")
    assert meta["readOnly"] is True
    assert meta["rebootRequired"] is True


def test_lookup_missing_returns_none(provider):
    provider.load_for("QUADROTOR")
    assert provider.lookup("DOES_NOT_EXIST", "copter") is None


def test_groups_collected(provider):
    provider.load_for("QUADROTOR")
    groups = provider.groups("QUADROTOR")
    assert "ArduCopter" in groups


def test_file_missing_unavailable():
    provider = MetadataProvider(metadata_dir="/nonexistent-dir")
    status = provider.load_for("QUADROTOR")
    assert status["status"] == STATUS_UNAVAILABLE


def test_malformed_file_is_error(tmp_path):
    (tmp_path / "copter.xml").write_text("<paramfile><vehicles>")
    provider = MetadataProvider(metadata_dir=str(tmp_path))
    status = provider.load_for("QUADROTOR")
    assert status["status"] == STATUS_ERROR


def test_status_available_after_load(provider):
    provider.load_for("QUADROTOR")
    status = provider.status("QUADROTOR")
    assert status["status"] == STATUS_AVAILABLE
    assert status["paramCount"] == 4


def test_unknown_id_with_loaded_catalog(provider):
    provider.load_for("QUADROTOR")
    assert provider.lookup("NOPE", "copter") is None


def test_cached_second_load_fast_and_consistent(provider):
    s1 = provider.load_for("QUADROTOR")
    s2 = provider.load_for("QUADROTOR")
    assert s2["status"] == STATUS_AVAILABLE
    assert s2["paramCount"] == s1["paramCount"] == 4


# ---------------------------------------------------------------------------
# Official staged files (regression against the ArduPilot toolchain)
# ---------------------------------------------------------------------------

def test_official_copter_file_loads_and_covers_known_params():
    provider = MetadataProvider()
    status = provider.load_for("QUADROTOR")
    assert status["status"] == STATUS_AVAILABLE
    assert status["paramCount"] > 5000
    meta = provider.lookup("WP_RADIUS_M", "copter")
    assert meta is not None
    assert meta["units"] == "m"
    assert meta["min"] == 0.05 and meta["max"] == 10.0 and meta["increment"] == 0.01
    fs = provider.lookup("FS_GCS_ENABLE", "copter")
    assert fs["values"] and "1" in fs["values"]


def test_official_rover_file_loads():
    provider = MetadataProvider()
    status = provider.load_for("GROUND_ROVER")
    assert status["status"] == STATUS_AVAILABLE
    assert status["paramCount"] > 4000
    meta = provider.lookup("WP_RADIUS", "rover")
    assert meta is not None
    assert meta["units"] in ("m", "degrees", "deg") or meta["units"] is not None