import dgram from "dgram";
import net from "net";
import { PassThrough, Writable } from "stream";

import {
  send,
  MavLinkPacketSplitter,
  MavLinkPacketParser,
  MavLinkPacketRegistry,
  MavLinkProtocolV2,
} from "node-mavlink";

import {
  minimal,
  common,
  ardupilotmega,
} from "mavlink-mappings";

import {
  handleHeartbeat,
  handleSysStatus,
  handleGlobalPositionInt,
  handleHomePosition,
  handleGpsRawInt,
  handleAttitude,
  handleVfrHud,
  handleBatteryStatus,
  handleMissionCurrent,
  handleMissionItemReached,
  handleStatusText,
  handleLocalPositionNed,
  handleRcChannels,
  handleRawImu,
  printTelemetry,
} from "./telemetryManager";

import { vehicleState } from "./vehicleState";
import { broadcastVehicleStatus } from "../socket/socket";
import { notifyHeartbeatReceived, getSerialTransport } from "./serial.service";
import { requestTelemetryStreams, resetStreamRequested } from "./streamRequester";

const REGISTRY: MavLinkPacketRegistry = {
  ...minimal.REGISTRY,
  ...common.REGISTRY,
  ...ardupilotmega.REGISTRY,
};

const packetListeners: Map<number, Array<(packet: any) => void>> = new Map();

export function onPacket(msgid: number, callback: (packet: any) => void): () => void {
  if (!packetListeners.has(msgid)) {
    packetListeners.set(msgid, []);
  }
  packetListeners.get(msgid)!.push(callback);
  return () => offPacket(msgid, callback);
}

export function offPacket(msgid: number, callback: (packet: any) => void): void {
  const listeners = packetListeners.get(msgid);
  if (!listeners) return;
  const idx = listeners.indexOf(callback);
  if (idx >= 0) listeners.splice(idx, 1);
}

let udp: dgram.Socket | null = null;
let firstHeartbeatReceived = false;

/* UDP connect promise management (parallel to serial.service.ts) */
let udpConnectResolve: ((value: boolean) => void) | null = null;
let udpHeartbeatTimer: ReturnType<typeof setTimeout> | null = null;
let udpDataReceived = false;

const loggedOnce = new Set<string>();

function pascalToUpperSnake(name: string): string {
  return name.replace(/([A-Z])/g, '_$1').replace(/^_/, '').toUpperCase();
}

let udpRemoteAddr = "";
let udpRemotePort = 0;
let pokeTargetAddr = "";
let pokeTargetPort = 0;

const stream = new PassThrough();

const reader = stream
  .pipe(new MavLinkPacketSplitter())
  .pipe(new MavLinkPacketParser());

initReader();

export function processMavlinkData(data: Buffer) {
  stream.write(data);
}

class UdpWriteStream extends Writable {
  constructor(
    private sock: dgram.Socket,
    private port: number,
    private addr: string
  ) {
    super();
  }

  _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    this.sock.send(chunk, this.port, this.addr, callback);
  }
}

let udpTransport: UdpWriteStream | null = null;

function resolvePokeHost(host: string): string {
  if (host === "0.0.0.0" || host === "::") return "127.0.0.1";
  return host;
}

/**
 * Send a MAVLink HEARTBEAT to host:port after binding. Some vehicles/SITL
 * configs (udpin / respond-to-sender) only start streaming once they receive a
 * packet from the GCS. The poke is harmless for push-based links (udpout).
 */
function pokeUdpTarget(host: string, port: number): void {
  if (!udp) return;
  const targetHost = resolvePokeHost(host);
  pokeTargetAddr = targetHost;
  pokeTargetPort = port;
  const pokeStream = new UdpWriteStream(udp, port, targetHost);

  const heartbeat = new minimal.Heartbeat();
  heartbeat.type = 6;      // MAV_TYPE_GCS
  heartbeat.autopilot = 8; // MAV_AUTOPILOT_INVALID
  heartbeat.baseMode = 0 as any; // no mode flags for a GCS
  heartbeat.customMode = 0;
  heartbeat.systemStatus = 0;

  send(pokeStream, heartbeat, new MavLinkProtocolV2())
    .then(() => {
      console.log(`[MAVLINK] Sent HEARTBEAT to ${targetHost}:${port} to request MAVLink stream`);
    })
    .catch((err: any) => {
      console.warn(`[MAVLINK] HEARTBEAT poke to ${targetHost}:${port} failed: ${err?.message ?? err}`);
    });
}

function getUdpTransport(): Writable | null {
  if (!udp || !udpRemoteAddr) return null;
  if (!udpTransport) {
    udpTransport = new UdpWriteStream(udp, udpRemotePort, udpRemoteAddr);
  }
  return udpTransport;
}

export function getTransport(): Writable | null {
  const serial = getSerialTransport();
  if (serial) return serial;
  const udpT = getUdpTransport();
  if (udpT) return udpT;
  if (tcpSocket && !tcpSocket.destroyed) return tcpSocket;
  return null;
}

export function startMavlinkService(port: number, host: string = "0.0.0.0"): Promise<boolean> {
  return new Promise((resolve) => {
    if (udp) {
      console.log("[MAVLINK] UDP service already running");
      resolve(false);
      return;
    }

    udpConnectResolve = resolve;
    udpDataReceived = false;
    firstHeartbeatReceived = false;

    console.log("========================= UDP CONNECT =========================");
    console.log(`Listening on UDP : ${host}:${port}`);
    console.log("====================================================================");

    udp = dgram.createSocket("udp4");

    udp.on("listening", () => {
      console.log(`[MAVLINK] UDP socket bound to ${host}:${port}`);
      vehicleState.udpConnected = true;

      pokeUdpTarget(host, port);

      udpHeartbeatTimer = setTimeout(() => {
        if (!udpDataReceived) {
          console.warn(`[MAVLINK] No MAVLink data within 15s on ${host}:${port} — listener kept open, waiting for vehicle`);
          console.warn(`[MAVLINK]   Make sure the vehicle/H12 pushes MAVLink to this GCS port:`);
          console.warn(`[MAVLINK]     MAVProxy: --out udp:${resolvePokeHost(host)}:${port}`);
          console.warn(`[MAVLINK]     sim_vehicle.py: --out ${resolvePokeHost(host)}:${port}`);
          console.warn(`[MAVLINK]   H12 Pro pushes to UDP 192.168.144.200:14550, so this host must be 0.0.0.0/14550.`);
        } else {
          console.warn("[MAVLINK] Data received but no HEARTBEAT within 15s — listener kept open");
        }
        // Keep the UDP socket listening so a late-arriving vehicle stream still
        // connects (GCS listen-and-wait). Just resolve the connect call.
        const resolveConnect = udpConnectResolve;
        udpConnectResolve = null;
        if (resolveConnect) {
          resolveConnect(false);
        }
      }, 15000);
    });

    udp.on("message", (msg, rinfo) => {
      if (pokeTargetAddr && rinfo.address === pokeTargetAddr && rinfo.port === pokeTargetPort) {
        console.log(`[MAVLINK] Ignoring self-sent packet from ${rinfo.address}:${rinfo.port}`);
        return;
      }
      udpRemoteAddr = rinfo.address;
      udpRemotePort = rinfo.port;
      udpDataReceived = true;
      console.log(`[MAVLINK] UDP packet received (${msg.length} bytes from ${rinfo.address}:${rinfo.port})`);
      processMavlinkData(msg);
    });

    udp.on("error", (err) => {
      console.error(`[MAVLINK] UDP error: ${err.message}`);
      if (udpHeartbeatTimer) {
        clearTimeout(udpHeartbeatTimer);
        udpHeartbeatTimer = null;
      }
      const resolveConnect = udpConnectResolve;
      stopMavlinkService();
      if (resolveConnect) {
        resolveConnect(false);
      }
    });

    udp.on("close", () => {
      console.log("[MAVLINK] UDP socket closed");
      vehicleState.udpConnected = false;
      vehicleState.connected = false;
      vehicleState.mode = "DISCONNECTED";
      vehicleState.armed = false;
      broadcastVehicleStatus();
    });

    udp.bind(port, host, () => {
      console.log(`[MAVLINK] UDP bind complete on ${host}:${port}`);
    });
  });
}

export function notifyUdpHeartbeat(): void {
  console.log("[MAVLINK] UDP HEARTBEAT received — resolving connect promise");
  if (udpHeartbeatTimer) {
    clearTimeout(udpHeartbeatTimer);
    udpHeartbeatTimer = null;
  }
  if (udpConnectResolve) {
    udpConnectResolve(true);
    udpConnectResolve = null;
  }
}

export function notifyTcpHeartbeat(): void {
  console.log("[MAVLINK] TCP HEARTBEAT received — resolving connect promise");
  if (tcpConnectResolve) {
    tcpConnectResolve(true);
    tcpConnectResolve = null;
  }
}

export function isUdpConnected(): boolean {
  return udp !== null && vehicleState.udpConnected;
}

export function stopMavlinkService() {
  stopMavlinkTcpService();
  if (!udp) return;
  console.log("[MAVLINK] Stopping UDP service");

  if (udpHeartbeatTimer) {
    clearTimeout(udpHeartbeatTimer);
    udpHeartbeatTimer = null;
  }
  udpConnectResolve = null;
  udpDataReceived = false;

  udp.removeAllListeners();
  udp.close(() => console.log("[MAVLINK] UDP socket closed"));
  udp = null;
  udpTransport = null;
  udpRemoteAddr = "";
  udpRemotePort = 0;
  pokeTargetAddr = "";
  pokeTargetPort = 0;
  firstHeartbeatReceived = false;
  loggedOnce.clear();
  packetListeners.clear();

  vehicleState.udpConnected = false;
}

/* ---- TCP MAVLink Client ---- */
let tcpSocket: net.Socket | null = null;
let tcpConnectResolve: ((value: boolean) => void) | null = null;

export function startMavlinkTcpService(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (tcpSocket) {
      console.log("[MAVLINK] TCP service already running");
      resolve(false);
      return;
    }

    tcpConnectResolve = resolve;
    firstHeartbeatReceived = false;

    console.log(`[MAVLINK] Connecting TCP to ${host}:${port}...`);

    const socket = new net.Socket();
    tcpSocket = socket;

    socket.connect(port, host, () => {
      console.log(`[MAVLINK] TCP connected to ${host}:${port}`);
      vehicleState.udpConnected = true;
    });

    socket.on("data", (data: Buffer) => {
      console.log(`[MAVLINK] TCP data received (${data.length} bytes)`);
      processMavlinkData(data);
    });

    socket.on("close", () => {
      console.log("[MAVLINK] TCP connection closed");
      vehicleState.udpConnected = false;
      vehicleState.connected = false;
      vehicleState.mode = "DISCONNECTED";
      vehicleState.armed = false;
      broadcastVehicleStatus();
    });

    socket.on("error", (err) => {
      console.error(`[MAVLINK] TCP error: ${err.message}`);
      const resolveTcp = tcpConnectResolve;
      stopMavlinkTcpService();
      if (resolveTcp) {
        resolveTcp(false);
      }
    });

    // timeout if no heartbeat within 10s
    setTimeout(() => {
      if (!firstHeartbeatReceived && tcpConnectResolve) {
        console.log("[MAVLINK] TCP connect timed out — no HEARTBEAT within 10s");
        tcpConnectResolve(false);
        tcpConnectResolve = null;
      }
    }, 10000);
  });
}

export function stopMavlinkTcpService() {
  if (!tcpSocket) return;
  console.log("[MAVLINK] Stopping TCP service");
  tcpSocket.removeAllListeners();
  tcpSocket.destroy();
  tcpSocket = null;
  tcpConnectResolve = null;
  firstHeartbeatReceived = false;
  loggedOnce.clear();
  packetListeners.clear();
  vehicleState.udpConnected = false;
}

export function isTcpConnected(): boolean {
  return tcpSocket !== null && !tcpSocket.destroyed;
}

function initReader() {
  reader.on("data", (packet) => {
    const clazz = REGISTRY[packet.header.msgid];
    if (!clazz) {
      console.log(`[MAVLINK] Unknown msgid ${packet.header.msgid} (sys=${packet.header.sysid}, comp=${packet.header.compid})`);
      return;
    }

    vehicleState.systemId = packet.header.sysid;
    vehicleState.componentId = packet.header.compid;

    const msg = packet.protocol.data(packet.payload, clazz);
    if (clazz.MSG_NAME === 'HEARTBEAT') {
      const hb = msg as any;
      const rawHex = packet.payload.slice(0, 9).toString('hex');
      console.log(`[HB DEBUG] proto=${packet.protocol.constructor.name} type=${hb.type} ap=${hb.autopilot} baseMode=${hb.baseMode} customMode=${hb.customMode} sysStatus=${hb.systemStatus} mavVersion=${hb.mavlinkVersion} raw=${rawHex}`);
    }
    const name = msg.constructor.name;

    console.log(`[MAVLINK] Parsed: ${pascalToUpperSnake(name)} (msgid=${packet.header.msgid})`);

    switch (name) {
      case "Heartbeat":
        console.log(`[MAVLINK] HEARTBEAT received (sys=${packet.header.sysid}, comp=${packet.header.compid})`);
        handleHeartbeat(msg);
        notifyHeartbeatReceived();
        notifyUdpHeartbeat();
        notifyTcpHeartbeat();
        broadcastVehicleStatus();
        requestStreamsAfterHeartbeat();
        console.log(`[MAVLINK] Vehicle: ${vehicleState.vehicleType} | Autopilot: ${vehicleState.autopilot} | SysID: ${vehicleState.systemId} | CompID: ${vehicleState.componentId} | Mode: ${vehicleState.mode} | Armed: ${vehicleState.armed}`);
        printTelemetry();
        break;

      case "SysStatus":
        if (!loggedOnce.has("SysStatus")) { loggedOnce.add("SysStatus"); console.log("[MAVLINK] SYS_STATUS received"); }
        handleSysStatus(msg);
        break;

      case "GlobalPositionInt":
        if (!loggedOnce.has("GlobalPositionInt")) { loggedOnce.add("GlobalPositionInt"); console.log("[MAVLINK] GLOBAL_POSITION_INT received"); }
        handleGlobalPositionInt(msg);
        break;

      case "HomePosition":
        if (!loggedOnce.has("HomePosition")) { loggedOnce.add("HomePosition"); console.log("[MAVLINK] HOME_POSITION received"); }
        handleHomePosition(msg);
        break;

      case "GpsRawInt":
        if (!loggedOnce.has("GpsRawInt")) { loggedOnce.add("GpsRawInt"); console.log("[MAVLINK] GPS_RAW_INT received"); }
        handleGpsRawInt(msg);
        break;

      case "Attitude":
        if (!loggedOnce.has("Attitude")) { loggedOnce.add("Attitude"); console.log("[MAVLINK] ATTITUDE received"); }
        handleAttitude(msg);
        break;

      case "VfrHud":
        if (!loggedOnce.has("VfrHud")) { loggedOnce.add("VfrHud"); console.log("[MAVLINK] VFR_HUD received"); }
        handleVfrHud(msg);
        break;

      case "BatteryStatus":
        if (!loggedOnce.has("BatteryStatus")) { loggedOnce.add("BatteryStatus"); console.log("[MAVLINK] BATTERY_STATUS received"); }
        handleBatteryStatus(msg);
        break;

      case "MissionCurrent":
        if (!loggedOnce.has("MissionCurrent")) { loggedOnce.add("MissionCurrent"); console.log("[MAVLINK] MISSION_CURRENT received"); }
        handleMissionCurrent(msg);
        break;

      case "MissionItemReached":
        if (!loggedOnce.has("MissionItemReached")) { loggedOnce.add("MissionItemReached"); console.log("[MAVLINK] MISSION_ITEM_REACHED received"); }
        handleMissionItemReached(msg);
        break;

      case "StatusText":
        handleStatusText(msg);
        break;

      case "LocalPositionNed":
        if (!loggedOnce.has("LocalPositionNed")) { loggedOnce.add("LocalPositionNed"); console.log("[MAVLINK] LOCAL_POSITION_NED received"); }
        handleLocalPositionNed(msg);
        break;

      case "RcChannels":
        handleRcChannels(msg);
        break;

      case "RawImu":
        handleRawImu(msg);
        break;

      case "CommandAck":
        console.log("[MAVLINK] CommandAck received:", (msg as any).result === 0 ? "ACCEPTED" : `result=${(msg as any).result}`);
        break;

      default:
        console.log(`[MAVLINK] Unhandled message: ${pascalToUpperSnake(name)}`);
        break;
    }

    const listeners = packetListeners.get(packet.header.msgid);
    if (listeners) {
      for (const cb of [...listeners]) {
        cb(packet);
      }
    }
  });
}

function requestStreamsAfterHeartbeat() {
  if (firstHeartbeatReceived) return;
  firstHeartbeatReceived = true;

  const transport = getTransport();
  if (!transport) {
    console.warn("[MAVLINK] No transport available to request telemetry streams");
    return;
  }

  requestTelemetryStreams(
    transport,
    vehicleState.systemId,
    vehicleState.componentId
  ).catch((err) =>
    console.error("[MAVLINK] Stream request error:", err.message)
  );
}
