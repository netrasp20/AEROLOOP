export interface VehicleState {
  connected: boolean;
  lastHeartbeat: number;
  systemId: number;
  componentId: number;
  vehicleType: string;
  autopilot: string;
  mode: string;
  armed: boolean;
  gpsFix: number;
  satellites: number;
  missionUploaded: boolean;
  missionRunning: boolean;
  missionCompleted: boolean;
  lastArmStatusText: string;
  serialPortOpen: boolean;
  udpConnected: boolean;
  missionStartTime: number;
  missionPrevLat: number;
  missionPrevLon: number;
  missionDistanceInitialized: boolean;
  missionTotalDistance: number;
  missionMaxSpeed: number;
  missionWaypointsVisited: number;
  missionTotalWaypoints: number;
  missionEndTime: number;
}

export const vehicleState: VehicleState = {
  connected: false,
  lastHeartbeat: 0,
  systemId: 0,
  componentId: 0,
  vehicleType: "UNKNOWN",
  autopilot: "UNKNOWN",
  mode: "DISCONNECTED",
  armed: false,
  gpsFix: 0,
  satellites: 0,
  missionUploaded: false,
  missionRunning: false,
  missionCompleted: false,
  lastArmStatusText: "",
  serialPortOpen: false,
  udpConnected: false,
  missionStartTime: 0,
  missionPrevLat: 0,
  missionPrevLon: 0,
  missionDistanceInitialized: false,
  missionTotalDistance: 0,
  missionMaxSpeed: 0,
  missionWaypointsVisited: 0,
  missionTotalWaypoints: 0,
  missionEndTime: 0,
};

export const CONNECTION_TIMEOUT_MS = 10000;

export function clearArmStatusText(): void {
  vehicleState.lastArmStatusText = "";
}

export function resetMissionStats(): void {
  vehicleState.missionStartTime = 0;
  vehicleState.missionPrevLat = 0;
  vehicleState.missionPrevLon = 0;
  vehicleState.missionDistanceInitialized = false;
  vehicleState.missionTotalDistance = 0;
  vehicleState.missionMaxSpeed = 0;
  vehicleState.missionWaypointsVisited = 0;
  /* missionTotalWaypoints is intentionally NOT reset here — it describes the
     currently uploaded/active mission (set on upload) and must survive mission
     start so the completion summary can report the real waypoint count. */
  vehicleState.missionEndTime = 0;
}

export function isVehicleConnected(): boolean {
  const transportReady = vehicleState.serialPortOpen || vehicleState.udpConnected;
  if (!transportReady) return false;
  if (vehicleState.lastHeartbeat === 0) return false;
  const elapsed = Date.now() - vehicleState.lastHeartbeat;
  if (elapsed > CONNECTION_TIMEOUT_MS) return false;
  return true;
}
