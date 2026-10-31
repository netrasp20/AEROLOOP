import {
  MapPinned,
  Gauge,
  BatteryFull,
  Satellite,
  Activity,
  Navigation,
  Compass,
  Wind,
} from "lucide-react";

import "../styles/telemetry.css";
import TelemetryCard from "./TelemetryCard";
import { useTelemetry } from "../providers/TelemetryProvider";
import { useMissionContext } from "../context/MissionContext";

/* haversine distance (meters) between two lat/lon points */
function haversineDistance(
  lat1: number, lon1: number,
  lat2: number, lon2: number,
): number {
  if (lat1 === 0 && lon1 === 0) return 0;
  if (lat2 === 0 && lon2 === 0) return 0;

  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function TelemetryGrid() {
  const t = useTelemetry();
  const { home, waypoints } = useMissionContext();

  /* Every card reflects ONLY live MAVLink telemetry. Until the vehicle is
     connected (or a value is reported) the card shows a placeholder, never a
     hardcoded number. */
  const connected = t.connected;

  const fixLabels = ["None", "No Fix", "2D", "3D", "3D DGPS", "RTK Float", "RTK Fixed"];
  const fixLabel = fixLabels[t.gpsFix] ?? `Fix ${t.gpsFix}`;

  /* distance: from vehicle to home (or 0 if home unknown) */
  const distToHome = home
    ? haversineDistance(t.latitude, t.longitude, home.lat, home.lng)
    : t.distance;

  /* distance to next un-reached waypoint */
  const nextWp = waypoints.find((wp) => wp.sequence > t.missionReached);
  const distToNextWp = nextWp
    ? haversineDistance(t.latitude, t.longitude, nextWp.lat, nextWp.lng)
    : 0;

  /* The altitude card shows the vehicle's LIVE relative altitude above home
     (GLOBAL_POSITION_INT.relative_alt), the value pilots monitor during
     missions. It starts at ~0 m on the ground and tracks takeoff, flight,
     hover, landing and RTL smoothly — it never shows absolute AMSL elevation
     and never the mission's planned target altitude (that belongs only in the
     Mission Active panel's "Target Altitude" row). */
  /* Battery: value only shown once a live battery reading exists. The percent
     is the autopilot's report (or, for SITL which has no battery monitor, a
     live estimate derived from voltage). Until then, "--". */
  const battKnown = connected && (t.batteryVoltage > 0 || t.batteryRemaining > 0);

  const altCard = (
    <TelemetryCard title="Altitude" value={connected ? t.relativeAltitude.toFixed(1) : "--"} unit={connected ? "m" : ""} icon={<MapPinned size={22} />} />
  );

  return (
    <div className="telemetry-grid">
      {altCard}
      <TelemetryCard title="Ground Speed" value={connected ? t.groundSpeed.toFixed(1) : "0.0"} unit="m/s" icon={<Gauge size={22} />} />
      <TelemetryCard title="Air Speed" value={connected ? (t.airSpeed > 0 ? t.airSpeed.toFixed(1) : "--") : "0.0"} unit="m/s" icon={<Wind size={22} />} />
      <TelemetryCard title="Heading" value={connected ? t.heading.toFixed(1) : "--"} unit={connected ? "°" : ""} icon={<Compass size={22} />} />
      <TelemetryCard title="Battery" value={battKnown ? `${t.batteryRemaining}%` : "--"} unit={battKnown ? `${t.batteryVoltage.toFixed(2)}V` : ""} icon={<BatteryFull size={22} />} />
      <TelemetryCard title="GPS" value={connected ? fixLabel : "--"} unit={connected ? `Sats: ${t.satellites}` : ""} icon={<Satellite size={22} />} />
      <TelemetryCard title="Mode" value={connected ? t.mode : "--"} unit={connected ? (t.armed ? "ARMED" : "DISARMED") : ""} icon={<Activity size={22} />} />
      <TelemetryCard title="Dist to Home" value={connected ? distToHome.toFixed(1) : "0.0"} unit="m" icon={<Navigation size={22} />} />
      <TelemetryCard title="Dist to Next WP" value={connected ? distToNextWp.toFixed(1) : "0.0"} unit="m" icon={<Navigation size={22} />} />
      <TelemetryCard title="HDOP" value={connected ? t.hdop.toFixed(1) : "--"} unit="" icon={<Satellite size={22} />} />
    </div>
  );
}

export default TelemetryGrid;
