"""Read-only bootloader identity service.

This module is the single place that decides *whether a bootloader identity read
is safe at all*, and produces the authoritative identity report the firmware
resolver consumes.

Transport safety, and why it matters
------------------------------------
The Pixhawk's bootloader and its firmware are two different protocols on the same
USB device. Sending bootloader framing to a board that is still running normal
firmware would be meaningless at best and dangerous at worst. So a read is
performed **only** when the transport has been positively identified as a
bootloader transport.

Transport classification is entirely read-only and comes from two independent
sources:

1. **USB descriptors** — vendor/product id, manufacturer, product string and the
   per-board serial number, obtained from the OS without opening the port.
2. **Liveness** — whether the board is answering MAVLink right now, taken from
   the existing connection state.

The decisive rules:

* The board answers MAVLink → it is running normal firmware → **refuse**. This is
  the connected Pixhawk1's actual state, and reading it is refused.
* The board is silent *and* advertises the bootloader's ``<BOARD>-BL`` product
  string → bootloader transport → reading is permitted.
* The board is silent but advertises *no* corroborating bootloader descriptor →
  **refuse**. Silence is not proof of bootloader mode, and guessing here would
  mean sending protocol bytes at an unknown device.

What this service will not do
-----------------------------
It never reboots the board, never requests bootloader entry, never erases, never
writes firmware and never changes a parameter. It also never enters a flash
mode transition. Any future capability of that kind is a separate, explicitly
approved phase.

The normal-mode USB product string trap
---------------------------------------
In normal mode a Pixhawk1 advertises the product string ``Pixhawk1``; in
bootloader mode the same board advertises ``Pixhawk1-BL`` (the
``HAL_USB_STRING_PRODUCT`` generated as ``"%BOARD%-BL"`` by ``chibios_hwdef.py``).
Only the ``-BL`` string is bootloader evidence.

``Pixhawk1`` is therefore recorded as *normal-mode product*, explicitly marked as
**not** bootloader evidence, and is never used to infer the platform. Matching on
it would be exactly the "guess Pixhawk1 from USB product information" shortcut
that this design exists to prevent.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

# --- transport kinds --------------------------------------------------------

#: No autopilot-like USB port is present at all.
TRANSPORT_NONE = "NONE"
#: A board is present and answering MAVLink: normal firmware, not a bootloader.
TRANSPORT_MAVLINK = "MAVLINK"
#: A board is present, silent, and advertising the bootloader's product string.
TRANSPORT_BOOTLOADER = "BOOTLOADER"
#: A board is present and silent but nothing corroborates bootloader mode.
TRANSPORT_UNKNOWN = "UNKNOWN"

#: Only this transport may be sent bootloader protocol traffic.
BOOTLOADER_CAPABLE_TRANSPORTS = frozenset({TRANSPORT_BOOTLOADER})

#: Suffix the ArduPilot bootloader appends to the USB product string.
BOOTLOADER_PRODUCT_SUFFIX = "-BL"

#: Identity fields this service can report, whether or not they were obtained.
#: Every one of these stays ``None`` when it could not be read; none is ever
#: invented, defaulted or inferred.
PROTOCOL_IDENTITY_FIELDS = (
    "bootloaderRevision",
    "boardId",
    "flashSize",
    "bootloaderUsbProductString",
)
USB_IDENTITY_FIELDS = (
    "usbVendorId",
    "usbProductId",
    "usbId",
    "usbSerialNumber",
    "usbManufacturer",
    "usbProductString",
    "usbProductIsBootloaderEvidence",
)
BOARD_IDENTITY_FIELDS = (
    "boardVersion",
    "boardType",
    "boardRev",
)
TRANSPORT_IDENTITY_FIELDS = (
    "mavlinkConnectionType",
    "systemId",
    "componentId",
)


@dataclass
class UsbPortIdentity:
    """USB descriptor identity of a port, as reported by the OS.

    Obtained without opening the port.
    """

    device: str
    vendor_id: Optional[int] = None
    product_id: Optional[int] = None
    serial_number: Optional[str] = None
    manufacturer: Optional[str] = None
    product: Optional[str] = None
    description: Optional[str] = None

    @property
    def usb_id(self) -> Optional[str]:
        """``VID:PID`` in the official manifest's own notation."""
        if self.vendor_id is None or self.product_id is None:
            return None
        return f"0x{self.vendor_id:04x}/0x{self.product_id:04x}"

    @property
    def is_bootloader_product_string(self) -> bool:
        """True only for the bootloader's ``<BOARD>-BL`` product string.

        A normal-mode product string is explicitly *not* bootloader evidence.
        """
        return bool(
            self.product
            and self.product.strip().endswith(BOOTLOADER_PRODUCT_SUFFIX)
        )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "device": self.device,
            "vendorId": self.vendor_id,
            "productId": self.product_id,
            "usbId": self.usb_id,
            "serialNumber": self.serial_number,
            "manufacturer": self.manufacturer,
            "product": self.product,
            "description": self.description,
            "isBootloaderProductString": self.is_bootloader_product_string,
        }


@dataclass
class TransportProbe:
    """Which transport a port is presenting, and the evidence for that call."""

    kind: str = TRANSPORT_NONE
    port: Optional[UsbPortIdentity] = None
    mavlink_alive: bool = False
    reason: str = ""
    evidence: List[str] = field(default_factory=list)

    @property
    def can_read_bootloader(self) -> bool:
        return self.kind in BOOTLOADER_CAPABLE_TRANSPORTS

    def to_dict(self) -> Dict[str, Any]:
        return {
            "kind": self.kind,
            "canReadBootloader": self.can_read_bootloader,
            "mavlinkAlive": self.mavlink_alive,
            "port": self.port.to_dict() if self.port else None,
            "reason": self.reason,
            "evidence": list(self.evidence),
        }


@dataclass
class BootloaderIdentityReport:
    """Everything this service could authoritatively learn, and what it could not.

    Every field is ``None`` when it was not genuinely read. ``missing_fields``
    names each one explicitly, so an absent field is always visible as absent
    rather than quietly defaulting to ``0``/``""``.
    """

    transport: TransportProbe = field(default_factory=TransportProbe)
    bootloader_revision: Optional[int] = None
    board_id: Optional[int] = None
    flash_size: Optional[int] = None
    bootloader_usb_product_string: Optional[str] = None
    board_version: Optional[int] = None
    board_type: Optional[int] = None
    board_rev: Optional[int] = None
    mavlink_connection_type: Optional[str] = None
    system_id: Optional[int] = None
    component_id: Optional[int] = None
    #: True when a bootloader identity was actually read from a bootloader.
    bootloader_read_performed: bool = False
    #: Why no bootloader read happened (empty when one did).
    refusal: str = ""
    evidence: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)

    # -- accessors -----------------------------------------------------------

    @property
    def usb_serial_number(self) -> Optional[str]:
        return self.transport.port.serial_number if self.transport.port else None

    @property
    def usb_id(self) -> Optional[str]:
        return self.transport.port.usb_id if self.transport.port else None

    @property
    def normal_mode_usb_product(self) -> Optional[str]:
        """The product string a running firmware advertises.

        Never bootloader evidence; recorded only so it is visible that it was
        considered and deliberately not used.
        """
        return self.transport.port.product if self.transport.port else None

    @property
    def missing_fields(self) -> List[str]:
        obtained = {
            "bootloaderRevision": self.bootloader_revision,
            "boardId": self.board_id,
            "flashSize": self.flash_size,
            "bootloaderUsbProductString": self.bootloader_usb_product_string,
            "boardVersion": self.board_version,
            "boardType": self.board_type,
            "boardRev": self.board_rev,
        }
        return [name for name, value in obtained.items() if value is None]

    @property
    def required_protocol_fields_present(self) -> bool:
        """The four bootloader fields that together make an identity usable.

        A partially-read identity is never treated as partial truth: the board-id
        9 collision means a half-populated identity can silently narrow the
        catalogue to the wrong physical platform.
        """
        return all(
            value is not None
            for value in (
                self.bootloader_revision,
                self.board_id,
                self.flash_size,
                self.bootloader_usb_product_string,
            )
        )

    @property
    def can_resolve_platform(self) -> bool:
        return bool(
            self.bootloader_read_performed and self.required_protocol_fields_present
        )

    def to_dict(self) -> Dict[str, Any]:
        port = self.transport.port
        return {
            # transport
            "transport": self.transport.to_dict(),
            "mavlinkConnectionType": self.mavlink_connection_type,
            "systemId": self.system_id,
            "componentId": self.component_id,
            # bootloader protocol fields
            "bootloaderRevision": self.bootloader_revision,
            "boardId": self.board_id,
            "flashSize": self.flash_size,
            "bootloaderUsbProductString": self.bootloader_usb_product_string,
            # board identity (MAVLink AUTOPILOT_VERSION)
            "boardVersion": self.board_version,
            "boardType": self.board_type,
            "boardRev": self.board_rev,
            # usb identity (descriptors)
            "usbVendorId": port.vendor_id if port else None,
            "usbProductId": port.product_id if port else None,
            "usbId": self.usb_id,
            "usbSerialNumber": self.usb_serial_number,
            "usbManufacturer": port.manufacturer if port else None,
            "usbProductString": self.normal_mode_usb_product,
            "usbProductIsBootloaderEvidence": bool(
                port and port.is_bootloader_product_string
            ),
            # outcome
            "bootloaderReadPerformed": self.bootloader_read_performed,
            "refusal": self.refusal,
            "missingFields": self.missing_fields,
            "requiredProtocolFieldsPresent": self.required_protocol_fields_present,
            "canResolvePlatform": self.can_resolve_platform,
            "evidence": list(self.evidence),
            "warnings": list(self.warnings),
        }


class BootloaderIdentityService:
    """Read-only, safety-gated bootloader identity.

    ``probe()`` and ``read_identity()`` never open a port, never write to a
    device and never change a device's state. They read OS USB descriptors and
    the existing MAVLink connection state, and they refuse to report a bootloader
    identity unless the transport has been positively identified as a bootloader.

    A transport may be injected (fixtures and tests use this); when none is
    supplied the service reports ``UNAVAILABLE`` rather than attempting a real
    bootloader read, because no real bootloader client exists in this phase.
    """

    def __init__(
        self,
        transport: Any = None,
        *,
        ports: Optional[List[Any]] = None,
        mavlink_alive: Optional[bool] = None,
    ) -> None:
        # A transport is optional. Without one this service can still classify
        # the transport and report the USB identity it can read safely.
        self._transport = transport
        self._ports_override = ports
        self._mavlink_alive_override = mavlink_alive

    # -- port enumeration ---------------------------------------------------

    def _ports(self) -> List[UsbPortIdentity]:
        if self._ports_override is not None:
            return [
                p if isinstance(p, UsbPortIdentity) else UsbPortIdentity(**p)
                for p in self._ports_override
            ]
        from services.serial_service import enumerate_usb_ports

        return [
            UsbPortIdentity(
                device=p.device,
                vendor_id=p.vid,
                product_id=p.pid,
                serial_number=p.serial_number,
                manufacturer=p.manufacturer,
                product=p.product,
                description=p.description,
            )
            for p in enumerate_usb_ports()
        ]

    def _mavlink_alive(self) -> bool:
        """Whether the existing MAVLink connection is live.

        Read-only: asks the already-running connection state, and never opens a
        link of its own.
        """
        if self._mavlink_alive_override is not None:
            return bool(self._mavlink_alive_override)
        try:
            from core.state import get_vehicle_status

            return bool(get_vehicle_status().get("connected"))
        except Exception:  # pragma: no cover - defensive
            return False

    # -- phase 2: transport classification ----------------------------------

    def probe(self) -> TransportProbe:
        """Classify the transport, read-only.

        ``BOOTLOADER`` requires *both* that the board is not answering MAVLink
        and that it advertises the bootloader's ``-BL`` product string. Anything
        else fails safe to ``UNKNOWN`` or ``MAVLINK``.
        """
        ports = self._ports()
        if not ports:
            return TransportProbe(
                kind=TRANSPORT_NONE,
                port=None,
                mavlink_alive=False,
                reason="No autopilot-like USB port is present.",
                evidence=["No /dev/ttyACM* or /dev/ttyUSB* device is enumerated."],
            )

        port = ports[0]
        mavlink_alive = self._mavlink_alive()
        evidence = [
            f"USB port {port.device} enumerated"
            + (f" as VID:PID {port.usb_id}" if port.usb_id else " with no VID/PID reported")
            + ".",
        ]
        if port.serial_number:
            evidence.append(f"USB serial number reported: {port.serial_number}.")
        else:
            evidence.append("No USB serial number was reported.")
        if port.product:
            evidence.append(f"USB product string reported: {port.product!r}.")

        if mavlink_alive:
            evidence.append(
                "The board is answering MAVLink, so it is running normal firmware."
            )
            return TransportProbe(
                kind=TRANSPORT_MAVLINK,
                port=port,
                mavlink_alive=True,
                reason=(
                    "The board is in normal MAVLink mode. It is not a bootloader "
                    "endpoint, so bootloader protocol traffic must not be sent to it."
                ),
                evidence=evidence,
            )

        evidence.append("The board is not answering MAVLink.")
        if port.is_bootloader_product_string:
            evidence.append(
                f"The USB product string ends in {BOOTLOADER_PRODUCT_SUFFIX!r}, "
                "which the ArduPilot bootloader uses."
            )
            return TransportProbe(
                kind=TRANSPORT_BOOTLOADER,
                port=port,
                mavlink_alive=False,
                reason=(
                    "The board is silent and advertises the bootloader's product "
                    "string, so it presents a bootloader transport."
                ),
                evidence=evidence,
            )

        evidence.append(
            "No bootloader product string was advertised, so a bootloader "
            "transport is not corroborated."
        )
        return TransportProbe(
            kind=TRANSPORT_UNKNOWN,
            port=port,
            mavlink_alive=False,
            reason=(
                "The board is silent but nothing corroborates bootloader mode. "
                "Silence is not proof of a bootloader, so no bootloader protocol "
                "traffic is sent."
            ),
            evidence=evidence,
        )

    # -- phase 1: the identity read -----------------------------------------

    def read_identity(self, *, mavlink_info: Optional[Dict[str, Any]] = None) -> BootloaderIdentityReport:
        """Collect every safely available identity field.

        Board identity and transport identity come from the existing MAVLink
        connection when it is live. The four bootloader protocol fields are only
        populated from a real bootloader transport read; otherwise they stay
        ``None`` and ``refusal`` explains why.

        Read-only throughout: no port is opened, nothing is written, and no
        device state is changed.
        """
        probe = self.probe()
        report = BootloaderIdentityReport(
            transport=probe,
            evidence=list(probe.evidence),
        )

        # Board + transport identity from the live MAVLink link, when present.
        info = mavlink_info
        if info is None and probe.mavlink_alive:
            try:
                from services.setup_service import request_firmware_info

                info = request_firmware_info()
            except Exception as exc:  # pragma: no cover - defensive
                report.warnings.append(f"MAVLink identity read failed: {exc}")
                info = None
        if info and info.get("success"):
            report.board_version = info.get("boardVersion")
            report.board_type = info.get("boardType")
            report.board_rev = info.get("boardRev")
            report.mavlink_connection_type = info.get("connectionType")
            report.system_id = info.get("systemId")
            report.component_id = info.get("componentId")
            report.evidence.append(
                "Board identity read from the live MAVLink AUTOPILOT_VERSION reply."
            )

        if probe.kind == TRANSPORT_MAVLINK:
            report.refusal = (
                "The board is in normal MAVLink mode, so no bootloader identity "
                "can be read. Entering bootloader mode is not performed by this "
                "phase, so the bootloader revision, board id, flash size and "
                "bootloader USB product string remain unknown."
            )
            report.warnings.append(
                "AUTOPILOT_VERSION.board_version is not a manifest board_id and "
                "was not used as one."
            )
            if report.normal_mode_usb_product:
                report.warnings.append(
                    f"USB product string {report.normal_mode_usb_product!r} is a "
                    "normal-mode product string, not bootloader evidence, and was "
                    "not used to infer the platform."
                )
            return report

        if probe.kind == TRANSPORT_NONE:
            report.refusal = "No device is connected, so no identity can be read."
            return report

        if probe.kind == TRANSPORT_UNKNOWN:
            report.refusal = probe.reason
            report.warnings.append(
                "No bootloader protocol traffic was sent to an uncorroborated port."
            )
            return report

        # --- bootloader transport: a real read is the only thing that fills these.
        if self._transport is None:
            report.refusal = (
                "The device presents a bootloader transport, but no bootloader "
                "client is available in this phase, so the bootloader revision, "
                "board id, flash size and bootloader USB product string remain "
                "unknown. Reading them requires no write, but needs a client "
                "that this phase does not provide."
            )
            return report

        result = self._transport.read_identity()
        identity = getattr(result, "identity", None)
        if identity is None or not getattr(identity, "is_usable_for_resolution", False):
            report.refusal = (
                "The bootloader read returned no usable identity: "
                + "; ".join(getattr(identity, "errors", []) or ["no identity returned"])
            )
            report.evidence.extend(getattr(result, "evidence", []) or [])
            return report

        report.bootloader_read_performed = True
        report.bootloader_revision = identity.bootloader_revision
        report.board_id = identity.board_id
        report.flash_size = identity.flash_size
        report.bootloader_usb_product_string = identity.usb_product_string
        report.evidence.append(
            "Bootloader identity read from the bootloader transport: "
            f"revision {identity.bootloader_revision}, board id {identity.board_id}, "
            f"flash size {identity.flash_size}, product "
            f"{identity.usb_product_string!r}."
        )
        return report


def read_bootloader_identity(
    *,
    transport: Any = None,
    ports: Optional[List[Any]] = None,
    mavlink_alive: Optional[bool] = None,
) -> BootloaderIdentityReport:
    """Module-level convenience used by the API and the resolver."""
    return BootloaderIdentityService(
        transport, ports=ports, mavlink_alive=mavlink_alive
    ).read_identity()