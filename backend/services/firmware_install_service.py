"""Firmware installer abstraction and the authoritative workflow state machine.

Separation of concerns
----------------------
Four independent responsibilities, one per module:

===========================  ==========================================
``firmware_catalog_service``  official manifest → candidates
``firmware_compat_service``   identity + manifest → resolution
``firmware_download_service`` verified artifact download
``firmware_install_service``  this module: installation
===========================  ==========================================

The UI never talks to an installer or a bootloader directly; it renders the
state this module publishes.

The installer interface
-----------------------
:class:`FirmwareInstaller` is deliberately small and transport-agnostic:

``prepare`` → ``install`` → ``progress`` → ``verify`` → ``cleanup``

It has no serial, no MAVLink and no bootloader awareness. A
:class:`RealFirmwareInstaller` would need all three, which is exactly why it must
not live behind the same interface as the simulation.

Two implementations
--------------------
:class:`TestFirmwareInstaller`
    A complete, honest simulation. Deterministic progress. Labeled
    ``TEST / SIMULATION``. It **cannot** reach hardware: it holds no device
    handle and every method is pure computation.

:class:`RealFirmwareInstaller`
    Structure only, permanently gated. ``installation_allowed`` is a hard
    ``False`` and :meth:`RealFirmwareInstaller.install` always raises. There is
    deliberately no configuration flag that can enable it.

The safety gate
---------------
:data:`REAL_INSTALLATION_ALLOWED` is a module constant ``False``, not an
environment variable. :func:`assert_installation_allowed` is the single choke
point and raises unconditionally, so any future caller must pass through it and
cannot bypass it by construction.

Workflow state machine
----------------------
The backend is authoritative. Every transition is recorded in
:attr:`InstallationSession.history`, so a client cannot invent a state, and a
``COMPLETED`` state can only be reached by re-reading the vehicle's actual
``AUTOPILOT_VERSION`` and comparing it with the expected target.
"""

from __future__ import annotations

import abc
import threading
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

TEST_LABEL = "TEST / SIMULATION"
REAL_LABEL = "REAL HARDWARE"

# ---------------------------------------------------------------------------
# Workflow states
# ---------------------------------------------------------------------------

IDLE = "IDLE"
DETECTING = "DETECTING"
IDENTIFYING = "IDENTIFYING"
RESOLVING = "RESOLVING"
READY = "READY"
CONFIRMATION_REQUIRED = "CONFIRMATION_REQUIRED"
DOWNLOADING = "DOWNLOADING"
DOWNLOAD_VERIFIED = "DOWNLOAD_VERIFIED"
PREPARING = "PREPARING"
INSTALLING = "INSTALLING"
VERIFYING = "VERIFYING"
COMPLETED = "COMPLETED"
FAILED = "FAILED"
CANCELLED = "CANCELLED"
DISCONNECTED = "DISCONNECTED"
BLOCKED = "BLOCKED"

#: Post-install verification re-read the board and something did not match what
#: the installation was supposed to produce.
VERIFICATION_MISMATCH = "VERIFICATION_MISMATCH"

#: Post-install verification could not confirm anything, e.g. the board stopped
#: answering or stopped reporting its identity. Distinct from a mismatch: the
#: installation may well be correct, but it was not proven.
VERIFICATION_UNCONFIRMED = "VERIFICATION_UNCONFIRMED"

WORKFLOW_STATES = (
    IDLE,
    DETECTING,
    IDENTIFYING,
    RESOLVING,
    READY,
    CONFIRMATION_REQUIRED,
    DOWNLOADING,
    DOWNLOAD_VERIFIED,
    PREPARING,
    INSTALLING,
    VERIFYING,
    COMPLETED,
    FAILED,
    CANCELLED,
    DISCONNECTED,
    BLOCKED,
)

#: States in which the vehicle connection is required. Losing it mid-flight
#: stops the workflow rather than reporting a result.
CONNECTION_DEPENDENT_STATES = frozenset(
    {
        DETECTING,
        IDENTIFYING,
        RESOLVING,
        READY,
        CONFIRMATION_REQUIRED,
        DOWNLOADING,
        DOWNLOAD_VERIFIED,
        PREPARING,
        INSTALLING,
        VERIFYING,
    }
)
"""Every state that asserts something about the connected vehicle.

Losing the vehicle invalidates all of them at once. ``READY`` and
``CONFIRMATION_REQUIRED`` are included because both present the user with a
firmware target for a board that is no longer there, and ``DOWNLOAD_VERIFIED``
because a verified artifact staged for a board is meaningless once the board
disappears. Only states that assert nothing about the connection survive.
"""

#: States that mean the operation has finished, one way or another.
TERMINAL_STATES = frozenset({COMPLETED, FAILED, CANCELLED, DISCONNECTED, BLOCKED})

#: Real-hardware operations that remain forbidden in this phase.
BLOCKED_OPERATIONS = (
    "enter-bootloader",
    "bootloader-erase",
    "bootloader-program",
    "bootloader-verify",
    "bootloader-reboot",
    "reboot-for-flashing",
    "firmware-install",
)

#: The only truthful reason to refuse an installation on real hardware.
REAL_HARDWARE_REFUSAL = (
    "Firmware installation is currently disabled for real hardware validation."
)

#: Hard gate. Not an environment variable; there is no way to set this True.
REAL_INSTALLATION_ALLOWED = False


class InstallationBlockedError(RuntimeError):
    """Raised whenever a real firmware installation is attempted."""


class InstallationFailedError(RuntimeError):
    """Raised when an installation does not complete."""


# ---------------------------------------------------------------------------
# Installer interface
# ---------------------------------------------------------------------------


@dataclass
class InstallProgress:
    """Progress reported by an installer.

    ``indeterminate`` exists because real progress must never be fabricated. If
    an installer cannot report meaningful progress it sets ``percent = None``
    and ``indeterminate = True``; the UI shows an activity indicator instead of
    invented numbers.
    """

    state: str
    percent: Optional[float] = None
    indeterminate: bool = False
    message: str = ""
    is_simulation: bool = False

    def to_dict(self) -> Dict[str, Any]:
        return {
            "state": self.state,
            "percent": self.percent,
            "indeterminate": self.indeterminate,
            "message": self.message,
            "isSimulation": self.is_simulation,
        }


@dataclass
class InstallResult:
    """Outcome of one installation attempt."""

    ok: bool
    state: str
    message: str = ""
    mode: str = TEST_LABEL
    is_simulation: bool = True
    hardware_touched: bool = False
    expected_version: Optional[str] = None
    observed_version: Optional[str] = None
    version_verified: bool = False
    progress: List[InstallProgress] = field(default_factory=list)
    error: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "success": self.ok,
            "state": self.state,
            "message": self.message,
            "mode": self.mode,
            "isSimulation": self.is_simulation,
            "hardwareTouched": self.hardware_touched,
            "expectedVersion": self.expected_version,
            "observedVersion": self.observed_version,
            "versionVerified": self.version_verified,
            "progress": [p.to_dict() for p in self.progress],
            "error": self.error,
        }


@dataclass
class VerificationResult:
    """Independent post-install verification of what the board now reports.

    Verification is a separate responsibility from installation: an installer
    may report ``COMPLETED``, but the workflow only accepts that result when a
    :meth:`FirmwareInstaller.verify` call independently re-reads the board.

    The firmware version is only part of the proof. A correct version on the
    wrong board, or on the wrong vehicle, is not a successful installation, so
    the board identity, vehicle type and autopilot type are checked too and any
    mismatch fails verification with :data:`VERIFICATION_MISMATCH`.
    """

    verified: bool
    expected_version: Optional[str] = None
    observed_version: Optional[str] = None
    source: str = ""
    message: str = ""
    #: Expected identity, captured before the installation started.
    expected_identity: Optional[Dict[str, Any]] = None
    #: Identity actually re-read from the board after installation.
    observed_identity: Optional[Dict[str, Any]] = None
    #: Per-field comparison results; ``matches`` is False for any mismatch.
    checks: List[Dict[str, Any]] = field(default_factory=list)

    @property
    def mismatches(self) -> List[str]:
        return [c["field"] for c in self.checks if not c["matches"]]

    @property
    def error(self) -> str:
        """Why verification failed, as a stable machine-readable code."""
        if self.verified:
            return ""
        return VERIFICATION_MISMATCH if self.mismatches else VERIFICATION_UNCONFIRMED

    def to_dict(self) -> Dict[str, Any]:
        return {
            "verified": self.verified,
            "error": self.error,
            "expectedVersion": self.expected_version,
            "observedVersion": self.observed_version,
            "expectedIdentity": self.expected_identity,
            "observedIdentity": self.observed_identity,
            "checks": self.checks,
            "mismatches": self.mismatches,
            "source": self.source,
            "message": self.message,
        }


class FirmwareInstaller(abc.ABC):
    """Installation contract: ``prepare`` → ``install`` → ``verify``.

    Implementations are given a verified artifact and an expected version, and
    must report honestly. They must never report success without evidence, and
    ``verify`` must never assume the observed version equals the expected one.
    """

    #: ``TEST / SIMULATION`` or ``REAL HARDWARE``.
    mode: str = ""
    #: True when the implementation cannot possibly touch hardware.
    is_simulation: bool = True
    #: Whether this installer may run against a real vehicle.
    installation_allowed: bool = False

    @abc.abstractmethod
    def prepare(self, artifact_path: str, expected_version: str) -> InstallProgress:
        """Validate preconditions without changing anything."""

    @abc.abstractmethod
    def install(self) -> InstallResult:
        """Perform the installation and report the result."""

    @abc.abstractmethod
    def verify(self) -> VerificationResult:
        """Re-read the ACTUAL installed version and compare it with the target.

        Implementations must obtain the observed version from an independent
        source (the vehicle for real hardware, the injected provider for the
        simulation). Returning ``verified=True`` without comparing an observed
        value against the target is a bug, not an optimisation.
        """

    @abc.abstractmethod
    def progress(self) -> List[InstallProgress]:
        """Progress recorded so far, oldest first."""

    def cancel(self) -> bool:
        """Request cancellation if the implementation supports it.

        Optional: implementations that cannot be interrupted simply do not
        override this. The return value says whether cancellation was actually
        requested — never whether it succeeded.
        """
        return False

    @abc.abstractmethod
    def cleanup(self) -> None:
        """Release resources. Never reports success."""


# ---------------------------------------------------------------------------
# Real hardware: structure only, permanently gated
# ---------------------------------------------------------------------------


class RealFirmwareInstaller(FirmwareInstaller):
    """Real-device installer skeleton. **Permanently disabled.**

    The class exists so the eventual real implementation has a defined place and
    the safety gate has a single, testable choke point. It performs no I/O.

    Every method either raises or returns a refusal. Nothing here opens a port,
    sends a MAVLink command or touches a bootloader.
    """

    mode = REAL_LABEL
    is_simulation = False
    installation_allowed = REAL_INSTALLATION_ALLOWED

    def __init__(self, *_args: Any, **_kwargs: Any) -> None:
        self._progress: List[InstallProgress] = []
        self._artifact_path: str = ""
        self._expected_version: str = ""

    @staticmethod
    def _refuse(operation: str) -> "InstallationBlockedError":
        return InstallationBlockedError(
            f"{REAL_HARDWARE_REFUSAL} Operation refused: {operation}. "
            f"Blocked operations: {', '.join(BLOCKED_OPERATIONS)}."
        )

    def prepare(self, artifact_path: str = "", expected_version: str = "") -> InstallProgress:
        raise self._refuse("prepare")

    def install(self) -> InstallResult:
        raise self._refuse("install")

    def verify(self) -> VerificationResult:
        raise self._refuse("verify")

    def cancel(self) -> bool:
        return False

    def progress(self) -> List[InstallProgress]:
        return list(self._progress)

    def cleanup(self) -> None:
        self._progress.clear()
        self._artifact_path = ""
        self._expected_version = ""

    # Explicit capability report, for tests and the capability endpoint.
    @staticmethod
    def capability() -> Dict[str, Any]:
        return {
            "mode": REAL_LABEL,
            "installationAllowed": REAL_INSTALLATION_ALLOWED,
            "blockedOperations": list(BLOCKED_OPERATIONS),
            "message": REAL_HARDWARE_REFUSAL,
        }


def assert_installation_allowed(operation: str = "firmware-install") -> None:
    """Single choke point for real installation. Always raises.

    There is deliberately no flag that can enable this: the gate is a module
    constant, so environment variables and config files cannot open it.
    """
    raise InstallationBlockedError(
        f"{REAL_HARDWARE_REFUSAL} Operation refused: {operation}. "
        f"Blocked operations: {', '.join(BLOCKED_OPERATIONS)}."
    )


def install_firmware(*_args: Any, **_kwargs: Any) -> Dict[str, Any]:
    """Attempt a real installation. Always blocked — see the gate above."""
    assert_installation_allowed("firmware-install")
    raise AssertionError("unreachable")  # pragma: no cover


# ---------------------------------------------------------------------------
# TEST / SIMULATION installer
# ---------------------------------------------------------------------------


class TestFirmwareInstaller(FirmwareInstaller):
    """A complete simulated installation. **TEST / SIMULATION only.**

    This is a genuine implementation of :class:`FirmwareInstaller`, not a stub:
    it walks every phase, emits deterministic progress, and verifies the result
    against an injected *observed* version. But it is pure computation — it
    holds no device handle, opens no port, sends no MAVLink message, and cannot
    reach hardware under any circumstances.

    Determinism
    -----------
    The default step plan is fixed and identical on every run, so tests can
    assert exact percentages. ``fail_at`` and ``step_plan`` are injectable for
    failure-path tests.

    Honest verification
    -------------------
    :meth:`install` marks itself ``COMPLETED`` **only** when the injected
    ``observed_version`` equals ``expected_version``. Passing the expected
    version in and echoing it back is not how this works: the caller supplies the
    version it *actually observed* on the vehicle, and a mismatch yields
    ``FAILED``.
    """

    mode = TEST_LABEL
    is_simulation = True
    installation_allowed = True

    #: Fixed plan, shared by every default run.
    DEFAULT_STEPS = (
        (PREPARING, 0.0, "Preparing the simulated installation."),
        (INSTALLING, 10.0, "Simulating firmware transfer."),
        (INSTALLING, 25.0, "Simulating firmware transfer."),
        (INSTALLING, 50.0, "Simulating firmware transfer."),
        (INSTALLING, 75.0, "Simulating firmware transfer."),
        (VERIFYING, 90.0, "Simulating post-install verification."),
        (VERIFYING, 95.0, "Simulating post-install verification."),
    )

    def __init__(
        self,
        artifact_path: str = "",
        expected_version: str = "",
        observed_version: Optional[str] = None,
        observed_version_provider: Optional[Callable[[], Optional[str]]] = None,
        fail_at: Optional[str] = None,
        step_plan: Optional[List[Any]] = None,
    ) -> None:
        self._artifact_path = artifact_path
        self._expected_version = expected_version
        # Injected so the caller supplies what the vehicle ACTUALLY reported.
        self._observed_version = observed_version
        self._observed_version_provider = observed_version_provider
        self._fail_at = fail_at
        self._step_plan = step_plan
        self._progress: List[InstallProgress] = []
        self._prepared = False
        self._cancelled = False

    @property
    def prepared(self) -> bool:
        return self._prepared

    def cancel(self) -> bool:
        """Request cancellation. Returns whether cancellation was requested."""
        self._cancelled = True
        return True

    def _record(self, state: str, percent: Optional[float], message: str) -> InstallProgress:
        progress = InstallProgress(
            state=state,
            percent=percent,
            indeterminate=percent is None,
            message=message,
            is_simulation=True,
        )
        self._progress.append(progress)
        return progress

    def prepare(self, artifact_path: str = "", expected_version: str = "") -> InstallProgress:
        if artifact_path:
            self._artifact_path = artifact_path
        if expected_version:
            self._expected_version = expected_version
        if not self._artifact_path:
            return self._record(
                FAILED, None, "No verified firmware artifact was supplied to the simulator."
            )
        self._prepared = True
        return self._record(
            PREPARING,
            0.0,
            f"{TEST_LABEL}: prepared {self._artifact_path} (no hardware involved).",
        )

    def install(self) -> InstallResult:
        """Run the simulated transfer.

        This reports whether the *transfer* completed. It deliberately does not
        decide that the installation succeeded: the version comparison lives in
        :meth:`verify`, so the workflow cannot accept an installer's own claim
        as proof.
        """
        if not self._prepared:
            return InstallResult(
                ok=False,
                state=FAILED,
                message=f"{TEST_LABEL}: prepare() must run before install().",
                error="prepare-not-called",
            )

        plan = self._step_plan or list(self.DEFAULT_STEPS)
        for state, percent, message in plan:
            if self._cancelled:
                return InstallResult(
                    ok=False,
                    state=CANCELLED,
                    message=f"{TEST_LABEL}: cancelled by the caller.",
                    progress=self.progress(),
                    error="cancelled",
                )
            if self._fail_at is not None and state == self._fail_at:
                self._record(FAILED, None, f"{TEST_LABEL}: simulated failure at {state}.")
                return InstallResult(
                    ok=False,
                    state=FAILED,
                    message=f"{TEST_LABEL}: simulated failure during {state}.",
                    progress=self.progress(),
                    error="simulated-failure",
                )
            self._record(state, percent, f"{TEST_LABEL}: {message}")

        return InstallResult(
            ok=True,
            state=INSTALLING,
            message=(
                f"{TEST_LABEL}: simulated transfer completed. Verification has not "
                "run yet."
            ),
            expected_version=self._expected_version,
            observed_version=None,
            version_verified=False,
            progress=self.progress(),
        )

    def _read_observed_version(self) -> Optional[str]:
        if self._observed_version_provider is not None:
            return self._observed_version_provider()
        return self._observed_version

    def verify(self) -> VerificationResult:
        """Compare the independently observed version with the target.

        The observed value comes from the injected provider (in production
        :func:`services.firmware_workflow_service.verify_installed_version`, which
        re-reads ``AUTOPILOT_VERSION``). Nothing is assumed: an unset or
        different observed version fails verification.
        """
        observed = self._read_observed_version()
        expected = self._expected_version
        verified = versions_match(expected, observed)
        if verified:
            message = (
                f"{TEST_LABEL}: verified installed version {observed} against the "
                f"target {expected}."
            )
        elif observed is None:
            message = (
                f"{TEST_LABEL}: verification could not be performed because no "
                "installed version was observed."
            )
        else:
            message = (
                f"{TEST_LABEL}: expected {expected!r} but observed {observed!r}; "
                "verification failed."
            )
        self._record(
            VERIFYING if not verified else COMPLETED,
            100.0 if verified else None,
            message,
        )
        return VerificationResult(
            verified=verified,
            expected_version=expected,
            observed_version=observed,
            source="simulated-observation",
            message=message,
        )

    def progress(self) -> List[InstallProgress]:
        return list(self._progress)

    def cleanup(self) -> None:
        self._progress.clear()
        self._prepared = False


# ---------------------------------------------------------------------------
# Version comparison
# ---------------------------------------------------------------------------


def normalize_version(value: Optional[str]) -> str:
    """Reduce a version string to its bare ``major.minor.patch`` form.

    The official manifest publishes ``mav-firmware-version-str`` with a leading
    ``V`` (``V4.7.1``) while a vehicle reports ``AUTOPILOT_VERSION`` as
    ``4.7.1 (Official Release)``. Comparing the raw strings would make a correct
    installation look like a mismatch, so both sides are reduced to the same
    canonical form before they are compared. Nothing here invents a version: an
    unparseable value reduces to its stripped text and simply fails to match.
    """
    if value is None:
        return ""
    text = str(value).strip()
    if not text:
        return ""
    # Drop a trailing parenthetical release suffix, e.g. "4.7.0 (Official Release)".
    if "(" in text:
        text = text.split("(", 1)[0].strip()
    if text[:1] in ("V", "v"):
        text = text[1:]
    parts = [p for p in text.replace("-", ".").split(".") if p != ""]
    numeric = []
    for part in parts[:3]:
        digits = ""
        for ch in part:
            if ch.isdigit():
                digits += ch
            else:
                break
        if digits == "":
            return text.lower()
        numeric.append(digits)
    if not numeric:
        return text.lower()
    while len(numeric) < 3:
        numeric.append("0")
    return ".".join(numeric)


def versions_match(expected: Optional[str], observed: Optional[str]) -> bool:
    """True when both versions denote the same release.

    Both values must be present. A missing observed version is never a match.
    """
    left = normalize_version(expected)
    right = normalize_version(observed)
    return bool(left and right and left == right)


# ---------------------------------------------------------------------------
# Authoritative session state machine
# ---------------------------------------------------------------------------


def _transition_allowed(current: str, nxt: str) -> bool:
    """Permitted transitions. Anything else is a programming error."""
    allowed = {
        IDLE: {DETECTING, READY, BLOCKED, CANCELLED},
        DETECTING: {IDENTIFYING, DISCONNECTED, FAILED, BLOCKED, CANCELLED},
        IDENTIFYING: {RESOLVING, DISCONNECTED, FAILED, BLOCKED, CANCELLED},
        RESOLVING: {READY, CONFIRMATION_REQUIRED, BLOCKED, FAILED, DISCONNECTED, CANCELLED},
        READY: {CONFIRMATION_REQUIRED, BLOCKED, DOWNLOADING, DISCONNECTED, FAILED},
        CONFIRMATION_REQUIRED: {DOWNLOADING, CANCELLED, BLOCKED, DISCONNECTED, FAILED},
        DOWNLOADING: {DOWNLOAD_VERIFIED, FAILED, CANCELLED, DISCONNECTED},
        DOWNLOAD_VERIFIED: {PREPARING, BLOCKED, FAILED, CANCELLED, DISCONNECTED},
        PREPARING: {INSTALLING, FAILED, CANCELLED, DISCONNECTED},
        INSTALLING: {VERIFYING, FAILED, CANCELLED, DISCONNECTED},
        VERIFYING: {COMPLETED, FAILED, DISCONNECTED},
        COMPLETED: {DETECTING, READY},
        FAILED: {DETECTING, READY},
        CANCELLED: {DETECTING, READY},
        DISCONNECTED: {DETECTING, READY},
        BLOCKED: {DETECTING, READY},
    }
    return nxt in allowed.get(current, set())


@dataclass
class InstallationSession:
    """Authoritative workflow state, owned by the backend.

    Holds the detected hardware, the current and target firmware, the installer
    in use and the transition history. A client may read this but may never
    write a state directly; it must call :meth:`advance`.

    Transitions and progress recording are guarded by a per-session lock, so a
    client polling :func:`services.firmware_workflow_service.status` can never
    observe a half-applied transition.
    """

    state: str = IDLE
    current_version: Optional[str] = None
    current_release: Optional[str] = None
    target_version: Optional[str] = None
    target_release: Optional[str] = None
    target_platform: Optional[str] = None
    target_candidate_id: Optional[str] = None
    outcome: Optional[str] = None
    mode: str = ""
    is_simulation: bool = False
    hardware_touched: bool = False
    confirmed_candidate_id: Optional[str] = None
    progress: List[InstallProgress] = field(default_factory=list)
    history: List[str] = field(default_factory=list)
    message: str = ""
    error: str = ""
    installer: Optional[FirmwareInstaller] = None
    installed_version: Optional[str] = None
    version_verified: bool = False
    lock: threading.RLock = field(
        default_factory=threading.RLock, repr=False, compare=False
    )

    def advance(self, nxt: str, message: str = "", **kwargs: Any) -> None:
        """Move to ``nxt``, validating the transition and recording it."""
        with self.lock:
            if nxt not in WORKFLOW_STATES:
                raise ValueError(f"Unknown workflow state: {nxt}")
            if not _transition_allowed(self.state, nxt):
                raise ValueError(
                    f"Illegal firmware workflow transition {self.state} -> {nxt}"
                )
            previous = self.state
            self.state = nxt
            self.history.append(nxt)
            if message:
                self.message = message
            for key, value in kwargs.items():
                setattr(self, key, value)
            # Every installer state move is recorded, so installer progress can be
            # reconstructed after the fact. Imported lazily to keep this module's
            # import graph free of a cycle.
            try:
                from services import firmware_logging as fwlog

                fwlog.log_event(
                    fwlog.INSTALLER_STATE,
                    fwlog.INSTALLER,
                    outcome=nxt,
                    previousState=previous,
                    targetCandidateId=self.target_candidate_id,
                    targetVersion=self.target_version,
                )
                # A refusal or a failure is also recorded as a failure so the
                # reason for a stopped session is never only in the state name.
                if nxt in (FAILED, BLOCKED):
                    fwlog.log_event(
                        fwlog.FAILURE_RECORDED,
                        fwlog.FAILURE,
                        outcome=nxt,
                        stage="installer",
                        reason=self.message or self.error or None,
                        previousState=previous,
                        targetCandidateId=self.target_candidate_id,
                        targetVersion=self.target_version,
                    )
            except Exception:  # pragma: no cover - logging must never raise
                pass

    def set(self, **kwargs: Any) -> None:
        """Update descriptive fields without changing state."""
        with self.lock:
            for key, value in kwargs.items():
                setattr(self, key, value)

    def record_progress(self, entries: List[InstallProgress]) -> None:
        with self.lock:
            self.progress.extend(entries)

    def snapshot(self) -> Dict[str, Any]:
        """A consistent copy of the session for readers."""
        with self.lock:
            return self.to_dict()

    def to_dict(self) -> Dict[str, Any]:
        with self.lock:
            return {
                # ``success`` means installed *and* verified. Deriving it here
                # keeps the snapshot honest on its own; callers that know better
                # (a refusal, an async "accepted") override it explicitly.
                "success": self.state == COMPLETED and self.version_verified,
                "state": self.state,
                "mode": self.mode,
                "isSimulation": self.is_simulation,
                "hardwareTouched": self.hardware_touched,
                "currentVersion": self.current_version,
                "currentRelease": self.current_release,
                "targetVersion": self.target_version,
                "targetRelease": self.target_release,
                "targetPlatform": self.target_platform,
                "targetCandidateId": self.target_candidate_id,
                "confirmedCandidateId": self.confirmed_candidate_id,
                "installedVersion": self.installed_version,
                "versionVerified": self.version_verified,
                "outcome": self.outcome,
                "message": self.message,
                "error": self.error,
                "progress": [p.to_dict() for p in self.progress],
                "history": list(self.history),
                "terminal": self.state in TERMINAL_STATES,
                "realInstallationAllowed": REAL_INSTALLATION_ALLOWED,
                "realInstallationRefusal": REAL_HARDWARE_REFUSAL,
                "blockedOperations": list(BLOCKED_OPERATIONS),
            }


# ---------------------------------------------------------------------------
# Server-side explicit confirmation
# ---------------------------------------------------------------------------


@dataclass
class ConfirmationRecord:
    """A confirmation the *backend* accepted, for one exact candidate.

    Confirmation is never inferred from a client flag alone: the target is
    re-resolved on the server and this record stores the resulting candidate
    id. Any install request must present the same candidate id, so selecting a
    different image later invalidates the confirmation.

    The record is additionally bound to the *context* the user approved: the
    hardware fingerprint, the catalogue generation and the currently installed
    version. Any change to those — a different board, a different image being
    published, or the board having been reflashed in the meantime — invalidates
    the confirmation, because none of them is what the user actually agreed to.
    """

    candidate_id: Optional[str] = None
    version: Optional[str] = None
    version_str: Optional[str] = None
    release: Optional[str] = None
    platform: Optional[str] = None
    outcome: Optional[str] = None
    #: Cheap fingerprint of which vehicle was connected when confirming.
    #: Checkable on the poll path without a MAVLink round trip.
    connection_fingerprint: Optional[str] = None
    #: Strong fingerprint of the physical board (USB ids, board type/rev,
    #: firmware version). Checked at confirmation, download and pre-install.
    hardware_fingerprint: Optional[str] = None
    #: ETag of the catalogue generation the candidate was validated against.
    catalog_etag: Optional[str] = None
    #: Firmware version the board was running at confirmation time.
    current_version: Optional[str] = None
    #: True for a TEST/SIMULATION confirmation. Those runs deliberately have
    #: no device, so the device/board/version/catalogue checks do not apply;
    #: only the exact-candidate binding does.
    synthetic: bool = False
    confirmed: bool = False
    confirmed_at: Optional[str] = None

    def matches(self, candidate_id: Optional[str]) -> bool:
        return bool(
            self.confirmed
            and candidate_id
            and self.candidate_id is not None
            and str(self.candidate_id) == str(candidate_id)
        )

    def staleness(
        self,
        candidate_id: Optional[str],
        *,
        hardware_fingerprint: Optional[str] = None,
        catalog_etag: Optional[str] = None,
        current_version: Optional[str] = None,
        connection_fingerprint: Optional[str] = None,
        deep: bool = True,
    ) -> List[str]:
        """Every reason this confirmation must no longer be honoured.

        Returns an empty list only when the confirmation is fully current. An
        absent observation (``None``) never counts as "unchanged": it means the
        check could not be made, so the confirmation is refused.

        ``deep`` selects the full validation performed at the decision points.
        With ``deep=False`` only the checks that need no MAVLink round trip are
        evaluated, which is what the polled status path can afford.
        """
        reasons: List[str] = []
        if not self.confirmed:
            reasons.append("no confirmation was recorded")
            return reasons
        if not candidate_id or self.candidate_id is None or str(self.candidate_id) != str(candidate_id):
            reasons.append("the requested candidate is not the confirmed candidate")
        if self.synthetic:
            # A simulation run has no device and no live catalogue binding; the
            # exact-candidate check above is the whole of its guarantee.
            return reasons

        if connection_fingerprint is None:
            reasons.append("no device is connected")
        elif self.connection_fingerprint is None:
            reasons.append("the confirmation was recorded without a vehicle identity")
        elif self.connection_fingerprint != connection_fingerprint:
            reasons.append("the connected vehicle is not the vehicle that was confirmed")

        if not deep:
            return reasons

        if hardware_fingerprint is None:
            reasons.append("the board hardware identity could not be read")
        elif self.hardware_fingerprint is None:
            reasons.append("the confirmation was recorded without a hardware identity")
        elif self.hardware_fingerprint != hardware_fingerprint:
            reasons.append("the connected hardware is not the hardware that was confirmed")
        if catalog_etag is None:
            reasons.append("the catalogue generation could not be established")
        elif self.catalog_etag is None:
            reasons.append("the confirmation was recorded without a catalogue generation")
        elif self.catalog_etag != catalog_etag:
            reasons.append("the official catalogue was refreshed after confirmation")
        if current_version is None:
            reasons.append("the currently installed firmware version could not be read")
        elif self.current_version is not None and current_version != self.current_version:
            reasons.append("the installed firmware version changed after confirmation")
        return reasons

    def to_dict(self) -> Dict[str, Any]:
        return {
            "confirmed": self.confirmed,
            "candidateId": self.candidate_id,
            "version": self.version,
            "versionStr": self.version_str,
            "release": self.release,
            "platform": self.platform,
            "outcome": self.outcome,
            "connectionFingerprint": self.connection_fingerprint,
            "hardwareFingerprint": self.hardware_fingerprint,
            "catalogEtag": self.catalog_etag,
            "currentVersion": self.current_version,
            "synthetic": self.synthetic,
            "confirmedAt": self.confirmed_at,
        }


class ConfirmationStore:
    """Process-wide record of the one confirmation currently in force."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._record = ConfirmationRecord()

    def record(
        self,
        candidate,
        outcome: Optional[str] = None,
        *,
        connection_fingerprint: Optional[str] = None,
        hardware_fingerprint: Optional[str] = None,
        catalog_etag: Optional[str] = None,
        current_version: Optional[str] = None,
        synthetic: bool = False,
    ) -> ConfirmationRecord:
        from datetime import datetime, timezone

        with self._lock:
            self._record = ConfirmationRecord(
                candidate_id=candidate.identity(),
                version=candidate.version,
                version_str=candidate.version_str,
                release=candidate.release_type,
                platform=candidate.platform,
                outcome=outcome,
                synthetic=synthetic,
                connection_fingerprint=connection_fingerprint,
                hardware_fingerprint=hardware_fingerprint,
                catalog_etag=catalog_etag,
                current_version=current_version,
                confirmed=True,
                confirmed_at=datetime.now(timezone.utc).isoformat(),
            )
            return self._record

    def clear(self, reason: str = "") -> ConfirmationRecord:
        with self._lock:
            self._record = ConfirmationRecord()
            if reason:
                self._record.outcome = reason
            return self._record

    @property
    def current(self) -> ConfirmationRecord:
        with self._lock:
            return self._record

    def invalidate_if_stale(
        self,
        candidate_id: Optional[str] = None,
        *,
        connection_fingerprint: Optional[str] = None,
        hardware_fingerprint: Optional[str] = None,
        catalog_etag: Optional[str] = None,
        current_version: Optional[str] = None,
        deep: bool = True,
    ) -> List[str]:
        """Drop a confirmation that no longer describes the current context.

        Called from every read path that can observe a change, so a stale
        confirmation is never presented as live and never authorises a download.
        Returns the reasons it was dropped, or an empty list when nothing changed.
        """
        with self._lock:
            if not self._record.confirmed:
                return []
            reasons = self._record.staleness(
                candidate_id,
                connection_fingerprint=connection_fingerprint,
                hardware_fingerprint=hardware_fingerprint,
                catalog_etag=catalog_etag,
                current_version=current_version,
                deep=deep,
            )
            if reasons:
                self._record = ConfirmationRecord(outcome="STALE")
            return reasons


#: Single authoritative confirmation record.
CONFIRMATION = ConfirmationStore()


class FirmwareWorkflow:
    """Owns the current :class:`InstallationSession` for the process.

    Single session, matching the single-vehicle model of the rest of the
    backend. Thread-safe because HTTP handlers run on worker threads and the
    installation runs on a background worker while clients poll
    :func:`services.firmware_workflow_service.status`.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._session = InstallationSession()
        self._thread: Optional[threading.Thread] = None

    @property
    def session(self) -> InstallationSession:
        with self._lock:
            return self._session

    @property
    def running(self) -> bool:
        thread = self._thread
        return bool(thread is not None and thread.is_alive())

    def reset(self, message: str = "") -> InstallationSession:
        with self._lock:
            self._session = InstallationSession(message=message)
            return self._session

    def blocked_session(self, reason: str = "") -> InstallationSession:
        """A session that truthfully refuses real installation."""
        with self._lock:
            session = InstallationSession()
            session.advance(BLOCKED, message=reason or REAL_HARDWARE_REFUSAL)
            self._session = session
            return session

    def start_worker(self, target, *args: Any, **kwargs: Any) -> bool:
        """Run ``target`` on a background worker.

        Returns ``False`` when a worker is already running, so two install
        requests cannot interleave on the single authoritative session.
        """
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                return False
            thread = threading.Thread(
                target=target,
                args=args,
                kwargs=kwargs,
                name="firmware-workflow",
                daemon=True,
            )
            self._thread = thread
        thread.start()
        return True


WORKFLOW = FirmwareWorkflow()


def environment() -> str:
    """``SITL``, ``HARDWARE`` or ``NONE`` for the connected target.

    Mirrors the established ``motor_test_service`` rule: a vehicle is only
    called a simulation when the transport is non-serial *and* ArduPilot's own
    ``SIM_*`` parameters are present. A physical board is never assumed to be a
    test rig.
    """
    from core.state import get_vehicle_status

    if not get_vehicle_status().get("connected"):
        return "NONE"
    from mavlink import parameter_manager
    from mavlink.connection_manager import manager

    transport = manager.connection_type
    if transport in ("udp", "tcp"):
        try:
            for entry in parameter_manager.get_all_parameters():
                if str(entry.get("id", "")).startswith("SIM_"):
                    return "SITL"
        except Exception:  # noqa: BLE001 - identity failure must not grant SITL
            return "HARDWARE"
    return "HARDWARE"


def is_real_hardware() -> bool:
    return environment() == "HARDWARE"


def capability() -> Dict[str, Any]:
    """Truthful installation capability report, enforced by the backend."""
    from core import config

    env = environment()
    return {
        "success": True,
        "firmwareIdentification": "available",
        "firmwareInstallation": "not-available",
        "installationState": BLOCKED,
        "environment": env,
        "realInstallationAllowed": REAL_INSTALLATION_ALLOWED,
        "hardcodedEnable": config.FIRMWARE_INSTALL_ENABLED,
        "blockedOperations": list(BLOCKED_OPERATIONS),
        "blockedOnHardware": True,
        "realInstaller": RealFirmwareInstaller.capability(),
        "testAdapter": {
            "enabled": bool(config.FIRMWARE_TEST_ADAPTER_ENABLED),
            "label": TEST_LABEL,
            "isSimulation": True,
            "hardwareTouched": False,
            "exposedOverHttp": True,
            "requiresExplicitConfirmation": True,
            "verificationRequired": True,
            "note": (
                "The test installer is a complete simulation and is the only "
                "installer that can run. It cannot reach hardware: it holds no "
                "device handle."
            ),
        },
        "installationMessage": REAL_HARDWARE_REFUSAL,
    }
