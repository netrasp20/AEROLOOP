"""Configuration loaded from environment (.env) for the Python backend."""

import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()


def _int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


def _bool(name: str, default: bool) -> bool:
    return os.getenv(name, str(default)).lower() in ("1", "true", "yes", "on")


def _float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


# HTTP / Socket.IO server port (Node used PORT or 5000).
PORT = _int("PORT", 5000)

# Vehicle connection defaults
DEFAULT_TCP_HOST = "127.0.0.1"
DEFAULT_TCP_PORT = 5760
DEFAULT_UDP_HOST = "0.0.0.0"
DEFAULT_UDP_PORT = 14550

# Heartbeat timeout (ms) — mirrors CONNECTION_TIMEOUT_MS
CONNECTION_TIMEOUT_MS = 10000

# QGC-style serial auto-connect: when idle, watch for an ArduPilot serial
# device (Pixhawk USB) to appear and connect automatically — no CONNECT click.
# Also auto-reconnects a lost serial link when the device reappears. UDP/TCP
# (SITL/MAVProxy) are never touched by this watcher; their heartbeat-resume
# reconnect is handled by the connection_manager watchdog.
AUTO_CONNECT_SERIAL = _bool("AUTO_CONNECT_SERIAL", True)
SERIAL_AUTO_SCAN_INTERVAL_S = 2.5
SERIAL_AUTO_RETRY_COOLDOWN_S = 10.0
SERIAL_AUTO_HEARTBEAT_WAIT_S = 10.0

# ---------------------------------------------------------------------------
# Official ArduPilot firmware catalog (read-only)
#
# The catalogue is always fetched from the official ArduPilot server; no
# catalogue is ever vendored into the repository or hardcoded. A validated copy
# is cached on disk and revalidated with an ETag conditional request.
# ---------------------------------------------------------------------------
FIRMWARE_MANIFEST_URL = os.getenv(
    "FIRMWARE_MANIFEST_URL", "https://firmware.ardupilot.org/manifest.json.gz"
)
FIRMWARE_MANIFEST_TIMEOUT_S = _float("FIRMWARE_MANIFEST_TIMEOUT_S", 20.0)
# How long a cached catalogue is reused before a conditional revalidation.
FIRMWARE_MANIFEST_CACHE_TTL_S = _float("FIRMWARE_MANIFEST_CACHE_TTL_S", 900.0)
FIRMWARE_MANIFEST_CACHE_DIR = os.getenv(
    "FIRMWARE_MANIFEST_CACHE_DIR",
    str(Path(__file__).resolve().parent.parent / ".firmware_cache"),
)
# Firmware artifact download preparation (read-only fetch + integrity check).
# The file is NEVER executed, uploaded or installed by this phase.
FIRMWARE_DOWNLOAD_ENABLED = _bool("FIRMWARE_DOWNLOAD_ENABLED", True)
FIRMWARE_DOWNLOAD_TIMEOUT_S = _float("FIRMWARE_DOWNLOAD_TIMEOUT_S", 60.0)
FIRMWARE_DOWNLOAD_MAX_BYTES = _int("FIRMWARE_DOWNLOAD_MAX_BYTES", 16 * 1024 * 1024)
# Structured firmware event log. Size-capped so a long-running ground station
# cannot fill the disk; it lives beside the manifest cache and holds no secrets.
FIRMWARE_LOG_MAX_BYTES = _int("FIRMWARE_LOG_MAX_BYTES", 2 * 1024 * 1024)

# HARDWARE SAFETY GATE.
#
# Firmware *installation* is not implemented and must stay that way. This flag
# is a hard backend-side gate, not a UI toggle: no code path may erase, program,
# boot, reboot-for-flashing, or otherwise install firmware onto real hardware.
# Firmware installation therefore cannot be enabled from configuration.
FIRMWARE_INSTALL_ENABLED = False
# The only executable firmware path is an explicitly labelled in-process test
# adapter (TEST / SIMULATION). It is deliberately NOT exposed over HTTP so it
# can never masquerade as a real device flash.
FIRMWARE_TEST_ADAPTER_ENABLED = _bool("FIRMWARE_TEST_ADAPTER_ENABLED", True)

# Landing gating constants (telemetryManager parity)
LANDING_ALT_THRESHOLD_M = 1.0
LANDING_TIMEOUT_MS = 60000
LANDING_POLL_MS = 500

# Debug toggles
TELEMETRY_DEBUG = os.getenv("TELEMETRY_DEBUG", "false").lower() == "true"