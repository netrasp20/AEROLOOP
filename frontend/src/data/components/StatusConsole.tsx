import { useTelemetry } from "../../providers/TelemetryProvider";

function StatusConsole() {
  const t = useTelemetry();
  const time = t.timestamp
    ? new Date(t.timestamp).toLocaleTimeString()
    : "";

  const fixLabels = ["None", "No Fix", "2D", "3D", "3D DGPS", "RTK Float", "RTK Fixed"];
  const fixLabel = fixLabels[t.gpsFix] ?? `Fix ${t.gpsFix}`;

  return (
    <div className="console">
      {t.statusText && (
        <div className="console-line info">
          [STATUS] {t.statusText}
        </div>
      )}
      <div className="console-line">
        {t.connected
          ? `[CONNECTED] ${t.vehicleType} | ${t.autopilot} | Sys ${t.systemId}`
          : "[DISCONNECTED]"}
      </div>
      {t.connected && (
        <>
          <div className="console-line">
            [GPS] {fixLabel} | Sats: {t.satellites} | HDOP: {t.hdop.toFixed(1)}
          </div>
          <div className="console-line">
            [MODE] {t.mode} | {t.armed ? "ARMED" : "DISARMED"}
          </div>
          <div className="console-line">
            [POS] {t.latitude.toFixed(6)}, {t.longitude.toFixed(6)}
          </div>
          <div className="console-line">
            [BAT] {t.batteryRemaining}% ({t.batteryVoltage.toFixed(2)}V)
          </div>
          <div className="console-line">
            [MISSION] Current: {t.missionCurrent} | Reached: {t.missionReached}
          </div>
          {time && <div className="console-line muted">Last update: {time}</div>}
        </>
      )}
    </div>
  );
}

export default StatusConsole;
