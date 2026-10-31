import { Activity, AlertTriangle } from "lucide-react";
import { useTelemetry } from "../../hooks/useTelemetry";
import { useEscSetup } from "../../hooks/useEscSetup";
import SetupReadOnlyState from "./SetupReadOnlyState";

const metric = (value: number | null, unit: string, digits = 1) => value === null ? "Unavailable" : `${value.toFixed(digits)} ${unit}`;

export default function SetupEsc() {
  const telemetry = useTelemetry();
  const { esc, connectionLost, refresh } = useEscSetup(telemetry.connected);
  return <SetupReadOnlyState page="ESC" icon={<Activity size={18} />} subtitle="Actual ESC telemetry and metadata-decoded configuration parameters" connected={telemetry.connected} connectionState={telemetry.connectionState ?? "DISCONNECTED"} disconnectReason={telemetry.disconnectReason ?? null} connectionLost={connectionLost} snapshot={esc} onRefresh={refresh}>
    {esc && <>
      <div className="actuator-warning" data-testid="esc-disabled-warning"><AlertTriangle size={15} /><span><strong>ESC calibration and actuator commands are disabled.</strong> This page displays vehicle-reported data only.</span></div>
      <section className="setup-card"><h3 className="setup-card-title">ESC Telemetry <span>{esc.escCount} reported</span></h3>
        {esc.telemetry.length === 0 ? <div className="actuator-unavailable" data-testid="esc-telemetry-unavailable">ESC telemetry unavailable. No ESC telemetry frames have been reported.</div> : <div className="actuator-table-wrap"><table className="actuator-table"><thead><tr><th>ESC</th><th>RPM</th><th>Voltage</th><th>Current</th><th>Temperature</th><th>Consumption</th><th>Status</th><th>Freshness</th></tr></thead><tbody>{esc.telemetry.map((item) => <tr key={item.index} data-testid={`esc-telemetry-${item.index}`}><td>{item.index}</td><td>{metric(item.rpm, "rpm", 0)}</td><td>{metric(item.voltage, "V", 2)}</td><td>{metric(item.current, "A", 2)}</td><td>{metric(item.temperature, "°C")}</td><td>{metric(item.consumptionMah, "mAh", 0)}</td><td>{item.status || "Unavailable"}</td><td><span className={`actuator-freshness ${item.freshness.toLowerCase()}`}>{item.freshness === "AVAILABLE" ? "Available" : item.freshness === "STALE" ? "Stale" : "Unavailable"}</span></td></tr>)}</tbody></table></div>}
      </section>
      <section className="setup-card"><h3 className="setup-card-title">Present ESC Configuration</h3>
        {esc.config.length === 0 ? <p className="setup-empty-note">No ESC configuration parameters are present in the vehicle parameter cache.</p> : <div className="setup-fw-grid">{esc.config.map((param) => <div className="setup-fw-row" key={param.id} data-testid={`esc-param-${param.id}`}><span className="setup-fw-label">{param.name}<em className="actuator-param-id">{param.id}</em></span><span className="setup-fw-value">{!param.supported || param.value === null ? "Unavailable" : param.decoded ? `${param.decoded} (${param.value})` : `${param.value}${param.units ? ` ${param.units}` : ""}`}</span></div>)}</div>}
        <p className="setup-note">Labels and decoded values come from parameter metadata. Missing values remain unavailable; this page provides no parameter editing or write action.</p>
      </section>
    </>}
  </SetupReadOnlyState>;
}
