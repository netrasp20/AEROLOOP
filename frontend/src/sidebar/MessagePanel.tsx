import { useTelemetry } from "../providers/TelemetryProvider";

function MessagePanel() {
  const t = useTelemetry();

  return (
    <div className="message-panel">
      <div className={`msg-line ${t.connected ? "msg-ok" : "msg-muted"}`}>
        {t.connected ? `● Connected (${t.vehicleType} / ${t.autopilot})` : "○ Disconnected"}
      </div>

      <div className={`msg-line ${t.gpsFix >= 3 ? "msg-ok" : "msg-muted"}`}>
        {t.gpsFix >= 3 ? `● GPS Fix: ${["None", "No Fix", "2D", "3D", "3D DGPS", "RTK Float", "RTK Fixed"][t.gpsFix]}` : "○ Waiting for GPS Fix"}
      </div>

      <div className={`msg-line ${t.armed ? "msg-warn" : "msg-muted"}`}>
        {t.armed ? "● ARMED" : "○ DISARMED"}
      </div>

      <div className="msg-line msg-muted">
        Mode: {t.mode}
      </div>

      {t.statusText && (
        <div className="msg-line msg-status">
          📡 {t.statusText}
        </div>
      )}

      <div className="msg-line msg-muted msg-timestamp">
        Last update: {t.timestamp ? new Date(t.timestamp).toLocaleTimeString() : "—"}
      </div>
    </div>
  );
}

export default MessagePanel;