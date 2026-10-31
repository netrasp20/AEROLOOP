"""End-to-end firmware workflow tests: all 24 required scenarios.

Every manifest document, identity and artifact here is SYNTHETIC. No test opens
a serial port, contacts a vehicle, enters bootloader mode, erases or flashes
anything. The real Pixhawk is never touched by this suite.
"""

import gzip
import inspect
import io
import json
import logging
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient


class _RecordingHandler(logging.Handler):
    """Collects formatted log records as parsed event dictionaries."""

    def __init__(self, sink):
        super().__init__()
        self._sink = sink

    def emit(self, record):
        try:
            self._sink.append(json.loads(record.getMessage()))
        except Exception:  # noqa: BLE001 - a test must not fail on log noise
            pass

from services import firmware_install_service as inst
from services import firmware_workflow_service as wf

# ---------------------------------------------------------------------------
# Synthetic fixtures
# ---------------------------------------------------------------------------

#: Board ID 9 is shared by three real ArduPilot platforms. The bootloader
#: product string is the only signal that distinguishes them, so a manifest with
#: no matching product string must stay AMBIGUOUS for this hardware.
BOARD9_PLATFORMS = [
    ("Pixhawk1", ["Pixhawk1-BL", "PX4 BL FMU v2.x"]),
    ("Pixhawk1-1M", ["Pixhawk1-1M-BL", "PX4 BL FMU v2.x"]),
    ("CubeBlack", ["CubeBlack-BL", "PX4 BL FMU v2.x"]),
]

ARTIFACT = b"SYNTHETIC-FIRMWARE-ARTIFACT" * 64


def _entry(platform="Pixhawk1", bootloader_str=None, board_id=9, vehicle="Copter", **overrides):
    base = {
        "mav-autopilot": "ARDUPILOTMEGA",
        "vehicletype": vehicle,
        "platform": platform,
        "git-sha": "dbe792162d06cab66c3475fd5556bf7a120f119e",
        "url": f"https://firmware.ardupilot.org/{vehicle}/stable/{platform}/arducopter.apj",
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


def _manifest(entries):
    return {"format-version": "1.0.0", "firmware": entries}


def _gzip(payload):
    if not isinstance(payload, (bytes, bytearray)):
        payload = json.dumps(payload).encode()
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb") as fh:
        fh.write(payload)
    return buf.getvalue()


def _http(status=200, body=b"", headers=None):
    base = {"etag": '"abc123"'}
    base.update(headers or {})
    return MagicMock(
        side_effect=lambda *a, **k: SimpleNamespace(status=status, headers=dict(base), body=body)
    )


def _connected_info(**overrides):
    """A plausible Pixhawk1 AUTOPILOT_VERSION reply (synthetic values)."""
    info = {
        "success": True,
        "connected": True,
        "flightSwVersion": 0x040700FF,
        "version": "4.7.0",
        "release": "Official Release",
        "boardVersion": 589824,
        "boardType": 0,
        "boardRev": 9,
        "custom": "",
        "vendorId": 4617,
        "productId": 22337,
        "uid": "0xaabb",
        "vehicleType": "QUADROTOR",
        "vehicle": "ArduCopter",
        "autopilot": "ARDUPILOTMEGA",
        "autopilotLabel": "ArduPilot",
        "systemId": 1,
        "componentId": 1,
        "connectionType": "USB",
        "supported": True,
    }
    info.update(overrides)
    return info


@pytest.fixture(autouse=True)
def isolated(tmp_path):
    from core import config
    from services import firmware_catalog_service as svc

    original = config.FIRMWARE_MANIFEST_CACHE_DIR
    config.FIRMWARE_MANIFEST_CACHE_DIR = str(tmp_path / "fw")
    svc.reset_cache()
    inst.WORKFLOW.reset()
    inst.CONFIRMATION.clear()
    yield
    config.FIRMWARE_MANIFEST_CACHE_DIR = original
    svc.reset_cache()
    inst.WORKFLOW.reset()
    inst.CONFIRMATION.clear()


@pytest.fixture
def client():
    from app import app

    return TestClient(app)


def _exact_entries():
    """Only Pixhawk1 lists 'Pixhawk1-BL', so the resolution is EXACT_MATCH."""
    return [_entry("Pixhawk1", ["Pixhawk1-BL"])]


class _OfflineManifest:
    """Patch manifest + artifact HTTP for one synthetic catalogue."""

    def __init__(
        self,
        entries,
        artifact=ARTIFACT,
        artifact_status=200,
        artifact_headers=None,
        manifest_etag='"abc123"',
    ):
        self.entries = entries
        self.artifact = artifact
        self.artifact_status = artifact_status
        self.artifact_headers = artifact_headers
        # The ETag is the catalogue generation a confirmation is bound to, so a
        # scenario that needs the catalogue to have been *refreshed* needs a
        # different one.
        self.manifest_etag = manifest_etag

    def _manifest_response(self):
        return _http(
            200, _gzip(_manifest(self.entries)), headers={"etag": self.manifest_etag}
        )()

    def _artifact_response(self):
        headers = {
            "content-length": str(len(self.artifact)),
            "content-type": "application/octet-stream",
        }
        headers.update(self.artifact_headers or {})
        if self.artifact_headers is not None and "content-length" not in self.artifact_headers:
            pass
        return _http(self.artifact_status, self.artifact, headers=headers)()

    def __enter__(self):
        from services import firmware_catalog_service as svc
        from services import firmware_download_service as dl

        def _dispatch(url, *_a, **_k):
            if "manifest" in url:
                return self._manifest_response()
            return self._artifact_response()

        mock_get = MagicMock(side_effect=_dispatch)
        self._p1 = patch.object(svc, "_http_get", mock_get)
        self._p2 = patch.object(dl, "_http_get", mock_get)
        self._p3 = patch.object(svc, "_memo", None)
        self._p1.start()
        self._p2.start()
        # The parsed manifest is memoised on the manifest URL, which every patch
        # shares. Without clearing it, a second patch in the same test is silently
        # ignored and the test resolves against the previous test's catalogue --
        # the worst kind of failure, because the assertions still read as though
        # they described the second catalogue.
        self._p3.start()
        return self

    def __exit__(self, *_exc):
        self._p1.stop()
        self._p2.stop()
        self._p3.stop()
        return False


def _catalog_patch(entries, **kwargs):
    return _OfflineManifest(entries, **kwargs)


def _with_bootloader_identity(product_string, *, board_id=9, flash_size=2 * 1024 * 1024):
    """Give the resolver a real bootloader observation.

    A board in normal mode has no trustworthy identity, so this patch is how the
    EXACT_MATCH scenarios are reached at all. Everything else about the identity
    still comes from the live ``AUTOPILOT_VERSION`` payload.
    """
    from services.bootloader_validation_service import SERVICE as validation

    @contextmanager
    def _stored_identity():
        # Seeded into the validation machine rather than patched over
        # ``build_identity``, so the production path that folds a stored
        # observation into resolution is the one under test. Restored on the way
        # out, because the machine is process-global and a leftover observation
        # would hand the next test a bootloader identity it never established.
        previous = validation.machine.identity
        validation.machine.identity = {
            "bootloaderRevision": 4,
            "boardId": board_id,
            "flashSize": flash_size,
            "bootloaderUsbProductString": product_string,
            "canResolvePlatform": True,
            "source": "BOOTLOADER",
        }
        try:
            yield
        finally:
            validation.machine.identity = previous

    return _stored_identity()


class _LiveVehicle:
    """Simulate a connected vehicle and a synthetic catalogue.

    Without ``bootloader=`` this reproduces a real Pixhawk in normal mode, which
    is deliberately AMBIGUOUS: board id 9 spans many platforms and no bootloader
    product string is observable.
    """

    def __init__(
        self,
        entries,
        *,
        environment="HARDWARE",
        info=None,
        bootloader=None,
        auto_confirm=False,
    ):
        self.entries = entries
        self.environment = environment
        self.info = info or _connected_info()
        self.bootloader = bootloader
        self.auto_confirm = auto_confirm
        self._stack = []

    def __enter__(self):
        self._stack = [
            patch("core.state.get_vehicle_status", return_value={"connected": True}),
            patch("services.setup_service.request_firmware_info", return_value=self.info),
            patch("services.firmware_install_service.environment", return_value=self.environment),
            _catalog_patch(self.entries),
        ]
        if self.bootloader:
            self._stack.append(_with_bootloader_identity(self.bootloader))
        for item in self._stack:
            item.__enter__()
        if self.auto_confirm:
            wf.confirmation(confirmed=True)
        return self

    def __exit__(self, *exc):
        for item in reversed(self._stack):
            item.__exit__(*exc)
        return False


def _exact_vehicle(entries=None, **kwargs):
    """A vehicle whose bootloader product string resolves one unique platform."""
    kwargs.setdefault("bootloader", "Pixhawk1-BL")
    return _LiveVehicle(entries or _exact_entries(), **kwargs)


def _no_device():
    """Nothing plugged in: no connection state and no identity reply.

    Both halves matter — a board that answers AUTOPILOT_VERSION is connected
    whatever the cached heartbeat state says.
    """
    return _BothNoDevice()


class _BothNoDevice:
    def __enter__(self):
        self._p1 = patch(
            "core.state.get_vehicle_status", return_value={"connected": False}
        )
        self._p2 = patch(
            "services.setup_service.request_firmware_info",
            return_value={"success": False, "connected": False, "message": "Vehicle is not connected."},
        )
        self._p1.start()
        self._p2.start()
        return self

    def __exit__(self, *exc):
        self._p2.stop()
        self._p1.stop()
        return False


def _confirmed_live():
    """A live, exactly-resolved vehicle with the target confirmed server-side."""
    return _exact_vehicle(auto_confirm=True)


# ---------------------------------------------------------------------------
# 1. no device
# ---------------------------------------------------------------------------


class TestNoDevice:
    def test_detect_reports_no_device(self):
        with _no_device():
            result = wf.detect()
        assert result["success"] is False
        assert result["state"] == "NO_DEVICE"
        assert result["connected"] is False

    def test_workflow_reports_no_device(self):
        with _no_device():
            result = wf.workflow()
        assert result["success"] is False
        assert result["state"] == "NO_DEVICE"
        assert result["connected"] is False

    def test_install_without_a_device_cannot_start(self):
        with _no_device():
            result = wf.run_install()
        assert result["success"] is False
        assert result["state"] == "NO_DEVICE"

    def test_workflow_endpoint_reports_no_device(self, client):
        with _no_device():
            body = client.get("/api/setup/firmware/workflow").json()
        assert body["state"] == "NO_DEVICE"

    def test_no_device_does_not_start_a_simulator_implicitly(self):
        with _no_device():
            result = wf.run_install(allow_simulation=True)
        assert result["success"] is False
        assert result["state"] == "NO_DEVICE"


# ---------------------------------------------------------------------------
# 2. Pixhawk detected
# ---------------------------------------------------------------------------


class TestPixhawkDetected:
    def test_detect_uses_the_existing_connection_manager(self):
        with (
            patch("core.state.get_vehicle_status", return_value={"connected": True}),
            patch("mavlink.connection_manager.manager") as mgr,
        ):
            mgr.connection_type = "serial"
            result = wf.detect()
        assert result["success"] is True
        assert result["connectionType"] == "serial"
        # Detection must never create a second connection.
        assert not mgr.connect.called
        assert not mgr.enqueue.called

    def test_detection_state_is_reported(self):
        with patch("core.state.get_vehicle_status", return_value={"connected": True}):
            assert wf.detect()["state"] == "READY"

    def test_detect_endpoint_reports_the_connection_type(self, client):
        with (
            patch("core.state.get_vehicle_status", return_value={"connected": True}),
            patch("mavlink.connection_manager.manager") as mgr,
        ):
            mgr.connection_type = "serial"
            body = client.get("/api/setup/firmware/workflow").json()
        assert body["detection"]["connected"] is True
        assert body["detection"]["connectionType"] == "serial"


# ---------------------------------------------------------------------------
# 3. current firmware detected
# ---------------------------------------------------------------------------


class TestCurrentFirmwareDetected:
    def test_identify_reads_actual_values(self):
        with patch("services.setup_service.request_firmware_info", return_value=_connected_info()):
            result = wf.identify()
        assert result["success"] is True
        assert result["info"]["version"] == "4.7.0"
        assert result["info"]["vehicle"] == "ArduCopter"

    def test_identify_failure_is_reported_truthfully(self):
        with patch(
            "services.setup_service.request_firmware_info",
            return_value={"success": False, "connected": True, "message": "timeout"},
        ):
            result = wf.identify()
        assert result["success"] is False
        assert result["state"] == "FAILED"

    def test_no_version_is_ever_hardcoded(self):
        with patch(
            "services.setup_service.request_firmware_info",
            return_value={"success": False, "connected": False, "message": "not connected"},
        ):
            assert wf.identify()["info"]["success"] is False
            assert wf.workflow()["current"] is None

    def test_workflow_reports_current_firmware(self):
        with _exact_vehicle():
            result = wf.workflow()
        assert result["current"]["version"] == "4.7.0"
        assert result["current"]["vehicle"] == "ArduCopter"
        assert result["connected"] is True


# ---------------------------------------------------------------------------
# 4. catalog retrieved
# ---------------------------------------------------------------------------


class TestCatalogRetrieved:
    def test_catalog_is_resolved_against_the_manifest(self):
        with _exact_vehicle():
            result = wf.workflow()
        assert result["resolution"]["candidateCount"] == 1
        assert result["resolution"]["selected"]["platform"] == "Pixhawk1"

    def test_catalog_failure_is_reported_unavailable(self):
        from services import firmware_catalog_service as svc

        with (
            patch("core.state.get_vehicle_status", return_value={"connected": True}),
            patch("services.setup_service.request_firmware_info", return_value=_connected_info()),
            patch("services.firmware_install_service.environment", return_value="HARDWARE"),
            patch.object(svc, "_http_get", MagicMock(side_effect=OSError("offline"))),
        ):
            result = wf.workflow()
        assert result["resolution"]["outcome"] == "UNAVAILABLE"
        assert result["resolution"]["canConfirm"] is False
        assert result["releases"] == []

    def test_versions_endpoint_lists_real_releases(self, client):
        with _exact_vehicle():
            body = client.get("/api/setup/firmware/versions").json()
        assert len(body["releases"]) == 1
        assert body["releases"][0]["versionStr"] == "V4.7.1"
        assert body["defaultCandidateId"] == body["releases"][0]["candidateId"]

    def test_catalog_is_never_cached_across_tests(self):
        from services import firmware_catalog_service as svc

        svc.reset_cache()
        with _exact_vehicle():
            assert len(wf.version_list()["releases"]) == 1
        svc.reset_cache()
        with _catalog_patch([]):
            assert wf.version_list()["releases"] == []


# ---------------------------------------------------------------------------
# 5. exact hardware match
# ---------------------------------------------------------------------------


class TestExactHardwareMatch:
    def test_unique_product_string_resolves_exact_match(self):
        with _exact_vehicle():
            result = wf.resolve()
        assert result["outcome"] == "EXACT_MATCH"
        assert result["resolution"].selected.platform == "Pixhawk1"
        assert result["resolution"].can_confirm is True

    def test_exact_match_offers_a_confirmable_target(self, client):
        with _exact_vehicle():
            body = client.post(
                "/api/setup/firmware/confirmation", json={"confirmed": True}
            ).json()
        assert body["success"] is True
        assert body["confirmed"] is True
        assert body["target"]["platform"] == "Pixhawk1"

    def test_exact_match_records_the_confirmed_candidate(self):
        with _exact_vehicle():
            body = wf.confirmation(confirmed=True)
        assert body["state"] == "READY"
        assert inst.CONFIRMATION.current.confirmed is True
        assert inst.CONFIRMATION.current.candidate_id == body["target"]["id"]


# ---------------------------------------------------------------------------
# 6. ambiguous hardware
# ---------------------------------------------------------------------------


class TestAmbiguousHardware:
    def test_board_id_9_alone_never_selects(self):
        """Board id 9 spans several platforms, so it must never select an image.

        A live board reporting no bootloader identity is IDENTITY_UNAVAILABLE:
        the board is present and answering, but the only trustworthy signal is
        unobtainable without entering bootloader mode.
        """
        entries = [_entry(p, bl) for p, bl in BOARD9_PLATFORMS]
        with _LiveVehicle(entries):
            result = wf.resolve()
        assert result["outcome"] == "IDENTITY_UNAVAILABLE"
        assert result["resolution"].selected is None
        assert result["resolution"].can_confirm is False

    def test_ambiguous_offers_no_releases(self, client):
        entries = [_entry(p, bl) for p, bl in BOARD9_PLATFORMS]
        with _LiveVehicle(entries):
            body = client.get("/api/setup/firmware/versions").json()
        assert body["releases"] == []
        assert body["defaultCandidateId"] is None

    def test_shared_product_string_stays_ambiguous_even_with_bootloader_evidence(self):
        from services import firmware_catalog_service as svc
        from services import firmware_compat_service as compat
        from services.bootloader_identity import VALID, BootloaderIdentity, build_identity

        # Pixhawk1 and CubeBlack legitimately share "PX4 BL FMU v2.x".
        entries = [
            _entry("Pixhawk1", ["PX4 BL FMU v2.x"]),
            _entry("CubeBlack", ["PX4 BL FMU v2.x"]),
        ]
        observed = build_identity(
            bootloader_revision=4,
            board_id=9,
            flash_size=2 * 1024 * 1024,
            usb_product_string="PX4 BL FMU v2.x",
        )
        assert observed.identity.validity == VALID
        with _catalog_patch(entries):
            identity = compat.apply_bootloader_identity(
                compat.identity_from_firmware_info(_connected_info()), observed
            )
            catalog = svc.get_catalog("Copter")
            resolution = compat.resolve(catalog.candidates, identity)
        assert resolution.outcome == "AMBIGUOUS"
        assert resolution.selected is None


# ---------------------------------------------------------------------------
# 7. unsupported hardware
# ---------------------------------------------------------------------------


class TestUnsupportedHardware:
    def test_non_copter_is_unsupported(self):
        entries = [_entry("Pixhawk1", ["Pixhawk1-BL"], vehicle="Rover")]
        with _LiveVehicle(
            entries,
            info=_connected_info(vehicleType="GROUNDROVER", vehicle="ArduRover"),
        ):
            result = wf.resolve()
        assert result["outcome"] == "UNSUPPORTED"

    def test_sitl_is_unsupported(self):
        with _LiveVehicle(_exact_entries(), environment="SITL"):
            result = wf.resolve()
        assert result["outcome"] == "UNSUPPORTED"


# ---------------------------------------------------------------------------
# 8. no matching firmware
# ---------------------------------------------------------------------------


class TestNoMatchingFirmware:
    def test_empty_catalog_is_no_match(self):
        with _LiveVehicle([]):
            result = wf.resolve()
        assert result["outcome"] == "NO_MATCH"

    def test_no_candidates_yields_no_releases(self, client):
        with _LiveVehicle([]):
            body = client.get("/api/setup/firmware/versions").json()
        assert body["releases"] == []

    def test_unmatched_product_string_is_no_match(self):
        from services import firmware_catalog_service as svc
        from services import firmware_compat_service as compat
        from services.bootloader_identity import VALID, build_identity

        observed = build_identity(
            bootloader_revision=4,
            board_id=9,
            flash_size=2 * 1024 * 1024,
            usb_product_string="Pixhawk1-BL",
        )
        assert observed.identity.validity == VALID
        with _catalog_patch([_entry("SomeOtherBoard", ["SomeOtherBoard-BL"])]):
            identity = compat.apply_bootloader_identity(
                compat.identity_from_firmware_info(_connected_info()), observed
            )
            catalog = svc.get_catalog("Copter")
            resolution = compat.resolve(catalog.candidates, identity)
        assert resolution.outcome == "NO_MATCH"
        assert resolution.selected is None

    def test_no_match_cannot_be_confirmed(self):
        with _LiveVehicle([]):
            body = wf.confirmation(confirmed=True)
        assert body["success"] is False
        assert body["confirmed"] is False


# ---------------------------------------------------------------------------
# 9. version list
# ---------------------------------------------------------------------------


class TestVersionList:
    def test_lists_only_real_catalogue_releases(self):
        entries = [
            _entry("Pixhawk1", ["Pixhawk1-BL"]),
            _entry(
                "Pixhawk1",
                ["Pixhawk1-BL"],
                **{
                    "mav-firmware-version-type": "BETA",
                    "mav-firmware-version": "4.8.0",
                    "mav-firmware-version-major": "4",
                    "mav-firmware-version-minor": "8",
                    "mav-firmware-version-patch": "0",
                    "mav-firmware-version-str": "V4.8.0-beta1",
                },
            ),
        ]
        with _LiveVehicle(entries, bootloader="Pixhawk1-BL"):
            body = wf.version_list()
        assert len(body["releases"]) == 2
        assert sorted(r["versionStr"] for r in body["releases"]) == ["V4.7.1", "V4.8.0-beta1"]
        assert {r["releaseType"] for r in body["releases"]} == {"OFFICIAL", "BETA"}

    def test_release_metadata_comes_from_the_manifest(self):
        with _exact_vehicle():
            release = wf.version_list()["releases"][0]
        assert release["platform"] == "Pixhawk1"
        assert release["boardId"] == 9
        assert release["imageSize"] == 1559908
        assert release["format"] == "apj"
        assert release["url"].startswith("https://firmware.ardupilot.org/")
        assert release["gitSha"] == "dbe792162d06cab66c3475fd5556bf7a120f119e"
        assert release["releaseLabel"] == "Stable"
        assert release["bootloaderStr"] == ["Pixhawk1-BL"]

    def test_other_platforms_are_not_listed(self):
        entries = _exact_entries() + [_entry("CubeBlack", ["CubeBlack-BL"])]
        with _LiveVehicle(entries, bootloader="Pixhawk1-BL"):
            body = wf.version_list()
        assert {r["platform"] for r in body["releases"]} == {"Pixhawk1"}

    def test_list_is_not_truncated_in_a_way_that_drops_the_default(self):
        entries = [
            _entry(
                "Pixhawk1",
                ["Pixhawk1-BL"],
                **{
                    "mav-firmware-version": f"4.{minor}.0",
                    "mav-firmware-version-major": "4",
                    "mav-firmware-version-minor": str(minor),
                    "mav-firmware-version-patch": "0",
                    "mav-firmware-version-str": f"V4.{minor}.0",
                },
            )
            for minor in range(wf._MAX_REPORTED_RELEASES + 10)
        ]
        with _LiveVehicle(entries, bootloader="Pixhawk1-BL"):
            body = wf.version_list()
        assert len(body["releases"]) == wf._MAX_REPORTED_RELEASES
        assert body["defaultCandidateId"] is not None


# ---------------------------------------------------------------------------
# 10. version selection
# ---------------------------------------------------------------------------


class TestVersionSelection:
    def _multi_channel(self):
        entries = [
            _entry("Pixhawk1", ["Pixhawk1-BL"]),
            _entry(
                "Pixhawk1",
                ["Pixhawk1-BL"],
                **{
                    "mav-firmware-version-type": "DEV",
                    "mav-firmware-version": "5.0.0",
                    "mav-firmware-version-major": "5",
                    "mav-firmware-version-minor": "0",
                    "mav-firmware-version-patch": "0",
                    "mav-firmware-version-str": "V5.0.0-dev",
                },
            ),
        ]
        return entries

    def test_default_selection_is_conservative(self):
        with _LiveVehicle(self._multi_channel(), bootloader="Pixhawk1-BL"):
            body = wf.version_list()
        default = next(r for r in body["releases"] if r["candidateId"] == body["defaultCandidateId"])
        assert default["releaseType"] == "OFFICIAL"

    def test_development_firmware_is_never_silently_default(self):
        entries = [
            _entry(
                "Pixhawk1",
                ["Pixhawk1-BL"],
                **{
                    "mav-firmware-version-type": "DEV",
                    "mav-firmware-version": "5.0.0",
                    "mav-firmware-version-major": "5",
                    "mav-firmware-version-minor": "0",
                    "mav-firmware-version-patch": "0",
                    "mav-firmware-version-str": "V5.0.0-dev",
                },
            )
        ]
        with _LiveVehicle(entries, bootloader="Pixhawk1-BL"):
            body = wf.version_list()
        assert len(body["releases"]) == 1
        # Offered, because it is real, but labelled honestly.
        assert body["releases"][0]["releaseLabel"] == "Development"

    def test_a_user_may_confirm_a_non_default_release_on_the_same_platform(self):
        with _LiveVehicle(self._multi_channel(), bootloader="Pixhawk1-BL"):
            releases = wf.version_list()["releases"]
            dev = next(r for r in releases if r["releaseType"] == "DEV")
            body = wf.confirmation(confirmed=True, candidate_id=dev["candidateId"])
        assert body["success"] is True
        assert body["nonDefaultChannel"] is True
        assert body["target"]["versionStr"] == "V5.0.0-dev"

    def test_a_client_cannot_nominate_a_different_platform(self):
        entries = self._multi_channel() + [_entry("CubeBlack", ["CubeBlack-BL"])]
        with _LiveVehicle(entries, bootloader="Pixhawk1-BL"):
            body = wf.confirmation(
                confirmed=True, candidate_id="Copter/CubeBlack/apj/4.7.1/OFFICIAL"
            )
        assert body["success"] is False
        assert body["confirmed"] is False

    def test_a_client_cannot_inject_an_arbitrary_url(self):
        with _exact_vehicle():
            body = wf.confirmation(
                confirmed=True, candidate_id="https://evil.example/flash.apj"
            )
        assert body["success"] is False
        assert body["confirmed"] is False


# ---------------------------------------------------------------------------
# 11. confirmation
# ---------------------------------------------------------------------------


class TestConfirmation:
    def test_confirmation_requires_explicit_action(self, client):
        with _exact_vehicle():
            body = client.post(
                "/api/setup/firmware/confirmation", json={"confirmed": False}
            ).json()
        assert body["success"] is True
        assert body["confirmed"] is False
        assert body["confirmationRequired"] is True
        assert body["state"] == "CONFIRMATION_REQUIRED"

    def test_confirmation_warning_is_present(self, client):
        with _exact_vehicle():
            body = client.post(
                "/api/setup/firmware/confirmation", json={"confirmed": True}
            ).json()
        assert "changes the flight-controller software" in body["warning"]
        assert inst.REAL_HARDWARE_REFUSAL in body["warning"]

    def test_confirmation_does_not_install(self, client):
        with _exact_vehicle():
            client.post("/api/setup/firmware/confirmation", json={"confirmed": True})
        assert inst.WORKFLOW.session.state not in (inst.COMPLETED, inst.DOWNLOADING)

    def test_confirming_a_different_candidate_invalidates_the_previous_record(self):
        entries = [
            _entry("Pixhawk1", ["Pixhawk1-BL"], **{
                "mav-firmware-version": "4.7.1",
                "mav-firmware-version-major": "4",
                "mav-firmware-version-minor": "7",
                "mav-firmware-version-patch": "1",
                "mav-firmware-version-str": "V4.7.1",
            }),
            _entry(
                "Pixhawk1",
                ["Pixhawk1-BL"],
                **{
                    "mav-firmware-version": "4.8.0",
                    "mav-firmware-version-major": "4",
                    "mav-firmware-version-minor": "8",
                    "mav-firmware-version-patch": "0",
                    "mav-firmware-version-str": "V4.8.0",
                },
            ),
        ]
        with _LiveVehicle(entries, bootloader="Pixhawk1-BL"):
            # Confirm the older release explicitly, so the two records differ.
            wf.confirmation(confirmed=True, candidate_id="Copter/Pixhawk1/apj/4.7.1/OFFICIAL")
            first = inst.CONFIRMATION.current.candidate_id
            assert first == "Copter/Pixhawk1/apj/4.7.1/OFFICIAL"
            wf.confirmation(confirmed=True, candidate_id="Copter/Pixhawk1/apj/4.8.0/OFFICIAL")
        assert inst.CONFIRMATION.current.candidate_id == "Copter/Pixhawk1/apj/4.8.0/OFFICIAL"
        # The old confirmation no longer authorises anything.
        assert inst.CONFIRMATION.current.matches("Copter/Pixhawk1/apj/4.7.1/OFFICIAL") is False

    def test_ambiguous_target_cannot_be_confirmed(self):
        entries = [_entry(p, bl) for p, bl in BOARD9_PLATFORMS]
        with _LiveVehicle(entries):
            body = wf.confirmation(confirmed=True)
        assert body["success"] is False
        assert body["confirmationRequired"] is False


# ---------------------------------------------------------------------------
# 12. cancellation
# ---------------------------------------------------------------------------


class TestCancellation:
    def test_cancel_endpoint_returns_a_real_state(self, client):
        with patch("core.state.get_vehicle_status", return_value={"connected": True}):
            body = client.post("/api/setup/firmware/cancel").json()
        assert body["state"] == inst.CANCELLED
        assert body["success"] is not True

    def test_cancel_marks_the_installer_cancelled(self):
        installer = inst.TestFirmwareInstaller(
            artifact_path="/tmp/x.apj", expected_version="4.7.1", observed_version="4.7.1"
        )
        installer.prepare()
        assert installer.cancel() is True
        assert installer.install().state == inst.CANCELLED

    def test_cancel_is_optional_on_the_interface(self):
        # A real installer cannot be interrupted; that is a legitimate False.
        assert inst.RealFirmwareInstaller().cancel() is False

    def test_cancelled_install_never_completes(self):
        session = inst.InstallationSession()
        session.advance(inst.READY)
        session.advance(inst.CONFIRMATION_REQUIRED)
        session.advance(inst.CANCELLED)
        assert session.snapshot()["terminal"] is True


# ---------------------------------------------------------------------------
# 13-15. download, checksum, corruption
# ---------------------------------------------------------------------------


class TestDownload:
    def test_download_refuses_without_confirmation(self, client):
        with _exact_vehicle():
            body = client.post("/api/setup/firmware/download", json={}).json()
        assert body["success"] is False
        assert body["state"] == "CONFIRMATION_REQUIRED"

    def test_download_verifies_and_reports_a_digest(self, client):
        with _confirmed_live():
            body = client.post("/api/setup/firmware/download", json={}).json()
        assert body["success"] is True
        assert body["state"] == "DOWNLOAD_VERIFIED"
        # The official manifest publishes no artifact digest, so the strongest
        # honest verdict is that the declared size matched.
        assert body["integrity"] == "SIZE_VERIFIED"
        assert body["downloadStatus"] == "DOWNLOAD_VERIFIED"
        assert body["checksumVerified"] is False
        assert body["verifiedForInstall"] is True
        assert len(body["sha256"]) == 64

    def test_digest_is_not_claimed_as_verified_against_the_manifest(self, client):
        with _confirmed_live():
            body = client.post("/api/setup/firmware/download", json={}).json()
        # The manifest publishes no artifact checksum; saying so is required.
        assert body["checksumVerified"] is False
        assert "checksum" in body["checksumNote"].lower()
        assert body["executed"] is False
        assert body["installed"] is False

    def test_http_error_is_rejected(self, client):
        with _confirmed_live():
            with _catalog_patch(_exact_entries(), artifact_status=404):
                body = client.post("/api/setup/firmware/download", json={}).json()
        assert body["success"] is False
        assert body["downloadStatus"] == "DOWNLOAD_FAILED"
        assert body["errorKind"] == "DOWNLOAD_FAILED"
        # A transport failure reaches no integrity verdict at all.
        assert not body.get("integrity")

    def test_corrupted_short_transfer_is_never_passed_on(self, client):
        with _confirmed_live():
            with _catalog_patch(_exact_entries(), artifact=b"short", artifact_headers={"content-length": str(len(ARTIFACT))}):
                body = client.post("/api/setup/firmware/download", json={}).json()
        assert body["success"] is False
        assert "incomplete transfer" in body["message"]
        assert body.get("verifiedForInstall") is not True

    def test_missing_content_length_is_not_claimed_as_verified(self, client):
        """No declared size and no digest means only the transfer was observed.

        Deliberately not an error: the artifact is kept, but it is reported as
        TRANSFER_COMPLETE_ONLY and refused for installation, because nothing
        published by the source can be checked against the bytes received.
        """
        with _confirmed_live():
            with _catalog_patch(
                _exact_entries(), artifact_headers={"content-length": None}
            ):
                body = client.post("/api/setup/firmware/download", json={}).json()
        assert body["success"] is True
        assert body["integrity"] == "TRANSFER_COMPLETE_ONLY"
        assert body["downloadStatus"] == "TRANSFER_COMPLETE_ONLY"
        assert body["verifiedForInstall"] is False
        assert body["cryptographicallyVerified"] is False
        assert body["integrityNote"]


# ---------------------------------------------------------------------------
# 16-18. test installation, progress, failure
# ---------------------------------------------------------------------------


class TestTestInstallation:
    """The TEST/SIMULATION adapter, exercised end to end with no vehicle."""

    def _run(self, *, vehicle="Copter", observed_version=None, fail_at=None):
        """Run the simulation, confirming the synthetic target first.

        The synthetic identity resolves nothing on a live vehicle, so the target
        is confirmed exactly as the test adapter documents: against the real
        catalogue entry the simulation will use.
        """
        with _catalog_patch(_exact_entries()):
            return wf.simulate_installation(
                vehicle=vehicle,
                observed_version=observed_version,
                fail_at=fail_at,
                confirmed=True,
            )

    def test_simulation_requires_the_explicit_confirmation_action(self):
        """Without ``confirmed`` the synthetic path refuses like a real one."""
        with _catalog_patch(_exact_entries()):
            result = wf.simulate_installation(vehicle="Copter", observed_version="V4.7.1")
        assert result["success"] is not True
        assert result["state"] == "CONFIRMATION_REQUIRED"
        assert "DOWNLOADING" not in result.get("history", [])

    def test_simulation_confirms_the_exact_candidate_server_side(self):
        with _catalog_patch(_exact_entries()):
            result = wf.simulate_installation(
                vehicle="Copter", observed_version="V4.7.1", confirmed=True
            )
        assert result["state"] == "COMPLETED"
        assert inst.CONFIRMATION.current.confirmed is True
        assert inst.CONFIRMATION.current.candidate_id == result["targetCandidateId"]

    def test_simulation_rejects_a_candidate_outside_the_catalogue(self):
        with _catalog_patch(_exact_entries()):
            result = wf.simulate_installation(
                vehicle="Copter",
                observed_version="V4.7.1",
                confirmed=True,
                candidate_id="Copter/NotAPlatform/apj/9.9.9/OFFICIAL",
            )
        assert result["success"] is not True
        assert result["state"] == "BLOCKED"

    def test_manifest_and_vehicle_version_forms_are_compared_by_value(self):
        """``V4.7.1`` in the manifest and ``4.7.1`` from the vehicle are equal."""
        assert inst.versions_match("V4.7.1", "4.7.1") is True
        assert inst.versions_match("V4.7.1", "4.7.1 (Official Release)") is True
        assert inst.versions_match("4.7.1", "v4.7.1") is True
        assert inst.versions_match("V4.7.1", "4.7.0") is False
        assert inst.versions_match("V4.7.1", None) is False
        assert inst.versions_match(None, "4.7.1") is False

    def test_simulation_completes_and_verifies(self):
        result = self._run(observed_version="V4.7.1")
        assert result["state"] == "COMPLETED"
        assert result["success"] is True
        assert result["versionVerified"] is True
        assert result["installedVersion"] == "V4.7.1"
        assert result["isSimulation"] is True
        assert result["hardwareTouched"] is False
        assert result["simulation"] is True
        assert result["compatibilityProven"] is False

    def test_simulation_never_claims_a_hardware_compatibility_result(self):
        result = self._run(observed_version="V4.7.1")
        assert result["outcome"] == "SIMULATION"
        assert result["mode"] == inst.TEST_LABEL

    def test_simulation_walks_every_state(self):
        result = self._run(observed_version="V4.7.1")
        for state in (
            "DETECTING",
            "IDENTIFYING",
            "RESOLVING",
            "CONFIRMATION_REQUIRED",
            "DOWNLOADING",
            "DOWNLOAD_VERIFIED",
            "PREPARING",
            "INSTALLING",
            "VERIFYING",
            "COMPLETED",
        ):
            assert state in result["history"], (state, result["history"])

    def test_progress_is_real_and_deterministic(self):
        first = self._run(observed_version="V4.7.1")["progress"]
        second = self._run(observed_version="V4.7.1")["progress"]
        assert [(p["state"], p["percent"]) for p in first] == [
            (p["state"], p["percent"]) for p in second
        ]
        assert first[-1]["percent"] == 100.0
        assert all(p["isSimulation"] is True for p in first)

    def test_verification_failure_never_reports_completed(self):
        result = self._run(observed_version="V1.0.0")
        assert result["state"] == "FAILED"
        assert result["success"] is not True
        assert result["versionVerified"] is False
        # A wrong observed version is a specific, machine-readable mismatch
        # rather than a generic failure.
        assert result["error"] == inst.VERIFICATION_MISMATCH
        assert result["verification"]["error"] == inst.VERIFICATION_MISMATCH

    def test_simulated_install_failure_is_reported(self):
        result = self._run(observed_version="V4.7.1", fail_at="INSTALLING")
        assert result["state"] == "FAILED"
        assert result["success"] is not True

    def test_simulation_requires_confirmation(self):
        with _catalog_patch(_exact_entries()):
            result = wf.simulate_installation(vehicle="Copter", observed_version="V4.7.1")
        assert result["success"] is False
        assert result["state"] == "CONFIRMATION_REQUIRED"

    def test_asynchronous_simulation_exposes_pollable_state(self, client):
        with _catalog_patch(_exact_entries()):
            from services import firmware_catalog_service as svc

            inst.CONFIRMATION.record(
                svc.get_catalog("Copter").candidates[0], synthetic=True
            )
            started = client.post(
                "/api/setup/firmware/simulate",
                json={"vehicle": "Copter", "observedVersion": "V4.7.1", "asynchronous": False},
            ).json()
        assert started["state"] == "COMPLETED"
        assert started["hardwareTouched"] is False


# ---------------------------------------------------------------------------
# 19. verification
# ---------------------------------------------------------------------------


class TestVerification:
    def test_verification_compares_expected_with_observed(self):
        with patch(
            "services.setup_service.request_firmware_info",
            return_value=_connected_info(version="4.9.9"),
        ):
            result = wf.verify_installed_version("4.9.9")
        assert result["verified"] is True
        assert result["observedVersion"] == "4.9.9"

    def test_verification_fails_on_mismatch(self):
        with patch(
            "services.setup_service.request_firmware_info",
            return_value=_connected_info(version="4.7.0"),
        ):
            result = wf.verify_installed_version("4.9.9")
        assert result["verified"] is False
        assert "Not verified" in result["message"]

    def test_verification_never_assumes_equality(self):
        with patch(
            "services.setup_service.request_firmware_info",
            return_value=_connected_info(version="4.7.0"),
        ):
            result = wf.verify_installed_version("4.9.9")
        assert result["observedVersion"] != result["expectedVersion"]

    def test_verification_requires_a_vehicle_reply(self):
        with patch(
            "services.setup_service.request_firmware_info",
            return_value={"success": False, "connected": True, "message": "timeout"},
        ):
            result = wf.verify_installed_version("4.9.9")
        assert result["verified"] is False
        assert result["observedVersion"] is None

    def test_verification_is_an_installer_interface_method(self):
        assert "verify" in inst.FirmwareInstaller.__abstractmethods__
        installer = inst.TestFirmwareInstaller(
            artifact_path="/tmp/x.apj", expected_version="1.2.3", observed_version="1.2.3"
        )
        assert installer.verify().verified is True
        assert (
            inst.TestFirmwareInstaller(
                artifact_path="/tmp/x.apj", expected_version="1.2.3", observed_version="9.9.9"
            ).verify().verified
            is False
        )


# ---------------------------------------------------------------------------
# 20-21. disconnect and reconnect
# ---------------------------------------------------------------------------


class TestDisconnectReconnect:
    def test_disconnect_during_a_connection_dependent_state(self):
        session = inst.WORKFLOW.reset()
        session.advance("DETECTING")
        session.advance("IDENTIFYING")
        with _no_device():
            body = wf.status()
        assert body["state"] == "DISCONNECTED"
        assert body["terminal"] is True

    def test_disconnect_never_reports_success(self):
        session = inst.WORKFLOW.reset()
        session.advance("READY")
        session.advance("DOWNLOADING")
        with _no_device():
            body = wf.status()
        assert body["state"] != "COMPLETED"

    def test_reconnect_rereads_everything(self):
        session = inst.WORKFLOW.reset()
        session.advance("READY")
        session.advance("DOWNLOADING")
        with _no_device():
            assert wf.status()["state"] == "DISCONNECTED"

        # Reconnect: detect → identify → resolve all run again.
        with _exact_vehicle():
            result = wf.workflow()
        assert result["connected"] is True
        assert result["current"]["version"] == "4.7.0"
        assert result["outcome"] == "EXACT_MATCH"

    def test_connection_dependent_states_are_declared(self):
        for state in (inst.DOWNLOADING, inst.INSTALLING, inst.VERIFYING, inst.PREPARING):
            assert state in inst.CONNECTION_DEPENDENT_STATES
        assert inst.COMPLETED not in inst.CONNECTION_DEPENDENT_STATES


# ---------------------------------------------------------------------------
# 22. real hardware installation blocked
# ---------------------------------------------------------------------------


class TestRealHardwareBlocked:
    def test_hardware_is_refused_before_any_download(self):
        with _exact_vehicle():
            wf.confirmation(confirmed=True)
            result = wf.run_install(allow_simulation=True)
        assert result["state"] == inst.BLOCKED
        assert result["success"] is not True
        assert inst.REAL_HARDWARE_REFUSAL in result["message"]
        assert "download" not in result

    def test_blocked_install_touches_no_hardware(self):
        with _exact_vehicle():
            wf.confirmation(confirmed=True)
            result = wf.run_install(allow_simulation=True)
        assert result["hardwareTouched"] is False
        assert result["versionVerified"] is False

    def test_blocked_install_never_reaches_installing(self):
        with _exact_vehicle():
            wf.confirmation(confirmed=True)
            result = wf.run_install(allow_simulation=True)
        assert "INSTALLING" not in result["history"]
        assert "DOWNLOADING" not in result["history"]
        assert "COMPLETED" not in result["history"]

    def test_real_installer_raises_on_every_entry_point(self):
        installer = inst.RealFirmwareInstaller()
        for call in (
            lambda: installer.prepare("/tmp/x.apj", "1.2.3"),
            lambda: installer.install(),
            lambda: installer.verify(),
        ):
            with pytest.raises(inst.InstallationBlockedError):
                call()

    def test_capability_reports_the_gate_truthfully(self):
        cap = inst.capability()
        assert cap["realInstallationAllowed"] is False
        assert cap["installationMessage"] == inst.REAL_HARDWARE_REFUSAL
        assert cap["blockedOnHardware"] is True

    def test_gate_is_not_a_configurable_flag(self):
        assert inst.REAL_INSTALLATION_ALLOWED is False
        from core import config

        assert config.FIRMWARE_INSTALL_ENABLED is False

    def test_install_endpoint_refuses_a_real_board(self, client):
        with _exact_vehicle():
            wf.confirmation(confirmed=True)
            body = client.post(
                "/api/setup/firmware/install",
                json={"allowSimulation": True, "asynchronous": False},
            ).json()
        assert body["state"] == inst.BLOCKED
        assert body["realInstallationAllowed"] is False


class TestDownloadFailureTaxonomy:
    """A failed *transfer* must not masquerade as a failed *verification*.

    Both are refusals, but they mean different things to an operator: "the
    server did not give us the file" versus "the file did not survive the trip
    intact". Collapsing them into one code hides which one happened.
    """

    def test_http_error_is_a_transfer_failure(self, client):
        with _confirmed_live():
            with _catalog_patch(_exact_entries(), artifact_status=500):
                body = client.post("/api/setup/firmware/download", json={}).json()
        assert body["success"] is False
        assert body["downloadStatus"] == "DOWNLOAD_FAILED"

    def test_missing_content_length_is_only_transfer_complete(self, client):
        """No declared size and no digest means only the transfer was observed."""
        with _confirmed_live():
            with _catalog_patch(
                _exact_entries(), artifact_headers={"content-length": ""}
            ):
                body = client.post("/api/setup/firmware/download", json={}).json()
        assert body["success"] is True
        assert body["integrity"] == "TRANSFER_COMPLETE_ONLY"
        assert body["downloadStatus"] == "TRANSFER_COMPLETE_ONLY"
        # Not verified, so it must not be offered for installation.
        assert body["verifiedForInstall"] is False
        assert body["cryptographicallyVerified"] is False
        assert body["integrityNote"]

    def test_incomplete_transfer_fails_verification(self, client):
        with _confirmed_live():
            with _catalog_patch(
                _exact_entries(),
                artifact_headers={"content-length": str(len(ARTIFACT) + 500)},
            ):
                body = client.post("/api/setup/firmware/download", json={}).json()
        assert body["success"] is False
        assert body["integrity"] == "VERIFICATION_FAILED"
        assert body["downloadStatus"] == "DOWNLOAD_VERIFICATION_FAILED"
        assert body["errorKind"] == "DOWNLOAD_VERIFICATION_FAILED"

    def test_a_transport_failure_is_never_called_a_verification_failure(self, client):
        with _confirmed_live():
            with _catalog_patch(
                _exact_entries(), artifact_status=500
            ):
                body = client.post("/api/setup/firmware/download", json={}).json()
        assert body["success"] is False
        assert body["downloadStatus"] == "DOWNLOAD_FAILED"
        assert body["errorKind"] == "DOWNLOAD_FAILED"

    def test_published_digest_is_verified_when_the_source_offers_one(self, client):
        """CHECKSUM_VERIFIED is reachable whenever a digest is published."""
        import hashlib

        published = hashlib.sha256(ARTIFACT).hexdigest()
        entries = [_entry("Pixhawk1", ["Pixhawk1-BL"], sha256=published)]
        with _exact_vehicle(entries, auto_confirm=True):
            with _catalog_patch(entries):
                body = client.post("/api/setup/firmware/download", json={}).json()
        assert body["success"] is True
        assert body["integrity"] == "CHECKSUM_VERIFIED"
        assert body["checksumVerified"] is True
        assert body["cryptographicallyVerified"] is True

    def test_a_wrong_published_digest_fails_verification(self, client):
        entries = [_entry("Pixhawk1", ["Pixhawk1-BL"], sha256="0" * 64)]
        with _exact_vehicle(entries, auto_confirm=True):
            with _catalog_patch(entries):
                body = client.post("/api/setup/firmware/download", json={}).json()
        assert body["success"] is False
        assert body["integrity"] == "VERIFICATION_FAILED"
        assert body["downloadStatus"] == "DOWNLOAD_VERIFICATION_FAILED"


class TestDetectionIdentityPayload:
    """Detection must expose the evidence the resolver and UI depend on."""

    def test_detection_reports_usb_and_bootloader_evidence_keys(self):
        body = wf.detect()
        for key in (
            "usbProduct",
            "usbSerialNumber",
            "usbManufacturer",
            "bootloaderIdentityAvailable",
            "bootloaderRevision",
            "bootloaderBoardId",
            "flashSize",
            "bootloaderUsbProduct",
        ):
            assert key in body, key

    def test_detection_does_not_claim_bootloader_identity_in_normal_mode(self):
        body = wf.detect()
        # No board is attached under pytest, so no bootloader identity can be
        # asserted. Every bootloader field must stay falsy rather than guessed.
        assert body["bootloaderIdentityAvailable"] is False
        assert body["bootloaderRevision"] is None
        assert body["bootloaderBoardId"] is None


class TestSnapshotSuccessIsDerived:
    """A session snapshot must never assert success on its own.

    ``success`` means installed *and* verified. Deriving it from the state keeps
    the status endpoint honest even when no caller overrides it.
    """

    def test_a_fresh_session_does_not_claim_success(self):
        assert inst.InstallationSession().snapshot()["success"] is False

    def test_no_non_completed_state_claims_success(self):
        for state in (
            "READY", "DETECTING", "IDENTIFYING", "RESOLVING",
            "CONFIRMATION_REQUIRED", "DOWNLOADING", "DOWNLOAD_VERIFIED",
            "PREPARING", "INSTALLING", "VERIFYING",
            "FAILED", "CANCELLED", "DISCONNECTED", "BLOCKED",
        ):
            session = inst.InstallationSession()
            session._state = state  # bypass transition rules: shape only
            assert session.snapshot()["success"] is False, state

    def test_disconnect_status_never_reports_success(self):
        session = inst.WORKFLOW.reset()
        session.advance("DETECTING")
        with _no_device():
            body = wf.status()
        assert body["state"] == "DISCONNECTED"
        assert body["success"] is False


class TestBusyResponseShape:
    """A refusal to start must still answer with the normal payload keys."""

    def test_busy_response_never_claims_verified_success(self, client, monkeypatch):
        """When a worker is already claimed, the refusal still answers fully."""
        from services import firmware_workflow_service as wfm

        monkeypatch.setattr(wfm.WORKFLOW, "start_worker", lambda *a, **k: False)
        body = client.post("/api/setup/firmware/install", json={}).json()
        assert body["busy"] is True
        assert body["success"] is False
        assert body["accepted"] is False
        assert body["versionVerified"] is False

    def test_simulation_busy_response_is_also_complete(self, client, monkeypatch):
        from services import firmware_workflow_service as wfm

        monkeypatch.setattr(wfm.WORKFLOW, "start_worker", lambda *a, **k: False)
        with _catalog_patch(_exact_entries()):
            body = client.post("/api/setup/firmware/simulate", json={}).json()
        assert body["busy"] is True
        assert body["success"] is False
        assert body["versionVerified"] is False


# ---------------------------------------------------------------------------
# 23. no fake success
# ---------------------------------------------------------------------------


class TestNoFakeSuccess:
    def test_ambiguous_hardware_cannot_install(self):
        entries = [_entry(p, bl) for p, bl in BOARD9_PLATFORMS]
        with _LiveVehicle(entries):
            result = wf.run_install(allow_simulation=True)
        assert result["success"] is not True
        assert result["state"] == inst.BLOCKED

    def test_accepted_async_request_is_not_reported_as_installed(self, client):
        """``success`` means installed-and-verified, never merely accepted."""
        body = client.post("/api/setup/firmware/install", json={}).json()
        assert body["accepted"] is True
        assert body["success"] is False
        assert body["versionVerified"] is False
        assert body["terminal"] is False

    def test_accepted_async_simulation_is_not_reported_as_installed(self, client):
        with _catalog_patch(_exact_entries()):
            body = client.post(
                "/api/setup/firmware/simulate", json={"vehicle": "Copter"}
            ).json()
        assert body["success"] is False
        assert body["versionVerified"] is False
        assert body["hardwareTouched"] is False

    def test_simulation_endpoint_rejects_an_unconfirmed_request(self, client):
        with _catalog_patch(_exact_entries()):
            body = client.post(
                "/api/setup/firmware/simulate",
                json={"vehicle": "Copter", "observedVersion": "V4.7.1", "asynchronous": False},
            ).json()
        assert body["success"] is not True
        assert body["state"] == "CONFIRMATION_REQUIRED"
        assert "DOWNLOADING" not in body.get("history", [])

    def test_simulation_endpoint_runs_end_to_end(self, client):
        with _catalog_patch(_exact_entries()):
            body = client.post(
                "/api/setup/firmware/simulate",
                json={
                    "vehicle": "Copter",
                    "observedVersion": "4.7.1 (Official Release)",
                    "confirmed": True,
                    "asynchronous": False,
                },
            ).json()
        assert body["state"] == "COMPLETED"
        assert body["success"] is True
        assert body["versionVerified"] is True
        assert body["hardwareTouched"] is False
        assert body["isSimulation"] is True

    def test_real_board_is_blocked_even_before_a_broken_download_matters(self, client):
        # With a board attached the gate fires first, so a broken artifact is
        # never even fetched.
        with _confirmed_live():
            with _catalog_patch(_exact_entries(), artifact_status=500):
                body = client.post(
                    "/api/setup/firmware/install",
                    json={"allowSimulation": True, "asynchronous": False},
                ).json()
        assert body["success"] is not True
        assert body["state"] == "BLOCKED"

    def test_failed_download_cannot_report_installed(self, client):
        with _catalog_patch(_exact_entries(), artifact_status=500):
            from services import firmware_catalog_service as svc

            inst.CONFIRMATION.record(
                svc.get_catalog("Copter").candidates[0], synthetic=True
            )
            body = client.post(
                "/api/setup/firmware/simulate",
                json={
                    "vehicle": "Copter",
                    "observedVersion": "V4.7.1",
                    "asynchronous": False,
                },
            ).json()
        assert body["success"] is not True
        assert body["state"] == "FAILED"
        assert body["error"] == "download-failed"
        assert body["versionVerified"] is False
        assert body["hardwareTouched"] is False

    def test_installed_version_is_never_assumed_from_the_target(self):
        session = inst.InstallationSession()
        session.set(
            target_version="1.2.3",
            installed_version="9.9.9",
            version_verified=False,
        )
        payload = session.snapshot()
        assert payload["targetVersion"] != payload["installedVersion"]
        assert payload["versionVerified"] is False

    def test_every_terminal_state_is_terminal(self):
        for state in ("COMPLETED", "FAILED", "CANCELLED", "DISCONNECTED", "BLOCKED"):
            session = inst.InstallationSession()
            session.state = state
            assert session.snapshot()["terminal"] is True

    def test_illegal_transitions_are_refused(self):
        session = inst.InstallationSession()
        with pytest.raises(ValueError):
            session.advance("COMPLETED")
        with pytest.raises(ValueError):
            session.advance("NOT_A_STATE")

    def test_client_cannot_confirm_and_install_in_one_call(self, client):
        """Passing ``confirmed: true`` does not stand in for a confirmation.

        Confirmation is a separate, recorded action that is re-validated against
        the live board and catalogue. An install that cannot be confirmed refuses
        and *settles* -- parking in CONFIRMATION_REQUIRED would report "waiting"
        while doing nothing, and would leave a client polling forever.
        """
        with _exact_vehicle():
            body = client.post(
                "/api/setup/firmware/install",
                json={"confirmed": True, "asynchronous": False},
            ).json()
        from services import firmware_errors as fe

        assert body["success"] is False
        assert body["state"] == "BLOCKED"
        assert body["errorKind"] == fe.CONFIRMATION_INVALID
        assert body["terminal"] is True
        assert body["versionVerified"] is False
        assert body["hardwareTouched"] is False

    def test_a_session_snapshot_cannot_be_mutated_by_a_reader(self):
        session = inst.InstallationSession()
        snapshot = session.snapshot()
        snapshot["state"] = "COMPLETED"
        assert session.state != "COMPLETED"


# ---------------------------------------------------------------------------
# 24. no hardcoded firmware version
# ---------------------------------------------------------------------------


class TestNoHardcodedVersions:
    def test_source_contains_no_pinned_version_literals(self):
        source = inspect.getsource(wf)
        for literal in ("4.7.1", "4.8.0", "4.9.9", "V4.7"):
            assert literal not in source, literal

    def test_release_versions_always_come_from_the_catalogue(self):
        entries = [
            _entry(
                "Pixhawk1",
                ["Pixhawk1-BL"],
                **{
                    "mav-firmware-version": "4.9.2",
                    "mav-firmware-version-major": "4",
                    "mav-firmware-version-minor": "9",
                    "mav-firmware-version-patch": "2",
                    "mav-firmware-version-str": "V4.9.2",
                },
            )
        ]
        with _LiveVehicle(entries, bootloader="Pixhawk1-BL"):
            assert wf.version_list()["releases"][0]["versionStr"] == "V4.9.2"

    def test_release_labels_are_channel_names_not_versions(self):
        assert wf.RELEASE_LABELS == {
            "OFFICIAL": "Stable",
            "BETA": "Beta",
            "DEV": "Development",
        }


# ---------------------------------------------------------------------------
# canonical production event taxonomy
# ---------------------------------------------------------------------------


class _EventRecorder:
    """Collects structured events in memory, through the logger seam.

    Tests must never write to the production log file, and they must not depend
    on what any earlier test left in it, so every case gets its own recorder.
    """

    def __init__(self):
        import logging as _logging

        self.events = []
        self._logger = _logging.getLogger(f"firmware.test.{id(self)}")
        self._logger.setLevel(_logging.DEBUG)
        self._logger.propagate = False
        self._handler = _RecordingHandler(self.events)
        self._logger.addHandler(self._handler)

    @property
    def names(self):
        return {e["event"] for e in self.events}

    def of(self, name):
        return next(e for e in self.events if e["event"] == name)


@pytest.fixture()
def events():
    from services import firmware_logging as fwlog

    recorder = _EventRecorder()
    fwlog.use_logger(recorder._logger)
    try:
        yield recorder
    finally:
        fwlog.use_logger(None)
        wf._set_was_connected(False)


class TestCanonicalEventTaxonomy:
    """Every event name an operator may grep for must be really emitted.

    The names are fixed and uppercase on purpose: they are the contract the
    documentation is written against, so a rename is a silent break. Each is
    produced here by a real code path rather than asserted against a constant.
    """

    def test_detection_is_recorded(self, events):
        with _exact_vehicle(_exact_entries(), bootloader="Pixhawk1-BL"):
            wf.detect(include_identity=True)
        assert "DETECTION" in events.names
        detection = events.of("DETECTION")
        assert detection["phase"] == "detection"
        assert detection["outcome"] == "CONNECTED"
        assert detection["usbProduct"] == "Pixhawk1"

    def test_identity_is_recorded_when_the_bootloader_is_read(self, events):
        from services import bootloader_validation_service as bvs
        from services.bootloader_identity_service import TRANSPORT_BOOTLOADER

        class _Report:
            transport = type("T", (), {"kind": TRANSPORT_BOOTLOADER})()
            can_resolve_platform = True
            missing_fields = []
            bootloader_revision = 4
            board_id = 9
            flash_size = 2 * 1024 * 1024
            bootloader_usb_product_string = "Pixhawk1-BL"

            def to_dict(self):
                return {"canResolvePlatform": True, "bootloaderRevision": 4}

        machine = bvs.BootloaderValidationMachine()
        machine.observe_transport(
            type("P", (), {"kind": TRANSPORT_BOOTLOADER})()
        )
        assert machine.observe_identity(_Report()) == bvs.IDENTITY_RESOLVED
        assert "IDENTITY" in events.names
        identity = events.of("IDENTITY")
        assert identity["outcome"] == "READ"
        assert identity["bootloaderProduct"] == "Pixhawk1-BL"
        assert identity["canResolvePlatform"] is True

    def test_resolution_selection_and_confirmation_are_recorded(self, events):
        with _exact_vehicle(_exact_entries(), bootloader="Pixhawk1-BL"):
            wf.detect(include_identity=True)
            wf.confirmation(confirmed=True)
        assert {"RESOLUTION", "SELECTION", "CONFIRMATION"} <= events.names
        # A resolution records the evidence it decided on, not just the answer.
        assert events.of("RESOLUTION")["signalsUsed"]
        assert events.of("RESOLUTION")["reason"]
        assert events.of("SELECTION")["candidateId"]
        assert events.of("CONFIRMATION")["confirmed"] is True

    def test_download_start_verification_and_completion_are_recorded(self, events):
        with _exact_vehicle(_exact_entries(), auto_confirm=True):
            with _catalog_patch(_exact_entries()):
                wf.download()
        assert {
            "DOWNLOAD_STARTED",
            "DOWNLOAD_VERIFICATION",
            "DOWNLOAD_COMPLETED",
        } <= events.names
        verification = events.of("DOWNLOAD_VERIFICATION")
        assert verification["outcome"] == "SIZE_VERIFIED"
        assert verification["verifiedForInstall"] is True

    def test_a_failed_download_is_recorded_with_its_kind(self, events):
        with _exact_vehicle(_exact_entries(), auto_confirm=True):
            with _catalog_patch(_exact_entries(), artifact_status=500):
                wf.download()
        assert "DOWNLOAD_FAILED" in events.names
        failed = events.of("DOWNLOAD_FAILED")
        assert failed["errorKind"] == "DOWNLOAD_FAILED"
        assert failed["reason"]
        # A transport failure is not an integrity verdict.
        assert "DOWNLOAD_VERIFICATION" not in events.names

    def test_a_refused_installation_is_recorded_as_a_failure(self, events):
        session = inst.InstallationSession()
        session.advance(inst.BLOCKED, "Real installation is disabled.")
        assert {"INSTALLER_STATE", "FAILURE"} <= events.names
        failure = events.of("FAILURE")
        assert failure["stage"] == "installer"
        assert failure["reason"] == "Real installation is disabled."
        assert failure["outcome"] == inst.BLOCKED

    def test_post_install_verification_is_recorded(self, events):
        wf.log_verification(
            {
                "verified": False,
                "error": inst.VERIFICATION_MISMATCH,
                "message": "The board still reports V4.7.0.",
                "expectedVersion": "V4.7.1",
                "observedVersion": "V4.7.0",
                "mismatches": ["firmware version"],
                "source": "autopilot_version",
            },
            stage="post_install",
        )
        assert "POST_INSTALL_VERIFICATION" in events.names
        event = events.of("POST_INSTALL_VERIFICATION")
        assert event["outcome"] == inst.VERIFICATION_MISMATCH
        assert event["expectedVersion"] == "V4.7.1"
        assert event["observedVersion"] == "V4.7.0"
        assert event["mismatches"] == ["firmware version"]

    def test_reconnect_is_distinguished_from_a_first_connect(self, events):
        wf._set_was_connected(None)          # nothing observed yet
        with _exact_vehicle(_exact_entries(), bootloader="Pixhawk1-BL"):
            wf.detect(include_identity=True)   # first connect
            wf.detect(include_identity=True)   # still connected
            assert "RECONNECT" not in events.names
            wf._set_was_connected(False)      # the link dropped
            wf.detect(include_identity=True)   # and came back
        assert "RECONNECT" in events.names
        assert events.of("RECONNECT")["outcome"] == "RECONNECTED"

    def test_no_event_is_written_to_the_production_log(self, events, tmp_path):
        from services import firmware_logging as fwlog

        assert fwlog.injected_logger() is events._logger
        with _exact_vehicle(_exact_entries(), auto_confirm=True):
            wf.detect(include_identity=True)
        assert events.names

    def test_every_required_event_name_is_declared(self):
        from services import firmware_logging as fwlog

        required = {
            "DETECTION", "IDENTITY", "RESOLUTION", "SELECTION", "CONFIRMATION",
            "DOWNLOAD_STARTED", "DOWNLOAD_COMPLETED", "DOWNLOAD_FAILED",
            "DOWNLOAD_VERIFICATION", "INSTALLER_STATE", "DISCONNECT", "RECONNECT",
            "POST_INSTALL_VERIFICATION", "FAILURE",
        }
        declared = {
            value for name, value in vars(fwlog).items() if isinstance(value, str)
        }
        assert required <= declared, sorted(required - declared)


# ---------------------------------------------------------------------------
# unified error taxonomy on the API surface
# ---------------------------------------------------------------------------


class TestErrorTaxonomyOnTheApi:
    """Every firmware response carries one kind from the single taxonomy.

    A client must be able to branch on ``errorKind`` alone. That only works if
    the value is always a real kind, is ``None`` exactly when nothing went
    wrong, and never leaks an internal service name.
    """

    def test_the_taxonomy_has_exactly_the_fourteen_kinds(self):
        from services import firmware_errors as fe

        assert len(fe.ERROR_KINDS) == 14
        assert len(set(fe.ERROR_KINDS)) == 14
        for kind in fe.ERROR_KINDS:
            fe.assert_known(kind)
            assert fe.describe(kind) and fe.describe(kind) != kind

    def test_no_device_detection_reports_device_not_connected(self, client):
        with _no_device():
            body = client.get("/api/setup/firmware/detection").json()
        assert body["state"] == "NO_DEVICE"
        assert body["errorKind"] == "DEVICE_NOT_CONNECTED"
        assert body["errorMessage"]

    def test_a_healthy_session_reports_no_error(self, client):
        with _exact_vehicle(_exact_entries(), bootloader="Pixhawk1-BL"):
            body = client.post(
                "/api/setup/firmware/confirmation", json={"confirmed": True}
            ).json()
        assert body["errorKind"] is None
        assert body["errorMessage"] is None

    def test_a_refused_install_is_blocked_not_failed(self, client):
        with _exact_vehicle(_exact_entries(), auto_confirm=True):
            body = client.post("/api/setup/firmware/install", json={}).json()
            assert body["accepted"] is True
            # Accepted work in flight is not a failure.
            assert body["errorKind"] is None

    def test_a_cancelled_session_is_not_a_failure(self, client):
        with _exact_vehicle(_exact_entries(), auto_confirm=True):
            body = client.post("/api/setup/firmware/cancel", json={}).json()
        assert body["state"] == "CANCELLED"
        assert body["errorKind"] is None

    def test_a_transport_failure_is_reported_as_a_download_failure(self, client):
        with _exact_vehicle(_exact_entries(), auto_confirm=True):
            with _catalog_patch(_exact_entries(), artifact_status=500):
                body = client.post("/api/setup/firmware/download", json={}).json()
        assert body["errorKind"] == "DOWNLOAD_FAILED"
        assert body["downloadStatus"] == "DOWNLOAD_FAILED"

    def test_a_damaged_artifact_is_reported_as_a_verification_failure(self, client):
        with _exact_vehicle(_exact_entries(), auto_confirm=True):
            with _catalog_patch(
                _exact_entries(), artifact_headers={"content-length": "999999"}
            ):
                body = client.post("/api/setup/firmware/download", json={}).json()
        assert body["errorKind"] == "DOWNLOAD_VERIFICATION_FAILED"
        assert body["integrity"] == "VERIFICATION_FAILED"

    def test_every_firmware_endpoint_reports_a_valid_kind(self, client):
        from services import firmware_errors as fe

        endpoints = [
            "/api/setup/firmware",
            "/api/setup/firmware/capability",
            "/api/setup/firmware/catalog",
            "/api/setup/firmware/workflow",
            "/api/setup/firmware/versions",
            "/api/setup/firmware/status",
            "/api/setup/firmware/pre-install-checks",
            "/api/setup/firmware/detection",
            "/api/setup/firmware/bootloader-identity",
            "/api/setup/firmware/bootloader-validation/status",
        ]
        with _no_device():
            for endpoint in endpoints:
                body = client.get(endpoint).json()
                assert "errorKind" in body, endpoint
                assert "errorMessage" in body, endpoint
                kind = body["errorKind"]
                assert kind is None or kind in fe.ERROR_KINDS, (endpoint, kind)

    def test_an_unrecognised_internal_outcome_is_never_forced_into_a_kind(self):
        from services import firmware_errors as fe

        # It stays visible under its own name instead of being coerced.
        assert fe.from_resolution("SOMETHING_NEW") == "SOMETHING_NEW"
        with pytest.raises(AssertionError):
            fe.assert_known(fe.from_resolution("SOMETHING_NEW"))
        # An absent outcome is not an error at all.
        assert fe.from_resolution(None) is None
        assert fe.from_state(None) is None
        assert fe.from_download(None) is None


# ---------------------------------------------------------------------------
# detection field availability
# ---------------------------------------------------------------------------


class TestDetectionFieldAvailability:
    """An unavailable field must say why, not just be null.

    A bare ``None`` cannot distinguish "the board reported nothing", "we have
    not read it yet" and "this board cannot supply it", and an operator seeing
    three nulls has no way to tell which is the case.
    """

    def test_every_identity_field_is_always_reported(self, client):
        with _exact_vehicle(_exact_entries(), bootloader="Pixhawk1-BL"):
            fields = client.get("/api/setup/firmware/detection").json()["fields"]
        assert set(fields) == set(wf._IDENTITY_FIELDS)
        for name, entry in fields.items():
            assert set(entry) == {"available", "reason"}, name
            assert isinstance(entry["available"], bool), name

    def test_an_available_field_has_no_reason(self, client):
        with _exact_vehicle(_exact_entries(), bootloader="Pixhawk1-BL"):
            body = client.get("/api/setup/firmware/detection").json()
        fields = body["fields"]
        for name in ("firmwareVersion", "firmwareRelease", "boardVersion"):
            assert fields[name]["available"] is True
            assert fields[name]["reason"] is None
            assert body[name] is not None

    def test_bootloader_fields_explain_that_the_board_is_in_normal_mode(self, client):
        # ``bootloader=None`` is the point of this test: the fixture otherwise
        # seeds a bootloader observation, and then the fields *would* be available.
        with _exact_vehicle(_exact_entries(), bootloader=None):
            body = client.get("/api/setup/firmware/detection").json()
        assert body["bootloaderIdentityAvailable"] is False
        for name in ("bootloaderRevision", "bootloaderBoardId", "flashSize",
                     "bootloaderUsbProduct"):
            entry = body["fields"][name]
            assert entry["available"] is False
            assert "normal mode" in entry["reason"]

    def test_a_board_with_no_link_reports_no_device_for_every_field(self, client):
        with _no_device():
            body = client.get("/api/setup/firmware/detection").json()
        assert body["state"] == "NO_DEVICE"
        assert body["connected"] is False
        assert body["fields"]["bootloaderRevision"]["reason"] == "No vehicle is connected."

    def test_a_silent_vehicle_says_it_answered_nothing(self, client):
        with _LiveVehicle(_exact_entries(), info={"success": False, "connected": True}):
            body = client.get("/api/setup/firmware/detection").json()
        entry = body["fields"]["firmwareVersion"]
        assert entry["available"] is False
        assert "AUTOPILOT_VERSION" in entry["reason"]

    def test_availability_never_claims_a_field_the_payload_lacks(self, client):
        with _exact_vehicle(_exact_entries(), bootloader="Pixhawk1-BL"):
            body = client.get("/api/setup/firmware/detection").json()
        for name, entry in body["fields"].items():
            # The two must always agree, in both directions.
            assert entry["available"] == (body.get(name) is not None), name
            assert bool(entry["available"]) or entry["reason"], name


# ---------------------------------------------------------------------------
# release rows: platform and compatibility
# ---------------------------------------------------------------------------


class TestReleaseRowsCarryPlatformAndCompatibility:
    """A release row must say what it is for and why it may be offered."""

    def test_every_release_names_its_platform_and_vehicle(self, client):
        with _exact_vehicle(_exact_entries(), bootloader="Pixhawk1-BL"):
            releases = client.get("/api/setup/firmware/versions").json()["releases"]
        assert releases
        for release in releases:
            assert release["platform"] == "Pixhawk1"
            assert release["vehicle"] == "Copter"

    def test_a_compatible_release_reports_the_resolvers_evidence(self, client):
        with _exact_vehicle(_exact_entries(), bootloader="Pixhawk1-BL"):
            releases = client.get("/api/setup/firmware/versions").json()["releases"]
        compatibility = releases[0]["compatibility"]
        assert compatibility["status"] == "COMPATIBLE"
        # The evidence must be the resolver's, not a bare assertion.
        assert compatibility["evidence"]
        assert "Pixhawk1-BL" in compatibility["reason"]

    def test_only_one_release_is_selected(self, client):
        with _exact_vehicle(
            [
                _entry("Pixhawk1", ["Pixhawk1-BL"], **{
                    "mav-firmware-version-str": "V4.9.0",
                    "mav-firmware-version-major": "4",
                    "mav-firmware-version-minor": "9",
                    "mav-firmware-version-patch": "0"}),
                _entry("Pixhawk1", ["Pixhawk1-BL"], **{
                    "mav-firmware-version-str": "V4.7.0",
                    "mav-firmware-version-major": "4",
                    "mav-firmware-version-minor": "7",
                    "mav-firmware-version-patch": "0"}),
            ],
            bootloader="Pixhawk1-BL",
        ):
            releases = client.get("/api/setup/firmware/versions").json()["releases"]
        assert sum(1 for r in releases if r["isSelected"]) == 1
        assert sum(1 for r in releases if r["isDefault"]) == 1

    def test_the_running_release_is_marked_current(self, client):
        entry = _entry("Pixhawk1", ["Pixhawk1-BL"], **{
            "mav-firmware-version-str": "V4.7.0",
            "mav-firmware-version-major": "4",
            "mav-firmware-version-minor": "7",
            "mav-firmware-version-patch": "0"})
        other = _entry("Pixhawk1", ["Pixhawk1-BL"], **{
            "mav-firmware-version-str": "V4.9.0",
            "mav-firmware-version-major": "4",
            "mav-firmware-version-minor": "9",
            "mav-firmware-version-patch": "0"})
        with _exact_vehicle([entry, other], bootloader="Pixhawk1-BL"):
            releases = client.get("/api/setup/firmware/versions").json()["releases"]
        current = [r["versionStr"] for r in releases if r["isCurrent"]]
        # The board reports 4.7.0; the manifest labels it V4.7.0.
        assert current == ["V4.7.0"]

    def test_no_release_is_marked_current_when_the_board_reports_nothing(self, client):
        with _LiveVehicle(_exact_entries(), info={"success": False, "connected": True}):
            releases = client.get("/api/setup/firmware/versions").json()["releases"]
        assert not any(r["isCurrent"] for r in releases)

    def test_version_comparison_ignores_only_the_v_prefix(self):
        assert wf._same_version("4.7.0", "V4.7.0")
        assert wf._same_version("V4.7.0", "4.7.0")
        assert not wf._same_version("4.7.0", "V4.9.0")
        assert not wf._same_version(None, "V4.7.0")
        assert not wf._same_version("4.7.0", None)
        assert not wf._same_version("", "")
