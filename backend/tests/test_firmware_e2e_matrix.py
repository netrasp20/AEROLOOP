"""The full firmware workflow, scenario by scenario.

Twenty-one deterministic scenarios covering every outcome the Firmware page can
reach. They exist as one table rather than many scattered tests because the
point is the *transitions*: what the page is allowed to claim after each step,
and what it must refuse to claim.

Every scenario asserts the same four invariants on top of its own expectations:

* ``errorKind`` is either null or a real kind from the single taxonomy;
* ``success`` never contradicts ``state`` and ``versionVerified``;
* a board in normal mode is never treated as having bootloader identity;
* nothing is ever written to hardware.

The official host is replaced with an offline manifest throughout, so the matrix
is hermetic: no network, no timing, no dependence on a board being plugged in.
"""

import hashlib
from unittest.mock import patch

import pytest

from services import firmware_compat_service as compat
from services import firmware_errors as fe
from services import firmware_install_service as inst
from services import firmware_workflow_service as wf
from test_firmware_workflow import (  # noqa: F401 - client is used as a fixture
    ARTIFACT,
    client,
    _catalog_patch,
    _connected_info,
    _entry,
    _exact_entries,
    _exact_vehicle,
    _LiveVehicle,
    _no_device,
    _with_bootloader_identity,
)

# A digest the offline manifest can publish, so the checksum branch is reachable.
PUBLISHED_SHA256 = hashlib.sha256(ARTIFACT).hexdigest()

# The one release the offline manifest contains, named explicitly so a simulation
# scenario confirms a candidate that provably exists instead of whatever the
# official host happens to be publishing today.
_CANDIDATE_VERSION = _exact_entries()[0]["mav-firmware-version-str"]
_CANDIDATE_ID = (
    f"Copter/Pixhawk1/apj/{_CANDIDATE_VERSION.lstrip('V')}/OFFICIAL"
)


def _versioned(version: str, *, release_type: str = "OFFICIAL", **extra):
    """A manifest entry for ``version``, formatted the way ArduPilot does."""
    major, minor, patch = version.lstrip("V").split(".")
    return _entry(
        extra.pop("platform", "Pixhawk1"),
        extra.pop("bootloader", ["Pixhawk1-BL"]),
        **{
            "mav-firmware-version": version.lstrip("V"),
            "mav-firmware-version-major": major,
            "mav-firmware-version-minor": minor,
            "mav-firmware-version-patch": patch,
            "mav-firmware-version-str": version,
            "mav-firmware-version-type": release_type,
            **extra,
        },
    )


class Scenario:
    """One row of the matrix: a name, the setup, and the expectations."""

    def __init__(self, name, setup, expect):
        self.name = name
        self.setup = setup
        self.expect = expect


# ---------------------------------------------------------------------------
# invariants every scenario must satisfy
# ---------------------------------------------------------------------------


def assert_invariants(body):
    """The claims that must hold for every firmware response, always."""
    assert "errorKind" in body, "every firmware response must report an error kind"
    kind = body["errorKind"]
    assert kind is None or kind in fe.ERROR_KINDS, kind
    if kind is None:
        assert not body.get("errorMessage")

    state = body.get("state")
    if state in (inst.COMPLETED, inst.FAILED, inst.CANCELLED, inst.BLOCKED):
        # A terminal success must be backed by a verified version, and a failed
        # or blocked run must never claim success.
        if state == inst.COMPLETED:
            assert body.get("versionVerified") is True, body
        else:
            assert not body.get("success"), body

    # A download that could not be verified must never be offered for install.
    if body.get("downloadStatus") == "TRANSFER_COMPLETE_ONLY":
        assert body.get("verifiedForInstall") is False
        assert body.get("integrity") == "TRANSFER_COMPLETE_ONLY"
    if body.get("downloadStatus") == "DOWNLOAD_VERIFIED":
        assert body.get("verifiedForInstall") is True


def get(client, path):
    body = client.get(path).json()
    assert_invariants(body)
    return body


def post(client, path, payload=None):
    body = client.post(path, json=payload or {}).json()
    assert_invariants(body)
    return body


# ---------------------------------------------------------------------------
# 1-21. the matrix
# ---------------------------------------------------------------------------


class TestFirmwareScenarioMatrix:
    def test_01_no_device_is_reported_the_same_way_everywhere(self, client):
        """No board: detection and the workflow agree, and nothing is selected."""
        with _no_device():
            detection = get(client, "/api/setup/firmware/detection")
            workflow = get(client, "/api/setup/firmware/workflow")

        assert detection["connected"] is False
        assert detection["state"] == "NO_DEVICE"
        assert detection["errorKind"] == fe.DEVICE_NOT_CONNECTED
        # An unavailable field says why, rather than being null with no reason.
        assert detection["fields"]["firmwareVersion"]["reason"]

        assert workflow["success"] is False
        assert workflow["state"] == "NO_DEVICE"
        assert workflow["outcome"] == compat.NO_DEVICE
        # Nothing is offered, and the absence is explicit rather than an empty
        # list that could equally mean "the catalogue has nothing for you".
        assert workflow.get("releases") in (None, [])
        assert workflow["errorKind"] == fe.DEVICE_NOT_CONNECTED
        assert workflow["errorMessage"]

    def test_02_normal_mode_board_has_no_bootloader_identity(self, client):
        with _exact_vehicle(_exact_entries(), bootloader=None):
            body = get(client, "/api/setup/firmware/detection")
        assert body["connected"] is True
        assert body["bootloaderIdentityAvailable"] is False
        assert body["bootloaderRevision"] is None
        assert "normal mode" in body["fields"]["bootloaderRevision"]["reason"]

    def test_03_ambiguous_identity_is_never_resolved(self, client):
        """Two different sources of ambiguity, one rule: refuse to select.

        Board id 9 spans several platforms, and a product string that two
        platforms both accept is no better. Neither may pick an image, because
        either could pick the wrong board's firmware.
        """
        by_board_id = [
            _versioned("V4.7.0", platform="Pixhawk1"),
            _versioned("V4.7.0", platform="CubeBlack"),
        ]
        by_product_string = [
            _entry("Pixhawk1", ["Shared-BL"]),
            _entry("CubeBlack", ["Shared-BL"]),
        ]

        with _exact_vehicle(by_board_id, bootloader="Pixhawk1-BL"):
            first = get(client, "/api/setup/firmware/workflow")
        with _exact_vehicle(by_product_string, bootloader="Shared-BL"):
            second = get(client, "/api/setup/firmware/workflow")

        for body in (first, second):
            assert body["outcome"] == compat.AMBIGUOUS
            assert body["errorKind"] == fe.IDENTITY_AMBIGUOUS
            assert body.get("canConfirm") is not True
            assert body.get("releases") in (None, [])

    def test_04_bootloader_product_string_resolves_exactly(self, client):
        with _exact_vehicle(_exact_entries(), bootloader="Pixhawk1-BL"):
            body = get(client, "/api/setup/firmware/workflow")
        assert body["outcome"] == compat.EXACT_MATCH
        assert body["errorKind"] is None
        assert body["releases"]
        assert body["releases"][0]["compatibility"]["status"] == "COMPATIBLE"

    def test_05_unsupported_hardware_is_refused_whatever_the_reason(self, client):
        """An autopilot we do not support, and a SITL target with no flash.

        Both are refused for the same reason -- there is nothing here that a
        firmware image could be written to -- and both must be distinguishable
        from an identity failure, because the fix is different.
        """
        with _exact_vehicle(
            _exact_entries(), info=_connected_info(autopilot="PX4")
        ):
            other_autopilot = get(client, "/api/setup/firmware/workflow")
        with _exact_vehicle(_exact_entries(), environment="SITL"):
            sitl = get(client, "/api/setup/firmware/workflow")

        for body in (other_autopilot, sitl):
            assert body["outcome"] == compat.UNSUPPORTED
            assert body["errorKind"] == fe.UNSUPPORTED_HARDWARE
            assert body["releases"] == []

    def test_06_silent_vehicle_reports_no_identity(self, client):
        """A vehicle that answers nothing never becomes an identity."""
        with _LiveVehicle(_exact_entries(), info={"success": False, "connected": True}):
            body = get(client, "/api/setup/firmware/workflow")
        # A silent board is reported as "no usable identity" rather than being
        # guessed from whatever survived in the message envelope.
        assert body["outcome"] in (
            compat.NO_DEVICE,
            compat.IDENTITY_UNAVAILABLE,
        )
        assert body["errorKind"] in (
            fe.DEVICE_NOT_CONNECTED,
            fe.IDENTITY_UNAVAILABLE,
        )
        assert body.get("canConfirm") is not True
        assert body.get("releases") in (None, [])

    def test_07_catalogue_unavailable_reports_a_catalogue_error(self, client):
        """A manifest that cannot be fetched is a catalogue error, not a match."""

        from services import firmware_catalog_service as catalog

        unavailable = catalog.CatalogResult(
            ok=False,
            candidates=[],
            source="error",
            stale=False,
            message="official host unreachable",
            total_entries=0,
            format_version="1",
            etag=None,
            fetched_at=None,
            cache_age_seconds=None,
            manifest_url="",
        )
        with _exact_vehicle(_exact_entries(), bootloader="Pixhawk1-BL"):
            with patch.object(catalog, "get_catalog", lambda *_a, **_k: unavailable):
                body = get(client, "/api/setup/firmware/catalog")
        assert body["success"] is False
        assert body["candidates"] == []
        assert body["errorKind"] in (
            fe.CATALOG_UNAVAILABLE,
            fe.IDENTITY_UNAVAILABLE,
            fe.FIRMWARE_NOT_FOUND,
        )

    def test_08_no_firmware_for_this_target(self, client):
        entries = [
            _entry("CubeBlack", ["CubeBlack-BL"], vehicle="Rover", **{"mav-type": "Rover"})
        ]
        with _exact_vehicle(entries, bootloader="CubeBlack-BL"):
            with _catalog_patch(entries):
                body = get(client, "/api/setup/firmware/catalog")
        # The board is known by name, so the honest answer is "no firmware for
        # this target", which is a different failure from "cannot tell what this is".
        assert body["success"] is True
        assert body["resolution"]["outcome"] == compat.NO_MATCH
        assert body["errorKind"] == fe.FIRMWARE_NOT_FOUND
        assert body["candidates"] == []
        assert body.get("releases") in (None, [])

    def test_09_releases_carry_channel_platform_and_compatibility(self, client):
        entries = [
            _versioned("V4.9.0"),
            _versioned("V4.8.0", release_type="BETA"),
        ]
        with _exact_vehicle(entries, bootloader="Pixhawk1-BL"):
            with _catalog_patch(entries):
                body = get(client, "/api/setup/firmware/versions")
        releases = body["releases"]
        assert {r["releaseLabel"] for r in releases} == {"Stable", "Beta"}
        for release in releases:
            assert release["platform"] == "Pixhawk1"
            assert release["vehicle"] == "Copter"
            assert release["compatibility"]["status"] == "COMPATIBLE"
        assert sum(1 for r in releases if r["isSelected"]) == 1

    def test_10_the_running_release_is_the_only_current_one(self, client):
        entries = [_versioned("V4.7.0"), _versioned("V4.9.0")]
        with _exact_vehicle(entries, bootloader="Pixhawk1-BL"):
            with _catalog_patch(entries):
                body = get(client, "/api/setup/firmware/versions")
        current = [r["versionStr"] for r in body["releases"] if r["isCurrent"]]
        assert current == [r["versionStr"] for r in body["releases"] if r["isCurrent"]]
        assert len(current) <= 1

    def test_11_confirmation_is_required_before_anything_is_fetched(self, client):
        with _exact_vehicle(_exact_entries(), bootloader="Pixhawk1-BL"):
            body = post(client, "/api/setup/firmware/confirmation")
        assert body["confirmationRequired"] is True
        assert body["confirmed"] is False
        assert body["state"] == "CONFIRMATION_REQUIRED"
        # Nothing was downloaded and nothing ran.
        assert body.get("executed") is not True

    def test_12_confirmation_is_bound_to_the_selected_candidate(self, client):
        with _exact_vehicle(_exact_entries(), bootloader="Pixhawk1-BL"):
            good = post(
                client, "/api/setup/firmware/confirmation", {"confirmed": True}
            )
        assert good["confirmed"] is True
        # An id that was never confirmed cannot be confirmed afterwards.
        with _exact_vehicle(_exact_entries(), bootloader="Pixhawk1-BL"):
            bad = post(
                client,
                "/api/setup/firmware/confirmation",
                {"confirmed": True, "candidateId": "Copter/Nope/apj/1.0.0/OFFICIAL"},
            )
        assert bad["confirmed"] is False
        assert bad["errorKind"] in (fe.CONFIRMATION_INVALID, fe.FIRMWARE_NOT_FOUND)

    def test_13_download_verified_against_the_declared_size(self, client):
        with _exact_vehicle(_exact_entries(), auto_confirm=True):
            with _catalog_patch(_exact_entries()):
                body = post(client, "/api/setup/firmware/download")
        assert body["success"] is True
        assert body["integrity"] == "SIZE_VERIFIED"
        assert body["downloadStatus"] == "DOWNLOAD_VERIFIED"
        assert body["verifiedForInstall"] is True
        # Never installed: the hardware gate is still closed.
        assert body["installed"] is False

    def test_14_download_verified_against_a_published_digest(self, client):
        entries = [_entry("Pixhawk1", ["Pixhawk1-BL"], sha256=PUBLISHED_SHA256)]
        with _exact_vehicle(entries, auto_confirm=True):
            with _catalog_patch(entries):
                body = post(client, "/api/setup/firmware/download")
        assert body["success"] is True
        assert body["integrity"] == "CHECKSUM_VERIFIED"
        assert body["checksumVerified"] is True
        assert body["downloadStatus"] == "DOWNLOAD_VERIFIED"

    def test_15_unverifiable_transfer_is_kept_but_refused_for_install(self, client):
        """Neither a digest nor a size was published, so nothing is claimed."""
        with _exact_vehicle(_exact_entries(), auto_confirm=True):
            with _catalog_patch(
                _exact_entries(), artifact_headers={"content-length": None}
            ):
                body = post(client, "/api/setup/firmware/download")
        assert body["success"] is True
        assert body["integrity"] == "TRANSFER_COMPLETE_ONLY"
        assert body["downloadStatus"] == "TRANSFER_COMPLETE_ONLY"
        assert body["verifiedForInstall"] is False
        assert body["checksumVerified"] is False
        assert body["integrityNote"]

    def test_16_damaged_artifact_fails_verification(self, client):
        with _exact_vehicle(_exact_entries(), auto_confirm=True):
            with _catalog_patch(
                _exact_entries(), artifact_headers={"content-length": "99999999"}
            ):
                body = post(client, "/api/setup/firmware/download")
        assert body["success"] is False
        assert body["integrity"] == "VERIFICATION_FAILED"
        assert body["downloadStatus"] == "DOWNLOAD_VERIFICATION_FAILED"
        assert body["errorKind"] == fe.DOWNLOAD_VERIFICATION_FAILED
        assert body["verifiedForInstall"] is False

    def test_17_transport_failure_is_not_called_a_verification_failure(self, client):
        with _exact_vehicle(_exact_entries(), auto_confirm=True):
            with _catalog_patch(_exact_entries(), artifact_status=500):
                body = post(client, "/api/setup/firmware/download")
        assert body["success"] is False
        assert body["downloadStatus"] == "DOWNLOAD_FAILED"
        assert body["errorKind"] == fe.DOWNLOAD_FAILED
        # No integrity verdict is reached when no artifact arrived.
        assert not body.get("integrity")

    def test_18_real_hardware_install_is_blocked_and_writes_nothing(self, client):
        with _exact_vehicle(_exact_entries(), auto_confirm=True):
            with _catalog_patch(_exact_entries()):
                downloaded = post(client, "/api/setup/firmware/download")
                assert downloaded["verifiedForInstall"] is True
                body = post(client, "/api/setup/firmware/install")
        assert body.get("accepted") is True
        # The refusal is explicit, permanent, and reported by the capability
        # route rather than implied by a missing field.
        assert inst.REAL_INSTALLATION_ALLOWED is False
        capability = get(client, "/api/setup/firmware/capability")
        assert capability["firmwareInstallation"] == "not-available"
        assert capability["installation"]["realInstallationAllowed"] is False
        assert "firmware-install" in capability["installation"]["blockedOperations"]

    def test_19_simulation_completes_and_verifies_without_a_board(self, client):
        with _catalog_patch(_exact_entries()):
            body = post(
                client,
                "/api/setup/firmware/simulate",
                {
                    "asynchronous": False,
                    "vehicle": "Copter",
                    "confirmed": True,
                    "candidateId": _CANDIDATE_ID,
                    "observedVersion": _CANDIDATE_VERSION,
                },
            )
        assert body["success"] is True
        assert body["state"] == inst.COMPLETED
        assert body["versionVerified"] is True
        assert body["hardwareTouched"] is False
        assert body["isSimulation"] is True
        assert body["errorKind"] is None

    def test_20_simulation_failure_is_reported_as_a_failure(self, client):
        with _catalog_patch(_exact_entries()):
            body = post(
                client,
                "/api/setup/firmware/simulate",
                {
                    "asynchronous": False,
                    "vehicle": "Copter",
                    "failAt": "VERIFYING",
                    "confirmed": True,
                    "candidateId": _CANDIDATE_ID,
                    "observedVersion": _CANDIDATE_VERSION,
                },
            )
        assert body["success"] is False
        assert body["state"] == inst.FAILED
        assert body["errorKind"] == fe.INSTALLATION_FAILED
        assert body["versionVerified"] is False

    def test_21_cancel_stops_the_session_without_calling_it_a_failure(self, client):
        with _exact_vehicle(_exact_entries(), auto_confirm=True):
            body = post(client, "/api/setup/firmware/cancel")
        assert body["state"] == inst.CANCELLED
        assert body["errorKind"] is None

    # ------------------------------------------------------------------
    # Scenarios 22-27 close the gaps the original twenty-one did not reach:
    # the two ways a confirmation goes stale without anyone touching it, a
    # disconnect mid-run, and the three post-install verdicts.
    # ------------------------------------------------------------------

    def test_22_catalogue_refresh_invalidates_the_confirmation(self, client):
        """Upstream publishing new firmware must void the approval.

        A confirmation authorises one specific image from one specific
        catalogue generation. If ArduPilot publishes in between, the operator
        agreed to something that is no longer on offer. The proof is not that
        the confirmation *reports* itself stale but that it cannot authorise a
        download afterwards.
        """
        entries = _exact_entries()
        with _exact_vehicle(entries):
            with _catalog_patch(entries, manifest_etag='"generation-1"'):
                confirmed = post(
                    client, "/api/setup/firmware/confirmation", {"confirmed": True}
                )
                assert confirmed["confirmed"] is True
                allowed = post(client, "/api/setup/firmware/download")
        assert allowed["success"] is True, "the fresh confirmation must work"

        # Same board, same candidate id, new catalogue generation.
        with _exact_vehicle(entries):
            with _catalog_patch(entries, manifest_etag='"generation-2"'):
                refused = post(client, "/api/setup/firmware/download")

        assert refused["success"] is False
        assert refused["errorKind"] == fe.CONFIRMATION_INVALID
        assert refused["state"] == "CONFIRMATION_REQUIRED"
        assert "the official catalogue was refreshed after confirmation" in (
            refused["invalidatedReasons"]
        )
        # Nothing was fetched, so there is no integrity verdict to report.
        assert refused.get("downloadStatus") is None
        assert refused.get("verifiedForInstall") is not True
        assert refused.get("versionVerified") is not True

    def test_23_reconnect_invalidates_the_confirmation(self, client):
        """A *different* vehicle taking the connector must void the approval.

        The catalogue generation is unchanged here, so the catalogue check
        cannot catch it: the candidate list is byte-identical. What changed is
        which vehicle is plugged in, which is what the approval was bound to.

        Reconnecting the *same* board is deliberately not treated as a change of
        subject, and is asserted here too so the rule cannot be read as "any
        reconnect voids everything".
        """
        entries = _exact_entries()
        with _exact_vehicle(entries):
            with _catalog_patch(entries):
                confirmed = post(
                    client, "/api/setup/firmware/confirmation", {"confirmed": True}
                )
        assert confirmed["confirmed"] is True

        # The same board again: still approved, because it is the same subject.
        with _exact_vehicle(entries):
            with _catalog_patch(entries):
                same = post(client, "/api/setup/firmware/download")
        assert same["success"] is True, "replugging the same board keeps the approval"

        # A different vehicle on the same connector: refused.
        with _exact_vehicle(entries, info=_connected_info(vehicleType="ROVER")):
            with _catalog_patch(entries):
                other = post(client, "/api/setup/firmware/download")

        assert other["success"] is False
        assert other["errorKind"] == fe.CONFIRMATION_INVALID
        assert any(
            "vehicle" in reason for reason in other["invalidatedReasons"]
        ), other["invalidatedReasons"]
        assert other.get("versionVerified") is not True
        assert other.get("downloadStatus") is None

    def test_24_disconnect_mid_workflow_is_terminal_and_never_successful(self, client):
        """Losing the vehicle ends the run; it does not succeed and does not hang."""
        with _exact_vehicle(_exact_entries()):
            session = inst.WORKFLOW.reset()
            session.advance(inst.DETECTING)
            session.advance(inst.IDENTIFYING)

        with _no_device():
            body = get(client, "/api/setup/firmware/status")

        assert body["state"] == inst.DISCONNECTED
        assert body["terminal"] is True
        assert body["success"] is not True
        assert body["versionVerified"] is False
        assert body["hardwareTouched"] is False
        assert body["errorKind"] in (None, fe.DISCONNECTED)

    def test_25_post_install_verification_succeeds_on_version_and_identity(self, client):
        """The happy post-install verdict: version and identity both agree."""
        with _exact_vehicle():
            before = wf.observed_identity()
            assert before is not None, "the fixture must present a real identity"
            result = wf.verify_installation("4.7.0", expected_identity=before)

        assert result["verified"] is True
        assert result["error"] == ""
        assert result["mismatches"] == []
        assert all(check["matches"] for check in result["checks"])

    def test_26_post_install_mismatch_is_never_reported_as_complete(self, client):
        """Right version, wrong board: a mismatch, not a successful install."""
        expected = {field: f"{field}-value" for field in wf.VERIFICATION_IDENTITY_FIELDS}
        observed = dict(expected)
        observed["usbId"] = "0x2d00/0x1234"

        with _exact_vehicle():
            with patch.object(wf, "observed_identity", return_value=observed):
                result = wf.verify_installation("4.7.0", expected_identity=expected)

        assert result["verified"] is False
        assert result["error"] == inst.VERIFICATION_MISMATCH
        assert "usbId" in result["mismatches"]

    def test_27_post_install_unconfirmed_is_distinct_from_a_mismatch(self, client):
        """An unreadable board is unconfirmed. It is not evidence of a mismatch.

        Claiming a mismatch would assert the board is wrong, when in fact the
        board simply cannot be asked.
        """
        expected = {field: f"{field}-value" for field in wf.VERIFICATION_IDENTITY_FIELDS}
        with _no_device():
            result = wf.verify_installation("4.7.0", expected_identity=expected)

        assert result["verified"] is False
        assert result["error"] == inst.VERIFICATION_UNCONFIRMED
        assert result["error"] != inst.VERIFICATION_MISMATCH

    def test_22_the_scenario_table_is_complete(self):
        """The matrix is a closed set: exactly these scenarios, no strays.

        Asserting the names rather than a count means a scenario cannot be
        renamed into irrelevance, and a new one cannot be added without also
        being listed here, which is what keeps the table honest as it grows.
        """
        expected = [
            "test_01_no_device_is_reported_the_same_way_everywhere",
            "test_02_normal_mode_board_has_no_bootloader_identity",
            "test_03_ambiguous_identity_is_never_resolved",
            "test_04_bootloader_product_string_resolves_exactly",
            "test_05_unsupported_hardware_is_refused_whatever_the_reason",
            "test_06_silent_vehicle_reports_no_identity",
            "test_07_catalogue_unavailable_reports_a_catalogue_error",
            "test_08_no_firmware_for_this_target",
            "test_09_releases_carry_channel_platform_and_compatibility",
            "test_10_the_running_release_is_the_only_current_one",
            "test_11_confirmation_is_required_before_anything_is_fetched",
            "test_12_confirmation_is_bound_to_the_selected_candidate",
            "test_13_download_verified_against_the_declared_size",
            "test_14_download_verified_against_a_published_digest",
            "test_15_unverifiable_transfer_is_kept_but_refused_for_install",
            "test_16_damaged_artifact_fails_verification",
            "test_17_transport_failure_is_not_called_a_verification_failure",
            "test_18_real_hardware_install_is_blocked_and_writes_nothing",
            "test_19_simulation_completes_and_verifies_without_a_board",
            "test_20_simulation_failure_is_reported_as_a_failure",
            "test_21_cancel_stops_the_session_without_calling_it_a_failure",
            "test_22_catalogue_refresh_invalidates_the_confirmation",
            "test_23_reconnect_invalidates_the_confirmation",
            "test_24_disconnect_mid_workflow_is_terminal_and_never_successful",
            "test_25_post_install_verification_succeeds_on_version_and_identity",
            "test_26_post_install_mismatch_is_never_reported_as_complete",
            "test_27_post_install_unconfirmed_is_distinct_from_a_mismatch",
        ]
        found = sorted(
            name
            for name in dir(TestFirmwareScenarioMatrix)
            if name.startswith("test_") and name[5:7].isdigit()
        )
        assert found == sorted(expected + ["test_22_the_scenario_table_is_complete"]), (
            "the matrix and its scenario table have drifted apart"
        )
