import type {
  Mission,
  UploadResult,
  UploadProgress,
  UploadError,
  ValidationErrorCode,
} from "../types/mission";

import socket from "../socket/socket";

export type ProgressCallback = (
  progress: UploadProgress
) => void;

const LAT_LNG_TOLERANCE = 0.000001;
const ALT_TOLERANCE = 0.5;

export function validateMission(
  mission: Mission,
  vehicleConnected: boolean
): UploadError | null {
  console.log("========== MISSION VALIDATION STARTED ==========");

  if (!vehicleConnected) {
    console.log("[VALIDATION] FAILED — Vehicle not connected");
    return {
      code: "VEHICLE_NOT_CONNECTED" as ValidationErrorCode,
      title: "❌ Vehicle Not Connected",
      message: "Please connect the flight controller before uploading the mission.",
    };
  }

  const wps = mission.waypoints || [];

  if (wps.length === 0) {
    console.log("[VALIDATION] FAILED — No waypoints in mission");
    return {
      code: "NO_WAYPOINTS" as ValidationErrorCode,
      title: "❌ No Waypoints Created",
      message: "No waypoints created. Please create at least one waypoint.",
    };
  }

  console.log(`[VALIDATION] Waypoint count: ${wps.length}`);

  for (const wp of wps) {
    if (typeof wp.lat !== "number" || isNaN(wp.lat) || typeof wp.lng !== "number" || isNaN(wp.lng)) {
      console.log(`[VALIDATION] FAILED — Waypoint ${wp.id} has invalid coordinates`);
      return {
        code: "INVALID_COORDINATES" as ValidationErrorCode,
        title: "❌ Invalid Waypoint",
        message: `Waypoint ${wp.id} contains invalid latitude or longitude.`,
      };
    }

    if (typeof wp.altitude !== "number" || isNaN(wp.altitude) || wp.altitude <= 0) {
      console.log(`[VALIDATION] FAILED — Waypoint ${wp.id} has invalid altitude`);
      return {
        code: "INVALID_ALTITUDE" as ValidationErrorCode,
        title: "❌ Invalid Altitude",
        message: `Waypoint ${wp.id} does not have a valid altitude.`,
      };
    }
  }

  if (wps.length >= 2) {
    for (let i = 0; i < wps.length; i++) {
      for (let j = i + 1; j < wps.length; j++) {
        const latDiff = Math.abs(wps[i].lat - wps[j].lat);
        const lngDiff = Math.abs(wps[i].lng - wps[j].lng);
        const altDiff = Math.abs(wps[i].altitude - wps[j].altitude);

        if (latDiff < LAT_LNG_TOLERANCE && lngDiff < LAT_LNG_TOLERANCE && altDiff < ALT_TOLERANCE) {
          console.log(`[VALIDATION] FAILED — Duplicate waypoints: WP${wps[i].id} and WP${wps[j].id} have same coordinates`);
          return {
            code: "DUPLICATE_SEQUENCE" as ValidationErrorCode,
            title: "❌ Duplicate Waypoints",
            message: "Duplicate waypoints detected. Please remove duplicate entries.",
          };
        }
      }
    }
    console.log("[VALIDATION] Duplicate check: PASSED");
  } else {
    console.log("[VALIDATION] Duplicate check: SKIPPED (fewer than 2 waypoints)");
  }

  const sorted = [...wps].sort((a, b) => a.sequence - b.sequence);
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].sequence !== i + 1) {
      console.log(`[VALIDATION] FAILED — Invalid sequence at WP${sorted[i].id}: expected ${i + 1}, got ${sorted[i].sequence}`);
      return {
        code: "INVALID_ORDER" as ValidationErrorCode,
        title: "❌ Invalid Waypoint Order",
        message: "Waypoint numbering is incorrect. Please regenerate the mission.",
      };
    }
  }
  console.log("[VALIDATION] Sequence check: PASSED");

  console.log("[VALIDATION] PASSED");
  return null;
}

export class MissionUploadService {
  async upload(
    mission: Mission,
    vehicleConnected: boolean,
    onProgress?: ProgressCallback
  ): Promise<UploadResult> {
    const error = validateMission(mission, vehicleConnected);

    if (error) {
      return {
        success: false,
        message: error.title,
        errors: [error.message],
        errorInfo: error,
      };
    }

    return new Promise<UploadResult>((resolve) => {
      const onProgressEvent = (data: {
        phase: string;
        current: number;
        total: number;
        message?: string;
      }) => {
        onProgress?.({
          total: data.total,
          current: data.current,
          phase: data.phase as UploadProgress["phase"],
        });
      };

      const onSuccess = (data: {
        message: string;
        waypointCount: number;
        vehicleMode: string;
      }) => {
        cleanup();
        resolve({
          success: true,
          message: data.message,
        });
      };

      const onError = (data: {
        message: string;
        errors: string[];
      }) => {
        cleanup();
        resolve({
          success: false,
          message: data.message,
          errors: data.errors,
          errorInfo: {
            code: "UPLOAD_FAILED",
            title: "❌ Upload Failed",
            message: data.errors?.[0] || data.message || "Mission upload failed.",
          },
        });
      };

      const cleanup = () => {
        socket.off("mission:progress", onProgressEvent);
        socket.off("mission:success", onSuccess);
        socket.off("mission:error", onError);
      };

      socket.on("mission:progress", onProgressEvent);
      socket.on("mission:success", onSuccess);
      socket.on("mission:error", onError);

      socket.emit("mission:upload", {
        home: mission.home,
        waypoints: mission.waypoints,
      });
    });
  }
}

export const missionUploadService = new MissionUploadService();
