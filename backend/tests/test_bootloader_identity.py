"""Tests for the bootloader identity reader, transport, and resolver integration.

Every value in this file is SYNTHETIC. Fixtures are defined in
``services.bootloader_fixtures`` and are explicitly marked as test data. No test
here reads from ``/dev/ttyACM0``, opens a real serial port, enters bootloader
mode, reboots the connected Pixhawk, or sends any bootloader command. The real
Pixhawk must remain read-only and untouched.

The manifest documents below are minimal synthetic fixtures built in-test; no
real firmware catalogue is vendored.
"""

import json

import pytest

from services import bootloader_fixtures as fx
from services import firmware_catalog_service as catalog
from services import firmware_compat_service as compat
from services.bootloader_identity import (
    BOARD_ID_FMUV2,
    BOARD_ID_FMUV3_SYNTHETIC,
    FLASH_SIZE_SMALL,
    INCOMPLETE,
    INVALID,
    UNAVAILABLE,
    VALID,
    build_identity,
    interpret_board_id,
    unavailable_identity,
)
from services.bootloader_transport import (
    BootloaderIdentityReader,
    BootloaderTransport,
    BootloaderTransportError,
    RawBootloaderInfo,
)

# ---------------------------------------------------------------------------
# Synthetic manifest helpers
# ---------------------------------------------------------------------------

# Board id 9 platforms that genuinely coexist in the official manifest. The
# board-id-9 collision is the reason corroboration is mandatory.
BOARD9_PLATFORMS = [
    ("Pixhawk1", ["Pixhawk1-BL", "PX4 BL FMU v2.x"]),
    ("Pixhawk1-1M", ["Pixhawk1-1M-BL", "PX4 BL FMU v2.x"]),
    ("CubeBlack", ["CubeBlack-BL", "PX4 BL FMU v2.x"]),
    ("fmuv2", ["PX4 BL FMU v2.x"]),
]


def _entry(platform="Pixhawk1", bootloader_str=None, board_id=9, **overrides):
    base = {
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
        "USBID": ["0x1209/0x5741"],
        "brand_name": platform,
        "manufacturer": "3DR",
        "image_size": 1559908,
    }
    base.update(overrides)
    return base


def _candidates(entries):
    """Turn synthetic manifest entries into FirmwareCandidate objects."""
    out = []
    for e in entries:
        c = catalog.candidate_from_entry(e)
        if c is not None:
            out.append(c)
    return out


def _board9_candidates():
    return _candidates([_entry(p, bl, board_id=9) for p, bl in BOARD9_PLATFORMS])


def _copter_identity(**overrides):
    """A normal-mode ArduCopter identity with no bootloader evidence."""
    base = dict(
        connected=True,
        is_sitl=False,
        autopilot="ARDUPILOTMEGA",
        vehicle_type="QUADROTOR",
        manifest_vehicle="Copter",
        board_type=0,
        board_rev=9,
        evidence=["synthetic test identity"],
    )
    base.update(overrides)
    return compat.IdentityEvidence(**base)


def _bootloader_identity(identity, result):
    """Fold a bootloader identity result into a normal-mode identity."""
    return compat.apply_bootloader_identity(identity, result)


# ---------------------------------------------------------------------------
# 1. complete identity
# ---------------------------------------------------------------------------


class TestCompleteIdentity:
    def test_fixture_a_is_valid_and_complete(self):
        result = fx.FixtureBootloaderTransport(fx.FIXTURE_A).read_identity()
        bid = result.identity
        assert bid.validity == VALID
        assert bid.is_complete
        assert bid.bootloader_revision == 4
        assert bid.board_id == BOARD_ID_FMUV2
        assert bid.flash_size == 2 * 1024 * 1024
        assert bid.usb_product_string == "Pixhawk1-BL"

    def test_reader_returns_valid_identity_for_complete_fixture(self):
        reader = BootloaderIdentityReader(fx.FixtureBootloaderTransport(fx.FIXTURE_A))
        result = reader.read()
        assert result.identity.is_valid
        assert result.identity.is_complete
        assert any("fixture" in e.lower() for e in result.evidence)

    def test_complete_identity_is_usable_for_resolution(self):
        result = fx.FixtureBootloaderTransport(fx.FIXTURE_A).read_identity()
        assert result.identity.is_usable_for_resolution

    def test_identity_serialises_all_fields(self):
        bid = fx.FixtureBootloaderTransport(fx.FIXTURE_A).read_identity().identity
        payload = bid.to_dict()
        assert payload["boardId"] == 9
        assert payload["flashSize"] == 2 * 1024 * 1024
        assert payload["usbProductString"] == "Pixhawk1-BL"
        assert payload["validity"] == VALID
        assert payload["isComplete"] is True
        assert payload["missingFields"] == []

    def test_transport_is_disconnected_after_read(self):
        transport = fx.FixtureBootloaderTransport(fx.FIXTURE_A)
        transport.read_identity()
        assert transport.is_connected() is False


# ---------------------------------------------------------------------------
# 2-6. missing / malformed identity
# ---------------------------------------------------------------------------


class TestMissingFields:
    def test_missing_board_id_is_incomplete_and_never_coerced(self):
        result = fx.FixtureBootloaderTransport(fx.FIXTURE_MISSING_BOARD_ID).read_identity()
        bid = result.identity
        assert bid.validity == INCOMPLETE
        assert bid.board_id is None
        assert not bid.is_usable_for_resolution
        assert "boardId" in bid.missing_fields

    def test_missing_flash_size_is_incomplete(self):
        result = fx.FixtureBootloaderTransport(fx.FIXTURE_MISSING_FLASH_SIZE).read_identity()
        assert result.identity.validity == INCOMPLETE
        assert result.identity.flash_size is None
        assert "flashSize" in result.identity.missing_fields

    def test_missing_bootloader_revision_is_incomplete(self):
        result = fx.FixtureBootloaderTransport(fx.FIXTURE_E).read_identity()
        assert result.identity.validity == INCOMPLETE
        assert result.identity.bootloader_revision is None
        assert "bootloaderRevision" in result.identity.missing_fields

    def test_missing_usb_product_string_is_incomplete(self):
        result = fx.FixtureBootloaderTransport(fx.FIXTURE_D).read_identity()
        assert result.identity.validity == INCOMPLETE
        assert result.identity.usb_product_string is None
        assert "usbProductString" in result.identity.missing_fields


class TestMalformedIdentity:
    def test_fixture_f_is_invalid(self):
        result = fx.FixtureBootloaderTransport(fx.FIXTURE_F).read_identity()
        assert result.identity.validity == INVALID
        assert result.identity.errors

    @pytest.mark.parametrize(
        "kwargs,expected_error_fragment",
        [
            ({"bootloader_revision": -1}, "bootloader revision"),
            ({"bootloader_revision": 6}, "outside the supported range"),
            ({"bootloader_revision": 99}, "outside the supported range"),
            ({"board_id": 0}, "not a valid board identifier"),
            ({"board_id": -5}, "not a valid board identifier"),
            ({"board_id": 255}, "synthetic FMUv3"),
            ({"board_id": 100000}, "out of range"),
            ({"flash_size": 0}, "greater than zero"),
            ({"flash_size": -1}, "greater than zero"),
            ({"flash_size": 64 * 1024 * 1024}, "sanity limit"),
            ({"usb_product_string": ""}, "empty"),
            ({"usb_product_string": "   "}, "empty"),
            ({"usb_product_string": 12345}, "must be a string"),
            ({"board_id": "nine"}, "must be an integer"),
            ({"flash_size": "2097152"}, "must be an integer"),
            ({"bootloader_revision": True}, "must be an integer"),
        ],
    )
    def test_malformed_values_are_rejected_not_coerced(self, kwargs, expected_error_fragment):
        good = dict(
            bootloader_revision=4,
            board_id=9,
            flash_size=2 * 1024 * 1024,
            usb_product_string="Pixhawk1-BL",
        )
        good.update(kwargs)
        result = build_identity(**good)
        assert result.identity.validity == INVALID
        assert result.identity.is_valid is False
        assert result.identity.is_usable_for_resolution is False
        assert any(expected_error_fragment in e for e in result.identity.errors), result.identity.errors

    def test_invalid_identity_reports_every_problem(self):
        result = build_identity(
            bootloader_revision=99, board_id=0, flash_size=0, usb_product_string=""
        )
        assert result.identity.validity == INVALID
        assert len(result.identity.errors) >= 4

    def test_invalid_identity_never_becomes_valid_via_missing_values(self):
        # A malformed board id must stay None, not silently become 0 or 9.
        result = build_identity(
            bootloader_revision=4, board_id=0, flash_size=2 * 1024 * 1024,
            usb_product_string="Pixhawk1-BL",
        )
        assert result.identity.board_id is None

    def test_overlong_usb_product_string_rejected(self):
        result = build_identity(
            bootloader_revision=4, board_id=9, flash_size=2 * 1024 * 1024,
            usb_product_string="x" * 300,
        )
        assert result.identity.validity == INVALID

    def test_usb_product_string_is_stripped(self):
        result = build_identity(
            bootloader_revision=4, board_id=9, flash_size=2 * 1024 * 1024,
            usb_product_string="  Pixhawk1-BL  ",
        )
        assert result.identity.usb_product_string == "Pixhawk1-BL"


# ---------------------------------------------------------------------------
# Transport behaviour / safety
# ---------------------------------------------------------------------------


class TestTransportAbstraction:
    def test_fixture_transport_is_a_bootloader_transport(self):
        transport = fx.FixtureBootloaderTransport(fx.FIXTURE_A)
        assert isinstance(transport, BootloaderTransport)

    def test_transport_interface_has_no_mutating_methods(self):
        # The read-only contract is enforced structurally: no erase/program/
        # write/reboot method may exist on the interface.
        forbidden = {"erase", "program", "write", "reboot", "reboot_to_bootloader", "flash"}
        assert forbidden.isdisjoint(set(dir(BootloaderTransport)))

    def test_reader_requires_a_transport(self):
        with pytest.raises(ValueError):
            BootloaderIdentityReader(None)

    def test_connect_failure_yields_unavailable_not_exception(self):
        transport = fx.FixtureBootloaderTransport(fx.FIXTURE_A, connect_should_fail=True)
        result = transport.read_identity()
        assert result.identity.validity == UNAVAILABLE

    def test_failed_read_still_disconnects(self):
        class BrokenTransport(BootloaderTransport):
            name = "test-broken"

            def __init__(self):
                self._connected = False

            def connect(self):
                self._connected = True

            def read_info(self):
                raise BootloaderTransportError("synthetic read failure")

            def disconnect(self):
                self._connected = False

        transport = BrokenTransport()
        result = transport.read_identity()
        assert result.identity.validity == UNAVAILABLE
        assert transport.is_connected() is False

    def test_reader_works_through_the_abstract_interface(self):
        class GenericTransport(BootloaderTransport):
            """Proves the reader depends only on the abstraction."""

            name = "test-generic"

            def __init__(self, raw):
                self._raw = raw
                self._connected = False

            def connect(self):
                self._connected = True

            def read_info(self):
                if not self._connected:
                    raise BootloaderTransportError("not connected")
                return self._raw

            def disconnect(self):
                self._connected = False

        reader = BootloaderIdentityReader(
            GenericTransport(
                RawBootloaderInfo(
                    bootloader_revision=4,
                    board_id=9,
                    flash_size=2 * 1024 * 1024,
                    usb_product_string="Pixhawk1-BL",
                )
            )
        )
        result = reader.read()
        assert result.identity.is_valid
        assert result.identity.board_id == 9

    def test_unavailable_identity_helper(self):
        result = unavailable_identity("no bootloader present")
        assert result.identity.validity == UNAVAILABLE
        assert not result.identity.is_usable_for_resolution


# ---------------------------------------------------------------------------
# 6. board ID 9 limitation
# ---------------------------------------------------------------------------


class TestBoardId9Handling:
    def test_board_id_9_is_marked_ambiguous_even_with_full_identity(self):
        result = fx.FixtureBootloaderTransport(fx.FIXTURE_A).read_identity()
        effective = interpret_board_id(
            result.identity.board_id, result.identity.flash_size, result.identity.bootloader_revision
        )
        assert effective.is_ambiguous_id is True
        assert effective.manifest_board_id == BOARD_ID_FMUV2

    def test_board_id_9_with_flash_below_threshold_is_small_flash(self):
        effective = interpret_board_id(9, FLASH_SIZE_SMALL, 4)
        assert effective.is_large_flash is False

    def test_board_id_9_with_large_flash_and_modern_bootloader_is_large_flash(self):
        effective = interpret_board_id(9, 2 * 1024 * 1024, 5)
        assert effective.is_large_flash is True

    def test_board_id_9_without_flash_size_cannot_determine_hardware(self):
        effective = interpret_board_id(9, None, 4)
        assert effective.is_ambiguous_id is True
        assert effective.is_large_flash is None

    def test_board_id_9_without_flash_size_notes_shared_platforms(self):
        effective = interpret_board_id(9, None, 4)
        assert "FMUv2" in effective.note and "Cube F4" in effective.note

    def test_non_ambiguous_board_id_is_used_directly(self):
        effective = interpret_board_id(24, 2 * 1024 * 1024, 5)
        assert effective.manifest_board_id == 24
        assert effective.is_ambiguous_id is False

    def test_missing_board_id_yields_no_interpretation(self):
        effective = interpret_board_id(None, 2 * 1024 * 1024, 5)
        assert effective.manifest_board_id is None

    def test_board_id_255_is_rejected_as_identity_but_meaningful_to_board_logic(self):
        # 255 must never be accepted from a device...
        result = build_identity(
            bootloader_revision=4, board_id=255, flash_size=2 * 1024 * 1024,
            usb_product_string="Pixhawk1-BL",
        )
        assert result.identity.validity == INVALID
        # ...but the constant is documented as QGC's synthetic marker.
        assert BOARD_ID_FMUV3_SYNTHETIC == 255

    def test_resolver_never_selects_on_board_id_9_alone(self):
        """The forbidden pattern: board_id == 9 must not pick Pixhawk firmware."""
        cands = _board9_candidates()
        identity = _copter_identity(board_id=9)
        # No bootloader identity at all: board id 9 must stay ambiguous.
        resolution = compat.resolve(cands, identity)
        assert resolution.outcome == compat.AMBIGUOUS
        assert resolution.selected is None
        assert resolution.can_confirm is False

    def test_resolver_with_only_board_id_9_and_no_product_string_is_unresolved(self):
        """Valid revision/flash but no product string is not a conflict.

        There is nothing to adjudicate; the only trustworthy signal is missing,
        so the honest outcome is IDENTITY_UNAVAILABLE.
        """
        cands = _board9_candidates()
        # Valid revision/flash but INCOMPLETE because no product string.
        result = fx.FixtureBootloaderTransport(fx.FIXTURE_D).read_identity()
        identity = _bootloader_identity(_copter_identity(), result)
        resolution = compat.resolve(cands, identity)
        assert resolution.outcome == compat.IDENTITY_UNAVAILABLE
        assert resolution.can_confirm is False
        assert resolution.selected is None


# ---------------------------------------------------------------------------
# Resolver integration
# ---------------------------------------------------------------------------


class TestResolverWithBootloaderIdentity:
    def test_board_id_9_with_matching_corroboration_selects_unique_platform(self):
        cands = _board9_candidates()
        result = fx.FixtureBootloaderTransport(fx.FIXTURE_BOARD_ID_9_MATCH).read_identity()
        identity = _bootloader_identity(_copter_identity(), result)
        resolution = compat.resolve(cands, identity)
        # "Pixhawk1-BL" is unique to Pixhawk1 in this fixture set.
        assert resolution.outcome == compat.EXACT_MATCH
        assert resolution.selected is not None
        assert resolution.selected.platform == "Pixhawk1"
        assert resolution.can_confirm is True

    def test_board_id_9_with_different_product_string_selects_that_platform(self):
        cands = _board9_candidates()
        result = fx.FixtureBootloaderTransport(fx.FIXTURE_B).read_identity()
        identity = _bootloader_identity(_copter_identity(), result)
        resolution = compat.resolve(cands, identity)
        assert resolution.outcome == compat.EXACT_MATCH
        assert resolution.selected.platform == "Pixhawk1-1M"

    def test_board_id_9_with_generic_product_string_stays_ambiguous(self):
        # "PX4 BL FMU v2.x" is shared by all four platforms.
        from services import bootloader_identity as bid

        result = bid.build_identity(
            bootloader_revision=4,
            board_id=9,
            flash_size=2 * 1024 * 1024,
            usb_product_string="PX4 BL FMU v2.x",
        )
        cands = _board9_candidates()
        identity = _bootloader_identity(_copter_identity(), result)
        resolution = compat.resolve(cands, identity)
        assert resolution.outcome == compat.AMBIGUOUS
        assert resolution.selected is None
        assert resolution.platform_count == 4

    def test_board_id_9_with_conflicting_corroboration_does_not_select_pixhawk(self):
        # A conflicting product string must not fall back to Pixhawk.
        cands = _board9_candidates()
        result = fx.FixtureBootloaderTransport(fx.FIXTURE_BOARD_ID_9_CONFLICT).read_identity()
        identity = _bootloader_identity(_copter_identity(), result)
        resolution = compat.resolve(cands, identity)
        # CubeBlack-BL is unique to CubeBlack, so it must not resolve to Pixhawk.
        assert resolution.outcome != compat.EXACT_MATCH or resolution.selected.platform != "Pixhawk1"
        assert resolution.selected is None or resolution.selected.platform == "CubeBlack"

    def test_incomplete_bootloader_identity_is_ignored_by_resolver(self):
        cands = _board9_candidates()
        result = fx.FixtureBootloaderTransport(fx.FIXTURE_BOARD_ID_9_INSUFFICIENT).read_identity()
        identity = _bootloader_identity(_copter_identity(), result)
        # Identity stays incomplete, so board id is not adopted.
        assert identity.bootloader_identity is None or not identity.bootloader_identity.is_usable_for_resolution
        resolution = compat.resolve(cands, identity)
        assert resolution.outcome == compat.IDENTITY_UNAVAILABLE
        assert resolution.selected is None

    def test_invalid_bootloader_identity_is_ignored_by_resolver(self):
        cands = _board9_candidates()
        result = fx.FixtureBootloaderTransport(fx.FIXTURE_F).read_identity()
        identity = _bootloader_identity(_copter_identity(), result)
        resolution = compat.resolve(cands, identity)
        assert resolution.outcome == compat.IDENTITY_UNAVAILABLE
        assert resolution.selected is None

    def test_unavailable_bootloader_identity_is_ignored(self):
        cands = _board9_candidates()
        result = unavailable_identity("not connected")
        identity = _bootloader_identity(_copter_identity(), result)
        resolution = compat.resolve(cands, identity)
        assert resolution.outcome == compat.IDENTITY_UNAVAILABLE
        assert resolution.selected is None

    def test_no_bootloader_result_at_all_is_handled(self):
        cands = _board9_candidates()
        identity = _bootloader_identity(_copter_identity(), None)
        resolution = compat.resolve(cands, identity)
        assert resolution.outcome == compat.IDENTITY_UNAVAILABLE
        assert resolution.can_confirm is False

    def test_exact_candidate_selection(self):
        cands = _board9_candidates()
        result = fx.FixtureBootloaderTransport(fx.FIXTURE_A).read_identity()
        identity = _bootloader_identity(_copter_identity(), result)
        resolution = compat.resolve(cands, identity)
        assert resolution.outcome == compat.EXACT_MATCH
        assert resolution.selected.platform == "Pixhawk1"
        assert resolution.platform_count == 1

    def test_unsupported_candidate_sitl_is_unaffected(self):
        cands = _board9_candidates()
        result = fx.FixtureBootloaderTransport(fx.FIXTURE_A).read_identity()
        identity = _bootloader_identity(_copter_identity(is_sitl=True), result)
        resolution = compat.resolve(cands, identity)
        assert resolution.outcome == compat.UNSUPPORTED

    def test_unsupported_non_copter_is_unaffected(self):
        cands = _candidates([_entry(vehicletype="Rover", platform="Pixhawk1")])
        result = fx.FixtureBootloaderTransport(fx.FIXTURE_A).read_identity()
        identity = _bootloader_identity(
            _copter_identity(vehicle_type="GROUNDROVER", manifest_vehicle=None), result
        )
        resolution = compat.resolve(cands, identity)
        assert resolution.outcome == compat.UNSUPPORTED

    def test_no_match_when_product_string_absent_from_catalogue(self):
        cands = _candidates([_entry("Pixhawk1", ["TotallyOther-BL"])])
        result = build_identity(
            bootloader_revision=4, board_id=9, flash_size=2 * 1024 * 1024,
            usb_product_string="Pixhawk1-BL",
        )
        identity = _bootloader_identity(_copter_identity(), result)
        resolution = compat.resolve(cands, identity)
        assert resolution.outcome == compat.NO_MATCH
        assert resolution.selected is None

    def test_no_match_when_catalogue_empty(self):
        result = fx.FixtureBootloaderTransport(fx.FIXTURE_A).read_identity()
        identity = _bootloader_identity(_copter_identity(), result)
        resolution = compat.resolve([], identity, catalog_available=True)
        assert resolution.outcome == compat.NO_MATCH

    def test_identity_unavailable_with_multiple_candidates_and_no_product_string(self):
        # Normal-mode evidence only, no bootloader: the board is connected but
        # its physical platform cannot be identified at all.
        cands = _board9_candidates()
        identity = _copter_identity()  # no board_id, no bootloader
        resolution = compat.resolve(cands, identity)
        assert resolution.outcome == compat.IDENTITY_UNAVAILABLE
        assert resolution.can_confirm is False
        assert resolution.platform_count == 4

    def test_resolution_evidence_records_bootloader_signals(self):
        cands = _board9_candidates()
        result = fx.FixtureBootloaderTransport(fx.FIXTURE_A).read_identity()
        identity = _bootloader_identity(_copter_identity(), result)
        resolution = compat.resolve(cands, identity)
        joined = " ".join(resolution.evidence)
        assert "Bootloader identity adopted" in joined
        assert "shared by several physical platforms" in joined


# ---------------------------------------------------------------------------
# 10-13. Candidate-type coverage (kept explicit per requirements)
# ---------------------------------------------------------------------------


class TestCandidateCoverage:
    def test_multiple_candidates_same_platform_picks_best_channel(self):
        # Two releases of the same platform -> still exactly one platform.
        entries = [
            _entry(
                "Pixhawk1",
                ["Pixhawk1-BL"],
                **{
                    "mav-firmware-version-type": "OFFICIAL",
                    "mav-firmware-version": "4.7.1",
                },
            ),
            _entry(
                "Pixhawk1",
                ["Pixhawk1-BL"],
                **{
                    "mav-firmware-version-type": "BETA",
                    "mav-firmware-version": "4.8.0",
                },
            ),
        ]
        cands = _candidates(entries)
        result = fx.FixtureBootloaderTransport(fx.FIXTURE_A).read_identity()
        identity = _bootloader_identity(_copter_identity(), result)
        resolution = compat.resolve(cands, identity)
        assert resolution.outcome == compat.EXACT_MATCH
        assert resolution.platform_count == 1
        assert resolution.selected.release_type == "OFFICIAL"

    def test_exact_candidate_present(self):
        cands = _candidates([_entry("Pixhawk1", ["Pixhawk1-BL"])])
        result = fx.FixtureBootloaderTransport(fx.FIXTURE_A).read_identity()
        identity = _bootloader_identity(_copter_identity(), result)
        resolution = compat.resolve(cands, identity)
        assert resolution.selected is not None

    def test_unsupported_candidate_reported(self):
        result = fx.FixtureBootloaderTransport(fx.FIXTURE_A).read_identity()
        identity = _bootloader_identity(_copter_identity(is_sitl=True), result)
        resolution = compat.resolve(_board9_candidates(), identity)
        assert resolution.outcome == compat.UNSUPPORTED
        assert resolution.selected is None

    def test_ambiguous_candidate_reported_with_platform_list(self):
        cands = _board9_candidates()
        result = build_identity(
            bootloader_revision=4, board_id=9, flash_size=2 * 1024 * 1024,
            usb_product_string="PX4 BL FMU v2.x",
        )
        identity = _bootloader_identity(_copter_identity(), result)
        resolution = compat.resolve(cands, identity)
        assert resolution.outcome == compat.AMBIGUOUS
        assert set(resolution.platforms) == {
            "Pixhawk1", "Pixhawk1-1M", "CubeBlack", "fmuv2",
        }


# ---------------------------------------------------------------------------
# Safety: no real hardware is ever touched
# ---------------------------------------------------------------------------


class TestNoHardwareAccess:
    def test_fixtures_are_marked_synthetic(self):
        for fixture in fx.ALL_FIXTURES:
            assert "TEST FIXTURE" in fixture.note or "TEST FIXTURE" in fixture.description

    def test_fixture_transport_evidence_declares_synthetic(self):
        transport = fx.FixtureBootloaderTransport(fx.FIXTURE_A)
        evidence = " ".join(transport.evidence)
        assert "TEST FIXTURE" in evidence
        assert "NOT read from the real Pixhawk" in evidence

    def test_identity_source_is_fixture_for_fixture_transport(self):
        result = fx.FixtureBootloaderTransport(fx.FIXTURE_A).read_identity()
        assert result.identity.source == "TEST_FIXTURE"

    def test_no_real_device_access_in_transport_modules(self):
        """Executable code must never touch a real device.

        Docstrings are stripped first, because the modules deliberately
        *mention* the real device path in prose to document that they never
        touch it.
        """
        import ast
        import inspect
        import textwrap

        import services.bootloader_identity as bi
        import services.bootloader_transport as bt

        def _code_only(module):
            tree = ast.parse(textwrap.dedent(inspect.getsource(module)))
            for node in ast.walk(tree):
                if isinstance(
                    node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)
                ):
                    if (
                        node.body
                        and isinstance(node.body[0], ast.Expr)
                        and isinstance(node.body[0].value, ast.Constant)
                        and isinstance(node.body[0].value.value, str)
                    ):
                        node.body.pop(0)
            return ast.unparse(tree)

        for module in (bi, bt, fx):
            code = _code_only(module)
            assert "/dev/tty" not in code
            assert "import serial" not in code
            assert "serial.Serial" not in code
            assert "open(" not in code.replace('open("rb")', "")

    def test_identity_and_transport_modules_do_not_import_each_other_silently(self):
        import ast
        import inspect
        import textwrap

        import services.bootloader_transport as bt

        tree = ast.parse(textwrap.dedent(inspect.getsource(bt)))
        imports = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.module:
                imports.add(node.module)
            if isinstance(node, ast.Import):
                imports.update(a.name for a in node.names)
        # The transport layer must not know about firmware selection.
        assert "services.firmware_compat_service" not in imports
        assert "services.firmware_catalog_service" not in imports

    def test_transport_is_purely_in_memory(self):
        transport = fx.FixtureBootloaderTransport(fx.FIXTURE_A)
        transport.connect()
        first = transport.read_info()
        second = transport.read_info()
        assert first.to_dict() == second.to_dict()
        transport.disconnect()
