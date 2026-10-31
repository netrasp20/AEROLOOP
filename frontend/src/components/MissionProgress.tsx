import { useTelemetry } from "../providers/TelemetryProvider";
import { useMissionContext } from "../context/MissionContext";

function MissionProgress() {
  const t = useTelemetry();
  const { waypoints } = useMissionContext();

  const currentWp = t.missionCurrent;
  const reachedWp = t.missionReached;
  const missionCompleted = t.missionCompleted;

  const totalWaypoints = waypoints.length;

  if (totalWaypoints === 0) {
    return (
      <div className="mission-progress">
        <div className="mission-progress-header">Mission Progress</div>
        <div className="mission-progress-empty">No waypoints in mission.</div>
      </div>
    );
  }

  const progressPct = missionCompleted
    ? 100
    : currentWp > 0 && totalWaypoints > 0
      ? Math.min(100, Math.round((currentWp / totalWaypoints) * 100))
      : 0;

  return (
    <div className="mission-progress">
      <div className="mission-progress-header">
        Mission Progress
        {missionCompleted && (
          <span className="mission-progress-wp">✓ Completed</span>
        )}
        {!missionCompleted && currentWp > 0 && (
          <span className="mission-progress-wp">
            WP {Math.min(currentWp, totalWaypoints)} / {totalWaypoints}
          </span>
        )}
        {!missionCompleted && currentWp === 0 && totalWaypoints > 0 && (
          <span className="mission-progress-wp">
            At HOME — {totalWaypoints} waypoints
          </span>
        )}
      </div>

      <div className="mission-progress-bar-track">
        <div
          className="mission-progress-bar-fill"
          style={{ width: `${progressPct}%` }}
        />
      </div>

      <div className="mission-progress-list">
        {waypoints.map((wp) => {
          const seq = wp.sequence;
          /* "Completed" must reflect an actual arrival, not the waypoint the
             rover is merely heading towards. missionReached is only advanced
             when ArduPilot confirms a waypoint has been reached, so a ✓ never
             appears before the waypoint is physically visited. */
          const isCompleted = missionCompleted ||
            (reachedWp > 0 && seq <= reachedWp);
          const isActive = !isCompleted &&
            !missionCompleted &&
            currentWp > 0 &&
            seq === currentWp;

          let statusClass = "waiting";
          let statusLabel = "Waiting";

          if (isActive) {
            statusClass = "active";
            statusLabel = "Active";
          } else if (isCompleted) {
            statusClass = "completed";
            statusLabel = "Completed";
          }

          return (
            <div
              key={wp.id}
              className={`mission-progress-item ${statusClass}`}
            >
              <span className="mission-progress-item-badge">
                {isCompleted ? "✓" : isActive ? "▶" : "○"}
              </span>
              <span className="mission-progress-item-name">
                WP{seq}
              </span>
              <span className="mission-progress-item-status">
                {statusLabel}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default MissionProgress;
