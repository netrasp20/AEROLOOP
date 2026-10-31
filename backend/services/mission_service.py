"""In-memory current mission, ported from backend/src/services/mission.service.ts."""

from typing import Any, Dict

_mission: Dict[str, Any] = {
    "home": None,
    "waypoints": [],
}


def save_mission(data: Dict[str, Any]) -> None:
    global _mission
    _mission = data


def get_mission() -> Dict[str, Any]:
    return _mission


def clear_mission() -> None:
    global _mission
    _mission = {
        "home": None,
        "waypoints": [],
    }
