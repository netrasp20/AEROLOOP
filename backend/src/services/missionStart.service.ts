import { send, common, MavLinkProtocolV2 } from "node-mavlink";
import type { Writable } from "stream";
import { vehicleState } from "../mavlink/vehicleState";
import { getTransport } from "../mavlink/mavlink.service";
import { onPacket } from "../mavlink/mavlink.service";

const ACK_TIMEOUT_MS = 5000;

export interface StartResult {
  success: boolean;
  message: string;
  ackCode?: number;
  ackLabel?: string;
}

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

export function getAckLabel(code: number): string {
  return MAV_ACK_MESSAGES[code] ?? `UNKNOWN(${code})`;
}

export function validateStart(): StartResult {
  if (!vehicleState.connected) {
    return {
      success: false,
      message: "Cannot start mission. Vehicle is not connected.",
    };
  }

  if (!vehicleState.missionUploaded) {
    return {
      success: false,
      message: "Cannot start mission. Please upload a mission first.",
    };
  }

  if (!vehicleState.armed) {
    return {
      success: false,
      message: "Cannot start mission. Vehicle must be armed first.",
    };
  }

  if (vehicleState.mode !== "AUTO") {
    return {
      success: false,
      message: "Cannot start mission. Vehicle must be in AUTO mode.",
    };
  }

  return { success: true, message: "Validation passed." };
}

export async function startMission(
  transport: Writable,
  sysId: number,
  compId: number,
  firstItem: number = 0,
  lastItem: number = 0
): Promise<StartResult> {
  const validation = validateStart();
  if (!validation.success) {
    return validation;
  }

  console.log("[MISSION START] Requested");
  console.log("[MISSION START] Sending MAV_CMD_MISSION_START");

  const cmd = new common.CommandLong();
  cmd.targetSystem = sysId;
  cmd.targetComponent = compId;
  cmd.command = common.MavCmd.MISSION_START;
  cmd.confirmation = 0;
  cmd._param1 = firstItem;
  cmd._param2 = lastItem;
  cmd._param3 = 0;
  cmd._param4 = 0;
  cmd._param5 = 0;
  cmd._param6 = 0;
  cmd._param7 = 0;

  const ack = await waitForCommandAck(transport, cmd, sysId, compId);

  if (ack.success) {
    console.log("[MISSION START] Mission ACK Received — ACCEPTED");
    console.log("[MISSION START] Mission Started");
  } else {
    console.log(`[MISSION START] Mission ACK Received — ${ack.ackLabel}`);
  }

  return ack;
}

async function waitForCommandAck(
  transport: Writable,
  command: common.CommandLong,
  sysId: number,
  compId: number
): Promise<StartResult> {
  return new Promise<StartResult>((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve({
        success: false,
        message: "Command acknowledgment timeout.",
        ackCode: -1,
        ackLabel: "TIMEOUT",
      });
    }, ACK_TIMEOUT_MS);

    const unsubscribe = onPacket(77, (packet: any) => {
      try {
        const msg = packet.protocol.data(packet.payload, common.CommandAck) as any;
        if (msg.command !== command.command) return;
        if (msg.result === 0) {
          cleanup();
          resolve({
            success: true,
            message: "Mission started successfully.",
            ackCode: 0,
            ackLabel: "ACCEPTED",
          });
        } else {
          cleanup();
          resolve({
            success: false,
            message: `Mission Start Failed. Reason: ${getAckLabel(msg.result)}`,
            ackCode: msg.result,
            ackLabel: getAckLabel(msg.result),
          });
        }
      } catch {
        /* ignore parse errors */
      }
    });

    function cleanup() {
      clearTimeout(timer);
      unsubscribe();
    }

    send(transport, command, new MavLinkProtocolV2()).catch((err) => {
      cleanup();
      resolve({
        success: false,
        message: `Failed to send command: ${err.message}`,
        ackCode: -1,
        ackLabel: "SEND_FAILED",
      });
    });
  });
}
