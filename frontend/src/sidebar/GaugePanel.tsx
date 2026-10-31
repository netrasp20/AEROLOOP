import { useTelemetry } from "../providers/TelemetryProvider";
import { radToDeg } from "../utils/units";

function GaugePanel() {
  const t = useTelemetry();

  const fixLabels = ["None", "No Fix", "2D", "3D", "3D DGPS", "RTK Float", "RTK Fixed"];
  const fixLabel = fixLabels[t.gpsFix] ?? `Fix ${t.gpsFix}`;

  return (
    <div className="gauge-panel">
      <div>Battery : {t.batteryRemaining}% ({t.batteryVoltage.toFixed(2)}V)</div>
      <div>GPS : {t.satellites} Satellites ({fixLabel})</div>
      <div>Altitude : {t.relativeAltitude.toFixed(1)}m</div>
      <div>Heading : {t.heading.toFixed(1)}°</div>
      <div>Ground Speed : {t.groundSpeed.toFixed(1)} m/s</div>
      <div>Air Speed : {t.airSpeed.toFixed(1)} m/s</div>
      <div>Mode : {t.mode} {t.armed ? "ARMED" : "DISARMED"}</div>
      <div>Roll : {radToDeg(t.roll).toFixed(1)}°  Pitch : {radToDeg(t.pitch).toFixed(1)}°  Yaw : {radToDeg(t.yaw).toFixed(1)}°</div>
      <div>HDOP : {t.hdop.toFixed(1)}</div>
    </div>
  );
}

export default GaugePanel;