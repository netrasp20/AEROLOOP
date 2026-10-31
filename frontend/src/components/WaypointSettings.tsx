import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { useMissionContext } from "../context/MissionContext";

export default function WaypointSettings() {
  const { waypoints, selectedWaypointId, updateWaypoint, deleteWaypoint } = useMissionContext();
  const waypoint = waypoints.find((wp) => wp.id === selectedWaypointId);

  const [alt, setAlt] = useState("");
  const [hover, setHover] = useState("");

  useEffect(() => {
    if (waypoint) {
      setAlt(waypoint.altitude.toString());
      setHover(waypoint.hoverTime.toString());
    }
  }, [waypoint]);

  if (!waypoint) return null;

  const handleDelete = () => {
    if (window.confirm(`Delete Waypoint ${waypoint.id}?`)) {
      deleteWaypoint(waypoint.id);
    }
  };

  return (
    <div className="waypoint-editor" key={waypoint.id}>
      <div className="we-header">
        <span className="we-icon">📍</span>
        <span className="we-title">Waypoint {waypoint.id}</span>
        <button
          className="we-delete"
          onClick={handleDelete}
          title="Delete Waypoint"
        >
          <Trash2 size={14} />
        </button>
      </div>
      <div className="we-body">
        <div className="we-field">
          <label className="we-label">Altitude (m)</label>
          <input
            className="we-input"
            type="text"
            value={alt}
            onChange={(e) => /^-?\d*\.?\d*$/.test(e.target.value) && setAlt(e.target.value)}
            onBlur={() => {
              const v = alt === "" ? 10 : parseFloat(alt);
              if (!isNaN(v)) updateWaypoint(waypoint.id, { altitude: v });
              setAlt(v.toString());
            }}
          />
        </div>
        <div className="we-field">
          <label className="we-label">Hover Time (s)</label>
          <input
            className="we-input"
            type="text"
            value={hover}
            onChange={(e) => /^\d*$/.test(e.target.value) && setHover(e.target.value)}
            onBlur={() => {
              const v = hover === "" ? 5 : parseInt(hover);
              if (!isNaN(v)) updateWaypoint(waypoint.id, { hoverTime: v });
              setHover(v.toString());
            }}
          />
        </div>
      </div>
    </div>
  );
}
