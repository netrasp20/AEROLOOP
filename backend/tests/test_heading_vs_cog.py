"""Regression tests for vehicle heading vs GPS course-over-ground (Phase 8J).

Defect found during the Phase 8J end-to-end audit: while connected to a real
ArduCopter SITL, `telemetry["heading"]` read 0.0 deg even though the vehicle's
ATTITUDE.yaw was non-zero. Cause: `handle_gps_raw_int` published
`GPS_RAW_INT.cog` (course over ground) into the `heading` field. COG is the
direction of travel, not the direction the vehicle is pointing, and it is 0
whenever the vehicle is stationary — so it overwrote the true heading on every
GPS update and the DATA heading card plus the HUD heading tape read 0 while
sitting on the ground.

These tests pin the corrected contract:
- GPS_RAW_INT must never modify `heading`.
- ATTITUDE.yaw is published as `heading` in degrees, normalised to 0..360.
- GLOBAL_POSITION_INT / VFR_HUD headings still win when they arrive.
"""

import math

import pytest

from core.state import telemetry
from mavlink import telemetry_manager as tm


class FakeMsg:
    def __init__(self, **kw):
        self.__dict__.update(kw)


@pytest.fixture(autouse=True)
def _clean_state():
    from core.state import reset_telemetry

    snapshot = dict(telemetry)
    tm._gps_raw_counter = 0
    try:
        yield
    finally:
        telemetry.clear()
        telemetry.update(snapshot)


def test_gps_raw_int_does_not_overwrite_heading_with_cog():
    """The core defect: a stationary vehicle reported COG 0 and lost its heading."""
    telemetry["heading"] = 217.4

    tm.handle_gps_raw_int(
        FakeMsg(lat=353632621, lon=1491652375, cog=0, alt=584090,
                fix_type=6, satellites_visible=10, eph=121)
    )

    assert telemetry["heading"] == 217.4, (
        "GPS_RAW_INT must not publish course-over-ground as vehicle heading"
    )
    # the rest of the GPS_RAW_INT payload is still applied
    assert telemetry["gpsFix"] == 6
    assert telemetry["satellites"] == 10
    assert abs(telemetry["hdop"] - 1.21) < 0.01


def test_gps_raw_int_moves_position_but_never_sets_heading_from_cog():
    """Even a non-zero COG must not become heading."""
    telemetry["heading"] = 90.0

    tm.handle_gps_raw_int(
        FakeMsg(lat=353632621, lon=1491652375, cog=27500, alt=584090,
                fix_type=3, satellites_visible=9, eph=100)
    )

    assert telemetry["heading"] == 90.0
    assert telemetry["satellites"] == 9


def test_attitude_publishes_real_heading_from_yaw():
    """ATTITUDE.yaw (rad) is the true heading and must reach the UI."""
    telemetry["heading"] = 0.0

    tm.handle_attitude(FakeMsg(roll=0.01, pitch=-0.02, yaw=-0.1259))

    assert abs(telemetry["heading"] - 352.79) < 0.05
    assert abs(telemetry["yaw"] - -0.1259) < 1e-9


def test_attitude_heading_is_normalised_to_0_360():
    telemetry["heading"] = 0.0
    tm.handle_attitude(FakeMsg(roll=0.0, pitch=0.0, yaw=math.pi))
    assert abs(telemetry["heading"] - 180.0) < 1e-6

    tm.handle_attitude(FakeMsg(roll=0.0, pitch=0.0, yaw=-math.pi / 2))
    assert abs(telemetry["heading"] - 270.0) < 1e-6


def test_stationary_sitl_heading_survives_repeated_gps_updates():
    """Regression scenario: GPS_RAW_INT streams at 10 Hz over a static vehicle."""
    telemetry["heading"] = 0.0
    for _ in range(50):
        tm.handle_attitude(FakeMsg(roll=0.0, pitch=0.0, yaw=-0.1259))
        tm.handle_gps_raw_int(
            FakeMsg(lat=353632621, lon=1491652375, cog=0, alt=584090,
                    fix_type=6, satellites_visible=10, eph=121)
        )
    assert abs(telemetry["heading"] - 352.79) < 0.05
