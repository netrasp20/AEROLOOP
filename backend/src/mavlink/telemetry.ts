export interface TelemetryData {
  connected: boolean;
  systemId: number;
  componentId: number;
  vehicleType: string;
  autopilot: string;

  mode: string;
  armed: boolean;

  latitude: number;
  longitude: number;
  altitude: number;
  relativeAltitude: number;

  homeLatitude: number;
  homeLongitude: number;
  homeAltitude: number;

  groundSpeed: number;
  airSpeed: number;
  verticalSpeed: number;

  heading: number;
  roll: number;
  pitch: number;
  yaw: number;

  batteryVoltage: number;
  batteryCurrent: number;
  batteryRemaining: number;

  gpsFix: number;
  satellites: number;
  hdop: number;

  distance: number;
  distanceToHome: number;
  atHome: boolean;

  missionCurrent: number;
  missionReached: number;
  missionRunning: boolean;
  missionCompleted: boolean;
  missionTotalDistance: number;

  statusText: string;

  timestamp: number;
}

export const telemetry: TelemetryData = {
  connected: false,
  systemId: 0,
  componentId: 0,
  vehicleType: "UNKNOWN",
  autopilot: "UNKNOWN",

  mode: "DISCONNECTED",
  armed: false,

  latitude: 0,
  longitude: 0,
  altitude: 0,
  relativeAltitude: 0,

  homeLatitude: 0,
  homeLongitude: 0,
  homeAltitude: 0,

  groundSpeed: 0,
  airSpeed: 0,
  verticalSpeed: 0,

  heading: 0,
  roll: 0,
  pitch: 0,
  yaw: 0,

  batteryVoltage: 0,
  batteryCurrent: 0,
  batteryRemaining: 0,

  gpsFix: 0,
  satellites: 0,
  hdop: 0,

  distance: 0,

  distanceToHome: 0,
  atHome: false,

  missionCurrent: 0,
  missionReached: 0,
  missionRunning: false,
  missionCompleted: false,
  missionTotalDistance: 0,

  statusText: "",

  timestamp: 0,
};
