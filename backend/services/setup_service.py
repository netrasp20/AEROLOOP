"""Vehicle SETUP support service (QGC-style Vehicle Configuration backend).

Firmware identification is provided by requesting AUTOPILOT_VERSION
(MAV_CMD_REQUEST_MESSAGE with param1 = AUTOPILOT_VERSION msgid 148) and
capturing the reply through the packet bus. The response is the single source
of truth for the Firmware page and the Setup Summary firmware card — both the
vehicle identity and the decoded firmware come from this one payload.

Firmware *installation* is deliberately NOT implemented anywhere in YantraYug.
`firmware_install_service` enforces that block in the backend (no install route
exists, and the single install choke point raises unconditionally), so the UI
never gains flashing controls, progress or success states it cannot evidence.

The official ArduPilot release catalogue and the compatibility resolver are
implemented and read-only: `firmware_catalog_service` retrieves and validates
the real manifest, and `firmware_compat_service` decides which image — if any —
may be offered, refusing to select one from `board_id` alone.
"""

import threading
import time
from typing import Any, Dict, Tuple

from core.state import is_vehicle_connected, vehicle_state
from mavlink import packet_bus
from mavlink.connection_manager import manager

AUTOPILOT_VERSION_MSGID = 148
MAV_CMD_REQUEST_MESSAGE = 512
REQUEST_TIMEOUT_S = 5.0

# FIRMWARE_VERSION_TYPE values (mavlink enums / common.xml)
FIRMWARE_TYPE_LABELS: Dict[int, str] = {
    0: "Development",
    64: "Beta",
    128: "Release Candidate",
    255: "Official Release",
}

# ArduPilot vehicle types that present as an ArduCopter flight stack.
COPTER_VEHICLE_TYPES = {
    "QUADROTOR",
    "TRICOPTER",
    "HEXAROTOR",
    "OCTOROTOR",
    "COAXIAL",
    "HELICOPTER",
    "VTOL_QUADROTOR",
    "VTOL_TILTROTOR",
    "VTOL_RESERVED2",
    "VTOL_RESERVED3",
    "VTOL_RESERVED4",
    "VTOL_RESERVED5",
}

_CONNECTION_LABELS = {
    "serial": "USB",
    "udp": "UDP",
    "tcp": "TCP",
}


def _firmware_type_label(raw: int) -> str:
    """Return only the release type label for flight_sw_version."""
    return FIRMWARE_TYPE_LABELS.get(raw & 0xFF, f"Type {raw & 0xFF}")


def _decode_flight_sw_version(raw: int) -> str:
    """Decode ArduPilot flight_sw_version: [7:0] type, [23:16] patch, [15:8] minor, [31:24] major."""
    fw_type = raw & 0xFF
    patch = (raw >> 8) & 0xFF
    minor = (raw >> 16) & 0xFF
    major = (raw >> 24) & 0xFF
    kind = FIRMWARE_TYPE_LABELS.get(fw_type, f"Type {fw_type}")
    return f"{major}.{minor}.{patch} ({kind})"


def _decode_board_version(raw: int) -> Tuple[int, int]:
    """Decode ArduPilot AUTOPILOT_VERSION.board_version.

    ArduPilot packs (board_type << 24) | (board_rev << 16) | 0 into the upper
    words; the low 16 bits are the board-version vendor value. Returns
    (board_type, board_rev) which are always real values from the vehicle.
    """
    board_type = (raw >> 24) & 0xFF
    board_rev = (raw >> 16) & 0xFF
    return board_type, board_rev


def _connection_type_label() -> str:
    ct = manager.connection_type
    if ct is None:
        from core.state import get_vehicle_status

        return get_vehicle_status()["connectionType"]
    return _CONNECTION_LABELS.get(ct, ct.upper())


def _vehicle_name() -> str:
    """Friendly autopilot-family name for the detected vehicle.

    ArduCopter-only: copter MAV types that are running under ArduPilot surface
    as "ArduCopter". Everything else is reported verbatim (never guessed).
    """
    autopilot = str(vehicle_state["autopilot"]).upper()
    if autopilot.startswith("ARDUPILOT"):
        vehicle_type = str(vehicle_state["vehicleType"]).upper()
        if vehicle_type in COPTER_VEHICLE_TYPES:
            return "ArduCopter"
    return str(vehicle_state["vehicleType"])


def _autopilot_name() -> str:
    autopilot = str(vehicle_state["autopilot"]).upper()
    if autopilot.startswith("ARDUPILOT"):
        return "ArduPilot"
    return str(vehicle_state["autopilot"])


def _supported_vehicle() -> Tuple[bool, str]:
    """Report whether the connected vehicle is a YantraYug-supported target.

    Only ArduPilot-based Copter stacks (ArduCopter) are supported by the
    Firmware page. Plane / Rover / PX4 / unknown vehicle types are reported as
    unsupported with the real identity (never guessed), so the UI can render the
    QGC-style "Unsupported vehicle" state honestly.
    """
    autopilot = str(vehicle_state["autopilot"]).upper()
    vehicle_type = str(vehicle_state["vehicleType"]).upper()

    if not autopilot.startswith("ARDUPILOT"):
        return (
            False,
            "YantraYug Firmware Setup currently supports ArduCopter only. "
            f"The connected autopilot ({_autopilot_name()}) is not supported.",
        )
    if vehicle_type not in COPTER_VEHICLE_TYPES:
        return (
            False,
            "YantraYug Firmware Setup currently supports ArduCopter only. "
            f"The connected vehicle type ({vehicle_type}) is not supported.",
        )
    return True, ""


def request_firmware_info() -> Dict[str, Any]:
    """Request AUTOPILOT_VERSION from the vehicle via MAV_CMD_REQUEST_MESSAGE.

    All MAVLink I/O is routed through the connection manager send queue and the
    packet bus, matching the established command/FTP patterns. The reply is
    enriched with the live vehicle identity so the Firmware page and the Setup
    Summary card render the exact same firmware + vehicle source of truth.
    """
    if not is_vehicle_connected():
        return {
            "success": False,
            "message": "Vehicle is not connected.",
            "connected": False,
        }

    conn = manager.connection
    sysid = vehicle_state["systemId"] or 1
    compid = vehicle_state["componentId"] or 1

    done = threading.Event()
    info: Dict[str, Any] = {}

    def on_version(msg: Any) -> None:
        if done.is_set():
            return
        raw = getattr(msg, "flight_sw_version", 0)
        info["flightSwVersion"] = raw
        info["version"] = _decode_flight_sw_version(raw)
        info["release"] = _firmware_type_label(raw)
        info["middlewareSwVersion"] = getattr(msg, "middleware_sw_version", 0)
        info["osSwVersion"] = getattr(msg, "os_sw_version", 0)
        info["boardVersion"] = getattr(msg, "board_version", 0)
        board_type, board_rev = _decode_board_version(info["boardVersion"])
        info["boardType"] = board_type
        info["boardRev"] = board_rev
        custom = bytes(getattr(msg, "flight_custom_version", b"") or b"")
        info["custom"] = custom.split(b"\0")[0].decode("utf-8", errors="replace")
        info["vendorId"] = getattr(msg, "vendor_id", 0)
        info["productId"] = getattr(msg, "product_id", 0)
        info["uid"] = hex(getattr(msg, "uid", 0))
        done.set()

    unsub = packet_bus.on_packet(AUTOPILOT_VERSION_MSGID, on_version)
    try:
        manager.enqueue(
            lambda: conn.mav.command_long_send(
                sysid, compid, MAV_CMD_REQUEST_MESSAGE, 0,
                float(AUTOPILOT_VERSION_MSGID), 0, 0, 0, 0, 0, 0,
            )
        )
        got = done.wait(REQUEST_TIMEOUT_S)
    finally:
        unsub()

    if not got:
        return {
            "success": False,
            "message": "Firmware version request timed out (no AUTOPILOT_VERSION reply).",
            "connected": True,
        }

    info["success"] = True
    info["connected"] = True
    info["vehicleType"] = vehicle_state["vehicleType"]
    info["vehicle"] = _vehicle_name()
    info["autopilot"] = vehicle_state["autopilot"]
    info["autopilotLabel"] = _autopilot_name()
    info["systemId"] = vehicle_state["systemId"]
    info["componentId"] = vehicle_state["componentId"]
    info["connectionType"] = _connection_type_label()
    supported, unsupported_reason = _supported_vehicle()
    info["supported"] = supported
    if not supported:
        info["unsupportedReason"] = unsupported_reason
        info["unsupportedAutopilot"] = info["autopilotLabel"]
        info["unsupportedVehicle"] = info["vehicle"]
    return info


def firmware_capability() -> Dict[str, Any]:
    """Honest capability report for the Firmware page.

    Identification is fully supported. The official ArduPilot release catalogue
    and compatibility resolution are live, so their availability reflects the
    real cached catalogue. Firmware *installation* remains unavailable and is
    enforced by `firmware_install_service` (backend side, not just the UI).
    """
    from services import firmware_catalog_service, firmware_install_service

    catalog = firmware_catalog_service.catalog_status()
    install = firmware_install_service.capability()
    return {
        "success": True,
        "firmwareIdentification": "available",
        "firmwareInstallation": "not-available",
        "releaseCatalog": "available" if catalog["available"] else "unavailable",
        "supportedTargets": [
            {"flightStack": "ArduPilot", "vehicle": "Copter"},
        ],
        "installationMessage": install["installationMessage"],
        "identificationMessage": "Firmware identification available.",
        "catalogMessage": catalog["message"],
        "catalog": catalog,
        "installation": install,
    }


# ------------------------------------------------------------------
# Official catalogue + compatibility resolution
# ------------------------------------------------------------------

_MAX_REPORTED_CANDIDATES = 50


def _sitl_evidence() -> bool:
    """Positive SITL identification (never assumes a physical board is a rig)."""
    from services.firmware_install_service import environment

    return environment() == "SITL"


def firmware_catalog(refresh: bool = False) -> Dict[str, Any]:
    """Resolve the official ArduPilot catalogue against the live vehicle.

    Combines the authoritative `AUTOPILOT_VERSION` identity, the official
    manifest catalogue and the compatibility resolver. Never selects a firmware
    image on `board_id` alone and never reports a success it cannot evidence.
    """
    from services import firmware_compat_service, firmware_install_service
    from services.firmware_catalog_service import get_catalog

    info = request_firmware_info()
    install = firmware_install_service.capability()

    if not info.get("success"):
        return {
            "success": False,
            "connected": bool(info.get("connected")),
            "message": info.get("message", "Vehicle identity is unavailable."),
            "identity": None,
            "catalog": None,
            "resolution": None,
            "candidates": [],
            "installation": install,
        }

    # The workflow's builder is used rather than re-deriving identity here, so
    # this route and /firmware/workflow answer identically for the same board:
    # one identity, one resolution rule, one bootloader-evidence fold.
    from services import firmware_workflow_service

    identity = firmware_workflow_service.build_identity()
    if identity is None:
        return {
            "success": False,
            "connected": bool(info.get("connected")),
            "message": info.get("message", "Vehicle identity is unavailable."),
            "identity": None,
            "catalog": None,
            "resolution": None,
            "candidates": [],
            "installation": install,
        }
    catalog = get_catalog(identity.manifest_vehicle, force_refresh=refresh)
    resolution = firmware_compat_service.resolve(
        catalog.candidates,
        identity,
        catalog_available=catalog.ok,
        catalog_message=catalog.message,
    )
    try:
        from services import firmware_logging as fwlog

        fwlog.log_resolution(
            resolution,
            stage="catalogue",
            manifestVehicle=identity.manifest_vehicle,
            candidateCount=len(catalog.candidates),
            catalogAvailable=catalog.ok,
        )
    except Exception:  # pragma: no cover - logging must never raise
        pass

    return {
        # A vehicle answered, but a manifest that could not be read means no
        # firmware can be offered. Reporting success here would let a caller act
        # on an empty candidate list as though the board simply had nothing
        # newer, which is a different and much milder claim than "the official
        # source is unreachable".
        "success": bool(catalog.ok),
        "connected": True,
        "current": {
            "version": info.get("version"),
            "release": info.get("release"),
            "custom": info.get("custom") or None,
            "boardType": info.get("boardType"),
            "boardRev": info.get("boardRev"),
            "connectionType": info.get("connectionType"),
            "vehicle": info.get("vehicle"),
            "autopilotLabel": info.get("autopilotLabel"),
            "uid": info.get("uid"),
        },
        "identity": identity.to_dict(),
        "catalog": catalog.status_dict(),
        "resolution": resolution.to_dict(),
        "candidates": [c.to_dict() for c in catalog.candidates[:_MAX_REPORTED_CANDIDATES]],
        "candidatesTruncated": len(catalog.candidates) > _MAX_REPORTED_CANDIDATES,
        "installation": install,
        "message": resolution.reason,
    }


def firmware_confirmation(confirmed: bool = False) -> Dict[str, Any]:
    """Confirmation state for the selected candidate. Never installs anything.

    The target is re-resolved server-side; a client cannot nominate its own
    firmware, so a wrong-board image can never be confirmed.
    """
    from services import firmware_install_service

    catalog = firmware_catalog()
    install = firmware_install_service.capability()
    resolution = catalog.get("resolution") or {}
    selected = resolution.get("selected")

    if not resolution.get("canConfirm") or not selected:
        return {
            "success": False,
            "confirmationRequired": False,
            "confirmed": False,
            "outcome": resolution.get("outcome", "UNKNOWN"),
            "message": (
                "No firmware candidate can be confirmed because compatibility could "
                "not be determined safely."
            ),
            "resolution": resolution,
            "installation": install,
        }

    return {
        "success": True,
        "confirmationRequired": True,
        "confirmed": bool(confirmed),
        "outcome": resolution.get("outcome"),
        "current": catalog.get("current"),
        "target": selected,
        "identity": catalog.get("identity"),
        "message": (
            "Firmware target confirmed. Installation remains blocked in this build; "
            "no firmware will be written."
            if confirmed
            else "Review the current and target firmware, then confirm."
        ),
        "installation": install,
    }
