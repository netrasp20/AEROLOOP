import { useState, useEffect, useCallback, useRef } from "react";
import socket from "../socket/socket";
import { useTelemetry } from "../providers/TelemetryProvider";

import type { MissionStartResult } from "../types/mission";

export function useMissionStart(totalWaypoints: number = 0) {
  const telemetry = useTelemetry();

  const [running, setRunning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startResult, setStartResult] = useState<MissionStartResult | null>(null);
  const [popupMessage, setPopupMessage] = useState<{
    type: "success" | "error" | "completed";
    title: string;
    message: string;
  } | null>(null);

  const completedRef = useRef(false);

  /* Socket events for start / failure */
  useEffect(() => {
    function onStartSuccess(data: { message: string }) {
      setStarting(false);
      setRunning(true);
      setStartResult({ success: true, message: data.message });
      setPopupMessage({
        type: "success",
        title: "✅ Mission Started Successfully",
        message: "Vehicle has started executing the uploaded mission.",
      });
      completedRef.current = false;
    }

    function onStartError(data: { message: string; ackCode?: number; ackLabel?: string }) {
      setStarting(false);
      setRunning(false);
      setStartResult({ success: false, message: data.message, ackCode: data.ackCode, ackLabel: data.ackLabel });
      setPopupMessage({
        type: "error",
        title: "❌ Mission Start Failed",
        message: data.ackLabel
          ? `Reason: ${data.ackLabel}`
          : data.message,
      });
    }

    socket.on("mission:start:success", onStartSuccess);
    socket.on("mission:start:error", onStartError);

    return () => {
      socket.off("mission:start:success", onStartSuccess);
      socket.off("mission:start:error", onStartError);
    };
  }, []);

  /* Detect mission completion — only from backend telemetry.
     The backend sets missionCompleted=true only AFTER the rover reaches the
     last waypoint AND auto-RTLs back to HOME, so the "completed" popup appears
     once the full mission (outbound + return) has finished. */
  useEffect(() => {
    if (!running) return;
    if (completedRef.current) return;

    if (telemetry.missionCompleted) {
      completedRef.current = true;
      setRunning(false);
      setPopupMessage({
        type: "completed",
        title: "✅ Mission Completed Successfully",
        message: `Mission has completed.`,
      });
    }
  }, [telemetry.missionReached, telemetry.missionCurrent, telemetry.missionCompleted, running, totalWaypoints]);

  const start = useCallback(() => {
    if (starting || running) return;
    setStarting(true);
    setStartResult(null);
    setPopupMessage(null);
    completedRef.current = false;
    socket.emit("mission:start");
  }, [starting, running]);

  const dismissPopup = useCallback(() => {
    setPopupMessage(null);
  }, []);

  /*
   * START MISSION button enable logic — derived entirely from real telemetry.
   * The button is only clickable when the Pixhawk confirms ALL four conditions
   * via MAVLink (heartbeat / vehicleStatus).
   */
  const canStart =
    telemetry.connected &&
    telemetry.missionUploaded &&
    telemetry.armed &&
    telemetry.mode === "AUTO";

  const execState = running
    ? completedRef.current
      ? "MISSION_COMPLETED"
      : "MISSION_RUNNING"
    : "MISSION_CREATED";

  return {
    execState,
    running,
    starting,
    startResult,
    popupMessage,
    canStart,
    start,
    dismissPopup,
  };
}
