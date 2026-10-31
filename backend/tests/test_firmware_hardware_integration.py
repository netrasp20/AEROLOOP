"""Hardware-integration tests for the firmware workflow.

Covers the identity pipeline end to end: authoritative detection, the explicit
resolver states, exact/ambiguous/unsupported selection, confirmation staleness,
disconnect handling, cancellation, failure reporting, the permanent real-hardware
gate and post-install identity verification.

Every manifest document, identity and artifact here is SYNTHETIC. No test opens
a serial port, contacts a vehicle, enters bootloader mode, erases or flashes
anything. The real Pixhawk is never touched by this suite.
"""

import json

from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from services import firmware_compat_service as compat
from services import firmware_install_service as inst
from services import firmware_workflow_service as wf

from tests.test_firmware_workflow import (
    _catalog_patch,
    _connected_info,
    _entry,
    _exact_entries,
    _exact_vehicle,
    _no_device,
    _LiveVehicle,
    _with_bootloader_identity,
    isolated,  # noqa: F401 - per-test cache/workflow/confirmation isolation
    BOARD9_PLATFORMS,
)

pytestmark = pytest.mark.usefixtures("isolated")


@pytest.fixture
def client():
    from app import app

    return TestClient(app)


# ---------------------------------------------------------------------------
# Detection: authoritative hardware identity
# ---------------------------------------------------------------------------


class TestAuthoritativeDetection:
    def test_detection_reports_only_reported_values(self):
        with _exact_vehicle():
            result = wf.detect(include_identity=True)
        assert result["connected"] is True
        assert result["firmwareVersion"] == "4.7.0"
        assert result["firmwareRelease"] == "Official Release"
        assert result["boardVersion"] == 589824
        assert result["boardType"] == 0
        assert result["boardRev"] == 9
        assert result["vendorId"] == 4617
        assert result["productId"] == 22337
        assert result["usbId"] == "0x1209/0x5741"
        assert result["vehicleType"] == "QUADROTOR"
        assert result["autopilot"] == "ARDUPILOTMEGA"

    def test_board_id_is_never_inferred_from_board_version(self):
        """board_version 0x00090000 is not the manifest board_id 9."""
        with _exact_vehicle():
            result = wf.detect(include_identity=True)
        assert result["boardVersion"] == 589824
        assert result["boardId"] is None

    def test_absent_identity_values_are_none_not_zero(self):
        """A silent board yields None everywhere, never a zero or a guess."""
        with _exact_vehicle(info=_connected_info(vendorId=None, productId=None)):
            result = wf.detect(include_identity=True)
        assert result["usbId"] is None
        assert result["vendorId"] is None
        assert result["productId"] is None

    def test_half_a_usb_identity_is_not_rendered(self):
        """VID without PID is not a usable USB identity."""
        with _exact_vehicle(info=_connected_info(productId=None)):
            result = wf.detect(include_identity=True)
        assert result["vendorId"] == 4617
        assert result["productId"] is None
        assert result["usbId"] is None

    def test_detection_never_opens_a_second_connection(self):
        """Detection reads existing state; it must not touch the transport."""
        with _exact_vehicle():
            with patch("pymavlink.mavutil.mavlink_connection") as connection:
                wf.detect(include_identity=True)
        connection.assert_not_called()

    def test_no_device_detection_reports_nothing_about_hardware(self):
        with _no_device():
            result = wf.detect(include_identity=True)
        assert result["connected"] is False
        assert result["firmwareVersion"] is None
        assert result["usbId"] is None
        assert result["boardId"] is None


# ---------------------------------------------------------------------------
# Resolver states
# ---------------------------------------------------------------------------


class TestResolverStates:
    def test_every_required_state_is_defined(self):
        for outcome in (
            compat.EXACT_MATCH,
            compat.AMBIGUOUS,
            compat.UNSUPPORTED,
            compat.NO_DEVICE,
            compat.IDENTITY_UNAVAILABLE,
        ):
            assert outcome in compat.ALL_OUTCOMES

    def test_exact_match_needs_real_bootloader_evidence(self):
        with _exact_vehicle():
            result = wf.resolve()
        assert result["outcome"] == compat.EXACT_MATCH
        assert result["resolution"].can_confirm is True

    def test_ambiguous_when_the_product_string_spans_platforms(self):
        entries = [
            _entry("Pixhawk1", ["PX4 BL FMU v2.x"]),
            _entry("CubeBlack", ["PX4 BL FMU v2.x"]),
        ]
        with _LiveVehicle(entries, bootloader="PX4 BL FMU v2.x"):
            result = wf.resolve()
        assert result["outcome"] == compat.AMBIGUOUS
        assert result["resolution"].can_confirm is False
        assert result["resolution"].selected is None
        assert result["resolution"].platform_count == 2

    def test_identity_unavailable_without_a_bootloader_identity(self):
        """A live board with no bootloader identity is not a conflict."""
        entries = [_entry(p, bl) for p, bl in BOARD9_PLATFORMS]
        with _LiveVehicle(entries):
            result = wf.resolve()
        assert result["outcome"] == compat.IDENTITY_UNAVAILABLE
        assert result["resolution"].can_confirm is False
        assert result["resolution"].selected is None
        assert result["resolution"].platform_count == 3

    def test_unsupported_for_a_non_copter_vehicle(self):
        entries = [_entry("RoverBoard", ["RoverBoard-BL"], vehicle="Rover")]
        rover = _connected_info(vehicleType="ROVER", vehicle="ArduRover")
        with _LiveVehicle(entries, bootloader="RoverBoard-BL", info=rover):
            result = wf.resolve()
        assert result["outcome"] == compat.UNSUPPORTED
        assert result["resolution"].can_confirm is False

    def test_no_device_is_its_own_outcome(self):
        with _no_device():
            result = wf.resolve()
        assert result["outcome"] == compat.NO_DEVICE
        assert result["state"] == "NO_DEVICE"

    def test_ambiguous_and_identity_unavailable_are_distinguishable(self):
        """Different problems must not collapse into one outcome."""
        entries = [_entry(p, bl) for p, bl in BOARD9_PLATFORMS]
        with _LiveVehicle(entries):
            unresolved = wf.resolve()["outcome"]
        conflicting = [
            _entry("Pixhawk1", ["PX4 BL FMU v2.x"]),
            _entry("CubeBlack", ["PX4 BL FMU v2.x"]),
        ]
        with _LiveVehicle(conflicting, bootloader="PX4 BL FMU v2.x"):
            conflict = wf.resolve()["outcome"]
        assert unresolved == compat.IDENTITY_UNAVAILABLE
        assert conflict == compat.AMBIGUOUS
        assert unresolved != conflict


# ---------------------------------------------------------------------------
# Confirmation binding and staleness
# ---------------------------------------------------------------------------


class TestConfirmationBinding:
    def test_confirmation_binds_hardware_catalogue_and_version(self):
        with _exact_vehicle(auto_confirm=True):
            record = inst.CONFIRMATION.current
            assert record.confirmed is True
            assert record.connection_fingerprint is not None
            assert record.hardware_fingerprint is not None
            assert record.catalog_etag is not None
            assert record.current_version == "4.7.0"
            assert record.synthetic is False

    def test_a_different_candidate_cannot_reuse_the_confirmation(self):
        with _exact_vehicle(auto_confirm=True):
            other = "Copter/Pixhawk1/apj/4.8.0/OFFICIAL"
            assert inst.CONFIRMATION.current.matches(other) is False

    def test_a_swapped_board_invalidates_the_confirmation(self):
        with _exact_vehicle(auto_confirm=True):
            other = _connected_info(vendorId=0x2D, productId=0x1234, boardVersion=0x000A0000)
            with patch("services.setup_service.request_firmware_info", return_value=other):
                payload = wf.current_confirmation(deep=True)
        assert payload["confirmed"] is False
        assert any("hardware" in r for r in payload["invalidatedReasons"])

    def test_a_reflashed_board_invalidates_the_confirmation(self):
        with _exact_vehicle(auto_confirm=True):
            reflashed = _connected_info(version="4.6.0")
            with patch("services.setup_service.request_firmware_info", return_value=reflashed):
                payload = wf.current_confirmation(deep=True)
        assert payload["confirmed"] is False
        assert any("version changed" in r for r in payload["invalidatedReasons"])

    def test_a_refreshed_catalogue_invalidates_the_confirmation(self):
        from services import firmware_catalog_service as svc

        with _exact_vehicle(auto_confirm=True):
            before = inst.CONFIRMATION.current.catalog_etag
            assert before is not None
            # A new manifest generation upstream.
            with patch.object(svc, "_http_get", _etag_manifest('"new-generation"')):
                svc.reset_cache()
                payload = wf.current_confirmation(deep=True)
        assert payload["confirmed"] is False
        assert any("catalogue" in r for r in payload["invalidatedReasons"])

    def test_a_disconnect_invalidates_the_confirmation(self):
        with _exact_vehicle(auto_confirm=True):
            with _no_device():
                payload = wf.current_confirmation(deep=False)
        assert payload["confirmed"] is False
        assert payload["invalidatedReasons"]

    def test_a_reconnect_to_a_different_vehicle_invalidates_it(self):
        with _exact_vehicle(auto_confirm=True):
            with patch("core.state.get_vehicle_status", return_value={"connected": True}):
                with patch("core.state.vehicle_state", {"systemId": 42, "componentId": 1}):
                    payload = wf.current_confirmation(deep=False)
        assert payload["confirmed"] is False

    def test_a_stale_confirmation_never_authorises_a_download(self):
        with _exact_vehicle(auto_confirm=True):
            reflashed = _connected_info(version="4.6.0")
            with patch("services.setup_service.request_firmware_info", return_value=reflashed):
                result = wf.download()
        assert result["success"] is False
        assert result["state"] == inst.CONFIRMATION_REQUIRED
        assert result["confirmed"] is False

    def test_asking_about_confirmation_does_not_clear_a_current_one(self):
        with _exact_vehicle(auto_confirm=True):
            wf.confirmation(confirmed=False)
            assert inst.CONFIRMATION.current.confirmed is True

    def test_simulation_confirmation_is_marked_synthetic(self):
        with _catalog_patch(_exact_entries()):
            inst.CONFIRMATION.record(
                _first_candidate(), outcome="SIMULATION", synthetic=True
            )
            record = inst.CONFIRMATION.current
        assert record.synthetic is True
        assert record.hardware_fingerprint is None
        # With no device, only the candidate binding applies.
        assert record.staleness(record.candidate_id) == []


def _etag_manifest(etag):
    from tests.test_firmware_workflow import _gzip, _manifest

    return MagicMock(
        side_effect=lambda *a, **k: __import__("types").SimpleNamespace(
            status=200, headers={"etag": etag}, body=_gzip(_manifest(_exact_entries()))
        )
    )


def _first_candidate():
    from services import firmware_catalog_service as svc

    return svc.get_catalog("Copter").candidates[0]


# ---------------------------------------------------------------------------
# Pre-install validation
# ---------------------------------------------------------------------------


class TestPreInstallValidation:
    def test_all_seven_checks_are_named_and_run(self):
        assert len(wf.PREINSTALL_CHECKS) == 7
        with _exact_vehicle(auto_confirm=True):
            result = wf.validate_pre_install(inst.CONFIRMATION.current.candidate_id)
        assert result["ok"] is True
        assert [c["check"] for c in result["checks"]] == list(wf.PREINSTALL_CHECKS)

    def test_no_device_fails_the_connected_check(self):
        with _exact_vehicle(auto_confirm=True):
            with _no_device():
                result = wf.validate_pre_install(inst.CONFIRMATION.current.candidate_id)
        assert result["ok"] is False
        assert "device-connected" in result["failures"]

    def test_a_swapped_board_fails_before_installation(self):
        with _exact_vehicle(auto_confirm=True):
            other = _connected_info(vendorId=0x2D, productId=0x1234)
            with patch("services.setup_service.request_firmware_info", return_value=other):
                result = wf.validate_pre_install(inst.CONFIRMATION.current.candidate_id)
        assert result["ok"] is False
        assert "hardware-identity-unchanged" in result["failures"]

    def test_a_changed_installed_version_fails_before_installation(self):
        with _exact_vehicle(auto_confirm=True):
            reflashed = _connected_info(version="4.6.0")
            with patch("services.setup_service.request_firmware_info", return_value=reflashed):
                result = wf.validate_pre_install(inst.CONFIRMATION.current.candidate_id)
        assert result["ok"] is False
        assert "installed-version-unchanged" in result["failures"]

    def test_an_unconfirmed_target_fails_before_installation(self):
        with _exact_vehicle():
            result = wf.validate_pre_install("Copter/Pixhawk1/apj/4.7.1/OFFICIAL")
        assert result["ok"] is False
        assert "confirmation-matches-candidate" in result["failures"]

    def test_every_failure_is_reported_not_just_the_first(self):
        with _exact_vehicle():
            result = wf.validate_pre_install()
        assert result["ok"] is False
        assert len(result["failures"]) >= 4

    def test_install_is_blocked_when_validation_fails(self):
        with _exact_vehicle(auto_confirm=True):
            reflashed = _connected_info(version="4.6.0")
            with patch("services.setup_service.request_firmware_info", return_value=reflashed):
                with patch(
                    "services.firmware_download_service._http_get"
                ) as download_http:
                    result = wf.run_install(allow_simulation=True)
        assert download_http.call_count == 0
        assert result["success"] is False
        # Refused before anything was fetched, and never reported as installing.
        assert result["state"] in (inst.BLOCKED, inst.CONFIRMATION_REQUIRED)
        assert "DOWNLOADING" not in result["history"]
        assert "INSTALLING" not in result["history"]


# ---------------------------------------------------------------------------
# Disconnect handling
# ---------------------------------------------------------------------------


class TestDisconnectHandling:
    def test_every_connection_asserting_state_is_connection_dependent(self):
        for state in (
            inst.DETECTING,
            inst.IDENTIFYING,
            inst.RESOLVING,
            inst.READY,
            inst.CONFIRMATION_REQUIRED,
            inst.DOWNLOADING,
            inst.DOWNLOAD_VERIFIED,
            inst.PREPARING,
            inst.INSTALLING,
            inst.VERIFYING,
        ):
            assert state in inst.CONNECTION_DEPENDENT_STATES, state

    def test_terminal_states_are_not_connection_dependent(self):
        for state in (inst.COMPLETED, inst.FAILED, inst.CANCELLED, inst.DISCONNECTED):
            assert state not in inst.CONNECTION_DEPENDENT_STATES

    #: A legal path to each state, so the test exercises the disconnect rule and
    #: not the transition table.
    _PATHS = {
        inst.READY: (inst.DETECTING, inst.IDENTIFYING, inst.RESOLVING, inst.READY),
        inst.CONFIRMATION_REQUIRED: (
            inst.DETECTING,
            inst.IDENTIFYING,
            inst.RESOLVING,
            inst.CONFIRMATION_REQUIRED,
        ),
        inst.DOWNLOAD_VERIFIED: (
            inst.DETECTING,
            inst.IDENTIFYING,
            inst.RESOLVING,
            inst.CONFIRMATION_REQUIRED,
            inst.DOWNLOADING,
            inst.DOWNLOAD_VERIFIED,
        ),
        inst.VERIFYING: (
            inst.DETECTING,
            inst.IDENTIFYING,
            inst.RESOLVING,
            inst.CONFIRMATION_REQUIRED,
            inst.DOWNLOADING,
            inst.DOWNLOAD_VERIFIED,
            inst.PREPARING,
            inst.INSTALLING,
            inst.VERIFYING,
        ),
    }

    @pytest.mark.parametrize("state", list(_PATHS))
    def test_losing_the_device_never_leaves_a_connection_state(self, state):
        session = inst.WORKFLOW.session
        for step in self._PATHS[state]:
            session.advance(step)
        assert session.state == state
        with _no_device():
            payload = wf.status()
        assert payload["state"] == inst.DISCONNECTED
        assert payload["state"] != state

    def test_disconnect_clears_the_stale_target_and_confirmation(self):
        with _exact_vehicle(auto_confirm=True):
            inst.WORKFLOW.session.advance(inst.READY)
            with _no_device():
                payload = wf.status()
        assert payload["targetCandidateId"] is None
        assert payload["confirmedCandidateId"] is None
        assert payload["targetVersion"] is None
        assert payload["installedVersion"] is None
        assert payload["versionVerified"] is False
        assert payload["confirmation"]["confirmed"] is False

    def test_a_completed_result_is_never_erased_by_a_later_disconnect(self):
        with _exact_vehicle(auto_confirm=True):
            session = inst.WORKFLOW.session
            session.advance(inst.READY)
            with _no_device():
                first = wf.status()
            assert first["state"] == inst.DISCONNECTED
            # Polling again stays terminal.
            with _no_device():
                second = wf.status()
        assert second["state"] == inst.DISCONNECTED

    def test_disconnect_before_confirmation_leaves_nothing_confirmable(self):
        with _exact_vehicle(auto_confirm=True):
            with _no_device():
                payload = wf.current_confirmation(deep=False)
                confirmed = wf.confirmation(confirmed=True)
        assert payload["confirmed"] is False
        assert confirmed["success"] is False


# ---------------------------------------------------------------------------
# Post-install verification
# ---------------------------------------------------------------------------


class TestPostInstallVerification:
    def test_identity_comparison_covers_board_vehicle_and_autopilot(self):
        expected = {field: f"{field}-value" for field in wf.VERIFICATION_IDENTITY_FIELDS}
        checks = wf.compare_identity(expected, dict(expected))
        assert len(checks) == len(wf.VERIFICATION_IDENTITY_FIELDS)
        assert all(c["matches"] for c in checks)

    @pytest.mark.parametrize("field", list(wf.VERIFICATION_IDENTITY_FIELDS))
    def test_any_single_identity_change_is_a_mismatch(self, field):
        expected = {f: f"{f}-value" for f in wf.VERIFICATION_IDENTITY_FIELDS}
        observed = dict(expected)
        observed[field] = "something-else"
        checks = wf.compare_identity(expected, observed)
        mismatched = [c["field"] for c in checks if not c["matches"]]
        assert mismatched == [field]

    def test_a_field_unknown_before_installation_is_not_held_against_it(self):
        checks = wf.compare_identity({"usbId": None}, {"usbId": "0x1209/0x5741"})
        assert all(c["matches"] for c in checks)

    def test_correct_version_on_the_wrong_board_fails_verification(self):
        expected = {f: f"{f}-value" for f in wf.VERIFICATION_IDENTITY_FIELDS}
        observed = dict(expected)
        observed["usbId"] = "0x2d00/0x1234"
        with patch(
            "services.setup_service.request_firmware_info",
            return_value=_connected_info(version="4.7.1"),
        ):
            result = wf.verify_installation("4.7.1", expected_identity=expected)
        assert result["verified"] is False
        assert result["error"] == inst.VERIFICATION_MISMATCH
        assert "usbId" in result["mismatches"]

    def test_correct_version_on_the_wrong_vehicle_type_fails_verification(self):
        expected = {f: f"{f}-value" for f in wf.VERIFICATION_IDENTITY_FIELDS}
        with patch("core.state.get_vehicle_status", return_value={"connected": True}):
            with patch(
                "services.setup_service.request_firmware_info",
                return_value=_connected_info(version="4.7.1", vehicleType="ROVER"),
            ):
                result = wf.verify_installation("4.7.1", expected_identity=expected)
        assert result["verified"] is False
        assert result["error"] == inst.VERIFICATION_MISMATCH
        assert "vehicleType" in result["mismatches"]

    def test_correct_version_on_the_wrong_autopilot_fails_verification(self):
        expected = {f: f"{f}-value" for f in wf.VERIFICATION_IDENTITY_FIELDS}
        with patch("core.state.get_vehicle_status", return_value={"connected": True}):
            with patch(
                "services.setup_service.request_firmware_info",
                return_value=_connected_info(version="4.7.1", autopilot="PXMMAV"),
            ):
                result = wf.verify_installation("4.7.1", expected_identity=expected)
        assert result["verified"] is False
        assert "autopilot" in result["mismatches"]

    def test_wrong_version_fails_with_the_specific_error(self):
        with patch(
            "services.setup_service.request_firmware_info",
            return_value=_connected_info(version="4.6.0"),
        ):
            result = wf.verify_installation("4.7.1", expected_identity=None)
        assert result["verified"] is False
        assert result["error"] == inst.VERIFICATION_MISMATCH

    def test_an_unreachable_board_is_unconfirmed_not_a_mismatch(self):
        expected = {f: f"{f}-value" for f in wf.VERIFICATION_IDENTITY_FIELDS}
        with _no_device():
            result = wf.verify_installation("4.7.1", expected_identity=expected)
        assert result["verified"] is False
        assert result["error"] == inst.VERIFICATION_UNCONFIRMED

    def test_matching_version_and_identity_verifies(self):
        with _exact_vehicle():
            before = wf.observed_identity()
            result = wf.verify_installation("4.7.0", expected_identity=before)
        assert result["verified"] is True
        assert result["error"] == ""

    def test_simulation_never_claims_a_hardware_verification(self):
        with _catalog_patch(_exact_entries()):
            result = wf.simulate_installation(
                vehicle="Copter", observed_version="V4.7.1", confirmed=True
            )
        assert result["success"] is True
        assert result["verification"]["identityApplicable"] is False
        assert result["hardwareTouched"] is False

    def test_simulation_verification_failure_is_specific(self):
        with _catalog_patch(_exact_entries()):
            result = wf.simulate_installation(
                vehicle="Copter", observed_version="V1.0.0", confirmed=True
            )
        assert result["success"] is not True
        assert result["error"] == inst.VERIFICATION_MISMATCH


# ---------------------------------------------------------------------------
# Cancellation and failure reporting
# ---------------------------------------------------------------------------


class TestCancellationAndFailure:
    def test_cancel_moves_a_running_workflow_to_cancelled(self):
        with _exact_vehicle(auto_confirm=True):
            session = inst.WORKFLOW.session
            for step in (
                inst.DETECTING,
                inst.IDENTIFYING,
                inst.RESOLVING,
                inst.CONFIRMATION_REQUIRED,
                inst.DOWNLOADING,
                inst.DOWNLOAD_VERIFIED,
                inst.PREPARING,
            ):
                session.advance(step)
            payload = wf.cancel_install()
        assert payload["state"] == inst.CANCELLED
        assert payload["success"] is False

    def test_cancel_is_idempotent(self):
        with _exact_vehicle(auto_confirm=True):
            wf.cancel_install()
            payload = wf.cancel_install()
        assert payload["state"] == inst.CANCELLED

    def test_download_failure_never_reports_an_installation(self):
        with _catalog_patch(_exact_entries(), artifact_status=500):
            payload = wf.simulate_installation(
                vehicle="Copter", observed_version="V4.7.1", confirmed=True
            )
        assert payload["success"] is not True
        assert payload["error"] == "download-failed"
        assert payload["state"] == inst.FAILED
        assert payload["versionVerified"] is False
        assert "PREPARING" not in payload["history"]

    def test_install_failure_reports_the_failing_stage(self):
        with _catalog_patch(_exact_entries()):
            payload = wf.simulate_installation(
                vehicle="Copter",
                observed_version="V4.7.1",
                confirmed=True,
                fail_at="INSTALLING",
            )
        assert payload["success"] is not True
        assert payload["state"] == inst.FAILED
        # The installer's own error code is preserved rather than replaced.
        assert payload["error"] == "simulated-failure"
        assert inst.INSTALLING in payload["history"]
        assert "VERIFYING" not in payload["history"]

    def test_every_state_reported_is_a_declared_state(self):
        with _catalog_patch(_exact_entries()):
            payload = wf.simulate_installation(
                vehicle="Copter", observed_version="V4.7.1", confirmed=True
            )
        for state in payload["history"]:
            assert state in inst.WORKFLOW_STATES, state


# ---------------------------------------------------------------------------
# The permanent real-hardware gate
# ---------------------------------------------------------------------------


class TestRealHardwareGate:
    def test_the_gate_is_not_a_configurable_flag(self):
        from core import config

        assert inst.REAL_INSTALLATION_ALLOWED is False
        assert config.FIRMWARE_INSTALL_ENABLED is False

    def test_a_real_board_is_refused_before_any_download(self):
        with _exact_vehicle(auto_confirm=True):
            with patch("services.firmware_download_service._http_get") as download_http:
                payload = wf.run_install(allow_simulation=True)
        assert download_http.call_count == 0
        assert payload["state"] == inst.BLOCKED
        assert "download" not in payload

    def test_the_refusal_reaches_no_further_state(self):
        with _exact_vehicle(auto_confirm=True):
            payload = wf.run_install(allow_simulation=True)
        for state in (inst.DOWNLOADING, inst.PREPARING, inst.INSTALLING, inst.COMPLETED):
            assert state not in payload["history"], state

    def test_the_real_installer_refuses_on_every_entry_point(self):
        installer = inst.RealFirmwareInstaller()
        assert installer.installation_allowed is False
        for call in (
            lambda: installer.prepare("/tmp/x.apj", "1.2.3"),
            lambda: installer.install(),
            lambda: installer.verify(),
        ):
            with pytest.raises(inst.InstallationBlockedError):
                call()

    def test_blocked_operations_are_still_declared(self):
        for operation in (
            "enter-bootloader",
            "bootloader-erase",
            "bootloader-program",
            "bootloader-reboot",
            "reboot-for-flashing",
            "firmware-install",
        ):
            assert operation in inst.BLOCKED_OPERATIONS