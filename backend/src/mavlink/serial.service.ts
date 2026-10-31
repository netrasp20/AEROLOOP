import { SerialPort } from "serialport";
import type { Writable } from "stream";
import { processMavlinkData } from "./mavlink.service";
import { vehicleState } from "./vehicleState";
import { broadcastVehicleStatus } from "../socket/socket";

let serialPort: SerialPort | null = null;
let portGen = 0;
let connectResolve: ((value: boolean) => void) | null = null;
let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
let dataReceived = false;

export function startSerialService(
  device: string,
  baudRate: number
): Promise<boolean> {
  return new Promise((resolve) => {
    if (serialPort?.isOpen) {
      console.log("[SERIAL] Already connected — rejecting duplicate connect");
      resolve(false);
      return;
    }

    portGen++;
    const gen = portGen;

    connectResolve = resolve;
    dataReceived = false;

    console.log(`[SERIAL] Opening ${device} @ ${baudRate} baud`);

    serialPort = new SerialPort({
      path: device,
      baudRate,
      autoOpen: true,
    });

    serialPort.on("open", () => {
      if (gen !== portGen) return;

      console.log(`[SERIAL] Port opened: ${device} @ ${baudRate} baud`);
      vehicleState.serialPortOpen = true;

      heartbeatTimer = setTimeout(() => {
        if (gen !== portGen) return;

        if (!dataReceived) {
          console.log("[SERIAL] No serial data received within 5s — timeout");
        } else {
          console.log("[SERIAL] Data received but no HEARTBEAT within 5s — timeout");
        }
        if (connectResolve) {
          connectResolve(false);
          connectResolve = null;
        }
      }, 5000);
    });

    serialPort.on("data", (data: Buffer) => {
      if (gen !== portGen) return;
      dataReceived = true;
      console.log(`[SERIAL] Received ${data.length} bytes`);
      processMavlinkData(data);
    });

    serialPort.on("error", (err) => {
      if (gen !== portGen) return;
      console.error(`[SERIAL] Error: ${err.message}`);
      if (connectResolve) {
        connectResolve(false);
        connectResolve = null;
      }
    });

    serialPort.on("close", () => {
      if (gen !== portGen) return;
      console.log("[SERIAL] Port closed");
      vehicleState.serialPortOpen = false;
      vehicleState.connected = false;
      vehicleState.mode = "DISCONNECTED";
      vehicleState.armed = false;
      broadcastVehicleStatus();
    });
  });
}

export function stopSerialService() {
  if (heartbeatTimer) {
    clearTimeout(heartbeatTimer);
    heartbeatTimer = null;
  }

  if (serialPort) {
    serialPort.removeAllListeners();
    if (serialPort.isOpen) {
      serialPort.close();
    }
  }
  serialPort = null;
  connectResolve = null;
  dataReceived = false;

  vehicleState.serialPortOpen = false;
  vehicleState.connected = false;
  vehicleState.mode = "DISCONNECTED";

  console.log("[SERIAL] Service stopped");
}

export function getSerialTransport(): Writable | null {
  return serialPort;
}

export function notifyHeartbeatReceived(): void {
  console.log("[SERIAL] Heartbeat received — resolving connect promise");
  if (heartbeatTimer) {
    clearTimeout(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (connectResolve) {
    connectResolve(true);
    connectResolve = null;
  }
}
