"""Read-only gimbal detection and configuration (Phase 8I) for ArduCopter.

Everything on the Gimbal Setup page is derived from genuine vehicle data:

  * gimbal hardware      -> mavlink.telemetry_manager (real GIMBAL_DEVICE_INFORMATION /
                            GIMBAL_DEVICE_ATTITUDE_STATUS frames the vehicle broadcasts)
  * gimbal configuration -> the downloaded PARAM_VALUE cache (real MNT_/GIMBAL_/GMB_/MOUNT_
                            parameters plus the SERVO outputs whose metadata-assigned
                            function label is a mount/gimbal axis)
  * labels, units, ranges, enum values, bitmasks
                          -> services.parameter_metadata (official ArduPilot definitions)

This service never sends a command. It exposes no gimbal control, no mount
movement and no actuator action. Configuration parameters are reported as
writable so the existing staged/verified parameter write pipeline
(mavlink.parameter_manager / services.write_transaction) can be reused; no new
write endpoint is added here.

A vehicle without a gimbal is NOT an error: the page reports "no gimbal
detected" honestly, because the absence of GIMBAL_DEVICE_* frames is the only
truthful signal available.
"""

import re
import time
from typing import Any, Dict, List, Optional, Tuple

from core.state import get_vehicle_status
from mavlink.parameter_manager import parameter_manager
from mavlink.telemetry_manager import get_gimbal_snapshot
from services.parameter_metadata import metadata_provider

COPTER_VEHICLE_TYPES = {
    "QUADROTOR", "TRICOPTER", "TRIROTOR", "HEXAROTOR", "OCTOROTOR", "COAXIAL",
    "HELICOPTER", "VTOL_QUADROTOR", "VTOL_TILTROTOR", "VTOL_RESERVED2",
    "VTOL_RESERVED3", "VTOL_RESERVED4", "VTOL_RESERVED5",
}

STATE_WAITING = "WAITING"
STATE_CONNECTING = "CONNECTING"
STATE_SYNCING = "SYNCING"
STATE_READY = "READY"
STATE_UNSUPPORTED = "UNSUPPORTED"
STATE_CONNECTION_LOST = "CONNECTION_LOST"
STATE_ERROR = "ERROR"

# Genuine ArduPilot gimbal / mount-manager parameter namespaces.
_CONFIG_PREFIXES = ("GIMBAL_", "GMB_", "MNT_", "MOUNT_")
_SERVO_PARAM = re.compile(r"^SERVO([1-9]|[12][0-9]|3[0-2])_FUNCTION$")
_MOUNT_LABEL = re.compile(r"\b(gimbal|mount)\b", re.IGNORECASE)


def _identity() -> Dict[str, Any]:
    status = get_vehicle_status()
    connection = status.get("connectionType", "NONE")
    return {
        "connected": status.get("connected", False),
        "connectionState": status.get("connectionState", "disconnected"),
        "disconnectReason": status.get("disconnectReason"),
        "armed": status.get("armed", False),
        "mode": status.get("mode", "DISCONNECTED"),
        "systemId": status.get("systemId", 0),
        "componentId": status.get("componentId", 0),
        "vehicleType": status.get("vehicleType", "UNKNOWN"),
        "autopilot": status.get("autopilot", "UNKNOWN"),
        "transport": {"SERIAL": "USB", "UDP": "UDP", "TCP": "TCP"}.get(connection, "NONE"),
    }


def _is_supported(identity: Dict[str, Any]) -> Tuple[bool, str]:
    if not identity["connected"]:
        return False, "No vehicle connected."
    if identity["autopilot"] != "ARDUPILOTMEGA":
        return False, f"Unsupported autopilot: {identity['autopilot'] or 'UNKNOWN'}"
    if identity["vehicleType"] not in COPTER_VEHICLE_TYPES:
        return False, (
            "Gimbal setup is available only for ArduCopter in this version "
            f"({identity['vehicleType']} detected)."
        )
    return True, ""


def _meta(param_id: str) -> Optional[Dict[str, Any]]:
    meta = metadata_provider.lookup(param_id, "copter")
    if meta is None:
        metadata_provider.load_for("QUADROTOR")
        meta = metadata_provider.lookup(param_id, "copter")
    return meta


def _numeric(value: Any) -> Optional[float]:
    if isinstance(value, bool) or value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _field(param_id: str, entry: Dict[str, Any], writable: bool = True) -> Dict[str, Any]:
    """Metadata-enriched parameter field shared by every Phase 8I page."""
    meta = _meta(param_id)
    value = _numeric(entry.get("value"))
    field: Dict[str, Any] = {
        "id": param_id,
        "supported": True,
        "value": value,
        "name": (meta.get("name") if meta else None) or param_id,
        "description": meta.get("description") if meta else None,
        "units": meta.get("units") if meta else None,
        "writable": bool(writable),
        "decoded": None,
        "options": [],
        "rebootRequired": bool(meta.get("rebootRequired", False)) if meta else False,
    }
    if meta:
        for key in ("min", "max", "increment"):
            if meta.get(key) is not None:
                field[key] = meta[key]
        values = meta.get("values")
        if values:
            options = []
            for code, label in values.items():
                try:
                    options.append({"code": int(code), "label": label})
                except (TypeError, ValueError):
                    options.append({"code": code, "label": label})
            try:
                options.sort(key=lambda option: int(option["code"]))
            except (TypeError, ValueError):
                pass
            field["options"] = options
            if value is not None:
                field["decoded"] = values.get(str(int(value)))
        bitmask = meta.get("bitmask")
        if bitmask:
            raw = int(value) if value is not None else 0
            bits = []
            for code, label in sorted(bitmask.items(), key=lambda item: int(item[0])):
                bits.append({
                    "code": int(code),
                    "label": label,
                    "present": bool(raw & (1 << int(code))),
                })
            field["kind"] = "bitmask"
            field["bits"] = bits
            enabled = sum(1 for bit in bits if bit["present"])
            field["enabledCount"] = enabled
            field["decoded"] = (
                "Disabled" if enabled == 0
                else f"Enabled ({enabled}/{len(bits)})"
                if enabled < len(bits)
                else f"Enabled ({enabled}/{len(bits)})"
            )
        elif values:
            field["kind"] = "enum"
        else:
            field["kind"] = "scalar"
    else:
        field["kind"] = "scalar"
    return field


def _discover(entries: List[Dict[str, Any]]) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """Gimbal configuration parameters and gimbal-assigned servo outputs."""
    config: Dict[str, Dict[str, Any]] = {}
    outputs: List[Dict[str, Any]] = []

    for entry in entries:
        param_id = entry.get("id", "")
        if not param_id:
            continue
        if param_id.startswith(_CONFIG_PREFIXES):
            config[param_id] = _field(param_id, entry)
            continue
        match = _SERVO_PARAM.match(param_id)
        if not match:
            continue
        field = _field(param_id, entry, writable=False)
        label = field.get("decoded") or ""
        if not _MOUNT_LABEL.search(str(label)):
            continue
        outputs.append({
            "output": int(match.group(1)),
            "functionId": int(field["value"]) if field["value"] is not None else None,
            "functionLabel": label or None,
            "source": param_id,
        })

    outputs.sort(key=lambda item: item["output"])
    ordered_config = [config[param_id] for param_id in sorted(config)]
    return ordered_config, outputs


def _state(identity: Dict[str, Any], supported: bool, sync: Dict[str, Any]) -> str:
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
    return STATE_READY


def get_gimbal_setup() -> Dict[str, Any]:
    identity = _identity()
    supported, reason = _is_supported(identity)
    sync = dict(parameter_manager.get_synchronization_state())
    sync["complete"] = sync.get("state") == "complete"

    config: List[Dict[str, Any]] = []
    outputs: List[Dict[str, Any]] = []
    if supported and sync.get("state") == "complete":
        config, outputs = _discover(parameter_manager.get_all_parameters())

    snapshot = get_gimbal_snapshot()
    devices = snapshot.get("devices", [])
    if devices:
        capability_reason = "Gimbal reported by the vehicle."
    elif outputs:
        capability_reason = "Gimbal axes are assigned to servo outputs, but the vehicle has not reported a gimbal device."
    elif config:
        capability_reason = "Gimbal configuration parameters are present, but the vehicle has not reported a gimbal device."
    else:
        capability_reason = "No gimbal device has been reported and no gimbal configuration parameters are present."

    return {
        "success": True,
        **identity,
        "supported": supported,
        "unsupportedReason": reason,
        "state": _state(identity, supported, sync),
        "sync": sync,
        "readOnly": True,
        "controlEnabled": False,
        "writePipeline": "shared",
        "capability": {
            "gimbalDetected": bool(devices) or bool(outputs) or bool(config),
            "deviceReported": bool(devices),
            "reason": capability_reason,
        },
        "devices": devices,
        "deviceCount": len(devices),
        "outputs": outputs,
        "outputCount": len(outputs),
        "config": config,
        "configCount": len(config),
        "capabilityCount": len(devices) + len(outputs) + len(config),
        "timestamp": int(time.time() * 1000),
    }
