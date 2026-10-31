import { vehicleState, isVehicleConnected } from "./vehicleState";
import { broadcastVehicleStatus } from "../socket/socket";
import { resetTelemetry } from "./telemetryManager";

const HEARTBEAT_TIMEOUT = 10000;
let watcherStarted = false;

export function startConnectionWatcher() {
  if (watcherStarted) return;
  watcherStarted = true;

  setInterval(() => {
    if (vehicleState.lastHeartbeat === 0) return;

    const transportReady = vehicleState.serialPortOpen || vehicleState.udpConnected;
    if (!transportReady) return;

    const elapsed = Date.now() - vehicleState.lastHeartbeat;

    if (elapsed > HEARTBEAT_TIMEOUT) {
      console.log(`[WATCHER] Heartbeat timeout — ${elapsed}ms since last HEARTBEAT`);
      console.log("[WATCHER] Setting connected=false, lastHeartbeat=0");
      resetTelemetry();
      vehicleState.lastHeartbeat = 0;
      vehicleState.connected = false;
      broadcastVehicleStatus();
    }
  }, 1000);
}
