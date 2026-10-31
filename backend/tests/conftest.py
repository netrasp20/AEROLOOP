"""Shared pytest fixtures. Puts the backend package on sys.path so tests can
import ``mavlink.*`` the same way uvicorn does (backend/ is the app root)."""

import os
import sys
import tempfile
from pathlib import Path

# Keep the QGC-style serial auto-connect watcher off during the pytest run so a
# developer workstation with a plugged Pixhawk can never hijack the transports
# under test (the watcher itself is covered by test_serial_autodetect.py).
os.environ.setdefault("AUTO_CONNECT_SERIAL", "false")

# Firmware event logging must not write into the real log while tests run: a
# passing test suite would otherwise bury the genuine events an operator reads
# after a real flight, mixing synthetic outcomes into their audit trail.
os.environ.setdefault(
    "FIRMWARE_LOG_PATH",
    str(Path(tempfile.gettempdir()) / "gcs-firmware-test-log.jsonl"),
)

BACKEND = Path(__file__).resolve().parent.parent
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

import pytest  # noqa: E402


@pytest.fixture(autouse=True)
def firmware_workflow_isolation():
    """Keep the process-global firmware state from leaking between tests.

    Three separate globals live at module scope and would each make the suite
    order-dependent:

    ``FirmwareWorkflow`` is a module-level singleton whose background worker is a
    daemon thread. A test that starts an asynchronous workflow therefore leaves
    ``WORKFLOW.running`` True, and whichever test runs next gets a "busy" refusal
    instead of its own state.

    The catalogue memoises the parsed manifest in ``_memo``, so a test that
    serves a synthetic manifest would otherwise be answered from the *previous*
    test's entries -- which is how a scenario can quietly resolve against the
    wrong platforms.

    The recorded confirmation is likewise process-global, and is bound to the
    catalogue generation and hardware fingerprint it was made against, so it has
    to be dropped too.

    Waits briefly for a worker to finish on its own, then detaches it, and clears
    the memo and confirmation so the next test starts clean.
    """
    from services import firmware_catalog_service as catalog
    from services import firmware_workflow_service as wf

    yield

    worker = getattr(wf.WORKFLOW, "_thread", None)
    if worker is not None and worker.is_alive():
        worker.join(timeout=10)
    if worker is None or not worker.is_alive():
        wf.WORKFLOW._thread = None
    wf.WORKFLOW.reset()

    # The parsed manifest memo is keyed on the manifest URL, which every test
    # shares, so only an explicit reset distinguishes one test's catalogue from
    # the next.
    catalog._memo = None
    wf.CONFIRMATION.clear()
    wf._set_was_connected(None)

    # A stored bootloader identity is the one piece of hardware evidence that
    # outlives a request, so it has to be dropped explicitly. Leaving it behind
    # would let a test that never read a bootloader inherit an exact match from
    # whichever test ran before it.
    from services.bootloader_validation_service import SERVICE as validation

    validation.machine.identity = None
