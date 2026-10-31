import { useMissionContext } from "../context/MissionContext";

const COLUMNS = [
  "WP",
  "Command",
  "Latitude",
  "Longitude",
  "Altitude",
  "Frame",
] as const;

function WaypointTable() {
  const {
    waypoints,
    updateWaypoint,
  } = useMissionContext();

  return (
    <div className="waypoint-table">
      <div className="wt-header">
        {COLUMNS.map((col) => (
          <div key={col} className={`wt-h wt-h--${col.toLowerCase()}`}>
            {col}
          </div>
        ))}
      </div>

      <div className="wt-body">
        {waypoints.length === 0 && (
          <div className="wt-row wt-row--empty">
            <div className="wt-cell wt-cell--wp" />
            <div className="wt-cell wt-cell--command" />
            <div className="wt-cell wt-cell--lat">No Waypoints</div>
            <div className="wt-cell wt-cell--lng" />
            <div className="wt-cell wt-cell--alt" />
            <div className="wt-cell wt-cell--frame" />
          </div>
        )}

        {waypoints.map((wp) => (
          <div className="wt-row" key={wp.id}>
            <div className="wt-cell wt-cell--wp">{wp.id}</div>
            <div className="wt-cell wt-cell--command">WAYPOINT</div>
            <div className="wt-cell wt-cell--lat">
              <input
                type="number"
                step="0.000001"
                value={wp.lat}
                onChange={(e) =>
                  updateWaypoint(wp.id, {
                    lat: Number(e.target.value),
                  })
                }
              />
            </div>
            <div className="wt-cell wt-cell--lng">
              <input
                type="number"
                step="0.000001"
                value={wp.lng}
                onChange={(e) =>
                  updateWaypoint(wp.id, {
                    lng: Number(e.target.value),
                  })
                }
              />
            </div>
            <div className="wt-cell wt-cell--alt">
              <input
                type="number"
                value={wp.altitude}
                onChange={(e) =>
                  updateWaypoint(wp.id, {
                    altitude: Number(e.target.value),
                  })
                }
              />
            </div>
            <div className="wt-cell wt-cell--frame">GLOBAL</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default WaypointTable;
