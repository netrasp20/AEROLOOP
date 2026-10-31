import { telemetry } from "../mavlink/telemetry";
import { vehicleState, isVehicleConnected } from "../mavlink/vehicleState";
import { setMode } from "../mavlink/command.service";
import { HOME_REACHED_THRESHOLD_M } from "../mavlink/telemetryManager";

const RTL_TIMEOUT_MS = 120000;
const RTL_POLL_MS = 500;

export interface RtlResult {
  success: boolean;
  message: string;
  statusText?: string;
}

export function validateRtl(): RtlResult {
  if (!isVehicleConnected()) {
    return {
      success: false,
      message: "Cannot return to launch. Vehicle is not connected.",
    };
  }
  if (telemetry.homeLatitude === 0 && telemetry.homeLongitude === 0) {
    return {
      success: false,
      message: "Cannot return to launch. No HOME position has been captured yet.",
    };
  }
  return { success: true, message: "Validation passed." };
}

function isAtHome(): boolean {
  return telemetry.atHome || telemetry.distanceToHome <= HOME_REACHED_THRESHOLD_M;
}

/**
 * Switch the vehicle to RTL mode and wait until it physically arrives at the
 * ArduPilot HOME position (within HOME_REACHED_THRESHOLD_M metres), using live
 * GLOBAL_POSITION_INT telemetry as the source of truth.
 */
export async function returnToLaunch(
  onProgress?: (message: string, distanceM: number) => void
): Promise<RtlResult> {
  const validation = validateRtl();
  if (!validation.success) return validation;

  console.log("[RTL] Switching vehicle to RTL mode...");
  onProgress?.("Switching to RTL mode...", telemetry.distanceToHome);

  const modeResult = await setMode("RTL");
  if (!modeResult.success) {
    const reason = modeResult.statusText || modeResult.message || "RTL mode change failed.";
    console.log(`[RTL] Failed to switch to RTL: ${reason}`);
    return {
      success: false,
      message: `Failed to switch to RTL mode. ${reason}`,
      statusText: reason,
    };
  }

  console.log("[RTL] RTL mode active — waiting for vehicle to reach HOME");

  if (isAtHome()) {
    console.log("[RTL] Already at home.");
    return { success: true, message: "Vehicle is already at home." };
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < RTL_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, RTL_POLL_MS));

    if (!isVehicleConnected()) {
      return {
        success: false,
        message: "RTL aborted — vehicle connection lost while returning to launch.",
      };
    }

    const dist = telemetry.distanceToHome;
    onProgress?.(
      dist <= HOME_REACHED_THRESHOLD_M
        ? "Vehicle reached home."
        : `Returning to home... ${dist.toFixed(1)}m away`,
      dist
    );

    if (isAtHome()) {
      console.log(`[RTL] Vehicle reached home — distance=${dist.toFixed(2)}m`);
      return { success: true, message: "Vehicle reached home successfully." };
    }
  }

  console.log("[RTL] Timeout waiting for vehicle to reach home");
  return {
    success: false,
    message: `RTL timeout — vehicle did not reach home within ${Math.round(RTL_TIMEOUT_MS / 1000)}s.`,
  };
}
