"""Firmware workflow orchestration: detect → identify → resolve → install.

This module is the *authority* behind the Firmware page. It runs the real
pipeline against whatever vehicle is actually connected:

1. **Detect** through the existing connection manager (no second connection).
2. **Identify** the current firmware via ``AUTOPILOT_VERSION``.
3. **Resolve** compatibility against the official manifest.
4. **List** the real available releases for a resolved platform.
5. **Confirm** explicitly — recorded server-side for one exact candidate.
6. **Choose the installer** *before* any download, so a real board is refused
   without transferring an artifact.
7. **Download** and transfer-verify the artifact.
8. **Install** through a :class:`~services.firmware_install_service.FirmwareInstaller`.
9. **Verify** through the installer's own independent ``verify()`` step.
10. **Report** the verified result.

Safety
------
Real hardware cannot be flashed. :func:`run_install` selects
:class:`~services.firmware_install_service.RealFirmwareInstaller` when a physical
board is connected and refuses *before* downloading anything. Only the
TEST/SIMULATION installer can execute, and it holds no device handle.

Release selection
-----------------
A client may choose any release the resolver proved safe for this hardware —
the resolved platform and vehicle, not merely the one the resolver ranked
first. That is re-validated server-side against the live manifest, so a client
can never nominate an image for different hardware or an unofficial URL. A
development channel is never chosen silently: the conservative default stays on
the resolved release.

Confirmation
------------
:meth:`confirmation` records the confirmation in the backend
(:data:`~services.firmware_install_service.CONFIRMATION`) against the exact
candidate id. :func:`download` and :func:`run_install` refuse to proceed without
a matching record, so a client flag alone cannot start an installation.

Verification honesty
--------------------
``COMPLETED`` is unreachable unless
:meth:`~services.firmware_install_service.FirmwareInstaller.verify` independently
re-reads the actual installed version and it matches the target.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from core import config
from services import (
    firmware_catalog_service,
    firmware_errors as errors,
    firmware_compat_service,
    firmware_download_service,
    firmware_install_service as install_svc,
    firmware_logging as fwlog,
)
from services.firmware_compat_service import IdentityEvidence, Resolution
from services.firmware_download_service import DOWNLOAD_VERIFICATION_FAILED
from services.firmware_install_service import (
    BLOCKED,
    CANCELLED,
    COMPLETED,
    CONFIRMATION_REQUIRED,
    DETECTING,
    DISCONNECTED,
    DOWNLOADING,
    DOWNLOAD_VERIFIED,
    FAILED,
    IDLE,
    IDENTIFYING,
    INSTALLING,
    PREPARING,
    READY,
    RESOLVING,
    VERIFYING,
    CONFIRMATION,
    FirmwareInstaller,
    RealFirmwareInstaller,
    TestFirmwareInstaller,
    WORKFLOW,
)

#: Release channels offered in the UI, in the conservative order used by QGC.
RELEASE_ORDER = ("OFFICIAL", "BETA", "DEV")

#: The artifact could not be trusted. Installation must not proceed. Distinct
#: from a generic failure so a transfer that never completed can be told apart
#: from one that completed and then failed verification.

RELEASE_LABELS = {
    "OFFICIAL": "Stable",
    "BETA": "Beta",
    "DEV": "Development",
}

#: Channels that may be installed only after an explicit user choice.
NON_DEFAULT_CHANNELS = frozenset({"BETA", "DEV"})

_MAX_REPORTED_RELEASES = 60


# ---------------------------------------------------------------------------
# Phase 1-4: detect, identify, resolve
# ---------------------------------------------------------------------------


def _sitl_evidence() -> bool:
    """Positive SITL identification (never assumes a physical board is a rig)."""
    return install_svc.environment() == "SITL"


def detect(include_identity: bool = False) -> Dict[str, Any]:
    """Detect a device through the existing connection architecture.

    Reports only authoritative values: connection state comes from the existing
    connection manager, and the hardware identity comes from the same single
    MAVLink link via ``AUTOPILOT_VERSION``. No second serial port or MAVLink
    link is ever opened.

    Every hardware field is reported as ``None`` when the vehicle did not send
    it, so an absent value can never be mistaken for a zero or a guess. Note
    ``boardVersion`` is ArduPilot's ``AUTOPILOT_VERSION.board_version``, which is
    **not** a manifest ``board_id``; ``boardId`` is therefore reported as
    ``None`` here and only ever populated from a real bootloader reading.

    ``include_identity`` costs a MAVLink round trip, so it is off by default:
    :func:`status` is polled, and polling must not spam the vehicle with
    ``AUTOPILOT_VERSION`` requests. One-off reads that need the full hardware
    identity pass ``True``.
    """
    from core.state import get_vehicle_status, vehicle_state
    from mavlink.connection_manager import manager

    status = get_vehicle_status()
    connected = bool(status.get("connected"))
    connection_state = status.get("connectionState")

    detection: Dict[str, Any] = {
        "success": connected,
        "state": "READY" if connected else "NO_DEVICE",
        "connected": connected,
        "connectionState": connection_state,
        "connectionType": manager.connection_type or None,
        "vehicleType": vehicle_state.get("vehicleType"),
        "autopilot": vehicle_state.get("autopilot"),
        # Phase 1 hardware identity. All authoritative, all read-only.
        "systemId": vehicle_state.get("systemId"),
        "componentId": vehicle_state.get("componentId"),
        "firmwareVersion": None,
        "firmwareRelease": None,
        "boardType": None,
        "boardRev": None,
        "boardVersion": None,
        "boardId": None,
        "vendorId": None,
        "productId": None,
        "usbId": None,
        "serialIdentity": None,
        # USB descriptor identity, read from the OS. Present even when MAVLink is
        # silent, because the descriptor is the only identity available then.
        "usbProduct": None,
        "usbSerialNumber": None,
        "usbManufacturer": None,
        # Bootloader identity. Populated only from an observation that genuinely
        # proved a bootloader transport; never inferred, never carried over from
        # a previous device. All null unless such an observation exists.
        "bootloaderIdentityAvailable": False,
        "bootloaderRevision": None,
        "bootloaderBoardId": None,
        "flashSize": None,
        "bootloaderUsbProduct": None,
        "disconnectReason": status.get("disconnectReason"),
        "message": (
            "Vehicle connected." if connected else "No vehicle is connected."
        ),
    }

    # USB descriptor identity is read from the OS on every detection: it is cheap,
    # opens no port and writes nothing. Bootloader fields come from the last
    # observation the validation service made -- detection never triggers a
    # bootloader read itself, because that would send protocol traffic to a board
    # that may simply be answering MAVLink.
    detection.update(_descriptor_identity())
    detection.update(_observed_bootloader_identity())

    if not include_identity:
        return detection

    # AUTOPILOT_VERSION carries the identity fields, but only when a reply
    # actually arrives. A timeout must leave the identity empty rather than
    # inventing a previous vehicle's values.
    try:
        from services.setup_service import request_firmware_info

        info = request_firmware_info()
    except Exception as exc:  # noqa: BLE001 - detection must never raise
        info = {"success": False, "message": f"Firmware identity unavailable: {exc}"}

    if info.get("success"):
        # The identity reply is proof a vehicle is really there, so it also
        # settles connectivity: this keeps detection and resolution from ever
        # disagreeing about whether a device exists.
        if not connected:
            connected = True
            detection["success"] = True
            detection["state"] = "READY"
            detection["connected"] = True
        # AUTOPILOT_VERSION carries the heartbeat identity too, so it is the
        # authority for vehicle type and autopilot rather than a cached value.
        detection["vehicleType"] = info.get("vehicleType") or detection["vehicleType"]
        detection["autopilot"] = info.get("autopilot") or detection["autopilot"]
        detection["systemId"] = info.get("systemId") or detection.get("systemId")
        detection["componentId"] = info.get("componentId") or detection.get("componentId")
        vendor = info.get("vendorId")
        product = info.get("productId")
        detection.update(
            {
                "firmwareVersion": info.get("version"),
                "firmwareRelease": info.get("release"),
                "boardType": info.get("boardType"),
                "boardRev": info.get("boardRev"),
                "boardVersion": info.get("boardVersion"),
                # Not a manifest board id; never inferred from board_version.
                "boardId": None,
                "vendorId": vendor,
                "productId": product,
                "usbId": _usb_id_string(vendor, product),
                "identityMessage": None,
            }
        )
    else:
        detection["identityMessage"] = info.get(
            "message", "The vehicle did not report its firmware identity."
        )

    # A link that comes back after having dropped is a reconnect, not a first
    # connect, and is reported separately so an interrupted session is visible.
    if detection.get("connected") and _was_connected():
        fwlog.log_event(
            fwlog.RECONNECT_OBSERVED,
            fwlog.DISCONNECT,
            outcome="RECONNECTED",
            connectionType=detection.get("connectionType"),
            vehicleType=detection.get("vehicleType"),
            usbId=detection.get("usbId"),
        )
    _set_was_connected(bool(detection.get("connected")))

    # Bootloader identity is logged on its own event so an operator can tell an
    # exact resolution apart from one that merely lacked identity evidence.
    if detection.get("bootloaderIdentityAvailable"):
        fwlog.log_event(
            fwlog.IDENTITY_OBSERVED,
            fwlog.IDENTITY,
            outcome="AVAILABLE",
            bootloaderProduct=detection.get("bootloaderUsbProduct"),
            bootloaderRevision=detection.get("bootloaderRevision"),
            bootloaderBoardId=detection.get("bootloaderBoardId"),
            flashSize=detection.get("flashSize"),
            usbSerialNumber=detection.get("usbSerialNumber"),
        )

    detection["fields"] = _field_availability(detection)

    fwlog.log_event(
        fwlog.DETECTION_COMPLETED,
        fwlog.DETECTION,
        outcome="CONNECTED" if detection.get("connected") else "NO_DEVICE",
        connected=detection.get("connected"),
        connectionType=detection.get("connectionType"),
        vehicleType=detection.get("vehicleType"),
        autopilot=detection.get("autopilot"),
        firmwareVersion=detection.get("firmwareVersion"),
        firmwareRelease=detection.get("firmwareRelease"),
        boardVersion=detection.get("boardVersion"),
        usbId=detection.get("usbId"),
        usbProduct=detection.get("usbProduct"),
        usbSerialNumber=detection.get("usbSerialNumber"),
        bootloaderIdentityAvailable=detection.get("bootloaderIdentityAvailable"),
        bootloaderRevision=detection.get("bootloaderRevision"),
        bootloaderBoardId=detection.get("bootloaderBoardId"),
        flashSize=detection.get("flashSize"),
        bootloaderUsbProduct=detection.get("bootloaderUsbProduct"),
    )
    return detection



# Tracks whether the last detection saw a vehicle, so the next one can tell a
# reconnect from a first connect. Detection is the only writer. ``None`` means
# "not observed yet", which is deliberately different from ``False``: a first
# connect is not a reconnect, but a link that dropped and came back is.
_LAST_CONNECTED: Optional[bool] = None


def _was_connected() -> bool:
    """True only when a connected link was previously seen and has since dropped."""
    return _LAST_CONNECTED is False


def _set_was_connected(value: bool) -> None:
    global _LAST_CONNECTED
    _LAST_CONNECTED = value


#: Detection fields a caller may need, and why each can be missing. A field that
#: is simply ``None`` tells an operator nothing about whether it is unavailable,
#: not-yet-read, or evidence of an unsupported board; these reasons do.
_IDENTITY_FIELDS = (
    "firmwareVersion",
    "firmwareRelease",
    "boardType",
    "boardRev",
    "boardVersion",
    "usbProduct",
    "usbSerialNumber",
    "usbManufacturer",
    "bootloaderRevision",
    "bootloaderBoardId",
    "flashSize",
    "bootloaderUsbProduct",
)

_BOOTLOADER_FIELDS = (
    "bootloaderRevision",
    "bootloaderBoardId",
    "flashSize",
    "bootloaderUsbProduct",
)

_USB_FIELDS = ("usbProduct", "usbSerialNumber", "usbManufacturer")


def _field_availability(detection: Dict[str, Any]) -> Dict[str, Any]:
    """Report, per identity field, whether it is available and why it is not.

    Every entry is always present. A field that has a value is simply available;
    a field without one carries the specific reason, so the UI never has to
    invent "unknown" and never implies the board reported something odd.
    """
    connected = bool(detection.get("connected"))
    have_bootloader = bool(detection.get("bootloaderIdentityAvailable"))

    availability: Dict[str, Any] = {}
    for name in _IDENTITY_FIELDS:
        if detection.get(name) is not None:
            availability[name] = {"available": True, "reason": None}
            continue

        if name in _BOOTLOADER_FIELDS:
            if not connected:
                reason = "No vehicle is connected."
            elif not have_bootloader:
                reason = (
                    "No bootloader identity has been read. This board is "
                    "answering MAVLink in normal mode, so it reports no "
                    "bootloader revision, board id, flash size or bootloader "
                    "product string."
                )
            else:
                reason = (
                    "The last bootloader observation did not include this "
                    "field, so it cannot be reported."
                )
        elif name in _USB_FIELDS:
            reason = (
                "The operating system reported no USB descriptor for the "
                "attached board."
                if connected
                else "No vehicle is connected."
            )
        else:
            reason = (
                "The vehicle did not answer AUTOPILOT_VERSION, so it reported "
                "no identity."
                if connected
                else "No vehicle is connected."
            )
        availability[name] = {"available": False, "reason": reason}
    return availability


def _descriptor_identity() -> Dict[str, Any]:
    """USB descriptor identity of the attached board, read from the OS.

    Read-only and cheap: ``enumerate_usb_ports`` only asks the operating system
    what USB devices exist. Every field is ``None`` when nothing is attached, so
    a partial descriptor can never look like a complete one.
    """
    out: Dict[str, Any] = {
        "usbProduct": None,
        "usbSerialNumber": None,
        "usbManufacturer": None,
    }
    try:
        from services.serial_service import enumerate_usb_ports

        ports = enumerate_usb_ports()
    except Exception:  # noqa: BLE001 - detection must never raise
        return out
    if not ports:
        return out
    port = ports[0]
    out["usbProduct"] = getattr(port, "product", None) or None
    out["usbSerialNumber"] = getattr(port, "serial_number", None) or None
    out["usbManufacturer"] = getattr(port, "manufacturer", None) or None
    return out


def _observed_bootloader_identity() -> Dict[str, Any]:
    """The last genuine bootloader observation, or explicit nulls.

    Reads the validation machine's stored observation rather than performing a
    new read, so detection stays free of bootloader protocol traffic. A stale or
    absent observation simply yields nulls; nothing is inferred from the
    normal-mode USB product string, and ``Pixhawk1`` is never read as
    ``Pixhawk1-BL``.
    """
    out: Dict[str, Any] = {
        "bootloaderIdentityAvailable": False,
        "bootloaderRevision": None,
        "bootloaderBoardId": None,
        "flashSize": None,
        "bootloaderUsbProduct": None,
    }
    try:
        from services.bootloader_validation_service import SERVICE as validation

        identity = validation.machine.identity
    except Exception:  # noqa: BLE001 - detection must never raise
        return out
    if not identity:
        return out
    if not identity.get("canResolvePlatform"):
        return out
    out.update(
        {
            "bootloaderIdentityAvailable": True,
            "bootloaderRevision": identity.get("bootloaderRevision"),
            "bootloaderBoardId": identity.get("boardId"),
            "flashSize": identity.get("flashSize"),
            "bootloaderUsbProduct": identity.get("bootloaderUsbProductString"),
        }
    )
    return out

def _usb_id_string(vendor: Any, product: Any) -> Optional[str]:
    """Render a USB VID:PID pair the way the official manifest writes it.

    Returns ``None`` when either half is missing, so a partial USB identity can
    never look like a complete one.
    """
    if vendor is None or product is None:
        return None
    try:
        return f"0x{int(vendor):04x}/0x{int(product):04x}"
    except (TypeError, ValueError):
        return None


def connection_fingerprint(detection: Optional[Dict[str, Any]] = None) -> Optional[str]:
    """A cheap fingerprint of *which* vehicle is connected.

    Built purely from state the backend already holds, so it is safe to evaluate
    on a poll: no MAVLink round trip. This is what catches the common real
    hazard — unplugging the board, or a different vehicle taking its place
    between confirmation and installation.

    Returns ``None`` when nothing is connected, which by itself makes any
    previous confirmation stale.
    """
    detection = detect() if detection is None else detection
    if not detection.get("connected"):
        return None
    parts = [
        f"system={detection.get('systemId')}",
        f"component={detection.get('componentId')}",
        f"transport={detection.get('connectionType')}",
        f"vehicle={detection.get('vehicleType')}",
        f"autopilot={detection.get('autopilot')}",
    ]
    return "|".join(parts)


def hardware_fingerprint(detection: Optional[Dict[str, Any]] = None) -> Optional[str]:
    """A fingerprint of the *physical board* currently connected.

    Stronger than :func:`connection_fingerprint` because it adds the fields only
    ``AUTOPILOT_VERSION`` reports — USB VID:PID, board type/revision and
    firmware version. That costs one MAVLink round trip, so it is used at the
    decision points (confirmation, download, pre-install validation) rather than
    on the poll path.

    Also deliberately *not* derived from a live OS enumeration of the USB serial:
    this fingerprint is built only from MAVLink-reported evidence so it stays a
    pure function of the vehicle link and never varies with what else happens to
    be plugged into the host. The USB serial is reported separately by
    :func:`detect` and by the bootloader-identity endpoint as display evidence.

    Derived from the very same :func:`build_identity` evidence the resolver
    uses, so detection and compatibility resolution can never disagree about
    which board is attached.

    Returns ``None`` when nothing is connected, which by itself makes any
    previous confirmation stale.
    """
    identity = build_identity()
    if identity is None or not identity.connected:
        return None
    return "|".join(
        [
            f"vehicle={identity.vehicle_type}",
            f"autopilot={identity.autopilot}",
            f"usb={identity.usb_id}",
            f"boardType={identity.board_type}",
            f"boardRev={identity.board_rev}",
            f"firmware={identity.firmware_version}",
            f"connectionType={identity.connection_type}",
        ]
    )


def identify() -> Dict[str, Any]:
    """Read the current firmware identity from the vehicle.

    Uses the established ``request_firmware_info`` MAVLink pipeline. Values are
    never hardcoded.
    """
    from services.setup_service import request_firmware_info

    info = request_firmware_info()
    if not info.get("success"):
        return {
            "success": False,
            "state": FAILED if info.get("connected") else "NO_DEVICE",
            "message": info.get("message", "Vehicle identity is unavailable."),
            "connected": bool(info.get("connected")),
            "info": info,
        }
    return {
        "success": True,
        "state": IDENTIFYING,
        "connected": True,
        "info": info,
        "message": (
            f"{info.get('autopilotLabel') or info.get('autopilot') or 'Unknown'} "
            f"{info.get('version') or 'unknown version'} "
            f"({info.get('release') or 'unknown release'})"
        ),
    }


def build_identity() -> Optional[IdentityEvidence]:
    """Build the resolver identity from the live vehicle, or None if absent.

    Any bootloader identity that was read earlier in this validation workflow is
    folded in here, rather than by each caller. That matters for more than
    tidiness: folding it in the caller would let ``/firmware/workflow`` and
    ``/firmware/catalog`` disagree about the same board, with one of them
    selecting nothing the other happily resolves.

    The fold re-validates what is stored, and a board that was never read simply
    keeps the normal-mode rules: no observation means no inference.
    """
    from services.setup_service import request_firmware_info

    info = request_firmware_info()
    if not info.get("success"):
        return None
    identity = firmware_compat_service.identity_from_firmware_info(
        info, is_sitl=_sitl_evidence()
    )
    try:
        from services.bootloader_validation_service import apply_stored_identity

        return apply_stored_identity(identity)
    except Exception:  # noqa: BLE001 - resolution must never raise
        return identity


def resolve() -> Dict[str, Any]:
    """Resolve compatibility against the official manifest.

    Never selects on ``board_id`` alone. Returns the resolver's honest outcome.
    """
    identity = build_identity()
    if identity is None:
        # No identity means no device answered. Reported as its own outcome so
        # the UI can tell "nothing plugged in" from "plugged in but
        # unidentifiable", rather than hiding both behind UNKNOWN.
        return {
            "success": False,
            "state": "NO_DEVICE",
            "outcome": firmware_compat_service.NO_DEVICE,
            "message": (
                "No vehicle is connected, so there is no hardware identity to "
                "resolve firmware compatibility against."
            ),
            "resolution": None,
            "catalog": None,
        }

    catalog = firmware_catalog_service.get_catalog(identity.manifest_vehicle)
    resolution = firmware_compat_service.resolve(
        catalog.candidates,
        identity,
        catalog_available=catalog.ok,
        catalog_message=catalog.message,
    )
    fwlog.log_resolution(
        resolution,
        stage="workflow",
        manifestVehicle=identity.manifest_vehicle,
        candidateCount=len(catalog.candidates),
        catalogAvailable=catalog.ok,
    )
    return {
        "success": True,
        "state": READY if not resolution.can_confirm else CONFIRMATION_REQUIRED,
        "outcome": resolution.outcome,
        "message": resolution.reason,
        "resolution": resolution,
        "catalog": catalog,
        "identity": identity,
    }


def _resolved(result: Dict[str, Any]) -> Optional[Resolution]:
    resolution = result.get("resolution")
    return resolution if resolution is not None and resolution.can_confirm else None


# ---------------------------------------------------------------------------
# Phase 5: version selection
# ---------------------------------------------------------------------------


def available_releases(
    resolution: Optional[Resolution],
    candidates: Optional[List[Any]] = None,
) -> List[Dict[str, Any]]:
    """Real releases for the resolved platform, straight from the manifest.

    ``candidates`` is the live candidate list from the catalogue; the resolved
    platform comes from ``resolution``. Every field returned here is read from a
    real manifest entry, so the version ordering below uses the parsed numeric
    version fields the catalogue already provides.
    """
    if resolution is None or resolution.selected is None:
        return []
    if not candidates:
        return []

    platform = resolution.selected.platform
    vehicle = resolution.selected.vehicle
    # A candidate is only pre-chosen when the hardware was identified exactly.
    # A merely narrowed platform still lists its candidates -- they are
    # genuinely compatible with this hardware and nothing else -- but nothing is
    # selected for the operator, so a row can never appear "chosen" on the
    # strength of an inference rather than a decision.
    selected_id = (
        resolution.selected.identity() if resolution.auto_selected else None
    )
    # Reported so the UI can mark the row the board is actually running instead
    # of guessing from a version string.
    current_version = _current_version()

    entries: List[Dict[str, Any]] = []
    for candidate in candidates:
        if candidate.platform != platform or candidate.vehicle != vehicle:
            continue
        entries.append(
            {
                "candidateId": candidate.identity(),
                "version": candidate.version,
                "versionStr": candidate.version_str,
                "versionMajor": candidate.version_major,
                "versionMinor": candidate.version_minor,
                "versionPatch": candidate.version_patch,
                "releaseType": candidate.release_type,
                "releaseLabel": RELEASE_LABELS.get(
                    candidate.release_type, candidate.release_type
                ),
                "platform": candidate.platform,
                "vehicle": candidate.vehicle,
                "boardId": candidate.board_id,
                "url": candidate.url,
                "format": candidate.image_format,
                "imageSize": candidate.image_size,
                "bootloaderStr": list(candidate.bootloader_str),
                "usbId": list(candidate.usb_id),
                "manufacturer": candidate.manufacturer,
                "brandName": candidate.brand_name,
                "gitSha": candidate.git_sha,
                "latest": candidate.latest,
                "isDefault": candidate.identity() == selected_id,
                "isSelected": candidate.identity() == selected_id,
                # True only when the board reports this exact version, so the
                # marker can never be inferred from the manifest alone. The
                # board's version and the manifest's label differ by a leading
                # "V", so both sides are normalised before comparing.
                "isCurrent": _same_version(current_version, candidate.version_str),
                "compatibility": _release_compatibility(candidate, resolution),
            }
        )

    entries.sort(
        key=lambda e: (
            RELEASE_ORDER.index(e["releaseType"])
            if e["releaseType"] in RELEASE_ORDER
            else 99,
            -(e["versionMajor"] or 0),
            -(e["versionMinor"] or 0),
            -(e["versionPatch"] or 0),
        )
    )
    return entries[:_MAX_REPORTED_RELEASES]


def _same_version(reported: Optional[str], candidate: Optional[str]) -> bool:
    """Whether the board runs exactly this candidate's firmware version.

    ArduPilot reports a bare dotted version over MAVLink while the official
    manifest labels the same release with a leading ``V``, so the prefix and
    case are normalised before comparing. No version is named here: these
    strings come from the vehicle and the manifest, never from this module.
    """
    def normalise(value: Optional[str]) -> str:
        return str(value or "").strip().lstrip("vV").strip()

    left, right = normalise(reported), normalise(candidate)
    return bool(left) and left == right


def _release_compatibility(candidate: Any, resolution: Resolution) -> Dict[str, Any]:
    """State, with evidence, why this release may be offered for this board.

    ``available_releases`` only returns candidates whose platform and vehicle
    equal the resolved selection, so a returned release is compatible by
    construction -- but "by construction" is not something to show an operator.
    The resolver's own reason and signals are reported verbatim, and anything
    weaker than an exact match is called ``UNKNOWN`` rather than ``COMPATIBLE``.
    """
    from services import firmware_compat_service as compat

    if resolution.outcome != compat.EXACT_MATCH:
        return {
            "status": "UNKNOWN",
            "reason": (
                "This release is listed for the target the resolver reported, "
                f"but the resolution outcome was {resolution.outcome}, so "
                "compatibility was not established."
            ),
            "evidence": list(resolution.signals_used),
        }

    return {
        "status": "COMPATIBLE",
        "reason": resolution.reason,
        "evidence": list(resolution.signals_used),
    }


def default_release_id(releases: List[Dict[str, Any]]) -> Optional[str]:
    """Conservative default: the release the resolver itself ranked first.

    The resolver orders official > beta > dev deterministically, so a development
    or beta image is never silently selected.
    """
    for entry in releases:
        if entry.get("isDefault"):
            return str(entry["candidateId"])
    return str(releases[0]["candidateId"]) if releases else None


def _select_release(
    candidates: List[Any], candidate_id: Optional[str]
) -> Optional[Any]:
    """Re-validate a client-supplied candidate against the live catalogue.

    Only a candidate present in the real catalogue is returned, so a client
    cannot inject an arbitrary URL or an image for different hardware.
    """
    if not candidate_id:
        return None
    for candidate in candidates:
        if candidate.identity() == candidate_id:
            return candidate
    return None


def _catalog_generation(catalog: Any) -> Optional[str]:
    """The catalogue generation a candidate was validated against.

    The official manifest's ETag changes whenever upstream publishes a new
    firmware manifest, so binding a confirmation to it means a confirmation can
    never authorise an installation from a catalogue the user did not see.
    """
    etag = getattr(catalog, "etag", None)
    return str(etag) if etag else None


def _current_version() -> Optional[str]:
    """The firmware version the connected board is running right now."""
    identified = identify()
    if not identified.get("success"):
        return None
    return identified["info"].get("version")


def _target(
    candidate_id: Optional[str] = None,
    *,
    refresh: bool = False,
) -> Dict[str, Any]:
    """Resolve the installation target and validate it against the catalogue.

    Returns a dict with the resolution, the candidate list and the selected
    candidate, or an ``error`` explaining why no safe target exists.
    """
    result = resolve()
    resolution = _resolved(result)
    if resolution is None or resolution.selected is None:
        return {
            "ok": False,
            "result": result,
            "error": (
                "Compatibility could not be determined safely, so no firmware "
                "target is available."
            ),
        }

    candidates = list(getattr(result.get("catalog"), "candidates", []) or [])
    selected = resolution.selected

    if not candidate_id:
        if not resolution.auto_selected:
            # The platform is resolved, but nothing has been chosen for the
            # operator. Installing the resolver's guess would mean writing
            # firmware that no human picked, on hardware identified by
            # inference rather than by an exact match.
            return {
                "ok": False,
                "result": result,
                "error": (
                    "Compatibility is narrowed but not exact, so no firmware "
                    "release has been chosen. Choose a release explicitly to "
                    "continue."
                ),
            }
        return {
            "ok": True,
            "result": result,
            "resolution": resolution,
            "candidates": candidates,
            "selected": selected,
            "catalog": result.get("catalog"),
            "identity": result.get("identity"),
        }

    chosen = _select_release(candidates, candidate_id)
    if chosen is None:
        return {
            "ok": False,
            "result": result,
            "error": (
                "The requested release is not present in the official catalogue "
                "for this hardware."
            ),
        }
    if chosen.platform != selected.platform or chosen.vehicle != selected.vehicle:
        return {
            "ok": False,
            "result": result,
            "error": (
                "The requested release targets different hardware than the "
                "resolved platform."
            ),
        }
    return {
        "ok": True,
        "result": result,
        "resolution": resolution,
        "candidates": candidates,
        "selected": chosen,
        "catalog": result.get("catalog"),
        "identity": result.get("identity"),
    }


def version_list(refresh: bool = False) -> Dict[str, Any]:
    """Available firmware versions for the resolved target."""
    result = resolve()
    resolution = _resolved(result)
    releases: List[Dict[str, Any]] = []
    if resolution is not None and resolution.selected is not None:
        candidates = list(getattr(result.get("catalog"), "candidates", []) or [])
        if refresh:
            # Re-read the manifest so the list is genuinely current.
            refetched = firmware_catalog_service.get_catalog(
                resolution.selected.vehicle, force_refresh=True
            )
            if refetched.ok:
                candidates = list(refetched.candidates)
        releases = available_releases(resolution, candidates)

    confirmation = current_confirmation()
    return {
        "success": bool(result.get("success")),
        "state": result.get("state"),
        "outcome": result.get("outcome"),
        "message": result.get("message"),
        "releases": releases,
        "defaultCandidateId": default_release_id(releases),
        "selected": resolution.selected.to_dict() if (resolution and resolution.selected) else None,
        "confirmation": confirmation,
        "installation": install_svc.capability(),
    }


# ---------------------------------------------------------------------------
# Phase 7: confirmation
# ---------------------------------------------------------------------------


def confirmation(confirmed: bool = False, candidate_id: Optional[str] = None) -> Dict[str, Any]:
    """Record or report the explicit confirmation for one exact candidate.

    Confirming never downloads or installs anything. The target is re-resolved
    and re-validated against the live catalogue server-side; the confirmation is
    bound to that candidate id, so it cannot be reused for a different image.
    """
    target = _target(candidate_id)
    if not target.get("ok"):
        from services import firmware_errors as errors

        # A caller naming a candidate that was never resolved is a confirmation
        # problem specifically, not a generic block, and saying so is what makes
        # the two failures separable in a log.
        named_an_unresolved_candidate = bool(candidate_id)
        return {
            "success": False,
            "confirmationRequired": False,
            "confirmed": False,
            "state": BLOCKED,
            "errorKind": (
                errors.CONFIRMATION_INVALID if named_an_unresolved_candidate else None
            ),
            "outcome": target["result"].get("outcome", "UNKNOWN"),
            "message": target.get("error")
            or (
                "No firmware candidate can be confirmed because compatibility "
                "could not be determined safely."
            ),
            "installation": install_svc.capability(),
        }

    selected = target["selected"]
    resolution = target["resolution"]
    releases = available_releases(resolution, target["candidates"])
    release_entry = next(
        (e for e in releases if e["candidateId"] == selected.identity()), None
    )

    if not confirmed:
        # Asking about confirmation must not clear a previous confirmation.
        return {
            "success": True,
            "confirmationRequired": True,
            "confirmed": False,
            "state": CONFIRMATION_REQUIRED,
            "outcome": resolution.outcome,
            "current": None,
            "target": selected.to_dict(),
            "release": release_entry,
            "nonDefaultChannel": selected.release_type in NON_DEFAULT_CHANNELS,
            "warning": (
                "Firmware installation changes the flight-controller software. "
                f"{install_svc.REAL_HARDWARE_REFUSAL}"
            ),
            "message": (
                f"Review the target firmware ({selected.version_str}), then "
                "confirm to continue."
            ),
            "installation": install_svc.capability(),
        }

    record = CONFIRMATION.record(
        selected,
        outcome=resolution.outcome,
        connection_fingerprint=connection_fingerprint(detect(include_identity=True)),
        hardware_fingerprint=hardware_fingerprint(),
        catalog_etag=_catalog_generation(target.get("catalog")),
        current_version=_current_version(),
    )
    fwlog.log_event(
        fwlog.SELECTION_CHANGED,
        fwlog.SELECTION,
        outcome=resolution.outcome,
        candidateId=selected.identity(),
        platform=selected.platform,
        releaseType=selected.release_type,
        version=selected.version_str,
        url=selected.url,
    )
    fwlog.log_event(
        fwlog.CONFIRMATION_RECORDED,
        fwlog.CONFIRMATION,
        outcome=resolution.outcome,
        confirmed=bool(confirmed),
        candidateId=record.candidate_id,
        targetVersion=record.current_version,
        targetPlatform=selected.platform,
        artifact=selected.url,
    )
    session = WORKFLOW.session
    if (
        session.state in install_svc.TERMINAL_STATES
        or session.state == CONFIRMATION_REQUIRED
    ):
        session = WORKFLOW.reset()
    session.set(
        confirmed_candidate_id=record.candidate_id,
        target_candidate_id=selected.identity(),
        target_version=selected.version_str or selected.version,
        target_release=selected.release_type,
        target_platform=selected.platform,
    )

    return {
        "success": True,
        "confirmationRequired": False,
        "confirmed": True,
        "state": READY,
        "outcome": resolution.outcome,
        "current": None,
        "target": selected.to_dict(),
        "release": release_entry,
        "nonDefaultChannel": selected.release_type in NON_DEFAULT_CHANNELS,
        "confirmation": record.to_dict(),
        "warning": (
            "Firmware installation changes the flight-controller software. "
            f"{install_svc.REAL_HARDWARE_REFUSAL}"
        ),
        "message": (
            f"Firmware target confirmed: {selected.version_str}. Continuing will "
            "download and verify this image."
        ),
        "installation": install_svc.capability(),
    }


def current_confirmation(deep: bool = False) -> Dict[str, Any]:
    """The live confirmation, dropping it first if the context has moved on.

    Every read path goes through here so a stale confirmation is never reported
    as live, never reaches the UI, and never authorises a download. Silently
    keeping a record whose board, version or catalogue generation no longer
    matches would let an old approval stand in for a new decision.

    ``deep=False`` runs only the checks that need no MAVLink round trip, which
    is what the polled status path must use. ``deep=True`` re-reads the board
    identity, installed version and catalogue generation, and is used at the
    decision points that authorise a download or an installation.
    """
    confirmation = CONFIRMATION.current
    if not confirmation.confirmed:
        return confirmation.to_dict()

    # The deep check must read the board identity the same way confirmation
    # recorded it, otherwise a connected board would look like a different one.
    detection = detect(include_identity=deep)
    vehicle_fingerprint = connection_fingerprint(detection)
    board_fingerprint: Optional[str] = None
    current_version: Optional[str] = None
    catalog_etag: Optional[str] = None
    if deep:
        board_fingerprint = hardware_fingerprint()
        if detection.get("connected"):
            current_version = _current_version()
            catalog_etag = _live_catalog_generation(deep=True)

    reasons = CONFIRMATION.invalidate_if_stale(
        confirmation.candidate_id,
        connection_fingerprint=vehicle_fingerprint,
        hardware_fingerprint=board_fingerprint,
        catalog_etag=catalog_etag,
        current_version=current_version,
        deep=deep,
    )
    payload = CONFIRMATION.current.to_dict()
    if reasons:
        payload["invalidatedReasons"] = reasons
    return payload


def _confirmation_error(candidate_id: Optional[str]) -> Optional[Dict[str, Any]]:
    """Refuse to continue unless the backend recorded a *current* confirmation.

    A matching candidate id is not enough: the confirmation is first re-validated
    against the live hardware, version and catalogue generation, so an approval
    given before the board or the manifest changed cannot authorise a download.
    """
    live = current_confirmation(deep=True)
    # ``current_confirmation`` drops a confirmation whose context moved on and
    # reports *why*. Asking the cleared record why it is empty afterwards would
    # only ever produce "no confirmation was recorded" -- a different and much
    # less useful claim, because the operator did confirm, and something they
    # could not see changed underneath them. So the invalidation reasons are
    # taken from the call that actually observed the change.
    reasons = list(live.get("invalidatedReasons") or []) or CONFIRMATION.current.staleness(
        candidate_id,
        connection_fingerprint=connection_fingerprint(detect(include_identity=True)),
        hardware_fingerprint=hardware_fingerprint(),
        catalog_etag=_live_catalog_generation(deep=True),
        current_version=_current_version(),
    )
    if not reasons:
        return None
    # A confirmation that was given and no longer holds is a different thing from
    # one that was never given, and the caller is told which: the first needs to
    # be re-examined and re-approved, the second simply has to be supplied.
    stale = "no confirmation was recorded" not in reasons
    return {
        "success": False,
        "state": CONFIRMATION_REQUIRED,
        # Only a stale confirmation is an invalid one. Reporting the kind for the
        # "nothing was ever confirmed" case would call an absent decision a
        # broken one.
        **({"error": "confirmation-invalid"} if stale else {}),
        "message": (
            (
                "The confirmation is no longer valid and must be given again: "
                + "; ".join(reasons)
            )
            if stale
            else (
                "Explicit confirmation is required before firmware is downloaded. "
                "Confirm the selected release first."
            )
        ),
        "confirmationRequired": True,
        "confirmed": False,
        "invalidatedReasons": reasons,
    }


def _live_catalog_generation(deep: bool = False) -> Optional[str]:
    """The current official-catalogue generation, or ``None`` if unavailable."""
    if not detect(include_identity=deep).get("connected"):
        return None
    try:
        return _catalog_generation(firmware_catalog_service.get_catalog("Copter"))
    except Exception:  # noqa: BLE001 - a failed fetch must not authorise anything
        return None


# ---------------------------------------------------------------------------
# Phase 6: pre-install validation
# ---------------------------------------------------------------------------


#: The seven checks run immediately before any installation is authorised.
#: Exposed so the API and the report can name exactly what was validated.
PREINSTALL_CHECKS = (
    "device-connected",
    "hardware-identity-unchanged",
    "installed-version-unchanged",
    "candidate-still-official",
    "confirmation-matches-candidate",
    "catalogue-generation-unchanged",
    "no-workflow-in-progress",
)


def validate_pre_install(candidate_id: Optional[str] = None) -> Dict[str, Any]:
    """Run every pre-install check, right before installation would be authorised.

    Each check is evaluated against freshly read authoritative state rather than
    anything cached from confirmation time, so a change at any point in the
    session — a swapped board, a re-flash, a republished manifest — stops the
    installation instead of silently proceeding against a stale approval.

    Returns ``{"ok": True, ...}`` only when all seven checks pass. ``failures``
    names every failed check, never just the first, so the user sees the full
    picture.
    """
    checks: List[Dict[str, Any]] = []

    def record(name: str, passed: bool, detail: str) -> None:
        checks.append({"check": name, "passed": bool(passed), "detail": detail})

    # 1. A device must still be connected.
    detection = detect(include_identity=True)
    connected = bool(detection.get("connected"))
    record(
        "device-connected",
        connected,
        (
            f"Connected over {detection.get('connectionType') or 'an unknown transport'}."
            if connected
            else "No vehicle is connected."
        ),
    )

    vehicle_fingerprint = connection_fingerprint(detection)
    board_fingerprint = hardware_fingerprint()
    current_version = _current_version() if connected else None

    confirmation = CONFIRMATION.current

    # 2. The connected vehicle and physical board must both be the ones that
    #    were confirmed: a different vehicle, or a different board on the same
    #    MAVLink system, is a different installation target.
    same_vehicle = bool(
        connected
        and confirmation.connection_fingerprint is not None
        and vehicle_fingerprint is not None
        and confirmation.connection_fingerprint == vehicle_fingerprint
    )
    same_hardware = bool(
        connected
        and confirmation.hardware_fingerprint is not None
        and board_fingerprint is not None
        and confirmation.hardware_fingerprint == board_fingerprint
    )
    record(
        "hardware-identity-unchanged",
        same_vehicle and same_hardware,
        (
            "The connected board matches the confirmed hardware."
            if same_vehicle and same_hardware
            else (
                "The connected vehicle is not the vehicle that was confirmed."
                if not same_vehicle
                else (
                    "The connected board is not the board that was confirmed."
                    if not same_hardware
                    else "The board hardware identity could not be read."
                )
            )
        ),
    )

    # 3. The firmware currently on the board must be the version that was confirmed.
    same_version = bool(
        connected
        and confirmation.current_version is not None
        and current_version is not None
        and confirmation.current_version == current_version
    )
    record(
        "installed-version-unchanged",
        same_version,
        (
            f"The board still reports {current_version}."
            if same_version
            else (
                "The installed firmware version could not be read."
                if current_version is None
                else (
                    "The installed firmware version changed after confirmation."
                    if confirmation.current_version is not None
                    else "The confirmation was recorded without an installed version."
                )
            )
        ),
    )

    # 4. The candidate must still be a real entry in the official catalogue,
    #    re-resolved live rather than trusted from the confirmation.
    target = _target(candidate_id or confirmation.candidate_id)
    target_ok = bool(target.get("ok"))
    live_candidate = target["selected"] if target_ok else None
    candidate_official = bool(target_ok and live_candidate is not None)
    record(
        "candidate-still-official",
        candidate_official,
        (
            "The candidate is still an official release for this hardware."
            if candidate_official
            else (
                target.get("error")
                or "The confirmed candidate is no longer available from the "
                "official catalogue for the connected hardware."
            )
        ),
    )

    # 5. The recorded confirmation must match the candidate being installed.
    confirmation_matches = CONFIRMATION.current.matches(candidate_id or confirmation.candidate_id)
    record(
        "confirmation-matches-candidate",
        confirmation_matches,
        (
            "The backend holds a confirmation for this exact candidate."
            if confirmation_matches
            else "No backend confirmation matches this exact candidate."
        ),
    )

    # 6. The catalogue generation must not have moved since confirmation.
    etag = _live_catalog_generation(deep=True) if target_ok else None
    same_generation = bool(
        confirmation.catalog_etag is not None and etag is not None and confirmation.catalog_etag == etag
    )
    record(
        "catalogue-generation-unchanged",
        same_generation,
        (
            "The official catalogue has not changed since confirmation."
            if same_generation
            else (
                "The official catalogue was refreshed after confirmation, so it "
                "must be reviewed again."
                if confirmation.catalog_etag is not None and etag is not None
                else "The catalogue generation could not be established for comparison."
            )
        ),
    )

    # 7. Nothing else may be installing on the single authoritative session.
    busy = WORKFLOW.running
    record(
        "no-workflow-in-progress",
        not busy,
        "No other firmware workflow is running."
        if not busy
        else "Another firmware workflow is already running.",
    )

    failures = [c for c in checks if not c["passed"]]
    return {
        "ok": not failures,
        "checks": checks,
        "failures": [c["check"] for c in failures],
        "message": (
            "Every pre-install check passed."
            if not failures
            else "Installation refused: "
            + "; ".join(c["detail"] for c in failures)
        ),
    }


# ---------------------------------------------------------------------------
# Phase 8: download + integrity verification
# ---------------------------------------------------------------------------


def _fetch(candidate) -> Dict[str, Any]:
    """Fetch one already-validated candidate and report its integrity verdict.

    Separate from :func:`download` so the test adapter can pass a candidate it
    validated itself, without re-resolving against a vehicle that is not there.

    The integrity verdict is the download service's, not this function's: it is
    the code that saw the headers and the bytes that decides how strong a
    statement can honestly be made.
    """
    download_result = firmware_download_service.prepare_download(candidate)
    payload = download_result.to_dict()
    fwlog.log_event(
        fwlog.DOWNLOAD_STARTED,
        fwlog.DOWNLOAD,
        candidateId=download_result.candidate_id,
        url=download_result.url,
        publishedSha256=getattr(candidate, "artifact_sha256", "") or None,
    )

    if not download_result.ok:
        payload["state"] = FAILED
        # A transfer that never completed and a transfer that completed and then
        # failed its integrity check both refuse installation, but they are not
        # the same event, so they keep separate codes.
        # No integrity verdict is reached when the transfer never produced an
        # artifact to check, so the field stays empty rather than claiming one.
        payload["integrity"] = download_result.integrity
        # The coarse outcome a client branches on, kept separate from the precise
        # integrity verdict: a transport failure and an integrity failure are
        # different events even though both refuse installation.
        payload["downloadStatus"] = (
            firmware_download_service.DOWNLOAD_FAILED
            if download_result.error_kind
            in (firmware_download_service.DOWNLOAD_FAILED,
                firmware_download_service.DOWNLOAD_REJECTED,
                firmware_download_service.DOWNLOAD_DISABLED)
            else firmware_download_service.DOWNLOAD_VERIFICATION_FAILED
        )
        payload["errorKind"] = errors.from_download(download_result.error_kind)
        payload["errorMessage"] = errors.describe(payload["errorKind"])
        payload["verifiedForInstall"] = False
        payload["failureReason"] = payload["integrity"]
        fwlog.log_event(
            fwlog.DOWNLOAD_FAILED,
            fwlog.DOWNLOAD,
            outcome=payload["integrity"],
            errorKind=payload["errorKind"],
            reason=download_result.message,
            candidateId=download_result.candidate_id,
            url=download_result.url,
        )
        return payload

    verdict = download_result.integrity or firmware_download_service.INTEGRITY_TRANSFER_COMPLETE_ONLY
    payload["state"] = DOWNLOAD_VERIFIED
    # The strongest statement the official source actually supports. Nothing here
    # is promoted to "verified" beyond what the source published.
    payload["integrity"] = verdict
    payload["integrityEvidence"] = download_result.integrity_evidence
    payload["checksumVerified"] = bool(download_result.checksum_verified)
    payload["cryptographicallyVerified"] = bool(download_result.checksum_verified)
    payload["verifiedForInstall"] = (
        verdict in firmware_download_service.INTEGRITY_VERIFIED_STATES
    )
    payload["downloadStatus"] = (
        firmware_download_service.INTEGRITY_TRANSFER_COMPLETE_ONLY
        if not payload["verifiedForInstall"]
        else "DOWNLOAD_VERIFIED"
    )
    if not payload["verifiedForInstall"]:
        # Nothing published a length or a digest, so completeness could not be
        # established. The artifact is kept for inspection but must not be
        # installed, and the reason travels with it.
        payload["integrityNote"] = (
            "Only the end of the transfer could be observed: the official source "
            "published neither an artifact checksum nor a size, so the bytes "
            "cannot be shown to be the intended ones. Not verified for install."
        )
    elif not payload["checksumVerified"]:
        payload["integrityNote"] = download_result.checksum_note

    fwlog.log_event(
        fwlog.DOWNLOAD_VERIFICATION,
        fwlog.DOWNLOAD,
        outcome=verdict,
        reason=download_result.integrity_evidence,
        candidateId=download_result.candidate_id,
        url=download_result.url,
        bytesWritten=download_result.bytes_written,
        contentLength=download_result.content_length,
        sha256=download_result.sha256,
        checksumVerified=payload["checksumVerified"],
        verifiedForInstall=payload["verifiedForInstall"],
    )
    if payload["verifiedForInstall"]:
        fwlog.log_event(
            fwlog.DOWNLOAD_COMPLETED,
            fwlog.DOWNLOAD,
            outcome=verdict,
            candidateId=download_result.candidate_id,
            url=download_result.url,
            bytesWritten=download_result.bytes_written,
            sha256=download_result.sha256,
        )
    return payload


def download(candidate_id: Optional[str] = None) -> Dict[str, Any]:
    """Download and transfer-verify the selected official artifact.

    A partial or corrupted file is never returned to the installer, and no
    download happens without a matching server-side confirmation.
    """
    effective = candidate_id or CONFIRMATION.current.candidate_id
    refusal = _confirmation_error(effective)
    if refusal:
        return refusal

    target = _target(effective)
    if not target.get("ok"):
        return {
            "success": False,
            "state": BLOCKED,
            "message": target.get("error")
            or "No firmware image can be downloaded because compatibility could not be determined.",
            "outcome": target["result"].get("outcome"),
        }
    return _fetch(target["selected"])


# ---------------------------------------------------------------------------
# Phase 8-14: the installation workflow
# ---------------------------------------------------------------------------


def _expected_version_for(candidate) -> str:
    """The version string a correct installation would report back."""
    return candidate.version_str or candidate.version


def _select_installer(
    *,
    artifact_path: str,
    expected_version: str,
    observed_version_provider,
    allow_simulation: bool,
    fail_at: Optional[str] = None,
) -> FirmwareInstaller:
    """Pick the installer for the connected target.

    A physical board always gets :class:`RealFirmwareInstaller`, which refuses.
    Only when no hardware is connected can the TEST installer be used.
    """
    env = install_svc.environment()
    if env == "HARDWARE":
        return RealFirmwareInstaller()

    if not allow_simulation or not config.FIRMWARE_TEST_ADAPTER_ENABLED:
        raise install_svc.InstallationBlockedError(
            "The TEST/SIMULATION installer is disabled."
        )

    return TestFirmwareInstaller(
        artifact_path=artifact_path,
        expected_version=expected_version,
        observed_version_provider=observed_version_provider,
        fail_at=fail_at,
    )


def simulate_installation(
    *,
    vehicle: str = "Copter",
    observed_version: Optional[str] = None,
    fail_at: Optional[str] = None,
    candidate_id: Optional[str] = None,
    confirmed: bool = False,
) -> Dict[str, Any]:
    """Run the whole pipeline with a synthetic identity — no vehicle needed.

    This is the test adapter's entry point. It exists because a complete
    no-device walk-through is impossible otherwise: the live resolver refuses to
    select anything without a real ``AUTOPILOT_VERSION`` reply, so with no board
    attached the workflow could only ever report ``NO_DEVICE``.

    Honesty constraints, all enforced here:

    * Nothing is fabricated. The artifact, its digest and the target version all
      come from the real official manifest; only the *vehicle identity* is
      synthetic.
    * The session is marked ``is_simulation`` and ``hardware_touched`` stays
      ``False``; no serial port or MAVLink link is opened.
    * Post-install verification still compares an observed version against the
      target, so a mismatch yields ``FAILED``. ``observed_version`` is the
      version the simulated vehicle would report; when it is ``None`` the
      observed value is read from :func:`verify_installed_version` if a vehicle
      happens to be connected, otherwise verification fails honestly.
    * The caller must supply ``vehicle`` explicitly; nothing defaults to a real
      hardware platform.
    * ``confirmed`` is the explicit user action for this synthetic run. It is
      recorded server-side against the exact candidate, exactly like a real
      confirmation, so no caller can skip the confirmation step.
    """
    catalog = firmware_catalog_service.get_catalog(vehicle)
    candidates = list(getattr(catalog, "candidates", []) or [])
    if not candidates:
        session = WORKFLOW.reset()
        return _refusal(
            session,
            BLOCKED,
            catalog.message or f"No {vehicle} firmware is available in the official catalogue.",
        )

    # The most conservative release for this vehicle: official channel first,
    # then the highest version. Never a development channel by default.
    ranked = sorted(
        candidates,
        key=lambda c: (
            RELEASE_ORDER.index(c.release_type)
            if c.release_type in RELEASE_ORDER
            else 99,
            -(c.version_major or 0),
            -(c.version_minor or 0),
            -(c.version_patch or 0),
        ),
    )
    selected = next(
        (c for c in ranked if c.release_type not in NON_DEFAULT_CHANNELS), ranked[0]
    )
    if candidate_id:
        chosen = _select_release(candidates, candidate_id)
        if chosen is None:
            session = WORKFLOW.reset()
            return _refusal(
                session,
                BLOCKED,
                "The requested release is not present in the official catalogue "
                f"for {vehicle}.",
            )
        selected = chosen

    resolution = Resolution(
        outcome="SIMULATION",
        reason=(
            "Synthetic identity supplied by the test adapter. Compatibility was "
            "not proven against real hardware."
        ),
        selected=selected,
        candidate_count=len(candidates),
        platform_count=len({c.platform for c in candidates}),
        platforms=sorted({c.platform for c in candidates}),
        signals_used=["test-adapter"],
        evidence=[
            "TEST/SIMULATION: no vehicle identity was read; this is not a "
            "hardware compatibility result."
        ],
    )

    session = WORKFLOW.reset()
    session.advance(DETECTING, "TEST/SIMULATION: no device is required.")
    session.advance(IDENTIFYING, "TEST/SIMULATION: using a synthetic identity.")
    session.advance(RESOLVING, resolution.reason)
    session.advance(CONFIRMATION_REQUIRED, "Explicit confirmation is required.")

    # The explicit action for a synthetic run is recorded here, server-side and
    # bound to the exact candidate, so this path cannot be entered silently.
    if confirmed:
        # A simulation has no device and no live hardware binding by design, so
        # its confirmation is recorded as synthetic: only the exact-candidate
        # binding applies, and it still cannot be skipped.
        CONFIRMATION.record(
            selected, outcome=resolution.outcome, synthetic=True
        )
    refusal = _confirmation_error(selected.identity())
    if refusal:
        session.error = "confirmation-required"
        return {**session.snapshot(), **refusal}

    session.set(
        outcome=resolution.outcome,
        mode=install_svc.TEST_LABEL,
        is_simulation=True,
        target_candidate_id=selected.identity(),
        target_version=_expected_version_for(selected),
        target_release=selected.release_type,
        target_platform=selected.platform,
    )

    expected = session.target_version or ""
    if not config.FIRMWARE_TEST_ADAPTER_ENABLED:
        return _refusal(session, BLOCKED, "The TEST/SIMULATION installer is disabled.")

    installer = TestFirmwareInstaller(
        artifact_path="",
        expected_version=expected,
        observed_version=observed_version,
        fail_at=fail_at,
    )
    session.installer = installer

    session.advance(DOWNLOADING, "Downloading the official firmware artifact.")
    download_payload = _fetch(selected)
    if not download_payload.get("success"):
        session.error = "download-failed"
        session.advance(
            FAILED, download_payload.get("message", "Firmware download failed.")
        )
        return {**session.snapshot(), "success": False, "download": download_payload}

    artifact_path = str(download_payload.get("path") or "")
    if not artifact_path:
        session.error = "no-artifact"
        return _refusal(
            session, FAILED, "The verified artifact has no local path.",
            download=download_payload,
        )
    session.advance(
        DOWNLOAD_VERIFIED,
        f"Artifact verified ({download_payload.get('sha256', '')[:16]}…).",
    )

    session.advance(PREPARING, f"{install_svc.TEST_LABEL}: preparing.")
    prepare_progress = installer.prepare(artifact_path, expected)
    session.record_progress([prepare_progress])
    if prepare_progress.state == FAILED:
        session.error = "prepare-failed"
        return {
            **session.snapshot(),
            "success": False,
            "download": download_payload,
        }

    session.advance(INSTALLING, f"{install_svc.TEST_LABEL}: installing.")
    result = installer.install()
    session.record_progress(result.progress)
    session.set(
        installed_version=result.observed_version,
        version_verified=result.version_verified,
    )

    if result.state == CANCELLED:
        session.error = result.error or "cancelled"
        session.advance(CANCELLED, result.message)
        return {
            **session.snapshot(),
            "success": False,
            "install": result.to_dict(),
            "download": download_payload,
        }
    if not result.ok:
        session.error = result.error or "install-failed"
        session.advance(FAILED, result.message)
        return {
            **session.snapshot(),
            "success": False,
            "install": result.to_dict(),
            "download": download_payload,
        }

    session.advance(
        VERIFYING,
        f"{install_svc.TEST_LABEL}: verifying the observed version.",
    )
    installer_verification = installer.verify()
    session.record_progress(installer.progress()[-1:])

    # A simulation has no device, so there is no board identity to re-read and
    # nothing that could be proved about real hardware. The version check still
    # applies to the observed value the caller supplied.
    expected_identity = observed_identity()
    verification = verify_installation(
        expected,
        expected_identity=expected_identity,
        observed_version=installer_verification.observed_version,
    )
    if session.is_simulation and expected_identity is None:
        # No board was ever involved: verify the observed version only, and say
        # so plainly rather than implying a hardware check happened.
        version_ok = install_svc.versions_match(
            expected, installer_verification.observed_version
        )
        verification = {
            **verification,
            "verified": bool(version_ok),
            "error": "" if version_ok else install_svc.VERIFICATION_MISMATCH,
            "identityApplicable": False,
            "message": (
                f"{install_svc.TEST_LABEL}: observed version "
                f"{installer_verification.observed_version} "
                f"{'matches' if version_ok else 'does not match'} the target. "
                "No hardware was involved, so no board identity was verified."
            ),
        }

    log_verification(verification, stage="simulation")

    session.set(
        installed_version=verification.get("observedVersion"),
        version_verified=bool(verification.get("verified")),
    )
    installer.cleanup()
    session.set(installer=None)

    if not session.version_verified:
        session.error = verification.get("error") or "verification-failed"
        session.advance(
            FAILED,
            verification.get("message")
            or f"{install_svc.TEST_LABEL}: verification did not confirm the target.",
        )
        return {
            **session.snapshot(),
            "success": False,
            "verification": verification,
            "install": result.to_dict(),
            "download": download_payload,
        }

    session.advance(
        COMPLETED,
        f"{install_svc.TEST_LABEL}: verified {session.installed_version} "
        "against the target. No hardware was involved.",
    )
    return {
        **session.snapshot(),
        "success": True,
        "simulation": True,
        "compatibilityProven": False,
        "verification": verification,
        "install": result.to_dict(),
        "download": download_payload,
    }


def start_simulation(
    *,
    vehicle: str = "Copter",
    observed_version: Optional[str] = None,
    fail_at: Optional[str] = None,
    candidate_id: Optional[str] = None,
    confirmed: bool = False,
) -> Dict[str, Any]:
    """Run :func:`simulate_installation` on a background worker."""
    if WORKFLOW.running:
        # Same shape as the accepted payload below, so a polling client never
        # has to special-case "busy". Nothing here is an installation result.
        return {
            "success": False,
            "accepted": False,
            "state": WORKFLOW.session.state,
            "running": True,
            "terminal": False,
            "versionVerified": False,
            "message": "A firmware workflow is already running.",
            "busy": True,
        }
    session = WORKFLOW.reset()
    session.advance(DETECTING, "TEST/SIMULATION: starting.")
    started = WORKFLOW.start_worker(
        simulate_installation,
        vehicle=vehicle,
        observed_version=observed_version,
        fail_at=fail_at,
        candidate_id=candidate_id,
        confirmed=confirmed,
    )
    if not started:
        # Same shape as the accepted payload, so a polling client never has to
        # special-case "busy"; nothing here is ever an installation result.
        return {
            "success": False,
            "accepted": False,
            "state": session.state,
            "running": True,
            "terminal": False,
            "versionVerified": False,
            "message": "A firmware workflow is already running.",
            "busy": True,
        }
    return {
        "success": False,
        "accepted": True,
        "state": session.state,
        "running": True,
        "terminal": False,
        "versionVerified": False,
        "isSimulation": True,
        "hardwareTouched": False,
        "message": (
            "TEST/SIMULATION workflow started. Poll the status endpoint; this "
            "response is not an installation result."
        ),
    }



def verify_installed_version(expected: str) -> Dict[str, Any]:
    """Read the vehicle's ACTUAL version and compare it with the target.

    This is the read-only half of verification. The installer's own
    :meth:`~services.firmware_install_service.FirmwareInstaller.verify` performs
    the comparison; this function supplies the observation and never assumes
    equality.
    """
    identified = identify()
    if not identified.get("success"):
        return {
            "verified": False,
            "observedVersion": None,
            "expectedVersion": expected,
            "message": (
                "Installation cannot be verified because the vehicle did not report "
                "its firmware version."
            ),
        }
    info = identified["info"]
    observed = info.get("version")
    verified = install_svc.versions_match(expected, observed)
    return {
        "verified": verified,
        "observedVersion": observed,
        "observedRelease": info.get("release"),
        "expectedVersion": expected,
        "message": (
            f"Verified: the vehicle reports {observed}, matching the target."
            if verified
            else f"Not verified: the vehicle reports {observed}, not the expected "
                 f"{expected}."
        ),
    }


def _refusal(session, state: str, message: str, **extra: Any) -> Dict[str, Any]:
    """Report a refusal on the session, without forcing it backwards.

    A refusal can be computed just as the vehicle goes away: the session has
    already settled on ``DISCONNECTED``, and advancing it to ``BLOCKED`` would
    raise inside the background worker, leaving the client polling a session
    that never finishes. When that race is lost, the state the session actually
    reached is the honest answer, so it is reported unchanged.
    """
    settled = getattr(session, "state", None)
    if settled in install_svc.TERMINAL_STATES and settled != state:
        return {**session.snapshot(), "success": False, **extra}
    session.advance(state, message)
    return {**session.snapshot(), "success": False, "message": message, **extra}


# ---------------------------------------------------------------------------
# Phase 7: post-install verification
# ---------------------------------------------------------------------------

#: Identity fields compared before and after an installation. A correct
#: firmware version on the wrong board is not a successful installation, so the
#: board and vehicle identity must survive the flash unchanged.
VERIFICATION_IDENTITY_FIELDS = (
    "firmwareVersion",
    "vehicleType",
    "autopilot",
    "usbId",
    "boardType",
    "boardRev",
)


def observed_identity() -> Optional[Dict[str, Any]]:
    """Re-read the board's identity after an installation.

    Returns ``None`` when the board cannot be reached or does not report its
    identity, which is an unconfirmed verification rather than a mismatch.
    """
    detection = detect(include_identity=True)
    if not detection.get("connected"):
        return None
    return {field: detection.get(field) for field in VERIFICATION_IDENTITY_FIELDS}


def compare_identity(
    expected: Optional[Dict[str, Any]],
    observed: Optional[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """Compare the identity the installation started from with the current one.

    A field that was unknown before the installation (``None``) is not held
    against it: there was nothing to protect. A field that *was* known and is
    now missing, different, or was missing before and now present, is a
    mismatch.
    """
    checks: List[Dict[str, Any]] = []
    for field_name in VERIFICATION_IDENTITY_FIELDS:
        before = (expected or {}).get(field_name)
        after = (observed or {}).get(field_name)
        if before is None:
            matches = True
            detail = "not known before installation; not held against it"
        else:
            matches = after == before
            detail = (
                f"unchanged ({before})" if matches else f"changed from {before} to {after}"
            )
        checks.append({"field": field_name, "expected": before, "observed": after, "matches": matches, "detail": detail})
    return checks


def verify_installation(
    expected_version: str,
    expected_identity: Optional[Dict[str, Any]] = None,
    observed_version: Optional[str] = None,
) -> Dict[str, Any]:
    """Verify a completed installation against the board as it now reports itself.

    Checks the firmware version *and* the board identity, vehicle type and
    autopilot type. Any mismatch fails with :data:`VERIFICATION_MISMATCH`; an
    unreadable board fails with :data:`VERIFICATION_UNCONFIRMED`. Neither is ever
    reported as a successful installation.
    """
    version_observation = verify_installed_version(expected_version)
    current_version = observed_version or version_observation.get("observedVersion")
    version_ok = bool(version_observation.get("verified"))

    current_identity = observed_identity()
    checks = compare_identity(expected_identity, current_identity)
    identity_ok = bool(current_identity is not None) and all(c["matches"] for c in checks)

    verified = bool(version_ok and identity_ok)
    if verified:
        message = (
            f"Verified: the vehicle reports {current_version} on the expected "
            "hardware, vehicle type and autopilot."
        )
        error = ""
    elif current_identity is None:
        message = (
            "Installation cannot be verified because the vehicle stopped "
            "reporting its identity after the installation."
        )
        error = install_svc.VERIFICATION_UNCONFIRMED
    elif not version_ok:
        message = (
            f"Not verified: the vehicle reports {current_version}, not the "
            f"expected {expected_version}."
        )
        error = install_svc.VERIFICATION_MISMATCH
    else:
        mismatched = [c["field"] for c in checks if not c["matches"]]
        message = (
            "Not verified: the firmware version matches, but the board's "
            f"identity changed during installation ({', '.join(mismatched)})."
        )
        error = install_svc.VERIFICATION_MISMATCH

    return {
        "verified": verified,
        "error": error,
        "expectedVersion": expected_version,
        "observedVersion": current_version,
        "expectedIdentity": expected_identity,
        "observedIdentity": current_identity,
        "checks": checks,
        "mismatches": [c["field"] for c in checks if not c["matches"]],
        "source": version_observation.get("source"),
        "message": message,
    }



def log_verification(verification: Dict[str, Any], *, stage: str) -> None:
    """Record the *settled* verification verdict for an install stage.

    Called by the caller once the verdict is final, never from inside the
    verification helper itself: that helper is invoked speculatively and its
    result is then adjusted (a simulation has no board to re-read), so logging
    there would record an intermediate value and make the audit trail contradict
    the state the workflow actually settled on.
    """
    verified = bool(verification.get("verified"))
    error = verification.get("error") or ""
    fwlog.log_event(
        fwlog.POST_INSTALL_VERIFICATION,
        fwlog.VERIFICATION,
        outcome="VERIFIED" if verified else (error or "UNVERIFIED"),
        stage=stage,
        reason=verification.get("message"),
        expectedVersion=verification.get("expectedVersion"),
        observedVersion=verification.get("observedVersion"),
        mismatches=list(verification.get("mismatches") or []),
        source=verification.get("source"),
    )

def run_install(
    candidate_id: Optional[str] = None,
    *,
    allow_simulation: bool = False,
    fail_at: Optional[str] = None,
) -> Dict[str, Any]:
    # The refusal path below is logged explicitly: "we declined, here is why" is
    # exactly the event an operator needs when nothing appears to happen.
    """Run the full installation workflow synchronously.

    Refuses real hardware *before* downloading. On the TEST/SIMULATION path it
    performs confirmation → download → integrity check → prepare → install →
    verify, and reports the real state at every step.
    """
    session = WORKFLOW.reset()
    session.advance(DETECTING, "Detecting the connected vehicle.")
    session.advance(IDENTIFYING, "Reading the current firmware version.")

    # ---- Refuse early and truthfully when there is no vehicle. -------------
    detection = detect()
    if not detection["success"]:
        return {
            **session.snapshot(),
            "success": False,
            "state": "NO_DEVICE",
            "connected": False,
            "message": (
                "No vehicle is connected, so there is no hardware identity to "
                "resolve firmware compatibility against. Use the TEST/SIMULATION "
                "endpoint to exercise the installer without hardware."
            ),
        }

    # ---- Resolve and validate the target. ---------------------------------
    target = _target(candidate_id)
    if not target.get("ok"):
        return _refusal(
            session,
            BLOCKED,
            target.get("error")
            or (
                "Installation cannot start because firmware compatibility could "
                "not be determined safely."
            ),
            outcome=target["result"].get("outcome"),
        )
    resolution = target["resolution"]
    selected = target["selected"]
    session.advance(RESOLVING, resolution.reason)

    identified = identify()
    if identified.get("success"):
        session.set(
            current_version=identified["info"].get("version"),
            current_release=identified["info"].get("release"),
        )

    # The identity the board reports now is what post-install verification
    # compares against, so the correct firmware on the wrong board cannot pass.
    expected_identity = observed_identity()

    # ---- Confirmation is mandatory. ---------------------------------------
    session.advance(
        CONFIRMATION_REQUIRED,
        "Waiting for explicit confirmation before downloading.",
    )
    effective_candidate_id = selected.identity()
    refusal = _confirmation_error(effective_candidate_id)
    if refusal:
        session.error = "confirmation-required"
        # A refused install has to *settle*. CONFIRMATION_REQUIRED is the state
        # the page waits in, but parking a refused workflow there leaves a client
        # polling a session that will never finish, and reports "waiting" beside
        # "your confirmation did not hold". The refusal settles as BLOCKED and
        # still carries what is needed, so the operator is told to confirm.
        return _refusal(
            session,
            BLOCKED,
            refusal.get("message")
            or "Explicit confirmation is required before anything is fetched.",
            **{k: v for k, v in refusal.items() if k not in ("success", "state", "message")},
        )

    session.set(
        outcome=resolution.outcome,
        target_candidate_id=effective_candidate_id,
        target_version=_expected_version_for(selected),
        target_release=selected.release_type,
        target_platform=selected.platform,
    )

    # ---- Choose the installer BEFORE downloading anything. ----------------
    # Every pre-install check runs here, against state read fresh at this
    # instant rather than anything cached at confirmation time.
    validation = validate_pre_install(effective_candidate_id)
    if not validation["ok"]:
        CONFIRMATION.clear("STALE")
        return _refusal(
            session,
            BLOCKED,
            validation["message"],
            preInstallChecks=validation["checks"],
        )

    expected = session.target_version or ""
    env = install_svc.environment()

    def observed_provider() -> Optional[str]:
        return verify_installed_version(expected).get("observedVersion")

    try:
        installer = _select_installer(
            artifact_path="",
            expected_version=expected,
            observed_version_provider=observed_provider,
            allow_simulation=allow_simulation,
            fail_at=fail_at,
        )
    except install_svc.InstallationBlockedError as exc:
        return _refusal(session, BLOCKED, str(exc))

    session.mode = installer.mode
    session.is_simulation = installer.is_simulation
    session.installer = installer

    if not installer.installation_allowed:
        # Real hardware: refuse truthfully, without downloading anything.
        return _refusal(session, BLOCKED, install_svc.REAL_HARDWARE_REFUSAL)

    # ---- Download and transfer-verify. ------------------------------------
    session.advance(DOWNLOADING, "Downloading the official firmware artifact.")
    download_payload = download(effective_candidate_id)
    if not download_payload.get("success"):
        session.error = "download-failed"
        session.advance(
            FAILED, download_payload.get("message", "Firmware download failed.")
        )
        return {**session.snapshot(), "success": False, "download": download_payload}

    artifact_path = str(download_payload.get("path") or "")
    if not artifact_path:
        session.error = "no-artifact"
        return _refusal(
            session,
            FAILED,
            "The verified artifact has no local path.",
            download=download_payload,
        )

    session.advance(
        DOWNLOAD_VERIFIED,
        f"Artifact verified ({download_payload.get('sha256', '')[:16]}…).",
    )

    # ---- Prepare, install, verify. ----------------------------------------
    session.advance(PREPARING, f"{installer.mode}: preparing the installation.")
    prepare_progress = installer.prepare(artifact_path, expected)
    session.record_progress([prepare_progress])
    if prepare_progress.state == FAILED:
        session.error = "prepare-failed"
        return {
            **session.snapshot(),
            "success": False,
            "download": download_payload,
        }

    session.advance(INSTALLING, f"{installer.mode}: installing.")
    result = installer.install()
    session.record_progress(result.progress)
    session.set(
        installed_version=result.observed_version,
        version_verified=result.version_verified,
    )

    if result.state == CANCELLED:
        session.error = result.error or "cancelled"
        session.advance(CANCELLED, result.message)
        return {
            **session.snapshot(),
            "success": False,
            "install": result.to_dict(),
            "download": download_payload,
        }

    if not result.ok:
        session.error = result.error or "install-failed"
        session.advance(FAILED, result.message)
        return {
            **session.snapshot(),
            "success": False,
            "install": result.to_dict(),
            "download": download_payload,
        }

    # ---- Mandatory independent verification. ------------------------------
    session.advance(
        VERIFYING,
        "Re-reading the installed firmware version and the board identity.",
    )
    installer_verification = installer.verify()
    session.record_progress(installer.progress()[-1:])

    # Independent of the installer: re-read the board itself and compare the
    # firmware version, board identity, vehicle type and autopilot type.
    verification = verify_installation(
        expected,
        expected_identity=expected_identity,
        observed_version=installer_verification.observed_version,
    )
    session.set(
        installed_version=verification.get("observedVersion"),
        version_verified=bool(verification.get("verified")),
    )
    log_verification(verification, stage="post-install")

    installer.cleanup()
    session.set(installer=None)

    if not session.version_verified:
        session.error = verification.get("error") or "verification-failed"
        session.advance(
            FAILED,
            verification.get("message")
            or f"{install_svc.TEST_LABEL}: verification did not confirm the target.",
        )
        return {
            **session.snapshot(),
            "success": False,
            "verification": verification,
            "install": result.to_dict(),
            "download": download_payload,
        }

    session.advance(
        COMPLETED,
        f"Installed and verified: {session.installed_version} matches the target "
        "on the expected hardware.",
    )
    return {
        **session.snapshot(),
        "success": True,
        "verification": verification,
        "install": result.to_dict(),
        "download": download_payload,
    }


def start_install(
    candidate_id: Optional[str] = None,
    *,
    allow_simulation: bool = False,
    fail_at: Optional[str] = None,
) -> Dict[str, Any]:
    """Start the workflow on a background worker and return immediately.

    The session is authoritative: the client polls
    :func:`status` for real progress instead of blocking on one response.
    """
    if WORKFLOW.running:
        # Same shape as the accepted payload below, so a polling client never
        # has to special-case "busy". Nothing here is an installation result.
        return {
            "success": False,
            "accepted": False,
            "state": WORKFLOW.session.state,
            "running": True,
            "terminal": False,
            "versionVerified": False,
            "message": "A firmware workflow is already running.",
            "busy": True,
        }

    session = WORKFLOW.reset()
    session.advance(DETECTING, "Detection started.")
    started = WORKFLOW.start_worker(
        run_install, candidate_id, allow_simulation=allow_simulation, fail_at=fail_at
    )
    if not started:
        # Same shape as the accepted payload, so a polling client never has to
        # special-case "busy"; nothing here is ever an installation result.
        return {
            "success": False,
            "accepted": False,
            "state": session.state,
            "running": True,
            "terminal": False,
            "versionVerified": False,
            "message": "A firmware workflow is already running.",
            "busy": True,
        }
    # ``success`` means "the firmware was installed and verified", so an accepted
    # request is never reported as one. Only the real installer running on the
    # worker can set that.
    return {
        "success": False,
        "accepted": True,
        "state": session.state,
        "running": True,
        "terminal": False,
        "versionVerified": False,
        "realInstallationAllowed": install_svc.REAL_INSTALLATION_ALLOWED,
        "message": (
            "Firmware workflow started. Poll the status endpoint for real progress; "
            "this response is not an installation result."
        ),
    }


def cancel_install() -> Dict[str, Any]:
    """Request cancellation of the running workflow."""
    session = WORKFLOW.session
    installer = session.installer
    requested = bool(installer and installer.cancel())
    if not session.state in install_svc.TERMINAL_STATES:
        session.advance(CANCELLED, "Installation cancelled.")
        session.error = "cancelled-by-user"
    return {
        **session.snapshot(),
        "success": False,
        "cancelRequested": requested,
        "message": "Installation cancelled.",
    }


def status() -> Dict[str, Any]:
    """Current authoritative workflow state.

    Read-only apart from recording an honest DISCONNECTED transition when the
    vehicle disappears mid-workflow.
    """
    session = WORKFLOW.session
    detection = detect()
    if not detection["connected"] and session.state in install_svc.CONNECTION_DEPENDENT_STATES:
        session.advance(
            DISCONNECTED,
            "The vehicle disconnected during the workflow. The firmware target, "
            "the staged artifact and the confirmation are no longer valid for "
            "any board.",
        )
        # A disconnected board invalidates the approval that was given for it,
        # so the confirmation is dropped rather than left to authorise a later
        # connection's installation.
        CONFIRMATION.clear("DISCONNECTED")
        session.set(
            target_candidate_id=None,
            confirmed_candidate_id=None,
            target_version=None,
            target_release=None,
            target_platform=None,
            # Never report a verified installation against a board that is gone.
            installed_version=None,
            version_verified=False,
        )
        # Any bootloader identity captured for the vanished board goes too, so a
        # later board can never inherit it.
        try:
            from services import bootloader_validation_service as validation

            validation.SERVICE.handle_connection_change(connected=False)
        except Exception:  # pragma: no cover - status must never raise
            pass
        fwlog.log_event(
            fwlog.DISCONNECT_OBSERVED,
            fwlog.DISCONNECT,
            outcome="DISCONNECTED",
            reason=detection.get("disconnectReason"),
            previousState=session.state,
            connectionFingerprintCleared=True,
        )
    payload = session.snapshot()
    payload["detection"] = detection
    payload["environment"] = install_svc.environment()
    payload["running"] = WORKFLOW.running
    payload["confirmation"] = current_confirmation()
    return payload


def workflow() -> Dict[str, Any]:
    """Full state for the Firmware page: detect → identify → resolve → list."""
    detection = detect()
    if not detection["success"]:
        # The same keys are present here as in the connected response below, so a
        # caller never has to ask whether a field is missing because there was no
        # board: "no releases" is then a fact, not an absent field.
        return {
            "success": False,
            "state": "NO_DEVICE",
            "connected": False,
            "outcome": firmware_compat_service.NO_DEVICE,
            "message": detection["message"],
            "detection": detection,
            "installation": install_svc.capability(),
            "current": None,
            "releases": [],
            "resolution": None,
            "canConfirm": False,
            "confirmationRequired": False,
        }

    identified = identify()
    resolved = resolve()
    resolution = _resolved(resolved)
    resolution_full = resolved.get("resolution")

    releases: List[Dict[str, Any]] = []
    if resolution is not None:
        releases = available_releases(
            resolution, list(getattr(resolved.get("catalog"), "candidates", []) or [])
        )

    current = None
    if identified.get("success"):
        info = identified["info"]
        current = {
            "version": info.get("version"),
            "release": info.get("release"),
            "vehicle": info.get("vehicle"),
            "autopilot": info.get("autopilotLabel") or info.get("autopilot"),
            "boardType": info.get("boardType"),
            "boardRev": info.get("boardRev"),
            "connectionType": info.get("connectionType"),
        }

    return {
        "success": bool(identified.get("success")),
        "state": resolved.get("state"),
        "connected": True,
        "detection": detection,
        "current": current,
        "outcome": resolved.get("outcome"),
        "message": resolved.get("message"),
        "resolution": (resolution_full.to_dict() if resolution_full else None),
        "releases": releases,
        "defaultCandidateId": default_release_id(releases),
        "confirmation": current_confirmation(),
        "installation": install_svc.capability(),
        "session": WORKFLOW.session.snapshot(),
    }


__all__ = [
    "IDLE",
    "DETECTING",
    "IDENTIFYING",
    "RESOLVING",
    "READY",
    "CONFIRMATION_REQUIRED",
    "DOWNLOADING",
    "DOWNLOAD_VERIFIED",
    "PREPARING",
    "INSTALLING",
    "VERIFYING",
    "COMPLETED",
    "FAILED",
    "CANCELLED",
    "DISCONNECTED",
    "BLOCKED",
    "RELEASE_ORDER",
    "RELEASE_LABELS",
    "available_releases",
    "build_identity",
    "cancel_install",
    "confirmation",
    "default_release_id",
    "detect",
    "download",
    "identify",
    "resolve",
    "run_install",
    "simulate_installation",
    "start_install",
    "start_simulation",
    "status",
    "verify_installed_version",
    "version_list",
    "workflow",
]
