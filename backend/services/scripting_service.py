"""Scripting capability detection and configuration (Phase 8I).

Scripting support is never assumed. It is reported only when the connected
ArduCopter genuinely exposes scripting parameters in the downloaded PARAM_VALUE
cache (SCR_* — for example the SCR_USER1..SCR_USER5 script variables) or when
the firmware identifies itself as a scripting-capable build.

This service is strictly read-only:

  * it does not upload, start, stop, edit or execute a script
  * it does not open a mount, write a file or use the MAVFTP data channel
  * browsing the real vehicle filesystem stays in the existing MAVFTP page

When scripting cannot be verified the page reports an honest unsupported
status instead of pretending the feature exists.
"""

import time
from typing import Any, Dict, List

from mavlink.parameter_manager import parameter_manager
from services.gimbal_service import _field, _is_supported, _identity  # shared Phase 8I helpers

STATE_WAITING = "WAITING"
STATE_CONNECTING = "CONNECTING"
STATE_SYNCING = "SYNCING"
STATE_READY = "READY"
STATE_UNSUPPORTED = "UNSUPPORTED"
STATE_CONNECTION_LOST = "CONNECTION_LOST"
STATE_ERROR = "ERROR"

_CONFIG_PREFIX = "SCR_"
# Scripting variables a script can read at runtime; reported separately because
# they are the parameters most often written by hand.
_USER_TOKEN = tuple(f"SCR_USER{index}" for index in range(1, 6))


def _discover(entries: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    fields: Dict[str, Dict[str, Any]] = {}
    for entry in entries:
        param_id = entry.get("id", "")
        if param_id and param_id.startswith(_CONFIG_PREFIX):
            fields[param_id] = _field(param_id, entry)

    ordered: List[Dict[str, Any]] = [
        fields.pop(param_id) for param_id in _USER_TOKEN if param_id in fields
    ]
    for param_id in sorted(fields):
        ordered.append(fields[param_id])
    return ordered


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


def get_scripting_setup() -> Dict[str, Any]:
    identity = _identity()
    supported, reason = _is_supported(identity)
    sync = dict(parameter_manager.get_synchronization_state())
    sync["complete"] = sync.get("state") == "complete"

    config: List[Dict[str, Any]] = []
    if supported and sync.get("state") == "complete":
        config = _discover(parameter_manager.get_all_parameters())

    if not config and identity["connected"] and sync.get("state") == "complete":
        reason = (
            "The connected ArduCopter firmware does not expose any SCR_* scripting parameters "
            "after a completed parameter sync, so scripting support cannot be verified."
        )

    detected = bool(config)
    return {
        "success": True,
        **identity,
        "supported": supported and (detected or not (identity["connected"] and sync.get("state") == "complete")),
        "unsupportedReason": reason,
        "state": _state(identity, supported, sync, detected),
        "sync": sync,
        "readOnly": False,
        "writePipeline": "shared",
        "executionEnabled": False,
        "capability": {
            "scriptingDetected": detected,
            "reason": (
                "Scripting parameters are present in the vehicle parameter cache."
                if detected
                else "No scripting parameters have been reported by the vehicle."
            ),
        },
        "userTokens": [field["id"] for field in config if field["id"] in _USER_TOKEN],
        "config": config,
        "configCount": len(config),
        "timestamp": int(time.time() * 1000),
    }
