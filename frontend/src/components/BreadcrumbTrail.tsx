import { useEffect, useRef } from "react";
import { Polyline } from "react-leaflet";
import { useTelemetry } from "../providers/TelemetryProvider";
function BreadcrumbTrail() {
  const t = useTelemetry();
  const trailRef = useRef<[number, number][]>([]);
  const runningRef = useRef(false);

  const missionRunning = t.missionRunning;
  const lat = t.latitude;
  const lng = t.longitude;

  useEffect(() => {
    if (missionRunning && !runningRef.current) {
      runningRef.current = true;
      trailRef.current = [];
    }
    if (!missionRunning && runningRef.current) {
      runningRef.current = false;
    }
  }, [missionRunning]);

  useEffect(() => {
    if (!runningRef.current) return;
    const last = trailRef.current[trailRef.current.length - 1];
    if (!last || last[0] !== lat || last[1] !== lng) {
      trailRef.current = [...trailRef.current, [lat, lng]];
    }
  }, [lat, lng]);

  const positions = trailRef.current;

  if (positions.length < 2) return null;

  return (
    <Polyline
      positions={positions}
      pathOptions={{
        color: "#22c55e",
        weight: 3,
        opacity: 0.7,
        dashArray: "8 6",
      }}
    />
  );
}

export default BreadcrumbTrail;
