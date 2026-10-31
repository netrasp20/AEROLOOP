import { useTelemetry } from "../../providers/TelemetryProvider";

function CompassWidget() {
  const t = useTelemetry();

  return (
    <div className="data-card">
      <h3>Compass</h3>
      <div className="compass-circle">
        <div
          className="compass-needle"
          style={{ transform: `rotate(${-t.heading}deg)` }}
        >
          N
        </div>
      </div>
      <div className="compass-heading">{t.heading.toFixed(0)}°</div>
    </div>
  );
}

export default CompassWidget;
