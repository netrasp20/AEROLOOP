import { useState } from "react";

import SetupNav from "./SetupNav";
import SetupSummary from "./SetupSummary";
import SetupFirmware from "./SetupFirmware";
import SetupFrame from "./SetupFrame";
import SetupInactive from "./SetupInactive";
import SetupParameters from "./SetupParameters";
import SetupRadio from "./SetupRadio";
import SetupSensors from "./SetupSensors";
import SetupPower from "./SetupPower";
import SetupSafety from "./SetupSafety";
import SetupMotors from "./SetupMotors";
import SetupEsc from "./SetupEsc";
import SetupLogging from "./SetupLogging";
import SetupScripting from "./SetupScripting";

import { summaryBadge } from "./setupLogic";
import { useSetupSummary } from "../../hooks/useSetupSummary";
import { useTelemetry } from "../../hooks/useTelemetry";

import FlightModes from "../parameters/FlightModes";

import "../../styles/setup.css";

export default function SetupConfig() {
  const [activeId, setActiveId] = useState("summary");

  const telemetry = useTelemetry();
  const { summary } = useSetupSummary(telemetry.connected);

  const counts = summary?.counts ? summaryBadge(summary.counts) : null;

  let content: React.ReactNode;
  if (activeId === "summary") {
    content = <SetupSummary summary={summary} onNavigate={setActiveId} />;
  } else if (activeId === "firmware") {
    content = <SetupFirmware />;
  } else if (activeId === "frame") {
    content = <SetupFrame />;
  } else if (activeId === "sensors") {
    content = <SetupSensors />;
  } else if (activeId === "radio") {
    content = <SetupRadio />;
  } else if (activeId === "power") {
    content = <SetupPower />;
  } else if (activeId === "safety") {
    content = <SetupSafety />;
  } else if (activeId === "motors") {
    content = <SetupMotors />;
  } else if (activeId === "esc") {
    content = <SetupEsc />;
  } else if (activeId === "logging") {
    content = <SetupLogging />;
  } else if (activeId === "scripting") {
    content = <SetupScripting />;
  } else if (activeId === "modes") {
    content = <FlightModes />;
  } else if (activeId === "parameters") {
    content = <SetupParameters />;
  } else {
    content = (
      <SetupInactive
        phase="8"
        description="This Setup page is not yet implemented."
        status="No vehicle functionality is simulated for this page."
      />
    );
  }

  return (
    <div className="setup-screen" data-testid="setup-screen">
      <header className="setup-topbar">
        <div className="setup-brand">
          <span className="setup-brand-mark" />
          <span className="setup-brand-text">VEHICLE SETUP</span>
        </div>
        <div className="setup-top-status">
          {telemetry.connected ? (
            <>
              <span
                className={`setup-conn-chip ${telemetry.armed ? "armed" : "good"}`}
                data-testid="setup-conn-chip"
              >
                {telemetry.armed ? "ARMED" : "Disarmed"}
              </span>
              <span className="setup-top-mode">{telemetry.mode}</span>
              <span className="setup-top-vehicle">{telemetry.vehicleType}</span>
            </>
          ) : (
            <span className="setup-conn-chip idle" data-testid="setup-conn-chip">
              Disconnected
            </span>
          )}
        </div>
      </header>

      <div className="setup-body">
        <aside className="setup-nav-panel">
          <SetupNav activeId={activeId} counts={counts ?? undefined} onSelect={setActiveId} />
        </aside>
        <section className="setup-content-panel">{content}</section>
      </div>
    </div>
  );
}
