import { send, common, MavLinkProtocolV2 } from "node-mavlink";
import type { Writable } from "stream";
import type { MavlinkMissionItem } from "../../models/mission.model";

export const MAV_MISSION_TYPE_MISSION = 0;
const MAV_FRAME_GLOBAL_RELATIVE_ALT = 3;
const MAV_CMD_NAV_WAYPOINT = 16;
const MAV_CMD_NAV_TAKEOFF = 22;
/* MAV_CMD_DO_SET_HOME is intentionally not used in the mission list.
 * See waypointsToMavlinkItems for rationale. */

export type MissionProgressCallback = (
  current: number,
  total: number
) => void;

export function waypointsToMavlinkItems(
  waypoints: Array<{
    lat: number;
    lng: number;
    altitude: number;
    hoverTime: number;
    sequence: number;
  }>,
  homeLat: number,
  homeLng: number,
  homeAlt: number,
  vehicleType?: string,
): MavlinkMissionItem[] {
  const isGroundVehicle = vehicleType
    ? vehicleType.startsWith("GROUND") || vehicleType === "SURFACE_BOAT"
    : false;
  /* ArduPilot RESERVES mission item seq=0 as the HOME position
     (AP_MISSION_FIRST_REAL_COMMAND = 1 — "command #0 reserved to hold home
     position"). The first REAL command therefore sits at seq=1:
     - Ground vehicle → seq=0 HOME placeholder, seq=1..N the waypoints.
     - Air vehicle (copter/plane) → seq=0 HOME, seq=1 NAV_TAKEOFF (controlled
       climb to the first waypoint's altitude), seq=2..N+1 the waypoints.
     This matches professional ArduPilot GCS missions: Arm → Takeoff → WP1.. */
  const items: MavlinkMissionItem[] = [];

  /* seq=0 — HOME (required by ArduPilot for every vehicle) */
  items.push({
    seq: 0,
    frame: MAV_FRAME_GLOBAL_RELATIVE_ALT,
    command: MAV_CMD_NAV_WAYPOINT,
    current: 0,
    autocontinue: 1,
    param1: 0, param2: 0, param3: 0, param4: 0,
    x: homeLat,
    y: homeLng,
    z: 0,
  });

  /* seq=1 — first real command */
  if (!isGroundVehicle) {
    const takeoffAlt = waypoints[0]?.altitude || 10;
    items.push({
      seq: 1,
      frame: MAV_FRAME_GLOBAL_RELATIVE_ALT,
      command: MAV_CMD_NAV_TAKEOFF,
      current: 1,
      autocontinue: 1,
      param1: 0, param2: 0, param3: 0, param4: 0,
      x: homeLat,
      y: homeLng,
      z: takeoffAlt,
    });
  }

  for (let i = 0; i < waypoints.length; i++) {
    const wp = waypoints[i];
    const seq = isGroundVehicle ? i + 1 : i + 2;
    items.push({
      seq,
      frame: MAV_FRAME_GLOBAL_RELATIVE_ALT,
      command: MAV_CMD_NAV_WAYPOINT,
      current: isGroundVehicle && i === 0 ? 1 : 0,
      autocontinue: 1,
      param1: wp.hoverTime || 0,
      param2: 0, param3: 0, param4: 0,
      x: wp.lat,
      y: wp.lng,
      z: isGroundVehicle ? 0 : (wp.altitude || 10),
    });
  }

  return items;
}

export async function sendMissionCount(
  transport: Writable,
  count: number,
  sysId: number,
  compId: number
): Promise<void> {
  const msg = new common.MissionCount();
  msg.targetSystem = sysId;
  msg.targetComponent = compId;
  msg.count = count;
  msg.missionType = MAV_MISSION_TYPE_MISSION;
  await send(transport, msg, new MavLinkProtocolV2());
}

export function createMissionItemInt(
  item: MavlinkMissionItem,
  sysId: number,
  compId: number
): common.MissionItemInt {
  const msg = new common.MissionItemInt();
  msg.targetSystem = sysId;
  msg.targetComponent = compId;
  msg.seq = item.seq;
  msg.frame = item.frame;
  msg.command = item.command;
  msg.current = item.current;
  msg.autocontinue = item.autocontinue;
  msg.param1 = item.param1;
  msg.param2 = item.param2;
  msg.param3 = item.param3;
  msg.param4 = item.param4;
  msg.x = Math.round(item.x * 1e7);
  msg.y = Math.round(item.y * 1e7);
  msg.z = item.z;
  msg.missionType = MAV_MISSION_TYPE_MISSION;
  return msg;
}

export function parseMissionRequest(packet: any): {
  seq: number;
} | null {
  if (packet.header.msgid === 51) {
    try {
      const msg = packet.protocol.data(
        packet.payload,
        common.MissionRequestInt
      ) as any;
      return { seq: msg.seq };
    } catch {
      return null;
    }
  }
  return null;
}

export function parseMissionAckResult(packet: any): number | null {
  if (packet.header.msgid === 47) {
    try {
      const msg = packet.protocol.data(
        packet.payload,
        common.MissionAck
      ) as any;
      return msg.type;
    } catch {
      return null;
    }
  }
  return null;
}

export function createMissionRequestList(
  sysId: number,
  compId: number
): common.MissionRequestList {
  const msg = new common.MissionRequestList();
  msg.targetSystem = sysId;
  msg.targetComponent = compId;
  msg.missionType = MAV_MISSION_TYPE_MISSION;
  return msg;
}

export function createMissionRequestInt(
  sysId: number,
  compId: number,
  seq: number
): common.MissionRequestInt {
  const msg = new common.MissionRequestInt();
  msg.targetSystem = sysId;
  msg.targetComponent = compId;
  msg.seq = seq;
  msg.missionType = MAV_MISSION_TYPE_MISSION;
  return msg;
}

export function parseMissionCount(packet: any): { count: number } | null {
  if (packet.header.msgid === 44) {
    try {
      const msg = packet.protocol.data(
        packet.payload,
        common.MissionCount
      ) as any;
      return { count: msg.count };
    } catch {
      return null;
    }
  }
  return null;
}

export function parseMissionItem(
  packet: any
): MavlinkMissionItem | null {
  try {
    let msg: any;
    let isInt: boolean;

    if (packet.header.msgid === 73) {
      msg = packet.protocol.data(packet.payload, common.MissionItemInt);
      isInt = true;
      console.log(`[MISSION_ITEM_INT] RAW seq=${msg.seq} frame=${msg.frame} command=${msg.command} x=${msg.x} y=${msg.y} z=${msg.z}`);
    } else if (packet.header.msgid === 39) {
      msg = packet.protocol.data(packet.payload, common.MissionItem);
      isInt = false;
      console.log(`[MISSION_ITEM] RAW seq=${msg.seq} frame=${msg.frame} command=${msg.command} x=${msg.x} y=${msg.y} z=${msg.z}`);
    } else {
      return null;
    }

    let lat: number;
    let lon: number;

    if (isInt) {
      lat = msg.x / 1e7;
      lon = msg.y / 1e7;
      console.log(`[MISSION_ITEM_INT] Converted: lat=${lat} lon=${lon} alt=${msg.z} (x/1e7, y/1e7)`);
    } else {
      lat = msg.x;
      lon = msg.y;
      console.log(`[MISSION_ITEM] Converted: lat=${lat} lon=${lon} alt=${msg.z} (float, no conversion)`);
    }

    return {
      seq: msg.seq,
      frame: msg.frame,
      command: msg.command,
      current: msg.current,
      autocontinue: msg.autocontinue,
      param1: msg.param1,
      param2: msg.param2,
      param3: msg.param3,
      param4: msg.param4,
      x: lat,
      y: lon,
      z: msg.z,
    };
  } catch (err: any) {
    console.error(`[MISSION_ITEM] Parse error: ${err.message}`);
    return null;
  }
}

const MAV_MISSION_ACK_MESSAGES: Record<number, string> = {
  0: "MAV_MISSION_ACCEPTED",
  1: "MAV_MISSION_ERROR",
  2: "MAV_MISSION_UNKNOWN_FRAME",
  3: "MAV_MISSION_UNKNOWN_COMMAND",
  4: "MAV_MISSION_INVALID_SEQUENCE",
  5: "MAV_MISSION_INVALID_PARAM1",
  6: "MAV_MISSION_INVALID_PARAM2",
  7: "MAV_MISSION_INVALID_PARAM3",
  8: "MAV_MISSION_INVALID_PARAM4",
  9: "MAV_MISSION_INVALID_PARAM5_X",
  10: "MAV_MISSION_INVALID_PARAM6_Y",
  11: "MAV_MISSION_INVALID_PARAM7_Z",
  12: "MAV_MISSION_INVALID_SEQUENCE",
  13: "MAV_MISSION_DENIED",
  14: "MAV_MISSION_OPERATION_IN_PROGRESS",
  15: "MAV_MISSION_INVALID_MAV_TYPE",
  16: "MAV_MISSION_INVALID_MISSION_TYPE",
  17: "MAV_MISSION_UNSUPPORTED",
  18: "MAV_MISSION_MAX_COUNT_EXCEEDED",
  19: "MAV_MISSION_INVALID_PROTOCOL_VERSION",
  20: "MAV_MISSION_INVALID_MAV_CAPABILITY",
  21: "MAV_MISSION_COUNT_CHANGED",
};

export function getAckResultMessage(code: number): string {
  return MAV_MISSION_ACK_MESSAGES[code] ?? `UNKNOWN(${code})`;
}
