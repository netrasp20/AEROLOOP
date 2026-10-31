"""Parameter presets (Phase 6).

Controlled, vehicle-correct profiles the user can load and compare — NOT an
arbitrary parameter dump. Every value is validated against live metadata at
compare/stage time (Phase 5 pre-flight remains the final gate).

Safety rules:

  * Vehicle-type guard: a preset tagged ``rover`` may only be analyzed when
    the connected vehicle resolves to a Rover metadata key. Anything else is
    rejected with VEHICLE_TYPE_MISMATCH — a copter must never receive
    rover-tuned values.
  * All presets are small, conservative tweak sets over parameters that are
    guaranteed to exist (values come from the official ArduPilot rover.xml
    ranges seen against the live vehicle before they are ever offered).
  * No write happens here. Apply-selected produces comparisons the frontend
    turns into staged (Phase 4) edits, then the Phase 5 transaction writes.
"""

from typing import Any, Dict, List, Optional

from services.parameter_file import ParameterFileService

# Rover metadata aliases from parameter_metadata (authoritative gate).
_ROVER_KEYS = ("rover",)

# Preset profile key -> id/name/description + param values.
# Values are intentionally conservative, standard-parameter tweaks.
ROVER_BASELINE = "rover_baseline"
ROVER_CONSERVATIVE = "rover_conservative"
ROVER_SPEED = "rover_speed"

PRESETS: List[Dict[str, Any]] = [
    {
        "id": ROVER_BASELINE,
        "name": "Rover Baseline",
        "description": "Sane, conservative starting point for a ground rover: "
                       "moderate waypoint radius and cruise speed.",
        "vehicle": "rover",
        "paramCount": 2,
        "params": {
            "WP_RADIUS": 2.0,        # m (waypoint reached) — range 0..100
            "CRUISE_SPEED": 2.0,     # m/s (auto target) — range 0..100
        },
    },
    {
        "id": ROVER_CONSERVATIVE,
        "name": "Rover Conservative",
        "description": "Slower, tighter-turning profile intended for first "
                       "runs and indoor testing.",
        "vehicle": "rover",
        "paramCount": 3,
        "params": {
            "WP_RADIUS": 2.0,        # m
            "CRUISE_SPEED": 1.0,     # m/s
            "TURN_RADIUS": 0.5,      # m — tighter turns at low speed
        },
    },
    {
        "id": ROVER_SPEED,
        "name": "Rover Speed",
        "description": "Higher cruise speed for open-space missions.",
        "vehicle": "rover",
        "paramCount": 2,
        "params": {
            "CRUISE_SPEED": 5.0,     # m/s
            "WP_RADIUS": 3.0,        # m
        },
    },
]

_PRESETS_BY_ID: Dict[str, Dict[str, Any]] = {p["id"]: p for p in PRESETS}


def rover_metadata_key(vehicle_type: Optional[str]) -> Optional[str]:
    """Resolve a live vehicle type to a ''rover'' provider key, else None."""
    from services.parameter_metadata import vehicle_metadata_key

    key = vehicle_metadata_key(vehicle_type or "")
    return key if key in _ROVER_KEYS else None


class ParameterPresetService:
    """Preset listing + vehicle-guarded comparison."""

    def __init__(self, file_service: ParameterFileService) -> None:
        self._files = file_service

    def list_presets(self, vehicle_type: Optional[str] = None) -> Dict[str, Any]:
        if vehicle_type is None:
            vehicle_type = self._vehicle_type()
        allowed = rover_metadata_key(vehicle_type) is not None
        return {
            "success": True,
            "vehicle": vehicle_type,
            "allowed": allowed,
            "presets": [
                {k: p[k] for k in ("id", "name", "description", "vehicle",
                                   "paramCount")}
                for p in PRESETS
            ],
        }

    def analyze(self, preset_id: str,
                staged: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        preset = _PRESETS_BY_ID.get(preset_id)
        if preset is None:
            return {
                "success": False,
                "error": {
                    "code": "PRESET_NOT_FOUND",
                    "message": f"No such preset: {preset_id}.",
                },
            }
        vehicle_type = self._vehicle_type()
        if rover_metadata_key(vehicle_type) is None:
            return {
                "success": False,
                "error": {
                    "code": "VEHICLE_TYPE_MISMATCH",
                    "message": (f"Preset '{preset['name']}' is for the ArduRover. "
                                f"The connected vehicle type "
                                f"({vehicle_type or 'unknown'}) is not a Rover."),
                },
            }
        content = self._preset_content(preset)
        return self._files.analyze(content, filename=f"preset:{preset_id}",
                                   staged=staged)

    @staticmethod
    def _preset_content(preset: Dict[str, Any]) -> str:
        lines = [f"# {preset['name']} (YantraYug preset 'rover')"]
        for param_id in sorted(preset["params"]):
            lines.append(f"{param_id},{preset['params'][param_id]}")
        return "\n".join(lines)

    @staticmethod
    def _vehicle_type() -> Optional[str]:
        from core.state import get_vehicle_status

        try:
            return (get_vehicle_status() or {}).get("vehicleType")
        except Exception:  # pragma: no cover - defensive
            return None


def _make_preset_service() -> ParameterPresetService:
    from services.parameter_file import parameter_file_service

    return ParameterPresetService(parameter_file_service)


parameter_preset_service = _make_preset_service()