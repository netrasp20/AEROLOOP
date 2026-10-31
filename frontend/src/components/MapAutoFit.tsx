import { useEffect, useRef, useCallback } from "react";
import { useMap } from "react-leaflet";
import { useTelemetry } from "../providers/TelemetryProvider";

const INITIAL_ZOOM = 17;
const FOLLOW_THRESHOLD_METERS = 50;

// NOTE: This component intentionally does NOT touch the map camera when
// waypoints are added/edited/removed. Adding a waypoint is an overlay/state
// change only — the user's current zoom and center must be preserved exactly.
// (Earlier versions called map.fitBounds() on waypoint changes, which caused
// the map to zoom/recenter whenever a waypoint was created — that is the bug
// that was removed.)

function MapAutoFit() {
  const map = useMap();
  const t = useTelemetry();
  const fitted = useRef(false);
  const userInteracted = useRef(false);

  useEffect(() => {
    const handleInteract = () => {
      userInteracted.current = true;
    };
    map.on("mousedown", handleInteract);
    map.on("touchstart", handleInteract);
    return () => {
      map.off("mousedown", handleInteract);
      map.off("touchstart", handleInteract);
    };
  }, [map]);

  // Vehicle-follow: center on the rover when connected (and only when the user
  // hasn't manually moved the map). This is unrelated to waypoint editing.
  useEffect(() => {
    const hasRover = t.connected && t.latitude !== 0 && t.longitude !== 0;
    if (!hasRover) return;

    const roverPt: [number, number] = [t.latitude, t.longitude];

    if (!fitted.current) {
      map.setView(roverPt, INITIAL_ZOOM, { animate: true });
      fitted.current = true;
      userInteracted.current = false;
      return;
    }

    if (userInteracted.current) return;

    const center = map.getCenter();
    const dist = map.distance(center, roverPt);
    if (dist > FOLLOW_THRESHOLD_METERS) {
      map.setView(roverPt, map.getZoom(), { animate: true });
    }
  }, [t.latitude, t.longitude, t.connected, map]);

  const recenter = useCallback(() => {
    if (t.connected && t.latitude !== 0 && t.longitude !== 0) {
      map.setView([t.latitude, t.longitude], INITIAL_ZOOM, { animate: true });
      userInteracted.current = false;
    }
  }, [map, t.connected, t.latitude, t.longitude]);

  useEffect(() => {
    (window as any).__mapRecenter = recenter;
    return () => {
      delete (window as any).__mapRecenter;
    };
  }, [recenter]);

  return null;
}

export default MapAutoFit;
