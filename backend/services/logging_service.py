"""Logging capability, configuration and on-board log listing (Phase 8I).

Every value on the Logging Setup page comes from the vehicle:

  * logging configuration -> the downloaded PARAM_VALUE cache (real LOG_* parameters)
  * labels/ranges/bitmask  -> services.parameter_metadata
  * on-board log files     -> mavlink.telemetry_manager (real LOG_ENTRY frames the
                              vehicle broadcasts while enumerating the SD card)

No log is created, downloaded, deleted or reconfigured by this service. The
returned configuration fields are writable through the existing staged/verified
parameter write pipeline; this module adds no write endpoint of its own.
"""

import time
from typing import Any, Dict, List

from mavlink.parameter_manager import parameter_manager
from mavlink.telemetry_manager import get_log_entry_snapshot
from services.gimbal_service import _field, _is_supported, _identity  # shared Phase 8I helpers

STATE_WAITING = "WAITING"
STATE_CONNECTING = "CONNECTING"
STATE_SYNCING = "SYNCING"
STATE_READY = "READY"
STATE_UNSUPPORTED = "UNSUPPORTED"
STATE_CONNECTION_LOST = "CONNECTION_LOST"
STATE_ERROR = "ERROR"

# Configuration parameters shown first when the firmware actually has them.
_PRIMARY = ("LOG_BITMASK", "LOG_BACKEND_TYPE", "LOG_BACKEND_RATE", "LOG_FILE_SIZE", "LOG_REPLAY")
_CONFIG_PREFIX = "LOG_"


def _discover(entries: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    fields: Dict[str, Dict[str, Any]] = {}
    for entry in entries:
        param_id = entry.get("id", "")
        if param_id and param_id.startswith(_CONFIG_PREFIX):
            fields[param_id] = _field(param_id, entry)

    ordered: List[Dict[str, Any]] = []
    for param_id in _PRIMARY:
        if param_id in fields:
            ordered.append(fields.pop(param_id))
    for param_id in sorted(fields):
        ordered.append(fields[param_id])
    return ordered


def _logging_status(config: List[Dict[str, Any]]) -> str:
    """Honest status derived from the real LOG_BITMASK / LOG_BACKEND_TYPE values."""
    by_id = {field["id"]: field for field in config}
    bitmask = by_id.get("LOG_BITMASK")
    if bitmask is None:
        return "Unknown"
    if bitmask.get("value") is None:
        return "Unknown"
    bits = bitmask.get("bits") or []
    if not bits:
        enabled = int(bitmask["value"]) != 0
        return "Enabled" if enabled else "Disabled"
    enabled = sum(1 for bit in bits if bit["present"])
    if enabled == 0:
        return "Disabled"
    if enabled < len(bits):
        return "Partially configured"
    return "Enabled"


def _state(identity: Dict[str, Any], supported: bool, sync: Dict[str, Any], has_config: bool) -> str:
    if identity["connectionState"] == "connecting":
        return STATE_CONNECTING
    if not identity["connected"]:
        return STATE_CONNECTION_LOST if identity.get("disconnectReason") else STATE_WAITING
    if not supported:
        return STATE_UNSUPPORTED
    if sync.get("state") in ("requesting", "receiving", "idle"):
        return STATE_SYNCING
    if sync.get("state") == "failed":
        return STATE_ERROR
    if sync.get("state") != "complete":
        return STATE_SYNCING
    if not has_config:
        return STATE_UNSUPPORTED
    return STATE_READY


def get_logging_setup() -> Dict[str, Any]:
    identity = _identity()
    supported, reason = _is_supported(identity)
    sync = dict(parameter_manager.get_synchronization_state())
    sync["complete"] = sync.get("state") == "complete"

    config: List[Dict[str, Any]] = []
    if supported and sync.get("state") == "complete":
        config = _discover(parameter_manager.get_all_parameters())

    if not config and identity["connected"] and sync.get("state") == "complete":
        reason = (
            "No LOG_* configuration parameters are present in the vehicle parameter cache "
            "after a completed parameter sync."
        )

    entries = get_log_entry_snapshot()
    status = _logging_status(config)
    return {
        "success": True,
        **identity,
        "supported": supported and (bool(config) or not (identity["connected"] and sync.get("state") == "complete")),
        "unsupportedReason": reason,
        "state": _state(identity, supported, sync, bool(config)),
        "sync": sync,
        "readOnly": False,
        "writePipeline": "shared",
        "status": status,
        "config": config,
        "configCount": len(config),
        "logEntries": entries.get("entries", []),
        "logEntryCount": entries.get("entryCount", 0),
        "numLogs": entries.get("numLogs"),
        "lastLogNum": entries.get("lastLogNum"),
        "timestamp": int(time.time() * 1000),
    }
