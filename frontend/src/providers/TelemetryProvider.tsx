import { createContext, useContext, useEffect, useState } from "react";
import socket from "../socket/socket";

export interface TelemetryData {
  connected: boolean;
  connectionState?: "CONNECTED" | "CONNECTING" | "DISCONNECTED";
  disconnectReason?: string | null;
  systemId: number;
  componentId: number;
  vehicleType: string;
  autopilot: string;

  mode: string;
  /** Raw HEARTBEAT.custom_mode. Resolve the mode name from parameter metadata. */
  modeCode?: number;
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

  missionUploaded: boolean;

  missionCurrent: number;
  missionReached: number;
  missionRunning: boolean;
  missionCompleted: boolean;
  missionTotalDistance: number;

  statusText: string;

  // RC receiver telemetry (real RC_CHANNELS frames; raw PWM per channel)
  rcChannels?: number[];
  rcSignal?: "RECEIVING" | "NO_SIGNAL" | "UNKNOWN";
  rcChannelCount?: number;
  rcRssi?: number;
  rcReceivedAt?: number;

  timestamp: number;
}

const defaultTelemetry: TelemetryData = {
  connected: false,
  connectionState: "DISCONNECTED",
  disconnectReason: null,
  systemId: 0,
  componentId: 0,
  vehicleType: "UNKNOWN",
  autopilot: "UNKNOWN",

  mode: "DISCONNECTED",
  modeCode: 0,
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

  missionUploaded: false,

  missionCurrent: 0,
  missionReached: 0,
  missionRunning: false,
  missionCompleted: false,
  missionTotalDistance: 0,

  statusText: "",

  rcChannels: [],
  rcSignal: "UNKNOWN",
  rcChannelCount: 0,
  rcRssi: 0,
  rcReceivedAt: 0,

  timestamp: 0,
};

const TelemetryContext = createContext<TelemetryData>(defaultTelemetry);

/* ------------------------------------------------------------------ */
/*  Debug mode – logs every telemetry update to the browser console.    */
/*  Set window.__TELEMETRY_DEBUG = true to enable.                    */
/* ------------------------------------------------------------------ */

/* Module-level flag — persists across HMR because the module scope      */
/* survives hot reloads. Defined once, never redefined.                  */

/* One-time setup: create a simple data property on window so the user   */
/* can toggle debug from the console with:                              */
/*   window.__TELEMETRY_DEBUG = true                                    */
/*                                                                       */
/* Use `configurable: true` so HMR re-runs this safely.                  */
if (typeof window !== "undefined" && !("__TELEMETRY_DEBUG" in window)) {
  Object.defineProperty(window, "__TELEMETRY_DEBUG", {
    value: false,
    writable: true,
    configurable: true,
    enumerable: true,
  });
}

function isDebugEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return (window as any).__TELEMETRY_DEBUG === true;
}

function logDebug(t: TelemetryData, source: string): void {
  if (!isDebugEnabled()) return;
  const RAD2DEG = 180 / Math.PI;
  console.log("──────────────────────────────");
  console.log(`Telemetry Received (${source})`);
  console.log("──────────────────────────────");
  console.log(`Mode:       ${t.mode}`);
  console.log(`Armed:      ${t.armed}`);
  console.log(`Lat:        ${t.latitude.toFixed(6)}`);
  console.log(`Lon:        ${t.longitude.toFixed(6)}`);
  console.log(`Altitude:   ${t.altitude.toFixed(1)}`);
  console.log(`Heading:    ${t.heading.toFixed(1)}`);
  console.log(`Battery:    ${t.batteryRemaining}%`);
  console.log(`Ground Spd: ${t.groundSpeed.toFixed(1)} m/s`);
  console.log(`Air Spd:    ${t.airSpeed.toFixed(1)} m/s`);
  console.log(`Vert Spd:   ${t.verticalSpeed.toFixed(2)} m/s`);
  console.log(`Roll:       ${(t.roll * RAD2DEG).toFixed(2)}°`);
  console.log(`Pitch:      ${(t.pitch * RAD2DEG).toFixed(2)}°`);
  console.log(`Yaw:        ${(t.yaw * RAD2DEG).toFixed(2)}°`);
  console.log(`GPS Fix:    ${t.gpsFix}`);
  console.log(`Satellites: ${t.satellites}`);
  console.log(`Voltage:    ${t.batteryVoltage.toFixed(2)}V`);
  console.log(`Current:    ${t.batteryCurrent.toFixed(2)}A`);
   console.log(`Dist:       ${t.distance.toFixed(1)} m`);
   console.log(`Mission WP: ${t.missionCurrent} (reached: ${t.missionReached}, running: ${t.missionRunning})`);
   console.log(`Status:     ${t.statusText}`);
  console.log("──────────────────────────────");
  console.log("Frontend Telemetry Updated");
}

function disconnectedSnapshot(reason?: string | null): TelemetryData {
  /* Defense-in-depth: when the authoritative link state goes away, drop every
     stale reading (battery / GPS / mode / position) so nothing is ever shown
     as current. Keep only the connection metadata. */
  return {
    ...defaultTelemetry,
    connectionState: "DISCONNECTED",
    disconnectReason: reason ?? null,
  };
}

export function TelemetryProvider({ children }: { children: React.ReactNode }) {
  const [telemetry, setTelemetry] = useState<TelemetryData>(defaultTelemetry);

  useEffect(() => {
    function handleTelemetry(data: TelemetryData) {
      setTelemetry((prev) => {
        const next = { ...prev, ...data };
        logDebug(next, "telemetry:update");
        return next;
      });
    }

    socket.on("telemetry:update", handleTelemetry);

    /* listen for vehicle status changes (connection state) */
    function handleStatus(status: any) {
      setTelemetry((prev) => {
        if (status.connected === false) {
          /* Backend never reasons from stale numbers, but if a vehicleStatus
             lands without the zeroed telemetry:update (or connection_state),
             drop the stale gauges here too. */
          const next = {
            ...disconnectedSnapshot(status.disconnectReason ?? null),
            connected: false,
            mode: status.mode ?? "DISCONNECTED",
            armed: status.armed ?? false,
          };
          logDebug(next, "vehicleStatus");
          return next;
        }
        const next = {
          ...prev,
          connected: status.connected ?? prev.connected,
          connectionState: status.connectionState ? "CONNECTED" : prev.connectionState,
          disconnectReason: null,
          mode: status.mode ?? prev.mode,
          armed: status.armed ?? prev.armed,
          systemId: status.systemId ?? prev.systemId,
          componentId: status.componentId ?? prev.componentId,
          vehicleType: status.vehicleType ?? prev.vehicleType,
          autopilot: status.autopilot ?? prev.autopilot,
          gpsFix: status.gpsFix ?? prev.gpsFix,
          satellites: status.satellites ?? prev.satellites,
          missionUploaded: status.missionUploaded ?? prev.missionUploaded,
          missionRunning: status.missionRunning ?? prev.missionRunning,
          missionCompleted: status.missionCompleted ?? prev.missionCompleted,
        };
        logDebug(next, "vehicleStatus");
        return next;
      });
    }

    socket.on("vehicleStatus", handleStatus);

    /* Authoritative MAVLink connection-state event (Phase 8C). */
    function handleConnectionState(payload: { state?: string; reason?: string }) {
      const state = payload.state;
      if (state === "CONNECTED") {
        setTelemetry((prev) => ({
          ...prev,
          connected: true,
          connectionState: "CONNECTED",
          disconnectReason: null,
        }));
      } else if (state === "CONNECTING") {
        setTelemetry((prev) => ({
          ...prev,
          connected: false,
          connectionState: "CONNECTING",
        }));
      } else if (state === "DISCONNECTED") {
        setTelemetry(disconnectedSnapshot(payload.reason ?? null));
      }
    }

    socket.on("connection_state", handleConnectionState);

    function handleMissionSuccess(_data: any) {
      setTelemetry((prev) => ({ ...prev, missionUploaded: true }));
    }

    socket.on("mission:success", handleMissionSuccess);

    return () => {
      socket.off("telemetry:update", handleTelemetry);
      socket.off("vehicleStatus", handleStatus);
      socket.off("connection_state", handleConnectionState);
      socket.off("mission:success", handleMissionSuccess);
    };
  }, []);

  return (
    <TelemetryContext.Provider value={telemetry}>
      {children}
    </TelemetryContext.Provider>
  );
}

export function useTelemetry() {
  return useContext(TelemetryContext);
}
