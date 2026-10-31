import { Marker, Popup } from "react-leaflet";
import type { LeafletEvent, LeafletMouseEvent } from "leaflet";
import L from "leaflet";

import { useMissionContext } from "../context/MissionContext";
import { useTelemetry } from "../providers/TelemetryProvider";

type WpState = "waiting" | "active" | "completed";

function createWaypointIcon(
  id: number,
  state: WpState,
  selected: boolean
) {
  const bgColor = state === "completed" ? "#16a34a"
    : state === "active" ? "#f59e0b"
    : selected ? "#22c55e"
    : "#7c3aed";

  const borderColor = state === "active" ? "#fbbf24"
    : selected ? "#16a34a"
    : "white";

  const pulse = state === "active" ? "animation: waypoint-pulse 1.2s ease-in-out infinite;" : "";

  return new L.DivIcon({
    className: "",
    html: `
      <div
        style="
          width:32px;
          height:32px;
          border-radius:50%;
          background:${bgColor};
          border:3px solid ${borderColor};
          display:flex;
          align-items:center;
          justify-content:center;
          color:${state === "completed" ? "#d1fae5" : "white"};
          font-weight:bold;
          font-size:14px;
          box-shadow:0 0 10px rgba(0,0,0,.3);
          cursor:pointer;
          ${pulse}
        "
      >
        ${state === "completed" ? "✓" : id}
      </div>
    `,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
  });
}

function WaypointMarker() {
  const {
    waypoints,
    moveWaypoint,
    selectedWaypointId,
    setSelectedWaypointId,
    setWaypointMenu,
  } = useMissionContext();
  const telemetry = useTelemetry();

  const currentSeq = telemetry.missionCurrent;
  const reachedSeq = telemetry.missionReached;
  const missionRunning = telemetry.missionRunning;
  const missionCompleted = telemetry.missionCompleted;

  function waypointState(seq: number): WpState {
    /* "Completed" must reflect an actual arrival (missionReached), never the
       waypoint the rover is merely heading towards. So a ✓ only appears after
       the waypoint has been physically visited. */
    if (missionCompleted) return "completed";
    if (missionRunning && reachedSeq >= seq) return "completed";
    if (missionRunning && currentSeq === seq) return "active";
    return "waiting";
  }

  return (
    <>
      {waypoints.map((wp) => {
        const state = waypointState(wp.sequence);
        return (
        <Marker
          key={wp.id}
          position={[wp.lat, wp.lng]}
          icon={createWaypointIcon(
            wp.id,
            state,
            selectedWaypointId === wp.id
          )}
          draggable
          eventHandlers={{
            click: (e: LeafletMouseEvent) => {
              L.DomEvent.stopPropagation(e);
              setSelectedWaypointId(wp.id);
            },

            contextmenu: (e: LeafletMouseEvent) => {
              L.DomEvent.stopPropagation(e);
              setWaypointMenu({
                visible: true,
                x: e.originalEvent.clientX,
                y: e.originalEvent.clientY,
                waypointId: wp.id,
              });
            },

            dragend: (event: LeafletEvent) => {
              const marker = event.target as L.Marker;

              const position = marker.getLatLng();

              moveWaypoint(
                wp.id,
                position.lat,
                position.lng
              );
            },
          }}
        >
          <Popup>
            <div>
              <strong>Waypoint {wp.id}</strong>

              <br />

              Latitude: {wp.lat.toFixed(6)}

              <br />

              Longitude: {wp.lng.toFixed(6)}

              <br />

              Altitude: {wp.altitude} m

              <br />

              Hover Time: {wp.hoverTime} s
            </div>
          </Popup>
        </Marker>
        );
      })}
    </>
  );
}

export default WaypointMarker;