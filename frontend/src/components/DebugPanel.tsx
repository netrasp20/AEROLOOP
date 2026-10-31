import { MapPin, Satellite, Activity } from "lucide-react";
import DraggablePanel from "./DraggablePanel";
import { useTelemetry } from "../providers/TelemetryProvider";

function DebugPanel() {
  const t = useTelemetry();

  const fixLabels = ["None", "No Fix", "2D", "3D", "3D DGPS", "RTK Float", "RTK Fixed"];
  const fixLabel = fixLabels[t.gpsFix] ?? `Fix ${t.gpsFix}`;
  const missionState = t.missionRunning ? "Running" : t.missionUploaded ? "Uploaded" : "None";

  return (
    <DraggablePanel
      id="debug-panel"
      title="Telemetry"
      defaultWidth={320}
      defaultHeight={320}
      defaultPos={{ x: 12, y: 280 }}
      icon={<Activity size={14} />}
    >
      <div className="debug-panel-grid">
        <div className="debug-panel-section">
          <div className="debug-panel-section-title">
            <MapPin size={12} /> Rover GPS
          </div>
          <div className="debug-panel-row">
            <span className="debug-panel-label">Lat</span>
            <span className="debug-panel-value">{t.latitude.toFixed(6)}</span>
          </div>
          <div className="debug-panel-row">
            <span className="debug-panel-label">Lon</span>
            <span className="debug-panel-value">{t.longitude.toFixed(6)}</span>
          </div>
          <div className="debug-panel-row">
            <span className="debug-panel-label">Alt</span>
            <span className="debug-panel-value">{t.relativeAltitude.toFixed(1)} m</span>
          </div>
          <div className="debug-panel-row">
            <span className="debug-panel-label">Heading</span>
            <span className="debug-panel-value">{t.heading.toFixed(1)}°</span>
          </div>
          <div className="debug-panel-row">
            <span className="debug-panel-label">Speed</span>
            <span className="debug-panel-value">{t.groundSpeed.toFixed(1)} m/s</span>
          </div>
        </div>

        <div className="debug-panel-section">
          <div className="debug-panel-section-title">
            <Satellite size={12} /> Status
          </div>
          <div className="debug-panel-row">
            <span className="debug-panel-label">Fix</span>
            <span className="debug-panel-value">{fixLabel}</span>
          </div>
          <div className="debug-panel-row">
            <span className="debug-panel-label">Sats</span>
            <span className="debug-panel-value">{t.satellites}</span>
          </div>
          <div className="debug-panel-row">
            <span className="debug-panel-label">Mode</span>
            <span className="debug-panel-value">{t.mode}</span>
          </div>
          <div className="debug-panel-row">
            <span className="debug-panel-label">Armed</span>
            <span className="debug-panel-value">{t.armed ? "YES" : "NO"}</span>
          </div>
          <div className="debug-panel-row">
            <span className="debug-panel-label">Connected</span>
            <span className="debug-panel-value">{t.connected ? "YES" : "NO"}</span>
          </div>
          <div className="debug-panel-row">
            <span className="debug-panel-label">Mission</span>
            <span className="debug-panel-value">{missionState}</span>
          </div>
          <div className="debug-panel-row">
            <span className="debug-panel-label">Current WP</span>
            <span className="debug-panel-value">{t.missionCurrent}</span>
          </div>
        </div>
      </div>
    </DraggablePanel>
  );
}

export default DebugPanel;
