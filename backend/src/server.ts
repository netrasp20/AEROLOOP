import dotenv from "dotenv";
dotenv.config();

process.on("uncaughtException", (err) => {
  console.error("\nUNCAUGHT EXCEPTION");
  console.error(err);
});

process.on("unhandledRejection", (reason) => {
  console.error("\nUNHANDLED REJECTION");
  console.error(reason);
});

import http from "http";

import app from "./app";

import { initializeSocket, getIO } from "./socket/socket";
import { startTelemetryBroadcast } from "./socket/telemetry.socket";
import { startConnectionWatcher } from "./mavlink/connectionWatcher";
import { stopMavlinkService } from "./mavlink/mavlink.service";
import { stopSerialService } from "./mavlink/serial.service";
import { stopSitl } from "./services/sitl.service";
import { resetTelemetry } from "./mavlink/telemetryManager";
import { broadcastVehicleStatus } from "./socket/socket";
import { vehicleState } from "./mavlink/vehicleState";
import { rtspProxy } from "./services/rtspProxy.service";

const PORT = Number(process.env.PORT) || 5000;

const server = http.createServer(app);

initializeSocket(server);

startTelemetryBroadcast();

startConnectionWatcher();

server.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});

server.on("error", (err) => {
  console.error("HTTP SERVER ERROR");
  console.error(err);
});

server.on("close", () => {
  console.log("HTTP Server Closed");
});

// -----------------------------
// Graceful Shutdown
// -----------------------------
function shutdown(signal: string) {
  console.log(`\n[SHUTDOWN] ${signal} received — cleaning up...`);

  stopMavlinkService();
  stopSerialService();
  stopSitl();
  rtspProxy.stopAll();
  resetTelemetry();
  vehicleState.connected = false;
  vehicleState.udpConnected = false;
  broadcastVehicleStatus();

  const io = getIO();
  if (io) io.close();

  server.close(() => {
    console.log("[SHUTDOWN] Complete");
    process.exit(0);
  });

  setTimeout(() => {
    console.error("[SHUTDOWN] Forced exit after timeout");
    process.exit(1);
  }, 5000);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGUSR2", () => shutdown("SIGUSR2"));
