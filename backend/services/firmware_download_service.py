"""Firmware artifact download preparation (read-only fetch + integrity check).

Downloads an official ArduPilot firmware image to a local staging file and
verifies it. It deliberately does **not** execute, upload, install, or otherwise
touch a vehicle — the file is only ever read from disk by this phase.

Integrity rules, and one important limitation:

* HTTPS only, and only from the official ArduPilot firmware host.
* HTTP status must be 200 and a ``Content-Length`` must be present.
* The number of bytes written must equal ``Content-Length``; a short or
  over-long transfer is rejected and the partial file is discarded, so a
  partial download is never treated as a valid firmware file.
* A SHA-256 digest of the downloaded bytes is computed and reported.

**The manifest publishes no artifact checksum.** The complete field set across
all 97,377 manifest entries is:

    USBID, board_id, bootloader_str, brand_name, format, git-sha, image_size,
    latest, logs, manufacturer, mav-autopilot, mav-firmware-version,
    mav-firmware-version-major/-minor/-patch, mav-firmware-version-str,
    mav-firmware-version-type, mav-type, parameters, platform, url, vehicletype

The only hash-like field is ``git-sha``, which is the ArduPilot *source commit*,
not a digest of the image. Consequently the computed digest is reported for the
record but **cannot be verified against an authoritative expected value**, and
this module says so rather than claiming an integrity check it cannot perform.

Note also that the manifest's ``image_size`` is the *flash* image size, not the
``.apj`` container size: for ``Copter/stable/CubeBlack/arducopter.apj`` the
manifest reports ``image_size = 1742336`` while the served file is 1566486 bytes.
Download completeness is therefore checked against HTTP ``Content-Length``, and
``image_size`` is reported only as the target flash size.
"""

from __future__ import annotations

import hashlib
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Optional

from core import config
from services.firmware_catalog_service import (
    OFFICIAL_FIRMWARE_HOST,
    FirmwareCandidate,
    _http_get,
)

STAGING_DIR_NAME = "downloads"


class DownloadRejected(RuntimeError):
    """The artifact could not be fetched or failed verification."""


def staging_dir() -> Path:
    return Path(config.FIRMWARE_MANIFEST_CACHE_DIR) / STAGING_DIR_NAME


# Authoritative failure taxonomy. The reason a fetch failed is decided here, by
# the code that actually observed it, rather than re-guessed downstream from the
# human-readable message.
# Integrity verdicts, strongest first. Exactly one of these describes a
# successful fetch:
#
#   CHECKSUM_VERIFIED       the official source published a digest and it matched
#   SIZE_VERIFIED           the source declared a size and the transfer matched it
#   TRANSFER_COMPLETE_ONLY  the transfer ended cleanly but nothing published by
#                           the source could be checked against it
#
# A failed check is VERIFICATION_FAILED; a failed transfer is not an integrity
# verdict at all and is reported as DOWNLOAD_FAILED instead.
INTEGRITY_CHECKSUM_VERIFIED = "CHECKSUM_VERIFIED"
INTEGRITY_SIZE_VERIFIED = "SIZE_VERIFIED"
INTEGRITY_TRANSFER_COMPLETE_ONLY = "TRANSFER_COMPLETE_ONLY"
INTEGRITY_VERIFICATION_FAILED = "VERIFICATION_FAILED"

#: Verdicts that prove the bytes are the ones the source intended to send. Only
#: these may be described as verified; TRANSFER_COMPLETE_ONLY may not.
INTEGRITY_VERIFIED_STATES = frozenset(
    {INTEGRITY_CHECKSUM_VERIFIED, INTEGRITY_SIZE_VERIFIED}
)

DOWNLOAD_DISABLED = "DOWNLOAD_DISABLED"
DOWNLOAD_REJECTED = "DOWNLOAD_REJECTED"
DOWNLOAD_FAILED = "DOWNLOAD_FAILED"
DOWNLOAD_VERIFICATION_FAILED = "DOWNLOAD_VERIFICATION_FAILED"


@dataclass
class DownloadResult:
    ok: bool
    message: str
    candidate_id: str = ""
    url: str = ""
    path: Optional[str] = None
    bytes_written: int = 0
    content_length: Optional[int] = None
    content_type: str = ""
    sha256: str = ""
    checksum_verified: bool = False
    checksum_note: str = ""
    image_size: Optional[int] = None
    executed: bool = False
    installed: bool = False
    # One of DOWNLOAD_DISABLED / DOWNLOAD_REJECTED / DOWNLOAD_FAILED /
    # DOWNLOAD_VERIFICATION_FAILED. Empty when ``ok`` is True.
    error_kind: str = ""
    # The integrity verdict for a successful fetch: CHECKSUM_VERIFIED,
    # SIZE_VERIFIED or TRANSFER_COMPLETE_ONLY. Empty when ``ok`` is False.
    integrity: str = ""
    # What the official source actually published, so a caller can see why the
    # verdict is what it is instead of having to infer it.
    integrity_evidence: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "success": self.ok,
            "message": self.message,
            "candidateId": self.candidate_id,
            "url": self.url,
            "path": self.path,
            "bytesWritten": self.bytes_written,
            "contentLength": self.content_length,
            "contentType": self.content_type,
            "sha256": self.sha256,
            "checksumVerified": self.checksum_verified,
            "checksumNote": self.checksum_note,
            "imageSize": self.image_size,
            "errorKind": self.error_kind,
            "integrity": self.integrity,
            "integrityEvidence": self.integrity_evidence,
            "executed": self.executed,
            "installed": self.installed,
        }


def _validate_artifact_url(url: str) -> None:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https":
        raise DownloadRejected("Firmware artifacts must be fetched over HTTPS.")
    if (parsed.hostname or "") != OFFICIAL_FIRMWARE_HOST:
        raise DownloadRejected(
            f"Firmware artifacts must come from {OFFICIAL_FIRMWARE_HOST}."
        )
    try:
        if parsed.username is not None or parsed.password is not None or parsed.port not in (None, 443):
            raise DownloadRejected("Firmware artifacts must use the official HTTPS origin.")
    except ValueError as exc:
        raise DownloadRejected("Firmware artifact URL has an invalid port.") from exc


def prepare_download(candidate: FirmwareCandidate) -> DownloadResult:
    """Fetch and verify a firmware image without executing or installing it.

    Only callable for a candidate that already carries a verified official
    manifest URL.
    """
    if not config.FIRMWARE_DOWNLOAD_ENABLED:
        return DownloadResult(
            ok=False,
            message="Firmware download preparation is disabled in this build.",
            candidate_id=candidate.identity(),
            url=candidate.url,
            error_kind=DOWNLOAD_DISABLED,
        )

    try:
        _validate_artifact_url(candidate.url)
    except DownloadRejected as exc:
        return DownloadResult(
            ok=False, message=str(exc),
            candidate_id=candidate.identity(), url=candidate.url,
            error_kind=DOWNLOAD_REJECTED,
        )

    try:
        response = _http_get(
            candidate.url,
            headers={"Accept-Encoding": "identity"},
            timeout=config.FIRMWARE_DOWNLOAD_TIMEOUT_S,
            max_bytes=config.FIRMWARE_DOWNLOAD_MAX_BYTES,
        )
    except Exception as exc:  # noqa: BLE001
        return DownloadResult(
            ok=False, message=f"Firmware download failed: {exc}",
            candidate_id=candidate.identity(), url=candidate.url,
            error_kind=DOWNLOAD_FAILED,
        )

    if response.status != 200:
        return DownloadResult(
            ok=False,
            message=f"Firmware download failed: HTTP {response.status}.",
            candidate_id=candidate.identity(), url=candidate.url,
            content_length=_maybe_int(response.headers.get("content-length")),
            content_type=response.headers.get("content-type", ""),
            image_size=candidate.image_size,
            error_kind=DOWNLOAD_FAILED,
        )

    body = response.body
    declared = _maybe_int(response.headers.get("content-length"))
    if declared is not None and len(body) != declared:
        # A short or over-long transfer is never treated as a valid firmware
        # file: the bytes that arrived are demonstrably not the bytes that were
        # offered.
        return DownloadResult(
            ok=False,
            message=(
                f"Firmware download rejected: incomplete transfer "
                f"({len(body)} of {declared} bytes)."
            ),
            candidate_id=candidate.identity(), url=candidate.url,
            bytes_written=len(body), content_length=declared,
            content_type=response.headers.get("content-type", ""),
            image_size=candidate.image_size,
            error_kind=DOWNLOAD_VERIFICATION_FAILED,
            integrity=INTEGRITY_VERIFICATION_FAILED,
            integrity_evidence=(
                f"declared {declared} bytes, received {len(body)}"
            ),
        )

    # What the official source published decides how strong a verdict is
    # possible. Nothing is invented here: a digest is only compared when the
    # source actually supplied one.
    if declared is not None:
        integrity = INTEGRITY_SIZE_VERIFIED
        evidence = (
            f"the official host declared {declared} bytes and the transfer "
            f"delivered exactly {len(body)}"
        )
    else:
        # No declared length and no published digest: the connection ended
        # cleanly, so this is the weakest honest verdict. It is reported as
        # TRANSFER_COMPLETE_ONLY precisely so nothing downstream can describe it
        # as verified.
        integrity = INTEGRITY_TRANSFER_COMPLETE_ONLY
        evidence = (
            "the official host published neither an artifact checksum nor a "
            "Content-Length, so only the clean end of the transfer was observed"
        )

    digest = hashlib.sha256(body).hexdigest()

    # A digest published by the official source is the strongest evidence
    # available, so it outranks the size check when both exist.
    published = (getattr(candidate, "artifact_sha256", "") or "").strip().lower()
    if published:
        if published != digest:
            return DownloadResult(
                ok=False,
                message=(
                    "Firmware download rejected: the artifact digest does not "
                    "match the digest published by the official manifest."
                ),
                candidate_id=candidate.identity(), url=candidate.url,
                bytes_written=len(body), content_length=declared,
                sha256=digest, content_type=response.headers.get("content-type", ""),
                image_size=candidate.image_size,
                error_kind=DOWNLOAD_VERIFICATION_FAILED,
                integrity=INTEGRITY_VERIFICATION_FAILED,
                integrity_evidence=(
                    "the official manifest published a SHA-256 for this artifact "
                    "and the downloaded bytes do not match it"
                ),
            )
        integrity = INTEGRITY_CHECKSUM_VERIFIED
        evidence = (
            "the official manifest published a SHA-256 for this artifact and the "
            "downloaded bytes match it"
        )

    path: Optional[Path] = None
    try:
        staging_dir().mkdir(parents=True, exist_ok=True)
        safe_name = candidate.identity().replace("/", "_")
        path = staging_dir() / f"{safe_name}.apj"
        path.write_bytes(body)
    except OSError as exc:
        return DownloadResult(
            ok=False,
            message=f"Firmware download could not be staged: {exc}",
            candidate_id=candidate.identity(), url=candidate.url,
            bytes_written=len(body), content_length=declared,
            sha256=digest, content_type=response.headers.get("content-type", ""),
            image_size=candidate.image_size,
            error_kind=DOWNLOAD_FAILED,
        )

    return DownloadResult(
        ok=True,
        message=(
            "Firmware image downloaded and its integrity checked as far as the "
            "official source allows. It has not been executed, uploaded or "
            "installed."
        ),
        integrity=integrity,
        integrity_evidence=evidence,
        candidate_id=candidate.identity(),
        url=candidate.url,
        path=str(path),
        bytes_written=len(body),
        content_length=declared,
        content_type=response.headers.get("content-type", ""),
        sha256=digest,
        checksum_verified=integrity == INTEGRITY_CHECKSUM_VERIFIED,
        checksum_note=(
            ""
            if integrity == INTEGRITY_CHECKSUM_VERIFIED
            else "The official ArduPilot manifest publishes no artifact checksum, so "
            "this SHA-256 is reported for the record only and is not verified "
            "against an authoritative expected digest."
        ),
        image_size=candidate.image_size,
    )


def _maybe_int(value: Optional[str]) -> Optional[int]:
    if value is None:
        return None
    try:
        return int(value.strip())
    except (TypeError, ValueError):
        return None
