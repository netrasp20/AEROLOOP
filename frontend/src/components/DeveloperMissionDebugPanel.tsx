import { useState, useEffect, useCallback } from "react";
import { useMissionContext } from "../context/MissionContext";
import { useTelemetry } from "../providers/TelemetryProvider";
import socket from "../socket/socket";

interface ArduPilotMission {
  success: boolean;
  count: number;
  error?: string;
  items?: Array<{
    seq: number;
    command: number;
    x: number;
    y: number;
    z: number;
  }>;
}

function DeveloperMissionDebugPanel() {
  const missionCtx = useMissionContext();
  const telemetry = useTelemetry();
  const [apMission, setApMission] = useState<ArduPilotMission | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [visible, setVisible] = useState(false);

  const waypointCount = missionCtx.waypoints.length;
  const missionCurrent = telemetry.missionCurrent;
  const missionReached = telemetry.missionReached;
  const missionRunning = telemetry.missionRunning;
  const missionCompleted = telemetry.missionCompleted;
  const missionUploaded = telemetry.missionUploaded;

  const verify = useCallback(() => {
    setVerifying(true);
    socket.emit("mission:verify");
  }, []);

  useEffect(() => {
    function onResult(data: ArduPilotMission) {
      setApMission(data);
      setVerifying(false);
      console.log("[DEBUG] Mission verification result:", data);
    }
    socket.on("mission:verify:result", onResult);
    return () => {
      socket.off("mission:verify:result", onResult);
    };
  }, []);

  if (!visible) {
    return (
      <button
        onClick={() => setVisible(true)}
        style={{
          position: "fixed",
          bottom: 4,
          right: 4,
          zIndex: 10000,
          fontSize: 10,
          padding: "2px 6px",
          opacity: 0.4,
          background: "#111",
          color: "#666",
          border: "1px solid #333",
          borderRadius: 4,
          cursor: "pointer",
        }}
        title="Show Mission Debug Panel"
      >
        DBG
      </button>
    );
  }

  const labelStyle: React.CSSProperties = { color: "#9ca3af", fontSize: 11, minWidth: 110 };
  const valueStyle: React.CSSProperties = { color: "#e5e7eb", fontWeight: 600, fontSize: 11, fontFamily: "monospace" };
  const rowStyle: React.CSSProperties = { display: "flex", justifyContent: "space-between", padding: "2px 0" };
  const ok = "#22c55e";
  const warn = "#f59e0b";
  const err = "#ef4444";

  const uploadedOk = apMission && apMission.success && apMission.count > 0;

  return (
    <div
      style={{
        position: "fixed",
        bottom: 4,
        right: 4,
        zIndex: 10000,
        background: "rgba(0,0,0,0.92)",
        border: "1px solid #374151",
        borderRadius: 8,
        padding: "10px 14px",
        fontSize: 11,
        minWidth: 300,
        maxWidth: 360,
        color: "#d1d5db",
        fontFamily: "monospace",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <span style={{ fontWeight: 700, fontSize: 12, color: "#a78bfa" }}>
          MISSION DEBUG
        </span>
        <button
          onClick={() => setVisible(false)}
          style={{ background: "none", border: "none", color: "#6b7280", cursor: "pointer", fontSize: 14, padding: 0 }}
        >
          ×
        </button>
      </div>

      <div style={{ borderTop: "1px solid #374151", paddingTop: 6 }}>

        <div style={rowStyle}>
          <span style={labelStyle}>MissionContext Waypoints</span>
          <span style={{ ...valueStyle, color: waypointCount > 0 ? ok : "#6b7280" }}>
            {waypointCount}
          </span>
        </div>

        <div style={rowStyle}>
          <span style={labelStyle}>Rendered on Map</span>
          <span style={{ ...valueStyle, color: waypointCount > 0 ? ok : "#6b7280" }}>
            {waypointCount > 0 ? waypointCount : 0}
          </span>
        </div>

        <div style={rowStyle}>
          <span style={labelStyle}>missionUploaded flag</span>
          <span style={{ ...valueStyle, color: missionUploaded ? ok : warn }}>
            {missionUploaded ? "true" : "false"}
          </span>
        </div>

        <div style={rowStyle}>
          <span style={labelStyle}>ArduPilot Mission Items</span>
          <span style={{ ...valueStyle, color: uploadedOk ? ok : err }}>
            {apMission ? (apMission.success ? apMission.count : "ERR") : "?"}
          </span>
        </div>

        {apMission && !apMission.success && (
          <div style={rowStyle}>
            <span style={labelStyle}>Download Error</span>
            <span style={{ ...valueStyle, color: err, fontSize: 10 }}>{apMission.error}</span>
          </div>
        )}

        <div style={{ borderTop: "1px solid #1f2937", margin: "4px 0" }} />

        <div style={rowStyle}>
          <span style={labelStyle}>MISSION_CURRENT</span>
          <span style={{ ...valueStyle, color: missionCurrent > 0 ? ok : "#6b7280" }}>
            {missionCurrent}
          </span>
        </div>

        <div style={rowStyle}>
          <span style={labelStyle}>MISSION_ITEM_REACHED</span>
          <span style={{ ...valueStyle, color: missionReached > 0 ? ok : "#6b7280" }}>
            {missionReached}
          </span>
        </div>

        <div style={rowStyle}>
          <span style={labelStyle}>Mission Running</span>
          <span style={{ ...valueStyle, color: missionRunning ? ok : "#6b7280" }}>
            {missionRunning ? "true" : "false"}
          </span>
        </div>

        <div style={rowStyle}>
          <span style={labelStyle}>Mission Completed</span>
          <span style={{ ...valueStyle, color: missionCompleted ? ok : "#6b7280" }}>
            {missionCompleted ? "true" : "false"}
          </span>
        </div>

        <div style={{ borderTop: "1px solid #1f2937", margin: "4px 0" }} />

        <div style={rowStyle}>
          <span style={labelStyle}>Armed</span>
          <span style={{ ...valueStyle, color: telemetry.armed ? ok : "#6b7280" }}>
            {telemetry.armed ? "true" : "false"}
          </span>
        </div>

        <div style={rowStyle}>
          <span style={labelStyle}>Mode</span>
          <span style={valueStyle}>{telemetry.mode}</span>
        </div>

        <div style={rowStyle}>
          <span style={labelStyle}>GPS Fix</span>
          <span style={{ ...valueStyle, color: telemetry.gpsFix >= 3 ? ok : warn }}>
            {telemetry.gpsFix}/6
          </span>
        </div>

        {apMission && apMission.items && apMission.items.length > 0 && (
          <>
            <div style={{ borderTop: "1px solid #1f2937", margin: "4px 0" }} />
            <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 2 }}>ArduPilot Mission Items:</div>
            {apMission.items.map((item) => (
              <div key={item.seq} style={rowStyle}>
                <span style={{ color: "#6b7280", fontSize: 10 }}>  [{item.seq}]</span>
                <span style={{ color: "#9ca3af", fontSize: 10 }}>
                  cmd={item.command} {item.x.toFixed(4)},{item.y.toFixed(4)} alt={item.z}
                </span>
              </div>
            ))}
          </>
        )}

      </div>

      <button
        onClick={verify}
        disabled={verifying}
        style={{
          marginTop: 6,
          width: "100%",
          padding: "4px 0",
          background: "#374151",
          border: "none",
          borderRadius: 4,
          color: "#d1d5db",
          fontSize: 10,
          cursor: "pointer",
        }}
      >
        {verifying ? "Verifying..." : "Verify Mission on ArduPilot"}
      </button>
    </div>
  );
}

export default DeveloperMissionDebugPanel;
