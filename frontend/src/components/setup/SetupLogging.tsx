import { FileText } from "lucide-react";
import { useTelemetry } from "../../hooks/useTelemetry";
import { useLoggingSetup } from "../../hooks/useLoggingSetup";
import SetupReadOnlyState from "./SetupReadOnlyState";
import SetupParamField from "./SetupParamField";

const STATUS_TONE: Record<string, string> = {
  Enabled: "safety-status-good",
  "Partially configured": "safety-status-warn",
  Disabled: "safety-status-warn",
  Unknown: "safety-status-neutral",
};

/**
 * MAVLink LOG_ENTRY.time_utc is a uint64 "time since UNIX epoch" whose unit is
 * not declared on the wire (UINT64_MAX when unknown). Normalise the common
 * magnitudes and refuse to invent a date for anything else.
 */
const utc = (value: number | null) => {
  if (value === null || !Number.isFinite(value) || value <= 0) return "Unavailable";
  let ms: number;
  if (value >= 1e17) ms = value / 1000; // nanoseconds
  else if (value >= 1e14) ms = value / 1000; // microseconds
  else if (value >= 1e11) ms = value; // milliseconds
  else if (value >= 1e8) ms = value * 1000; // seconds
  else return "Unavailable";
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? "Unavailable" : date.toISOString().replace("T", " ").slice(0, 19);
};

const size = (bytes: number | null) => {
  if (bytes === null) return "Unavailable";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
};

export default function SetupLogging() {
  const telemetry = useTelemetry();
  const { logging, connectionLost, refresh } = useLoggingSetup(telemetry.connected);

  return (
    <SetupReadOnlyState
      page="Logging"
      icon={<FileText size={18} />}
      subtitle="Logging parameters and the on-board dataflash log list reported by the vehicle"
      connected={telemetry.connected}
      connectionState={telemetry.connectionState ?? "DISCONNECTED"}
      disconnectReason={telemetry.disconnectReason ?? null}
      connectionLost={connectionLost}
      snapshot={logging}
      onRefresh={refresh}
    >
      {logging && (
        <>
          <section className="setup-card" data-testid="logging-status-card">
            <h3 className="setup-card-title">Logging Status</h3>
            <p>
              <span
                className={`safety-status-value ${STATUS_TONE[logging.status] ?? "safety-status-neutral"}`}
                data-testid="logging-status"
              >
                {logging.status}
              </span>
            </p>
            <div className="setup-fw-grid">
              <div className="setup-fw-row">
                <span className="setup-fw-label">Log files on board<em className="actuator-param-id">LOG_ENTRY</em></span>
                <span className="setup-fw-value" data-testid="logging-num-logs">
                  {logging.numLogs === null ? "Unavailable" : logging.numLogs}
                </span>
              </div>
              <div className="setup-fw-row">
                <span className="setup-fw-label">Last log number</span>
                <span className="setup-fw-value" data-testid="logging-last-log">
                  {logging.lastLogNum === null ? "Unavailable" : logging.lastLogNum}
                </span>
              </div>
            </div>
          </section>

          <section className="setup-card">
            <h3 className="setup-card-title">
              On-Board Log Entries <span>{logging.logEntryCount} listed</span>
            </h3>
            {logging.logEntries.length === 0 ? (
              <div className="actuator-unavailable" data-testid="logging-entries-unavailable">
                The vehicle has not broadcast any LOG_ENTRY frames, so no on-board log list is
                available. This is not simulated.
              </div>
            ) : (
              <div className="actuator-table-wrap">
                <table className="actuator-table">
                  <thead>
                    <tr>
                      <th>Log</th>
                      <th>Time (UTC)</th>
                      <th>Size</th>
                      <th>Files on card</th>
                      <th>Freshness</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logging.logEntries.map((entry) => (
                      <tr key={entry.id} data-testid={`logging-entry-${entry.id}`}>
                        <td>{entry.id}</td>
                        <td>{utc(entry.timeUtc)}</td>
                        <td>{size(entry.sizeBytes)}</td>
                        <td>{entry.numLogs === null ? "Unavailable" : entry.numLogs}</td>
                        <td>
                          <span className={`actuator-freshness ${entry.freshness.toLowerCase()}`}>
                            {entry.freshness === "AVAILABLE" ? "Available" : "Stale"}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="setup-card">
            <h3 className="setup-card-title">
              Present Logging Configuration <span>{logging.configCount} parameters</span>
            </h3>
            {logging.config.length === 0 ? (
              <p className="setup-empty-note" data-testid="logging-config-empty">
                No LOG_* configuration parameters are present in the vehicle parameter cache.
              </p>
            ) : (
              <div className="setup-fw-grid">
                {logging.config.map((field) => (
                  <SetupParamField key={field.id} field={field} />
                ))}
              </div>
            )}
            <p className="setup-note">
              Values, bit names, units and ranges come from ArduPilot parameter metadata. Edits are
              staged here and applied through the shared verified write pipeline; this page never
              downloads, deletes or reformats a log.
            </p>
          </section>
        </>
      )}
    </SetupReadOnlyState>
  );
}
