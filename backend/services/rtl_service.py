"""Return-to-launch, ported from backend/src/services/rtl.service.ts.

Switches the vehicle to RTL mode and polls live telemetry until it reaches
HOME (within HOME_REACHED_THRESHOLD_M metres) or the timeout elapses.
"""

import time
from typing import Any, Callable, Dict, Optional

from core.state import is_vehicle_connected, telemetry
from mavlink.command_service import set_mode
from mavlink.telemetry_manager import HOME_REACHED_THRESHOLD_M

RTL_TIMEOUT_MS = 120000
RTL_POLL_MS = 500


def validate_rtl() -> Dict[str, Any]:
    if not is_vehicle_connected():
        return {
            "success": False,
            "message": "Cannot return to launch. Vehicle is not connected.",
        }
    if telemetry["homeLatitude"] == 0 and telemetry["homeLongitude"] == 0:
        return {
            "success": False,
            "message": "Cannot return to launch. No HOME position has been captured yet.",
        }
    return {"success": True, "message": "Validation passed."}


def is_at_home() -> bool:
    return telemetry["atHome"] or telemetry["distanceToHome"] <= HOME_REACHED_THRESHOLD_M


def return_to_launch(
    on_progress: Optional[Callable[[str, float], None]] = None,
) -> Dict[str, Any]:
    validation = validate_rtl()
    if not validation["success"]:
        return validation

    print("[RTL] Switching vehicle to RTL mode...")
    if on_progress:
        on_progress("Switching to RTL mode...", telemetry["distanceToHome"])

    mode_result = set_mode("RTL")
    if not mode_result["success"]:
        reason = mode_result.get("statusText") or mode_result.get("message") or "RTL mode change failed."
        print(f"[RTL] Failed to switch to RTL: {reason}")
        return {
            "success": False,
            "message": f"Failed to switch to RTL mode. {reason}",
            "statusText": reason,
        }

    print("[RTL] RTL mode active — waiting for vehicle to reach HOME")

    if is_at_home():
        print("[RTL] Already at home.")
        return {"success": True, "message": "Vehicle is already at home."}

    started_at = int(time.time() * 1000)
    while int(time.time() * 1000) - started_at < RTL_TIMEOUT_MS:
        time.sleep(RTL_POLL_MS / 1000.0)

        if not is_vehicle_connected():
            return {
                "success": False,
                "message": "RTL aborted — vehicle connection lost while returning to launch.",
            }

        dist = telemetry["distanceToHome"]
        if on_progress:
            on_progress(
                "Vehicle reached home."
                if dist <= HOME_REACHED_THRESHOLD_M
                else f"Returning to home... {dist:.1f}m away",
                dist,
            )

        if is_at_home():
            print(f"[RTL] Vehicle reached home — distance={dist:.2f}m")
            return {"success": True, "message": "Vehicle reached home successfully."}

    print("[RTL] Timeout waiting for vehicle to reach home")
    return {
        "success": False,
        "message": f"RTL timeout — vehicle did not reach home within {RTL_TIMEOUT_MS // 1000}s.",
    }
