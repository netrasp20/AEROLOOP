"""QGC-style serial auto-connect (Pixhawk USB plug detection).

Mirrors QGroundControl's behaviour of auto-detecting and auto-connecting the
flight controller over USB: when the backend is idle (no active transport, no
CONNECT in flight) and an ArduPilot serial device appears, we open it and wait
for the first real HEARTBEAT — no CONNECT click required.

Scope / guards:
- Serial devices only. UDP/TCP (SITL/MAVProxy) are never touched by this
  thread; their heartbeat-resume reconnect is handled by the connection_manager
  watchdog and keep the UDP socket open.
- It never steals a busy port: if the open fails (e.g. MAVProxy already owns
  /dev/ttyACM0) the attempt is a graceful no-op with a cooldown.
- After a transport loss the same thread reconnects when the device reappears
  (re-plug), satisfying the QGC replug lifecycle without a browser refresh.
- One attempt at a time; the loop yields while any transport is active.
- The `connection_state` / `vehicleStatus` events emitted by the connection
  manager on connect are the authoritative UI source — nothing extra is
  broadcast here.
"""

import threading
import time
from typing import List, Optional

from core import config
from core.state import vehicle_state

_stop = threading.Event()
_thread: Optional[threading.Thread] = None


def scan_serial_devices() -> List[str]:
    """Return autopilot-like serial device paths (stable by-id when available).

    Reuses the serial_service enumeration so auto-connect prefers the exact
    devices the port dropdown would show (ttyACM*/ttyUSB*/cu.* only)."""
    from services import serial_service

    try:
        devices = [p.device for p in serial_service._enumerate_ports()]
    except Exception:  # pragma: no cover - enumeration must never crash the watcher
        devices = []
    return devices


def attempt_auto_connect() -> None:
    """One auto-connect attempt (unit-testable; the loop calls this).

    No-op unless: a serial device is present, no transport is running, and the
    vehicle is currently not connected."""
    from mavlink.connection_manager import manager

    try:
        devices = scan_serial_devices()
    except Exception:  # pragma: no cover
        return
    if not devices:
        return
    if manager.running:
        return
    if vehicle_state.get("connected", False):
        return
    if manager.manual_disconnect_requested:
        return

    device = devices[0]

    print(f"[AUTO-CONNECT] Serial device detected: {device}")
    try:
        ok, message = manager.start(
            connection_type="serial", device=device, clear_manual_disconnect=False
        )
    except Exception as err:  # noqa: BLE001
        print(f"[AUTO-CONNECT] Failed to open {device}: {err}")
        return
    if ok:
        print(f"[AUTO-CONNECT] Connected to {device} automatically — {message}")
    else:
        print(f"[AUTO-CONNECT] {device} present but no vehicle detected: {message}")


def _serial_autodetect_loop() -> None:
    last_attempt = 0.0
    last_device: Optional[str] = None
    while not _stop.wait(config.SERIAL_AUTO_SCAN_INTERVAL_S):
        if not config.AUTO_CONNECT_SERIAL:
            continue
        from mavlink.connection_manager import manager

        if (
            manager.running
            or vehicle_state.get("connected", False)
            or manager.manual_disconnect_requested
        ):
            last_attempt = 0.0
            last_device = None
            continue

        try:
            devices = scan_serial_devices()
        except Exception:  # pragma: no cover
            continue
        if not devices:
            last_device = None
            continue

        device = devices[0]
        now = time.time()
        if (
            device == last_device
            and now - last_attempt < config.SERIAL_AUTO_RETRY_COOLDOWN_S
        ):
            continue
        last_attempt = now
        last_device = device
        attempt_auto_connect()


def start() -> None:
    """Start the auto-connect watcher (idempotent). No-op when disabled."""
    global _thread
    if not config.AUTO_CONNECT_SERIAL:
        return
    if _thread is not None and _thread.is_alive():
        return
    _stop.clear()
    _thread = threading.Thread(
        target=_serial_autodetect_loop,
        daemon=True,
        name="serial-autodetect",
    )
    _thread.start()
    print("[AUTO-CONNECT] Serial auto-connect watcher started (AUTO_CONNECT_SERIAL=true)")


def stop() -> None:
    """Stop the auto-connect watcher."""
    global _thread
    _stop.set()
    if _thread is not None:
        _thread.join(timeout=2.0)
    _thread = None
