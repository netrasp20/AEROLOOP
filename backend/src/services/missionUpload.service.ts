import { send, common, MavLinkProtocolV2 } from "node-mavlink";
import { vehicleState } from "../mavlink/vehicleState";
import { telemetry } from "../mavlink/telemetry";
import { getTransport, onPacket } from "../mavlink/mavlink.service";

import {
  waypointsToMavlinkItems,
  sendMissionCount,
  createMissionItemInt,
  parseMissionRequest,
  parseMissionAckResult,
  getAckResultMessage,
} from "../mavlink/commands/MissionCommand";

import type { MavlinkMissionItem } from "../models/mission.model";

export type UploadProgressCallback = (
  phase: "validating" | "connecting" | "uploading" | "verifying" | "done",
  current: number,
  total: number,
  message?: string
) => void;

export interface UploadValidation {
  valid: boolean;
  errors: string[];
}

const LAT_LNG_TOLERANCE = 0.000001;
const ALT_TOLERANCE = 0.5;

let uploadStatusText: string[] = [];

export function getUploadStatusText(): string[] {
  return uploadStatusText;
}

export function clearUploadStatusText(): void {
  uploadStatusText = [];
}

function captureStatusText(packet: any): void {
  try {
    if (packet.header.msgid === 253) {
      const msg = packet.protocol.data(packet.payload, common.StatusText) as any;
      const text = (msg.text ?? "").replace(/\0.*$/, "").trim();
      if (text) {
        uploadStatusText.push(text);
        console.log(`[UPLOAD STATUSTEXT] ${text}`);
      }
    }
  } catch {
    // ignore parse errors
  }
}

export function validateMission(
  home: { lat: number; lng: number } | null,
  waypoints: any[]
): UploadValidation {
  console.log("========== BACKEND MISSION VALIDATION STARTED ==========");

  const errors: string[] = [];

  if (!vehicleState.connected) {
    console.log("[VALIDATION] FAILED — No vehicle connected");
    errors.push("No vehicle connected.");
    return { valid: false, errors };
  }

  if (!waypoints || waypoints.length === 0) {
    console.log("[VALIDATION] FAILED — No waypoints in mission");
    errors.push("No waypoints in mission.");
    return { valid: false, errors };
  }

  console.log(`[VALIDATION] Waypoint count: ${waypoints.length}`);

  for (const wp of waypoints) {
    if (typeof wp.lat !== "number" || isNaN(wp.lat)) {
      console.log(`[VALIDATION] FAILED — Waypoint ${wp.id} has invalid latitude`);
      errors.push(`Waypoint ${wp.id} has invalid latitude.`);
      return { valid: false, errors };
    }
    if (typeof wp.lng !== "number" || isNaN(wp.lng)) {
      console.log(`[VALIDATION] FAILED — Waypoint ${wp.id} has invalid longitude`);
      errors.push(`Waypoint ${wp.id} has invalid longitude.`);
      return { valid: false, errors };
    }
    if (typeof wp.altitude !== "number" || isNaN(wp.altitude) || wp.altitude <= 0) {
      console.log(`[VALIDATION] FAILED — Waypoint ${wp.id} has invalid altitude`);
      errors.push(`Waypoint ${wp.id} has invalid altitude.`);
      return { valid: false, errors };
    }
  }

  if (waypoints.length >= 2) {
    for (let i = 0; i < waypoints.length; i++) {
      for (let j = i + 1; j < waypoints.length; j++) {
        const latDiff = Math.abs(waypoints[i].lat - waypoints[j].lat);
        const lngDiff = Math.abs(waypoints[i].lng - waypoints[j].lng);
        const altDiff = Math.abs(waypoints[i].altitude - waypoints[j].altitude);

        if (latDiff < LAT_LNG_TOLERANCE && lngDiff < LAT_LNG_TOLERANCE && altDiff < ALT_TOLERANCE) {
          console.log(`[VALIDATION] FAILED — Duplicate waypoints: WP${waypoints[i].id} and WP${waypoints[j].id}`);
          errors.push("Duplicate waypoints detected.");
          return { valid: false, errors };
        }
      }
    }
    console.log("[VALIDATION] Duplicate check: PASSED");
  } else {
    console.log("[VALIDATION] Duplicate check: SKIPPED (fewer than 2 waypoints)");
  }

  const sorted = [...waypoints].sort((a: any, b: any) => a.sequence - b.sequence);
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].sequence !== i + 1) {
      console.log(`[VALIDATION] FAILED — Invalid sequence at WP${sorted[i].id}: expected ${i + 1}, got ${sorted[i].sequence}`);
      errors.push("Waypoint numbering is incorrect.");
      return { valid: false, errors };
    }
  }
  console.log("[VALIDATION] Sequence check: PASSED");

  console.log("[VALIDATION] PASSED");
  return { valid: errors.length === 0, errors };
}

function waitForMissionRequest(seq: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timeout waiting for MISSION_REQUEST/MISSION_REQUEST_INT seq=${seq}`));
    }, timeoutMs);

    const unsubscribe = onPacket(51, (packet: any) => {
      try {
        const request = parseMissionRequest(packet);
        if (request && request.seq === seq) {
          console.log(`[UPLOAD] Received MISSION_REQUEST_INT seq=${seq}`);
          clearTimeout(timer);
          cleanup();
          resolve();
        }
      } catch {
        // ignore parse errors
      }
    });

    const unsubscribeLegacy = onPacket(40, (packet: any) => {
      try {
        if (packet.header.msgid === 40) {
          const msg = packet.protocol.data(packet.payload, common.MissionRequest) as any;
          if (msg.seq === seq) {
            console.log(`[UPLOAD] Received MISSION_REQUEST (legacy) seq=${seq}`);
            clearTimeout(timer);
            cleanup();
            unsubscribeLegacy();
            resolve();
          }
        }
      } catch {
        // ignore parse errors
      }
    });

    function cleanup() {
      unsubscribe();
      unsubscribeLegacy();
    }
  });
}

function waitForMissionAck(timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timeout waiting for MISSION_ACK"));
    }, timeoutMs);

    const unsubscribe = onPacket(47, (packet: any) => {
      try {
        console.log(`[UPLOAD] RAW MISSION_ACK packet received (msgid=47)`);
        const ackType = parseMissionAckResult(packet);
        if (ackType !== null) {
          console.log(`[UPLOAD] MISSION_ACK type=${ackType} (${getAckResultMessage(ackType)})`);
          clearTimeout(timer);
          cleanup();
          resolve(ackType);
        }
      } catch {
        // ignore parse errors
      }
    });

    function cleanup() {
      unsubscribe();
    }
  });
}

export async function uploadMission(
  home: { lat: number; lng: number } | null,
  waypoints: Array<{
    id: number;
    lat: number;
    lng: number;
    altitude: number;
    hoverTime: number;
    sequence: number;
  }>,
  onProgress: UploadProgressCallback
): Promise<{ items: MavlinkMissionItem[]; ackCode: number }> {
  const transport = getTransport();
  if (!transport) {
    throw new Error("No transport available for mission upload.");
  }

  const sysId = vehicleState.systemId || 1;
  const compId = vehicleState.componentId || 1;

  const hLat = home?.lat ?? (telemetry.homeLatitude || telemetry.latitude || 0);
  const hLng = home?.lng ?? (telemetry.homeLongitude || telemetry.longitude || 0);
  const hAlt = telemetry.homeAltitude || telemetry.altitude || 0;

  const items = waypointsToMavlinkItems(waypoints, hLat, hLng, hAlt, vehicleState.vehicleType);

  clearUploadStatusText();

  const statusTextUnsub = onPacket(253, (packet: any) => {
    captureStatusText(packet);
  });

  console.log(`[UPLOAD] items.length=${items.length} — these are the waypoints being sent`);

  console.log("========================================");
  console.log("[UPLOAD] Starting mission upload");
  console.log(`[UPLOAD] System ID: ${sysId}, Component ID: ${compId}`);
  console.log(`[UPLOAD] Total mission items: ${items.length}`);
  items.forEach((item, idx) => {
    console.log(`[UPLOAD]   Item ${idx}: seq=${item.seq} cmd=${item.command} frame=${item.frame} lat=${item.x} lon=${item.y} alt=${item.z}`);
  });

  onProgress("uploading", 0, items.length);

  console.log("[UPLOAD] >>> Sending MISSION_COUNT");
  console.log(`[UPLOAD] >>>   count=${items.length} missionType=0`);
  await sendMissionCount(transport, items.length, sysId, compId);

  for (let i = 0; i < items.length; i++) {
    console.log(`[UPLOAD] >>> Waiting for MISSION_REQUEST/MISSION_REQUEST_INT seq=${i}...`);
    try {
      await waitForMissionRequest(i, 10000);
      console.log(`[UPLOAD] <<< Got request for seq=${i}, sending MISSION_ITEM_INT`);
    } catch (err: any) {
      console.log(`[UPLOAD] <<< ${err.message} — sending MISSION_ITEM_INT anyway`);
    }

    const msg = createMissionItemInt(items[i], sysId, compId);
    console.log(`[UPLOAD] >>> Sending MISSION_ITEM_INT #${items[i].seq}`);
    console.log(`[UPLOAD] >>>   command=${items[i].command} frame=${items[i].frame}`);
    console.log(`[UPLOAD] >>>   x(raw)=${(msg as any).x} y(raw)=${(msg as any).y} z=${items[i].z}`);
    console.log(`[UPLOAD] >>>   param1=${items[i].param1} autocontinue=${items[i].autocontinue}`);
    await send(transport, msg, new MavLinkProtocolV2());
    onProgress("uploading", i + 1, items.length);
  }

  console.log("[UPLOAD] All items sent. Waiting for MISSION_ACK...");

  let ackCode: number;
  try {
    ackCode = await waitForMissionAck(10000);
    const ackLabel = getAckResultMessage(ackCode);
    console.log(`[UPLOAD] MISSION_ACK final: code=${ackCode} label=${ackLabel}`);
  } catch (err: any) {
    console.log(`[UPLOAD] MISSION_ACK timeout: ${err.message}`);
    console.log("[UPLOAD] StatusText during upload:");
    uploadStatusText.forEach(t => console.log(`[UPLOAD]   ${t}`));
    throw new Error("Mission upload failed: No MISSION_ACK received from vehicle.");
  } finally {
    statusTextUnsub();
  }

  if (ackCode !== 0) {
    const ackLabel = getAckResultMessage(ackCode);
    const statusContext = uploadStatusText.length > 0
      ? ` Vehicle reported: ${uploadStatusText.join(" | ")}`
      : "";
    const msg = `Mission upload rejected — ${ackLabel}.${statusContext}`;
    console.log(`[UPLOAD] ${msg}`);
    throw new Error(msg);
  }

  console.log("[UPLOAD] MISSION_ACK = MAV_MISSION_ACCEPTED — Mission uploaded successfully");
  onProgress("done", items.length, items.length);

  return { items, ackCode };
}

export function getAckErrorMessage(code: number): string {
  return `MISSION_ACK ${getAckResultMessage(code)}`;
}
