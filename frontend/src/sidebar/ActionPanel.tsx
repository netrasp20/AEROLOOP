import { useEffect, useState } from "react";

import socket from "../socket/socket";
import { useTelemetry } from "../providers/TelemetryProvider";
import { useMissionContext } from "../context/MissionContext";
import { useMissionStart } from "../hooks/useMissionStart";
import { setHome } from "../api/vehicle";
import MissionProgress from "../components/MissionProgress";

function ActionPanel() {
  const telemetry = useTelemetry();
  const { waypoints } = useMissionContext();
  const { execState } = useMissionStart(waypoints.length);

  const isMissionRunning = execState === "MISSION_RUNNING";

  const [connected, setConnected] = useState(false);
  const [homeState, setHomeState] = useState<{
    busy: boolean;
    message: string;
  }>({ busy: false, message: "" });
  const [rtlState, setRtlState] = useState<{
    active: boolean;
    message: string;
    distanceM: number;
  }>({ active: false, message: "", distanceM: 0 });

  useEffect(() => {
    if (telemetry.connected !== undefined) {
      setConnected(telemetry.connected);
    }
  }, [telemetry.connected]);

  useEffect(() => {
    function onRtlProgress(data: { message: string; distanceM?: number }) {
      setRtlState({
        active: true,
        message: data.message || "Returning to home...",
        distanceM: data.distanceM ?? 0,
      });
    }
    function onRtlSuccess(data: { message: string; distanceM?: number }) {
      setRtlState({
        active: false,
        message: data.message || "Rover is at home.",
        distanceM: data.distanceM ?? 0,
      });
    }
    function onRtlError(data: { message: string }) {
      setRtlState({
        active: false,
        message: data.message || "Return to launch failed.",
        distanceM: 0,
      });
    }

    socket.on("mission:rtl:progress", onRtlProgress);
    socket.on("mission:rtl:success", onRtlSuccess);
    socket.on("mission:rtl:error", onRtlError);

    return () => {
      socket.off("mission:rtl:progress", onRtlProgress);
      socket.off("mission:rtl:success", onRtlSuccess);
      socket.off("mission:rtl:error", onRtlError);
    };
  }, []);

  const rtlEnabled = connected;

  function handleRtl() {
    if (!rtlEnabled) return;
    setRtlState({ active: true, message: "Requesting return to launch...", distanceM: 0 });
    socket.emit("mission:rtl");
  }

  async function handleSetHome() {
    if (!connected || homeState.busy) return;
    setHomeState({ busy: true, message: "Setting home to current position..." });
    try {
      const res = await setHome();
      setHomeState({
        busy: false,
        message: res.success ? "Home set." : res.message || "Failed to set home.",
      });
    } catch {
      setHomeState({ busy: false, message: "Failed to set home." });
    }
  }

  return (
    <div className="action-panel">
      <button
        onClick={handleRtl}
        disabled={!rtlEnabled}
        title={
          !connected
            ? "Vehicle not connected"
            : "Return to launch (rover drives back to HOME)"
        }
      >
        RTL
      </button>

      <button onClick={handleSetHome} disabled={!connected || homeState.busy}>
        {homeState.busy ? "SETTING..." : "SET HOME"}
      </button>

      {telemetry.missionUploaded && (
        <div className="action-panel-state">
          {telemetry.armed ? "✓ Armed" : "○ Disarmed"} · Mode: {telemetry.mode}
          {telemetry.distanceToHome > 0 && (
            <span> · Home: {telemetry.distanceToHome.toFixed(1)}m{telemetry.atHome ? " (AT HOME)" : ""}</span>
          )}
        </div>
      )}

      {homeState.message && (
        <div className="action-panel-state" style={{ color: "#34d399" }}>
          {homeState.message}
        </div>
      )}

      {rtlState.active && (
        <div className="action-panel-state" style={{ color: "#f59e0b" }}>
          ↩ {rtlState.message}
        </div>
      )}

      {(isMissionRunning || execState === "MISSION_COMPLETED") && (
        <div style={{ gridColumn: "1 / -1", marginTop: 8 }}>
          <MissionProgress />
        </div>
      )}
    </div>
  );
}

export default ActionPanel;
