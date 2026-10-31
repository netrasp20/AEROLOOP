import { Braces } from "lucide-react";
import { useTelemetry } from "../../hooks/useTelemetry";
import { useScriptingSetup } from "../../hooks/useScriptingSetup";
import SetupReadOnlyState from "./SetupReadOnlyState";
import SetupParamField from "./SetupParamField";

export default function SetupScripting() {
  const telemetry = useTelemetry();
  const { scripting, connectionLost, refresh } = useScriptingSetup(telemetry.connected);

  return (
    <SetupReadOnlyState
      page="Scripting"
      icon={<Braces size={18} />}
      subtitle="Scripting capability detected from the vehicle and its real SCR_ parameters"
      connected={telemetry.connected}
      connectionState={telemetry.connectionState ?? "DISCONNECTED"}
      disconnectReason={telemetry.disconnectReason ?? null}
      connectionLost={connectionLost}
      snapshot={scripting}
      onRefresh={refresh}
    >
      {scripting && (
        <>
          <div className="actuator-warning" data-testid="scripting-readonly-warning">
            <strong>Script upload and execution are disabled.</strong> This page only reports the
            scripting capability the vehicle exposes and the SCR_ parameters it holds. It never
            uploads, starts, stops or edits a script.
          </div>

          <section className="setup-card" data-testid="scripting-capability">
            <h3 className="setup-card-title">Scripting Capability</h3>
            <p className="setup-fw-value" data-testid="scripting-capability-reason">
              {scripting.capability.reason}
            </p>
            <div className="setup-fw-grid">
              <div className="setup-fw-row">
                <span className="setup-fw-label">Scripting detected</span>
                <span className="setup-fw-value" data-testid="scripting-detected">
                  {scripting.capability.scriptingDetected ? "Yes" : "No"}
                </span>
              </div>
              <div className="setup-fw-row">
                <span className="setup-fw-label">Script execution</span>
                <span className="setup-fw-value" data-testid="scripting-execution">
                  {scripting.executionEnabled ? "Enabled" : "Disabled"}
                </span>
              </div>
              <div className="setup-fw-row">
                <span className="setup-fw-label">Script variables<em className="actuator-param-id">SCR_USER1-5</em></span>
                <span className="setup-fw-value" data-testid="scripting-user-tokens">
                  {scripting.userTokens.length === 0
                    ? "None present"
                    : scripting.userTokens.join(", ")}
                </span>
              </div>
            </div>
          </section>

          <section className="setup-card">
            <h3 className="setup-card-title">
              Present Scripting Configuration <span>{scripting.configCount} parameters</span>
            </h3>
            {scripting.config.length === 0 ? (
              <p className="setup-empty-note" data-testid="scripting-config-empty">
                No SCR_* configuration parameters are present in the vehicle parameter cache.
              </p>
            ) : (
              <div className="setup-fw-grid">
                {scripting.config.map((field) => (
                  <SetupParamField key={field.id} field={field} />
                ))}
              </div>
            )}
            <p className="setup-note">
              Script files are read through the existing MAVFTP file browser, which is left
              unchanged. Edits to script variables are staged here and applied through the shared
              verified write pipeline.
            </p>
          </section>
        </>
      )}
    </SetupReadOnlyState>
  );
}
