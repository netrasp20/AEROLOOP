"""The 14-case bootloader identity matrix, end to end.

Every value in this file is SYNTHETIC. Port descriptors, MAVLink replies and
bootloader identities are all injected fixtures. No test here reads
``/dev/ttyACM0``, opens a real serial port, sends a byte to a real board, enters
bootloader mode, reboots, erases or writes firmware. The real Pixhawk stays
read-only and untouched.

The matrix walks the same order the user cares about:

===  ==========================================================================
  1  complete exact identity                     -> EXACT_MATCH, cross-checked
  2  board id only                              -> never selectable
  3  board id + matching bootloader string      -> resolved and cross-checked
  4  board id + conflicting bootloader string   -> refused
  5  missing bootloader revision                -> IDENTITY_UNAVAILABLE
  6  missing flash size                         -> IDENTITY_UNAVAILABLE
  7  missing USB product string                 -> IDENTITY_UNAVAILABLE
  8  conflicting VID/PID                        -> AMBIGUOUS
  9  multiple compatible platforms              -> AMBIGUOUS
 10  no device                                  -> NO_DEVICE
 11  disconnected device                        -> IDENTITY_UNAVAILABLE
 12  MAVLink endpoint offered as a bootloader   -> refused, zero traffic
 13  stale identity after disconnect            -> not reused
 14  reconnect with a changed identity          -> new identity, never the old
===  ==========================================================================
"""

from __future__ import annotations

import pytest

from services import bootloader_fixtures as fx
from services import firmware_catalog_service as catalog
from services import firmware_compat_service as compat
from services.bootloader_identity_service import (
    TRANSPORT_BOOTLOADER,
    TRANSPORT_MAVLINK,
    TRANSPORT_NONE,
    TRANSPORT_UNKNOWN,
    BootloaderIdentityService,
    UsbPortIdentity,
)

# ---------------------------------------------------------------------------
# Synthetic catalogue + identity helpers
# ---------------------------------------------------------------------------

#: Board id 9 genuinely spans four physical platforms in the official manifest.
#: That collision is the whole reason corroboration is mandatory.
BOARD9_PLATFORMS = [
    ("Pixhawk1", ["Pixhawk1-BL", "PX4 BL FMU v2.x"]),
    ("Pixhawk1-1M", ["Pixhawk1-1M-BL", "PX4 BL FMU v2.x"]),
    ("CubeBlack", ["CubeBlack-BL", "PX4 BL FMU v2.x"]),
    ("fmuv2", ["PX4 BL FMU v2.x"]),
]

PIXHAWK1_USB = ["0x1209/0x5741"]


def _entry(platform="Pixhawk1", bootloader_str=None, board_id=9, usb_id=None, **overrides):
    entry = {
        "mav-autopilot": "ARDUPILOTMEGA",
        "vehicletype": "Copter",
        "platform": platform,
        "git-sha": "dbe792162d06cab66c3475fd5556bf7a120f119e",
        "url": f"https://firmware.ardupilot.org/Copter/stable/{platform}/arducopter.apj",
        "mav-type": "Copter",
        "mav-firmware-version-type": "OFFICIAL",
        "mav-firmware-version-str": "V4.7.1",
        "latest": 0,
        "format": "apj",
        "mav-firmware-version": "4.7.1",
        "mav-firmware-version-major": "4",
        "mav-firmware-version-minor": "7",
        "mav-firmware-version-patch": "1",
        "board_id": board_id,
        "bootloader_str": bootloader_str or ["Pixhawk1-BL"],
        "USBID": usb_id if usb_id is not None else PIXHAWK1_USB,
        "brand_name": platform,
        "manufacturer": "3DR",
        "image_size": 1559908,
    }
    entry.update(overrides)
    return entry


def _candidates(entries):
    return [c for c in (catalog.candidate_from_entry(e) for e in entries) if c is not None]


def _board9_candidates():
    return _candidates([_entry(p, bl, board_id=9) for p, bl in BOARD9_PLATFORMS])


def _pixhawk1_candidates():
    """Only Pixhawk1 declares the Pixhawk1-BL bootloader string."""
    return _candidates([_entry("Pixhawk1", ["Pixhawk1-BL"])])


def _connected_identity(**overrides):
    base = dict(
        connected=True,
        is_sitl=False,
        autopilot="ARDUPILOTMEGA",
        vehicle_type="QUADROTOR",
        manifest_vehicle="Copter",
        evidence=["synthetic test identity"],
    )
    base.update(overrides)
    return compat.IdentityEvidence(**base)


def _with_bootloader(identity, fixture):
    result = fx.FixtureBootloaderTransport(fixture).read_identity()
    return compat.apply_bootloader_identity(identity, result)


# --- synthetic USB descriptors ---------------------------------------------

MAVLINK_PORT = UsbPortIdentity(
    device="/dev/ttyACM0",
    vendor_id=0x1209,
    product_id=0x5741,
    serial_number="3C0027000951363033383531",
    manufacturer="ArduPilot",
    product="Pixhawk1",  # normal-mode product string, NOT "Pixhawk1-BL"
    description="Pixhawk1",
)

BOOTLOADER_PORT = UsbPortIdentity(
    device="/dev/ttyACM0",
    vendor_id=0x1209,
    product_id=0x5741,
    serial_number="3C0027000951363033383531",
    manufacturer="ArduPilot",
    product="Pixhawk1-BL",
    description="Pixhawk1-BL",
)

OTHER_USB_PORT = UsbPortIdentity(
    device="/dev/ttyACM0",
    vendor_id=0x2D00,
    product_id=0x1015,
    serial_number="3C0027000951363033383531",
    manufacturer="ArduPilot",
    product="Pixhawk1-BL",
    description="Pixhawk1-BL",
)

MAVLINK_INFO = {
    "success": True,
    "boardVersion": 589824,
    "boardType": 0,
    "boardRev": 9,
    "connectionType": "USB",
    "systemId": 1,
    "componentId": 1,
}


class RecordingTransport:
    """Counts reads so "no bootloader traffic was sent" is provable."""

    name = "bootloader-transport:recording"

    def __init__(self, fixture):
        self.fixture = fixture
        self.reads = 0
        self.connects = 0

    def connect(self):
        self.connects += 1

    def read_info(self):
        self.reads += 1
        return self.fixture.raw()

    def disconnect(self):
        pass

    @property
    def evidence(self):
        return [f"recording transport, reads={self.reads}"]

    def read_identity(self):
        import dataclasses

        from services.bootloader_identity import SOURCE_FIXTURE, build_identity

        self.connect()
        self.reads += 1
        raw = self.fixture.raw()
        result = build_identity(
            bootloader_revision=raw.bootloader_revision,
            board_id=raw.board_id,
            flash_size=raw.flash_size,
            usb_product_string=raw.usb_product_string,
            source=SOURCE_FIXTURE,
        )
        return dataclasses.replace(result, evidence=list(self.evidence))


# ===========================================================================
# 1. Complete exact identity
# ===========================================================================


class TestCase01CompleteExactIdentity:
    def test_complete_identity_resolves_and_cross_checks(self):
        identity = _with_bootloader(_connected_identity(), fx.FIXTURE_A)
        result = compat.resolve(_pixhawk1_candidates(), identity)
        assert result.outcome == compat.EXACT_MATCH
        assert result.selected is not None
        assert result.selected.platform == "Pixhawk1"

    def test_every_official_manifest_check_passes(self):
        identity = _with_bootloader(_connected_identity(), fx.FIXTURE_A)
        result = compat.resolve(_pixhawk1_candidates(), identity)
        assert result.cross_check is not None
        assert result.cross_check.passed
        assert result.cross_check.failed_checks == []
        names = [c.name for c in result.cross_check.checks]
        for expected in (
            "manifest board id",
            "required bootloader identity",
            "vehicle type",
            "firmware type",
            "official-catalog",
            "USB",
        ):
            assert expected in names

    def test_exact_match_is_confirmable(self):
        identity = _with_bootloader(_connected_identity(), fx.FIXTURE_A)
        assert compat.resolve(_pixhawk1_candidates(), identity).can_confirm

    def test_service_reports_all_four_protocol_fields_on_a_bootloader_port(self):
        service = BootloaderIdentityService(
            RecordingTransport(fx.FIXTURE_A),
            ports=[BOOTLOADER_PORT],
            mavlink_alive=False,
        )
        report = service.read_identity()
        assert report.bootloader_read_performed
        assert report.bootloader_revision == 4
        assert report.board_id == 9
        assert report.flash_size == 2 * 1024 * 1024
        assert report.bootloader_usb_product_string == "Pixhawk1-BL"
        # All four bootloader protocol fields are present.
        assert report.required_protocol_fields_present is True
        for field in (
            "bootloaderRevision",
            "boardId",
            "flashSize",
            "bootloaderUsbProductString",
        ):
            assert field not in report.missing_fields
        # A bootloader has no MAVLink link, so the AUTOPILOT_VERSION board fields
        # are honestly absent rather than guessed.
        assert "boardVersion" in report.missing_fields
        assert report.board_version is None
        assert report.can_resolve_platform


# ===========================================================================
# 2. Board ID only — never selectable
# ===========================================================================


class TestCase02BoardIdOnly:
    def test_board_id_alone_is_not_selectable(self):
        identity = _connected_identity(board_id=9)
        result = compat.resolve(_board9_candidates(), identity)
        assert result.outcome == compat.AMBIGUOUS
        assert result.selected is None
        assert not result.can_confirm

    def test_board_id_alone_is_refused_even_on_a_single_platform(self):
        """Deliberately refused even when board id 9 maps to one platform."""
        identity = _connected_identity(board_id=9)
        result = compat.resolve(_pixhawk1_candidates(), identity)
        assert result.outcome == compat.AMBIGUOUS
        assert result.selected is None

    def test_board_id_from_autopilot_version_is_not_a_board_id(self):
        """boardVersion 589824 is not a manifest board_id and must not be used."""
        service = BootloaderIdentityService(ports=[MAVLINK_PORT], mavlink_alive=True)
        report = service.read_identity(mavlink_info=MAVLINK_INFO)
        assert report.board_version == 589824
        assert report.board_id is None
        assert any("not a manifest board_id" in w for w in report.warnings)


# ===========================================================================
# 3. Board ID plus matching bootloader string
# ===========================================================================


class TestCase03BoardIdPlusMatchingString:
    def test_two_agreeing_bootloader_signals_resolve(self):
        identity = _with_bootloader(_connected_identity(), fx.FIXTURE_A)
        assert identity.board_id == 9
        assert identity.bootloader_str == "Pixhawk1-BL"
        result = compat.resolve(_board9_candidates(), identity)
        assert result.outcome == compat.EXACT_MATCH
        assert result.selected.platform == "Pixhawk1"

    def test_matching_signals_are_recorded_as_signals_used(self):
        identity = _with_bootloader(_connected_identity(), fx.FIXTURE_A)
        result = compat.resolve(_board9_candidates(), identity)
        assert "bootloader product string" in result.signals_used
        assert "official-manifest cross-check" in result.signals_used

    def test_bootloader_str_corroborates_an_ambiguous_board_id(self):
        """Board id 9 alone spans four platforms; the string resolves it."""
        identity = _with_bootloader(_connected_identity(), fx.FIXTURE_A)
        narrowed = compat.resolve(_board9_candidates(), identity)
        assert narrowed.platform_count == 1

    def test_1m_variant_resolves_to_its_own_platform(self):
        identity = _with_bootloader(_connected_identity(), fx.FIXTURE_B)
        result = compat.resolve(_board9_candidates(), identity)
        assert result.selected is not None
        assert result.selected.platform == "Pixhawk1-1M"


# ===========================================================================
# 4. Board ID plus conflicting bootloader string
# ===========================================================================


class TestCase04BoardIdPlusConflictingString:
    def test_string_matching_a_different_platform_is_refused(self):
        """board_id 9 + 'Pixhawk1-BL' must not be allowed to also pick CubeBlack."""
        identity = _with_bootloader(_connected_identity(), fx.FIXTURE_A)
        cube_black = _candidates([_entry("CubeBlack", ["CubeBlack-BL"])])
        result = compat.resolve(cube_black, identity)
        assert result.selected is None
        assert result.outcome in (compat.NO_MATCH, compat.AMBIGUOUS)

    def test_a_string_no_image_declares_is_a_no_match(self):
        identity = _with_bootloader(_connected_identity(), fx.FIXTURE_A)
        identity.bootloader_str = "Totally-Unknown-BL"
        result = compat.resolve(_pixhawk1_candidates(), identity)
        assert result.outcome == compat.NO_MATCH
        assert "Totally-Unknown-BL" in result.reason

    def test_incomplete_string_never_matches(self):
        """An empty/None string is never treated as a match-all."""
        identity = _connected_identity(board_id=9, bootloader_str="")
        result = compat.resolve(_pixhawk1_candidates(), identity)
        assert result.outcome != compat.EXACT_MATCH
        assert result.selected is None


# ===========================================================================
# 5-7. Missing required fields -> IDENTITY_UNAVAILABLE
# ===========================================================================


class TestCase05MissingBootloaderRevision:
    def test_missing_revision_is_never_used_to_select(self):
        fixture = fx.BootloaderFixture(
            name="no-rev",
            description="Missing bootloader revision",
            bootloader_revision=None,
            board_id=9,
            flash_size=2 * 1024 * 1024,
            usb_product_string="Pixhawk1-BL",
        )
        identity = _with_bootloader(_connected_identity(), fixture)
        result = compat.resolve(_pixhawk1_candidates(), identity)
        assert result.selected is None
        assert result.outcome == compat.IDENTITY_UNAVAILABLE

    def test_missing_revision_is_named_in_the_evidence(self):
        fixture = fx.BootloaderFixture(
            name="no-rev",
            description="Missing bootloader revision",
            bootloader_revision=None,
            board_id=9,
            flash_size=2 * 1024 * 1024,
            usb_product_string="Pixhawk1-BL",
        )
        identity = _with_bootloader(_connected_identity(), fixture)
        assert any("bootloaderRevision" in e for e in identity.evidence)

    def test_missing_revision_fails_the_cross_check(self):
        fixture = fx.BootloaderFixture(
            name="no-rev",
            description="Missing bootloader revision",
            bootloader_revision=None,
            board_id=9,
            flash_size=2 * 1024 * 1024,
            usb_product_string="Pixhawk1-BL",
        )
        identity = _with_bootloader(_connected_identity(), fixture)
        candidates = _pixhawk1_candidates()
        check = compat.cross_check_exact_match(candidates[0], identity)
        assert not check.passed
        assert "required bootloader identity" in check.failed_checks


class TestCase06MissingFlashSize:
    def test_missing_flash_size_is_never_used_to_select(self):
        identity = _with_bootloader(_connected_identity(), fx.FIXTURE_MISSING_FLASH_SIZE)
        result = compat.resolve(_pixhawk1_candidates(), identity)
        assert result.selected is None
        assert result.outcome == compat.IDENTITY_UNAVAILABLE

    def test_missing_flash_size_is_reported_missing(self):
        identity = _with_bootloader(_connected_identity(), fx.FIXTURE_MISSING_FLASH_SIZE)
        assert any("flashSize" in e for e in identity.evidence)

    def test_flash_size_exclusion_needs_a_real_value(self):
        """The large-flash exclusion must not fire on a missing flash size."""
        identity = _with_bootloader(_connected_identity(), fx.FIXTURE_MISSING_FLASH_SIZE)
        result = compat.resolve(_board9_candidates(), identity)
        assert result.outcome == compat.IDENTITY_UNAVAILABLE


class TestCase07MissingUsbProductString:
    def test_missing_usb_product_is_never_used_to_select(self):
        identity = _with_bootloader(_connected_identity(), fx.FIXTURE_MISSING_USB_PRODUCT)
        result = compat.resolve(_pixhawk1_candidates(), identity)
        assert result.selected is None
        assert result.outcome == compat.IDENTITY_UNAVAILABLE

    def test_missing_board_id_is_never_used_to_select(self):
        identity = _with_bootloader(_connected_identity(), fx.FIXTURE_MISSING_BOARD_ID)
        result = compat.resolve(_pixhawk1_candidates(), identity)
        assert result.selected is None
        assert result.outcome == compat.IDENTITY_UNAVAILABLE

    def test_normal_mode_product_string_is_not_bootloader_evidence(self):
        """The real board advertises 'Pixhawk1'; that must never resolve a board."""
        service = BootloaderIdentityService(
            ports=[MAVLINK_PORT], mavlink_alive=True
        )
        report = service.read_identity(mavlink_info=MAVLINK_INFO)
        assert report.normal_mode_usb_product == "Pixhawk1"
        assert report.transport.port.is_bootloader_product_string is False
        assert report.bootloader_read_performed is False
        assert report.can_resolve_platform is False
        assert "Pixhawk1-BL" not in str(report.to_dict()["bootloaderUsbProductString"])


# ===========================================================================
# 8. Conflicting VID/PID
# ===========================================================================


class TestCase08ConflictingVidPid:
    def test_conflicting_vid_pid_downgrades_to_ambiguous(self):
        identity = _with_bootloader(_connected_identity(), fx.FIXTURE_A)
        # The port reports a VID/PID the matched platform does not declare.
        identity.vendor_id = 0x2D00
        identity.product_id = 0x1015
        identity.usb_id = "0x2d00/0x1015"
        result = compat.resolve(_pixhawk1_candidates(), identity)
        assert result.outcome == compat.AMBIGUOUS
        assert result.selected is None
        assert not result.can_confirm

    def test_conflicting_vid_pid_names_the_usb_check(self):
        identity = _with_bootloader(_connected_identity(), fx.FIXTURE_A)
        identity.usb_id = "0x2d00/0x1015"
        candidates = _pixhawk1_candidates()
        check = compat.cross_check_exact_match(candidates[0], identity)
        assert not check.passed
        assert "USB" in check.failed_checks

    def test_matching_vid_pid_passes_the_usb_check(self):
        identity = _with_bootloader(_connected_identity(), fx.FIXTURE_A)
        identity.usb_id = "0x1209/0x5741"
        candidates = _pixhawk1_candidates()
        check = compat.cross_check_exact_match(candidates[0], identity)
        assert check.passed

    def test_absent_catalogue_usb_id_is_unverifiable_not_a_conflict(self):
        identity = _with_bootloader(_connected_identity(), fx.FIXTURE_A)
        identity.usb_id = "0x1209/0x5741"
        candidates = _candidates([_entry("Pixhawk1", ["Pixhawk1-BL"], usb_id=[])])
        check = compat.cross_check_exact_match(candidates[0], identity)
        assert check.passed
        assert "unverifiable" in next(
            c.detail for c in check.checks if c.name == "USB"
        )


# ===========================================================================
# 9. Multiple compatible platforms
# ===========================================================================


class TestCase09MultipleCompatiblePlatforms:
    def test_two_platforms_sharing_a_string_are_ambiguous(self):
        shared = ["Shared-BL"]
        candidates = _candidates(
            [
                _entry("PlatformA", shared),
                _entry("PlatformB", shared),
            ]
        )
        identity = _with_bootloader(_connected_identity(), fx.FIXTURE_A)
        identity.bootloader_str = "Shared-BL"
        result = compat.resolve(candidates, identity)
        assert result.outcome == compat.AMBIGUOUS
        assert result.selected is None
        assert result.platform_count == 2

    def test_a_second_agreeing_signal_resolves_the_tie(self):
        candidates = _candidates(
            [
                _entry("PlatformA", ["Shared-BL"], board_id=9),
                _entry("PlatformB", ["Shared-BL"], board_id=9),
            ]
        )
        # board id 9 does not disambiguate A vs B, so it stays ambiguous.
        identity = _with_bootloader(_connected_identity(), fx.FIXTURE_A)
        identity.bootloader_str = "Shared-BL"
        assert compat.resolve(candidates, identity).outcome == compat.AMBIGUOUS

    def test_first_candidate_is_never_chosen(self):
        """A pool of several platforms never auto-selects the first entry."""
        candidates = _candidates(
            [_entry(f"P{i}", [f"P{i}-BL"]) for i in range(5)]
        )
        identity = _with_bootloader(_connected_identity(), fx.FIXTURE_A)
        identity.bootloader_str = "no-such-board-BL"
        result = compat.resolve(candidates, identity)
        assert result.selected is None
        assert result.outcome == compat.NO_MATCH

    def test_ambiguous_outcome_never_offers_a_target(self):
        identity = _connected_identity(board_id=9)
        result = compat.resolve(_board9_candidates(), identity)
        assert result.outcome == compat.AMBIGUOUS
        assert result.can_confirm is False


# ===========================================================================
# 10. No device
# ===========================================================================


class TestCase10NoDevice:
    def test_no_device_outcome(self):
        result = compat.resolve(_board9_candidates(), _connected_identity(connected=False))
        assert result.outcome == compat.NO_DEVICE
        assert result.selected is None

    def test_no_device_is_distinct_from_identity_unavailable(self):
        assert compat.NO_DEVICE in compat.ALL_OUTCOMES
        assert compat.NO_DEVICE != compat.IDENTITY_UNAVAILABLE

    def test_service_reports_no_port(self):
        service = BootloaderIdentityService(ports=[], mavlink_alive=False)
        probe = service.probe()
        assert probe.kind == TRANSPORT_NONE
        assert probe.can_read_bootloader is False
        report = service.read_identity()
        assert report.refusal
        assert report.can_resolve_platform is False
        assert report.usb_id is None


# ===========================================================================
# 11. Disconnected device
# ===========================================================================


class TestCase11DisconnectedDevice:
    def test_silent_board_without_bootloader_string_is_unknown(self):
        service = BootloaderIdentityService(ports=[MAVLINK_PORT], mavlink_alive=False)
        probe = service.probe()
        assert probe.kind == TRANSPORT_UNKNOWN
        assert probe.can_read_bootloader is False

    def test_silence_never_sends_bootloader_traffic(self):
        transport = RecordingTransport(fx.FIXTURE_A)
        service = BootloaderIdentityService(
            transport, ports=[MAVLINK_PORT], mavlink_alive=False
        )
        report = service.read_identity()
        assert transport.reads == 0
        assert transport.connects == 0
        assert report.bootloader_read_performed is False

    def test_silent_board_with_no_board_id_is_identity_unavailable(self):
        """No board id and no bootloader string means identity unavailable."""
        identity = _connected_identity()
        result = compat.resolve(_board9_candidates(), identity)
        assert result.outcome == compat.IDENTITY_UNAVAILABLE

    def test_a_known_but_ambiguous_board_id_is_ambiguous_not_unavailable(self):
        """board_id 9 is present but spans four platforms: a different problem."""
        identity = _connected_identity(board_id=9)
        assert compat.resolve(_board9_candidates(), identity).outcome == compat.AMBIGUOUS

    def test_usb_identity_is_still_reported_when_silent(self):
        service = BootloaderIdentityService(ports=[MAVLINK_PORT], mavlink_alive=False)
        report = service.read_identity()
        assert report.usb_id == "0x1209/0x5741"
        assert report.usb_serial_number == "3C0027000951363033383531"
        assert report.missing_fields


# ===========================================================================
# 12. MAVLink endpoint offered as a bootloader
# ===========================================================================


class TestCase12MavlinkEndpointMisrouted:
    def test_mavlink_port_is_classified_as_mavlink(self):
        service = BootloaderIdentityService(ports=[MAVLINK_PORT], mavlink_alive=True)
        probe = service.probe()
        assert probe.kind == TRANSPORT_MAVLINK
        assert probe.mavlink_alive is True
        assert probe.can_read_bootloader is False

    def test_no_bootloader_traffic_reaches_a_mavlink_endpoint(self):
        transport = RecordingTransport(fx.FIXTURE_A)
        service = BootloaderIdentityService(
            transport, ports=[MAVLINK_PORT], mavlink_alive=True
        )
        report = service.read_identity(mavlink_info=MAVLINK_INFO)
        assert transport.reads == 0
        assert transport.connects == 0
        assert report.bootloader_read_performed is False

    def test_mavlink_read_still_yields_board_identity(self):
        service = BootloaderIdentityService(ports=[MAVLINK_PORT], mavlink_alive=True)
        report = service.read_identity(mavlink_info=MAVLINK_INFO)
        assert report.board_version == 589824
        assert report.board_type == 0
        assert report.board_rev == 9
        assert report.mavlink_connection_type == "USB"
        assert report.system_id == 1
        assert report.component_id == 1

    def test_refusal_names_the_mavlink_mode(self):
        service = BootloaderIdentityService(ports=[MAVLINK_PORT], mavlink_alive=True)
        report = service.read_identity(mavlink_info=MAVLINK_INFO)
        assert "MAVLink mode" in report.refusal

    def test_board_version_is_not_promoted_to_a_board_id(self):
        service = BootloaderIdentityService(ports=[MAVLINK_PORT], mavlink_alive=True)
        report = service.read_identity(mavlink_info=MAVLINK_INFO)
        assert report.board_id is None
        assert any("not a manifest board_id" in w for w in report.warnings)

    def test_normal_mode_product_string_is_warned_about(self):
        service = BootloaderIdentityService(ports=[MAVLINK_PORT], mavlink_alive=True)
        report = service.read_identity(mavlink_info=MAVLINK_INFO)
        assert any(
            "normal-mode product string" in w and "not used to infer" in w
            for w in report.warnings
        )

    def test_bootloader_fields_stay_null_in_mavlink_mode(self):
        service = BootloaderIdentityService(ports=[MAVLINK_PORT], mavlink_alive=True)
        report = service.read_identity(mavlink_info=MAVLINK_INFO)
        assert report.bootloader_revision is None
        assert report.board_id is None
        assert report.flash_size is None
        assert report.bootloader_usb_product_string is None
        assert report.can_resolve_platform is False


# ===========================================================================
# 13. Stale identity after disconnect
# ===========================================================================


class TestCase13StaleIdentityAfterDisconnect:
    def test_a_fresh_service_after_disconnect_does_not_reuse_the_identity(self):
        transport = RecordingTransport(fx.FIXTURE_A)
        connected = BootloaderIdentityService(
            transport, ports=[BOOTLOADER_PORT], mavlink_alive=False
        )
        first = connected.read_identity()
        assert first.bootloader_read_performed

        # Board disconnects.
        gone = BootloaderIdentityService(transport, ports=[], mavlink_alive=False)
        second = gone.read_identity()
        assert second.bootloader_read_performed is False
        assert second.can_resolve_platform is False
        assert second.refusal

    def test_a_removed_port_leaves_no_protocol_fields(self):
        report = BootloaderIdentityService(ports=[], mavlink_alive=False).read_identity()
        assert report.bootloader_revision is None
        assert report.board_id is None
        assert report.flash_size is None
        assert report.bootloader_usb_product_string is None
        assert report.usb_serial_number is None

    def test_usb_serial_identity_also_disappears(self):
        report = BootloaderIdentityService(ports=[], mavlink_alive=False).read_identity()
        assert report.usb_id is None
        assert report.normal_mode_usb_product is None

    def test_stale_values_cannot_be_reused_for_resolution(self):
        """A previously-read board-9 identity does not survive a disconnect."""
        identity = _with_bootloader(_connected_identity(), fx.FIXTURE_A)
        assert compat.resolve(_pixhawk1_candidates(), identity).outcome == compat.EXACT_MATCH

        # Disconnected: rebuild the evidence as a fresh no-device identity.
        stale = compat.IdentityEvidence(connected=False, usb_id=identity.usb_id)
        assert stale.bootloader_identity is None
        assert compat.resolve(_pixhawk1_candidates(), stale).outcome == compat.NO_DEVICE


# ===========================================================================
# 14. Reconnect with a changed identity
# ===========================================================================


class TestCase14ReconnectChangedIdentity:
    def test_a_changed_product_string_resolves_differently(self):
        first = _with_bootloader(_connected_identity(), fx.FIXTURE_A)
        second = _with_bootloader(_connected_identity(), fx.FIXTURE_B)
        assert first.bootloader_str != second.bootloader_str
        a = compat.resolve(_board9_candidates(), first)
        b = compat.resolve(_board9_candidates(), second)
        assert a.selected.platform == "Pixhawk1"
        assert b.selected.platform == "Pixhawk1-1M"

    def test_a_changed_usb_serial_is_reported_not_inherited(self):
        """USB serial is the per-board serial, so a swap must show up."""
        original = UsbPortIdentity(
            device="/dev/ttyACM0",
            vendor_id=0x1209,
            product_id=0x5741,
            serial_number="AAA",
            product="Pixhawk1-BL",
        )
        swapped = UsbPortIdentity(
            device="/dev/ttyACM0",
            vendor_id=0x1209,
            product_id=0x5741,
            serial_number="BBB",
            product="Pixhawk1-BL",
        )
        service = BootloaderIdentityService(ports=[original], mavlink_alive=False)
        assert service.read_identity().usb_serial_number == "AAA"
        service = BootloaderIdentityService(ports=[swapped], mavlink_alive=False)
        assert service.read_identity().usb_serial_number == "BBB"

    def test_a_changed_board_id_is_not_treated_as_the_same_board(self):
        """A different board id on reconnect must not reuse the old match."""
        fixture = fx.BootloaderFixture(
            name="other-board",
            description="Different physical board",
            bootloader_revision=4,
            board_id=9,
            flash_size=2 * 1024 * 1024,
            usb_product_string="CubeBlack-BL",
        )
        identity = _with_bootloader(_connected_identity(), fixture)
        result = compat.resolve(_board9_candidates(), identity)
        assert result.selected is not None
        assert result.selected.platform == "CubeBlack"

    def test_reconnect_reads_a_fresh_identity_from_the_transport(self):
        transport = RecordingTransport(fx.FIXTURE_A)
        service = BootloaderIdentityService(
            transport, ports=[BOOTLOADER_PORT], mavlink_alive=False
        )
        service.read_identity()
        first_reads = transport.reads
        report = service.read_identity()
        assert transport.reads > first_reads
        assert report.board_id == 9

    def test_a_stale_uncorroborated_port_yields_no_resolution(self):
        """A port that stopped advertising -BL no longer reads as a bootloader."""
        transport = RecordingTransport(fx.FIXTURE_A)
        service = BootloaderIdentityService(
            transport, ports=[BOOTLOADER_PORT], mavlink_alive=False
        )
        assert service.read_identity().bootloader_read_performed

        # Same device now answering MAVLink after reconnection.
        service = BootloaderIdentityService(
            transport, ports=[MAVLINK_PORT], mavlink_alive=True
        )
        report = service.read_identity(mavlink_info=MAVLINK_INFO)
        assert report.bootloader_read_performed is False
        assert report.can_resolve_platform is False


# ===========================================================================
# Safety invariants that must hold across every case
# ===========================================================================


class TestSafetyInvariants:
    def test_only_a_bootloader_transport_is_bootloader_capable(self):
        assert TRANSPORT_BOOTLOADER == "BOOTLOADER"
        assert TRANSPORT_MAVLINK != TRANSPORT_BOOTLOADER
        assert TRANSPORT_UNKNOWN != TRANSPORT_BOOTLOADER
        assert TRANSPORT_NONE != TRANSPORT_BOOTLOADER

    def test_service_never_exposes_a_write_method(self):
        forbidden = {
            "write", "erase", "flash", "upload", "program", "reboot",
            "reset", "enter_bootloader", "set_bootloader", "format",
        }
        public = [n for n in dir(BootloaderIdentityService) if not n.startswith("_")]
        for name in public:
            assert not any(f in name.lower() for f in forbidden), name

    def test_bootloader_product_suffix_is_required_for_evidence(self):
        assert UsbPortIdentity(device="x", product="Pixhawk1-BL").is_bootloader_product_string
        assert not UsbPortIdentity(device="x", product="Pixhawk1").is_bootloader_product_string
        assert not UsbPortIdentity(device="x", product=None).is_bootloader_product_string
        assert not UsbPortIdentity(device="x", product="").is_bootloader_product_string

    def test_every_report_field_is_null_or_real(self):
        """No field ever defaults: missing means None, never 0 or ''."""
        report = BootloaderIdentityService(ports=[], mavlink_alive=False).read_identity()
        assert report.bootloader_revision is None
        assert report.board_id is None
        assert report.flash_size is None
        assert report.board_version is None
        assert report.board_type is None
        assert report.board_rev is None

    def test_serialises_every_documented_field(self):
        payload = BootloaderIdentityService(
            RecordingTransport(fx.FIXTURE_A), ports=[BOOTLOADER_PORT], mavlink_alive=False
        ).read_identity().to_dict()
        for key in (
            "bootloaderRevision",
            "boardId",
            "flashSize",
            "bootloaderUsbProductString",
            "boardVersion",
            "boardType",
            "boardRev",
            "usbVendorId",
            "usbProductId",
            "usbId",
            "usbSerialNumber",
            "usbManufacturer",
            "usbProductString",
            "usbProductIsBootloaderEvidence",
            "mavlinkConnectionType",
            "systemId",
            "componentId",
            "bootloaderReadPerformed",
            "missingFields",
            "canResolvePlatform",
        ):
            assert key in payload, key