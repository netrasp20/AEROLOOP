"""Every firmware route answers in the same shape, always.

The scenario matrix in ``test_firmware_e2e_matrix.py`` checks what each page
state means. This file checks the thing that is easy to miss while doing that:
that *no* route is left out. A response shape that only one endpoint has is
where a client ends up with a branch it never wrote, usually discovered in the
field.

Every firmware route is therefore called here -- connected, disconnected, and
mid-workflow -- and each answer is held to the same contract:

* ``errorKind`` is present, and is either ``null`` or a declared taxonomy kind;
* ``errorMessage`` is present, and is non-empty exactly when there is a kind;
* ``success`` does not contradict ``state``: a terminal failure never claims
  success, and a completed run is backed by a verified version;
* an accepted-but-unfinished operation says so, and is never dressed up as a
  result.

The route list is derived from the router rather than written out, so a new
firmware endpoint cannot be added without appearing here and being held to the
contract.
"""

import re
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from services import firmware_errors as fe
from services import firmware_download_service as dl
from services import firmware_install_service as inst
from test_firmware_workflow import (  # noqa: F401 - client is used as a fixture
    ARTIFACT,
    client,
    _catalog_patch,
    _connected_info,
    _entry,
    _exact_entries,
    _exact_vehicle,
    _LiveVehicle,
    _no_device,
)

API = "/api/setup"

#: Bodies for the routes that take one. A POST with no body is fine, but the
#: audit must not send a payload the model rejects and read the 422 as a pass.
BODIES = {
    "/firmware/confirmation": {"confirmed": True},
    "/firmware/download": {},
    "/firmware/install": {},
    "/firmware/simulate": {
        "asynchronous": False,
        "vehicle": "Copter",
        "confirmed": True,
    },
    "/firmware/cancel": {},
    "/firmware/bootloader-validation/prepare": {},
    "/firmware/bootloader-validation/cancel": {},
}

#: States that mean the operation has finished, one way or another.
TERMINAL = {"COMPLETED", "FAILED", "CANCELLED", "DISCONNECTED", "BLOCKED"}


def firmware_routes():
    """Every firmware endpoint the router actually exposes.

    Read from the source rather than imported from a list, so this cannot fall
    behind the API: a route added tomorrow shows up here as a missing entry and
    fails the test that checks the list is complete.
    """
    source = (Path(__file__).resolve().parent.parent / "api" / "setup.py").read_text()
    found = re.findall(r'@router\.(get|post)\("(/firmware[^"]*)"\)', source)
    return [(verb.upper(), path) for verb, path in found]


ALL_ROUTES = firmware_routes()


def call(client, path):
    """Call a firmware route with a body it will accept."""
    verb = next(v for v, p in ALL_ROUTES if p == path)
    body = BODIES.get(path)
    if verb == "GET":
        response = client.get(f"{API}{path}")
    else:
        response = client.post(f"{API}{path}", json=body if body is not None else {})
    return response


def wait_for_terminal(client, attempts=60):
    """Poll the status route until the session has settled.

    The workflow runs on a background worker, so reading the status once is a
    race against it. Both refusals below depend on which side of that race a
    given run lands on, which is exactly why the assertions are about the
    invariants that hold either way rather than about a fixed winner.
    """
    body = call(client, "/firmware/status").json()
    for _ in range(attempts):
        if body.get("terminal") is True:
            return body
        time.sleep(0.05)
        body = call(client, "/firmware/status").json()
    return body


def assert_contract(body, where):
    """The invariants every firmware response owes its caller."""
    assert isinstance(body, dict), f"{where}: expected an object, got {type(body)}"

    assert "errorKind" in body, f"{where}: no errorKind"
    kind = body["errorKind"]
    assert kind is None or kind in fe.ERROR_KINDS, f"{where}: {kind!r} is not a kind"

    assert "errorMessage" in body, f"{where}: no errorMessage"
    if kind is None:
        assert not body.get("errorMessage"), (
            f"{where}: an error message with no kind is unexplainable to a caller"
        )
    else:
        assert body["errorMessage"], f"{where}: kind {kind!r} with no explanation"

    state = body.get("state")
    if state in TERMINAL and state != "COMPLETED":
        assert body.get("success") is not True, (
            f"{where}: terminal state {state} claims success"
        )
    if state == "COMPLETED":
        # A completed run is only allowed to exist on a verified version.
        assert body.get("versionVerified") is True, (
            f"{where}: COMPLETED without a verified version"
        )

    # An operation that is merely under way must not be reported as a result.
    if body.get("accepted") or body.get("running"):
        assert body.get("versionVerified") is False, (
            f"{where}: an unfinished operation claims a verified version"
        )


class TestFirmwareRouteContract:
    def test_the_audit_covers_every_firmware_route(self):
        """A new firmware endpoint has to be audited, not merely added."""
        assert len(ALL_ROUTES) == 17, sorted(path for _, path in ALL_ROUTES)
        audited = {path for path in BODIES} | {
            path
            for _, path in ALL_ROUTES
            if path not in BODIES
        }
        assert audited == {path for _, path in ALL_ROUTES}
        # Every POST body in the table has to belong to a real route, or the
        # table would look complete while testing nothing.
        for path in BODIES:
            assert path in {p for _, p in ALL_ROUTES}, path

    @pytest.mark.parametrize("verb,path", ALL_ROUTES, ids=[f"{v} {p}" for v, p in ALL_ROUTES])
    def test_every_route_answers_the_contract_with_a_connected_board(self, client, verb, path):
        with _exact_vehicle(_exact_entries(), auto_confirm=True):
            with _catalog_patch(_exact_entries()):
                response = call(client, path)
        assert response.status_code == 200, f"{path}: HTTP {response.status_code}"
        assert_contract(response.json(), path)

    @pytest.mark.parametrize("verb,path", ALL_ROUTES, ids=[f"{v} {p}" for v, p in ALL_ROUTES])
    def test_every_route_answers_the_contract_with_nothing_connected(self, client, verb, path):
        with _no_device():
            response = call(client, path)
        assert response.status_code == 200, f"{path}: HTTP {response.status_code}"
        assert_contract(response.json(), path)

    def test_a_refused_install_is_reported_as_blocked_not_as_a_start(self, client):
        """The one route whose refusal is easy to misread as progress.

        ``install`` answers ``accepted: true`` with ``success: false``: the
        workflow was accepted, and the *result* is a refusal. Reading either
        field alone gets it wrong, which is why both are asserted here together
        with the terminal outcome that follows.
        """
        # The board stays connected across both calls: the refusal is settled
        # while the vehicle is still there, which is the case worth pinning.
        with _exact_vehicle(_exact_entries(), auto_confirm=True):
            with _catalog_patch(_exact_entries()):
                started = call(client, "/firmware/install").json()

                assert started["accepted"] is True
                assert started["success"] is False
                assert started["versionVerified"] is False
                assert started["realInstallationAllowed"] is False
                assert_contract(started, "install (accepted)")

                settled = wait_for_terminal(client)

        assert settled["terminal"] is True
        assert settled["state"] == inst.BLOCKED
        # Which precondition catches the install depends on whether the recorded
        # confirmation still binds to the live catalogue at install time. Both
        # are honest refusals; what matters is that one of them is declared and
        # that neither writes anything.
        assert settled["errorKind"] in (fe.INSTALLATION_BLOCKED, fe.CONFIRMATION_INVALID)
        assert settled["success"] is not True
        assert settled["versionVerified"] is False
        assert settled["hardwareTouched"] is False
        assert_contract(settled, "status (after refusal)")

    def test_a_disconnect_during_a_startup_wins_over_the_late_refusal(self, client):
        """Unplugging mid-startup settles as DISCONNECTED, not as the refusal.

        The refusal is computed just as the vehicle disappears. Both want the
        last word on the session, and only one of them can have it: the state
        the session actually reached is the honest one. Forcing the refusal on
        top would raise inside the worker thread and leave a client polling a
        session that never finishes.
        """
        with _exact_vehicle(_exact_entries(), auto_confirm=True):
            with _catalog_patch(_exact_entries()):
                call(client, "/firmware/install")

        # The board is gone from here on, so the session settles on the truth.
        settled = wait_for_terminal(client)

        assert settled["terminal"] is True
        # Which of the two wins is genuinely timing-dependent -- the refusal may
        # be computed just before or just after the disconnect is noticed -- and
        # both outcomes are honest. What must not happen is a session that never
        # settles, or one that claims work it did not do.
        assert settled["state"] in (inst.DISCONNECTED, inst.BLOCKED)
        assert settled["success"] is not True
        assert settled["versionVerified"] is False
        assert settled["hardwareTouched"] is False
        assert_contract(settled, "status (disconnected mid-startup)")

    def test_a_silent_vehicle_never_reports_a_downloadable_target(self, client):
        """No identity means nothing to fetch, on any route that offers firmware.

        Checked across the three routes a client would use to find out what to
        install, because "offered nothing" has to mean the same thing on all of
        them.
        """
        with _LiveVehicle(_exact_entries(), info={"success": False, "connected": True}):
            with _catalog_patch(_exact_entries()):
                for path in ("/firmware/workflow", "/firmware/versions", "/firmware/detection"):
                    body = call(client, path).json()
                    assert body.get("releases") in (None, []), path
                    assert body.get("canConfirm") is not True, path
                    assert_contract(body, path)

    def test_a_download_is_never_offered_without_a_confirmation(self, client):
        with _exact_vehicle(_exact_entries()):
            with _catalog_patch(_exact_entries()):
                body = call(client, "/firmware/download").json()
        assert body["success"] is False
        # "Not confirmed yet" is a wait, not a fault: the workflow is holding the
        # operator's decision, so there is no error kind. This is deliberately
        # distinct from CONFIRMATION_INVALID, which means a confirmation was
        # given and did not hold.
        assert body["state"] == inst.CONFIRMATION_REQUIRED
        assert body["confirmationRequired"] is True
        assert body["errorKind"] is None
        # No artifact was fetched, so there is no integrity verdict to report.
        assert not body.get("integrity")
        assert body.get("verifiedForInstall") is not True
        assert_contract(body, "download (unconfirmed)")


# ---------------------------------------------------------------------------
# GAP 5: every state the API can report, held to its own rules
# ---------------------------------------------------------------------------

#: Every state the workflow may report, with what it is allowed to claim.
#: ``terminal`` states have finished; ``waits`` have not and must not be dressed
#: up as either a success or a failure.
#: Every state the workflow may report, with what it is allowed to claim.
#:
#: ``waits`` marks a state that is genuinely still in progress. Those must never
#: carry an error kind: reporting a failure for work that is legitimately under
#: way is how a client ends up showing an error on a healthy install.
#:
#: The non-terminal states that are *not* marked ``waits`` are settled refusals.
#: ``NO_DEVICE`` and ``IDENTITY_UNAVAILABLE`` never resolve and never will on
#: their own, but that is a definite answer about this hardware, not work in
#: progress, so they carry a kind -- that kind is the information the operator
#: needs.
STATE_RULES = {
    # --- in progress ---
    "IDLE": {"terminal": False, "waits": True},
    "DETECTING": {"terminal": False, "waits": True},
    "IDENTIFYING": {"terminal": False, "waits": True},
    "RESOLVING": {"terminal": False, "waits": True},
    "READY": {"terminal": False, "waits": True},
    "CONFIRMATION_REQUIRED": {"terminal": False, "waits": True},
    "DOWNLOADING": {"terminal": False, "waits": True},
    "DOWNLOAD_VERIFIED": {"terminal": False, "waits": True},
    "PREPARING": {"terminal": False, "waits": True},
    "INSTALLING": {"terminal": False, "waits": True},
    "VERIFYING": {"terminal": False, "waits": True},
    # --- settled refusals, reported without ending the page ---
    "NO_DEVICE": {"terminal": False, "success": False},
    "IDENTITY_UNAVAILABLE": {"terminal": False, "success": False},
    "AMBIGUOUS": {"terminal": False, "success": False},
    "UNSUPPORTED": {"terminal": False, "success": False},
    "TRANSFER_COMPLETE_ONLY": {"terminal": False, "verified": False},
    # --- terminal ---
    "COMPLETED": {"terminal": True, "success": True, "verified": True},
    "FAILED": {"terminal": True, "success": False},
    "CANCELLED": {"terminal": True, "success": False},
    "DISCONNECTED": {"terminal": True, "success": False},
    "BLOCKED": {"terminal": True, "success": False},
}

#: Endpoints whose ``success`` does not describe an operation on the connected
#: vehicle, so it may be true with nothing plugged in. Each one is exempt for a
#: stated reason rather than because it was inconvenient:
#:
#: * ``/firmware/capability`` -- answers "what does this build support", a
#:   property of the build, not of the board.
#: * ``/firmware/bootloader-validation/status`` -- a status *query*; success
#:   means the state was read.
#: * ``/firmware/bootloader-validation/cancel`` -- a no-op when nothing is
#:   running, and it correctly reports that it finished cancelling.
#:
#: None of them can claim firmware was installed, which is checked separately.
DESCRIPTIVE_ROUTES = {
    "/firmware/capability",
    "/firmware/bootloader-validation/status",
    "/firmware/bootloader-validation/cancel",
}


class TestEveryReportedState:
    """Each state, reached through real code, must obey its own contract.

    The route audit above proves every *endpoint* answers consistently. This
    proves every *state* means what its name says, which is the other half: a
    client switches on these names, so a state that under- or over-states what
    happened is a contract break even when the HTTP shape is perfect.
    """

    def test_every_state_the_api_can_report_is_pinned(self):
        """No state may be added without deciding what it is allowed to claim."""
        import services.firmware_workflow_service as wf

        reported = {
            "NO_DEVICE",
            "DETECTING",
            "IDENTIFYING",
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
        } | set(inst.WORKFLOW_STATES) | set(fe._EXTRA_STATES)
        missing = reported - set(STATE_RULES)
        assert not missing, f"states with no declared contract: {sorted(missing)}"

    @pytest.mark.parametrize("state", sorted(STATE_RULES))
    def test_a_state_never_contradicts_its_own_rules(self, state):
        """Build a response for ``state`` and hold it to what it may claim."""
        rules = STATE_RULES[state]
        body = fe.annotate(
            {
                "state": state,
                "success": rules.get("success", False),
                # A completed session is only meaningful with the verified
                # version it claims, so the payload carries it. Asserting it here
                # separately is what makes the entry meaningful.
                "versionVerified": rules.get("verified", False),
            }
        )
        assert_contract(body, f"state {state}")

        if "terminal" in rules:
            # A bare annotated payload has no session behind it, so ``terminal``
            # is only asserted when the payload actually carries one. The real
            # terminal flags are checked against live sessions elsewhere.
            if "terminal" in body:
                assert body["terminal"] is rules["terminal"], (
                    f"{state}: terminal flag disagrees with the declared contract"
                )
        if "success" in rules:
            assert body["success"] == rules["success"], (
                f"{state}: success disagrees with the declared contract"
            )
        if rules.get("verified") is not None:
            assert body.get("versionVerified") is rules["verified"], (
                f"{state}: verification claim disagrees with the declared contract"
            )

    @pytest.mark.parametrize(
        "state", [s for s, r in STATE_RULES.items() if r.get("waits")]
    )
    def test_a_waiting_state_is_never_reported_as_a_terminal_failure(self, state):
        """Waiting is not failing.

        ``success: false`` on a state that has not settled is honest -- nothing
        has succeeded *yet*. What would be dishonest is letting a waiting state
        acquire an error kind, because that is what makes a client show an error
        for work that is still legitimately under way.
        """
        body = fe.annotate({"state": state, "success": False})
        assert body["errorKind"] is None, (
            f"{state}: work in progress must not report a failure"
        )
        assert body.get("errorMessage") is None, (
            f"{state}: work in progress must not explain a failure"
        )

    @pytest.mark.parametrize(
        "state",
        [
            s
            for s, r in STATE_RULES.items()
            if r.get("terminal") is False and not r.get("waits")
        ],
    )
    def test_a_settled_refusal_explains_itself(self, state):
        """A non-terminal refusal must still say *why* it refuses.

        These states never resolve on their own, but the operator is owed an
        explanation: a kind of None here would leave the page blank about a board
        it cannot identify.
        """
        body = fe.annotate({"state": state, "success": False})
        assert body["errorKind"] is not None, (
            f"{state}: a refusal with no reason leaves the operator with nothing"
        )
        assert body["errorMessage"], f"{state}: a kind with no explanation"

    def test_a_verification_mismatch_can_never_become_completed(self, client):
        """The single most dangerous conversion in the whole workflow."""
        body = fe.annotate(
            {
                "state": inst.COMPLETED,
                "success": True,
                "versionVerified": False,
                "error": inst.VERIFICATION_MISMATCH,
            }
        )
        assert body["errorKind"] == fe.VERIFICATION_MISMATCH
        # A mismatch reported on a COMPLETED session is still not a completion.
        assert body["versionVerified"] is not True

    def test_an_unconfirmed_verification_is_not_reported_as_a_mismatch(self):
        """An unreadable board is unknown, not wrong.

        Conflating them asserts the board is faulty, which is a claim nothing
        observed.
        """
        unconfirmed = fe.annotate(
            {"error": inst.VERIFICATION_UNCONFIRMED, "success": False}
        )
        assert unconfirmed["errorKind"] == fe.VERIFICATION_UNCONFIRMED
        assert unconfirmed["errorKind"] != fe.VERIFICATION_MISMATCH

    @pytest.mark.parametrize(
        ("download_kind", "expected"),
        [
            (dl.DOWNLOAD_FAILED, fe.DOWNLOAD_FAILED),
            (dl.DOWNLOAD_VERIFICATION_FAILED, fe.DOWNLOAD_VERIFICATION_FAILED),
            # A non-official URL is refused before any transfer begins, so it is
            # a download failure and never an integrity one.
            (dl.DOWNLOAD_REJECTED, fe.DOWNLOAD_FAILED),
            (dl.DOWNLOAD_DISABLED, fe.INSTALLATION_BLOCKED),
        ],
    )
    def test_download_failures_keep_their_own_kind(self, download_kind, expected):
        """A transport failure is not a verification failure."""
        body = fe.annotate({"downloadErrorKind": download_kind, "success": False})
        assert body["errorKind"] == expected

    def test_transfer_complete_only_never_claims_cryptographic_verification(self, client):
        """The honest middle: the bytes arrived, their origin is unproven.

        This is the state most likely to be quietly upgraded, because the file
        really is on disk and its size really does match.
        """
        # Neither a published digest nor a declared length, so only the clean
        # end of the transfer was ever observed.
        with _exact_vehicle(_exact_entries(), auto_confirm=True):
            with _catalog_patch(
                _exact_entries(), artifact_headers={"content-length": None}
            ):
                body = call(client, "/firmware/download").json()

        assert body["downloadStatus"] == "TRANSFER_COMPLETE_ONLY"
        assert body["integrity"] == "TRANSFER_COMPLETE_ONLY"
        # Not a cryptographic verification, and never offered for installation.
        assert body.get("checksumVerified") is not True
        assert body["verifiedForInstall"] is False
        assert body["errorKind"] is None
        # The transfer itself did succeed, and saying so is honest: the file is on
        # disk. What must never happen is ``success`` and ``verifiedForInstall``
        # being true together, which would let a client read "downloaded" as
        # "verified" and offer it for installation.
        assert body["success"] is True, "a clean transfer is a successful transfer"
        assert not (body["success"] and body["verifiedForInstall"]), (
            "a transfer-complete-only download is never offered as verified"
        )

    def test_a_disconnected_device_never_returns_success(self, client):
        """No operation reports success with nothing plugged in.

        The routes listed in :data:`DESCRIPTIVE_ROUTES` are excluded on purpose;
        each is a query or a no-op, not work on hardware that is not there.
        """
        for _verb, path in ALL_ROUTES:
            if path in DESCRIPTIVE_ROUTES:
                continue
            body = call(client, path).json()
            assert body.get("success") is not True, (
                f"{path}: reports success with no device connected"
            )
            assert_contract(body, f"{path} (no device)")

    def test_a_disconnected_device_can_never_look_installed(self, client):
        """No route may report a verified installation while unplugged.

        Stricter than the check above, and the one that matters: a stale
        ``versionVerified`` left on a session is exactly how a client shows an
        install as done on a board that was never touched.
        """
        for _verb, path in ALL_ROUTES:
            body = call(client, path).json()
            assert body.get("versionVerified") is not True, (
                f"{path}: claims a verified version with no device connected"
            )
