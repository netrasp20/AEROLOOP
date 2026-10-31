"""One error taxonomy for the whole firmware workflow.

Every firmware failure is reported as exactly one of the kinds below. The point
is that unrelated failures stay unrelated: a board that is not connected, a board
whose identity cannot be trusted, an official catalogue that could not be read,
and an artifact that arrived damaged are four different problems, and an
operator diagnosing a flight needs to be able to tell them apart.

Internal service outcomes (the resolver's ``UNSUPPORTED``, the download
service's four failure kinds, the installer's terminal states) keep their own
names. This module maps them onto the taxonomy rather than replacing them, so
no existing message or test that depends on an internal name breaks.

Rules:

* Never guess. An unrecognised input maps to ``None`` (no error) rather than
  being forced into a kind it does not belong to.
* Never collapse. Two unrelated internal reasons never share a kind unless they
  genuinely mean the same thing to a caller.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

# --- The taxonomy -----------------------------------------------------------

DEVICE_NOT_CONNECTED = "DEVICE_NOT_CONNECTED"
IDENTITY_UNAVAILABLE = "IDENTITY_UNAVAILABLE"
IDENTITY_AMBIGUOUS = "IDENTITY_AMBIGUOUS"
UNSUPPORTED_HARDWARE = "UNSUPPORTED_HARDWARE"
CATALOG_UNAVAILABLE = "CATALOG_UNAVAILABLE"
FIRMWARE_NOT_FOUND = "FIRMWARE_NOT_FOUND"
CONFIRMATION_INVALID = "CONFIRMATION_INVALID"
DOWNLOAD_FAILED = "DOWNLOAD_FAILED"
DOWNLOAD_VERIFICATION_FAILED = "DOWNLOAD_VERIFICATION_FAILED"
INSTALLATION_BLOCKED = "INSTALLATION_BLOCKED"
INSTALLATION_FAILED = "INSTALLATION_FAILED"
DISCONNECTED = "DISCONNECTED"
VERIFICATION_MISMATCH = "VERIFICATION_MISMATCH"
VERIFICATION_UNCONFIRMED = "VERIFICATION_UNCONFIRMED"

#: Every kind this module is allowed to report, for tests and the API.
ERROR_KINDS = (
    DEVICE_NOT_CONNECTED,
    IDENTITY_UNAVAILABLE,
    IDENTITY_AMBIGUOUS,
    UNSUPPORTED_HARDWARE,
    CATALOG_UNAVAILABLE,
    FIRMWARE_NOT_FOUND,
    CONFIRMATION_INVALID,
    DOWNLOAD_FAILED,
    DOWNLOAD_VERIFICATION_FAILED,
    INSTALLATION_BLOCKED,
    INSTALLATION_FAILED,
    DISCONNECTED,
    VERIFICATION_MISMATCH,
    VERIFICATION_UNCONFIRMED,
)

#: Human-readable meaning of each kind. The API returns these so a client never
#: has to invent its own explanation for a code.
ERROR_MESSAGES: Dict[str, str] = {
    DEVICE_NOT_CONNECTED: "No vehicle is connected, so firmware identity cannot be established.",
    IDENTITY_UNAVAILABLE: "The vehicle reports no bootloader identity, so its exact platform cannot be trusted.",
    IDENTITY_AMBIGUOUS: "The reported identity matches more than one platform, so no firmware can be selected safely.",
    UNSUPPORTED_HARDWARE: "This hardware or autopilot is not supported for firmware resolution.",
    CATALOG_UNAVAILABLE: "The official firmware catalogue could not be read.",
    FIRMWARE_NOT_FOUND: "The official catalogue holds no firmware for this target.",
    CONFIRMATION_INVALID: "The confirmation does not match the current vehicle, candidate or catalogue.",
    DOWNLOAD_FAILED: "The firmware artifact could not be downloaded.",
    DOWNLOAD_VERIFICATION_FAILED: "The downloaded artifact failed its integrity verification.",
    INSTALLATION_BLOCKED: "Installation is blocked and nothing was written to the board.",
    INSTALLATION_FAILED: "The installation did not complete.",
    DISCONNECTED: "The vehicle disconnected, so the session was invalidated.",
    VERIFICATION_MISMATCH: "Post-install verification found a different firmware or identity than expected.",
    VERIFICATION_UNCONFIRMED: "Post-install verification could not read the board to confirm the result.",
}


def describe(kind: Optional[str]) -> Optional[str]:
    """The explanation for a kind, or ``None`` when there is no error."""
    if not kind:
        return None
    return ERROR_MESSAGES.get(kind, kind)


# --- Mapping from the services' own outcomes --------------------------------


def from_resolution(outcome: Optional[str]) -> Optional[str]:
    """Map a resolver outcome onto the taxonomy.

    ``EXACT_MATCH`` is not an error and maps to ``None``.
    """
    from services import firmware_compat_service as compat

    return {
        compat.EXACT_MATCH: None,
        compat.AMBIGUOUS: IDENTITY_AMBIGUOUS,
        compat.IDENTITY_UNAVAILABLE: IDENTITY_UNAVAILABLE,
        # The resolver reports one UNAVAILABLE for "the catalogue could not be
        # read". It is distinct from NO_MATCH, which is a successful read that
        # simply holds nothing for this target.
        compat.UNAVAILABLE: CATALOG_UNAVAILABLE,
        compat.NO_MATCH: FIRMWARE_NOT_FOUND,
        # The resolver's UNSUPPORTED covers both a non-ArduPilot autopilot and a
        # SITL target with no flash. Both mean "this is not supported hardware".
        compat.UNSUPPORTED: UNSUPPORTED_HARDWARE,
        compat.NO_DEVICE: DEVICE_NOT_CONNECTED,
    }.get(outcome or "", _UNMAPPED(outcome))


def from_download(error_kind: Optional[str]) -> Optional[str]:
    """Map a download service failure kind onto the taxonomy."""
    from services import firmware_download_service as dl

    return {
        # A build with downloads switched off is blocked, not broken.
        dl.DOWNLOAD_DISABLED: INSTALLATION_BLOCKED,
        # A non-official URL is refused before any transfer starts: the artifact
        # was never fetched, so this is a download failure rather than an
        # integrity one.
        dl.DOWNLOAD_REJECTED: DOWNLOAD_FAILED,
        dl.DOWNLOAD_FAILED: DOWNLOAD_FAILED,
        dl.DOWNLOAD_VERIFICATION_FAILED: DOWNLOAD_VERIFICATION_FAILED,
    }.get(error_kind or "", _UNMAPPED(error_kind))


#: Session states the workflow reports that are not installer states but still
#: describe a real condition. ``NO_DEVICE`` is the detection state, not an
#: installation one, so it is mapped by its literal value.
_EXTRA_STATES = {
    "NO_DEVICE": DEVICE_NOT_CONNECTED,
}


def from_state(state: Optional[str], error: Optional[str] = None) -> Optional[str]:
    """Map an installation session state (and its error) onto the taxonomy.

    The installer's own ``error`` is authoritative when present, because a state
    of ``FAILED`` says what happened while the error says why.
    """
    from services import firmware_install_service as inst

    if error:
        reason = str(error).lower()
        # A cancelled session is the operator's own doing, not a fault, whatever
        # wording the caller used for it.
        if "cancel" in reason:
            return None
        # A step refused because the confirmation does not hold is a confirmation
        # problem, whatever the session happened to be doing at the time.
        if "confirm" in reason:
            return CONFIRMATION_INVALID
        if "disconnect" in reason:
            return DISCONNECTED
        # An internal error string is only allowed to speak for the state if it
        # is a name the taxonomy actually declares. "simulated-failure" must not
        # become a kind, and it must not erase the fact that the state was FAILED
        # either -- so an unrecognised string falls through to the state below
        # rather than winning or vetoing.
        mapped = _mapped(from_verification(error)) or _mapped(from_download(error))
        if mapped:
            return mapped
        if error in ("blocked", "hardware-not-allowed", inst.REAL_HARDWARE_REFUSAL):
            return INSTALLATION_BLOCKED

    # NO_DEVICE is a resolver outcome, not an installation state: the session
    # reports DISCONNECTED once a board that was present goes away.
    if state in _EXTRA_STATES:
        return _EXTRA_STATES[state]

    return {
        inst.IDLE: None,
        inst.DETECTING: None,
        inst.IDENTIFYING: None,
        inst.RESOLVING: None,
        inst.READY: None,
        inst.CONFIRMATION_REQUIRED: None,
        inst.DOWNLOADING: None,
        inst.DOWNLOAD_VERIFIED: None,
        inst.PREPARING: None,
        inst.INSTALLING: None,
        inst.VERIFYING: None,
        inst.COMPLETED: None,
        inst.FAILED: INSTALLATION_FAILED,
        # Cancelling is something the operator asked for; it is not a failure and
        # is reported by ``state``, not by an error kind.
        inst.CANCELLED: None,
        inst.DISCONNECTED: DISCONNECTED,
        inst.BLOCKED: INSTALLATION_BLOCKED,
    }.get(state or "", _UNMAPPED(state))


def from_verification(error: Optional[str]) -> Optional[str]:
    """Map a post-install verification error onto the taxonomy."""
    from services import firmware_install_service as inst

    return {
        inst.VERIFICATION_MISMATCH: VERIFICATION_MISMATCH,
        inst.VERIFICATION_UNCONFIRMED: VERIFICATION_UNCONFIRMED,
    }.get(error or "", _UNMAPPED(error))


def annotate(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Stamp ``errorKind``/``errorMessage`` onto a workflow response.

    Every firmware endpoint returns this pair, so a client never has to infer a
    failure from a message string. The kind is derived from the response's own
    authoritative fields and is never invented: a response that reports success
    gets ``None``.

    Precedence matters. An explicit kind already on the payload (the download
    path sets one) wins, then a specific verification error, then the session
    state, then the resolver outcome, and only then the generic success/failure
    shape. That order keeps a transport failure from being reported as a
    verification problem just because the session also ended in ``FAILED``.
    """
    kind = payload.get("errorKind")
    if kind is not None and kind not in ERROR_KINDS:
        # An internal name that has no taxonomy entry is not a kind. It stays in
        # ``errorMessage`` where it is visible, but ``errorKind`` may only ever
        # carry one of the declared values, because that is what callers switch on
        # -- so an undeclared value falls through to the sources below rather than
        # being passed off as a kind.
        kind = None
    if not kind:
        # The catalogue route reports the resolver's verdict nested rather than
        # flattened, so both spellings are consulted.
        resolution = payload.get("resolution")
        nested = resolution.get("outcome") if isinstance(resolution, dict) else None
        state = payload.get("state")

        # The resolver's verdict is more specific than a generic session state:
        # an unsupported board reaches state READY, so the outcome has to be read
        # before the state is trusted.
        # A session reports its own reason as ``error``, which is where the
        # verification and download vocabularies show up.
        reason = payload.get("error")
        kind = _mapped(
            from_verification(payload.get("verificationError") or reason)
            or from_download(payload.get("downloadErrorKind") or reason)
            or from_resolution(payload.get("outcome"))
            or from_resolution(nested)
        )
        if kind is None and _state_is_known(state):
            # Otherwise the state decides, and it decides *alone*: a cancelled or
            # merely in-flight session must not be reclassified into a failure
            # just because ``success`` is still False while work is pending.
            kind = from_state(state, payload.get("error"))
        elif kind is None:
            # Only a response with no recognised state falls back to its own
            # shape.
            kind = _from_shape(payload)
    payload["errorKind"] = _mapped(kind)
    if not isinstance(kind, str):
        payload["errorMessage"] = None
        return payload

    # The response's own message explains what happened in terms a person can act
    # on; the taxonomy text is the fallback for the responses that carry only an
    # internal code. A raw identifier such as "simulated-failure" is a useful log
    # field, not something to show as the explanation.
    payload["errorMessage"] = (
        payload.get("message") or payload.get("error") or describe(kind)
    )
    return payload


def _state_is_known(state: Optional[str]) -> bool:
    """Whether ``state`` is one this taxonomy maps, error or not."""
    from services import firmware_install_service as inst

    if not state:
        return False
    if state in _EXTRA_STATES:
        return True
    return state in _INSTALLER_STATES


_INSTALLER_STATES = frozenset(
    {
        "IDLE", "DETECTING", "IDENTIFYING", "RESOLVING", "READY",
        "CONFIRMATION_REQUIRED", "DOWNLOADING", "DOWNLOAD_VERIFIED", "PREPARING",
        "INSTALLING", "VERIFYING", "COMPLETED", "FAILED", "CANCELLED",
        "DISCONNECTED", "BLOCKED",
    }
)


def _from_shape(payload: Dict[str, Any]) -> Optional[str]:
    """Fall back to the response's own success flag and catalogue state.

    ``success`` is False on an accepted asynchronous operation too -- it means
    "not finished", not "went wrong" -- so an in-flight response is never
    reported as a failure. Only a response that says it is finished, and not
    successful, has failed.
    """
    if payload.get("success") is not False:
        return None
    if payload.get("accepted") or payload.get("running"):
        return None
    if payload.get("catalogAvailable") is False:
        return CATALOG_UNAVAILABLE
    if payload.get("connected") is False:
        return DEVICE_NOT_CONNECTED
    if payload.get("confirmationRequired") or payload.get("confirmed") is False:
        return CONFIRMATION_INVALID
    if payload.get("terminal") is False:
        return None
    return INSTALLATION_FAILED


def _mapped(kind: Optional[str]) -> Optional[str]:
    """Drop an internal name that the taxonomy does not define.

    :func:`from_resolution` and friends report an unrecognised value verbatim so
    it stays visible, but a caller that switches on ``errorKind`` must never see
    a value outside :data:`ERROR_KINDS`. Unmapped means "no declared kind", which
    lets the next, more specific source decide instead of inventing one.
    """
    if kind is None or isinstance(kind, _Unmapped):
        return None
    return kind


def _UNMAPPED(value: Optional[str]) -> Optional[str]:  # noqa: N802
    """Map an internal name onto the taxonomy, never guessing.

    An absent value means "there is no error here" and maps to ``None``. A value
    that is present but unrecognised maps to itself (wrapped, so it stays
    visible in the response) rather than to a nearby kind: two different internal
    failures must not silently collapse into one kind, because that is exactly
    the mistake this taxonomy exists to prevent.
    """
    if not value:
        return None
    return _Unmapped(value)


class _Unmapped(str):
    """An internal outcome with no mapping in the taxonomy.

    Subclasses ``str`` so it serialises as its own name, which keeps an unmapped
    value visible in the API response instead of being dropped or coerced into a
    kind it does not belong to.
    """

    __slots__ = ()

    def __new__(cls, value: Optional[str]) -> "_Unmapped":
        return super().__new__(cls, value or "UNKNOWN")


def assert_known(kind: Any) -> None:
    """Raise if ``kind`` is not a real taxonomy entry. For tests."""
    if kind is None:
        return
    if kind not in ERROR_KINDS:
        raise AssertionError(f"{kind!r} is not a firmware error kind")
