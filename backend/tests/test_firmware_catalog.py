"""Tests for the official ArduPilot firmware catalogue and compatibility resolver.

Covers manifest download, gzip + JSON parsing, schema validation (including
fail-closed behaviour on an unknown format-version), ETag conditional requests
and on-disk caching, stale-cache fallback, corrupted-cache rejection, candidate
extraction, vehicle identity derivation, every resolver outcome, candidate
selection determinism, download integrity, the confirmation state, the
real-hardware installation block, and the TEST/SIMULATION adapter.

The manifest fixtures below are *synthetic* — minimal documents built in the
test to exercise the parser deterministically and offline. No real firmware
catalogue is vendored, and the production code always fetches from the official
server. Fixture URLs use the real official host so the URL allow-list is
exercised realistically.
"""

import gzip
import io
import json
import time
import urllib.request
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _plat_entry(platform, bootloader, **overrides):
    """A manifest entry for a specific platform with its own bootloader string."""
    return _entry(platform=platform, bootloader_str=[bootloader], **overrides)


def _entry(**overrides):
    base = {
        "mav-autopilot": "ARDUPILOTMEGA",
        "vehicletype": "Copter",
        "platform": "Pixhawk1",
        "git-sha": "dbe792162d06cab66c3475fd5556bf7a120f119e",
        "url": "https://firmware.ardupilot.org/Copter/stable/Pixhawk1/arducopter.apj",
        "mav-type": "Copter",
        "mav-firmware-version-type": "OFFICIAL",
        "mav-firmware-version-str": "V4.7.1",
        "latest": 0,
        "format": "apj",
        "mav-firmware-version": "4.7.1",
        "mav-firmware-version-major": "4",
        "mav-firmware-version-minor": "7",
        "mav-firmware-version-patch": "1",
        "board_id": 9,
        "bootloader_str": ["Pixhawk1-BL", "PX4 BL FMU v2.x"],
        "USBID": ["0x1209/0x5741"],
        "brand_name": "Pixhawk1",
        "manufacturer": "3DR",
        "image_size": 1559908,
    }
    base.update(overrides)
    return base


def _manifest(entries, version="1.0.0"):
    return {"format-version": version, "firmware": entries}


def _gzip_bytes(payload) -> bytes:
    if not isinstance(payload, (bytes, bytearray)):
        payload = json.dumps(payload).encode("utf-8")
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb") as fh:
        fh.write(payload)
    return buf.getvalue()


def _http(status=200, body=b"", headers=None):
    """A MagicMock transport returning a fixed response, with call_count."""
    base = {"etag": '"abc123"'}
    base.update(headers or {})

    def _respond(*_a, **_k):
        return SimpleNamespace(status=status, headers=dict(base), body=body)

    return MagicMock(side_effect=_respond)


@pytest.fixture(autouse=True)
def isolated_cache(tmp_path):
    """Point the catalogue cache at a temp dir and clear the in-memory memo."""
    from core import config
    from services import firmware_catalog_service as svc

    original = config.FIRMWARE_MANIFEST_CACHE_DIR
    config.FIRMWARE_MANIFEST_CACHE_DIR = str(tmp_path / "fwcache")
    svc.reset_cache()
    yield tmp_path / "fwcache"
    config.FIRMWARE_MANIFEST_CACHE_DIR = original
    svc.reset_cache()


@pytest.fixture
def clean_state():
    from core.state import vehicle_state
    from services import firmware_install_service as inst

    snapshot = dict(vehicle_state)
    yield
    vehicle_state.clear()
    vehicle_state.update(snapshot)
    # A confirmation is bound to one candidate in one workflow; never let it
    # leak into an unrelated test.
    inst.CONFIRMATION.clear()


@pytest.fixture
def client():
    from app import app

    return TestClient(app)


def _connected_info(**overrides):
    """Realistic ArduPilot AUTOPILOT_VERSION-derived identity (Pixhawk1)."""
    info = {
        "success": True,
        "connected": True,
        "flightSwVersion": 0x040700FF,
        "version": "4.7.0 (Official Release)",
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


# ---------------------------------------------------------------------------
# 1. Manifest download / gzip / JSON / schema validation
# ---------------------------------------------------------------------------


class TestManifestRetrieval:
    @pytest.mark.parametrize("url", [
        "https://firmware.ardupilot.org:4443/manifest.json.gz",
        "https://user@firmware.ardupilot.org/manifest.json.gz",
        "https://firmware.ardupilot.org:invalid/manifest.json.gz",
    ])
    def test_manifest_and_artifact_reject_nonofficial_origins(self, url):
        from services import firmware_catalog_service as svc
        from services import firmware_download_service as dl

        with pytest.raises(svc.ManifestSchemaError):
            svc._validate_manifest_url(url)
        with pytest.raises(dl.DownloadRejected):
            dl._validate_artifact_url(url)

    def test_http_transport_disables_redirects(self):
        from services import firmware_catalog_service as svc

        request = urllib.request.Request(
            "https://firmware.ardupilot.org/manifest.json.gz"
        )
        handler = svc._NoRedirect()
        assert handler.redirect_request(
            request, None, 302, "Found", {"location": "https://other.example/test"},
            "https://other.example/test",
        ) is None

    def test_downloads_and_parses_manifest(self):
        from services import firmware_catalog_service as svc

        body = _gzip_bytes(_manifest([_entry()]))
        with patch.object(svc, "_http_get", _http(200, body)):
            result = svc.get_catalog("Copter")
        assert result.ok is True
        assert result.source == "network"
        assert result.stale is False
        assert result.format_version == "1.0.0"
        assert result.total_entries == 1
        assert len(result.candidates) == 1
        assert result.etag == '"abc123"'

    def test_gzip_body_is_decompressed(self):
        from services import firmware_catalog_service as svc

        assert svc.decompress_manifest(_gzip_bytes(_manifest([])))[0:1] == b"{"

    def test_invalid_gzip_is_rejected(self):
        from services import firmware_catalog_service as svc

        with pytest.raises(svc.ManifestSchemaError):
            svc.decompress_manifest(b"this is not gzip")

    def test_empty_body_is_rejected(self):
        from services import firmware_catalog_service as svc

        with pytest.raises(svc.ManifestSchemaError):
            svc.decompress_manifest(b"")

    def test_malformed_json_is_rejected(self):
        from services import firmware_catalog_service as svc

        with pytest.raises(svc.ManifestSchemaError):
            svc.parse_manifest(b"{not json")

    def test_unknown_format_version_major_fails_closed(self):
        from services import firmware_catalog_service as svc

        with pytest.raises(svc.ManifestSchemaError):
            svc.parse_manifest(json.dumps(_manifest([], version="2.0.0")).encode())

    @pytest.mark.parametrize(
        "document",
        [
            b"[]",
            b"{}",
            b'{"format-version": "1.0.0"}',
            b'{"firmware": []}',
            b'{"format-version": "", "firmware": []}',
            b'{"format-version": "x.y.z", "firmware": []}',
            b'{"format-version": "1.0.0", "firmware": {"a": 1}}',
            b'{"format-version": "1.0.0", "firmware": ["not-an-object"]}',
        ],
    )
    def test_schema_violations_rejected(self, document):
        from services import firmware_catalog_service as svc

        with pytest.raises(svc.ManifestSchemaError):
            svc.parse_manifest(document)

    def test_unknown_fields_do_not_break_parsing(self):
        from services import firmware_catalog_service as svc

        result = svc.parse_manifest(
            json.dumps(_manifest([_entry(some_new_field={"x": 1}, another="y")])).encode()
        )
        assert result[0] == "1.0.0"
        assert len(result[1]) == 1

    def test_malformed_manifest_is_not_cached_and_falls_back(self):
        from services import firmware_catalog_service as svc

        # A good manifest populates the cache first.
        with patch.object(svc, "_http_get", _http(200, _gzip_bytes(_manifest([_entry()])))):
            assert svc.get_catalog("Copter").ok is True

        # A corrupt response afterwards must not poison the cache.
        svc.clear_memo()
        with patch.object(svc, "_http_get", _http(200, b"corrupt-not-gzip")):
            result = svc.get_catalog("Copter")
        assert result.candidates  # served from the revalidated cache
        assert result.stale is True
        assert "invalid" in result.message.lower()

    def test_http_error_status_falls_back_to_cache(self):
        from services import firmware_catalog_service as svc

        with patch.object(svc, "_http_get", _http(200, _gzip_bytes(_manifest([_entry()])))):
            svc.get_catalog("Copter")
        svc.clear_memo()
        with patch.object(svc, "_http_get", _http(500, b"")):
            result = svc.get_catalog("Copter")
        assert result.ok is True
        assert result.source == "cache"
        assert result.stale is True
        assert "500" in result.message

    def test_unavailable_without_remote_or_cache(self):
        from services import firmware_catalog_service as svc

        def boom(*a, **k):
            raise OSError("network down")

        with patch.object(svc, "_http_get", boom):
            result = svc.get_catalog("Copter")
        assert result.ok is False
        assert result.source == "none"
        assert result.candidates == []
        assert "failed" in result.message.lower()

    def test_non_https_manifest_url_is_refused(self):
        from core import config
        from services import firmware_catalog_service as svc

        original = config.FIRMWARE_MANIFEST_URL
        config.FIRMWARE_MANIFEST_URL = "http://firmware.ardupilot.org/manifest.json.gz"
        try:
            result = svc.get_catalog("Copter")
        finally:
            config.FIRMWARE_MANIFEST_URL = original
        assert result.ok is False
        assert "https" in result.message.lower()

    def test_foreign_host_manifest_url_is_refused(self):
        from core import config
        from services import firmware_catalog_service as svc

        original = config.FIRMWARE_MANIFEST_URL
        config.FIRMWARE_MANIFEST_URL = "https://evil.example.com/manifest.json.gz"
        try:
            result = svc.get_catalog("Copter")
        finally:
            config.FIRMWARE_MANIFEST_URL = original
        assert result.ok is False
        assert "firmware.ardupilot.org" in result.message


# ---------------------------------------------------------------------------
# 2. Cache / ETag
# ---------------------------------------------------------------------------


class TestCache:
    def test_conditional_request_sends_etag_and_uses_304(self):
        from services import firmware_catalog_service as svc

        with patch.object(svc, "_http_get", _http(200, _gzip_bytes(_manifest([_entry()])))):
            svc.get_catalog("Copter")
        svc.clear_memo()

        seen = {}

        def spy(url, **kwargs):
            seen.update(kwargs.get("headers") or {})
            return SimpleNamespace(
                status=304, headers={"etag": '"abc123"'}, body=b""
            )

        with patch.object(svc, "_http_get", spy):
            result = svc.get_catalog("Copter")
        assert seen.get("If-None-Match") == '"abc123"'
        assert result.ok is True
        assert result.source == "cache"
        assert result.stale is False
        assert len(result.candidates) == 1

    def test_fresh_cache_avoids_the_network(self):
        from services import firmware_catalog_service as svc

        with patch.object(svc, "_http_get", _http(200, _gzip_bytes(_manifest([_entry()])))) as m:
            svc.get_catalog("Copter")
            svc.get_catalog("Copter")
        assert m.call_count == 1

    def test_corrupted_cache_is_never_used(self, isolated_cache):
        from services import firmware_catalog_service as svc

        with patch.object(svc, "_http_get", _http(200, _gzip_bytes(_manifest([_entry()])))):
            svc.get_catalog("Copter")
        svc.clear_memo()

        cache_dir = isolated_cache
        (cache_dir / "manifest.json.gz").write_bytes(b"tampered")

        def boom(*a, **k):
            raise OSError("network down")

        with patch.object(svc, "_http_get", boom):
            result = svc.get_catalog("Copter")
        assert result.ok is False
        assert result.candidates == []

    def test_cache_only_written_after_validation(self, isolated_cache):
        from services import firmware_catalog_service as svc

        with patch.object(svc, "_http_get", _http(200, b"not-gzip")):
            svc.get_catalog("Copter")
        assert not (isolated_cache / "manifest.json.gz").exists()

    def test_catalog_status_reports_cache_presence(self):
        from services import firmware_catalog_service as svc

        assert svc.catalog_status()["available"] is False
        with patch.object(svc, "_http_get", _http(200, _gzip_bytes(_manifest([_entry()])))):
            svc.get_catalog("Copter")
        status = svc.catalog_status()
        assert status["available"] is True
        assert status["totalEntries"] == 1


# ---------------------------------------------------------------------------
# 3. Candidate extraction / metadata
# ---------------------------------------------------------------------------


class TestCandidateExtraction:
    def test_extracts_verified_fields(self):
        from services import firmware_catalog_service as svc

        candidates = svc.extract_candidates([_entry()])
        assert len(candidates) == 1
        c = candidates[0]
        assert c.platform == "Pixhawk1"
        assert c.vehicle == "Copter"
        assert c.image_format == "apj"
        assert c.version == "4.7.1"
        assert c.release_type == "OFFICIAL"
        assert c.board_id == 9
        assert c.bootloader_str == ("Pixhawk1-BL", "PX4 BL FMU v2.x")
        assert c.usb_id == ("0x1209/0x5741",)
        assert c.image_size == 1559908
        assert c.url.startswith("https://firmware.ardupilot.org/")

    def test_pinned_archives_are_excluded(self):
        from services import firmware_catalog_service as svc

        entries = [_entry(), _entry(**{"mav-firmware-version-type": "STABLE-4.7.1"})]
        assert len(svc.extract_candidates(entries)) == 1

    @pytest.mark.parametrize("channel", ["OFFICIAL", "BETA", "DEV"])
    def test_active_channels_included(self, channel):
        from services import firmware_catalog_service as svc

        entries = [_entry(**{"mav-firmware-version-type": channel})]
        assert len(svc.extract_candidates(entries)) == 1

    def test_non_apj_formats_excluded(self):
        from services import firmware_catalog_service as svc

        assert svc.extract_candidates([_entry(format="hex")]) == []

    def test_vehicle_filter_applied(self):
        from services import firmware_catalog_service as svc

        entries = [_entry(), _entry(**{"mav-type": "Rover", "url": "https://firmware.ardupilot.org/Rover/stable/Pixhawk1/ardurover.apj"})]
        assert len(svc.extract_candidates(entries, vehicle="Copter")) == 1
        assert len(svc.extract_candidates(entries, vehicle="Rover")) == 1

    def test_entries_without_usable_url_are_skipped(self):
        from services import firmware_catalog_service as svc

        assert svc.extract_candidates([_entry(url="")]) == []
        assert svc.extract_candidates([_entry(url="http://firmware.ardupilot.org/x.apj")]) == []
        assert svc.extract_candidates([_entry(url="https://evil.example.com/x.apj")]) == []

    def test_metadata_payload_shape(self):
        from services import firmware_catalog_service as svc

        payload = svc.extract_candidates([_entry()])[0].to_dict()
        for key in (
            "id", "url", "platform", "vehicle", "format", "version",
            "releaseType", "boardId", "bootloaderStr", "usbId", "imageSize",
        ):
            assert key in payload
        assert payload["releaseType"] == "OFFICIAL"
        assert payload["boardId"] == 9

    def test_candidates_sorted_newest_first(self):
        from services import firmware_catalog_service as svc

        entries = [
            _entry(**{"mav-firmware-version": "4.6.0", "mav-firmware-version-major": "4",
                      "mav-firmware-version-minor": "6", "mav-firmware-version-patch": "0"}),
            _entry(**{"mav-firmware-version": "4.7.1", "mav-firmware-version-major": "4",
                      "mav-firmware-version-minor": "7", "mav-firmware-version-patch": "1"}),
        ]
        versions = [c.version for c in svc.extract_candidates(entries)]
        assert versions == ["4.7.1", "4.6.0"]


# ---------------------------------------------------------------------------
# 4. Identity derivation
# ---------------------------------------------------------------------------


class TestIdentity:
    def test_derives_identity_from_existing_firmware_info(self):
        from services import firmware_compat_service as compat

        identity = compat.identity_from_firmware_info(_connected_info())
        assert identity.connected is True
        assert identity.manifest_vehicle == "Copter"
        assert identity.board_type == 0
        assert identity.board_rev == 9
        assert identity.usb_id == "0x1209/0x5741"
        assert identity.bootloader_str is None

    def test_bootloader_identity_absent_outside_bootloader_mode(self):
        from services import firmware_compat_service as compat

        identity = compat.identity_from_firmware_info(_connected_info())
        assert identity.to_dict()["hasBootloaderIdentity"] is False
        assert any("bootloader" in e.lower() for e in identity.evidence)

    def test_real_normal_mode_product_and_config_cannot_select_a_platform(self):
        """Firmware USB product and writable BRD_TYPE are not bootloader evidence."""
        from services import firmware_catalog_service as catalog
        from services import firmware_compat_service as compat

        # Observed on the connected controller: product Pixhawk1, BRD_TYPE=2,
        # VID:PID=1209:5741, and board_version=9<<16. None is a verified
        # bootloader product or an independent physical flash-size measurement.
        info = _connected_info(
            boardVersion=9 << 16, usbProduct="Pixhawk1", brdType=2,
        )
        identity = compat.identity_from_firmware_info(info)
        candidates = catalog.extract_candidates([
            _plat_entry("Pixhawk1", "Pixhawk1-BL"),
            _plat_entry("Pixhawk1-1M", "Pixhawk1-1M-BL"),
        ])

        result = compat.resolve(candidates, identity)
        assert identity.usb_id == "0x1209/0x5741"
        assert identity.board_id is None
        assert identity.bootloader_str is None
        # A live Pixhawk in normal mode: the board is present and answering, but
        # no bootloader identity is obtainable without entering bootloader mode.
        assert result.outcome == compat.IDENTITY_UNAVAILABLE
        assert result.can_confirm is False
        assert result.platform_count == 2
        assert result.selected is None

    def test_non_copter_vehicle_is_not_mapped(self):
        from services import firmware_compat_service as compat

        identity = compat.identity_from_firmware_info(
            _connected_info(vehicleType="FIXED_WING")
        )
        assert identity.manifest_vehicle is None

    def test_disconnected_identity(self):
        from services import firmware_compat_service as compat

        identity = compat.identity_from_firmware_info({"success": False})
        assert identity.connected is False


# ---------------------------------------------------------------------------
# 5. Resolver outcomes
# ---------------------------------------------------------------------------


def _identity(**overrides):
    from services import firmware_compat_service as compat

    base = {"connected": True, "autopilot": "ARDUPILOTMEGA", "vehicle_type": "QUADROTOR",
            "manifest_vehicle": "Copter", "board_type": 0, "board_rev": 9,
            "usb_id": "0x1209/0x5741", "firmware_version": "4.7.0"}
    base.update(overrides)
    return compat.IdentityEvidence(**base)


def _bootloader_identity(usb_product_string="Pixhawk1-BL", **overrides):
    """An identity backed by a genuinely complete bootloader read.

    An exact match is only offered when the four bootloader protocol fields
    were actually read and every official-manifest check agrees, so tests that
    exercise selection have to supply a real identity rather than a bare
    ``bootloader_str`` string.
    """
    from services import bootloader_fixtures as fx
    from services import firmware_compat_service as compat

    fixture = fx.BootloaderFixture(
        name="catalog-test",
        description="complete identity for resolver selection tests",
        bootloader_revision=4,
        board_id=9,
        flash_size=2 * 1024 * 1024,
        usb_product_string=usb_product_string,
    )
    identity = compat.apply_bootloader_identity(
        _identity(**overrides),
        fx.FixtureBootloaderTransport(fixture).read_identity(),
    )
    return identity


class TestResolver:
    def test_identity_unavailable_when_no_bootloader_identity(self):
        """A connected board with no bootloader identity gets its own outcome.

        This is distinct from AMBIGUOUS: there is no conflict to adjudicate, the
        only trustworthy signal is simply unobtainable without entering
        bootloader mode.
        """
        from services import firmware_catalog_service as svc
        from services import firmware_compat_service as compat

        entries = [
            _plat_entry("Pixhawk1", "Pixhawk1-BL"),
            _plat_entry("Pixhawk1-1M", "Pixhawk1-1M-BL"),
            _plat_entry("CubeBlack", "CubeBlack-BL"),
        ]
        result = compat.resolve(svc.extract_candidates(entries), _identity())
        assert result.outcome == compat.IDENTITY_UNAVAILABLE
        assert result.can_confirm is False
        assert result.selected is None
        assert result.platform_count == 3
        assert "bootloader identity" in result.reason.lower()

    def test_board_id_alone_never_selects(self):
        from services import firmware_catalog_service as svc
        from services import firmware_compat_service as compat

        # board_id 9 spans several platforms -> ambiguous.
        entries = [
            _plat_entry("Pixhawk1", "Pixhawk1-BL"),
            _plat_entry("CubeBlack", "CubeBlack-BL"),
        ]
        result = compat.resolve(
            svc.extract_candidates(entries), _identity(board_id=9)
        )
        assert result.outcome == compat.AMBIGUOUS
        assert result.selected is None

    def test_board_id_alone_refused_even_when_unique(self):
        from services import firmware_catalog_service as svc
        from services import firmware_compat_service as compat

        entries = [_plat_entry("OnlyOnePlatform", "OnlyOnePlatform-BL", board_id=77)]
        result = compat.resolve(
            svc.extract_candidates(entries), _identity(board_id=77)
        )
        assert result.outcome == compat.AMBIGUOUS
        assert result.selected is None
        assert "board id alone" in result.reason.lower()

    def test_exact_match_via_bootloader_product_string(self):
        from services import firmware_catalog_service as svc
        from services import firmware_compat_service as compat

        entries = [
            _plat_entry("Pixhawk1", "Pixhawk1-BL"),
            _plat_entry("CubeBlack", "CubeBlack-BL"),
        ]
        result = compat.resolve(
            svc.extract_candidates(entries),
            _bootloader_identity("CubeBlack-BL"),
        )
        assert result.outcome == compat.EXACT_MATCH
        assert result.can_confirm is True
        assert result.selected.platform == "CubeBlack"

    def test_confirmed_compatible_via_bootloader_plus_board_id(self):
        from services import firmware_catalog_service as svc
        from services import firmware_compat_service as compat

        # Both share board_id 9; only the bootloader string plus board_id resolves.
        entries = [
            _plat_entry("CubeBlack", "PX4 BL FMU v2.x", board_id=9),
            _plat_entry("Pixhawk1", "PX4 BL FMU v2.x", board_id=9),
        ]
        result = compat.resolve(
            svc.extract_candidates(entries),
            _bootloader_identity("PX4 BL FMU v2.x"),
        )
        assert result.outcome == compat.AMBIGUOUS  # board_id 9 still spans both

        # A bootloader string unique to one platform resolves outright.
        entries = [
            _plat_entry("CubeBlack", "CubeBlack-BL", board_id=9),
            _plat_entry("Pixhawk1", "PX4 BL FMU v2.x", board_id=9),
        ]
        result = compat.resolve(
            svc.extract_candidates(entries), _bootloader_identity("CubeBlack-BL")
        )
        assert result.outcome == compat.EXACT_MATCH
        assert result.selected.platform == "CubeBlack"

    def test_no_match_when_bootloader_string_unknown_to_catalogue(self):
        from services import firmware_catalog_service as svc
        from services import firmware_compat_service as compat

        result = compat.resolve(
            svc.extract_candidates([_entry()]),
            _bootloader_identity("TotallyUnknownBoard-BL"),
        )
        assert result.outcome == compat.NO_MATCH
        assert result.selected is None

    def test_no_match_when_catalogue_empty(self):
        from services import firmware_compat_service as compat

        result = compat.resolve([], _identity())
        assert result.outcome == compat.NO_MATCH

    def test_unsupported_non_copter(self):
        from services import firmware_catalog_service as svc
        from services import firmware_compat_service as compat

        result = compat.resolve(
            svc.extract_candidates([_entry()]),
            _identity(manifest_vehicle=None, vehicle_type="FIXED_WING"),
        )
        assert result.outcome == compat.UNSUPPORTED

    def test_unsupported_sitl(self):
        from services import firmware_catalog_service as svc
        from services import firmware_compat_service as compat

        result = compat.resolve(
            svc.extract_candidates([_entry()]), _identity(is_sitl=True)
        )
        assert result.outcome == compat.UNSUPPORTED
        assert "simulation" in result.reason.lower()

    def test_no_device_when_disconnected(self):
        """Nothing connected is reported as NO_DEVICE, not UNKNOWN.

        The UI needs to tell "nothing is plugged in" apart from "something is
        plugged in but we could not identify it".
        """
        from services import firmware_compat_service as compat

        result = compat.resolve([], _identity(connected=False))
        assert result.outcome == compat.NO_DEVICE
        assert result.can_confirm is False
        assert result.selected is None

    def test_unresolved_identity_is_reported_not_hidden(self):
        """The full platform list is always surfaced, never silently collapsed."""
        from services import firmware_catalog_service as svc
        from services import firmware_compat_service as compat

        entries = [
            _plat_entry("Pixhawk1", "Pixhawk1-BL"),
            _plat_entry("Pixhawk1-1M", "Pixhawk1-1M-BL"),
            _plat_entry("CubeBlack", "CubeBlack-BL"),
        ]
        result = compat.resolve(svc.extract_candidates(entries), _identity())
        payload = result.to_dict()
        assert payload["outcome"] == compat.IDENTITY_UNAVAILABLE
        assert payload["canConfirm"] is False
        assert payload["platformCount"] == 3
        assert "Pixhawk1-1M" in payload["platforms"]

    def test_true_ambiguity_when_bootloader_string_spans_platforms(self):
        """AMBIGUOUS is reserved for a genuine multi-platform conflict.

        A bootloader string that matches several platforms is a real conflict;
        no identity at all is not.
        """
        from services import firmware_catalog_service as svc
        from services import firmware_compat_service as compat

        entries = [
            _plat_entry("CubeBlack", "PX4 BL FMU v2.x"),
            _plat_entry("Pixhawk1", "PX4 BL FMU v2.x"),
        ]
        result = compat.resolve(
            svc.extract_candidates(entries),
            _bootloader_identity("PX4 BL FMU v2.x"),
        )
        assert result.outcome == compat.AMBIGUOUS
        assert result.can_confirm is False
        assert result.platform_count == 2

    def test_selection_prefers_official_then_newest(self):
        from services import firmware_compat_service as compat

        entries = [
            _entry(**{"mav-firmware-version-type": "DEV", "mav-firmware-version": "4.8.0",
                      "mav-firmware-version-major": "4", "mav-firmware-version-minor": "8",
                      "mav-firmware-version-patch": "0"}),
            _entry(**{"mav-firmware-version-type": "OFFICIAL", "mav-firmware-version": "4.7.1"}),
        ]
        from services import firmware_catalog_service as svc

        result = compat.resolve(
            svc.extract_candidates(entries), _bootloader_identity()
        )
        assert result.outcome == compat.EXACT_MATCH
        assert result.selected.release_type == "OFFICIAL"
        assert result.selected.version == "4.7.1"

    def test_selection_is_deterministic(self):
        from services import firmware_catalog_service as svc
        from services import firmware_compat_service as compat

        entries = [
            _entry(**{"mav-firmware-version-type": "BETA", "mav-firmware-version": "4.7.1",
                      "mav-firmware-version-major": "4", "mav-firmware-version-minor": "7",
                      "mav-firmware-version-patch": "1"}),
            _entry(**{"mav-firmware-version-type": "OFFICIAL", "mav-firmware-version": "4.7.1",
                      "mav-firmware-version-major": "4", "mav-firmware-version-minor": "7",
                      "mav-firmware-version-patch": "1"}),
        ]
        pool = svc.extract_candidates(entries)
        first = compat.resolve(pool, _bootloader_identity()).selected
        second = compat.resolve(pool, _bootloader_identity()).selected
        assert first.identity() == second.identity()
        assert first.release_type == "OFFICIAL"


# ---------------------------------------------------------------------------
# 6. Download integrity
# ---------------------------------------------------------------------------


class TestDownload:
    def _candidate(self, **overrides):
        from services import firmware_catalog_service as svc

        return svc.extract_candidates([_entry(**overrides)])[0]

    def test_download_verifies_completeness_and_never_executes(self):
        from services import firmware_download_service as dl

        payload = b"\x01\x02\x03firmware-bytes"
        candidate = self._candidate()
        response = lambda *a, **k: SimpleNamespace(
            status=200,
            headers={"content-length": str(len(payload)),
                     "content-type": "application/octet-stream"},
            body=payload,
        )
        with patch.object(dl, "_http_get", response):
            result = dl.prepare_download(candidate)
        assert result.ok is True
        assert result.bytes_written == len(payload)
        assert result.executed is False
        assert result.installed is False
        assert len(result.sha256) == 64

    def test_partial_download_is_rejected(self):
        from services import firmware_download_service as dl

        candidate = self._candidate()
        response = lambda *a, **k: SimpleNamespace(
            status=200, headers={"content-length": "9999"}, body=b"short"
        )
        with patch.object(dl, "_http_get", response):
            result = dl.prepare_download(candidate)
        assert result.ok is False
        assert "incomplete" in result.message.lower()
        assert result.executed is False

    def test_missing_content_length_is_only_transfer_complete(self):
        """Nothing published by the source can be checked, so claim nothing.

        The transfer is still recorded as completed -- bytes arrived and the
        stream ended -- but the result must not be usable for installation and
        must not be described as a checksum or a size verification.
        """
        from services import firmware_download_service as dl

        candidate = self._candidate()
        response = lambda *a, **k: SimpleNamespace(
            status=200, headers={"content-type": "application/octet-stream"}, body=b"data"
        )
        with patch.object(dl, "_http_get", response):
            result = dl.prepare_download(candidate)
        assert result.ok is True
        assert result.integrity == dl.INTEGRITY_TRANSFER_COMPLETE_ONLY
        assert result.integrity not in dl.INTEGRITY_VERIFIED_STATES
        assert result.checksum_verified is False
        assert result.integrity_evidence

    def test_http_error_is_rejected(self):
        from services import firmware_download_service as dl

        candidate = self._candidate()
        response = lambda *a, **k: SimpleNamespace(
            status=404, headers={}, body=b""
        )
        with patch.object(dl, "_http_get", response):
            result = dl.prepare_download(candidate)
        assert result.ok is False
        assert "404" in result.message

    def test_checksum_is_reported_but_not_claimed_verified(self):
        """The official manifest publishes no artifact checksum."""
        from services import firmware_download_service as dl

        payload = b"bytes"
        candidate = self._candidate()
        response = lambda *a, **k: SimpleNamespace(
            status=200, headers={"content-length": str(len(payload))}, body=payload
        )
        with patch.object(dl, "_http_get", response):
            result = dl.prepare_download(candidate)
        assert result.checksum_verified is False
        assert "no artifact checksum" in result.checksum_note

    def test_non_official_url_is_rejected(self):
        from services import firmware_download_service as dl
        from services import firmware_catalog_service as svc

        candidate = svc.FirmwareCandidate(
            url="https://evil.example.com/arducopter.apj", platform="Pixhawk1",
            vehicle="Copter", vehicle_type="Copter", image_format="apj",
            version="4.7.1", version_str="V4.7.1", version_major=4, version_minor=7,
            version_patch=1, release_type="OFFICIAL", board_id=9,
            bootloader_str=(), usb_id=(), brand_name="", manufacturer="",
            image_size=1, git_sha="", autopilot="", latest=False,
        )
        result = dl.prepare_download(candidate)
        assert result.ok is False
        assert "firmware.ardupilot.org" in result.message


# ---------------------------------------------------------------------------
# 7. Hardware safety gate + test adapter
# ---------------------------------------------------------------------------


class TestSafetyGate:
    def test_install_firmware_always_raises(self):
        from services import firmware_install_service as inst

        with pytest.raises(inst.InstallationBlockedError):
            inst.install_firmware()

    def test_assert_installation_allowed_always_raises(self):
        from services import firmware_install_service as inst

        with pytest.raises(inst.InstallationBlockedError):
            inst.assert_installation_allowed("firmware-install")

    def test_install_cannot_be_enabled_by_configuration(self):
        from core import config
        from services import firmware_install_service as inst

        assert config.FIRMWARE_INSTALL_ENABLED is False
        assert inst.capability()["hardcodedEnable"] is False

    def test_capability_reports_blocked_state(self):
        from services import firmware_install_service as inst

        cap = inst.capability()
        assert cap["firmwareInstallation"] == "not-available"
        assert cap["installationState"] == inst.BLOCKED
        assert cap["blockedOnHardware"] is True
        assert cap["realInstallationAllowed"] is False

    def test_blocked_operations_include_destructive_actions(self):
        from services import firmware_install_service as inst

        blocked = set(inst.capability()["blockedOperations"])
        for operation in (
            "enter-bootloader", "bootloader-erase", "bootloader-program",
            "firmware-install", "reboot-for-flashing",
        ):
            assert operation in blocked

    def test_install_route_refuses_real_hardware_truthfully(self, client):
        """The install route exists but must never flash real hardware.

        An earlier design had no route at all (404). It now exists so the refusal
        is a real, inspectable answer instead of a missing endpoint, and so the
        simulation path is reachable with no board attached.
        """
        from services import firmware_install_service as inst

        with (
            patch(
                "services.firmware_install_service.environment", return_value="HARDWARE"
            ),
            patch(
                "services.setup_service.request_firmware_info",
                return_value=_connected_info(),
            ),
        ):
            response = client.post(
                "/api/setup/firmware/install",
                json={"allowSimulation": False, "asynchronous": False},
            )
        body = response.json()
        assert body["realInstallationAllowed"] is False
        assert body["success"] is not True
        assert body["state"] in ("BLOCKED", "NO_DEVICE", "FAILED")
        # A confirmed client flag alone must never authorise anything.
        assert body.get("history", []).count("DOWNLOADING") == 0

    def test_workflow_states_cover_required_set(self):
        from services import firmware_install_service as inst

        required = {
            "IDLE", "DETECTING", "IDENTIFYING", "RESOLVING", "READY",
            "CONFIRMATION_REQUIRED", "DOWNLOADING", "DOWNLOAD_VERIFIED",
            "PREPARING", "INSTALLING", "VERIFYING", "COMPLETED", "FAILED",
            "CANCELLED", "DISCONNECTED", "BLOCKED",
        }
        assert required <= set(inst.WORKFLOW_STATES)

    def test_real_installer_is_permanently_gated(self):
        from services import firmware_install_service as inst

        # Not an env var: a module constant, so nothing can flip it.
        assert inst.REAL_INSTALLATION_ALLOWED is False
        assert inst.RealFirmwareInstaller().installation_allowed is False
        with pytest.raises(inst.InstallationBlockedError):
            inst.RealFirmwareInstaller().install()
        with pytest.raises(inst.InstallationBlockedError):
            inst.RealFirmwareInstaller().prepare("/tmp/x.apj", "4.7.1")

    def test_real_installer_gate_cannot_be_bypassed_by_config(self):
        from core import config
        from services import firmware_install_service as inst

        # Even if a config flag were flipped, the gate still refuses.
        original = config.FIRMWARE_INSTALL_ENABLED
        try:
            config.FIRMWARE_INSTALL_ENABLED = True
            with pytest.raises(inst.InstallationBlockedError):
                inst.assert_installation_allowed("firmware-install")
            with pytest.raises(inst.InstallationBlockedError):
                inst.install_firmware()
        finally:
            config.FIRMWARE_INSTALL_ENABLED = original


class TestSimulationInstaller:
    """The TEST/SIMULATION installer is a real implementation of the interface."""

    def _installer(self, **kwargs):
        from services import firmware_install_service as inst

        kwargs.setdefault("artifact_path", "/tmp/simulated.apj")
        kwargs.setdefault("expected_version", "4.7.1")
        kwargs.setdefault("observed_version", "4.7.1")
        return inst.TestFirmwareInstaller(**kwargs)

    def test_installer_is_labelled_simulation(self):
        from services import firmware_install_service as inst

        installer = self._installer()
        assert installer.mode == "TEST / SIMULATION"
        assert installer.is_simulation is True
        assert installer.installation_allowed is True

    def test_installer_implements_the_interface(self):
        from services import firmware_install_service as inst

        installer = self._installer()
        assert isinstance(installer, inst.FirmwareInstaller)
        assert isinstance(inst.RealFirmwareInstaller(), inst.FirmwareInstaller)

    def test_installer_never_touches_hardware(self):
        from services import firmware_install_service as inst

        result = self._installer().install()
        assert result.hardware_touched is False
        assert result.is_simulation is True
        assert result.mode == inst.TEST_LABEL

    def test_installer_progress_is_deterministic(self):
        """Two identical runs produce identical progress, ending in verification.

        The final progress entry comes from ``verify()``, which is a separate
        step: the installer deliberately does not decide on its own that the
        installation succeeded.
        """
        installer_a, installer_b = self._installer(), self._installer()
        installer_a.prepare()
        installer_b.prepare()
        installer_a.install()
        installer_a.verify()
        installer_b.install()
        installer_b.verify()
        run_a = [(p.state, p.percent) for p in installer_a.progress()]
        run_b = [(p.state, p.percent) for p in installer_b.progress()]
        assert run_a == run_b
        assert run_a[-1][0] == "COMPLETED"

    def test_installer_verifies_only_when_observed_version_matches(self):
        ok = self._installer()
        ok.prepare()
        ok.install()
        assert ok.verify().verified is True

        wrong = self._installer(observed_version="9.9.9")
        wrong.prepare()
        result = wrong.install()
        verification = wrong.verify()
        assert verification.verified is False
        assert verification.observed_version == "9.9.9"
        assert verification.expected_version == "4.7.1"
        # install() itself reports only the transfer, never the verdict.
        assert result.version_verified is False

    def test_installer_fails_without_a_vehicle_reporting_a_version(self):
        installer = self._installer(observed_version=None)
        installer.prepare()
        installer.install()
        verification = installer.verify()
        assert verification.verified is False
        assert verification.observed_version is None

    def test_installer_requires_prepare_first(self):
        result = self._installer().install()
        assert result.ok is False
        assert result.error == "prepare-not-called"

    def test_installer_can_fail_at_a_chosen_phase(self):
        installer = self._installer(fail_at="INSTALLING")
        installer.prepare()
        result = installer.install()
        assert result.ok is False
        assert result.error == "simulated-failure"

    def test_installer_can_be_cancelled(self):
        installer = self._installer()
        installer.prepare()
        installer.cancel()
        result = installer.install()
        assert result.state == "CANCELLED"

    def test_simulation_never_claims_a_real_flash(self):
        from services import firmware_install_service as inst

        payload = inst.capability()["testAdapter"]
        assert payload["isSimulation"] is True
        assert payload["hardwareTouched"] is False
        assert inst.capability()["realInstallationAllowed"] is False

    def test_installer_holds_no_device_handle(self):
        import inspect

        from services import firmware_install_service as inst

        source = inspect.getsource(inst.TestFirmwareInstaller)
        for forbidden in ("serial", "pyserial", "/dev/tty", "enqueue", "mav.", "Bootloader"):
            assert forbidden not in source


# ---------------------------------------------------------------------------
# 8. API surface
# ---------------------------------------------------------------------------


def _patched_setup(service, info, result):
    return patch.object(service, "request_firmware_info", return_value=info), patch.object(
        service, "firmware_catalog", return_value=result
    )


class TestApi:
    def test_capability_endpoint_keeps_installation_unavailable(self, client):
        response = client.get("/api/setup/firmware/capability")
        body = response.json()
        assert body["firmwareIdentification"] == "available"
        assert body["firmwareInstallation"] == "not-available"
        assert body["releaseCatalog"] in ("available", "unavailable")
        assert body["installation"]["installationState"] == "BLOCKED"
        assert body["installation"]["realInstallationAllowed"] is False

    def test_catalog_endpoint_reports_unresolved_identity_truthfully(self, client, clean_state):
        from services import firmware_catalog_service as svc
        from services import setup_service

        body_bytes = _gzip_bytes(_manifest([
            _plat_entry("Pixhawk1", "Pixhawk1-BL"),
            _plat_entry("CubeBlack", "CubeBlack-BL"),
        ]))
        with (
            patch.object(svc, "_http_get", _http(200, body_bytes)),
            patch("services.setup_service.request_firmware_info", return_value=_connected_info()),
            patch("services.firmware_install_service.environment", return_value="HARDWARE"),
        ):
            response = client.get("/api/setup/firmware/catalog")
        body = response.json()
        assert body["success"] is True
        assert body["identity"]["hasBootloaderIdentity"] is False
        assert body["resolution"]["outcome"] == "IDENTITY_UNAVAILABLE"
        assert body["resolution"]["canConfirm"] is False
        assert body["resolution"]["selected"] is None
        assert body["current"]["version"] == "4.7.0 (Official Release)"

    def test_catalog_endpoint_reports_unavailable_when_offline(self, client, clean_state):
        from services import firmware_catalog_service as svc
        from services import setup_service

        def boom(*a, **k):
            raise OSError("offline")

        with (
            patch.object(svc, "_http_get", boom),
            patch("services.setup_service.request_firmware_info", return_value=_connected_info()),
        ):
            response = client.get("/api/setup/firmware/catalog")
        body = response.json()
        assert body["resolution"]["outcome"] == "UNAVAILABLE"
        assert body["catalog"]["available"] is False
        assert body["resolution"]["canConfirm"] is False

    def test_catalog_endpoint_requires_vehicle_identity(self, client, clean_state):
        from services import setup_service

        with patch(
            "services.setup_service.request_firmware_info",
            return_value={"success": False, "connected": False, "message": "Vehicle is not connected."},
        ):
            body = client.get("/api/setup/firmware/catalog").json()
        assert body["success"] is False
        assert body["resolution"] is None
        assert body["candidates"] == []

    def test_confirmation_blocked_when_identity_unavailable(self, client, clean_state):
        from services import firmware_catalog_service as svc
        from services import setup_service

        body_bytes = _gzip_bytes(_manifest([
            _plat_entry("Pixhawk1", "Pixhawk1-BL"),
            _plat_entry("CubeBlack", "CubeBlack-BL"),
        ]))
        with (
            patch.object(svc, "_http_get", _http(200, body_bytes)),
            patch("services.setup_service.request_firmware_info", return_value=_connected_info()),
            patch("services.firmware_install_service.environment", return_value="HARDWARE"),
        ):
            body = client.post("/api/setup/firmware/confirmation", json={"confirmed": False}).json()
        assert body["success"] is False
        assert body["confirmationRequired"] is False
        assert body["confirmed"] is False
        assert body["outcome"] == "IDENTITY_UNAVAILABLE"
        assert body["installation"]["firmwareInstallation"] == "not-available"

    def test_download_refused_when_identity_unavailable(self, client, clean_state):
        """An unconfirmed download never reaches compatibility resolution."""
        from services import firmware_catalog_service as svc

        body_bytes = _gzip_bytes(_manifest([
            _plat_entry("Pixhawk1", "Pixhawk1-BL"),
            _plat_entry("CubeBlack", "CubeBlack-BL"),
        ]))
        with (
            patch.object(svc, "_http_get", _http(200, body_bytes)),
            patch("services.setup_service.request_firmware_info", return_value=_connected_info()),
            patch("services.firmware_install_service.environment", return_value="HARDWARE"),
        ):
            body = client.post("/api/setup/firmware/download", json={}).json()
        assert body["success"] is False
        assert body["state"] == "CONFIRMATION_REQUIRED"
        assert body["confirmed"] is False

        # Confirming an unidentifiable target is refused with the real outcome.
        with (
            patch.object(svc, "_http_get", _http(200, body_bytes)),
            patch("services.setup_service.request_firmware_info", return_value=_connected_info()),
            patch("services.firmware_install_service.environment", return_value="HARDWARE"),
        ):
            confirmed = client.post(
                "/api/setup/firmware/confirmation",
                json={"confirmed": True},
            ).json()
        assert confirmed["success"] is False
        assert confirmed["outcome"] == "IDENTITY_UNAVAILABLE"
        assert confirmed["confirmed"] is False

    def _confident_resolver(self, outcome="EXACT_MATCH"):
        """Patch the resolver so a confidently selected target exists.

        The live identity can never reach a selecting outcome on its own
        (no bootloader product string outside bootloader mode), so the
        candidate-selection branch of the download route is driven explicitly.
        """
        from services import firmware_compat_service as compat
        from services import firmware_catalog_service as svc

        selected = svc.extract_candidates([_entry()])[0]
        resolution = compat.Resolution(
            outcome=outcome,
            reason="synthetic",
            selected=selected,
            candidate_count=1,
            platform_count=1,
            platforms=["Pixhawk1"],
        )
        return patch.object(compat, "resolve", return_value=resolution)

    def test_download_refused_for_wrong_candidate_id(self, client, clean_state):
        from services import firmware_catalog_service as svc
        from services import setup_service

        body_bytes = _gzip_bytes(_manifest([_entry()]))
        selected = svc.extract_candidates([_entry()])[0]
        with (
            patch.object(svc, "_http_get", _http(200, body_bytes)),
            patch("services.setup_service.request_firmware_info", return_value=_connected_info()),
            patch("services.firmware_install_service.environment", return_value="HARDWARE"),
            self._confident_resolver(),
            patch("services.firmware_download_service.prepare_download") as dl,
        ):
            # Confirming an id that is not in the catalogue must be refused.
            confirmed = client.post(
                "/api/setup/firmware/confirmation",
                json={"confirmed": True, "candidateId": "not/the/right/one"},
            ).json()
            assert confirmed["success"] is False
            assert "not present in the official catalogue" in confirmed["message"]

            # The recorded confirmation is bound to the real candidate, so a
            # download for a different id is refused.
            client.post(
                "/api/setup/firmware/confirmation",
                json={"confirmed": True, "candidateId": selected.identity()},
            )
            body = client.post(
                "/api/setup/firmware/download", json={"candidateId": "not/the/right/one"}
            ).json()
        assert body["success"] is False
        assert body["confirmed"] is False
        assert body["state"] == "CONFIRMATION_REQUIRED"
        dl.assert_not_called()

    def test_download_executes_nothing_without_confirmation(self, client, clean_state):
        """No confirmation means no artifact fetch, even with a resolvable target."""
        from services import firmware_catalog_service as svc

        body_bytes = _gzip_bytes(_manifest([_entry()]))
        with (
            patch.object(svc, "_http_get", _http(200, body_bytes)),
            patch("services.setup_service.request_firmware_info", return_value=_connected_info()),
            patch("services.firmware_install_service.environment", return_value="HARDWARE"),
            self._confident_resolver(),
            patch("services.firmware_download_service._http_get") as dl_http,
        ):
            dl_http.return_value = SimpleNamespace(
                status=200, headers={"content-length": "4"}, body=b"abcd"
            )
            body = client.post("/api/setup/firmware/download", json={}).json()
        assert body["success"] is False
        assert body["state"] == "CONFIRMATION_REQUIRED"
        # Nothing ran and nothing was transferred.
        assert body.get("executed") is not True
        assert body.get("installed") is not True
        assert body.get("checksumVerified") is not True
        assert "path" not in body
        dl_http.assert_not_called()

    def test_download_uses_resolved_candidate_url(self, client, clean_state):
        from services import firmware_catalog_service as svc

        body_bytes = _gzip_bytes(_manifest([_entry()]))
        selected = svc.extract_candidates([_entry()])[0]
        with (
            patch.object(svc, "_http_get", _http(200, body_bytes)),
            patch("services.setup_service.request_firmware_info", return_value=_connected_info()),
            patch("services.firmware_install_service.environment", return_value="HARDWARE"),
            self._confident_resolver(),
            patch("services.firmware_download_service._http_get") as dl_http,
        ):
            dl_http.return_value = SimpleNamespace(
                status=200, headers={"content-length": "4"}, body=b"abcd"
            )
            client.post(
                "/api/setup/firmware/confirmation",
                json={"confirmed": True, "candidateId": selected.identity()},
            )
            body = client.post("/api/setup/firmware/download", json={}).json()
        assert body["success"] is True
        assert body["url"].startswith("https://firmware.ardupilot.org/")
        assert dl_http.call_args[0][0].startswith("https://firmware.ardupilot.org/")
        assert body["executed"] is False
        assert body["installed"] is False

    def test_refresh_flag_revalidates(self, client, clean_state):
        from services import firmware_catalog_service as svc
        from services import setup_service

        body_bytes = _gzip_bytes(_manifest([_entry()]))
        with (
            patch.object(svc, "_http_get", _http(200, body_bytes)) as m,
            patch("services.setup_service.request_firmware_info", return_value=_connected_info()),
            patch("services.firmware_install_service.environment", return_value="HARDWARE"),
        ):
            client.get("/api/setup/firmware/catalog?refresh=true")
        assert m.call_count == 1
