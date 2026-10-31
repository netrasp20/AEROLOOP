import { send, common, MavLinkProtocolV2 } from "node-mavlink";
import type { Writable } from "stream";

/* ------------------------------------------------------------------ */
/*  Messages to request — each with a target interval                  */
/* ------------------------------------------------------------------ */

const DESIRED_MESSAGES: Array<{
  msgid: number;
  intervalUs: number;
  name: string;
}> = [
  { msgid: 30,  intervalUs: 100000, name: "ATTITUDE" },
  { msgid: 33,  intervalUs: 100000, name: "GLOBAL_POSITION_INT" },
  { msgid: 24,  intervalUs: 100000, name: "GPS_RAW_INT" },
  { msgid: 1,   intervalUs: 100000, name: "SYS_STATUS" },
  { msgid: 147, intervalUs: 500000, name: "BATTERY_STATUS" },
  { msgid: 74,  intervalUs: 200000, name: "VFR_HUD" },
  { msgid: 32,  intervalUs: 100000, name: "LOCAL_POSITION_NED" },
  { msgid: 42,  intervalUs: 500000, name: "MISSION_CURRENT" },
  { msgid: 46,  intervalUs: 500000, name: "MISSION_ITEM_REACHED" },
  { msgid: 253, intervalUs: 500000, name: "STATUSTEXT" },
];

/* ------------------------------------------------------------------ */
/*  Legacy data streams to enable                                      */
/* ------------------------------------------------------------------ */

const DATA_STREAMS: Array<{
  streamId: number;
  rateHz: number;
  name: string;
}> = [
  { streamId: 2,  rateHz: 10, name: "EXTENDED_STATUS" },
  { streamId: 10, rateHz: 10, name: "EXTRA1" },
  { streamId: 11, rateHz: 10, name: "EXTRA2" },
  { streamId: 12, rateHz: 4,  name: "EXTRA3" },
  { streamId: 6,  rateHz: 10, name: "POSITION" },
];

/* ------------------------------------------------------------------ */
/*  Guard: only request once                                           */
/* ------------------------------------------------------------------ */

let requested = false;

/* ------------------------------------------------------------------ */
/*  Main entry point                                                   */
/* ------------------------------------------------------------------ */

export async function requestTelemetryStreams(
  transport: Writable,
  targetSystem: number,
  targetComponent: number
): Promise<void> {
  if (requested) return;
  requested = true;

  const sysId = targetSystem || 1;
  const compId = targetComponent || 1;

  console.log("📡 Requesting telemetry streams from vehicle...");

  /* ---- MAV_CMD_SET_MESSAGE_INTERVAL (modern) ---- */

  for (const msg of DESIRED_MESSAGES) {
    try {
      const cmd = new common.SetMessageIntervalCommand();
      cmd.targetSystem = sysId;
      cmd.targetComponent = compId;
      cmd.messageId = msg.msgid;
      cmd.interval = msg.intervalUs;

      await send(transport, cmd, new MavLinkProtocolV2());

      console.log(`  ✅ ${msg.name}  (msgid=${msg.msgid}, ${msg.intervalUs}µs)`);
    } catch (err) {
      console.error(`  ❌ ${msg.name}:`, (err as Error).message);
    }
  }

  /* ---- REQUEST_DATA_STREAM (legacy fallback) ---- */

  for (const ds of DATA_STREAMS) {
    try {
      const rds = new common.RequestDataStream();
      rds.targetSystem = sysId;
      rds.targetComponent = compId;
      rds.reqStreamId = ds.streamId;
      rds.reqMessageRate = ds.rateHz;
      rds.startStop = 1;

      await send(transport, rds, new MavLinkProtocolV2());

      console.log(`  ✅ ${ds.name} stream  (id=${ds.streamId}, ${ds.rateHz}Hz)`);
    } catch (err) {
      console.error(`  ❌ ${ds.name}:`, (err as Error).message);
    }
  }

  /* ---- Request ArduPilot's HOME_POSITION (msgid 242) ----
     HOME_POSITION is the authoritative RTL target. ArduPilot does not stream
     it by default, so we send MAV_CMD_GET_HOME_POSITION which triggers a
     single HOME_POSITION reply carrying the true stored home. */
  try {
    const cmd = new common.CommandLong();
    cmd.targetSystem = sysId;
    cmd.targetComponent = compId;
    (cmd as any).command = 410; // MAV_CMD_GET_HOME_POSITION
    cmd.confirmation = 0;
    cmd._param1 = 0; cmd._param2 = 0; cmd._param3 = 0; cmd._param4 = 0;
    cmd._param5 = 0; cmd._param6 = 0; cmd._param7 = 0;
    await send(transport, cmd, new MavLinkProtocolV2());
    console.log("  ✅ HOME_POSITION requested (MAV_CMD_GET_HOME_POSITION)");
  } catch (err) {
    console.error("  ❌ HOME_POSITION request:", (err as Error).message);
  }

  console.log("📡 Telemetry stream requests sent.");
}

/* ------------------------------------------------------------------ */
/*  Reset (allows re-requesting after disconnect / reconnect)          */
/* ------------------------------------------------------------------ */

export function resetStreamRequested(): void {
  requested = false;
}
