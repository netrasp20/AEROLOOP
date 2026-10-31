import { useCallback, useEffect, useRef, useState } from "react";

import {
  cancelAccelCalibration,
  confirmAccelPosition,
  getAccelCalStatus,
  startAccelCalibration,
  type AccelCalActionResponse,
  type AccelCalStartResponse,
  type AccelCalStatus,
} from "../api/setup";
import socket from "../socket/socket";

export interface AccelCalPositionEvent {
  position: number;
  label: string;
  order: number;
  total: number;
}

export interface AccelCalResultEvent {
  result: "success" | "failed" | "cancelled";
}

interface UseAccelCalibrationResult {
  status: AccelCalStatus;
  busy: boolean;
  message: string | null;
  start: () => Promise<void>;
  confirm: () => Promise<void>;
  cancel: () => Promise<void>;
  refresh: () => Promise<void>;
}

function initialState(): AccelCalStatus {
  return {
    active: false,
    step: null,
    label: "",
    order: 0,
    total: 6,
    result: null,
  };
}

/** Wizard state for the interactive 6-position accelerometer calibration. */
export function useAccelCalibration(enabled: boolean): UseAccelCalibrationResult {
  const [status, setStatus] = useState<AccelCalStatus>(initialState);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const wasEnabled = useRef(enabled);

  useEffect(() => {
    if (!enabled && wasEnabled.current && status.active) {
      setStatus(initialState());
      setMessage("Calibration stopped: vehicle connection lost.");
    }
    wasEnabled.current = enabled;
  }, [enabled, status.active]);

  const handlePosition = useCallback((event: AccelCalPositionEvent) => {
    setStatus((prev) => ({
      ...prev,
      active: true,
      step: event.position,
      label: event.label,
      order: event.order,
      total: event.total,
      result: null,
    }));
    setMessage(null);
  }, []);

  const handleResult = useCallback((event: AccelCalResultEvent) => {
    setStatus((prev) => ({ ...prev, active: false, result: event.result }));
  }, []);

  const refresh = useCallback(async () => {
    if (!enabled) {
      setStatus(initialState());
      return;
    }
    try {
      const current = await getAccelCalStatus();
      setStatus(current);
    } catch {
      // Wizard status unavailable; keep the current view.
    }
  }, [enabled]);

  const start = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result: AccelCalStartResponse = await startAccelCalibration();
      if (!result.success) {
        setMessage(result.message || "Calibration could not be started.");
        return;
      }
      setStatus({
        active: true,
        step: result.step,
        label: result.label,
        order: result.order,
        total: result.total,
        result: null,
      });
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Calibration start failed.");
    } finally {
      setBusy(false);
    }
  }, []);

  const confirm = useCallback(async () => {
    if (status.step === null) return;
    setBusy(true);
    setMessage(null);
    try {
      const result: AccelCalActionResponse = await confirmAccelPosition(status.step);
      if (!result.success) {
        setMessage(result.message || "Position not accepted.");
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Position confirm failed.");
    } finally {
      setBusy(false);
    }
  }, [status.step]);

  const cancel = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result: AccelCalActionResponse = await cancelAccelCalibration();
      if (result.success) {
        setStatus(initialState());
      } else {
        setMessage(result.message || "Calibration could not be cancelled.");
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Calibration cancel failed.");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    socket.on("accel_cal:position", handlePosition);
    socket.on("accel_cal:result", handleResult);
    return () => {
      socket.off("accel_cal:position", handlePosition);
      socket.off("accel_cal:result", handleResult);
    };
  }, [handlePosition, handleResult]);

  return { status, busy, message, start, confirm, cancel, refresh };
}