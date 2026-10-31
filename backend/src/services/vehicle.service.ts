import { vehicleState } from "../mavlink/vehicleState";
import { broadcastVehicleStatus } from "../socket/socket";
import { startMavlinkService, stopMavlinkService, startMavlinkTcpService, stopMavlinkTcpService } from "../mavlink/mavlink.service";
import { startSerialService, stopSerialService } from "../mavlink/serial.service";
import { resetTelemetry } from "../mavlink/telemetryManager";

type ConnectionRequest =
  | { connectionType: "tcp"; host: string; port: number; device?: never; baudRate?: never; }
  | { connectionType: "udp"; host: string; port: number; device?: never; baudRate?: never; }
  | { connectionType: "serial"; device: string; baudRate: number; port?: never; host?: never; };

export async function connectVehicle(connection: ConnectionRequest) {
  console.log(`[VEHICLE] connectVehicle called: type=${connection.connectionType}`);

  if (connection.connectionType === "tcp") {
    const host = connection.host || "127.0.0.1";
    const port = connection.port || 5760;
    console.log(`[VEHICLE] Connecting TCP to ${host}:${port}`);
    try {
      const gotHeartbeat = await startMavlinkTcpService(host, port);
      if (gotHeartbeat) {
        console.log("[VEHICLE] TCP connect succeeded — HEARTBEAT received");
        return {
          success: true,
          connected: true,
          message: "Connected via TCP. HEARTBEAT received.",
        };
      } else {
        console.log("[VEHICLE] TCP connect failed — no HEARTBEAT received within timeout");
        stopMavlinkTcpService();
        return {
          success: false,
          connected: false,
          message: "TCP connection timeout — no HEARTBEAT received.",
        };
      }
    } catch (err: any) {
      const msg = err?.message ?? "Unknown error";
      console.error(`[VEHICLE] TCP connect threw: ${msg}`);
      stopMavlinkTcpService();
      return {
        success: false,
        connected: false,
        message: msg,
      };
    }
  }

  if (connection.connectionType === "udp") {
    const host = connection.host || "127.0.0.1";
    const port = connection.port || 14550;
    console.log(`[VEHICLE] Starting UDP listener on ${host}:${port}`);
    try {
      const gotHeartbeat = await startMavlinkService(port, host);
      if (gotHeartbeat) {
        console.log("[VEHICLE] UDP connect succeeded — HEARTBEAT received");
        return {
          success: true,
          connected: true,
          message: "Connected via UDP. HEARTBEAT received.",
        };
      } else {
        console.log("[VEHICLE] UDP connect: no HEARTBEAT within 15s — listener left open, will connect when vehicle streams");
        return {
          success: false,
          connected: false,
          message: "UDP listener active — waiting for vehicle to stream MAVLink.",
        };
      }
    } catch (err: any) {
      const msg = err?.message ?? "Unknown error";
      console.error(`[VEHICLE] UDP connect threw: ${msg}`);
      stopMavlinkService();
      return {
        success: false,
        connected: false,
        message: msg,
      };
    }
  }

  console.log(`[VEHICLE] Starting serial connection on ${connection.device} @ ${connection.baudRate} baud`);

  try {
    const gotHeartbeat = await startSerialService(connection.device, connection.baudRate);
    if (gotHeartbeat) {
      console.log("[VEHICLE] Serial connect succeeded — HEARTBEAT received");
      return {
        success: true,
        connected: true,
        message: "Connected. HEARTBEAT received.",
      };
    } else {
      console.log("[VEHICLE] Serial connect failed — no HEARTBEAT received within timeout");
      stopSerialService();
      return {
        success: false,
        connected: false,
        message: "Connection timeout — no HEARTBEAT received.",
      };
    }
  } catch (err: any) {
    const msg = err?.message ?? "Unknown error";
    console.error(`[VEHICLE] Serial connect threw: ${msg}`);
    return {
      success: false,
      connected: false,
      message: msg,
    };
  }
}

export function disconnectVehicle() {
  console.log("[VEHICLE] Disconnecting vehicle");
  stopMavlinkService();
  stopSerialService();
  resetTelemetry();
  broadcastVehicleStatus();
  return {
    success: true,
    connected: false,
    message: "Vehicle disconnected.",
  };
}

import { isTcpConnected } from "../mavlink/mavlink.service";

export function getVehicleStatus() {
  const tcpConnected = isTcpConnected();
  const connectionType = vehicleState.serialPortOpen ? "SERIAL" : tcpConnected ? "TCP" : vehicleState.udpConnected ? "UDP" : "NONE";
  return {
    success: true,
    connected: vehicleState.connected,
    armed: vehicleState.armed,
    mode: vehicleState.mode,
    systemId: vehicleState.systemId,
    componentId: vehicleState.componentId,
    vehicleType: vehicleState.vehicleType,
    autopilot: vehicleState.autopilot,
    gpsFix: vehicleState.gpsFix,
    satellites: vehicleState.satellites,
    lastHeartbeat: vehicleState.lastHeartbeat,
    connectionType,
  };
}
