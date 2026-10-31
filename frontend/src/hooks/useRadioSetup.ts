import { useCallback, useEffect, useRef, useState } from "react";

import {
  cancelRadioCalibration,
  captureRadioPhase,
  getRadioCalibrationStatus,
  getRadioStatus,
  startRadioCalibration,
  type RadioActionResponse,
  type RadioCalibrationStatus,
  type RadioStatus,
} from "../api/setup";
import socket from "../socket/socket";

export interface RadioCalibrationProgressEvent {
  state?: string;
  stage?: string;
  message?: string;
  phase?: string | null;
  progress?: {
    phase?: string;
    frames?: number;
    channels?: Record<string, unknown>;
  } | null;
}

interface UseRadioSetupResult {
  radio: RadioStatus | null;
  calibration: RadioCalibrationStatus;
  message: string | null;
  busy: boolean;
  connectionLost: boolean;
  lastUpdated: number | null;
  refresh: () => Promise<void>;
  beginCalibration: () => Promise<void>;
  capture: (phase: string) => Promise<void>;
  cancelCalibration: () => Promise<void>;
}

function idleCalibration(): RadioCalibrationStatus {
  return {
    state: "idle",
    stage: "IDLE",
    message: "",
    phase: null,
    progress: null,
    result: null,
  };
}

/**
 * Radio page data: the authoritative /api/setup/radio snapshot plus the live
 * calibration wizard state. The channel bars themselves are NOT polled here —
 * they come from the real `telemetry.rcChannels` stream via useTelemetry.
 *
 * When the MAVLink link drops mid-calibration the local state is reset and
 * `connectionLost` is set so the UI requires an explicit restart after
 * reconnecting (same contract as the sensor calibration hook).
 */
export function useRadioSetup(connected: boolean): UseRadioSetupResult {
  const [radio, setRadio] = useState<RadioStatus | null>(null);
  const [calibration, setCalibration] = useState<RadioCalibrationStatus>(idleCalibration);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [connectionLost, setConnectionLost] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);

  const wasConnected = useRef(connected);

  useEffect(() => {
    if (!connected && wasConnected.current) {
      setConnectionLost(true);
      setRadio(null);
      setCalibration(idleCalibration());
      setMessage("MAVLink connection lost — RC telemetry unavailable.");
    }
    wasConnected.current = connected;
  }, [connected]);

  const finishAction = useCallback((result: RadioActionResponse) => {
    if (!result.success) {
      setMessage(result.message || "Radio operation failed.");
      return;
    }
    if (result.state || result.stage) {
      setCalibration((prev) => ({
        ...prev,
        ...(result.state ? { state: result.state } : {}),
        ...(result.stage ? { stage: result.stage } : {}),
      }));
    }
    setMessage(result.message || null);
  }, []);

  const refresh = useCallback(async () => {
    if (!connected) {
      setRadio(null);
      setCalibration(idleCalibration());
      return;
    }
    try {
      const status = await getRadioStatus();
      setRadio(status);
      setLastUpdated(Date.now());
      setCalibration(status.calibration ?? idleCalibration());
    } catch {
      // Radio status unavailable; keep the last known view.
    }
  }, [connected]);

  useEffect(() => {
    void refresh();
  }, [refresh, connected]);

  const handleProgress = useCallback((event: RadioCalibrationProgressEvent) => {
    setCalibration((prev) => ({
      ...prev,
      state: (event.state as RadioCalibrationStatus["state"]) ?? prev.state,
      stage: (event.stage as RadioCalibrationStatus["stage"]) ?? prev.stage,
      message: event.message ?? prev.message,
      phase: event.phase ?? prev.phase,
      progress: event.progress ?? prev.progress,
    }));
  }, []);

  useEffect(() => {
    socket.on("radio:calibration:progress", handleProgress);
    return () => {
      socket.off("radio:calibration:progress", handleProgress);
    };
  }, [handleProgress]);

  const beginCalibration = useCallback(async () => {
    setBusy(true);
    try {
      finishAction(await startRadioCalibration());
    } catch {
      setMessage("Could not start radio calibration.");
    } finally {
      setBusy(false);
    }
  }, [finishAction]);

  const capture = useCallback(
    async (phase: string) => {
      setBusy(true);
      try {
        finishAction(await captureRadioPhase(phase));
        const fresh = await getRadioCalibrationStatus();
        setCalibration(fresh);
      } catch {
        setMessage("Could not run the radio capture.");
      } finally {
        setBusy(false);
      }
    },
    [finishAction],
  );

  const cancelCalibration = useCallback(async () => {
    setBusy(true);
    try {
      finishAction(await cancelRadioCalibration());
      const fresh = await getRadioCalibrationStatus();
      setCalibration(fresh);
    } catch {
      setMessage("Could not cancel radio calibration.");
    } finally {
      setBusy(false);
    }
  }, [finishAction]);

  return {
    radio,
    calibration,
    message,
    busy,
    connectionLost,
    lastUpdated,
    refresh,
    beginCalibration,
    capture,
    cancelCalibration,
  };
}