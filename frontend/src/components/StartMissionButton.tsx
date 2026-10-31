import { useState, useCallback, useEffect, useRef } from "react";
import { useTelemetry } from "../providers/TelemetryProvider";
import { useMissionContext } from "../context/MissionContext";
import socket from "../socket/socket";

function StartMissionButton() {
  const telemetry = useTelemetry();
  const { waypoints } = useMissionContext();
  const [starting, setStarting] = useState(false);
  const [stepText, setStepText] = useState("");
  const [rtlState, setRtlState] = useState<{
    active: boolean;
    message: string;
    distanceM: number;
  }>({ active: false, message: "", distanceM: 0 });
  const [popup, setPopup] = useState<{
    type: "success" | "error" | "completed";
    title: string;
    message: string;
    stats?: {
      elapsedMs: number;
      totalDistance: number;
      avgSpeed: number;
      maxSpeed: number;
      waypointsVisited: number;
    };
  } | null>(null);
  const startingRef = useRef(false);
  const completedRef = useRef(false);
  const popupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const missionRunning = telemetry.missionRunning;
  const missionUploaded = telemetry.missionUploaded;
  const missionCompleted = telemetry.missionCompleted;
  const atHome = telemetry.atHome;

  useEffect(() => {
    function onProgress(data: { step: string; message: string }) {
      setStepText(data.message);
    }
    function onSuccess(_data: { message: string }) {
      startingRef.current = false;
      setStarting(false);
      setStepText("");
      completedRef.current = false;
    }
    function onError(data: { message: string; step?: string }) {
      startingRef.current = false;
      setStarting(false);
      setStepText("");
      setPopup({
        type: "error",
        title: "❌ Mission Start Failed",
        message: data.message,
      });
    }
    function onCompleted(data: {
      startTime: number;
      endTime: number;
      elapsedMs: number;
      totalDistance: number;
      avgSpeed: number;
      maxSpeed: number;
      waypointsVisited: number;
      status: string;
    }) {
      startingRef.current = false;
      setStarting(false);
      setStepText("");
      completedRef.current = false;
      setPopup({
        type: "completed",
        title: "✅ Mission Completed Successfully",
        message: `All waypoints reached.`,
        stats: data,
      });
    }
    function onRtlProgress(data: {
      step: string;
      message: string;
      distanceM?: number;
      auto?: boolean;
    }) {
      setRtlState({
        active: true,
        message: data.message || "Returning to home...",
        distanceM: data.distanceM ?? 0,
      });
      setStepText(data.message || "Returning to home...");
    }
    function onRtlSuccess(data: { message: string; distanceM?: number }) {
      setRtlState({
        active: false,
        message: data.message || "Rover is at home.",
        distanceM: data.distanceM ?? 0,
      });
      setStepText("");
    }
    function onRtlError(data: { message: string }) {
      setRtlState({
        active: false,
        message: data.message || "Return to launch failed.",
        distanceM: 0,
      });
      setStepText("");
    }
    socket.on("mission:auto:progress", onProgress);
    socket.on("mission:auto:success", onSuccess);
    socket.on("mission:auto:error", onError);
    socket.on("mission:completed", onCompleted);
    socket.on("mission:rtl:progress", onRtlProgress);
    socket.on("mission:rtl:success", onRtlSuccess);
    socket.on("mission:rtl:error", onRtlError);
    return () => {
      socket.off("mission:auto:progress", onProgress);
      socket.off("mission:auto:success", onSuccess);
      socket.off("mission:auto:error", onError);
      socket.off("mission:completed", onCompleted);
      socket.off("mission:rtl:progress", onRtlProgress);
      socket.off("mission:rtl:success", onRtlSuccess);
      socket.off("mission:rtl:error", onRtlError);
    };
  }, []);

  useEffect(() => {
    if (missionRunning) {
      completedRef.current = false;
    }
  }, [missionRunning]);

  const handleStart = useCallback(() => {
    if (startingRef.current) return;
    startingRef.current = true;
    setStarting(true);
    setStepText("Checking vehicle connection...");
    setPopup(null);
    socket.emit("mission:start:auto");
  }, []);

  const dismissPopup = useCallback(() => {
    if (popupTimerRef.current) {
      clearTimeout(popupTimerRef.current);
      popupTimerRef.current = null;
    }
    setPopup(null);
  }, []);

  /* Auto-dismiss the mission-completed popup after 5 seconds so the operator
     doesn't have to click OK. The manual OK button still closes it instantly,
     and clicking it (or any popup change) cancels this timer. */
  useEffect(() => {
    if (!popup || popup.type !== "completed") return;
    popupTimerRef.current = setTimeout(() => {
      setPopup(null);
    }, 5000);
    return () => {
      if (popupTimerRef.current) {
        clearTimeout(popupTimerRef.current);
        popupTimerRef.current = null;
      }
    };
  }, [popup]);

  const canStart =
    telemetry.connected &&
    missionUploaded &&
    !startingRef.current &&
    !rtlState.active &&
    !missionRunning &&
    !missionCompleted &&
    atHome;

  const isReady =
    telemetry.connected && missionUploaded && !missionRunning && !missionCompleted;

  const isCompleted = missionCompleted;

  const buttonText = (() => {
    if (starting) {
      return <>{stepText}</>;
    }
    if (missionRunning) {
      return "▶ MISSION RUNNING";
    }
    if (rtlState.active) {
      return <>↩ {rtlState.message}</>;
    }
    if (!atHome && isReady) {
      return <>↩ RETURNING HOME — {telemetry.distanceToHome.toFixed(0)}m</>;
    }
    if (isCompleted && missionUploaded) {
      return "✓ MISSION COMPLETED";
    }
    return "► START MISSION";
  })();

  return (
    <>
      {popup && (
        <div className="modal-overlay" onClick={dismissPopup}>
          <div
            className="modal-content upload-popup-modal mission-complete-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="upload-popup-icon">
              <div
                className={
                  popup.type === "success" || popup.type === "completed"
                    ? "upload-popup-check"
                    : "upload-popup-cross"
                }
              >
                {popup.type === "success" || popup.type === "completed" ? "✓" : "✕"}
              </div>
            </div>
            <div className="upload-popup-title">{popup.title}</div>
            <div className="upload-popup-message">{popup.message}</div>

            {popup.stats && (
              <div className="mission-complete-stats">
                <div className="mission-complete-stat">
                  <span className="mission-complete-stat-label">Distance</span>
                  <span className="mission-complete-stat-value">{popup.stats.totalDistance.toFixed(0)} m</span>
                </div>
                <div className="mission-complete-stat">
                  <span className="mission-complete-stat-label">Avg Speed</span>
                  <span className="mission-complete-stat-value">{popup.stats.avgSpeed.toFixed(1)} m/s</span>
                </div>
                <div className="mission-complete-stat">
                  <span className="mission-complete-stat-label">Max Speed</span>
                  <span className="mission-complete-stat-value">{popup.stats.maxSpeed.toFixed(1)} m/s</span>
                </div>
                <div className="mission-complete-stat">
                  <span className="mission-complete-stat-label">Waypoints</span>
                  <span className="mission-complete-stat-value">{waypoints.length}</span>
                </div>
                <div className="mission-complete-stat">
                  <span className="mission-complete-stat-label">Duration</span>
                  <span className="mission-complete-stat-value">{(popup.stats.elapsedMs / 1000).toFixed(0)}s</span>
                </div>
              </div>
            )}

            {popup.type !== "completed" && (
              <button className="upload-popup-btn" onClick={dismissPopup}>
                OK
              </button>
            )}
          </div>
        </div>
      )}

      <div className="start-mission-section">
        <button
          className="start-mission-btn"
          onClick={handleStart}
          disabled={!canStart}
          title={
            !telemetry.connected
              ? "Vehicle not connected"
              : !missionUploaded
                ? "Please upload a mission first"
                : missionRunning
                  ? "Mission is running"
                  : starting
                    ? "Starting mission..."
                    : !atHome
                      ? "Rover is away from HOME — mission starts from HOME (RTL)"
                      : "Start autonomous mission"
          }
        >
          {starting && <span className="start-mission-spinner" />}
          {buttonText}
        </button>
        {isReady && !missionRunning && (
          <div className="start-mission-state">
            {rtlState.active
              ? rtlState.message
              : atHome
                ? "Mission Ready"
                : `Returning to home... ${telemetry.distanceToHome.toFixed(0)}m`}
          </div>
        )}
      </div>
    </>
  );
}

export default StartMissionButton;
