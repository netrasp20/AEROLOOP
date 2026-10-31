import { useEffect, useState } from "react";
import socket from "../socket/socket";

export interface Telemetry {
  mode: string;
  armed: boolean;
  vehicleType: string;

  altitude: number;
  groundSpeed: number;
  heading: number;

  battery: number;
  satellites: number;

  distance: number;

  pitch: number;
  roll: number;
  yaw: number;

  fenceBreachStatus?: number;
  fenceBreachCount?: number;
  fenceBreachType?: number;
}

export default function useSocketTelemetry() {
  const [telemetry, setTelemetry] =
    useState<Telemetry | null>(null);

  useEffect(() => {
    socket.on("telemetry", (data: Telemetry) => {
      setTelemetry(data);
    });

    return () => {
      socket.off("telemetry");
    };
  }, []);

  return telemetry;
}