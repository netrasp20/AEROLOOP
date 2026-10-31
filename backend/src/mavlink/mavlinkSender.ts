import { MavTCP } from "node-mavlink";
import { common } from "mavlink-mappings";
import { vehicleState } from "./vehicleState";

let mav: MavTCP | null = null;

export async function connectMavlink() {
  console.log("🔄 connectMavlink() called");

  if (mav) {
    console.log("✅ Already connected to SITL");
    return mav;
  }

  try {
    mav = new MavTCP();

    // ===========================
    // Connection Event Handlers
    // ===========================

    mav.on("error", (err: any) => {
      console.error("❌ MAVLink TCP Error:", err.message);

      vehicleState.connected = false;
      vehicleState.mode = "DISCONNECTED";
      vehicleState.armed = false;
      vehicleState.systemId = 0;
      vehicleState.componentId = 0;
      vehicleState.gpsFix = 0;
      vehicleState.satellites = 0;

      mav = null;
    });

    mav.on("close", () => {
      console.log("🔌 MAVLink connection closed");

      vehicleState.connected = false;
      vehicleState.mode = "DISCONNECTED";
      vehicleState.armed = false;
      vehicleState.systemId = 0;
      vehicleState.componentId = 0;
      vehicleState.gpsFix = 0;
      vehicleState.satellites = 0;

      mav = null;
    });

    console.log("📡 Connecting to 127.0.0.1:5760 ...");

    const info = await mav.start("127.0.0.1", 5760);

    console.log("✅ Connected to SITL:", info);

    return mav;
  } catch (err) {
    console.error("❌ Failed to connect to SITL");
    console.error(err);

    mav = null;

    throw err;
  }
}

export function getMav() {
  if (!mav) {
    throw new Error("MAVLink not connected");
  }

  return mav;
}

export async function sendArmCommand(arm: boolean) {
  const command = new common.ComponentArmDisarmCommand(1, 1);

  command.arm = arm ? 1 : 0;
  command.force = 0;

  console.log(
    arm
      ? "📤 Sending ARM command..."
      : "📤 Sending DISARM command..."
  );

  try {
    const mav = getMav();

console.log("➡️ Before send()");
console.log("Socket writable:", (mav as any).socket?.writable);
console.log("Socket destroyed:", (mav as any).socket?.destroyed);
console.log("Socket connecting:", (mav as any).socket?.connecting);

await mav.send(command);

console.log("✅ After send()");
    console.log("✅ ARM/DISARM command sent successfully");
  } catch (err) {
    console.error("❌ ARM SEND FAILED");
    console.error(err);
    throw err;
  }
}

export async function sendModeCommand(customMode: number) {
  const command = new common.DoSetModeCommand(1, 1);

  command.mode = 1;
  command.customMode = customMode;
  command.customSubmode = 0;

  console.log("📤 Sending MODE command:", customMode);

  try {
    console.log("➡️ Before send()");

    await getMav().send(command);

    console.log("✅ After send()");
    console.log("✅ MODE command sent successfully");
  } catch (err) {
    console.error("❌ MODE SEND FAILED");
    console.error(err);
    throw err;
  }
}

