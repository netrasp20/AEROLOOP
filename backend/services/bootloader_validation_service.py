"""Explicit bootloader identity validation — state machine and preparation.

This module prepares the application for a bootloader-identity workflow that a
user starts deliberately. It does **not** perform one: nothing here reboots,
erases, flashes, changes a parameter, or commands an actuator, and nothing here
moves the board into bootloader mode.

The central safety rule
-----------------------
A board that stops answering MAVLink is **not** a bootloader. Silence is
evidence of nothing in particular — a crashed process, a powered-down USB
stack, a cable fault or a board mid-reboot all look identical. Transitioning to
``BOOTLOADER_DETECTED`` on silence alone would let the workflow send bootloader
protocol bytes at a device of unknown state.

So ``BOOTLOADER_DETECTED`` is reachable only through the evidence
:class:`~services.bootloader_identity_service.BootloaderIdentityService` already
gathers: the transport must be positively classified as ``BOOTLOADER``, which
itself requires *both* that the board is not answering MAVLink *and* that it
advertises the bootloader's ``<BOARD>-BL`` USB product string. Nothing in this
module can raise that evidence on its own.

What ``prepare_bootloader_identity_validation`` actually does
------------------------------------------------------------
It records *what would have to be true* for a future validation and marks the
workflow as awaiting a bootloader. It does not create one. The user is told what
the next requirement is, and then the board is left completely alone.

The state machine
-----------------
``NORMAL_MAVLINK``            board is answering MAVLink; no bootloader identity
``AWAITING_BOOTLOADER``       preparation done; waiting for the user to act
``BOOTLOADER_DETECTED``       bootloader transport positively evidenced
``BOOTLOADER_IDENTITY_READING``  identity read in progress
``BOOTLOADER_IDENTITY_READ``  a read completed (usable or not)
``IDENTITY_RESOLVED``         identity resolved to one platform, cross-checked
``IDENTITY_AMBIGUOUS``        several platforms remain, or a check disagreed
``IDENTITY_FAILED``           read failed or returned nothing usable
``DISCONNECTED``              no device present

Transitions are validated against :data:`ALLOWED_TRANSITIONS`, so an
out-of-order move is rejected rather than silently accepted.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from services.bootloader_identity_service import (
    TRANSPORT_BOOTLOADER,
    TRANSPORT_MAVLINK,
    TRANSPORT_NONE,
    TRANSPORT_UNKNOWN,
    BootloaderIdentityService,
    UsbPortIdentity,
)

# --- states -----------------------------------------------------------------

NORMAL_MAVLINK = "NORMAL_MAVLINK"
AWAITING_BOOTLOADER = "AWAITING_BOOTLOADER"
BOOTLOADER_DETECTED = "BOOTLOADER_DETECTED"
BOOTLOADER_IDENTITY_READING = "BOOTLOADER_IDENTITY_READING"
BOOTLOADER_IDENTITY_READ = "BOOTLOADER_IDENTITY_READ"
IDENTITY_RESOLVED = "IDENTITY_RESOLVED"
IDENTITY_AMBIGUOUS = "IDENTITY_AMBIGUOUS"
IDENTITY_FAILED = "IDENTITY_FAILED"
DISCONNECTED = "DISCONNECTED"

ALL_STATES = (
    NORMAL_MAVLINK,
    AWAITING_BOOTLOADER,
    BOOTLOADER_DETECTED,
    BOOTLOADER_IDENTITY_READING,
    BOOTLOADER_IDENTITY_READ,
    IDENTITY_RESOLVED,
    IDENTITY_AMBIGUOUS,
    IDENTITY_FAILED,
    DISCONNECTED,
)

#: States in which a bootloader identity is being or has been read.
IDENTITY_STATES = frozenset(
    {
        BOOTLOADER_IDENTITY_READING,
        BOOTLOADER_IDENTITY_READ,
        IDENTITY_RESOLVED,
        IDENTITY_AMBIGUOUS,
        IDENTITY_FAILED,
    }
)

#: States that assert something about the currently attached board, and are
#: therefore meaningless once it is unplugged.
CONNECTION_BOUND_STATES = frozenset(
    {s for s in ALL_STATES if s != DISCONNECTED}
)

#: The only legal moves. Note that ``BOOTLOADER_DETECTED`` is only ever entered
#: from ``AWAITING_BOOTLOADER`` and only with positive bootloader evidence.
ALLOWED_TRANSITIONS: Dict[str, frozenset] = {
    NORMAL_MAVLINK: frozenset(
        {
            AWAITING_BOOTLOADER,
            BOOTLOADER_DETECTED,
            IDENTITY_RESOLVED,
            # A board answering MAVLink can still land on an ambiguous or failed
            # identity — board id 9 spanning several platforms is precisely the
            # honest normal-mode state, so these must be reachable from here.
            IDENTITY_AMBIGUOUS,
            IDENTITY_FAILED,
            DISCONNECTED,
        }
    ),
    AWAITING_BOOTLOADER: frozenset(
        {
            BOOTLOADER_DETECTED,
            NORMAL_MAVLINK,
            IDENTITY_AMBIGUOUS,
            IDENTITY_FAILED,
            DISCONNECTED,
        }
    ),
    BOOTLOADER_DETECTED: frozenset(
        {
            BOOTLOADER_IDENTITY_READING,
            IDENTITY_FAILED,
            DISCONNECTED,
            # A board answering MAVLink is by definition running normal firmware,
            # so any bootloader progress must be abandoned. Without this edge the
            # status path raised IllegalTransition the moment a detected board
            # turned out to be a normal one.
            NORMAL_MAVLINK,
        }
    ),
    BOOTLOADER_IDENTITY_READING: frozenset(
        {
            BOOTLOADER_IDENTITY_READ,
            IDENTITY_RESOLVED,
            IDENTITY_AMBIGUOUS,
            IDENTITY_FAILED,
            DISCONNECTED,
            # A MAVLink reply mid-read invalidates the whole read; see the note
            # on BOOTLOADER_DETECTED.
            NORMAL_MAVLINK,
        }
    ),
    BOOTLOADER_IDENTITY_READ: frozenset(
        {
            IDENTITY_RESOLVED,
            IDENTITY_AMBIGUOUS,
            IDENTITY_FAILED,
            BOOTLOADER_IDENTITY_READING,
            DISCONNECTED,
            # See the note on BOOTLOADER_DETECTED.
            NORMAL_MAVLINK,
        }
    ),
    IDENTITY_RESOLVED: frozenset(
        {
            AWAITING_BOOTLOADER,
            NORMAL_MAVLINK,
            DISCONNECTED,
            IDENTITY_AMBIGUOUS,
            # The board has gone silent with no bootloader evidence, so the
            # resolved identity can no longer be tied to a verified device. It
            # must not keep standing; a port is still enumerated, so this is a
            # failed identification rather than a disconnection.
            IDENTITY_FAILED,
        }
    ),
    IDENTITY_AMBIGUOUS: frozenset(
        {AWAITING_BOOTLOADER, NORMAL_MAVLINK, DISCONNECTED, IDENTITY_FAILED}
    ),
    IDENTITY_FAILED: frozenset(
        {
            AWAITING_BOOTLOADER,
            NORMAL_MAVLINK,
            BOOTLOADER_IDENTITY_READING,
            BOOTLOADER_DETECTED,
            DISCONNECTED,
        }
    ),
    DISCONNECTED: frozenset(
        {
            NORMAL_MAVLINK,
            AWAITING_BOOTLOADER,
            BOOTLOADER_DETECTED,
            # A USB port can reappear silent and uncorroborated (a loose plug, a
            # hub reset). A device is then present but unidentifiable, which is
            # IDENTITY_FAILED rather than staying DISCONNECTED.
            IDENTITY_FAILED,
        }
    ),
}

#: The read-only preparation never performs any of these. Asserted by the test
#: suite: a violation here would mean this phase had grown a physical side
#: effect, which is exactly what it must not do.
FORBIDDEN_OPERATIONS = (
    "reboot",
    "reset",
    "erase",
    "flash",
    "write",
    "upload",
    "program",
    "set_bootloader",
    "enter_bootloader",
    "set_parameter",
    "arm",
    "motor",
    "servo",
    "download",
)


class IllegalTransition(RuntimeError):
    """A state move that the machine does not permit."""


@dataclass
class ValidationRecord:
    """What was captured when the user asked to prepare a validation.

    Every field is a fact about the board as it was at preparation time. Holding
    these is what makes a later bootloader read meaningful: it can be checked
    that the board answering the bootloader is the same board that was here
    before, rather than whatever got plugged in meanwhile.
    """

    prepared: bool = False
    connection_fingerprint: Optional[str] = None
    hardware_fingerprint: Optional[str] = None
    firmware_version: Optional[str] = None
    usb_id: Optional[str] = None
    usb_serial_number: Optional[str] = None
    usb_product_string: Optional[str] = None
    vehicle_type: Optional[str] = None
    autopilot: Optional[str] = None
    #: Why the preparation was allowed, in plain language.
    note: str = ""
    #: Set when preparation was refused, with the reason.
    refused_reason: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "prepared": self.prepared,
            "connectionFingerprint": self.connection_fingerprint,
            "hardwareFingerprint": self.hardware_fingerprint,
            "firmwareVersion": self.firmware_version,
            "usbId": self.usb_id,
            "usbSerialNumber": self.usb_serial_number,
            "usbProductString": self.usb_product_string,
            "vehicleType": self.vehicle_type,
            "autopilot": self.autopilot,
            "note": self.note,
            "refusedReason": self.refused_reason,
        }


@dataclass
class BootloaderValidationMachine:
    """The bootloader-identity state machine, with its captured context.

    Holds no hardware handle. Every observation arrives as an argument, which
    keeps the machine pure and makes it impossible for it to acquire a device on
    its own.
    """

    state: str = NORMAL_MAVLINK
    history: List[Dict[str, Any]] = field(default_factory=list)
    record: ValidationRecord = field(default_factory=ValidationRecord)
    identity: Optional[Dict[str, Any]] = None
    resolution: Optional[Dict[str, Any]] = None
    #: Fields cleared by the last stale-data sweep, for the report.
    last_cleared: List[str] = field(default_factory=list)

    def transition(self, new_state: str, reason: str = "") -> str:
        """Move to ``new_state``, or refuse if the machine disallows it."""
        if new_state not in ALL_STATES:
            raise IllegalTransition(f"Unknown state {new_state!r}.")
        allowed = ALLOWED_TRANSITIONS.get(self.state, frozenset())
        if new_state != self.state and new_state not in allowed:
            raise IllegalTransition(
                f"Cannot move from {self.state} to {new_state}. "
                f"Allowed from {self.state}: {sorted(allowed)}."
            )
        previous = self.state
        self.state = new_state
        if previous != new_state:
            self.history.append({"from": previous, "to": new_state, "reason": reason})
        return new_state

    # -- observation --------------------------------------------------------

    def observe_transport(self, probe: Any) -> str:
        """Update the state from a transport probe alone.

        This is the only path to ``BOOTLOADER_DETECTED``, and it requires
        ``probe.kind == BOOTLOADER`` — which the identity service only reports
        when the board is silent *and* advertises the bootloader's ``-BL``
        product string.

        A silent board classified ``UNKNOWN`` is deliberately parked in
        ``IDENTITY_FAILED``. It is *not* promoted to ``BOOTLOADER_DETECTED``,
        because silence is not bootloader evidence.
        """
        kind = getattr(probe, "kind", TRANSPORT_UNKNOWN)

        if kind == TRANSPORT_NONE:
            return self.transition(
                DISCONNECTED,
                "No autopilot-like USB port is present.",
            )

        if kind == TRANSPORT_MAVLINK:
            if self.state == AWAITING_BOOTLOADER:
                # Still awaiting: the board has not gone anywhere, it is simply
                # still running normal firmware. Preparation stands.
                return self.state
            if self.state in (
                BOOTLOADER_DETECTED,
                BOOTLOADER_IDENTITY_READING,
                BOOTLOADER_IDENTITY_READ,
                IDENTITY_RESOLVED,
                IDENTITY_AMBIGUOUS,
                IDENTITY_FAILED,
            ):
                return self.transition(
                    NORMAL_MAVLINK,
                    "The board is answering MAVLink again, so it is running "
                    "normal firmware rather than a bootloader.",
                )
            return self.transition(NORMAL_MAVLINK, "The board is answering MAVLink.")

        if kind == TRANSPORT_BOOTLOADER:
            if self.state in (BOOTLOADER_IDENTITY_READING, BOOTLOADER_IDENTITY_READ,
                              IDENTITY_RESOLVED, IDENTITY_AMBIGUOUS, IDENTITY_FAILED):
                # Already past detection; nothing to re-announce. Re-polling
                # mid-read must not walk the machine backwards to
                # BOOTLOADER_DETECTED.
                return self.state
            if self.state == DISCONNECTED:
                self.transition(NORMAL_MAVLINK, "A bootloader device is present.")
            return self.transition(
                BOOTLOADER_DETECTED,
                "The board is silent and advertises the bootloader's USB product "
                "string, which together positively identify a bootloader transport.",
            )

        # TRANSPORT_UNKNOWN: silent, nothing corroborates a bootloader.
        if self.state in (NORMAL_MAVLINK, AWAITING_BOOTLOADER):
            return self.state
        return self.transition(
            IDENTITY_FAILED,
            "The board stopped answering MAVLink but advertised no bootloader "
            "product string. Silence is not bootloader evidence, so the board is "
            "not treated as a bootloader.",
        )

    def observe_identity(self, report: Any) -> str:
        """Update the state from a completed identity read."""
        if report.transport.kind != TRANSPORT_BOOTLOADER:
            # No positive bootloader evidence, so nothing about the board's
            # bootloader identity may be concluded.
            self.identity = None
            return self.transition(
                IDENTITY_FAILED,
                "The identity read was refused because the transport is "
                f"{report.transport.kind}, not a bootloader.",
            )

        self.transition(BOOTLOADER_IDENTITY_READING, "Reading bootloader identity.")
        self.identity = report.to_dict()
        self.transition(BOOTLOADER_IDENTITY_READ, "The bootloader read completed.")

        # The identity read is the one place a bootloader identity genuinely
        # comes into existence, so it is recorded here rather than in detection,
        # which only ever reads what was stored by this method.
        try:
            from services import firmware_logging as fwlog

            fwlog.log_event(
                fwlog.IDENTITY_OBSERVED,
                fwlog.IDENTITY,
                outcome="READ",
                bootloaderRevision=getattr(report, "bootloader_revision", None),
                bootloaderBoardId=getattr(report, "board_id", None),
                flashSize=getattr(report, "flash_size", None),
                bootloaderProduct=getattr(
                    report, "bootloader_usb_product_string", None
                ),
                canResolvePlatform=bool(report.can_resolve_platform),
            )
        except Exception:  # pragma: no cover - logging must never raise
            pass

        if report.can_resolve_platform:
            return self.transition(
                IDENTITY_RESOLVED,
                "A complete, validated bootloader identity is available.",
            )
        return self.transition(
            IDENTITY_FAILED,
            "The bootloader read returned no complete identity. Missing: "
            + ", ".join(report.missing_fields),
        )

    def apply_resolution(self, resolution: Dict[str, Any]) -> str:
        """Move to a terminal identity state from a resolver outcome."""
        from services import firmware_compat_service as compat

        self.resolution = resolution
        outcome = resolution.get("outcome")

        if outcome in (compat.EXACT_MATCH, compat.CONFIRMED_COMPATIBLE):
            cross = resolution.get("crossCheck")
            if cross is not None and not cross.get("passed", False):
                return self.transition(
                    IDENTITY_AMBIGUOUS,
                    "The match failed independent verification: "
                    + ", ".join(cross.get("failedChecks", [])),
                )
            return self.transition(IDENTITY_RESOLVED, "Resolved to one platform.")

        if outcome in (compat.AMBIGUOUS, compat.NO_MATCH, compat.UNKNOWN):
            return self.transition(
                IDENTITY_AMBIGUOUS,
                "The catalogue leaves more than one possibility: "
                + str(resolution.get("reason", "")),
            )

        if outcome in (compat.IDENTITY_UNAVAILABLE, compat.NO_DEVICE, compat.UNAVAILABLE):
            return self.transition(
                IDENTITY_FAILED,
                str(resolution.get("reason", "")),
            )

        # UNSUPPORTED lands here, and deliberately NOT in IDENTITY_AMBIGUOUS:
        # an unsupported target has *zero* applicable images, so claiming the
        # catalogue "leaves more than one possibility" would be false. The state
        # set has no dedicated unsupported state, so IDENTITY_FAILED carries it,
        # while the status payload preserves the exact UNSUPPORTED outcome.
        return self.transition(
            IDENTITY_FAILED,
            f"Unsupported target: {str(resolution.get('reason', ''))}",
        )

    # -- stale data ---------------------------------------------------------

    def clear_stale_identity(self, reason: str, same_device: bool) -> List[str]:
        """Drop everything that only made sense for the previous connection.

        ``same_device`` is only ever ``True`` when a *live* fingerprint proves
        the attached board is the identical unit that was previously connected.
        Anything weaker clears the data, because a stale bootloader identity,
        firmware target, confirmation or verification result must never be
        applied to a board that has not been positively identified.

        Returns the list of things cleared, for honest reporting.
        """
        cleared: List[str] = []
        if same_device:
            # Proven same unit: the captured context survives, but a
            # verification result still does not, because the board's *firmware*
            # may have changed while it was away.
            if self.identity is not None:
                cleared.append("verificationState")
                self.resolution = None
            self.last_cleared = cleared
            return cleared

        if self.identity is not None:
            self.identity = None
            cleared.append("bootloaderIdentity")
        if self.resolution is not None:
            self.resolution = None
            cleared.append("resolvedFirmwareCandidate")
        if self.record.prepared:
            self.record = ValidationRecord()
            cleared.append("validationRecord")
        self.last_cleared = cleared
        return cleared

    def reset(self, reason: str = "") -> None:
        self.state = NORMAL_MAVLINK
        self.identity = None
        self.resolution = None
        self.record = ValidationRecord()
        self.last_cleared = []
        self.history.append({"from": DISCONNECTED, "to": NORMAL_MAVLINK, "reason": reason})

    def snapshot(self) -> Dict[str, Any]:
        return {
            "state": self.state,
            "history": list(self.history),
            "record": self.record.to_dict(),
            "identity": self.identity,
            "resolution": self.resolution,
            "lastCleared": list(self.last_cleared),
        }


class BootloaderValidationService:
    """Owns the single validation machine and the preparation operation."""

    def __init__(
        self,
        *,
        identity_service: Optional[BootloaderIdentityService] = None,
        mavlink_info: Optional[Dict[str, Any]] = None,
    ) -> None:
        self.machine = BootloaderValidationMachine()
        self._identity_service = identity_service or BootloaderIdentityService()
        self._mavlink_info = mavlink_info

    # -- preparation --------------------------------------------------------

    def prepare_bootloader_identity_validation(self) -> Dict[str, Any]:
        """Record what a future bootloader validation would need, and stop.

        This is an explicitly requested, user-initiated *preparation*. It does
        not begin a bootloader transition and does not touch the board:

        * no reboot, and in particular no reboot-into-bootloader
        * no erase
        * no flash or firmware write
        * no parameter change
        * no actuator command
        * no downloader contact

        It captures the connection and hardware fingerprints, the current
        firmware identity and the USB descriptor identity, marks the workflow
        as awaiting a bootloader, and invalidates any stale identity data so a
        later read cannot inherit an old answer.
        """
        from services import firmware_workflow_service as wf

        probe = self._identity_service.probe()

        if probe.kind == TRANSPORT_NONE:
            self.machine.record = ValidationRecord(
                refused_reason=(
                    "No device is connected, so there is no identity to prepare "
                    "a bootloader validation against."
                )
            )
            return self._refusal(
                "No device is connected. Connect the board and try again.",
                probe,
            )

        if probe.kind == TRANSPORT_MAVLINK:
            # The normal, expected case: a board running normal firmware.
            detection = wf.detect(include_identity=True)
            if not detection.get("connected"):
                return self._refusal(
                    "The board is not answering MAVLink, so its firmware "
                    "identity could not be captured.",
                    probe,
                )

            connection_fp = wf.connection_fingerprint(detection)
            hardware_fp = wf.hardware_fingerprint(detection)
            port = probe.port

            # Stale identity data from any earlier connection is dropped *before*
            # the fresh capture, so the sweep cannot wipe what was just recorded.
            cleared = self.machine.clear_stale_identity(
                "Preparing a fresh bootloader identity validation.", False
            )

            self.machine.record = ValidationRecord(
                prepared=True,
                connection_fingerprint=connection_fp,
                hardware_fingerprint=hardware_fp,
                firmware_version=detection.get("firmwareVersion"),
                usb_id=port.usb_id if port else None,
                usb_serial_number=port.serial_number if port else None,
                usb_product_string=port.product if port else None,
                vehicle_type=detection.get("vehicleType"),
                autopilot=detection.get("autopilot"),
                note=(
                    "Captured the connected board's identity. Nothing was written "
                    "to it and it was not moved into bootloader mode."
                ),
            )

            self.machine.observe_transport(probe)
            try:
                self.machine.transition(
                    AWAITING_BOOTLOADER,
                    "Preparation complete; awaiting an explicitly initiated "
                    "bootloader transition.",
                )
            except IllegalTransition:
                pass

            return {
                "success": True,
                "prepared": True,
                "state": self.machine.state,
                "nextRequirement": (
                    "Exact hardware compatibility requires a bootloader identity "
                    "(bootloader revision, board id, flash size and the "
                    "bootloader's USB product string). This service will not "
                    "move the board into bootloader mode. Until that identity "
                    "is read, installation stays blocked."
                ),
                "record": self.machine.record.to_dict(),
                "clearedStaleData": cleared,
                "transport": probe.to_dict(),
                "performedOperations": [],
                "message": (
                    "Bootloader identity validation prepared. The board was "
                    "left exactly as it was: not rebooted, not erased, not "
                    "flashed, no parameters changed."
                ),
            }

        if probe.kind == TRANSPORT_BOOTLOADER:
            # A bootloader is already present and positively evidenced.
            self.machine.observe_transport(probe)
            return {
                "success": True,
                "prepared": True,
                "state": self.machine.state,
                "nextRequirement": (
                    "A bootloader transport is already present, so an identity "
                    "read can proceed."
                ),
                "record": self.machine.record.to_dict(),
                "clearedStaleData": [],
                "transport": probe.to_dict(),
                "performedOperations": [],
                "message": "A bootloader transport is already present.",
            }

        # UNKNOWN: silent, uncorroborated. Refuse — and specifically do not treat
        # this as a bootloader.
        return self._refusal(
            "The board is not answering MAVLink, but it advertised no bootloader "
            "product string, so it cannot be identified as a bootloader. Silence "
            "is not bootloader evidence.",
            probe,
            treat_as_bootloader=False,
        )

    def _refusal(
        self,
        reason: str,
        probe: Any,
        treat_as_bootloader: bool = False,
    ) -> Dict[str, Any]:
        self.machine.record = ValidationRecord(refused_reason=reason)
        if treat_as_bootloader:
            self.machine.observe_transport(probe)
        else:
            # Parked deliberately: not treated as a bootloader, and not treated
            # as a normal link either.
            if probe.kind == TRANSPORT_UNKNOWN:
                try:
                    self.machine.transition(
                        IDENTITY_FAILED,
                        "Silent board with no bootloader evidence; not a bootloader.",
                    )
                except IllegalTransition:
                    pass
        return {
            "success": False,
            "prepared": False,
            "state": self.machine.state,
            "reason": reason,
            "refused": True,
            "treatedAsBootloader": False,
            "transport": probe.to_dict(),
            "performedOperations": [],
            "message": reason,
        }

    # -- cancellation -------------------------------------------------------

    def cancel(self, reason: str = "Cancelled by the operator.") -> Dict[str, Any]:
        """Abandon a prepared validation and drop its captured context.

        Read-only with respect to the board: it only forgets what was recorded.
        """
        cleared = self.machine.clear_stale_identity(reason, False)
        self.machine.reset(reason)
        return {
            "success": True,
            "state": self.machine.state,
            "clearedStaleData": cleared,
            "performedOperations": [],
            "message": (
                "The pending bootloader identity validation was cancelled. No "
                "bootloader identity data is retained."
            ),
        }

    # -- stale data on disconnect / reconnect -------------------------------

    def handle_connection_change(
        self,
        *,
        connected: bool,
        connection_fingerprint: Optional[str] = None,
        hardware_fingerprint: Optional[str] = None,
    ) -> List[str]:
        """Drop identity data that no longer provably belongs to this board.

        Called on disconnect and again on reconnect. Nothing survives unless a
        *live* fingerprint pair proves the attached unit is the identical board
        that was previously connected — and even then a verification result is
        dropped, because the firmware may have changed while it was away.

        Returns the list of cleared field names.
        """
        if not connected:
            cleared = self.machine.clear_stale_identity(
                "The device disconnected.", False
            )
            try:
                self.machine.transition(DISCONNECTED, "The device disconnected.")
            except IllegalTransition:
                pass
            return cleared

        same_device = bool(
            self.machine.record.prepared
            and connection_fingerprint is not None
            and hardware_fingerprint is not None
            and self.machine.record.connection_fingerprint == connection_fingerprint
            and self.machine.record.hardware_fingerprint == hardware_fingerprint
        )
        cleared = self.machine.clear_stale_identity(
            "The device reconnected.", same_device
        )
        if self.machine.state == DISCONNECTED:
            try:
                self.machine.transition(NORMAL_MAVLINK, "A device reconnected.")
            except IllegalTransition:
                pass
        return cleared

    # -- read + resolve -----------------------------------------------------

    def observe(self) -> Dict[str, Any]:
        """Observe the current transport and, when permitted, read identity.

        This is the only place that can move into ``BOOTLOADER_DETECTED``, and
        it does so solely on the identity service's own evidence.
        """
        report = self._identity_service.read_identity(mavlink_info=self._mavlink_info)
        self.machine.observe_transport(report.transport)
        if report.transport.kind == TRANSPORT_BOOTLOADER:
            self.machine.observe_identity(report)
        return report.to_dict()

    def snapshot(self) -> Dict[str, Any]:
        return self.machine.snapshot()


#: Process-wide validation service.
SERVICE = BootloaderValidationService()


def prepare_bootloader_identity_validation() -> Dict[str, Any]:
    """Module-level entry point for the explicit preparation operation."""
    return SERVICE.prepare_bootloader_identity_validation()


def validation_snapshot() -> Dict[str, Any]:
    return SERVICE.snapshot()


def assert_no_physical_operations(names: List[str]) -> None:
    """Guard used by the tests: no forbidden operation may appear."""
    for name in names:
        lowered = str(name).lower()
        for forbidden in FORBIDDEN_OPERATIONS:
            assert forbidden not in lowered, f"forbidden operation exposed: {name}"

# ---------------------------------------------------------------------------
# Phase 1 — bootloader identity status
# ---------------------------------------------------------------------------

#: Resolver outcomes this phase can report. Kept to the five the workflow is
#: allowed to produce for an identity decision.
REPORTABLE_OUTCOMES = (
    "EXACT_MATCH",
    "AMBIGUOUS",
    "IDENTITY_UNAVAILABLE",
    "UNSUPPORTED",
    "NO_DEVICE",
)


def identity_status(
    *,
    service: Optional[BootloaderValidationService] = None,
) -> Dict[str, Any]:
    """A clear, read-only description of the current identity situation.

    Reports, without fabricating anything:

    * the current transport classification
    * whether MAVLink is connected or disconnected
    * whether a bootloader identity is available
    * bootloader revision / board id / flash size / product string, if available
    * USB VID/PID and USB serial
    * the identity resolver's result

    Every field that could not be obtained is reported as ``None`` together with
    the reason, never as a placeholder value.
    """
    svc = service or SERVICE
    from services import firmware_compat_service as compat
    from services import firmware_workflow_service as wf

    report = svc.observe()
    transport = report["transport"]
    kind = transport["kind"]
    mavlink_connected = bool(transport.get("mavlinkAlive"))

    available = bool(report.get("canResolvePlatform"))

    resolution = _resolve_with_bootloader_evidence(svc)
    resolver = _resolver_summary(resolution)

    return {
        "success": True,
        "state": svc.machine.state,
        "transport": kind,
        "mavlinkConnected": mavlink_connected,
        "mavlinkConnectionType": report.get("mavlinkConnectionType"),
        "bootloaderIdentityAvailable": available,
        "bootloaderIdentityReadPerformed": bool(
            report.get("bootloaderReadPerformed")
        ),
        "bootloaderRevision": report.get("bootloaderRevision"),
        "boardId": report.get("boardId"),
        "flashSize": report.get("flashSize"),
        "bootloaderProductString": report.get("bootloaderUsbProductString"),
        "usbVendorId": report.get("usbVendorId"),
        "usbProductId": report.get("usbProductId"),
        "usbId": report.get("usbId"),
        "usbSerialNumber": report.get("usbSerialNumber"),
        "usbProductString": report.get("usbProductString"),
        "usbProductIsBootloaderEvidence": bool(
            report.get("usbProductIsBootloaderEvidence")
        ),
        "boardVersion": report.get("boardVersion"),
        "boardType": report.get("boardType"),
        "boardRev": report.get("boardRev"),
        "systemId": report.get("systemId"),
        "componentId": report.get("componentId"),
        "missingFields": report.get("missingFields", []),
        "refusal": report.get("refusal", ""),
        "warnings": report.get("warnings", []),
        "resolver": resolver,
        "validation": svc.snapshot(),
        "installationBlocked": not resolver["canConfirm"],
        "performedOperations": [],
    }


# ---------------------------------------------------------------------------
# Phase 5 — identity resolution with bootloader evidence
# ---------------------------------------------------------------------------


def _resolve_with_bootloader_evidence(svc: BootloaderValidationService) -> Any:
    """Resolve compatibility, feeding in any genuine bootloader identity.

    When the validation machine holds a *complete, validated* bootloader
    identity it is folded into the resolver's evidence, so the resolver can use
    the bootloader product string and board id — and so its official-manifest
    cross-check has something real to verify.

    When no such identity exists the normal-mode rules apply unchanged. Nothing
    is inferred: a missing identity never becomes a guess.
    """
    from services import firmware_compat_service as compat
    from services import firmware_catalog_service as catalog_service
    from services import firmware_workflow_service as wf

    identity = wf.build_identity()
    rebuilt = _rebuild_bootloader_identity(svc.machine.identity)

    if identity is None:
        # A board in bootloader mode is *by definition* not answering MAVLink,
        # so the usual identity source is unavailable here. That must not be
        # mistaken for "no device": if a complete bootloader identity was read
        # and the preparation record proves it is the same unit, resolve from
        # that instead of discarding what was genuinely learned.
        if rebuilt is None:
            return None
        identity = _identity_from_preparation_record(svc, rebuilt)
        if identity is None:
            return None
    # A MAVLink identity already carries any stored bootloader evidence, because
    # ``wf.build_identity`` folds it in for every caller -- deliberately, so the
    # workflow and catalogue routes cannot disagree.

    catalog = catalog_service.get_catalog(identity.manifest_vehicle)
    resolution = compat.resolve(
        catalog.candidates,
        identity,
        catalog_available=catalog.ok,
        catalog_message=catalog.message,
    )
    return resolution


def apply_stored_identity(identity: Any) -> Any:
    """Fold this machine's stored bootloader identity into a resolver identity.

    This is the single place that decides whether an observation which was read
    earlier may narrow a *live* resolution. Every consumer goes through it --
    the workflow route, the catalogue route and the validation status alike -- so
    one board cannot produce two different compatibility answers depending on
    which endpoint is asked.

    The stored dict is never trusted directly; it is rebuilt through the
    validator first, so an incomplete or invalid observation stays unusable. When
    there is nothing usable the identity is returned unchanged, which is what
    leaves normal-mode resolution rules in force for a board that has never been
    read.
    """
    from services import firmware_compat_service as compat

    rebuilt = _rebuild_bootloader_identity(SERVICE.machine.identity)
    if rebuilt is None:
        return identity
    return compat.apply_bootloader_identity(
        identity,
        type(
            "StoredResult",
            (),
            {
                "identity": rebuilt.identity,
                "evidence": [
                    "Bootloader identity read earlier in this validation workflow.",
                ],
            },
        )(),
    )


def _rebuild_bootloader_identity(report: Any) -> Any:
    """Re-validate a stored bootloader report and return its usable identity.

    The stored dict is never trusted on its own: it is rebuilt through
    ``bootloader_identity.build_identity`` so that the validator keeps the final
    say. Anything incomplete comes back as ``None``, which callers must treat as
    "no identity" rather than "some identity".
    """
    if not report or not report.get("canResolvePlatform"):
        return None

    from services.bootloader_identity import build_identity

    rebuilt = build_identity(
        bootloader_revision=report.get("bootloaderRevision"),
        board_id=report.get("boardId"),
        flash_size=report.get("flashSize"),
        usb_product_string=report.get("bootloaderUsbProductString"),
        source=report.get("source") or "BOOTLOADER",
    )
    if not rebuilt.identity.is_usable_for_resolution:
        return None
    return rebuilt


def _identity_from_preparation_record(svc: BootloaderValidationService, rebuilt: Any) -> Any:
    """Build resolver evidence from the captured preparation record.

    Used only in bootloader mode, where no MAVLink reply is possible. The vehicle
    type comes from what the board itself reported while it was still running
    normal firmware, and it is only trusted when the record's USB identity still
    matches the device actually on the bus right now. That record is cleared on
    disconnect and on any fingerprint mismatch, so a swapped board cannot lend
    its vehicle type to another unit.

    Returns ``None`` when there is no such proof, leaving the caller to report
    the honest outcome rather than guessing.
    """
    from services import firmware_compat_service as compat

    record = svc.machine.record
    if not record.prepared or not record.vehicle_type or not record.autopilot:
        return None

    current = svc.machine.identity or {}
    for captured, present in (
        (record.usb_id, current.get("usbId")),
        (record.usb_serial_number, current.get("usbSerialNumber")),
    ):
        if not captured or not present or captured != present:
            # Not proven to be the same unit: the captured vehicle type is not
            # evidence about whatever is on the bus now.
            return None

    # Reuse the existing firmware-info mapping so there is exactly one
    # ArduCopter -> manifest-vehicle rule in the codebase.
    identity = compat.identity_from_firmware_info(
        {
            "success": True,
            "connected": True,
            "autopilot": record.autopilot,
            "vehicleType": record.vehicle_type,
            "version": record.firmware_version or "",
            "connectionType": "USB",
        },
        is_sitl=False,
    )
    identity.evidence.append(
        "Vehicle type and autopilot taken from the prepared record for this "
        "same USB device, because a board in bootloader mode cannot report "
        "them over MAVLink."
    )
    return compat.apply_bootloader_identity(
        identity,
        type("StoredResult", (), {"identity": rebuilt.identity, "evidence": []})(),
    )


def _resolver_summary(resolution: Any) -> Dict[str, Any]:
    """Summarise a resolver outcome for the status payload.

    ``None`` (nothing connected) becomes ``NO_DEVICE`` rather than an exception,
    so the status endpoint always answers with a real, honest outcome.
    """
    from services import firmware_compat_service as compat

    if resolution is None:
        return {
            "outcome": "NO_DEVICE",
            "reason": (
                "No device is connected, so there is no hardware identity to "
                "resolve firmware compatibility against."
            ),
            "canConfirm": False,
            "selected": None,
            "signalsUsed": [],
            "crossCheck": None,
            "platformCount": None,
        }

    cross = resolution.cross_check
    return {
        "outcome": resolution.outcome,
        "reason": resolution.reason,
        "canConfirm": bool(resolution.can_confirm),
        "selected": resolution.selected.to_dict() if resolution.selected else None,
        "signalsUsed": list(resolution.signals_used),
        "crossCheck": cross.to_dict() if cross else None,
        "platformCount": resolution.platform_count,
        "platforms": list(resolution.platforms),
    }
