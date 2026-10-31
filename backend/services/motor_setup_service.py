"""Read-only Motors, servo outputs and ESC setup snapshots for ArduCopter."""

import re
import time
from typing import Any, Dict, List, Optional, Tuple

from core.state import get_vehicle_status
from mavlink.parameter_manager import parameter_manager
from mavlink.telemetry_manager import get_esc_telemetry_snapshot, get_servo_output_snapshot
from services.parameter_metadata import metadata_provider

COPTER_VEHICLE_TYPES = {
    "QUADROTOR", "TRICOPTER", "TRIROTOR", "HEXAROTOR", "OCTOROTOR", "COAXIAL",
    "HELICOPTER", "VTOL_QUADROTOR", "VTOL_TILTROTOR", "VTOL_RESERVED2",
    "VTOL_RESERVED3", "VTOL_RESERVED4", "VTOL_RESERVED5",
}
STATES = {"WAITING", "CONNECTING", "SYNCING", "READY", "UNSUPPORTED", "CONNECTION_LOST", "ERROR"}
_SERVO_PARAM = re.compile(r"^SERVO([1-9]|[12][0-9]|3[0-2])_(FUNCTION|MIN|TRIM|MAX|REVERSED)$")
_MOTOR_LABEL = re.compile(r"^Motor\s*(1[0-2]|[1-9])$", re.IGNORECASE)
_CONFIG_IDS = ("MOT_PWM_TYPE", "MOT_PWM_FREQ", "RC_SPEED")
_FRAME_PARAM = "FRAME_CLASS"
_FRAME_TYPE_PARAM = "FRAME_TYPE"

# Arm count is a property of the frame *class* itself, so it is derived from the
# label the connected firmware reports for FRAME_CLASS - never guessed from the
# vehicle type or from the number of discovered motors. Classes whose rotor
# layout is not an arm layout (helicopters, coax, single-rotor, scripting
# matrices) are deliberately absent: their arm count stays unknown instead of
# being fabricated.
_FRAME_ARM_COUNT = {
    "quad": 4,
    "hexa": 6,
    "octa": 8,
    "octaquad": 8,
    "y6": 6,
    "tri": 3,
    "bicopter": 2,
    "dodecahexa": 12,
    "deca": 10,
}

_GEOMETRY_REASON = (
    "ArduCopter FRAME_CLASS/FRAME_TYPE do not encode motor positions or arm "
    "geometry, so per-motor physical locations are not available and are not inferred."
)



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


def _supported(identity: Dict[str, Any]) -> Tuple[bool, str]:
    if not identity["connected"]:
        return False, "No vehicle connected."
    if identity["autopilot"] != "ARDUPILOTMEGA":
        return False, f"Unsupported autopilot: {identity['autopilot'] or 'UNKNOWN'}"
    if identity["vehicleType"] not in COPTER_VEHICLE_TYPES:
        return False, f"Motor setup is available only for ArduCopter in this version ({identity['vehicleType']} detected)."
    return True, ""


def _meta(param_id: str) -> Optional[Dict[str, Any]]:
    meta = metadata_provider.lookup(param_id, "copter")
    if meta is None:
        metadata_provider.load_for("QUADROTOR")
        meta = metadata_provider.lookup(param_id, "copter")
    return meta


def _field(param_id: str, entry: Dict[str, Any]) -> Dict[str, Any]:
    meta = _meta(param_id)
    value = entry.get("value")
    field: Dict[str, Any] = {
        "id": param_id,
        "supported": True,
        "value": value,
        "name": meta.get("name") if meta else param_id,
        "description": meta.get("description") if meta else None,
        "units": meta.get("units") if meta else None,
        "readOnly": True,
        "decoded": None,
        "rebootRequired": bool(meta.get("rebootRequired")) if meta else False,
    }
    if meta:
        for key in ("min", "max", "increment", "rebootRequired"):
            if meta.get(key) is not None:
                field[key] = meta[key]
        if meta.get("values"):
            field["options"] = [{"code": int(k), "label": v} for k, v in meta["values"].items()]
            try:
                field["decoded"] = meta["values"].get(str(int(value)))
            except (TypeError, ValueError):
                field["decoded"] = None
    return field


def _discover() -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], Dict[str, Any]]:
    by_channel: Dict[int, Dict[str, Dict[str, Any]]] = {}
    entries = parameter_manager.get_all_parameters()
    for entry in entries:
        param_id = entry.get("id", "")
        match = _SERVO_PARAM.match(param_id)
        if match:
            by_channel.setdefault(int(match.group(1)), {})[match.group(2).lower()] = _field(param_id, entry)

    channels: List[Dict[str, Any]] = []
    for number in sorted(by_channel):
        fields = by_channel[number]
        function = fields.get("function")
        label = function.get("decoded") if function else None
        motor_match = _MOTOR_LABEL.fullmatch(label or "")
        channels.append({
            "channel": number,
            "functionId": function.get("value") if function else None,
            "functionLabel": label,
            "functionDescription": function.get("description") if function and label else None,
            "isMotor": motor_match is not None,
            "motorNumber": int(motor_match.group(1)) if motor_match else None,
            "fields": fields,
        })

    config = [_field(entry["id"], entry) for entry in entries if entry.get("id") in _CONFIG_IDS]
    config.sort(key=lambda item: _CONFIG_IDS.index(item["id"]))
    frame = _frame({entry.get("id", ""): entry for entry in entries})
    return channels, config, frame


def _frame(entries: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
    """Decode the live frame identity from FRAME_CLASS / FRAME_TYPE.

    Both values are read from the vehicle's own parameter cache and decoded with
    the connected firmware's parameter metadata, so the reported frame identity is
    authoritative rather than a static table. Physical motor geometry is *not*
    derivable from these parameters and is reported as unavailable.
    """
    class_field = _field(_FRAME_PARAM, entries.get(_FRAME_PARAM, {"id": _FRAME_PARAM, "value": None}))
    type_field = _field(_FRAME_TYPE_PARAM, entries.get(_FRAME_TYPE_PARAM, {"id": _FRAME_TYPE_PARAM, "value": None}))

    class_value = class_field.get("value")
    class_label = class_field.get("decoded")
    type_value = type_field.get("value")
    type_label = type_field.get("decoded")

    arm_count = None
    if class_label:
        arm_count = _FRAME_ARM_COUNT.get(str(class_label).replace(" ", "_").lower())

    label = None
    if class_label and type_label:
        label = f"{class_label} ({type_label})"
    elif class_label:
        label = str(class_label)

    configured = bool(class_value) and int(class_value) > 0
    return {
        "classParam": _FRAME_PARAM,
        "typeParam": _FRAME_TYPE_PARAM,
        "class": int(class_value) if isinstance(class_value, (int, float)) else None,
        "type": int(type_value) if isinstance(type_value, (int, float)) else None,
        "classLabel": class_label,
        "typeLabel": type_label,
        "label": label,
        "configured": configured,
        "armCount": arm_count,
        "armCountSource": "frame-class-label" if arm_count is not None else None,
        "source": "firmware-metadata" if class_label else "unavailable",
        "supported": class_field.get("supported", False) and bool(class_label),
        "geometryAvailable": False,
        "geometryReason": _GEOMETRY_REASON,
    }


def _state(identity: Dict[str, Any], supported: bool, has_channels: bool) -> str:
    if identity["connectionState"] == "connecting":
        return "CONNECTING"
    if not identity["connected"]:
        return "CONNECTION_LOST" if identity.get("disconnectReason") else "WAITING"
    if not supported:
        return "UNSUPPORTED"
    sync = parameter_manager.get_synchronization_state()
    if sync.get("state") in ("requesting", "receiving", "idle"):
        return "SYNCING"
    if sync.get("state") == "failed":
        return "ERROR"
    return "READY" if sync.get("state") == "complete" and has_channels else "ERROR"


def get_motor_setup(view: str = "motors") -> Dict[str, Any]:
    identity = _identity()
    supported, reason = _supported(identity)
    channels: List[Dict[str, Any]] = []
    config: List[Dict[str, Any]] = []
    frame: Dict[str, Any] = _frame({})
    if identity["connected"] and supported and parameter_manager.get_synchronization_state().get("state") == "complete":
        channels, config, frame = _discover()
    sync = dict(parameter_manager.get_synchronization_state())
    sync["complete"] = sync.get("state") == "complete"
    servo_snapshot = get_servo_output_snapshot()
    esc_snapshot = get_esc_telemetry_snapshot()
    servo_by_channel = {item["channel"]: item for item in servo_snapshot["channels"]}

    response = {
        "success": True,
        **identity,
        "supported": supported,
        "unsupportedReason": reason,
        "state": _state(identity, supported, bool(channels)),
        "sync": sync,
        "readOnly": True,
        "view": view,
        "channels": channels,
        "channelCount": len(channels),
        "motors": [channel for channel in channels if channel["isMotor"]],
        "motorCount": sum(1 for channel in channels if channel["isMotor"]),
        "configuration": config,
        "timestamp": int(time.time() * 1000),
    }

    if view == "motors":
        outputs = []
        for channel in response["motors"]:
            motor_number = channel["motorNumber"]
            # A motor sits on this airframe only if the frame class implies that
            # many arms. When the arm count is unknown the mapping stays
            # explicitly unknown instead of being guessed.
            if frame["armCount"] is None:
                frame_mapped = None
                frame_reason = "Frame class does not imply a motor count; motor position unknown."
            elif motor_number is not None and 1 <= motor_number <= frame["armCount"]:
                frame_mapped = True
                frame_reason = None
            else:
                frame_mapped = False
                frame_reason = f"Motor {motor_number} exceeds the {frame['armCount']}-arm count implied by {frame['classLabel']}."
            live = servo_by_channel.get(channel["channel"])
            outputs.append({
                "output": channel["channel"],
                "motorNumber": motor_number,
                "motorLabel": channel["functionLabel"],
                "functionId": channel["functionId"],
                "functionLabel": channel["functionLabel"],
                "configured": channel["functionId"] is not None,
                "source": channel["fields"].get("function", {}).get("id"),
                "frameMapped": frame_mapped,
                "frameMappingReason": frame_reason,
                "pwm": live.get("pwm") if live else None,
                "receivedAt": live.get("receivedAt") if live else None,
                "ageMs": live.get("ageMs") if live else None,
                "freshness": ("STALE" if live["stale"] else "AVAILABLE") if live else "UNAVAILABLE",
            })
        response["outputs"] = outputs
        response["outputCount"] = len(outputs)
        response["frame"] = frame
    elif view == "servo-outputs":
        outputs = []
        for channel in channels:
            fields = channel["fields"]
            live = servo_by_channel.get(channel["channel"])
            freshness = "UNAVAILABLE"
            if live:
                freshness = "STALE" if live["stale"] else "AVAILABLE"
            reversed_field = fields.get("reversed")
            outputs.append({
                "output": channel["channel"],
                "functionId": channel["functionId"],
                "functionLabel": channel["functionLabel"],
                "min": fields.get("min", {}).get("value"),
                "trim": fields.get("trim", {}).get("value"),
                "max": fields.get("max", {}).get("value"),
                "reversed": bool(reversed_field["value"]) if reversed_field else None,
                "status": "Configured" if channel["functionId"] is not None else "Partial configuration",
                "pwm": live.get("pwm") if live else None,
                "receivedAt": live.get("receivedAt") if live else None,
                "ageMs": live.get("ageMs") if live else None,
                "freshness": freshness,
            })
        response["outputs"] = outputs
        response["outputCount"] = len(outputs)
    elif view == "esc":
        telemetry = []
        for item in esc_snapshot["escs"]:
            telemetry.append({
                "index": item["channel"],
                "rpm": item["rpm"],
                "voltage": item["voltage"],
                "current": item["current"],
                "temperature": item["temperature"],
                "consumptionMah": item["totalCurrentMah"],
                "status": item["status"],
                "receivedAt": item["receivedAt"],
                "ageMs": item["ageMs"],
                "freshness": "STALE" if item["stale"] else "AVAILABLE",
            })
        response["telemetry"] = telemetry
        response["escCount"] = len(telemetry)
        response["config"] = config

    return response
