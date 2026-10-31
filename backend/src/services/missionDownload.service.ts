import { send, common, MavLinkProtocolV2 } from "node-mavlink";
import type { Writable } from "stream";
import { vehicleState } from "../mavlink/vehicleState";
import { getTransport, onPacket } from "../mavlink/mavlink.service";
import {
  createMissionRequestList,
  createMissionRequestInt,
  parseMissionCount,
  parseMissionItem,
  getAckResultMessage,
} from "../mavlink/commands/MissionCommand";
import type { MavlinkMissionItem } from "../models/mission.model";

const REQUEST_TIMEOUT_MS = 10000;

export interface DownloadResult {
  success: boolean;
  items: MavlinkMissionItem[];
  count: number;
  error?: string;
}

function waitForMissionCount(timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timeout waiting for MISSION_COUNT"));
    }, timeoutMs);

    const unsubscribe = onPacket(44, (packet: any) => {
      try {
        const parsed = parseMissionCount(packet);
        if (parsed !== null) {
          console.log(`[DOWNLOAD] <<< MISSION_COUNT received: count=${parsed.count}`);
          clearTimeout(timer);
          cleanup();
          resolve(parsed.count);
        }
      } catch {
        /* ignore parse errors */
      }
    });

    function cleanup() {
      unsubscribe();
    }
  });
}

function waitForMissionItemInt(seq: number, timeoutMs: number): Promise<MavlinkMissionItem> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timeout waiting for MISSION_ITEM_INT seq=${seq}`));
    }, timeoutMs);

    const unsubscribe = onPacket(73, (packet: any) => {
      try {
        const item = parseMissionItem(packet);
        if (item && item.seq === seq) {
          console.log(`[DOWNLOAD] <<< MISSION_ITEM_INT seq=${seq} received: cmd=${item.command} lat=${item.x} lon=${item.y} alt=${item.z}`);
          clearTimeout(timer);
          cleanup();
          resolve(item);
        }
      } catch {
        /* ignore parse errors */
      }
    });

    function cleanup() {
      unsubscribe();
    }
  });
}

export async function downloadMissionFromArduPilot(): Promise<DownloadResult> {
  const transport = getTransport();
  if (!transport) {
    return { success: false, items: [], count: 0, error: "No transport available" };
  }

  const sysId = vehicleState.systemId || 1;
  const compId = vehicleState.componentId || 1;

  console.log("[DOWNLOAD] Requesting mission list from ArduPilot...");
  console.log(`[DOWNLOAD] >>> Sending MISSION_REQUEST_LIST (sys=${sysId} comp=${compId})`);

  const requestList = createMissionRequestList(sysId, compId);
  await send(transport, requestList, new MavLinkProtocolV2());

  let count: number;
  try {
    count = await waitForMissionCount(REQUEST_TIMEOUT_MS);
    console.log(`[DOWNLOAD] ArduPilot reports ${count} mission items`);
  } catch (err: any) {
    console.error(`[DOWNLOAD] Failed to get MISSION_COUNT: ${err.message}`);
    return { success: false, items: [], count: 0, error: err.message };
  }

  if (count === 0) {
    console.log("[DOWNLOAD] No mission stored on ArduPilot (count=0)");
    return { success: true, items: [], count: 0 };
  }

  const items: MavlinkMissionItem[] = [];

  for (let seq = 0; seq < count; seq++) {
    console.log(`[DOWNLOAD] >>> Requesting MISSION_ITEM_INT seq=${seq}...`);
    const requestItem = createMissionRequestInt(sysId, compId, seq);
    await send(transport, requestItem, new MavLinkProtocolV2());

    try {
      const item = await waitForMissionItemInt(seq, REQUEST_TIMEOUT_MS);
      items.push(item);
      console.log(`[DOWNLOAD]   Item ${seq}/${count - 1}: cmd=${item.command} lat=${item.x.toFixed(6)} lon=${item.y.toFixed(6)} alt=${item.z}`);
    } catch (err: any) {
      const msg = `Failed to download mission item seq=${seq}: ${err.message}`;
      console.error(`[DOWNLOAD] ${msg}`);
      return { success: false, items, count, error: msg };
    }
  }

  console.log(`[DOWNLOAD] Downloaded ${items.length}/${count} items from ArduPilot`);
  return { success: true, items, count };
}

export interface VerificationResult {
  match: boolean;
  uploadedCount: number;
  downloadedCount: number;
  differences: string[];
  uploadedItems: MavlinkMissionItem[];
  downloadedItems: MavlinkMissionItem[];
}

export function verifyMission(
  uploadedItems: MavlinkMissionItem[],
  downloadedItems: MavlinkMissionItem[]
): VerificationResult {
  const differences: string[] = [];

  console.log("========== MISSION VERIFICATION ==========");
  console.log(`[VERIFY] Uploaded count:   ${uploadedItems.length}`);
  console.log(`[VERIFY] Downloaded count: ${downloadedItems.length}`);

  uploadedItems.forEach((item, i) => {
    console.log(`[VERIFY] Uploaded [${i}]: cmd=${item.command} frame=${item.frame} lat=${item.x} lon=${item.y} alt=${item.z} seq=${item.seq} current=${item.current} autocon=${item.autocontinue} p1=${item.param1}`);
  });
  downloadedItems.forEach((item, i) => {
    console.log(`[VERIFY] Downloaded [${i}]: cmd=${item.command} frame=${item.frame} lat=${item.x} lon=${item.y} alt=${item.z} seq=${item.seq} current=${item.current} autocon=${item.autocontinue} p1=${item.param1}`);
  });

  /* We upload HOME + waypoints. Both arrays should have the same length.
   * If downloaded has 1 extra item, shift (legacy offset for missions
   * uploaded without a HOME item). */
  let dlOffset = 0;
  let skipFirstUploaded = false;

  if (downloadedItems.length === uploadedItems.length + 1) {
    console.log(`[VERIFY] Downloaded has 1 extra item — item 0 is the ArduPilot HOME position, skipping it`);
    console.log(`[VERIFY] HOME item: cmd=${downloadedItems[0].command} frame=${downloadedItems[0].frame} lat=${downloadedItems[0].x} lon=${downloadedItems[0].y} alt=${downloadedItems[0].z}`);
    dlOffset = 1;
  } else if (downloadedItems.length === uploadedItems.length - 1) {
    /* ArduPilot did not include our HOME item (seq=0). Skip the first uploaded item. */
    console.log(`[VERIFY] Downloaded has 1 fewer item — ArduPilot did not store our HOME placeholder, skipping first uploaded item`);
    skipFirstUploaded = true;
  } else if (downloadedItems.length !== uploadedItems.length) {
    differences.push(`Item count mismatch: uploaded=${uploadedItems.length} downloaded=${downloadedItems.length}`);
    console.log(`[VERIFY] FAILED — ${differences[0]}`);
    console.log("==========================================");
    return {
      match: false,
      uploadedCount: uploadedItems.length,
      downloadedCount: downloadedItems.length,
      differences,
      uploadedItems,
      downloadedItems,
    };
  }

  const startIdx = skipFirstUploaded ? 1 : 0;
  for (let i = startIdx; i < uploadedItems.length; i++) {
    const u = uploadedItems[i];
    const d = downloadedItems[i - (skipFirstUploaded ? 1 : 0) + dlOffset];
    const isHome = i === 0;

    const ulabel = skipFirstUploaded ? `(skipped uploaded[0]=HOME) uploaded[${i}]` : `uploaded[${i}]`;
    console.log(`[VERIFY] Comparing item ${i} (${ulabel} ↔ downloaded[${i - (skipFirstUploaded ? 1 : 0) + dlOffset}])${isHome ? ' — HOME item' : ''}:`);
    console.log(`[VERIFY]   Uploaded   seq=${u.seq} cmd=${u.command} frame=${u.frame} lat=${u.x} lon=${u.y} alt=${u.z} cur=${u.current} p1=${u.param1} autocon=${u.autocontinue}`);
    console.log(`[VERIFY]   Downloaded seq=${d.seq} cmd=${d.command} frame=${d.frame} lat=${d.x} lon=${d.y} alt=${d.z} cur=${d.current} p1=${d.param1} autocon=${d.autocontinue}`);

    if (isHome) {
      /* HOME item — relaxed tolerances; ArduPilot may adjust it */
      if (Math.abs(u.x - d.x) > 0.001) {
        differences.push(`Item ${i} (HOME) lat mismatch: uploaded=${u.x} downloaded=${d.x}`);
      }
      if (Math.abs(u.y - d.y) > 0.001) {
        differences.push(`Item ${i} (HOME) lon mismatch: uploaded=${u.y} downloaded=${d.y}`);
      }
      /* HOME altitude is always 0 (relative); ArduPilot may store absolute. Skip check. */
    } else {
      /* Regular waypoint — strict tolerances */
      if (Math.abs(u.x - d.x) > 0.000001) {
        differences.push(`Item ${i} lat mismatch: uploaded=${u.x} downloaded=${d.x}`);
      }
      if (Math.abs(u.y - d.y) > 0.000001) {
        differences.push(`Item ${i} lon mismatch: uploaded=${u.y} downloaded=${d.y}`);
      }
      if (Math.abs(u.z - d.z) > 0.5) {
        differences.push(`Item ${i} alt mismatch: uploaded=${u.z} downloaded=${d.z}`);
      }
      if (Math.abs(u.param1 - d.param1) > 0.01) {
        differences.push(`Item ${i} param1 (hover time) mismatch: uploaded=${u.param1} downloaded=${d.param1}`);
      }
    }
    if (u.command !== d.command) {
      differences.push(`Item ${i} command mismatch: uploaded=${u.command} downloaded=${d.command}`);
    }
    if (u.frame !== d.frame) {
      console.log(`[VERIFY] WARNING — Item ${i} frame mismatch (uploaded=${u.frame} downloaded=${d.frame}) — continuing`);
    }
  }

  console.log(`[VERIFY] ${differences.length === 0 ? "PASSED — Mission matches ArduPilot" : `FAILED — ${differences.length} difference(s)`}`);
  if (differences.length > 0) {
    differences.forEach(d => console.log(`[VERIFY]   ${d}`));
  } else {
    console.log(`[VERIFY] All ${uploadedItems.length} items match perfectly`);
  }
  console.log("==========================================");

  return {
    match: differences.length === 0,
    uploadedCount: uploadedItems.length,
    downloadedCount: downloadedItems.length,
    differences,
    uploadedItems,
    downloadedItems,
  };
}

export async function getMissionCountFromArduPilot(): Promise<number> {
  const transport = getTransport();
  if (!transport) return -1;

  const sysId = vehicleState.systemId || 1;
  const compId = vehicleState.componentId || 1;

  const requestList = createMissionRequestList(sysId, compId);
  await send(transport, requestList, new MavLinkProtocolV2());

  try {
    const count = await waitForMissionCount(5000);
    console.log(`[MISSION COUNT] ArduPilot reports ${count} mission items`);
    return count;
  } catch {
    console.log("[MISSION COUNT] Failed to get mission count from ArduPilot");
    return -1;
  }
}
