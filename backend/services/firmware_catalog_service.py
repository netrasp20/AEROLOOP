"""Official ArduPilot firmware catalogue (read-only, verified source only).

The catalogue is fetched live from the official ArduPilot server
(``firmware.ardupilot.org``) and is never vendored, hardcoded or invented:

    https://firmware.ardupilot.org/manifest.json.gz
        -> HTTP 200, application/x-gzip
        -> gunzip -> JSON {"format-version": "1.0.0", "firmware": [...]}

Observed shape (97,377 entries at time of writing). Only the three *active*
release channels are considered, matching QGroundControl's behaviour:

    mav-firmware-version-type in ("OFFICIAL", "BETA", "DEV")

The pinned ``STABLE-X.Y.Z`` archive directories (78,523 entries) are excluded
because they are not part of the active channels.

Integrity rules enforced here:

* HTTPS only, and only for the official ArduPilot firmware host.
* Bounded response size, bounded decompressed size, bounded request timeout.
* Top-level schema validation, failing closed on an unexpected
  ``format-version`` major.
* Unknown per-entry fields are ignored rather than breaking parsing.
* The on-disk cache is only written *after* a successful validation, and every
  read re-verifies the stored SHA-256 — corrupted cache is discarded, never used.
* When the network fails and a validated cache exists, the cache is used and
  explicitly reported as ``stale``. With neither, the catalogue is unavailable.

This service never downloads, executes, uploads or installs a firmware image;
artifact preparation lives in ``firmware_download_service``.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, NamedTuple, Optional, Tuple

from core import config

# The only host that may ever serve a catalogue or a firmware artifact.
OFFICIAL_FIRMWARE_HOST = "firmware.ardupilot.org"

# Observed compressed size is ~1.8 MB; the ceiling leaves generous headroom
# while bounding a hostile or broken response.
MAX_COMPRESSED_BYTES = 16 * 1024 * 1024
MAX_DECOMPRESSED_BYTES = 512 * 1024 * 1024

# Only this manifest major version is understood. A newer major is refused
# rather than parsed on a guess.
SUPPORTED_FORMAT_MAJOR = 1

# Active release channels (QGC parity: OFFICIAL / BETA / DEV only).
ACTIVE_RELEASE_TYPES: Tuple[str, ...] = ("OFFICIAL", "BETA", "DEV")

# Image formats ArduPilot ships for bootloader flashing. `.apj` is the
# ChibiOS/STM32 image (embedded binary + JSON descriptor).
INSTALLABLE_FORMATS: Tuple[str, ...] = ("apj",)


class ManifestSchemaError(ValueError):
    """The downloaded manifest did not match the expected schema."""


class _HttpResponse(NamedTuple):
    status: int
    headers: Dict[str, str]
    body: bytes


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Never follow a firmware-server redirect to an unvalidated destination."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


# ---------------------------------------------------------------------------
# HTTP transport (single seam so tests never touch the network)
# ---------------------------------------------------------------------------

def _http_get(
    url: str,
    *,
    headers: Optional[Dict[str, str]] = None,
    timeout: float = config.FIRMWARE_MANIFEST_TIMEOUT_S,
    max_bytes: int = MAX_COMPRESSED_BYTES,
) -> _HttpResponse:
    """GET a URL, returning status/headers/body without raising on HTTP errors.

    ``urllib`` raises :class:`HTTPError` for every non-2xx status, which would
    hide a legitimate ``304 Not Modified`` revalidation, so the error path is
    converted into a normal return value.
    """
    request = urllib.request.Request(url, headers=headers or {}, method="GET")
    try:
        with urllib.request.build_opener(_NoRedirect()).open(request, timeout=timeout) as response:
            body = response.read(max_bytes + 1)
            return _HttpResponse(
                getattr(response, "status", 200) or 200,
                {k.lower(): v for k, v in response.headers.items()},
                body,
            )
    except urllib.error.HTTPError as exc:
        try:
            body = exc.read(max_bytes + 1)
        except Exception:  # noqa: BLE001 - error bodies are best effort
            body = b""
        return _HttpResponse(
            exc.code, {k.lower(): v for k, v in (exc.headers or {}).items()}, body
        )


def _validate_manifest_url(url: str) -> str:
    """Return the URL if it is an acceptable official manifest URL, else raise."""
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https":
        raise ManifestSchemaError("Firmware manifest must be fetched over HTTPS.")
    if (parsed.hostname or "") != OFFICIAL_FIRMWARE_HOST:
        raise ManifestSchemaError(
            f"Firmware manifest host must be {OFFICIAL_FIRMWARE_HOST}."
        )
    try:
        if parsed.username is not None or parsed.password is not None or parsed.port not in (None, 443):
            raise ManifestSchemaError("Firmware manifest URL must use the official HTTPS origin.")
    except ValueError as exc:
        raise ManifestSchemaError("Firmware manifest URL has an invalid port.") from exc
    return url


# ---------------------------------------------------------------------------
# Manifest parsing / schema validation
# ---------------------------------------------------------------------------

def decompress_manifest(compressed: bytes) -> bytes:
    """Gunzip manifest bytes, bounding the decompressed size.

    The official server returns a real gzip *file* (``application/x-gzip``) and
    not ``Content-Encoding: gzip``, so the body must be decompressed here.
    """
    if not compressed:
        raise ManifestSchemaError("Firmware manifest response was empty.")
    try:
        with gzip.GzipFile(fileobj=_BytesReader(compressed)) as stream:
            data = stream.read(MAX_DECOMPRESSED_BYTES + 1)
    except (OSError, EOFError) as exc:
        raise ManifestSchemaError(f"Firmware manifest gzip stream is invalid: {exc}") from exc
    if not data:
        raise ManifestSchemaError("Firmware manifest decompressed to an empty document.")
    if len(data) > MAX_DECOMPRESSED_BYTES:
        raise ManifestSchemaError("Firmware manifest exceeds the maximum decompressed size.")
    return data


class _BytesReader:
    """Minimal file-like wrapper so gzip can read an in-memory buffer."""

    def __init__(self, data: bytes) -> None:
        self._data = data
        self._pos = 0

    def read(self, size: int = -1) -> bytes:
        if size is None or size < 0:
            size = len(self._data) - self._pos
        chunk = self._data[self._pos : self._pos + size]
        self._pos += len(chunk)
        return chunk

    def seek(self, offset: int, whence: int = 0) -> int:
        if whence == 0:
            self._pos = offset
        elif whence == 1:
            self._pos += offset
        else:
            self._pos = len(self._data) + offset
        return self._pos

    def tell(self) -> int:
        return self._pos


def parse_manifest(document: bytes) -> Tuple[str, List[Dict[str, Any]]]:
    """Parse and validate the decompressed manifest document.

    Returns ``(format_version, entries)``. Fails closed on an unknown
    ``format-version`` major so a schema change can never be parsed on a guess.
    """
    try:
        parsed = json.loads(document.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ManifestSchemaError(f"Firmware manifest is not valid JSON: {exc}") from exc

    if not isinstance(parsed, dict):
        raise ManifestSchemaError("Firmware manifest root must be a JSON object.")

    version = parsed.get("format-version")
    if not isinstance(version, str) or not version.strip():
        raise ManifestSchemaError("Firmware manifest is missing 'format-version'.")

    try:
        major = int(version.split(".", 1)[0])
    except ValueError as exc:
        raise ManifestSchemaError(
            f"Firmware manifest format-version {version!r} is not numeric."
        ) from exc
    if major != SUPPORTED_FORMAT_MAJOR:
        raise ManifestSchemaError(
            f"Firmware manifest format-version {version!r} is unsupported "
            f"(expected major {SUPPORTED_FORMAT_MAJOR}); refusing to parse."
        )

    entries = parsed.get("firmware")
    if not isinstance(entries, list):
        raise ManifestSchemaError("Firmware manifest 'firmware' must be a list.")
    for entry in entries:
        if not isinstance(entry, dict):
            raise ManifestSchemaError("Firmware manifest entries must be JSON objects.")

    return version, entries


# ---------------------------------------------------------------------------
# Typed candidates
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class FirmwareCandidate:
    """One real, installable-shape ArduPilot firmware image from the manifest."""

    url: str
    platform: str
    vehicle: str
    vehicle_type: str
    image_format: str
    version: str
    version_str: str
    version_major: Optional[int]
    version_minor: Optional[int]
    version_patch: Optional[int]
    release_type: str
    board_id: Optional[int]
    bootloader_str: Tuple[str, ...]
    usb_id: Tuple[str, ...]
    brand_name: str
    manufacturer: str
    image_size: Optional[int]
    git_sha: str
    autopilot: str
    latest: bool
    #: Digest of the artifact as published by the official manifest, when it
    #: publishes one. Empty when the manifest is silent. ``image_size`` is
    #: deliberately NOT used as the expected artifact length: it is the flash
    #: image size, not the size of the .apj container being downloaded.
    artifact_sha256: str = ""

    def identity(self) -> str:
        """Stable identifier used to re-select this exact candidate later."""
        return f"{self.vehicle}/{self.platform}/{self.image_format}/{self.version}/{self.release_type}"

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.identity(),
            "url": self.url,
            "platform": self.platform,
            "vehicle": self.vehicle,
            "vehicleType": self.vehicle_type,
            "format": self.image_format,
            "version": self.version,
            "versionStr": self.version_str,
            "versionMajor": self.version_major,
            "versionMinor": self.version_minor,
            "versionPatch": self.version_patch,
            "releaseType": self.release_type,
            "boardId": self.board_id,
            "bootloaderStr": list(self.bootloader_str),
            "usbId": list(self.usb_id),
            "brandName": self.brand_name,
            "manufacturer": self.manufacturer,
            "imageSize": self.image_size,
            "gitSha": self.git_sha,
            "autopilot": self.autopilot,
            "latest": self.latest,
            "sha256": self.artifact_sha256,
        }


def _as_str(value: Any, default: str = "") -> str:
    return value if isinstance(value, str) else default


def _as_optional_int(value: Any) -> Optional[int]:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        try:
            return int(value.strip())
        except ValueError:
            return None
    return None


def _as_str_tuple(value: Any) -> Tuple[str, ...]:
    if not isinstance(value, list):
        return ()
    return tuple(item for item in value if isinstance(item, str) and item.strip())


def candidate_from_entry(entry: Dict[str, Any]) -> Optional[FirmwareCandidate]:
    """Build a typed candidate from one manifest entry, or ``None``.

    Unknown fields are ignored. An entry without a usable HTTPS image URL cannot
    ever be fetched, so it is skipped rather than exposed as selectable.
    """
    url = _as_str(entry.get("url")).strip()
    if not url:
        return None
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https" or (parsed.hostname or "") != OFFICIAL_FIRMWARE_HOST:
        # Never surface an artifact that YantraYug would refuse to download.
        return None

    release_type = _as_str(entry.get("mav-firmware-version-type")).strip()
    image_format = _as_str(entry.get("format")).strip()
    vehicle = _as_str(entry.get("mav-type")).strip()
    if not release_type or not image_format or not vehicle:
        return None

    return FirmwareCandidate(
        url=url,
        platform=_as_str(entry.get("platform")).strip(),
        vehicle=vehicle,
        vehicle_type=_as_str(entry.get("vehicletype")).strip(),
        image_format=image_format,
        version=_as_str(entry.get("mav-firmware-version")).strip(),
        version_str=_as_str(entry.get("mav-firmware-version-str")).strip(),
        version_major=_as_optional_int(entry.get("mav-firmware-version-major")),
        version_minor=_as_optional_int(entry.get("mav-firmware-version-minor")),
        version_patch=_as_optional_int(entry.get("mav-firmware-version-patch")),
        release_type=release_type,
        board_id=_as_optional_int(entry.get("board_id")),
        bootloader_str=_as_str_tuple(entry.get("bootloader_str")),
        usb_id=_as_str_tuple(entry.get("USBID")),
        brand_name=_as_str(entry.get("brand_name")).strip(),
        manufacturer=_as_str(entry.get("manufacturer")).strip(),
        image_size=_as_optional_int(entry.get("image_size")),
        git_sha=_as_str(entry.get("git-sha")).strip(),
        autopilot=_as_str(entry.get("mav-autopilot")).strip(),
        latest=bool(entry.get("latest")),
        artifact_sha256=_as_str(
            entry.get("sha256") or entry.get("artifact_sha256")
        ).strip().lower(),
    )


def extract_candidates(
    entries: List[Dict[str, Any]], vehicle: Optional[str] = None
) -> List[FirmwareCandidate]:
    """Extract active-channel candidates, optionally restricted to one vehicle."""
    candidates: List[FirmwareCandidate] = []
    seen = set()
    for entry in entries:
        candidate = candidate_from_entry(entry)
        if candidate is None:
            continue
        if candidate.release_type not in ACTIVE_RELEASE_TYPES:
            continue
        if candidate.image_format not in INSTALLABLE_FORMATS:
            continue
        if vehicle and candidate.vehicle != vehicle:
            continue
        key = candidate.identity()
        if key in seen:
            continue
        seen.add(key)
        candidates.append(candidate)
    candidates.sort(key=lambda c: (c.version, c.platform), reverse=True)
    return candidates


# ---------------------------------------------------------------------------
# Cache
# ---------------------------------------------------------------------------

@dataclass
class _CacheRecord:
    compressed: bytes
    sha256: str
    etag: str
    fetched_at: float
    url: str


def _cache_dir() -> Path:
    return Path(config.FIRMWARE_MANIFEST_CACHE_DIR)


def _cache_paths() -> Tuple[Path, Path]:
    root = _cache_dir()
    return root / "manifest.json.gz", root / "manifest.meta.json"


def _read_cache() -> Optional[_CacheRecord]:
    """Load and re-verify the cached manifest. Corrupt cache is discarded."""
    data_path, meta_path = _cache_paths()
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        compressed = data_path.read_bytes()
    except (OSError, ValueError):
        return None
    if not isinstance(meta, dict):
        return None
    digest = meta.get("sha256")
    etag = meta.get("etag")
    fetched_at = meta.get("fetchedAt")
    url = meta.get("url")
    if not isinstance(digest, str) or not isinstance(etag, str):
        return None
    if not isinstance(fetched_at, (int, float)) or not isinstance(url, str):
        return None
    if hashlib.sha256(compressed).hexdigest() != digest:
        return None
    return _CacheRecord(
        compressed=compressed,
        sha256=digest,
        etag=etag,
        fetched_at=float(fetched_at),
        url=url,
    )


def _write_cache(compressed: bytes, etag: str, url: str) -> None:
    """Persist a *validated* manifest. Never called before validation succeeds."""
    data_path, meta_path = _cache_paths()
    try:
        _cache_dir().mkdir(parents=True, exist_ok=True)
        data_path.write_bytes(compressed)
        meta_path.write_text(
            json.dumps(
                {
                    "sha256": hashlib.sha256(compressed).hexdigest(),
                    "etag": etag,
                    "fetchedAt": time.time(),
                    "url": url,
                },
                indent=2,
            ),
            encoding="utf-8",
        )
    except OSError:
        # A cache that cannot be written is not fatal; the network result stands.
        pass


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

@dataclass
class CatalogResult:
    ok: bool
    candidates: List[FirmwareCandidate]
    source: str  # "network" | "cache" | "none"
    stale: bool
    format_version: str
    total_entries: int
    etag: str
    message: str
    fetched_at: Optional[float]
    cache_age_seconds: Optional[int]
    manifest_url: str

    def status_dict(self) -> Dict[str, Any]:
        return {
            "available": self.ok,
            "source": self.source,
            "stale": self.stale,
            "formatVersion": self.format_version,
            "totalEntries": self.total_entries,
            "etag": self.etag,
            "message": self.message,
            "fetchedAt": self.fetched_at,
            "cacheAgeSeconds": self.cache_age_seconds,
            "manifestUrl": self.manifest_url,
            "candidateCount": len(self.candidates),
        }


_lock = threading.Lock()
_memo: Optional[Tuple[str, str, List[FirmwareCandidate]]] = None


def _build_from_compressed(
    compressed: bytes, etag: str, manifest_url: str
) -> Tuple[str, int, List[FirmwareCandidate]]:
    """Decompress → parse → validate → extract (all vehicle types, active channels)."""
    document = decompress_manifest(compressed)
    format_version, entries = parse_manifest(document)
    return format_version, len(entries), extract_candidates(entries)


def get_catalog(vehicle: Optional[str] = None, force_refresh: bool = False) -> CatalogResult:
    """Return the official catalogue for ``vehicle``.

    Flow: conditional GET (ETag) → 304 uses the cache, 200 validates and replaces
    it, and a transport failure falls back to a revalidated cache marked stale.
    """
    global _memo

    manifest_url = config.FIRMWARE_MANIFEST_URL
    try:
        _validate_manifest_url(manifest_url)
    except ManifestSchemaError as exc:
        return CatalogResult(
            ok=False, candidates=[], source="none", stale=False, format_version="",
            total_entries=0, etag="", message=str(exc), fetched_at=None,
            cache_age_seconds=None, manifest_url=manifest_url,
        )

    with _lock:
        cache = _read_cache()
        now = time.time()
        cache_fresh = bool(
            cache and not force_refresh
            and (now - cache.fetched_at) < config.FIRMWARE_MANIFEST_CACHE_TTL_S
        )

        # Serve the validated cache without a round trip while it is fresh.
        if cache_fresh and _memo is not None:
            format_version, total, candidates = _memo
            return CatalogResult(
                ok=True,
                candidates=[c for c in candidates if not vehicle or c.vehicle == vehicle],
                source="cache", stale=False, format_version=format_version,
                total_entries=total, etag=cache.etag,
                message="Firmware catalogue served from validated local cache.",
                fetched_at=cache.fetched_at,
                cache_age_seconds=int(now - cache.fetched_at),
                manifest_url=manifest_url,
            )

        headers: Dict[str, str] = {"Accept-Encoding": "identity"}
        if cache:
            headers["If-None-Match"] = cache.etag

        try:
            response = _http_get(
                manifest_url,
                headers=headers,
                timeout=config.FIRMWARE_MANIFEST_TIMEOUT_S,
            )
        except Exception as exc:  # noqa: BLE001 - any transport failure falls back
            return _fallback(cache, manifest_url, f"Firmware catalogue request failed: {exc}")

        if response.status == 304:
            if not cache:
                return _fallback(cache, manifest_url, "Server reported no change but no cache exists.")
            try:
                format_version, total, candidates = _build_from_compressed(
                    cache.compressed, cache.etag, manifest_url
                )
            except ManifestSchemaError as exc:
                return _fallback(cache, manifest_url, f"Cached catalogue is unusable: {exc}")
            _memo = (cache.etag, format_version, candidates)
            return CatalogResult(
                ok=True,
                candidates=[c for c in candidates if not vehicle or c.vehicle == vehicle],
                source="cache", stale=False, format_version=format_version,
                total_entries=total, etag=cache.etag,
                message="Firmware catalogue revalidated (unchanged upstream).",
                fetched_at=cache.fetched_at,
                cache_age_seconds=int(time.time() - cache.fetched_at),
                manifest_url=manifest_url,
            )

        if response.status != 200:
            return _fallback(
                cache, manifest_url,
                f"Firmware catalogue server returned HTTP {response.status}.",
            )

        compressed = response.body
        if not compressed:
            return _fallback(cache, manifest_url, "Firmware catalogue response was empty.")
        if len(compressed) > MAX_COMPRESSED_BYTES:
            return _fallback(cache, manifest_url, "Firmware catalogue response exceeded the size limit.")

        try:
            format_version, total, candidates = _build_from_compressed(
                compressed, "", manifest_url
            )
        except ManifestSchemaError as exc:
            # Invalid remote data is never cached and never returned as data.
            return _fallback(cache, manifest_url, f"Firmware catalogue is invalid: {exc}")

        etag = response.headers.get("etag", "")
        _write_cache(compressed, etag, manifest_url)
        _memo = (etag, format_version, candidates)

        return CatalogResult(
            ok=True,
            candidates=[c for c in candidates if not vehicle or c.vehicle == vehicle],
            source="network", stale=False, format_version=format_version,
            total_entries=total, etag=etag,
            message="Firmware catalogue retrieved from the official ArduPilot server.",
            fetched_at=time.time(), cache_age_seconds=0, manifest_url=manifest_url,
        )


def _fallback(cache: Optional[_CacheRecord], manifest_url: str, reason: str) -> CatalogResult:
    """Use a revalidated cache marked stale, or report unavailable."""
    global _memo
    if cache:
        try:
            format_version, total, candidates = _build_from_compressed(
                cache.compressed, cache.etag, manifest_url
            )
        except ManifestSchemaError as exc:
            return CatalogResult(
                ok=False, candidates=[], source="none", stale=False, format_version="",
                total_entries=0, etag="", message=f"{reason} Cached catalogue unusable: {exc}",
                fetched_at=None, cache_age_seconds=None, manifest_url=manifest_url,
            )
        if _memo is None:
            _memo = (cache.etag, format_version, candidates)
        return CatalogResult(
            ok=True,
            candidates=candidates,
            source="cache", stale=True, format_version=format_version,
            total_entries=total, etag=cache.etag,
            message=f"{reason} Using validated cached catalogue.",
            fetched_at=cache.fetched_at,
            cache_age_seconds=int(time.time() - cache.fetched_at),
            manifest_url=manifest_url,
        )
    return CatalogResult(
        ok=False, candidates=[], source="none", stale=False, format_version="",
        total_entries=0, etag="", message=reason, fetched_at=None,
        cache_age_seconds=None, manifest_url=manifest_url,
    )


def catalog_status() -> Dict[str, Any]:
    """Lightweight catalogue availability report for the capability endpoint.

    Uses only the on-disk cache: probing the network on a capability request
    would make a UI poll trigger a 1.8 MB download.
    """
    cache = _read_cache()
    if cache is None:
        return {
            "available": False,
            "source": "none",
            "stale": False,
            "message": "Firmware catalogue has not been retrieved yet.",
            "manifestUrl": config.FIRMWARE_MANIFEST_URL,
        }
    try:
        format_version, total, _ = _build_from_compressed(
            cache.compressed, cache.etag, config.FIRMWARE_MANIFEST_URL
        )
    except ManifestSchemaError as exc:
        return {
            "available": False,
            "source": "none",
            "stale": False,
            "message": f"Cached firmware catalogue is invalid: {exc}",
            "manifestUrl": config.FIRMWARE_MANIFEST_URL,
        }
    return {
        "available": True,
        "source": "cache",
        "stale": False,
        "message": "Firmware catalogue available from the official ArduPilot server.",
        "formatVersion": format_version,
        "totalEntries": total,
        "etag": cache.etag,
        "cacheAgeSeconds": int(time.time() - cache.fetched_at),
        "manifestUrl": config.FIRMWARE_MANIFEST_URL,
    }


def clear_memo() -> None:
    """Drop only the in-memory parsed catalogue, keeping the on-disk cache.

    Used to model a fresh process that still has a valid cache on disk.
    """
    global _memo
    with _lock:
        _memo = None


def reset_cache() -> None:
    """Clear the in-memory memo and the on-disk catalogue cache (tests)."""
    clear_memo()
    data_path, meta_path = _cache_paths()
    for path in (data_path, meta_path):
        try:
            path.unlink()
        except OSError:
            pass
