import { Server } from "socket.io";
import { vehicleState } from "../mavlink/vehicleState";
import { registerMissionHandlers } from "./mission.socket";

let io: Server;

export function initializeSocket(server: any) {
  /* Socket.IO uses its own CORS layer (separate from the Express `cors()`
     middleware, which allows all origins). Allow any origin so the GCS works
     from localhost, 127.0.0.1, and LAN addresses (tablet/companion access). */
  io = new Server(server, {
    cors: {
      origin: "*",
    },
  });

  io.on("connection", (socket) => {
    console.log("🟢 Frontend Connected:", socket.id);

    socket.emit("vehicleStatus", {
      connected: vehicleState.connected,
      armed: vehicleState.armed,
      mode: vehicleState.mode,
      systemId: vehicleState.systemId,
      componentId: vehicleState.componentId,
      vehicleType: vehicleState.vehicleType,
      autopilot: vehicleState.autopilot,
      gpsFix: vehicleState.gpsFix,
      satellites: vehicleState.satellites,
      missionUploaded: vehicleState.missionUploaded,
      missionRunning: vehicleState.missionRunning,
      missionCompleted: vehicleState.missionCompleted,
    });

    registerMissionHandlers(socket);

    socket.on("disconnect", () => {
      console.log("🔴 Frontend Disconnected:", socket.id);
    });
  });
}

export function getIO() {
  return io;
}

/**
 * Broadcast the latest vehicle status
 * to every connected frontend.
 */
export function closeSocket() {
  if (!io) return;
  io.close();
}

export function broadcastVehicleStatus() {
  if (!io) return;

  io.emit("vehicleStatus", {
    connected: vehicleState.connected,
    armed: vehicleState.armed,
    mode: vehicleState.mode,
    systemId: vehicleState.systemId,
    componentId: vehicleState.componentId,
    vehicleType: vehicleState.vehicleType,
    autopilot: vehicleState.autopilot,
    gpsFix: vehicleState.gpsFix,
    satellites: vehicleState.satellites,
    missionUploaded: vehicleState.missionUploaded,
    missionRunning: vehicleState.missionRunning,
    missionCompleted: vehicleState.missionCompleted,
  });
}