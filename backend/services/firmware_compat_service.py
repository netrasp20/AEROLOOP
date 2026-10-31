"""Firmware compatibility resolution for the SETUP -> Firmware page.

This module decides whether a real, official ArduPilot firmware image can be
offered for the connected vehicle. Its single most important rule is that
**board_id alone is never sufficient to select a firmware image**.

That rule is not theoretical. Verified against the live official manifest
(97,377 entries), for the ArduCopter vehicle in the three active release
channels there are 895 ``.apj`` candidates spanning **254 distinct board_id
values**, and the very common ``board_id = 9`` ("PX4 BL FMU v2.x") resolves to
**14 mutually incompatible physical platforms**:

    Pixhawk1, Pixhawk1-1M, Pixhawk1-bdshot, Pixhawk1-1M-bdshot,
    CubeBlack, CubePurple, CubeSolo, CubeGreen-solo,
    fmuv2, fmuv3, skyviper-journey, skyviper-v2450,
    mRoX21, CUAV-Pixhack-v3

The manifest's ``USBID`` is even weaker: ``0x1209/0x5741`` is present on 528 of
895 ArduCopter candidates and spans **159 board_ids / 188 platforms**, so a USB
ID must never be used to choose an image either.

The only field that actually discriminates is ``bootloader_str`` (present on
100% of candidates) — the bootloader's USB product string, which is observable
*only while the board is in bootloader mode*. Outside bootloader mode there is
no trustworthy board identity, so the resolver reports AMBIGUOUS rather than
guessing. That is the truthful outcome, not a failure.

Outcomes
--------
``EXACT_MATCH``          bootloader product string resolved one unique platform.
``CONFIRMED_COMPATIBLE`` bootloader string plus a corroborating board id resolved
                        one unique platform.
``AMBIGUOUS``            several mutually incompatible candidates remain, or the
                        available evidence is too weak to choose.
``UNSUPPORTED``          the connected target is not an ArduCopter target (this
                        includes SITL, which has no physical flash target).
``NO_MATCH``             the catalogue holds no entry for this identity.
``UNKNOWN``             no vehicle identity is available yet.
``UNAVAILABLE``          the official catalogue itself could not be retrieved, so
                        compatibility was never actually evaluated.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence
from urllib.parse import urlparse

from services.bootloader_identity import (
    BOARD_ID_FMUV2,
    FLASH_SIZE_SMALL,
    BootloaderIdentity,
    interpret_board_id,
)
from services.firmware_catalog_service import (
    ACTIVE_RELEASE_TYPES,
    OFFICIAL_FIRMWARE_HOST,
    FirmwareCandidate,
)

# Outcomes
EXACT_MATCH = "EXACT_MATCH"
CONFIRMED_COMPATIBLE = "CONFIRMED_COMPATIBLE"
AMBIGUOUS = "AMBIGUOUS"
UNSUPPORTED = "UNSUPPORTED"
NO_MATCH = "NO_MATCH"
UNKNOWN = "UNKNOWN"
UNAVAILABLE = "UNAVAILABLE"

#: The device is present and identified well enough to talk to, but the data
#: needed to identify its *hardware* could not be obtained. Distinct from
#: ``AMBIGUOUS`` (where several incompatible targets remain) and from
#: ``NO_DEVICE`` (where there is nothing to talk to at all).
IDENTITY_UNAVAILABLE = "IDENTITY_UNAVAILABLE"

#: No device is connected, so no identity could be attempted.
NO_DEVICE = "NO_DEVICE"

# Outcomes that may be presented to the user as an installable target.
SELECTING_OUTCOMES = (EXACT_MATCH, CONFIRMED_COMPATIBLE)

#: Every outcome the resolver can return.
ALL_OUTCOMES = (
    EXACT_MATCH,
    CONFIRMED_COMPATIBLE,
    AMBIGUOUS,
    UNSUPPORTED,
    IDENTITY_UNAVAILABLE,
    NO_DEVICE,
    NO_MATCH,
    UNKNOWN,
    UNAVAILABLE,
)

# Deterministic release-type preference when several channels offer the same
# platform. Stable > Beta > Dev, matching QGroundControl's channel ordering.
_RELEASE_RANK = {"OFFICIAL": 0, "BETA": 1, "DEV": 2}

# How many ambiguous platforms are reported back to the UI. The full list is
# still counted honestly; only the sample is truncated for transport size.
_MAX_REPORTED_PLATFORMS = 20


@dataclass
class IdentityEvidence:
    """Board/vehicle identity gathered from the authoritative vehicle data."""

    connected: bool = False
    is_sitl: bool = False
    autopilot: str = ""
    vehicle_type: str = ""
    manifest_vehicle: Optional[str] = None
    board_type: Optional[int] = None
    board_rev: Optional[int] = None
    board_id: Optional[int] = None
    vendor_id: Optional[int] = None
    product_id: Optional[int] = None
    usb_id: Optional[str] = None
    bootloader_str: Optional[str] = None
    firmware_version: str = ""
    connection_type: str = ""
    evidence: List[str] = field(default_factory=list)

    #: Validated bootloader identity, or None when the board is not in
    #: bootloader mode. Only a *valid and complete* identity is ever consumed
    #: by :func:`resolve`; see :func:`apply_bootloader_identity`.
    bootloader_identity: Optional[BootloaderIdentity] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "connected": self.connected,
            "isSitl": self.is_sitl,
            "autopilot": self.autopilot,
            "vehicleType": self.vehicle_type,
            "manifestVehicle": self.manifest_vehicle,
            "boardType": self.board_type,
            "boardRev": self.board_rev,
            "boardId": self.board_id,
            "vendorId": self.vendor_id,
            "productId": self.product_id,
            "usbId": self.usb_id,
            "bootloaderStr": self.bootloader_str,
            "firmwareVersion": self.firmware_version,
            "connectionType": self.connection_type,
            "evidence": list(self.evidence),
            "hasBootloaderIdentity": self.bootloader_identity is not None
            and self.bootloader_identity.is_usable_for_resolution,
            "bootloaderIdentity": (
                self.bootloader_identity.to_dict() if self.bootloader_identity else None
            ),
        }


@dataclass
class CrossCheckItem:
    """One independent fact an exact match has to survive."""

    name: str
    passed: bool
    detail: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {"name": self.name, "passed": self.passed, "detail": self.detail}


@dataclass
class CrossCheckResult:
    """The full cross-check verdict for one exact match."""

    candidate: str
    platform: str
    passed: bool
    checks: List[CrossCheckItem] = field(default_factory=list)

    @property
    def failed_checks(self) -> List[str]:
        return [c.name for c in self.checks if not c.passed]

    @property
    def summary(self) -> str:
        if self.passed:
            return f"{self.platform} verified against every official-manifest check."
        return (
            f"{self.platform} failed: "
            + "; ".join(f"{c.name} ({c.detail})" for c in self.checks if not c.passed)
        )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "candidate": self.candidate,
            "platform": self.platform,
            "passed": self.passed,
            "failedChecks": self.failed_checks,
            "checks": [c.to_dict() for c in self.checks],
        }


@dataclass
class Resolution:
    outcome: str
    reason: str
    selected: Optional[FirmwareCandidate] = None
    candidate_count: int = 0
    platform_count: int = 0
    platforms: List[str] = field(default_factory=list)
    signals_used: List[str] = field(default_factory=list)
    evidence: List[str] = field(default_factory=list)
    #: Verdict of the independent official-manifest cross-check, when one was
    #: run. An exact match that failed cross-checking is reported as AMBIGUOUS,
    #: so a populated cross_check with ``passed=False`` never accompanies a
    #: selectable outcome.
    cross_check: Optional[CrossCheckResult] = None

    @property
    def can_confirm(self) -> bool:
        return self.outcome in SELECTING_OUTCOMES and self.selected is not None

    @property
    def auto_selected(self) -> bool:
        """Whether a candidate may be chosen for the operator.

        Only :data:`EXACT_MATCH` identifies the hardware positively enough to
        pick a firmware image without a human saying which one they meant. Every
        other outcome that still resolves a platform has narrowed the field
        (``CONFIRMED_COMPATIBLE``), which is enough to *offer* the candidates
        and to say they are not compatible with anything else, but not enough
        to choose one on the operator's behalf. Those outcomes must be
        confirmed explicitly.
        """
        return self.outcome == EXACT_MATCH and self.selected is not None

    def to_dict(self, include_candidates: int = 0) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "outcome": self.outcome,
            "reason": self.reason,
            "canConfirm": self.can_confirm,
            "candidateCount": self.candidate_count,
            "platformCount": self.platform_count,
            "platforms": self.platforms[:_MAX_REPORTED_PLATFORMS],
            "platformsTruncated": len(self.platforms) > _MAX_REPORTED_PLATFORMS,
            "signalsUsed": self.signals_used,
            "evidence": self.evidence,
            "selected": self.selected.to_dict() if self.selected else None,
            "crossCheck": self.cross_check.to_dict() if self.cross_check else None,
        }
        return payload


# ---------------------------------------------------------------------------
# Identity extraction (reuses the existing authoritative firmware info)
# ---------------------------------------------------------------------------

# ArduPilot MAVLink copter vehicle types that map onto the manifest's "Copter".
_COPTER_TYPES = {
    "QUADROTOR", "TRICOPTER", "HEXAROTOR", "OCTOROTOR", "COAXIAL",
    "HELICOPTER", "VTOL_QUADROTOR", "VTOL_TILTROTOR", "VTOL_RESERVED2",
    "VTOL_RESERVED3", "VTOL_RESERVED4", "VTOL_RESERVED5",
}


def _hex(value: Optional[int], width: int) -> str:
    if value is None:
        return ""
    return f"0x{value:0{width}x}"


def identity_from_firmware_info(info: Dict[str, Any], is_sitl: bool = False) -> IdentityEvidence:
    """Derive board/vehicle identity evidence from the existing firmware info.

    Deliberately reuses the payload already produced by
    ``setup_service.request_firmware_info()`` (AUTOPILOT_VERSION + heartbeat
    identity) so no second vehicle-identity system is introduced.
    """
    evidence: List[str] = []
    identity = IdentityEvidence(
        connected=bool(info.get("connected")) and bool(info.get("success")),
        autopilot=str(info.get("autopilot") or ""),
        vehicle_type=str(info.get("vehicleType") or ""),
        board_type=info.get("boardType"),
        board_rev=info.get("boardRev"),
        vendor_id=info.get("vendorId"),
        product_id=info.get("productId"),
        firmware_version=str(info.get("version") or ""),
        connection_type=str(info.get("connectionType") or ""),
        is_sitl=is_sitl,
    )

    if identity.connected:
        evidence.append("AUTOPILOT_VERSION identity received from the vehicle")

    # ArduCopter <-> manifest "Copter"
    if identity.autopilot.upper().startswith("ARDUPILOT") and identity.vehicle_type.upper() in _COPTER_TYPES:
        identity.manifest_vehicle = "Copter"
        evidence.append(f"ArduPilot {identity.vehicle_type} maps to manifest vehicle 'Copter'")
    else:
        identity.manifest_vehicle = None

    if identity.vendor_id is not None and identity.product_id is not None:
        identity.usb_id = f"{_hex(identity.vendor_id, 4)}/{_hex(identity.product_id, 4)}"
        evidence.append(f"USB vendor/product {identity.usb_id} reported by AUTOPILOT_VERSION")

    # ArduPilot's AUTOPILOT_VERSION.board_version is NOT the manifest board_id.
    # On a live Pixhawk1 (board_version 589824 = 0x00090000) it decodes to
    # board_type 0 / board_rev 9, and 0 matches no manifest board_id. It is
    # therefore reported as evidence only, and is never used to select a board.
    if identity.board_type is not None:
        evidence.append(
            f"AUTOPILOT_VERSION.board_version decodes to board type "
            f"{identity.board_type}.{identity.board_rev or 0} "
            "(not a manifest board id; not used for selection)"
        )

    # The bootloader's USB product string is the only strong selector and is
    # observable only in bootloader mode. This phase never enters bootloader
    # mode on real hardware, so it is never populated here.
    identity.bootloader_str = None
    evidence.append(
        "No bootloader product string available: the board is not in bootloader "
        "mode, so its physical platform cannot be identified safely"
    )

    identity.bootloader_identity = None
    identity.evidence = evidence
    return identity


def apply_bootloader_identity(
    identity: IdentityEvidence,
    bootloader_result: Any,
) -> IdentityEvidence:
    """Fold a validated bootloader identity into the resolver's identity.

    ``bootloader_result`` is a
    :class:`~services.bootloader_identity.BootloaderIdentityResult` (or ``None``).

    Only a *valid and complete* identity is promoted into ``bootloader_str`` and
    ``board_id``. An ``INCOMPLETE``, ``INVALID`` or ``UNAVAILABLE`` identity is
    recorded as evidence and otherwise ignored, because a partially-read
    identity must never narrow the manifest — with board id 9 covering FMUv2,
    FMUv3 and Cube F4, a half-populated identity can point at the wrong board.
    """
    evidence = list(identity.evidence)

    if bootloader_result is None:
        evidence.append("No bootloader identity reader was supplied for this resolution.")
        identity.evidence = evidence
        return identity

    bid = getattr(bootloader_result, "identity", None)
    evidence.extend(getattr(bootloader_result, "evidence", []) or [])

    if bid is None or not getattr(bid, "is_valid", False):
        validity = getattr(bid, "validity", "UNAVAILABLE")
        errors = list(getattr(bid, "errors", []) or [])
        if errors:
            evidence.append(
                f"Bootloader identity rejected ({validity}): " + "; ".join(errors)
            )
        evidence.append(
            "Bootloader identity was not usable for selection, so normal-mode "
            "resolution rules apply unchanged."
        )
        identity.evidence = evidence
        return identity

    if not bid.is_complete:
        evidence.append(
            "Bootloader identity is valid but incomplete (missing: "
            + ", ".join(bid.missing_fields)
            + "). An incomplete identity is not used to select firmware."
        )
        identity.evidence = evidence
        return identity

    effective = interpret_board_id(bid.board_id, bid.flash_size, bid.bootloader_revision)
    evidence.append(effective.note)

    identity.bootloader_identity = bid
    identity.bootloader_str = bid.usb_product_string
    identity.board_id = effective.manifest_board_id
    evidence.append(
        "Bootloader identity adopted: "
        f"revision {bid.bootloader_revision}, board id {bid.board_id}, "
        f"flash {bid.flash_size}, product string '{bid.usb_product_string}'."
    )

    if effective.is_ambiguous_id:
        evidence.append(
            f"Board id {bid.board_id} is shared by several physical platforms "
            "(FMUv2, FMUv3, Cube F4); the USB product string is required as "
            "corroboration and board id alone can never select an image."
        )

    identity.evidence = evidence
    return identity


#: Outcomes a *cross-checked* exact match may be reported under. An exact match
#: that fails cross-checking is downgraded, never silently accepted.
CROSSCHECK_EXACT_OUTCOMES = (EXACT_MATCH, CONFIRMED_COMPATIBLE)

#: USB ids the catalogue never publishes for a platform. Treat a match against
#: an empty declaration as unverifiable rather than as agreement.
_CATALOG_UNVERIFIABLE = "unverifiable"


def cross_check_exact_match(
    candidate: FirmwareCandidate,
    identity: IdentityEvidence,
) -> CrossCheckResult:
    """Independently verify an exact match against the official manifest.

    An exact match must survive every one of these checks before it is presented
    as installable. Each is reported separately so a failure explains *which*
    fact did not hold rather than only that "compatibility could not be proven".

    ==========================  =========================================
    Check                        Requirement
    ==========================  =========================================
    manifest board id            the candidate declares the board id the
                                bootloader reported
    required bootloader identity bootloader revision, board id, flash size
                                and product string were all genuinely read
    vehicle type                 the image is an ArduCopter build
    firmware type                the image is on an active release channel
    official-catalog             the image comes from the official ArduPilot
                                firmware host
    USB                          the declared USB id matches the port's
                                descriptor VID/PID, or does not contradict it
    ==========================  =========================================
    """
    checks: List[CrossCheckItem] = []

    bid = identity.bootloader_identity
    usable = bool(bid is not None and bid.is_usable_for_resolution)

    checks.append(
        CrossCheckItem(
            name="manifest board id",
            passed=candidate.board_id is not None
            and identity.board_id is not None
            and candidate.board_id == identity.board_id,
            detail=(
                f"manifest board id {candidate.board_id}, bootloader board id "
                f"{identity.board_id}"
            ),
        )
    )

    present = []
    if usable and bid is not None:
        present = [
            name
            for name, value in (
                ("bootloader revision", bid.bootloader_revision),
                ("board id", bid.board_id),
                ("flash size", bid.flash_size),
                ("bootloader product string", bid.usb_product_string),
            )
            if value is not None
        ]
    checks.append(
        CrossCheckItem(
            name="required bootloader identity",
            passed=bool(usable) and len(present) == 4,
            detail=(
                "read: " + ", ".join(present)
                if present
                else "no bootloader identity was read"
            ),
        )
    )

    checks.append(
        CrossCheckItem(
            name="vehicle type",
            passed=(candidate.vehicle or "").strip().upper()
            == (identity.manifest_vehicle or "").strip().upper()
            and bool(identity.manifest_vehicle),
            detail=(
                f"image vehicle {candidate.vehicle or 'unset'}, connected vehicle "
                f"{identity.manifest_vehicle or 'unknown'}"
            ),
        )
    )

    checks.append(
        CrossCheckItem(
            name="firmware type",
            passed=(candidate.release_type or "").strip().upper() in ACTIVE_RELEASE_TYPES,
            detail=f"release type {candidate.release_type or 'unset'}",
        )
    )

    official = False
    if candidate.url:
        try:
            official = (urlparse(candidate.url).hostname or "") == OFFICIAL_FIRMWARE_HOST
        except ValueError:  # pragma: no cover - malformed manifest URL
            official = False
    checks.append(
        CrossCheckItem(
            name="official-catalog",
            passed=official,
            detail=OFFICIAL_FIRMWARE_HOST if official else (candidate.url or "no url"),
        )
    )

    usb_detail: str
    usb_passed: bool
    if identity.usb_id:
        declared = {u.strip().lower() for u in candidate.usb_id if u and u.strip()}
        if not declared:
            usb_passed = True
            usb_detail = (
                f"catalogue declares no USB id; port {identity.usb_id} is "
                f"{_CATALOG_UNVERIFIABLE}"
            )
        else:
            usb_passed = identity.usb_id.strip().lower() in declared
            usb_detail = f"port {identity.usb_id}, catalogue declares {sorted(declared)}"
    else:
        usb_passed = True
        usb_detail = "no port VID/PID was reported"
    checks.append(
        CrossCheckItem(name="USB", passed=usb_passed, detail=usb_detail)
    )

    failed = [c for c in checks if not c.passed]
    return CrossCheckResult(
        candidate=candidate.identity(),
        platform=candidate.platform,
        passed=not failed,
        checks=checks,
    )


def _downgrade_unverified(
    resolution: Resolution,
    result: CrossCheckResult,
    identity: IdentityEvidence,
) -> Resolution:
    """Turn an exact match that failed cross-checking into AMBIGUOUS.

    An image is never offered because a single string matched. If any of the
    independent manifest checks disagrees, the match is withdrawn.
    """
    downgraded = _ambiguous(
        "The catalogue match "
        f"({result.platform}) could not be verified against the official "
        f"manifest: {result.summary}. An image is not offered unless every "
        "check agrees.",
        [resolution.selected] if resolution.selected else [],
        identity,
        resolution.signals_used,
    )
    downgraded.cross_check = result
    return downgraded


# ---------------------------------------------------------------------------
# Resolver
# ---------------------------------------------------------------------------

def _platforms(candidates: Sequence[FirmwareCandidate]) -> List[str]:
    return sorted({c.platform for c in candidates if c.platform})


def _best_candidate(candidates: Sequence[FirmwareCandidate]) -> Optional[FirmwareCandidate]:
    """Deterministically pick one candidate: best channel, then highest version.

    Only ever called once a single physical platform has been established, so
    this chooses *which release of that board*, never *which board*.
    """
    if not candidates:
        return None
    return sorted(
        candidates,
        key=lambda c: (
            _RELEASE_RANK.get(c.release_type, 99),
            -(c.version_major or 0),
            -(c.version_minor or 0),
            -(c.version_patch or 0),
            c.platform,
        ),
    )[0]


def _is_fmuv2_platform(candidate: FirmwareCandidate) -> bool:
    """Mirror QGroundControl's ``platform.contains("fmuv2")`` heuristic.

    QGroundControl excludes these rows when the corrected board id is the
    synthetic FMUv3 id, i.e. when a large-flash v2 board reported usable flash
    geometry. Reproduced here because it is part of the proven selection rule.
    """
    return "fmuv2" in (candidate.platform or "").lower()


def _ambiguous(
    reason: str,
    candidates: Sequence[FirmwareCandidate],
    identity: IdentityEvidence,
    signals: Sequence[str],
) -> Resolution:
    return Resolution(
        outcome=AMBIGUOUS,
        reason=reason,
        candidate_count=len(candidates),
        platform_count=len(_platforms(candidates)),
        platforms=_platforms(candidates),
        signals_used=list(signals),
        evidence=list(identity.evidence),
    )


def resolve(
    candidates: Sequence[FirmwareCandidate],
    identity: IdentityEvidence,
    catalog_available: bool = True,
    catalog_message: str = "",
) -> Resolution:
    """Resolve the compatible firmware candidate, or explain why none is safe.

    Never selects an image on ``board_id`` or USB id alone. When the official
    catalogue could not be retrieved, ``UNAVAILABLE`` is reported instead of
    ``NO_MATCH``, because "no match" would wrongly imply the catalogue was
    actually searched.
    """
    if not identity.connected:
        # A device that is not connected is reported as its own outcome rather
        # than as UNKNOWN, so the UI can distinguish "nothing plugged in" from
        # "something is plugged in but we could not identify it".
        return Resolution(
            outcome=NO_DEVICE,
            reason=(
                "No device is connected, so there is no hardware identity to "
                "resolve firmware compatibility against."
            ),
            evidence=list(identity.evidence),
        )

    if identity.is_sitl:
        return Resolution(
            outcome=UNSUPPORTED,
            reason=(
                "The connected target is a SITL simulation, which has no physical "
                "flash target, so no firmware image applies to it."
            ),
            candidate_count=len(candidates),
            platform_count=len(_platforms(candidates)),
            platforms=_platforms(candidates),
            signals_used=["SITL identification"],
            evidence=list(identity.evidence),
        )

    if not identity.manifest_vehicle:
        return Resolution(
            outcome=UNSUPPORTED,
            reason=(
                "Firmware compatibility is resolved for ArduCopter only. The "
                f"connected target (autopilot {identity.autopilot or 'unknown'}, "
                f"vehicle {identity.vehicle_type or 'unknown'}) is not an ArduCopter."
            ),
            candidate_count=len(candidates),
            evidence=list(identity.evidence),
        )

    if not candidates:
        if not catalog_available:
            return Resolution(
                outcome=UNAVAILABLE,
                reason=(
                    "Compatibility could not be evaluated because the official "
                    f"firmware catalogue is unavailable. {catalog_message}".strip()
                ),
                evidence=list(identity.evidence),
            )
        return Resolution(
            outcome=NO_MATCH,
            reason=(
                f"The official catalogue holds no active-channel "
                f"{identity.manifest_vehicle} .apj image for this target."
            ),
            evidence=list(identity.evidence),
        )

    pool = list(candidates)
    signals: List[str] = []

    # Strongest and only trustworthy selector: the bootloader's USB product
    # string. Available solely in bootloader mode.
    if identity.bootloader_str:
        wanted = identity.bootloader_str.strip().lower()
        matched = [c for c in pool if any(wanted == b.lower() for b in c.bootloader_str)]

        # Apply the proven large-flash exclusion before reporting a no-match, so
        # a filtered row cannot masquerade as an unknown platform.
        if not matched:
            bid = identity.bootloader_identity
            if bid is not None and bid.board_id == BOARD_ID_FMUV2 and bid.flash_size is not None:
                if bid.flash_size > FLASH_SIZE_SMALL and bid.bootloader_revision is not None:
                    large = [
                        c
                        for c in pool
                        if c.board_id == BOARD_ID_FMUV2 and not _is_fmuv2_platform(c)
                    ]
                    matched = [
                        c
                        for c in large
                        if any(wanted == b.lower() for b in c.bootloader_str)
                    ]

        if not matched:
            return Resolution(
                outcome=NO_MATCH,
                reason=(
                    f"No catalogue image declares bootloader product string "
                    f"'{identity.bootloader_str}'."
                ),
                candidate_count=len(pool),
                platform_count=len(_platforms(pool)),
                platforms=_platforms(pool),
                signals_used=["bootloader product string"],
                evidence=list(identity.evidence),
            )
        pool = matched
        signals.append("bootloader product string")

        if len(_platforms(pool)) == 1:
            selected = _best_candidate(pool)
            if selected is None:
                return _ambiguous(
                    "The bootloader product string matched one platform but no "
                    "installable image was found for it.",
                    pool, identity, signals,
                )
            result = cross_check_exact_match(selected, identity)
            signals.append("official-manifest cross-check")
            if not result.passed:
                return _downgrade_unverified(
                    Resolution(
                        outcome=EXACT_MATCH,
                        reason="",
                        selected=selected,
                        signals_used=signals,
                    ),
                    result,
                    identity,
                )
            return Resolution(
                outcome=EXACT_MATCH,
                reason=(
                    f"Bootloader product string '{identity.bootloader_str}' matches a "
                    f"single platform ({selected.platform}), and "
                    f"{result.summary}"
                ),
                selected=selected,
                candidate_count=len(pool),
                platform_count=1,
                platforms=_platforms(pool),
                signals_used=signals,
                evidence=list(identity.evidence),
                cross_check=result,
            )

        # Bootloader string still spans several platforms: corroborate with a
        # board id so two independent signals agree.
        if identity.board_id is not None:
            narrowed = [c for c in pool if c.board_id == identity.board_id]
            if narrowed and len(_platforms(narrowed)) == 1:
                selected = _best_candidate(narrowed)
                if selected is None:
                    return _ambiguous(
                        "Two bootloader signals agreed on one platform but no "
                        "installable image was found for it.",
                        narrowed, identity, signals,
                    )
                result = cross_check_exact_match(selected, identity)
                signals.append(f"board id {identity.board_id}")
                signals.append("official-manifest cross-check")
                if not result.passed:
                    return _downgrade_unverified(
                        Resolution(
                            outcome=CONFIRMED_COMPATIBLE,
                            reason="",
                            selected=selected,
                            signals_used=signals,
                        ),
                        result,
                        identity,
                    )
                return Resolution(
                    outcome=CONFIRMED_COMPATIBLE,
                    reason=(
                        f"Bootloader product string plus board id {identity.board_id} "
                        f"resolve to a single platform ({selected.platform}), and "
                        f"{result.summary}"
                    ),
                    selected=selected,
                    candidate_count=len(narrowed),
                    platform_count=1,
                    platforms=_platforms(narrowed),
                    signals_used=signals,
                    evidence=list(identity.evidence),
                    cross_check=result,
                )
        return _ambiguous(
            "The bootloader product string still matches several physical platforms "
            "and no corroborating board id is available.",
            pool, identity, signals,
        )

    # ------------------------------------------------------------------
    # A validated bootloader identity is present, but its USB product string
    # resolved nothing above. That is a genuine no-match for this board, not a
    # weakness of the evidence: the strongest signal was present and rejected.
    # ------------------------------------------------------------------
    if identity.bootloader_identity is not None and identity.bootloader_identity.is_usable_for_resolution:
        return Resolution(
            outcome=NO_MATCH,
            reason=(
                "The validated bootloader identity "
                f"(board id {identity.bootloader_identity.board_id}, flash "
                f"{identity.bootloader_identity.flash_size}) has no catalogue match."
            ),
            candidate_count=len(pool),
            platform_count=len(_platforms(pool)),
            platforms=_platforms(pool),
            signals_used=[
                f"board id {identity.bootloader_identity.board_id}",
                "bootloader flash size",
            ],
            evidence=list(identity.evidence),
        )

    # No bootloader identity (the normal, non-bootloader case).
    platform_count = len(_platforms(pool))
    if identity.board_id is not None:
        narrowed = [c for c in pool if c.board_id == identity.board_id]
        narrowed_platforms = _platforms(narrowed)
        if narrowed and len(narrowed_platforms) == 1:
            # Reachable only in principle; deliberately still refused because the
            # rule is that board_id alone must never select a firmware image.
            return _ambiguous(
                "Board id alone is not sufficient to select a firmware image, even "
                "when it currently maps to one platform.",
                pool, identity, [],
            )
        return _ambiguous(
            f"Board id {identity.board_id} spans {len(narrowed_platforms)} mutually "
            "incompatible platforms, so no single image can be selected safely.",
            narrowed or pool, identity, [f"board id {identity.board_id}"],
        )

    # No bootloader identity at all: the board is connected and answering, but
    # the only trustworthy identity signal is unobtainable without entering
    # bootloader mode. That is "identity unavailable", which is a different
    # problem from "several incompatible targets" — report it as such so the
    # UI can explain the real blocker instead of implying a choice exists.
    return Resolution(
        outcome=IDENTITY_UNAVAILABLE,
        reason=(
            "The connected board reports no bootloader identity, which is the only "
            "signal that can identify its physical platform safely. Board id "
            f"{identity.board_id if identity.board_id is not None else 'unavailable'} "
            f"spans several platforms on its own, so none of the {len(pool)} "
            "matching images can be selected. A bootloader identity read is "
            "required, and reading one does not modify the board."
        ),
        candidate_count=len(pool),
        platform_count=platform_count,
        platforms=_platforms(pool),
        signals_used=[],
        evidence=list(identity.evidence),
    )
