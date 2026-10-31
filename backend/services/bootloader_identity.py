"""Typed bootloader identity model and validation.

This module defines *what* a bootloader identity is and *when* it may be
trusted. It deliberately contains no transport, no serial access and no
firmware-selection policy; those live in
:mod:`services.bootloader_transport` and
:mod:`services.firmware_compat_service` respectively.

Identity model
--------------
A bootloader identity is the four signals that the ArduPilot bootloader can
report about itself, and which the official manifest can be filtered against:

===========================  ==================================  ===========
Field                        Source                             Required
===========================  ==================================  ===========
``bootloader_revision``      ``INFO_BL_REV``  (PROTO_GET_DEVICE)  yes
``board_id``                 ``INFO_BOARD_ID`` (PROTO_GET_DEVICE)  yes
``flash_size``               ``INFO_FLASH_SIZE`` (PROTO_GET_DEVICE) yes
``usb_product_string``       USB descriptors while in bootloader  yes
===========================  ==================================  ===========

Validity
--------
``VALID``          every field present and in range; safe to resolve against.
``INCOMPLETE``     at least one field missing; carries the list of gaps.
``INVALID``        a field is present but malformed; carries the reasons.
``UNAVAILABLE``    no bootloader was reached at all.

``INCOMPLETE`` and ``INVALID`` are deliberately *not* usable by the resolver.
A partially-read identity must never be treated as partial truth: the board ID
9 collision (FMUv2 / FMUv3 / Cube F4 all report 9) means a half-populated
identity can silently narrow the manifest to the wrong physical platform.
Malformed data is never coerced into a valid value — no clamping, no defaulting,
no silent coercion of ``None`` to ``0``.

No value in this module is ever sourced from real hardware in this phase. The
transport that would produce them is not wired to any device; see
``docs/BOOTLOADER_IDENTITY_IMPLEMENTATION.md``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

# --- validity states --------------------------------------------------------

VALID = "VALID"
INCOMPLETE = "INCOMPLETE"
INVALID = "INVALID"
UNAVAILABLE = "UNAVAILABLE"

USABLE_STATES = frozenset({VALID})

# --- protocol constants (QGroundControl Bootloader.h, PX4/AP_Bootloader) ---

#: PX4 FMU v2 board id as reported by ``INFO_BOARD_ID``.
BOARD_ID_FMUV2 = 9
#: QGroundControl's *synthetic* FMU v3 id; never a real ``INFO_BOARD_ID`` value.
BOARD_ID_FMUV3_SYNTHETIC = 255
#: Minimum/maximum bootloader protocol revision accepted by QGroundControl.
BOOTLOADER_REVISION_MIN = 2
BOOTLOADER_REVISION_MAX = 5
#: Boards at/above this revision report usable flash size despite v2 silicon.
BOOTLOADER_REVISION_V2_CORRECT_FLASH = 5
#: Flash size (bytes) of v2 silicon with the large-flash defect.
FLASH_SIZE_SMALL = 1032192
#: Sanity ceiling for a flash size, in bytes (16 MiB). Purely a typo guard.
FLASH_SIZE_MAX = 16 * 1024 * 1024
#: Upper bound for a USB product string; a typo/descriptors guard.
USB_PRODUCT_STRING_MAX = 256

SOURCE_BOOTLOADER = "BOOTLOADER"
SOURCE_FIXTURE = "TEST_FIXTURE"


@dataclass(frozen=True)
class BootloaderIdentity:
    """A structured, *validated* bootloader identity.

    Every field is optional because a bootloader may fail to report one of
    them. ``None`` always means "not reported", never "assume a default".
    """

    bootloader_revision: Optional[int] = None
    board_id: Optional[int] = None
    flash_size: Optional[int] = None
    usb_product_string: Optional[str] = None
    source: str = SOURCE_BOOTLOADER
    validity: str = UNAVAILABLE
    errors: List[str] = field(default_factory=list)

    @property
    def is_valid(self) -> bool:
        return self.validity in USABLE_STATES

    @property
    def is_usable_for_resolution(self) -> bool:
        """True only when every field required for a safe resolution is present."""
        return self.is_valid and self.is_complete

    @property
    def is_complete(self) -> bool:
        return (
            self.bootloader_revision is not None
            and self.board_id is not None
            and self.flash_size is not None
            and self.usb_product_string is not None
        )

    @property
    def missing_fields(self) -> List[str]:
        gaps = []
        if self.bootloader_revision is None:
            gaps.append("bootloaderRevision")
        if self.board_id is None:
            gaps.append("boardId")
        if self.flash_size is None:
            gaps.append("flashSize")
        if self.usb_product_string is None:
            gaps.append("usbProductString")
        return gaps

    def to_dict(self) -> Dict[str, Any]:
        return {
            "bootloaderRevision": self.bootloader_revision,
            "boardId": self.board_id,
            "flashSize": self.flash_size,
            "usbProductString": self.usb_product_string,
            "source": self.source,
            "validity": self.validity,
            "errors": list(self.errors),
            "isComplete": self.is_complete,
            "missingFields": self.missing_fields,
        }


@dataclass(frozen=True)
class BootloaderIdentityResult:
    """Outcome of one identity read, including why it was rejected."""

    identity: BootloaderIdentity
    evidence: List[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return self.identity.is_valid

    def to_dict(self) -> Dict[str, Any]:
        return {"identity": self.identity.to_dict(), "evidence": list(self.evidence)}


# ---------------------------------------------------------------------------
# Field validation. Each helper returns (value, error). No coercion, ever.
# ---------------------------------------------------------------------------


def _validate_revision(value: Any) -> tuple[Optional[int], Optional[str]]:
    if value is None:
        return None, None
    if isinstance(value, bool) or not isinstance(value, int):
        return None, f"bootloader revision must be an integer, got {type(value).__name__}"
    if value < BOOTLOADER_REVISION_MIN or value > BOOTLOADER_REVISION_MAX:
        return None, (
            f"bootloader revision {value} is outside the supported range "
            f"{BOOTLOADER_REVISION_MIN}..{BOOTLOADER_REVISION_MAX}"
        )
    return value, None


def _validate_board_id(value: Any) -> tuple[Optional[int], Optional[str]]:
    if value is None:
        return None, None
    if isinstance(value, bool) or not isinstance(value, int):
        return None, f"board id must be an integer, got {type(value).__name__}"
    # Board ID 0 is not a real ArduPilot board id; 255 is QGroundControl's
    # synthetic FMUv3 marker and must never arrive from a device.
    if value <= 0:
        return None, f"board id {value} is not a valid board identifier"
    if value == BOARD_ID_FMUV3_SYNTHETIC:
        return None, (
            f"board id {BOARD_ID_FMUV3_SYNTHETIC} is QGroundControl's synthetic FMUv3 "
            "marker and must not be reported by a bootloader"
        )
    if value > 0xFFFF:
        return None, f"board id {value} is out of range"
    return value, None


def _validate_flash_size(value: Any) -> tuple[Optional[int], Optional[str]]:
    if value is None:
        return None, None
    if isinstance(value, bool) or not isinstance(value, int):
        return None, f"flash size must be an integer, got {type(value).__name__}"
    if value <= 0:
        return None, f"flash size {value} must be greater than zero"
    if value > FLASH_SIZE_MAX:
        return None, f"flash size {value} exceeds the {FLASH_SIZE_MAX} byte sanity limit"
    return value, None


def _validate_usb_product_string(value: Any) -> tuple[Optional[str], Optional[str]]:
    if value is None:
        return None, None
    if not isinstance(value, str):
        return None, f"usb product string must be a string, got {type(value).__name__}"
    stripped = value.strip()
    if not stripped:
        return None, "usb product string is empty"
    if len(stripped) > USB_PRODUCT_STRING_MAX:
        return None, (
            f"usb product string is {len(stripped)} characters, longer than the "
            f"{USB_PRODUCT_STRING_MAX} character limit"
        )
    return stripped, None


def build_identity(
    *,
    bootloader_revision: Any = None,
    board_id: Any = None,
    flash_size: Any = None,
    usb_product_string: Any = None,
    source: str = SOURCE_BOOTLOADER,
) -> BootloaderIdentityResult:
    """Validate raw reported values into a :class:`BootloaderIdentity`.

    Precedence is explicit: malformed values produce ``INVALID`` and are never
    repaired. Only when every present field is well-formed do missing fields
    downgrade the result to ``INCOMPLETE``.
    """
    evidence: List[str] = []

    revision, rev_err = _validate_revision(bootloader_revision)
    bid, bid_err = _validate_board_id(board_id)
    flash, flash_err = _validate_flash_size(flash_size)
    usb, usb_err = _validate_usb_product_string(usb_product_string)

    errors = [e for e in (rev_err, bid_err, flash_err, usb_err) if e]

    identity = BootloaderIdentity(
        bootloader_revision=revision,
        board_id=bid,
        flash_size=flash,
        usb_product_string=usb,
        source=source,
        validity=VALID,
        errors=errors,
    )

    for label, value, err in (
        ("bootloader revision", bootloader_revision, rev_err),
        ("board id", board_id, bid_err),
        ("flash size", flash_size, flash_err),
        ("USB product string", usb_product_string, usb_err),
    ):
        if err:
            evidence.append(f"Rejected {label}: {err}")
        elif value is not None:
            evidence.append(f"Accepted {label}: {value}")

    if errors:
        evidence.append(
            "Identity rejected as INVALID: malformed values are never coerced into a "
            "valid identity."
        )
        identity = BootloaderIdentity(
            bootloader_revision=revision,
            board_id=bid,
            flash_size=flash,
            usb_product_string=usb,
            source=source,
            validity=INVALID,
            errors=errors,
        )
        return BootloaderIdentityResult(identity=identity, evidence=evidence)

    missing = identity.missing_fields
    if missing:
        evidence.append(
            "Identity is INCOMPLETE; unresolved fields: " + ", ".join(missing)
            + ". An incomplete identity is never used to select firmware."
        )
        identity = BootloaderIdentity(
            bootloader_revision=revision,
            board_id=bid,
            flash_size=flash,
            usb_product_string=usb,
            source=source,
            validity=INCOMPLETE,
            errors=errors,
        )
        return BootloaderIdentityResult(identity=identity, evidence=evidence)

    evidence.append(
        "Bootloader identity is VALID and complete; it may be used for firmware "
        "resolution."
    )
    return BootloaderIdentityResult(identity=identity, evidence=evidence)


def unavailable_identity(reason: str, source: str = SOURCE_BOOTLOADER) -> BootloaderIdentityResult:
    """Identity for 'no bootloader was reached'."""
    return BootloaderIdentityResult(
        identity=BootloaderIdentity(
            source=source,
            validity=UNAVAILABLE,
            errors=[reason] if reason else [],
        ),
        evidence=[reason] if reason else ["No bootloader identity is available."],
    )


# ---------------------------------------------------------------------------
# Board ID 9 flash-size interpretation (QGroundControl Bootloader.cc)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class EffectiveBoard:
    """Board interpretation after applying the v2 flash correction."""

    manifest_board_id: Optional[int]
    is_large_flash: Optional[bool]
    is_ambiguous_id: bool
    note: str


def interpret_board_id(
    board_id: Optional[int],
    flash_size: Optional[int],
    bootloader_revision: Optional[int],
) -> EffectiveBoard:
    """Map a reported board id onto the manifest id, mirroring QGroundControl.

    QGroundControl synthesises id 255 when a v2 board reports a usable
    large flash, then folds 255 back to 9 for the manifest lookup and excludes
    ``fmuv2``-platform rows. The ``fmuv2`` exclusion is applied by the resolver,
    because it needs catalogue knowledge; this function only reports what the
    hardware claimed.
    """
    if board_id is None:
        return EffectiveBoard(
            manifest_board_id=None,
            is_large_flash=None,
            is_ambiguous_id=False,
            note="No board id was reported, so no board interpretation is possible.",
        )

    if board_id == BOARD_ID_FMUV2:
        if flash_size is None:
            return EffectiveBoard(
                manifest_board_id=BOARD_ID_FMUV2,
                is_large_flash=None,
                is_ambiguous_id=True,
                note=(
                    "Board id 9 was reported without a flash size. Board id 9 is "
                    "shared by FMUv2, FMUv3 and Cube F4, so without flash geometry "
                    "the physical platform cannot be determined."
                ),
            )
        if bootloader_revision is not None and bootloader_revision >= BOOTLOADER_REVISION_V2_CORRECT_FLASH:
            if flash_size > FLASH_SIZE_SMALL:
                return EffectiveBoard(
                    manifest_board_id=BOARD_ID_FMUV2,
                    is_large_flash=True,
                    is_ambiguous_id=True,
                    note=(
                        f"Board id 9 reported {flash_size} bytes of flash with "
                        f"bootloader revision {bootloader_revision} >= "
                        f"{BOOTLOADER_REVISION_V2_CORRECT_FLASH}; treated as large-flash "
                        "hardware. Board id 9 still spans several platforms and "
                        "requires the USB product string to resolve."
                    ),
                )
        return EffectiveBoard(
            manifest_board_id=BOARD_ID_FMUV2,
            is_large_flash=False,
            is_ambiguous_id=True,
            note=(
                f"Board id 9 reported {flash_size} bytes of flash, at or below the "
                f"{FLASH_SIZE_SMALL} byte small-flash threshold; treated as small-flash "
                "hardware. Board id 9 still spans several platforms and requires the "
                "USB product string to resolve."
            ),
        )

    return EffectiveBoard(
        manifest_board_id=board_id,
        is_large_flash=None,
        is_ambiguous_id=False,
        note=f"Board id {board_id} is used directly for manifest lookup.",
    )
