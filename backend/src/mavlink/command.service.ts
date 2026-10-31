import { send, MavLinkProtocolV2 } from "node-mavlink";
import type { Writable } from "stream";
import { common } from "mavlink-mappings";

import { telemetry } from "./telemetry";
import { getTransport, onPacket } from "./mavlink.service";
import { vehicleState, clearArmStatusText, isVehicleConnected } from "./vehicleState";

const ACK_TIMEOUT_MS = 8000;
const HEARTBEAT_CONFIRM_TIMEOUT_MS = 3000;
const STATUSTEXT_DELAY_MS = 300;

const MAV_ACK_MESSAGES: Record<number, string> = {
  0: "ACCEPTED",
  1: "TEMPORARY_REJECTED",
  2: "DENIED",
  3: "UNSUPPORTED",
  4: "FAILED",
  5: "IN_PROGRESS",
  6: "CANCELLED",
  7: "COMMAND_INT_ONLY",
  8: "COMMAND_UNSUPPORTED_MAV_FRAME",
  9: "TIMEOUT",
};

export interface CommandResult {
  success: boolean;
  message: string;
  ackCode?: number;
  ackLabel?: string;
  statusText?: string;
}

function getAckLabel(code: number): string {
  return MAV_ACK_MESSAGES[code] ?? `UNKNOWN(${code})`;
}

function requireTransport(): Writable {
  const t = getTransport();
  if (!t) throw new Error("No transport available — vehicle not connected.");
  return t;
}

function waitForCommandAck(
  transport: Writable,
  command: common.CommandLong,
  sysId: number,
  compId: number,
  commandId: number,
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve) => {
    let resolved = false;

    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      cleanup();
      console.log(`[CMD] ACK TIMEOUT after ${ACK_TIMEOUT_MS}ms for command ${commandId}`);
      resolve({
        success: false,
        message: "Command acknowledgment timeout.",
        ackCode: -1,
        ackLabel: "TIMEOUT",
      });
    }, ACK_TIMEOUT_MS);

    const unsubscribe = onPacket(77, (packet: any) => {
      if (resolved) return;
      try {
        const msg = packet.protocol.data(packet.payload, common.CommandAck) as any;
        if (msg.command !== commandId) return;
        const ackLabel = getAckLabel(msg.result);
        console.log(`[CMD] COMMAND_ACK received — command=${msg.command} result=${msg.result} (${ackLabel})`);

        if (msg.result === 0) {
          resolved = true;
          cleanup();
          console.log("[CMD] Command ACCEPTED");
          resolve({
            success: true,
            message: "Command accepted.",
            ackCode: 0,
            ackLabel: "ACCEPTED",
          });
        } else {
          resolved = true;
          cleanup();
          console.log(`[CMD] Command REJECTED: ${ackLabel}`);
          const rejectionMsg = `Command rejected: ${ackLabel}`;
          resolve({
            success: false,
            message: rejectionMsg,
            ackCode: msg.result,
            ackLabel,
          });
        }
      } catch (err) {
        console.error(`[CMD] Error parsing COMMAND_ACK:`, err);
      }
    });

    function cleanup() {
      clearTimeout(timer);
      unsubscribe();
    }

    send(transport, command, new MavLinkProtocolV2()).catch((err) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      console.error(`[CMD] Send failed: ${err.message}`);
      resolve({
        success: false,
        message: `Failed to send command: ${err.message}`,
        ackCode: -1,
        ackLabel: "SEND_FAILED",
      });
    });
  });
}

/**
 * After receiving COMMAND_ACK, wait for the autopilot to send a HEARTBEAT
 * that reflects the requested armed state.  This catches edge cases where
 * the ACK says ACCEPTED but the vehicle does not actually arm.
 */
function waitForHeartbeatArmState(
  targetArmed: boolean,
  timeoutMs: number,
): Promise<{ success: boolean; message: string }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      clearInterval(interval);
      resolve({
        success: false,
        message: `Timeout waiting for armed=${targetArmed} in HEARTBEAT`,
      });
    }, timeoutMs);

    const interval = setInterval(() => {
      if (vehicleState.armed === targetArmed) {
        clearInterval(interval);
        clearTimeout(timer);
        resolve({
          success: true,
          message: targetArmed
            ? "Vehicle is armed (confirmed by HEARTBEAT)"
            : "Vehicle is disarmed (confirmed by HEARTBEAT)",
        });
      }
    }, 100);
  });
}

function waitForHeartbeatMode(
  targetMode: string,
  timeoutMs: number,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      clearInterval(interval);
      resolve({
        success: false,
        message: `Timeout waiting for mode=${targetMode} in HEARTBEAT`,
        ackCode: -1,
        ackLabel: "TIMEOUT",
      });
    }, timeoutMs);

    const interval = setInterval(() => {
      if (vehicleState.mode === targetMode) {
        clearInterval(interval);
        clearTimeout(timer);
        vehicleState.mode = targetMode;
        telemetry.mode = targetMode;
        console.log(`[MODE] Mode changed to ${targetMode} (confirmed by HEARTBEAT)`);
        resolve({
          success: true,
          message: `Mode changed to ${targetMode}`,
          ackCode: 0,
          ackLabel: "ACCEPTED",
        });
      }
    }, 100);
  });
}

export async function armVehicle(): Promise<CommandResult> {
  console.log("============================ ARM REQUEST ============================");
  console.log(`Vehicle Connected : ${isVehicleConnected()}`);
  console.log(`Serial Open       : ${vehicleState.serialPortOpen}`);
  console.log(`Heartbeat Age     : ${vehicleState.lastHeartbeat > 0 ? (Date.now() - vehicleState.lastHeartbeat) + 'ms' : 'NEVER'}`);
  console.log(`System ID         : ${vehicleState.systemId}`);
  console.log(`Component ID      : ${vehicleState.componentId}`);
  console.log(`Mode              : ${vehicleState.mode}`);
  console.log(`Armed             : ${vehicleState.armed}`);
  console.log(`Vehicle Type      : ${vehicleState.vehicleType}`);
  console.log(`Autopilot         : ${vehicleState.autopilot}`);
  console.log("====================================================================");

  const transport = requireTransport();
  const sysId = vehicleState.systemId || 1;
  const compId = vehicleState.componentId || 1;

  clearArmStatusText();

  const cmd = new common.CommandLong();
  cmd.targetSystem = sysId;
  cmd.targetComponent = compId;
  cmd.command = common.MavCmd.COMPONENT_ARM_DISARM;
  cmd.confirmation = 0;
  cmd._param1 = 1;
  cmd._param2 = 0;
  cmd._param3 = 0;
  cmd._param4 = 0;
  cmd._param5 = 0;
  cmd._param6 = 0;
  cmd._param7 = 0;

  console.log("[ARM] Sending MAV_CMD_COMPONENT_ARM_DISARM...");
  console.log(`[ARM]   targetSystem    = ${sysId}`);
  console.log(`[ARM]   targetComponent = ${compId}`);
  console.log(`[ARM]   command         = ${common.MavCmd.COMPONENT_ARM_DISARM} (MAV_CMD_COMPONENT_ARM_DISARM)`);
  console.log(`[ARM]   param1          = 1 (arm)`);
  console.log(`[ARM]   param2          = 0 (force)`);

  const ackResult = await waitForCommandAck(transport, cmd, sysId, compId, common.MavCmd.COMPONENT_ARM_DISARM);

  console.log("[ARM] COMMAND_ACK received");
  console.log(`[ARM]   Result  = ${ackResult.ackLabel}`);
  console.log(`[ARM]   Code    = ${ackResult.ackCode}`);
  console.log(`[ARM]   Message = ${ackResult.message}`);

  if (!ackResult.success) {
    await new Promise((r) => setTimeout(r, STATUSTEXT_DELAY_MS));
    const reason = vehicleState.lastArmStatusText;
    if (reason) {
      console.log(`[ARM] STATUSTEXT: ${reason}`);
      ackResult.statusText = reason;
      ackResult.message = reason;
    } else {
      ackResult.message = `Command rejected: ${ackResult.ackLabel}`;
    }
    console.log(`[ARM] Returning failure: ${ackResult.message}`);
    console.log("====================================================================");
    return ackResult;
  }

  console.log("[ARM] Waiting for HEARTBEAT armed=true...");
  const heartbeatConfirm = await waitForHeartbeatArmState(true, HEARTBEAT_CONFIRM_TIMEOUT_MS);
  console.log(`[ARM] HEARTBEAT confirm: ${heartbeatConfirm.message}`);

  if (!heartbeatConfirm.success) {
    console.log(`[ARM] HEARTBEAT confirm failed: ${heartbeatConfirm.message}`);
    console.log("====================================================================");
    return {
      success: false,
      message: heartbeatConfirm.message,
      ackCode: ackResult.ackCode,
      ackLabel: ackResult.ackLabel,
    };
  }

  console.log("[ARM] Vehicle armed successfully");
  console.log("====================================================================");
  return {
    success: true,
    message: "Vehicle armed successfully",
  };
}

export async function disarmVehicle(): Promise<CommandResult> {
  console.log("============================ DISARM REQUEST ============================");
  console.log(`Vehicle Connected : ${isVehicleConnected()}`);
  console.log(`Serial Open       : ${vehicleState.serialPortOpen}`);
  console.log(`Heartbeat Age     : ${vehicleState.lastHeartbeat > 0 ? (Date.now() - vehicleState.lastHeartbeat) + 'ms' : 'NEVER'}`);
  console.log(`System ID         : ${vehicleState.systemId}`);
  console.log(`Component ID      : ${vehicleState.componentId}`);
  console.log(`Mode              : ${vehicleState.mode}`);
  console.log(`Armed             : ${vehicleState.armed}`);
  console.log("=======================================================================");

  const transport = requireTransport();
  const sysId = vehicleState.systemId || 1;
  const compId = vehicleState.componentId || 1;

  const cmd = new common.CommandLong();
  cmd.targetSystem = sysId;
  cmd.targetComponent = compId;
  cmd.command = common.MavCmd.COMPONENT_ARM_DISARM;
  cmd.confirmation = 0;
  cmd._param1 = 0;
  cmd._param2 = 0;
  cmd._param3 = 0;
  cmd._param4 = 0;
  cmd._param5 = 0;
  cmd._param6 = 0;
  cmd._param7 = 0;

  console.log("[DISARM] Sending MAV_CMD_COMPONENT_ARM_DISARM...");
  console.log(`[DISARM]   targetSystem    = ${sysId}`);
  console.log(`[DISARM]   targetComponent = ${compId}`);
  console.log(`[DISARM]   param1          = 0 (disarm)`);

  const ackResult = await waitForCommandAck(transport, cmd, sysId, compId, common.MavCmd.COMPONENT_ARM_DISARM);

  console.log("[DISARM] COMMAND_ACK received");
  console.log(`[DISARM]   Result  = ${ackResult.ackLabel}`);
  console.log(`[DISARM]   Code    = ${ackResult.ackCode}`);

  if (!ackResult.success) {
    console.log(`[DISARM] Disarm failed: ${ackResult.ackLabel}`);
    console.log("=======================================================================");
    return ackResult;
  }

  console.log("[DISARM] Waiting for HEARTBEAT armed=false...");
  const heartbeatConfirm = await waitForHeartbeatArmState(false, HEARTBEAT_CONFIRM_TIMEOUT_MS);
  console.log(`[DISARM] HEARTBEAT confirm: ${heartbeatConfirm.message}`);

  if (!heartbeatConfirm.success) {
    console.log(`[DISARM] HEARTBEAT confirm failed: ${heartbeatConfirm.message}`);
    console.log("=======================================================================");
    return {
      success: false,
      message: heartbeatConfirm.message,
      ackCode: ackResult.ackCode,
      ackLabel: ackResult.ackLabel,
    };
  }

  console.log("[DISARM] Vehicle disarmed successfully");
  console.log("=======================================================================");
  return {
    success: true,
    message: "Vehicle disarmed successfully",
  };
}

/**
 * Map a logical mode name to the autopilot's custom_mode number AND the mode
 * name as reported in the HEARTBEAT, per vehicle type. Mode numbers differ
 * between ArduCopter and ArduRover (e.g. AUTO=3 vs AUTO=10), so the correct
 * table is chosen from the connected vehicle's type.
 */
interface ModeDef {
  number: number;
  heartbeatName: string;
}

const COPTER_MODES: Record<string, ModeDef> = {
  STABILIZE: { number: 0, heartbeatName: "STABILIZE" },
  ACRO: { number: 1, heartbeatName: "ACRO" },
  ALT_HOLD: { number: 2, heartbeatName: "ALT_HOLD" },
  AUTO: { number: 3, heartbeatName: "AUTO" },
  GUIDED: { number: 4, heartbeatName: "GUIDED" },
  LOITER: { number: 5, heartbeatName: "LOITER" },
  RTL: { number: 6, heartbeatName: "RTL" },
  CIRCLE: { number: 7, heartbeatName: "CIRCLE" },
  LAND: { number: 9, heartbeatName: "LAND" },
  DRIFT: { number: 11, heartbeatName: "DRIFT" },
  SPORT: { number: 13, heartbeatName: "SPORT" },
  POSHOLD: { number: 16, heartbeatName: "POSHOLD" },
  BRAKE: { number: 17, heartbeatName: "BRAKE" },
  GUIDED_NOGPS: { number: 20, heartbeatName: "GUIDED_NOGPS" },
  SMART_RTL: { number: 21, heartbeatName: "SMART_RTL" },
  FLOWHOLD: { number: 22, heartbeatName: "FLOWHOLD" },
  FOLLOW: { number: 23, heartbeatName: "FOLLOW" },
  /* aliases so the shared GCS dropdown keeps working on a copter */
  MANUAL: { number: 0, heartbeatName: "STABILIZE" },
  HOLD: { number: 2, heartbeatName: "ALT_HOLD" },
};

const ROVER_MODES: Record<string, ModeDef> = {
  MANUAL: { number: 0, heartbeatName: "MANUAL" },
  ACRO: { number: 1, heartbeatName: "ACRO" },
  STEERING: { number: 3, heartbeatName: "STEERING" },
  HOLD: { number: 4, heartbeatName: "HOLD" },
  LOITER: { number: 5, heartbeatName: "LOITER" },
  FOLLOW: { number: 6, heartbeatName: "FOLLOW" },
  SIMPLE: { number: 7, heartbeatName: "SIMPLE" },
  DOCK: { number: 8, heartbeatName: "DOCK" },
  CIRCLE: { number: 9, heartbeatName: "CIRCLE" },
  AUTO: { number: 10, heartbeatName: "AUTO" },
  RTL: { number: 11, heartbeatName: "RTL" },
  SMART_RTL: { number: 12, heartbeatName: "SMART_RTL" },
  GUIDED: { number: 15, heartbeatName: "GUIDED" },
  INITIALISING: { number: 16, heartbeatName: "INITIALISING" },
};

function isAirVehicle(): boolean {
  const vt = vehicleState.vehicleType;
  return (
    vt.startsWith("QUAD") ||
    vt.startsWith("HEXA") ||
    vt.startsWith("OCTO") ||
    vt.startsWith("TRI") ||
    vt.startsWith("HELI") ||
    vt.startsWith("COAX") ||
    vt.startsWith("VTOL") ||
    vt === "FIXED_WING" ||
    vt.startsWith("FLAPPING")
  );
}

/* The mode used to arm the vehicle. ArduCopter refuses to arm in RTL, LAND,
   THROW, etc.; STABILIZE is the standard, universally-armable arming mode for
   air vehicles. Ground vehicles arm in HOLD. */
export function getSafeArmMode(): string {
  return isAirVehicle() ? "STABILIZE" : "HOLD";
}

/* Modes in which ArduPilot will reject an arm request. Arming is only ever
   attempted after the vehicle is normalized out of one of these. */
const NON_ARMABLE_MODES = new Set([
  "RTL",
  "LAND",
  "SMART_RTL",
  "THROW",
  "BRAKE",
  "AUTOROTATE",
  "AUTO_RTL",
  "GUIDED_NOGPS",
  "INITIALISING",
]);

export function isModeArmable(mode: string): boolean {
  return !NON_ARMABLE_MODES.has(mode);
}

export async function setMode(mode: string): Promise<CommandResult> {
  const table = isAirVehicle() ? COPTER_MODES : ROVER_MODES;
  const def = table[mode];
  if (!def) {
    console.log(`[MODE] Unknown mode for vehicle ${vehicleState.vehicleType}: ${mode}`);
    return {
      success: false,
      message: `Mode ${mode} is not supported on ${vehicleState.vehicleType}.`,
      ackCode: -1,
      ackLabel: "INVALID_MODE",
    };
  }
  const customMode = def.number;

  console.log("============================ MODE CHANGE ============================");
  console.log(`Mode Requested    : ${mode} (customMode=${customMode}, heartbeat=${def.heartbeatName})`);
  console.log(`Vehicle Connected : ${isVehicleConnected()}`);
  console.log(`System ID         : ${vehicleState.systemId}`);
  console.log(`Component ID      : ${vehicleState.componentId}`);
  console.log(`Current Mode      : ${vehicleState.mode}`);
  console.log(`Armed             : ${vehicleState.armed}`);
  console.log(`Vehicle Type      : ${vehicleState.vehicleType}`);
  console.log("====================================================================");

  const transport = requireTransport();
  const sysId = vehicleState.systemId || 1;

  /* Use SET_MODE message (msgid 11) directly instead of COMMAND_LONG with
     DO_SET_MODE, because mavlink-mappings has the wrong MavCmd value. */
  const msg = new common.SetMode();
  msg.targetSystem = sysId;
  (msg as any).baseMode = 1; // MAV_MODE_FLAG_CUSTOM_MODE_ENABLED
  (msg as any).customMode = customMode;

  console.log(`[MODE] Sending SET_MESSAGE: baseMode=1 customMode=${customMode} (${mode})`);

  await send(transport, msg, new MavLinkProtocolV2());

  /* Wait for HEARTBEAT to confirm the mode change */
  return waitForHeartbeatMode(def.heartbeatName, HEARTBEAT_CONFIRM_TIMEOUT_MS);
}

/**
 * Set the vehicle's HOME location via MAV_CMD_DO_SET_HOME (command 179).
 * If `lat`/`lon`/`alt` are provided they are used directly, otherwise
 * param1=1 tells the autopilot to use its current position.
 */
export async function setHome(opts?: {
  lat?: number;
  lon?: number;
  alt?: number;
}): Promise<CommandResult> {
  const transport = requireTransport();
  const sysId = vehicleState.systemId || 1;
  const compId = vehicleState.componentId || 1;

  const useCurrent = !opts || opts.lat === undefined || opts.lon === undefined;

  const lat = opts?.lat;
  const lon = opts?.lon;
  const alt = opts?.alt;

  const cmd = new common.CommandLong();
  cmd.targetSystem = sysId;
  cmd.targetComponent = compId;
  cmd.command = 179; // MAV_CMD_DO_SET_HOME
  cmd.confirmation = 0;
  cmd._param1 = useCurrent ? 1 : 0;
  cmd._param2 = 0;
  cmd._param3 = 0;
  cmd._param4 = 0;
  cmd._param5 = useCurrent ? 0 : Math.round((lat as number) * 1e7);
  cmd._param6 = useCurrent ? 0 : Math.round((lon as number) * 1e7);
  cmd._param7 = useCurrent ? 0 : (alt ?? 0);

  console.log(`[HOME] Sending MAV_CMD_DO_SET_HOME (179) — useCurrentPosition=${useCurrent}`);
  if (!useCurrent) {
    console.log(`[HOME]   lat=${lat} lon=${lon} alt=${alt}`);
  }

  const ackResult = await waitForCommandAck(transport, cmd, sysId, compId, 179);
  console.log(`[HOME] COMMAND_ACK result=${ackResult.ackLabel}`);
  return ackResult;
}

/**
 * Set the active mission item via MAV_CMD_DO_SET_MISSION_CURRENT (command 224).
 * ArduPilot's mission state machine only resumes/restarts reliably when the
 * current waypoint is explicitly set before MAV_CMD_MISSION_START, so the GCS
 * points it at the first real waypoint (seq=1, skipping the HOME item at seq 0).
 */
export async function setMissionCurrent(seq: number): Promise<CommandResult> {
  const transport = requireTransport();
  const sysId = vehicleState.systemId || 1;
  const compId = vehicleState.componentId || 1;

  const cmd = new common.CommandLong();
  cmd.targetSystem = sysId;
  cmd.targetComponent = compId;
  cmd.command = 224; // MAV_CMD_DO_SET_MISSION_CURRENT
  cmd.confirmation = 0;
  cmd._param1 = seq;
  cmd._param2 = 0;
  cmd._param3 = 0;
  cmd._param4 = 0;
  cmd._param5 = 0;
  cmd._param6 = 0;
  cmd._param7 = 0;

  console.log(`[MISSION] Sending MAV_CMD_DO_SET_MISSION_CURRENT seq=${seq}`);
  const ackResult = await waitForCommandAck(transport, cmd, sysId, compId, 224);
  console.log(`[MISSION] SET_MISSION_CURRENT ACK result=${ackResult.ackLabel}`);
  return ackResult;
}
