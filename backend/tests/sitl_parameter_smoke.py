"""SITL integration smoke test (Phase 1 — MAVLink Parameter Manager).

Connects a SECOND MAVLink client to the live vehicle via a spare SITL TCP
link. The vehicle's primary console (127.0.0.1:5760) is already held by
mavproxy (which forwards to UDP:14550 — that's the running backend's link),
so we use the secondary SITL TCP listener (127.0.0.1:5762), which ArduPilot
exposes for extra MAVLink clients. Never touches the backend's UDP:14550 path.

Flow:
  1. start() the transports, wait for HEARTBEAT
  2. request_all_parameters()        -> cache populated, COMPLETE
  3. read WP_RADIUS                  -> current value
  4. set WP_RADIUS = value + 1       -> echoed/verified
  5. read WP_RADIUS again            -> new value persists
  6. set WP_RADIUS back to original  -> verified revert
  7. refresh_parameters()            -> re-sync, COMPLETE
  8. stop session + transport

Run from backend/ (the app root):
    python -m tests.sitl_parameter_smoke   (or: python tests/sitl_parameter_smoke.py)

Exit code 0 = all steps PASS.
"""

import sys
import time
from contextlib import closing

sys.path.insert(0, __file__.rsplit("/", 2)[0])  # backend/ on path

from mavlink.connection_manager import manager
from mavlink.parameter_manager import (
    RESULT_REJECTED,
    RESULT_SUCCESS,
    STATE_COMPLETE,
    parameter_manager,
)

VEHICLE = "tcp"
HOST = "127.0.0.1"
PORT = 5762

FAILURES = []


def step(name: str, ok: bool, detail: str = "") -> None:
    mark = "PASS" if ok else "FAIL"
    print(f"  [{mark}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        FAILURES.append(name)


def main() -> int:
    print("=== SITL Parameter Manager smoke test ===")

    started, message = manager.start(VEHICLE, host=HOST, port=PORT)
    step("connect + HEARTBEAT", started, message)
    if not started:
        manager.stop()
        return 1

    result = parameter_manager.request_all_parameters()
    sync = parameter_manager.get_synchronization_state()
    step("full parameter download", result["status"] == RESULT_SUCCESS,
         f"{sync.get('receivedCount')} received / {sync.get('expectedCount')} expected "
         f"(state={sync.get('state')})")
    assert result["status"] == RESULT_SUCCESS, (result, sync)
    if sync["state"] != STATE_COMPLETE:
        FAILURES.append("download reached COMPLETE state")
    assert sync["receivedCount"] > 0

    read1 = parameter_manager.read_parameter("WP_RADIUS_M")
    step("read WP_RADIUS_M", read1["status"] == RESULT_SUCCESS,
         f"value={read1.get('value')}")
    assert read1["status"] == RESULT_SUCCESS, read1

    original = read1["value"]
    target = original + 1.0
    written = parameter_manager.set_parameter("WP_RADIUS_M", target)
    step("write WP_RADIUS_M +1 (verified)", written["status"] == RESULT_SUCCESS,
         f"value={written.get('value')}")
    assert written["status"] == RESULT_SUCCESS, written

    read2 = parameter_manager.read_parameter("WP_RADIUS_M")
    step("read WP_RADIUS_M (persisted)", read2["status"] == RESULT_SUCCESS
         and abs(read2["value"] - target) < 0.5,
         f"value={read2.get('value')} (expected ~{target})")

    reverted = parameter_manager.set_parameter("WP_RADIUS_M", original)
    step("write WP_RADIUS_M revert (verified)", reverted["status"] == RESULT_SUCCESS,
         f"value={reverted.get('value')}")
    assert reverted["status"] == RESULT_SUCCESS, reverted

    ref = parameter_manager.refresh_parameters()
    ref_sync = parameter_manager.get_synchronization_state()
    step("parameter refresh", ref["status"] == RESULT_SUCCESS,
         f"{ref_sync.get('receivedCount')} / {ref_sync.get('expectedCount')} "
         f"(state={ref_sync.get('state')})")

    # Sanity: value is back to the original and cache is coherent.
    final = parameter_manager.get_parameter("WP_RADIUS_M")
    step("cache reflects vehicle", final is not None
         and abs(final["value"] - original) < 0.5,
         f"value={final['value'] if final else None}")

    step("writeState seam (verified)", final is not None
         and final["writeState"] == "verified")

    parameter_manager.stop_session("sitl smoke complete")
    manager.stop()

    print("=" * 48)
    if FAILURES:
        print(f"FAILED steps: {', '.join(FAILURES)}")
        return 1
    print("ALL SITL STEPS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())