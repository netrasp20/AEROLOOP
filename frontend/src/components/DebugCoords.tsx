import { useTelemetry } from "../providers/TelemetryProvider";

function DebugCoords() {
  const t = useTelemetry();

  return (
    <div className="debug-coords">
      <div className="debug-coords-title">📍 Rover Debug</div>
      <table>
        <tbody>
          <tr>
            <td className="debug-label">Lat</td>
            <td className="debug-val">{t.latitude.toFixed(6)}</td>
          </tr>
          <tr>
            <td className="debug-label">Lon</td>
            <td className="debug-val">{t.longitude.toFixed(6)}</td>
          </tr>
          <tr>
            <td className="debug-label">GPS Fix</td>
            <td className="debug-val">{t.gpsFix} ({t.satellites} sats)</td>
          </tr>
          <tr>
            <td className="debug-label">Mode</td>
            <td className="debug-val">{t.mode}</td>
          </tr>
          <tr>
            <td className="debug-label">Armed</td>
            <td className="debug-val">{t.armed ? "ARMED" : "DISARMED"}</td>
          </tr>
          <tr>
            <td className="debug-label">Mission</td>
            <td className="debug-val">{t.missionRunning ? "Running" : t.missionUploaded ? "Uploaded" : "None"} / WP:{t.missionCurrent}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export default DebugCoords;
