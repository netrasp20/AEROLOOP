"""Explicit bootloader identity validation — the 14 required cases.

Every value here is SYNTHETIC and injected. No test reads ``/dev/ttyACM0``,
opens a real serial port, sends a byte to the attached Pixhawk, reboots it,
enters bootloader mode, or contacts a downloader. The real board stays
read-only and untouched.

===  ==========================================================================
  1  normal MAVLink device
  2  genuine bootloader identity
  3  silent device without bootloader evidence
  4  missing USB product
  5  conflicting USB identity
  6  board ID 9 alone
  7  exact Pixhawk1 bootloader identity
  8  multiple platform ambiguity
  9  disconnect while awaiting bootloader
 10  reconnect with different device identity
 11  stale identity rejection
 12  no automatic reboot
 13  no firmware write
 14  no downloader contact before exact compatibility
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
    TransportProbe,
    UsbPortIdentity,
)
from services.bootloader_validation_service import (
    AWAITING_BOOTLOADER,
    BOOTLOADER_DETECTED,
    BOOTLOADER_IDENTITY_READ,
    BOOTLOADER_IDENTITY_READING,
    DISCONNECTED,
    IDENTITY_AMBIGUOUS,
    IDENTITY_FAILED,
    IDENTITY_RESOLVED,
    NORMAL_MAVLINK,
    ALL_STATES,
    ALLOWED_TRANSITIONS,
    FORBIDDEN_OPERATIONS,
    BootloaderValidationMachine,
    BootloaderValidationService,
    IllegalTransition,
    ValidationRecord,
)

# ---------------------------------------------------------------------------
# Synthetic fixtures
# ---------------------------------------------------------------------------

#: Normal mode: the real board's descriptor. Note "Pixhawk1", NOT "Pixhawk1-BL".
NORMAL_PORT = UsbPortIdentity(
    device="/dev/ttyACM0",
    vendor_id=0x1209,
    product_id=0x5741,
    serial_number="3C0027000951363033383531",
    manufacturer="ArduPilot",
    product="Pixhawk1",
    description="Pixhawk1",
)

#: The same physical unit once it is in bootloader mode.
BOOTLOADER_PORT = UsbPortIdentity(
    device="/dev/ttyACM0",
    vendor_id=0x1209,
    product_id=0x5741,
    serial_number="3C0027000951363033383531",
    manufacturer="ArduPilot",
    product="Pixhawk1-BL",
    description="Pixhawk1-BL",
)

#: A different USB identity for the same silent board.
OTHER_USB_PORT = UsbPortIdentity(
    device="/dev/ttyACM0",
    vendor_id=0x2D00,
    product_id=0x1015,
    serial_number="3C0027000951363033383531",
    manufacturer="ArduPilot",
    product="Pixhawk1-BL",
    description="Pixhawk1-BL",
)

#: A different physical board entirely.
SWAPPED_BOARD_PORT = UsbPortIdentity(
    device="/dev/ttyACM1",
    vendor_id=0x1209,
    product_id=0x5741,
    serial_number="DIFFERENT-SERIAL-0001",
    manufacturer="ArduPilot",
    product="CubeBlack-BL",
    description="CubeBlack-BL",
)

#: Silent, and advertising a plain normal-mode product string.
SILENT_NO_EVIDENCE_PORT = UsbPortIdentity(
    device="/dev/ttyACM0",
    vendor_id=0x1209,
    product_id=0x5741,
    serial_number="3C0027000951363033383531",
    manufacturer="ArduPilot",
    product="Pixhawk1",
    description="Pixhawk1",
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
    """Counts every read so 'no bootloader traffic was sent' is provable."""

    name = "bootloader-transport:recording"

    def __init__(self, fixture=None):
        self.fixture = fixture
        self.reads = 0
        self.connects = 0

    def connect(self):
        self.connects += 1

    def read_info(self):
        self.reads += 1
        if self.fixture is None:
            raise RuntimeError("no fixture configured")
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
        "USBID": usb_id if usb_id is not None else ["0x1209/0x5741"],
        "brand_name": platform,
        "manufacturer": "3DR",
        "image_size": 1559908,
    }
    entry.update(overrides)
    return entry


def _candidates(entries):
    return [c for c in (catalog.candidate_from_entry(e) for e in entries) if c is not None]


def _pixhawk1_candidates():
    return _candidates([_entry("Pixhawk1", ["Pixhawk1-BL"])])


def _board9_entries():
    return [
        _entry("Pixhawk1", ["Pixhawk1-BL"]),
        _entry("Pixhawk1-1M", ["Pixhawk1-1M-BL"]),
        _entry("CubeBlack", ["CubeBlack-BL"]),
        _entry("fmuv2", ["PX4 BL FMU v2.x"]),
    ]


def _board9_candidates():
    return _candidates(_board9_entries())


def _connected_identity(**overrides):
    base = dict(
        connected=True,
        is_sitl=False,
        autopilot="ARDUPILOTMEGA",
        vehicle_type="QUADROTOR",
        manifest_vehicle="Copter",
        evidence=["synthetic"],
    )
    base.update(overrides)
    return compat.IdentityEvidence(**base)


def _with_bootloader(identity, fixture):
    result = fx.FixtureBootloaderTransport(fixture).read_identity()
    return compat.apply_bootloader_identity(identity, result)


def _probe(kind, port=None):
    return TransportProbe(
        kind=kind,
        port=port,
        mavlink_alive=(kind == TRANSPORT_MAVLINK),
        reason="synthetic",
        evidence=["synthetic"],
    )


def _service(*, transport=None, ports=None, mavlink_alive=False):
    return BootloaderValidationService(
        identity_service=BootloaderIdentityService(
            transport, ports=ports, mavlink_alive=mavlink_alive
        ),
        mavlink_info=MAVLINK_INFO if mavlink_alive else None,
    )


# ===========================================================================
# 1. Normal MAVLink device
# ===========================================================================


class TestCase01NormalMavlinkDevice:
    def test_normal_mavlink_device_is_classified_mavlink(self):
        service = _service(ports=[NORMAL_PORT], mavlink_alive=True)
        assert service.observe()["transport"]["kind"] == TRANSPORT_MAVLINK

    def test_state_is_normal_mavlink(self):
        svc = _service(ports=[NORMAL_PORT], mavlink_alive=True)
        svc.observe()
        assert svc.machine.state == NORMAL_MAVLINK

    def test_no_bootloader_identity_is_available(self):
        svc = _service(ports=[NORMAL_PORT], mavlink_alive=True)
        report = svc.observe()
        assert report["bootloaderReadPerformed"] is False
        assert report["canResolvePlatform"] is False

    def test_board_identity_is_still_reported(self):
        svc = _service(ports=[NORMAL_PORT], mavlink_alive=True)
        report = svc.observe()
        assert report["boardVersion"] == 589824
        assert report["boardType"] == 0
        assert report["boardRev"] == 9
        assert report["usbId"] == "0x1209/0x5741"
        assert report["usbSerialNumber"] == "3C0027000951363033383531"

    def test_normal_mode_product_is_not_bootloader_evidence(self):
        svc = _service(ports=[NORMAL_PORT], mavlink_alive=True)
        report = svc.observe()
        assert report["usbProductString"] == "Pixhawk1"
        assert report["usbProductIsBootloaderEvidence"] is False


# ===========================================================================
# 2. Genuine bootloader identity
# ===========================================================================


class TestCase02GenuineBootloaderIdentity:
    def test_bootloader_transport_is_detected_with_real_evidence(self):
        transport = RecordingTransport(fx.FIXTURE_A)
        svc = _service(transport=transport, ports=[BOOTLOADER_PORT])
        report = svc.observe()
        assert report["transport"]["kind"] == TRANSPORT_BOOTLOADER
        assert report["bootloaderReadPerformed"] is True

    def test_all_four_protocol_fields_are_read(self):
        transport = RecordingTransport(fx.FIXTURE_A)
        svc = _service(transport=transport, ports=[BOOTLOADER_PORT])
        report = svc.observe()
        assert report["bootloaderRevision"] == 4
        assert report["boardId"] == 9
        assert report["flashSize"] == 2 * 1024 * 1024
        assert report["bootloaderUsbProductString"] == "Pixhawk1-BL"
        assert report["canResolvePlatform"] is True

    def test_identity_is_read_exactly_once(self):
        transport = RecordingTransport(fx.FIXTURE_A)
        svc = _service(transport=transport, ports=[BOOTLOADER_PORT])
        svc.observe()
        assert transport.reads == 1

    def test_state_reaches_identity_read(self):
        transport = RecordingTransport(fx.FIXTURE_A)
        svc = _service(transport=transport, ports=[BOOTLOADER_PORT])
        svc.observe()
        assert svc.machine.state in (BOOTLOADER_IDENTITY_READ, IDENTITY_RESOLVED)
        assert svc.machine.identity is not None


# ===========================================================================
# 3. Silent device without bootloader evidence
# ===========================================================================


class TestCase03SilentDeviceWithoutBootloaderEvidence:
    def test_silence_alone_is_not_bootloader_detected(self):
        svc = _service(ports=[SILENT_NO_EVIDENCE_PORT])
        svc.observe()
        assert svc.machine.state != BOOTLOADER_DETECTED

    def test_silent_uncorroborated_port_is_unknown_transport(self):
        svc = _service(ports=[SILENT_NO_EVIDENCE_PORT])
        assert svc.observe()["transport"]["kind"] == TRANSPORT_UNKNOWN

    def test_no_bootloader_traffic_is_sent_to_a_silent_uncorroborated_port(self):
        transport = RecordingTransport(fx.FIXTURE_A)
        svc = _service(transport=transport, ports=[SILENT_NO_EVIDENCE_PORT])
        svc.observe()
        assert transport.reads == 0
        assert transport.connects == 0

    def test_silence_after_awaiting_still_is_not_bootloader_detected(self):
        machine = BootloaderValidationMachine()
        machine.observe_transport(_probe(TRANSPORT_MAVLINK, NORMAL_PORT))
        machine.transition(AWAITING_BOOTLOADER, "prepared")
        machine.observe_transport(_probe(TRANSPORT_UNKNOWN, SILENT_NO_EVIDENCE_PORT))
        assert machine.state != BOOTLOADER_DETECTED

    def test_machine_promotes_only_with_real_evidence(self):
        machine = BootloaderValidationMachine()
        machine.observe_transport(_probe(TRANSPORT_MAVLINK, NORMAL_PORT))
        machine.transition(AWAITING_BOOTLOADER, "prepared")
        machine.observe_transport(_probe(TRANSPORT_BOOTLOADER, BOOTLOADER_PORT))
        assert machine.state == BOOTLOADER_DETECTED


# ===========================================================================
# 4. Missing USB product
# ===========================================================================


class TestCase04MissingUsbProduct:
    def test_missing_usb_product_never_resolves_a_platform(self):
        identity = _with_bootloader(_connected_identity(), fx.FIXTURE_MISSING_USB_PRODUCT)
        result = compat.resolve(_pixhawk1_candidates(), identity)
        assert result.selected is None
        assert result.outcome == compat.IDENTITY_UNAVAILABLE

    def test_missing_usb_product_is_reported_missing(self):
        identity = _with_bootloader(_connected_identity(), fx.FIXTURE_MISSING_USB_PRODUCT)
        assert any("usbProductString" in e for e in identity.evidence)

    def test_null_usb_product_is_not_treated_as_a_wildcard(self):
        identity = _connected_identity(board_id=9, bootloader_str="")
        assert compat.resolve(_pixhawk1_candidates(), identity).selected is None

    def test_missing_product_in_report_stays_none(self):
        port = UsbPortIdentity(device="/dev/ttyACM0", vendor_id=0x1209, product_id=0x5741)
        assert port.product is None
        assert port.is_bootloader_product_string is False


# ===========================================================================
# 5. Conflicting USB identity
# ===========================================================================


class TestCase05ConflictingUsbIdentity:
    def test_conflicting_vid_pid_downgrades_to_ambiguous(self):
        identity = _with_bootloader(_connected_identity(), fx.FIXTURE_A)
        identity.usb_id = "0x2d00/0x1015"
        result = compat.resolve(_pixhawk1_candidates(), identity)
        assert result.outcome == compat.AMBIGUOUS
        assert result.selected is None

    def test_conflict_names_the_usb_check(self):
        identity = _with_bootloader(_connected_identity(), fx.FIXTURE_A)
        identity.usb_id = "0x2d00/0x1015"
        check = compat.cross_check_exact_match(_pixhawk1_candidates()[0], identity)
        assert not check.passed
        assert "USB" in check.failed_checks

    def test_matching_vid_pid_passes(self):
        identity = _with_bootloader(_connected_identity(), fx.FIXTURE_A)
        identity.usb_id = "0x1209/0x5741"
        check = compat.cross_check_exact_match(_pixhawk1_candidates()[0], identity)
        assert check.passed

    def test_undeclared_catalogue_usb_id_is_unverifiable_not_conflict(self):
        identity = _with_bootloader(_connected_identity(), fx.FIXTURE_A)
        identity.usb_id = "0x1209/0x5741"
        candidates = _candidates([_entry("Pixhawk1", ["Pixhawk1-BL"], usb_id=[])])
        check = compat.cross_check_exact_match(candidates[0], identity)
        assert check.passed
        assert "unverifiable" in next(c.detail for c in check.checks if c.name == "USB")

    def test_different_usb_port_is_reported_as_a_different_device(self):
        assert NORMAL_PORT.usb_id != OTHER_USB_PORT.usb_id
        assert NORMAL_PORT.serial_number == OTHER_USB_PORT.serial_number


# ===========================================================================
# 6. Board ID 9 alone
# ===========================================================================


class TestCase06BoardIdNineAlone:
    def test_board_id_nine_alone_never_selects(self):
        identity = _connected_identity(board_id=9)
        result = compat.resolve(_board9_candidates(), identity)
        assert result.selected is None
        assert result.outcome == compat.AMBIGUOUS

    def test_board_id_nine_alone_is_refused_even_on_one_platform(self):
        identity = _connected_identity(board_id=9)
        result = compat.resolve(_pixhawk1_candidates(), identity)
        assert result.selected is None
        assert result.outcome == compat.AMBIGUOUS
        assert result.can_confirm is False

    def test_board_version_is_not_promoted_to_board_id(self):
        svc = _service(ports=[NORMAL_PORT], mavlink_alive=True)
        report = svc.observe()
        assert report["boardVersion"] == 589824
        assert report["boardId"] is None
        assert any("not a manifest board_id" in w for w in report["warnings"])

    def test_cross_check_fails_without_bootloader_identity(self):
        identity = _connected_identity(board_id=9)
        check = compat.cross_check_exact_match(_pixhawk1_candidates()[0], identity)
        assert not check.passed
        assert "required bootloader identity" in check.failed_checks


# ===========================================================================
# 7. Exact Pixhawk1 bootloader identity
# ===========================================================================


class TestCase07ExactPixhawk1BootloaderIdentity:
    def test_exact_pixhawk1_is_resolved_and_verified(self):
        identity = _with_bootloader(_connected_identity(), fx.FIXTURE_A)
        result = compat.resolve(_board9_candidates(), identity)
        assert result.outcome == compat.EXACT_MATCH
        assert result.selected.platform == "Pixhawk1"

    def test_every_cross_check_passes(self):
        identity = _with_bootloader(_connected_identity(), fx.FIXTURE_A)
        result = compat.resolve(_pixhawk1_candidates(), identity)
        assert result.cross_check is not None
        assert result.cross_check.passed
        assert result.cross_check.failed_checks == []

    def test_resolution_reaches_identity_resolved(self):
        transport = RecordingTransport(fx.FIXTURE_A)
        svc = _service(transport=transport, ports=[BOOTLOADER_PORT])
        svc.observe()
        resolution = compat.resolve(
            _pixhawk1_candidates(), _with_bootloader(_connected_identity(), fx.FIXTURE_A)
        )
        svc.machine.apply_resolution(resolution.to_dict())
        assert svc.machine.state == IDENTITY_RESOLVED

    def test_1m_variant_resolves_to_its_own_platform(self):
        identity = _with_bootloader(_connected_identity(), fx.FIXTURE_B)
        result = compat.resolve(_board9_candidates(), identity)
        assert result.selected.platform == "Pixhawk1-1M"


# ===========================================================================
# 8. Multiple platform ambiguity
# ===========================================================================


class TestCase08MultiplePlatformAmbiguity:
    def test_shared_bootloader_string_is_ambiguous(self):
        shared = ["Shared-BL"]
        candidates = _candidates(
            [_entry("PlatformA", shared), _entry("PlatformB", shared)]
        )
        identity = _with_bootloader(_connected_identity(), fx.FIXTURE_A)
        identity.bootloader_str = "Shared-BL"
        result = compat.resolve(candidates, identity)
        assert result.outcome == compat.AMBIGUOUS
        assert result.selected is None
        assert result.platform_count == 2

    def test_machine_records_ambiguity(self):
        svc = _service(ports=[NORMAL_PORT], mavlink_alive=True)
        svc.observe()
        svc.machine.apply_resolution(
            {
                "outcome": compat.AMBIGUOUS,
                "reason": "several platforms remain",
                "selected": None,
                "canConfirm": False,
                "crossCheck": None,
            }
        )
        assert svc.machine.state == IDENTITY_AMBIGUOUS

    def test_first_candidate_is_never_auto_selected(self):
        candidates = _candidates([_entry(f"P{i}", [f"P{i}-BL"]) for i in range(5)])
        identity = _with_bootloader(_connected_identity(), fx.FIXTURE_A)
        identity.bootloader_str = "no-such-board-BL"
        assert compat.resolve(candidates, identity).selected is None


# ===========================================================================
# 9. Disconnect while awaiting bootloader
# ===========================================================================


class TestCase09DisconnectWhileAwaitingBootloader:
    def test_disconnect_moves_to_disconnected(self):
        machine = BootloaderValidationMachine()
        machine.observe_transport(_probe(TRANSPORT_MAVLINK, NORMAL_PORT))
        machine.transition(AWAITING_BOOTLOADER, "prepared")
        machine.handle = None
        machine.observe_transport(_probe(TRANSPORT_NONE, None))
        assert machine.state == DISCONNECTED

    def test_disconnect_clears_the_prepared_record(self):
        svc = _service(ports=[NORMAL_PORT], mavlink_alive=True)
        svc.machine.record = ValidationRecord(
            prepared=True,
            connection_fingerprint="system=1|component=1",
            hardware_fingerprint="vehicle=QUADROTOR",
        )
        svc.machine.observe_transport(_probe(TRANSPORT_MAVLINK, NORMAL_PORT))
        svc.machine.transition(AWAITING_BOOTLOADER, "prepared")
        cleared = svc.handle_connection_change(connected=False)
        assert "validationRecord" in cleared
        assert svc.machine.record.prepared is False

    def test_disconnect_clears_a_bootloader_identity(self):
        transport = RecordingTransport(fx.FIXTURE_A)
        svc = _service(transport=transport, ports=[BOOTLOADER_PORT])
        svc.observe()
        assert svc.machine.identity is not None
        cleared = svc.handle_connection_change(connected=False)
        assert "bootloaderIdentity" in cleared
        assert svc.machine.identity is None

    def test_awaiting_state_does_not_survive_disconnect(self):
        svc = _service(ports=[NORMAL_PORT], mavlink_alive=True)
        svc.observe()
        svc.machine.transition(AWAITING_BOOTLOADER, "prepared")
        svc.handle_connection_change(connected=False)
        assert svc.machine.state == DISCONNECTED


# ===========================================================================
# 10. Reconnect with different device identity
# ===========================================================================


class TestCase10ReconnectDifferentDevice:
    def test_different_usb_serial_is_not_the_same_device(self):
        assert SWAPPED_BOARD_PORT.serial_number != NORMAL_PORT.serial_number

    def test_reconnect_with_different_fingerprint_clears_everything(self):
        svc = _service(ports=[NORMAL_PORT], mavlink_alive=True)
        svc.machine.record = ValidationRecord(
            prepared=True,
            connection_fingerprint="system=1|component=1|transport=serial",
            hardware_fingerprint="vehicle=QUADROTOR",
        )
        cleared = svc.handle_connection_change(
            connected=True,
            connection_fingerprint="system=1|component=1|transport=USB",
            hardware_fingerprint="vehicle=QUADROTOR",
        )
        assert "validationRecord" in cleared

    def test_a_swapped_board_reports_its_own_usb_identity(self):
        first = _service(ports=[NORMAL_PORT], mavlink_alive=True).observe()
        second = _service(ports=[SWAPPED_BOARD_PORT], mavlink_alive=True).observe()
        assert first["usbSerialNumber"] != second["usbSerialNumber"]
        assert first["usbProductString"] != second["usbProductString"]

    def test_reconnect_does_not_reuse_the_old_resolution(self):
        svc = _service(ports=[NORMAL_PORT], mavlink_alive=True)
        svc.machine.resolution = {"outcome": compat.EXACT_MATCH, "selected": "x"}
        svc.handle_connection_change(connected=True, connection_fingerprint="other")
        assert svc.machine.resolution is None


# ===========================================================================
# 11. Stale identity rejection
# ===========================================================================


class TestCase11StaleIdentityRejection:
    def test_stale_identity_is_rejected_without_proof(self):
        machine = BootloaderValidationMachine()
        machine.identity = {"boardId": 9}
        machine.resolution = {"outcome": compat.EXACT_MATCH}
        cleared = machine.clear_stale_identity("disconnected", same_device=False)
        assert "bootloaderIdentity" in cleared
        assert machine.identity is None
        assert machine.resolution is None

    def test_same_device_proof_keeps_the_identity(self):
        machine = BootloaderValidationMachine()
        machine.identity = {"boardId": 9}
        cleared = machine.clear_stale_identity("reconnected", same_device=True)
        assert machine.identity == {"boardId": 9}
        assert "verificationState" in cleared

    def test_verification_state_is_dropped_even_for_the_same_device(self):
        machine = BootloaderValidationMachine()
        machine.identity = {"boardId": 9}
        machine.resolution = {"outcome": compat.EXACT_MATCH}
        machine.clear_stale_identity("reconnected", same_device=True)
        assert machine.resolution is None

    def test_identical_fingerprints_prove_the_same_device(self):
        svc = _service(ports=[NORMAL_PORT], mavlink_alive=True)
        svc.machine.record = ValidationRecord(
            prepared=True,
            connection_fingerprint="A",
            hardware_fingerprint="B",
        )
        cleared = svc.handle_connection_change(
            connected=True, connection_fingerprint="A", hardware_fingerprint="B"
        )
        assert "validationRecord" not in cleared
        assert svc.machine.record.prepared is True

    def test_a_missing_fingerprint_is_never_proof(self):
        svc = _service(ports=[NORMAL_PORT], mavlink_alive=True)
        svc.machine.record = ValidationRecord(
            prepared=True, connection_fingerprint="A", hardware_fingerprint="B"
        )
        cleared = svc.handle_connection_change(
            connected=True, connection_fingerprint=None, hardware_fingerprint=None
        )
        assert "validationRecord" in cleared

    def test_cancel_drops_the_record(self):
        svc = _service(ports=[NORMAL_PORT], mavlink_alive=True)
        svc.machine.record = ValidationRecord(prepared=True, connection_fingerprint="A")
        result = svc.cancel()
        assert result["performedOperations"] == []
        assert svc.machine.record.prepared is False


# ===========================================================================
# 12. No automatic reboot
# ===========================================================================


class TestCase12NoAutomaticReboot:
    def test_validation_service_exposes_no_reboot_method(self):
        public = [n for n in dir(BootloaderValidationService) if not n.startswith("_")]
        for name in public:
            assert "reboot" not in name.lower()
            assert "reset_device" not in name.lower()

    def test_module_exposes_no_forbidden_operation(self):
        import services.bootloader_validation_service as module

        for name in dir(module):
            lowered = name.lower()
            for forbidden in FORBIDDEN_OPERATIONS:
                assert forbidden not in lowered, name

    def test_observe_does_not_reboot(self):
        transport = RecordingTransport(fx.FIXTURE_A)
        svc = _service(transport=transport, ports=[BOOTLOADER_PORT])
        svc.observe()
        assert transport.connects == 1
        assert not hasattr(transport, "rebooted")

    def test_prepare_does_not_reboot_a_normal_board(self, monkeypatch):
        svc = _service(ports=[NORMAL_PORT], mavlink_alive=True)
        calls = []
        import services.firmware_workflow_service as wf

        monkeypatch.setattr(wf, "detect", lambda include_identity=False: {
            "connected": True, "connectionType": "serial", "systemId": 1,
            "componentId": 1, "vehicleType": "QUADROTOR",
            "autopilot": "ARDUPILOTMEGA", "firmwareVersion": "4.7.0",
        })
        monkeypatch.setattr(wf, "connection_fingerprint", lambda d=None: "conn")
        monkeypatch.setattr(wf, "hardware_fingerprint", lambda d=None: "hw")
        result = svc.prepare_bootloader_identity_validation()
        calls.append(result)
        assert result["performedOperations"] == []
        assert result["state"] == AWAITING_BOOTLOADER


# ===========================================================================
# 13. No firmware write
# ===========================================================================


class TestCase13NoFirmwareWrite:
    def test_no_write_method_anywhere_in_the_chain(self):
        for cls in (BootloaderValidationService, BootloaderValidationMachine):
            public = [n for n in dir(cls) if not n.startswith("_")]
            for name in public:
                for forbidden in ("write", "erase", "flash", "upload", "program"):
                    assert forbidden not in name.lower(), f"{cls.__name__}.{name}"

    def test_machine_holds_no_device_handle(self):
        machine = BootloaderValidationMachine()
        payload = machine.snapshot()
        assert set(payload) == {
            "state", "history", "record", "identity", "resolution", "lastCleared"
        }

    def test_prepare_returns_no_performed_write(self, monkeypatch):
        svc = _service(ports=[NORMAL_PORT], mavlink_alive=True)
        import services.firmware_workflow_service as wf

        monkeypatch.setattr(wf, "detect", lambda include_identity=False: {
            "connected": True, "connectionType": "serial", "systemId": 1,
            "componentId": 1, "vehicleType": "QUADROTOR",
            "autopilot": "ARDUPILOTMEGA", "firmwareVersion": "4.7.0",
        })
        monkeypatch.setattr(wf, "connection_fingerprint", lambda d=None: "conn")
        monkeypatch.setattr(wf, "hardware_fingerprint", lambda d=None: "hw")
        assert svc.prepare_bootloader_identity_validation()["performedOperations"] == []

    def test_identity_read_never_writes_to_the_transport(self):
        transport = RecordingTransport(fx.FIXTURE_A)
        svc = _service(transport=transport, ports=[BOOTLOADER_PORT])
        svc.observe()
        # Only connect() and read_info() were used; both are read-only.
        assert transport.reads == 1
        assert not hasattr(transport, "written")


# ===========================================================================
# 14. No downloader contact before exact compatibility
# ===========================================================================


class TestCase14NoDownloaderBeforeExactMatch:
    def test_resolver_confirms_nothing_without_a_bootloader_identity(self):
        identity = _connected_identity(board_id=9)
        result = compat.resolve(_board9_candidates(), identity)
        assert result.can_confirm is False

    def test_no_candidate_is_selected_without_a_bootloader_identity(self):
        identity = _connected_identity()
        result = compat.resolve(_board9_candidates(), identity)
        assert result.selected is None
        assert result.outcome == compat.IDENTITY_UNAVAILABLE

    def test_board_id_alone_confirms_nothing(self):
        identity = _connected_identity(board_id=9)
        assert compat.resolve(_board9_candidates(), identity).can_confirm is False

    def test_conflicting_usb_confirms_nothing(self):
        identity = _with_bootloader(_connected_identity(), fx.FIXTURE_A)
        identity.usb_id = "0x2d00/0x1015"
        assert compat.resolve(_pixhawk1_candidates(), identity).can_confirm is False

    def test_only_a_cross_checked_exact_match_confirms(self):
        identity = _with_bootloader(_connected_identity(), fx.FIXTURE_A)
        result = compat.resolve(_pixhawk1_candidates(), identity)
        assert result.outcome == compat.EXACT_MATCH
        assert result.cross_check.passed
        assert result.can_confirm is True

    def test_real_installation_stays_permanently_gated(self):
        from services import firmware_install_service as install_svc

        assert install_svc.REAL_INSTALLATION_ALLOWED is False


# ===========================================================================
# State machine invariants
# ===========================================================================


class TestStateMachineInvariants:
    def test_all_nine_states_exist(self):
        assert len(ALL_STATES) == 9
        for name in (
            NORMAL_MAVLINK,
            AWAITING_BOOTLOADER,
            BOOTLOADER_DETECTED,
            BOOTLOADER_IDENTITY_READING,
            BOOTLOADER_IDENTITY_READ,
            IDENTITY_RESOLVED,
            IDENTITY_AMBIGUOUS,
            IDENTITY_FAILED,
            DISCONNECTED,
        ):
            assert name in ALL_STATES

    def test_bootloader_detected_is_reachable_only_from_real_predecessors(self):
        allowed = ALLOWED_TRANSITIONS
        for state in ALL_STATES:
            if state in (AWAITING_BOOTLOADER, NORMAL_MAVLINK, DISCONNECTED,
                         BOOTLOADER_DETECTED, IDENTITY_FAILED):
                continue
            assert BOOTLOADER_DETECTED not in allowed[state], state

    def test_illegal_transition_is_refused(self):
        machine = BootloaderValidationMachine()
        machine.state = BOOTLOADER_IDENTITY_READ
        with pytest.raises(IllegalTransition):
            machine.transition(BOOTLOADER_DETECTED, "illegal backwards move")

    def test_unknown_state_is_refused(self):
        with pytest.raises(IllegalTransition):
            BootloaderValidationMachine().transition("NOT_A_STATE")

    def test_every_state_has_a_transition_table(self):
        for state in ALL_STATES:
            assert state in ALLOWED_TRANSITIONS
            for target in ALLOWED_TRANSITIONS[state]:
                assert target in ALL_STATES

    def test_disconnected_can_always_be_reached(self):
        for state in ALL_STATES:
            if state == DISCONNECTED:
                continue
            assert DISCONNECTED in ALLOWED_TRANSITIONS[state], state


# ===========================================================================
# 15. End-to-end status payload through the real resolver path
#
# These drive the actual `identity_status()` entry point instead of feeding a
# hand-built identity straight into the resolver, because the two can disagree:
# the machine can hold a complete, validated bootloader identity while the status
# payload still reports NO_DEVICE, since a board in bootloader mode cannot answer
# MAVLink. That contradiction was a real bug, so it is pinned down here.
# ===========================================================================


def _small_catalog(entries):
    """Stub the catalogue so resolution is deterministic and offline."""
    import services.firmware_catalog_service as catalog_service

    return type(
        "StubCatalog",
        (),
        {
            "candidates": _candidates(entries),
            "ok": True,
            "message": "synthetic catalogue",
        },
    )()


def _prepared_service(monkeypatch, *, entries, bootloader_port=None, fixture=fx.FIXTURE_A):
    """Prepare on a normal board, then hand back the service re-enumerated as a bootloader.

    This mirrors production as closely as the tests allow: the *same* identity
    service instance is used throughout, its USB port list is mutated in place,
    and MAVLink liveness is answered by a patched live status. Nothing is
    re-wired behind the validation service's back, so the state transitions under
    test are the ones the real process would take.
    """
    import core.state
    import services.bootloader_validation_service as validation  # noqa: F401
    import services.firmware_catalog_service as catalog_service
    import services.firmware_workflow_service as wf
    import services.setup_service as setup_service

    monkeypatch.setattr(catalog_service, "get_catalog", lambda vehicle=None: _small_catalog(entries))

    # Mutable, so the board can re-enumerate exactly as it would in reality.
    ports = [NORMAL_PORT]
    mavlink = {"connected": True}
    monkeypatch.setattr(core.state, "get_vehicle_status", lambda: dict(mavlink))
    monkeypatch.setattr(setup_service, "request_firmware_info", lambda: {
        "success": True, "connected": True, "boardVersion": 589824, "boardType": 0,
        "boardRev": 9, "connectionType": "USB", "systemId": 1, "componentId": 1,
    })

    service = BootloaderValidationService(
        identity_service=BootloaderIdentityService(
            fx.FixtureBootloaderTransport(fixture), ports=ports
        ),
        mavlink_info=None,
    )

    monkeypatch.setattr(wf, "detect", lambda include_identity=False: {
        "connected": True, "connectionType": "serial", "systemId": 1,
        "componentId": 1, "vehicleType": "QUADROTOR",
        "autopilot": "ARDUPILOTMEGA", "firmwareVersion": "4.7.0",
    })
    monkeypatch.setattr(wf, "connection_fingerprint", lambda d=None: "conn")
    monkeypatch.setattr(wf, "hardware_fingerprint", lambda d=None: "hw")
    prepared = service.prepare_bootloader_identity_validation()
    assert prepared["state"] == AWAITING_BOOTLOADER
    assert service.machine.record.vehicle_type == "QUADROTOR"

    # The board re-enumerates as a bootloader: new product string, and it stops
    # answering MAVLink entirely.
    ports[:] = [bootloader_port or BOOTLOADER_PORT]
    mavlink["connected"] = False
    # In bootloader mode there is no MAVLink reply, so the normal identity
    # source is genuinely unavailable.
    monkeypatch.setattr(wf, "build_identity", lambda: None)
    return service


class TestCase15EndToEndStatusResolution:
    def test_complete_bootloader_identity_resolves_through_the_status_endpoint(self, monkeypatch):
        from services.bootloader_validation_service import identity_status

        service = _prepared_service(monkeypatch, entries=[_entry("Pixhawk1", ["Pixhawk1-BL"])])
        status = identity_status(service=service)

        assert status["bootloaderIdentityAvailable"] is True
        assert status["resolver"]["outcome"] == compat.EXACT_MATCH
        assert status["resolver"]["canConfirm"] is True
        assert status["resolver"]["selected"]["platform"] == "Pixhawk1"
        assert status["resolver"]["crossCheck"]["passed"] is True
        assert status["resolver"]["crossCheck"]["failedChecks"] == []

    def test_status_does_not_contradict_the_machine_state(self, monkeypatch):
        from services.bootloader_validation_service import identity_status

        service = _prepared_service(monkeypatch, entries=[_entry("Pixhawk1", ["Pixhawk1-BL"])])
        status = identity_status(service=service)

        # A resolved outcome and IDENTITY_RESOLVED must agree; the old bug
        # reported NO_DEVICE while the machine sat in IDENTITY_RESOLVED.
        if status["resolver"]["outcome"] == compat.EXACT_MATCH:
            assert status["validation"]["state"] == IDENTITY_RESOLVED
        assert status["resolver"]["outcome"] != compat.NO_DEVICE

    def test_distinct_bootloader_strings_still_disambiguate(self, monkeypatch):
        """The whole point of the bootloader string: it separates board 9."""
        from services.bootloader_validation_service import identity_status

        service = _prepared_service(monkeypatch, entries=_board9_entries())
        status = identity_status(service=service)

        # Board id 9 alone spans four platforms, but the bootloader's own product
        # string matches exactly one of them.
        assert status["resolver"]["outcome"] == compat.EXACT_MATCH
        assert status["resolver"]["selected"]["platform"] == "Pixhawk1"

    def test_shared_bootloader_string_reports_ambiguous_not_no_device(self, monkeypatch):
        from services.bootloader_validation_service import identity_status

        shared = ["Pixhawk1-BL"]
        service = _prepared_service(
            monkeypatch,
            entries=[_entry("Pixhawk1", shared), _entry("Pixhawk1Clone", shared)],
        )
        status = identity_status(service=service)

        assert status["resolver"]["outcome"] == compat.AMBIGUOUS
        assert status["resolver"]["selected"] is None
        assert status["resolver"]["canConfirm"] is False
        assert status["installationBlocked"] is True

    def test_a_swapped_board_cannot_borrow_the_recorded_vehicle_type(self, monkeypatch):
        from services.bootloader_validation_service import identity_status

        service = _prepared_service(
            monkeypatch,
            entries=[_entry("Pixhawk1", ["Pixhawk1-BL"])],
            bootloader_port=SWAPPED_BOARD_PORT,
        )
        status = identity_status(service=service)

        # The bootloader identity itself is real, but the prepared record belongs
        # to a different USB serial, so its vehicle type is not evidence here.
        assert status["resolver"]["selected"] is None
        assert status["resolver"]["canConfirm"] is False

    def test_without_a_preparation_no_vehicle_context_means_no_selection(self, monkeypatch):
        from services.bootloader_validation_service import identity_status

        import services.firmware_catalog_service as catalog_service
        import services.firmware_workflow_service as wf

        monkeypatch.setattr(
            catalog_service, "get_catalog",
            lambda vehicle=None: _small_catalog([_entry("Pixhawk1", ["Pixhawk1-BL"])]),
        )
        service = _service(
            transport=fx.FixtureBootloaderTransport(fx.FIXTURE_A), ports=[BOOTLOADER_PORT]
        )
        monkeypatch.setattr(wf, "build_identity", lambda: None)

        status = identity_status(service=service)
        assert status["bootloaderIdentityAvailable"] is True
        assert status["resolver"]["selected"] is None
        assert status["resolver"]["canConfirm"] is False

    def test_resolution_never_writes_or_reboots(self, monkeypatch):
        from services.bootloader_validation_service import identity_status

        transport = RecordingTransport(fx.FIXTURE_A)
        service = _service(transport=transport, ports=[NORMAL_PORT], mavlink_alive=True)

        import services.firmware_workflow_service as wf

        monkeypatch.setattr(wf, "detect", lambda include_identity=False: {
            "connected": True, "connectionType": "serial", "systemId": 1,
            "componentId": 1, "vehicleType": "QUADROTOR",
            "autopilot": "ARDUPILOTMEGA", "firmwareVersion": "4.7.0",
        })
        monkeypatch.setattr(wf, "connection_fingerprint", lambda d=None: "conn")
        monkeypatch.setattr(wf, "hardware_fingerprint", lambda d=None: "hw")
        service.prepare_bootloader_identity_validation()
        service.identity_service = BootloaderIdentityService(
            transport, ports=[BOOTLOADER_PORT], mavlink_alive=False
        )
        monkeypatch.setattr(wf, "build_identity", lambda: None)

        status = identity_status(service=service)
        assert status["performedOperations"] == []
        assert not hasattr(transport, "rebooted")


# ===========================================================================
# 16. Exhaustive transition matrix
#
# Requirement: every state transition is tested. Rather than spot-checking a
# handful of edges, this walks the whole (from, to) grid. Every declared edge
# must be accepted, and every undeclared edge must be refused -- so the table
# cannot quietly grow a transition nobody intended, and cannot quietly lose one.
# ===========================================================================


def _machine_in(state, *, identity=None, resolution=None):
    machine = BootloaderValidationMachine()
    machine.state = state
    if identity is not None:
        machine.identity = identity
    if resolution is not None:
        machine.resolution = resolution
    return machine


class TestCase16EveryTransition:
    def test_every_declared_transition_is_accepted(self):
        checked = 0
        for source, targets in ALLOWED_TRANSITIONS.items():
            for target in targets:
                machine = _machine_in(source)
                assert machine.transition(target, "matrix check") == target
                assert machine.state == target
                assert machine.history[-1]["from"] == source
                assert machine.history[-1]["to"] == target
                checked += 1
        assert checked > 0

    def test_every_undeclared_transition_is_refused(self):
        checked = 0
        for source in ALL_STATES:
            allowed = set(ALLOWED_TRANSITIONS[source])
            for target in ALL_STATES:
                # A self-transition is a deliberate no-op (see transition()).
                if target in allowed or target == source:
                    continue
                machine = _machine_in(source)
                with pytest.raises(IllegalTransition):
                    machine.transition(target, "must not be allowed")
                assert machine.state == source, f"{source} -> {target} moved anyway"
                checked += 1
        assert checked > 0

    def test_no_self_transition_is_declared(self):
        for state, targets in ALLOWED_TRANSITIONS.items():
            assert state not in targets, f"{state} declares a self-transition"

    def test_disconnected_is_reachable_from_every_state(self):
        for state in ALL_STATES:
            if state == DISCONNECTED:
                # Already there; re-observing "no device" is a no-op.
                machine = _machine_in(state)
                assert machine.observe_transport(_probe(TRANSPORT_NONE)) == DISCONNECTED
                continue
            assert DISCONNECTED in ALLOWED_TRANSITIONS[state], state

    def test_a_silent_board_never_keeps_a_resolved_identity(self):
        """Losing MAVLink without bootloader evidence invalidates the answer."""
        machine = _machine_in(IDENTITY_RESOLVED, identity={"boardId": 9})
        assert machine.observe_transport(_probe(TRANSPORT_UNKNOWN)) == IDENTITY_FAILED

    def test_bootloader_detected_requires_positive_evidence_not_silence(self):
        # Every edge into BOOTLOADER_DETECTED exists, but observe_transport is the
        # only path there and it demands a BOOTLOADER probe. Silence (UNKNOWN)
        # must never arrive there from any state.
        for state in ALL_STATES:
            machine = _machine_in(state)
            result = machine.observe_transport(_probe(TRANSPORT_UNKNOWN))
            assert result != BOOTLOADER_DETECTED, state

    def test_awaiting_survives_a_board_that_is_still_on_mavlink(self):
        machine = _machine_in(AWAITING_BOOTLOADER)
        assert machine.observe_transport(_probe(TRANSPORT_MAVLINK)) == AWAITING_BOOTLOADER

    def test_awaiting_is_cleared_when_the_board_really_does_reach_a_bootloader(self):
        machine = _machine_in(AWAITING_BOOTLOADER)
        assert machine.observe_transport(_probe(TRANSPORT_BOOTLOADER)) == BOOTLOADER_DETECTED

    def test_normal_mavlink_to_detected_to_resolved(self):
        """The one happy path, asserted end to end across the real edges."""
        machine = _machine_in(NORMAL_MAVLINK)
        assert machine.observe_transport(_probe(TRANSPORT_BOOTLOADER)) == BOOTLOADER_DETECTED

        class _Report:
            transport = type("T", (), {"kind": TRANSPORT_BOOTLOADER})()
            can_resolve_platform = True
            missing_fields: list = []

            def to_dict(self):
                return {"canResolvePlatform": True, "bootloaderRevision": 4}

        assert machine.observe_identity(_Report()) == IDENTITY_RESOLVED

    def test_returning_to_mavlink_from_a_terminal_state_back_to_normal(self):
        for source in (IDENTITY_RESOLVED, IDENTITY_AMBIGUOUS, IDENTITY_FAILED):
            machine = _machine_in(source, identity={"x": 1})
            assert machine.observe_transport(_probe(TRANSPORT_MAVLINK)) == NORMAL_MAVLINK

    def test_unsupported_target_is_not_reported_as_ambiguity(self):
        machine = _machine_in(BOOTLOADER_IDENTITY_READ)
        state = machine.apply_resolution(
            {
                "outcome": compat.UNSUPPORTED,
                "reason": "the connected target is not an ArduCopter",
                "selected": None,
                "canConfirm": False,
                "crossCheck": None,
            }
        )
        # Zero images apply, so "more than one possibility" would be false.
        assert state == IDENTITY_FAILED
        assert "not an ArduCopter" in machine.history[-1]["reason"]


class TestCase16bObserveNeverRaises:
    """The read-only status path must never raise, from any state.

    The UI asks for status repeatedly, and a board can vanish, come back, go
    quiet, or turn out to be a normal board at any moment. Every one of those is
    an ordinary observation, so none of them may surface as an error instead of
    an honest status.
    """

    @pytest.mark.parametrize("source", ALL_STATES)
    @pytest.mark.parametrize("kind", [TRANSPORT_NONE, TRANSPORT_MAVLINK,
                                      TRANSPORT_BOOTLOADER, TRANSPORT_UNKNOWN])
    def test_no_state_and_transport_combination_raises(self, source, kind):
        machine = _machine_in(source, identity={"boardId": 9})
        result = machine.observe_transport(_probe(kind))
        assert result in ALL_STATES
        assert result != BOOTLOADER_DETECTED or kind == TRANSPORT_BOOTLOADER

    @pytest.mark.parametrize("source", ALL_STATES)
    def test_repeated_observation_of_the_same_transport_is_stable(self, source):
        for kind in (TRANSPORT_NONE, TRANSPORT_MAVLINK, TRANSPORT_UNKNOWN):
            machine = _machine_in(source)
            first = machine.observe_transport(_probe(kind))
            second = machine.observe_transport(_probe(kind))
            assert first == second, (source, kind)
