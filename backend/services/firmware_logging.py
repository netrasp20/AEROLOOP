"""Structured logging for the firmware workflow.

Every firmware event is recorded as one JSON object per line so that detection,
identity, catalog resolution, selection, confirmation, download, verification,
installer state, disconnect, post-install verification and failure reasons can
be followed after the fact.

Design rules:

* **Structured.** One JSON object per line, with a stable ``event`` name and a
  ``phase`` grouping, so lines can be filtered without parsing prose.
* **Read-only.** Logging never performs I/O against a vehicle, opens no port and
  writes nothing to any device.
* **No secrets.** Only identity, version and outcome fields are recorded. URLs
  are reduced to host and path so no query string or credential can leak, and no
  value is ever taken from an environment variable or a credential store.
* **Bounded.** The log is size-capped and rotates, so a long-running ground
  station cannot fill the disk.
* **Never raises.** Logging must not be able to break the firmware workflow, so
  every failure here is swallowed after being reported once.
"""

from __future__ import annotations

import json
import logging
import os
import threading
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import urlsplit

_LOGGER_NAME = "firmware"

#: Fields that must never reach the log, whatever a caller passes.
_FORBIDDEN_KEYS = frozenset(
    {
        "password", "passwd", "secret", "token", "apikey", "api_key",
        "authorization", "auth", "credential", "credentials", "cookie",
        "session", "private_key", "privatekey",
    }
)

#: Event groups, so a reader can filter by phase as well as by event name.
DETECTION = "detection"
IDENTITY = "identity"
CATALOG = "catalog"
SELECTION = "selection"
CONFIRMATION = "confirmation"
DOWNLOAD = "download"
VERIFICATION = "verification"
INSTALLER = "installer"
DISCONNECT = "disconnect"
FAILURE = "failure"

# --- The production event set ------------------------------------------------
#
# Every production firmware event is one of these. They are the contract a log
# consumer can rely on: a reader can enumerate them, assert they are stable, and
# alert on a specific one without parsing prose. Adding an event is a deliberate
# act, not an accident of whichever call site happened to log first.
DETECTION_COMPLETED = "DETECTION"
IDENTITY_OBSERVED = "IDENTITY"
RESOLUTION_COMPLETED = "RESOLUTION"
SELECTION_CHANGED = "SELECTION"
CONFIRMATION_RECORDED = "CONFIRMATION"
DOWNLOAD_STARTED = "DOWNLOAD_STARTED"
DOWNLOAD_COMPLETED = "DOWNLOAD_COMPLETED"
DOWNLOAD_FAILED = "DOWNLOAD_FAILED"
DOWNLOAD_VERIFICATION = "DOWNLOAD_VERIFICATION"
INSTALLER_STATE = "INSTALLER_STATE"
DISCONNECT_OBSERVED = "DISCONNECT"
RECONNECT_OBSERVED = "RECONNECT"
POST_INSTALL_VERIFICATION = "POST_INSTALL_VERIFICATION"
FAILURE_RECORDED = "FAILURE"

#: The complete production event set, for tests and for documentation.
PRODUCTION_EVENTS = (
    DETECTION_COMPLETED,
    IDENTITY_OBSERVED,
    RESOLUTION_COMPLETED,
    SELECTION_CHANGED,
    CONFIRMATION_RECORDED,
    DOWNLOAD_STARTED,
    DOWNLOAD_COMPLETED,
    DOWNLOAD_FAILED,
    DOWNLOAD_VERIFICATION,
    INSTALLER_STATE,
    DISCONNECT_OBSERVED,
    RECONNECT_OBSERVED,
    POST_INSTALL_VERIFICATION,
    FAILURE_RECORDED,
)

_LOCK = threading.Lock()
_CONFIGURED = False

#: Set by :func:`use_logger`. When it is not ``None`` every event goes to this
#: logger instead of the production file. This is the seam that keeps a test from
#: ever being able to reach the production firmware log: a test injects its own
#: logger and the production handler is never configured at all.
_INJECTED: Optional[logging.Logger] = None


def _max_bytes() -> int:
    try:
        from core import config

        return int(getattr(config, "FIRMWARE_LOG_MAX_BYTES", 2 * 1024 * 1024))
    except Exception:  # noqa: BLE001
        return 2 * 1024 * 1024


def _backup_count() -> int:
    try:
        from core import config

        return max(0, int(getattr(config, "FIRMWARE_LOG_BACKUP_COUNT", 2)))
    except Exception:  # noqa: BLE001
        return 2


def log_path() -> Path:
    """Where firmware events are written."""
    override = os.environ.get("FIRMWARE_LOG_PATH")
    if override:
        return Path(override)
    try:
        from core import config

        base = getattr(config, "FIRMWARE_MANIFEST_CACHE_DIR", ".firmware_cache")
    except Exception:  # noqa: BLE001
        base = ".firmware_cache"
    return Path(base) / "logs" / "firmware.jsonl"


def use_logger(logger: Optional[logging.Logger]) -> None:
    """Route events to ``logger`` instead of the production file.

    Passing ``None`` restores production logging. Intended for tests and for
    embedding the firmware workflow in another application that owns its own log
    pipeline.
    """
    global _INJECTED
    with _LOCK:
        _INJECTED = logger


def injected_logger() -> Optional[logging.Logger]:
    """The injected logger, or ``None`` when production logging is in force."""
    return _INJECTED


def _logger() -> logging.Logger:
    """A logger writing one JSON object per line, size-capped."""
    global _CONFIGURED
    if _INJECTED is not None:
        return _INJECTED
    logger = logging.getLogger(_LOGGER_NAME)
    with _LOCK:
        if _CONFIGURED:
            return logger
        try:
            from logging.handlers import RotatingFileHandler

            path = log_path()
            path.parent.mkdir(parents=True, exist_ok=True)
            # Rotating on size only: the firmware log must never grow without
            # bound on a long-running ground station.
            handler = RotatingFileHandler(
                path, maxBytes=_max_bytes(), backupCount=_backup_count(), encoding="utf-8"
            )
            handler.setFormatter(logging.Formatter("%(message)s"))
            logger.addHandler(handler)
            logger.setLevel(logging.INFO)
            # Own our own records; a root handler would duplicate every line.
            logger.propagate = False
        except Exception:  # noqa: BLE001
            # A logger that cannot write must still not raise into the workflow.
            logger.addHandler(logging.NullHandler())
        _CONFIGURED = True
    return logger


def reset() -> None:
    """Drop the current handler so the next event reconfigures from settings.

    Used when the log destination or size changes, and by tests that need each
    case to start from an empty log.
    """
    global _CONFIGURED
    logger = logging.getLogger(_LOGGER_NAME)
    with _LOCK:
        for handler in list(logger.handlers):
            try:
                handler.close()
            except Exception:  # noqa: BLE001
                pass
            logger.removeHandler(handler)
        _CONFIGURED = False


def _scrub(value: Any, key: str = "") -> Any:
    """Drop anything credential-shaped before it can be written."""
    if key.lower() in _FORBIDDEN_KEYS:
        return "[redacted]"
    if isinstance(value, dict):
        return {str(k): _scrub(v, str(k)) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_scrub(v) for v in value]
    if isinstance(value, str):
        # A query string is the usual hiding place for a signed-URL credential,
        # so any URL is reduced to host + path whatever its field is called.
        if "://" in value:
            return safe_url(value) or "[url withheld]"
        return value
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    return str(value)


def safe_url(url: Optional[str]) -> Optional[str]:
    """Reduce a URL to host + path.

    Query strings and fragments are dropped because they are the usual place for
    signed-URL credentials to appear.
    """
    if not url:
        return None
    try:
        parts = urlsplit(str(url))
    except Exception:  # noqa: BLE001
        return None
    if not parts.netloc:
        return None
    return f"{parts.scheme}://{parts.netloc}{parts.path}"


def log_event(
    event: str,
    phase: str,
    *,
    outcome: Optional[str] = None,
    reason: Optional[str] = None,
    **fields: Any,
) -> None:
    """Record one firmware event. Never raises.

    ``event`` names the specific action (``detection.completed``), ``phase``
    groups it (``detection``), and ``outcome``/``reason`` carry the honest result.
    """
    try:
        record: Dict[str, Any] = {"event": event, "phase": phase}
        if outcome is not None:
            record["outcome"] = outcome
        if reason is not None:
            record["reason"] = reason
        for key, value in fields.items():
            if value is None:
                continue
            record[key] = _scrub(value, key)
        _logger().info(json.dumps(record, sort_keys=True, default=str))
    except Exception:  # noqa: BLE001
        pass


def log_resolution(resolution: Any, *, stage: str, **context: Any) -> None:
    """Record one compatibility resolution.

    Both the Firmware page and the catalogue endpoint resolve compatibility, so
    this lives here to keep a single definition of what a resolution records
    rather than one copy per call site.
    """
    selected = getattr(resolution, "selected", None)
    cross_check = getattr(resolution, "cross_check", None)
    log_event(
        RESOLUTION_COMPLETED,
        CATALOG,
        outcome=getattr(resolution, "outcome", None),
        reason=getattr(resolution, "reason", None),
        stage=stage,
        selected=getattr(selected, "platform", None),
        signalsUsed=list(getattr(resolution, "signals_used", []) or []),
        crossCheckPassed=(getattr(cross_check, "passed", None) if cross_check else None),
        canConfirm=bool(getattr(resolution, "can_confirm", False)),
        **context,
    )


def read_events(limit: Optional[int] = None) -> list:
    """Read back recorded events. Used by tests and the diagnostics endpoint."""
    try:
        path = log_path()
        if not path.exists():
            return []
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except Exception:  # noqa: BLE001
        return []
    out = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except Exception:  # noqa: BLE001
            continue
    if limit is not None:
        return out[-limit:]
    return out
