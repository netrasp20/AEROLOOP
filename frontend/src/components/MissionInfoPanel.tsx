import { useState, useEffect, useRef } from "react";
import { useTelemetry } from "../providers/TelemetryProvider";
import { useMissionContext } from "../context/MissionContext";

function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatMs(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const hr = Math.floor(totalSec / 3600);
  const min = Math.floor((totalSec % 3600) / 60);
  const sec = totalSec % 60;
  if (hr > 0) return `${hr}:${min.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
  return `${min.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
}

/* Distance (m) from the waypoint at which the rover is considered to have
   physically arrived, starting the hover countdown. Kept small so the timer
   starts at the real arrival instant rather than when a MAVLink "reached"
   message happens to be received. */
const HOVER_ARRIVAL_RADIUS_M = 3;

function MissionInfoPanel() {
  const t = useTelemetry();
  const { waypoints } = useMissionContext();
  const startRef = useRef<number | null>(null);
  const [elapsed, setElapsed] = useState("00:00");
  /* Start of the hover dwell: the moment the rover physically arrived at the
     current hover waypoint (frontend GPS distance check). Used to compute the
     live Hover Remaining countdown for that waypoint. */
  const [hoverStart, setHoverStart] = useState<{ seq: number; time: number } | null>(null);
  /* Dummy ticker re-rendered every second while hovering to drive the live
     countdown (independent of the elapsed-time interval). */
  const [, setHoverTick] = useState(0);

  const missionRunning = t.missionRunning;
  const missionCompleted = t.missionCompleted;
  const currentWp = t.missionCurrent;
  const gs = t.groundSpeed;
  const distance = t.missionTotalDistance;
  const totalWp = waypoints.length;

  useEffect(() => {
    if (missionRunning) {
      if (startRef.current === null) {
        startRef.current = Date.now();
      }
      const interval = setInterval(() => {
        if (startRef.current !== null) {
          setElapsed(formatMs(Date.now() - startRef.current));
        }
      }, 1000);
      return () => clearInterval(interval);
    } else {
      startRef.current = null;
      setElapsed("00:00");
    }
  }, [missionRunning]);

  /* Active waypoint = the waypoint whose sequence matches the current
     mission item (ArduPilot mission list is HOME@0 + waypoints@1..N).
     Look up by sequence (not array index) so the configured hover time,
     altitude and remaining distance always track the actual active waypoint,
     even if the planner list is re-ordered or edited mid-mission. */
  const targetWp =
    currentWp > 0 && totalWp > 0
      ? waypoints.find((wp) => wp.sequence === currentWp) ?? null
      : null;

  /* Reset the hover timer whenever there is no active mission, and start it
     the moment the rover physically arrives within the acceptance radius of
     the current hover waypoint. Driven by live GPS position, so the countdown
     always begins at the real arrival instant — independent of MAVLink message
     timing — and never jumps straight to 0. */
  useEffect(() => {
    if (!missionRunning || missionCompleted || totalWp === 0) {
      setHoverStart(null);
      return;
    }
    if (!targetWp || targetWp.hoverTime <= 0) return;
    const dist = haversineM(t.latitude, t.longitude, targetWp.lat, targetWp.lng);
    if (
      dist <= HOVER_ARRIVAL_RADIUS_M &&
      (hoverStart === null || hoverStart.seq !== targetWp.sequence)
    ) {
      setHoverStart({ seq: targetWp.sequence, time: Date.now() });
    }
  }, [missionRunning, missionCompleted, totalWp, targetWp, t.latitude, t.longitude, hoverStart]);

  /* "Hovering" = the rover has physically arrived at the active waypoint and
     that waypoint has a configured hover time. The countdown runs off the
     frontend clock from the arrival instant: 4 → 3 → 2 → 1 → 0. */
  const activeSeq = targetWp ? targetWp.sequence : -1;
  const activeHoverTime = targetWp ? targetWp.hoverTime : 0;
  const isRtl = t.mode === "RTL";

  const isHovering =
    missionRunning &&
    !missionCompleted &&
    !isRtl &&
    activeHoverTime > 0 &&
    hoverStart !== null &&
    hoverStart.seq === activeSeq;

  const hoverRemaining = isHovering && hoverStart
    ? Math.max(0, Math.ceil(activeHoverTime - (Date.now() - hoverStart.time) / 1000))
    : 0;

  /* "Hovering" status only while the countdown is still running; flips back
     to "Navigating" the moment it reaches zero. */
  const hovering = isHovering && hoverRemaining > 0;

  /* 1-second ticker while hovering so "Hover Remaining" decrements in real
     time every second (4 → 3 → 2 → 1 → 0). */
  useEffect(() => {
    if (!isHovering) return;
    const interval = setInterval(() => setHoverTick((v) => v + 1), 1000);
    return () => clearInterval(interval);
  }, [isHovering]);

  if ((!missionRunning && !missionCompleted) || totalWp === 0) return null;

  const wpDisplay = missionCompleted
    ? `${totalWp} / ${totalWp}`
    : currentWp > 0
      ? `${Math.min(currentWp, totalWp)} / ${totalWp}`
      : `Starting...`;

  let remainingDist = 0;
  if (targetWp && currentWp > 0 && !missionCompleted) {
    remainingDist = haversineM(t.latitude, t.longitude, targetWp.lat, targetWp.lng);
  }

  const status = missionCompleted
    ? "Completed"
    : currentWp === 0
      ? "Starting..."
      : hovering
        ? "Hovering"
        : "Navigating";

  /* Target altitude comes from the active waypoint's configured altitude
     (mission planning data), NOT from telemetry.altitude which is the rover's
     GPS elevation (e.g. ~900m at the SITL location). These are two different
     values and must never be mixed. */
  const targetAltitude = targetWp ? targetWp.altitude : 0;

  return (
    <div className="mission-info-panel">
      <div className="mission-info-header">MISSION {missionCompleted ? "COMPLETED" : "ACTIVE"}</div>
      <div className="mission-info-row">
        <span className="mission-info-label">Current Waypoint</span>
        <span className="mission-info-value">{targetWp ? `Waypoint ${targetWp.sequence}` : "Home"}</span>
      </div>
      <div className="mission-info-row">
        <span className="mission-info-label">Target Altitude</span>
        <span className="mission-info-value">{targetAltitude.toFixed(1)} m</span>
      </div>
      <div className="mission-info-row">
        <span className="mission-info-label">Mission Progress</span>
        <span className="mission-info-value">{wpDisplay}</span>
      </div>
      <div className="mission-info-row">
        <span className="mission-info-label">Ground Speed</span>
        <span className="mission-info-value">{gs.toFixed(1)} m/s</span>
      </div>
      {targetWp && targetWp.hoverTime > 0 && (
        <>
          <div className="mission-info-row">
            <span className="mission-info-label">Hover Time</span>
            <span className="mission-info-value">{targetWp.hoverTime} s</span>
          </div>
          <div className="mission-info-row">
            <span className="mission-info-label">Hover Remaining</span>
            <span className="mission-info-value">{isHovering ? `${hoverRemaining} s` : "--"}</span>
          </div>
        </>
      )}
      <div className="mission-info-row">
        <span className="mission-info-label">Remaining Distance</span>
        <span className="mission-info-value">{remainingDist < 1 ? (remainingDist * 100).toFixed(0) + ' cm' : remainingDist.toFixed(1) + ' m'}</span>
      </div>
      <div className="mission-info-row">
        <span className="mission-info-label">Total Distance</span>
        <span className="mission-info-value">{distance.toFixed(1)} m</span>
      </div>
      <div className="mission-info-row">
        <span className="mission-info-label">Elapsed Time</span>
        <span className="mission-info-value">{elapsed}</span>
      </div>
      <div className="mission-info-row">
        <span className="mission-info-label">Mission State</span>
        <span className="mission-info-value">{status}</span>
      </div>
    </div>
  );
}

export default MissionInfoPanel;
