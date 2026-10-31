import { useEffect, useState } from "react";
import socket from "../socket/socket";

type VehicleStatus = {
  connected: boolean;
  armed: boolean;
  mode: string;
  gpsFix: number;
  satellites: number;
  systemId: number;
  componentId: number;
};

export default function VehicleStatus() {
  const [status, setStatus] = useState<VehicleStatus>({
    connected: false,
    armed: false,
    mode: "DISCONNECTED",
    gpsFix: 0,
    satellites: 0,
    systemId: 0,
    componentId: 0,
  });

  useEffect(() => {
  const handleVehicleStatus = (data: VehicleStatus) => {
    console.log("📡 VehicleStatus received:", data);

    setStatus({
      connected: data.connected,
      armed: data.armed,
      mode: data.mode,
      gpsFix: data.gpsFix,
      satellites: data.satellites,
      systemId: data.systemId,
      componentId: data.componentId,
    });
  };

  socket.on("vehicleStatus", handleVehicleStatus);

  return () => {
    socket.off("vehicleStatus", handleVehicleStatus);
  };
}, []);

useEffect(() => {
  console.log("🔄 VehicleStatus updated:", status);
}, [status]);

  return (
    <div
      style={{
        background: "#111827",
        borderRadius: "10px",
        padding: "12px",
        color: "white",
        minWidth: "240px",
      }}
    >
      <h4 style={{ marginTop: 0 }}>Vehicle Status</h4>

      <p>
        Status:
        <strong
          style={{
            color: status.connected ? "#22c55e" : "#ef4444",
            marginLeft: 8,
          }}
        >
          {status.connected ? "Connected" : "Disconnected"}
        </strong>
      </p>

      <p>Mode: {status.mode}</p>

      <p>Armed: {status.armed ? "Yes" : "No"}</p>

      <p>GPS Fix: {status.gpsFix}</p>

      <p>Satellites: {status.satellites}</p>

      <p>
        Vehicle:
        {" "}
        {status.systemId}:{status.componentId}
      </p>
    </div>
  );
}