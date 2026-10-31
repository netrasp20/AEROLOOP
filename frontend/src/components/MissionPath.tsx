import { Polyline } from "react-leaflet";

import { useMissionContext } from "../context/MissionContext";
import { useTelemetry } from "../providers/TelemetryProvider";

const COLOR_REMAINING = "#00ff66";
const COLOR_COMPLETED = "#3f3f46";
const COLOR_RTL = "#c084fc";

type LatLng = [number, number];

function MissionPath() {
  const { waypoints } = useMissionContext();
  const t = useTelemetry();

  const hasHome = t.homeLatitude !== 0 || t.homeLongitude !== 0;

  if (!hasHome && waypoints.length < 2) {
    return null;
  }

  if (!hasHome && waypoints.length <= 1) {
    return null;
  }

  const home: LatLng = [t.homeLatitude, t.homeLongitude];
  const positions: LatLng[] = [];

  if (hasHome) {
    positions.push(home);
  }

  waypoints.forEach((wp) => {
    positions.push([wp.lat, wp.lng]);
  });

  if (positions.length < 2) {
    return null;
  }

  const segmentCount = positions.length - 1;
  const missionRunning = t.missionRunning;
  const missionCompleted = t.missionCompleted;
  const isRtl = t.mode === "RTL";

  /* Number of completed mission segments. Segment i connects positions[i] →
     positions[i+1]; when waypoint k is reached, segments 0..k-1 are done.
     During RTL and after completion every mission segment has been driven. */
  let completedSegments = 0;
  if (missionCompleted) {
    completedSegments = segmentCount;
  } else if (missionRunning && isRtl) {
    completedSegments = segmentCount;
  } else if (missionRunning) {
    completedSegments = Math.min(Math.max(t.missionReached, 0), segmentCount);
  }

  /* RTL return path: last waypoint → HOME. Drawn as a light-purple dashed
     line so it is clearly an automatic Return-to-Launch route, not a mission
     segment. Only visible once RTL is actually triggered. */
  let rtlPath: LatLng[] | null = null;

  if (missionRunning && isRtl && hasHome && positions.length >= 2) {
    rtlPath = [positions[positions.length - 1], home];
  }

  return (
    <>
      {Array.from({ length: segmentCount }, (_, i) => {
        const done = i < completedSegments;
        return (
          <Polyline
            key={i}
            positions={[positions[i], positions[i + 1]]}
            pathOptions={{
              color: done ? COLOR_COMPLETED : COLOR_REMAINING,
              weight: done ? 5 : 4,
              className: "mission-segment",
            }}
          />
        );
      })}
      {rtlPath && (
        <Polyline
          positions={rtlPath}
          pathOptions={{
            color: COLOR_RTL,
            weight: 2,
            dashArray: "6, 10",
            opacity: 0.55,
          }}
        />
      )}
    </>
  );
}

export default MissionPath;
