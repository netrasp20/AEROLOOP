import { send, MavLinkProtocolV2 } from "node-mavlink";
import type { Writable } from "stream";
import { onPacket, offPacket } from "../mavlink.service";
import {
  createMissionRequestList,
  createMissionRequestInt,
  parseMissionCount,
  parseMissionItem,
} from "./MissionCommand";
import type { MavlinkMissionItem, VerificationResult, VerificationMismatch } from "../../models/mission.model";

const LAT_TOLERANCE = 0.000001;
const LON_TOLERANCE = 0.000001;
const ALT_TOLERANCE = 0.1;

const MISSION_COUNT_MSGID = 44;
const MISSION_ITEM_MSGID = 39;
const MISSION_ITEM_INT_MSGID = 73;

function waitForPacket(msgid: number, timeoutMs: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      offPacket(msgid, handler);
      reject(new Error(`Timeout waiting for msgid ${msgid} (timeout=${timeoutMs}ms)`));
    }, timeoutMs);

    const handler = (packet: any) => {
      clearTimeout(timer);
      resolve(packet);
    };

    onPacket(msgid, handler);
  });
}

function waitForAnyPacket(msgids: number[], timeoutMs: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const unsubs: (() => void)[] = [];

    const timer = setTimeout(() => {
      for (const unsub of unsubs) unsub();
      reject(new Error(`Timeout waiting for msgids [${msgids.join(",")}] (timeout=${timeoutMs}ms)`));
    }, timeoutMs);

    for (const msgid of msgids) {
      const handler = (packet: any) => {
        clearTimeout(timer);
        for (const unsub of unsubs) unsub();
        resolve(packet);
      };
      onPacket(msgid, handler);
      unsubs.push(() => offPacket(msgid, handler));
    }
  });
}

export async function verifyMission(
  uploadedItems: MavlinkMissionItem[],
  transport: Writable,
  sysId: number,
  compId: number,
  onProgress: (current: number, total: number) => void
): Promise<VerificationResult> {
  const mismatches: VerificationMismatch[] = [];

  console.log("[VERIFIER] Requesting mission list from vehicle...");

  const requestList = createMissionRequestList(sysId, compId);
  await send(transport, requestList, new MavLinkProtocolV2());

  console.log("[VERIFIER] Waiting for MISSION_COUNT...");

  let countPacket: any;
  try {
    countPacket = await waitForPacket(MISSION_COUNT_MSGID, 10000);
  } catch (err: any) {
    console.error(`[VERIFIER] ${err.message}`);
    return {
      success: false,
      uploadedCount: uploadedItems.length,
      downloadedCount: 0,
      mismatches: [],
    };
  }

  const countResult = parseMissionCount(countPacket);
  if (!countResult) {
    console.error("[VERIFIER] Failed to parse MISSION_COUNT");
    return {
      success: false,
      uploadedCount: uploadedItems.length,
      downloadedCount: 0,
      mismatches: [],
    };
  }

  const vehicleCount = countResult.count;
  console.log(`[VERIFIER] MISSION_COUNT received: ${vehicleCount}`);

  if (vehicleCount === 0) {
    console.error("[VERIFIER] Vehicle reports 0 mission items");
    return {
      success: false,
      uploadedCount: uploadedItems.length,
      downloadedCount: 0,
      mismatches: [],
    };
  }

  const downloadedItems: MavlinkMissionItem[] = [];

  for (let seq = 0; seq < vehicleCount; seq++) {
    console.log(`[VERIFIER] Requesting waypoint #${seq}...`);

    const requestItem = createMissionRequestInt(sysId, compId, seq);
    await send(transport, requestItem, new MavLinkProtocolV2());

    let itemPacket: any;
    try {
      itemPacket = await waitForAnyPacket(
        [MISSION_ITEM_MSGID, MISSION_ITEM_INT_MSGID],
        5000
      );
    } catch (err: any) {
      console.error(`[VERIFIER] ${err.message}`);
      onProgress(seq, vehicleCount);
      return {
        success: false,
        uploadedCount: uploadedItems.length,
        downloadedCount: downloadedItems.length,
        mismatches,
      };
    }

    console.log(`[VERIFIER] Raw packet: msgid=${itemPacket.header.msgid}`);

    const item = parseMissionItem(itemPacket);
    if (!item) {
      console.error(`[VERIFIER] Failed to parse mission item for seq ${seq}`);
      return {
        success: false,
        uploadedCount: uploadedItems.length,
        downloadedCount: downloadedItems.length,
        mismatches,
      };
    }

    console.log(`[VERIFIER] Downloaded waypoint #${seq}: cmd=${item.command} frame=${item.frame} lat=${item.x} lon=${item.y} alt=${item.z}`);
    downloadedItems.push(item);
    onProgress(seq + 1, vehicleCount);
  }

  const uploadedWaypoints = uploadedItems.slice(1);
  const downloadedWaypoints = downloadedItems.slice(1);

  const uploadedWpCount = uploadedWaypoints.length;
  const downloadedWpCount = downloadedWaypoints.length;

  console.log(`[VERIFIER] Skipping Waypoint #0 (HOME). Verifying ${uploadedWpCount} uploaded waypoints against ${downloadedWpCount} downloaded waypoints...`);

  const compareCount = Math.min(uploadedWpCount, downloadedWpCount);

  for (let i = 0; i < compareCount; i++) {
    const wpNum = i + 1;
    const up = uploadedWaypoints[i];
    const down = downloadedWaypoints[i];

    if (up.command !== down.command) {
      mismatches.push({ waypoint: wpNum, field: "command", uploaded: up.command, downloaded: down.command });
    }

    if (up.frame !== down.frame) {
      mismatches.push({ waypoint: wpNum, field: "frame", uploaded: up.frame, downloaded: down.frame });
    }

    if (Math.abs(up.x - down.x) > LAT_TOLERANCE) {
      mismatches.push({ waypoint: wpNum, field: "latitude", uploaded: up.x, downloaded: down.x });
    }

    if (Math.abs(up.y - down.y) > LON_TOLERANCE) {
      mismatches.push({ waypoint: wpNum, field: "longitude", uploaded: up.y, downloaded: down.y });
    }

    if (Math.abs(up.z - down.z) > ALT_TOLERANCE) {
      mismatches.push({ waypoint: wpNum, field: "altitude", uploaded: up.z, downloaded: down.z });
    }

    if (up.seq !== down.seq) {
      mismatches.push({ waypoint: wpNum, field: "sequence", uploaded: up.seq, downloaded: down.seq });
    }
  }

  if (uploadedWpCount !== downloadedWpCount) {
    mismatches.push({
      waypoint: -1,
      field: "count",
      uploaded: uploadedWpCount,
      downloaded: downloadedWpCount,
    });
  }

  if (mismatches.length === 0) {
    console.log("[VERIFIER] Mission Verification PASSED");
  } else {
    console.log(`[VERIFIER] Mission Verification FAILED — ${mismatches.length} mismatch(es)`);
    for (const m of mismatches) {
      console.log(`  [VERIFIER] Waypoint #${m.waypoint} ${m.field}: uploaded=${m.uploaded}, downloaded=${m.downloaded}`);
    }
  }

  return {
    success: mismatches.length === 0,
    uploadedCount: uploadedWpCount,
    downloadedCount: downloadedWpCount,
    mismatches,
  };
}
