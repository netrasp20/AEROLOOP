import { useCallback, useEffect, useRef, useState } from "react";

import {
  acceptCompassCalibration,
  cancelCompassCalibration,
  cancelCompassMot,
  getCompassCalStatus,
  getCompassConfiguration,
  getCompassMotCapability,
  getSensorStatus,
  runBaroCalibration,
  runGyroCalibration,
  runLevelCalibration,
  startCompassCalibration,
  startCompassMot,
  type CompassCalActionResponse,
  type CompassCalStatus,
  type CompassConfiguration,
  type CompassMotActionResponse,
  type CompassMotState,
  type SensorCalActionResponse,
  type SensorStatus,
} from "../api/setup";
import socket from "../socket/socket";

export interface CompassCalProgressEvent {
  compassId: number;
  calMask: number;
  status: string;
  completionPct: number;
  attempt: number;
  direction: { x: number; y: number; z: number };
}

export interface CompassCalReportEvent {
  compassId: number;
  calMask: number;
  status: string;
  autosaved: boolean;
  fitness: number;
  ofsX: number;
  ofsY: number;
  ofsZ: number;
  scaleFactor: number;
}

export interface CompassCalResultEvent {
  result: "ready-to-accept" | "success" | "failed" | "cancelled";
  message?: string;
  report?: CompassCalReportEvent;
}

export interface CompassMotStatusEvent {
  throttle?: number;
  interference?: number;
}

interface SensorCalState {
  busy: boolean;
  result: "success" | "failed" | "cancelled" | null;
  message: string | null;
}

interface UseSensorCalibrationResult {
  sensors: SensorStatus | null;
  gyro: SensorCalState;
  baro: SensorCalState;
  level: SensorCalState;
  compass: CompassCalStatus;
  compassReport: CompassCalReportEvent | null;
  compassConfig: CompassConfiguration | null;
  compassMot: CompassMotState;
  message: string | null;
  connectionLost: boolean;
  runGyro: () => Promise<void>;
  runBaro: () => Promise<void>;
  runLevel: () => Promise<void>;
  startCompass: () => Promise<void>;
  acceptCompass: () => Promise<void>;
  cancelCompass: () => Promise<void>;
  startMotorTest: () => Promise<void>;
  cancelMotorTest: () => Promise<void>;
  refresh: () => Promise<void>;
}

function idleCal(): SensorCalState {
  return { busy: false, result: null, message: null };
}

function idleCompass(): CompassCalStatus {
  return { active: false, mask: 0, status: "idle", completionPct: 0, result: null };
}

function idleCompassMot(): CompassMotState {
  return { supported: false, enabled: null, active: false, throttle: 0, interference: 0 };
}

function initialState(): SensorStatus | null {
  return null;
}

/** Sensor calibration hook: gyro/baro/level-horizon/compass + status readback.
 *
 * Watches `connected` from telemetry — when the Pixhawk link drops while a
 * calibration is running the local state is reset and `connectionLost` is
 * set, so the UI can require an explicit restart after reconnecting.
 */
export function useSensorCalibration(connected: boolean): UseSensorCalibrationResult {
  const [sensors, setSensors] = useState<SensorStatus | null>(initialState);
  const [gyro, setGyro] = useState<SensorCalState>(idleCal);
  const [baro, setBaro] = useState<SensorCalState>(idleCal);
  const [level, setLevel] = useState<SensorCalState>(idleCal);
  const [compass, setCompass] = useState<CompassCalStatus>(idleCompass);
  const [message, setMessage] = useState<string | null>(null);
  const [connectionLost, setConnectionLost] = useState(false);
  const [compassReport, setCompassReport] = useState<CompassCalReportEvent | null>(null);
  const [compassConfig, setCompassConfig] = useState<CompassConfiguration | null>(null);
  const [compassMot, setCompassMot] = useState<CompassMotState>(idleCompassMot);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const wasConnected = useRef(connected);

  useEffect(() => {
    if (!connected && wasConnected.current) {
      setConnectionLost(true);
      setGyro(idleCal());
      setBaro(idleCal());
      setLevel(idleCal());
      setCompass(idleCompass());
      setCompassMot(idleCompassMot());
      setCompassConfig(null);
      setCompassReport(null);
      setMessage("Pixhawk connection lost.");
    }
    wasConnected.current = connected;
  }, [connected]);

  const handleProgress = useCallback((event: CompassCalProgressEvent) => {
    setCompass((prev) => ({
      ...prev,
      active: true,
      status: event.status,
      completionPct: event.completionPct,
      result: null,
    }));
  }, []);

  const handleCompassReport = useCallback((event: CompassCalReportEvent) => {
    setCompass((prev) => ({ ...prev, active: true, status: "success", result: null }));
    setCompassReport(event);
  }, []);

  const handleResult = useCallback((event: CompassCalResultEvent) => {
    setCompass((prev) => {
      if (event.result === "ready-to-accept") {
        return { ...prev, active: true, status: "success", completionPct: 100, result: null };
      }
      if (event.result === "cancelled") {
        setCompassReport(null);
        return idleCompass();
      }
      return { ...prev, active: false, status: prev.status, completionPct: prev.completionPct, result: event.result };
    });
    if (event.result === "success") {
      setMessage(null);
    }
  }, []);

  const handleCompassMotStatus = useCallback((event: CompassMotStatusEvent) => {
    setCompassMot((prev) => ({
      ...prev,
      active: true,
      throttle: event.throttle ?? prev.throttle,
      interference: event.interference ?? prev.interference,
    }));
  }, []);

  const handleCompassMotResult = useCallback(() => {
    setCompassMot((prev) => ({
      ...prev,
      active: false,
      throttle: 0,
      interference: 0,
    }));
  }, []);

  const refresh = useCallback(async () => {
    if (!connected) {
      setSensors(initialState());
      setCompass(idleCompass());
      setCompassMot(idleCompassMot());
      setCompassConfig(null);
      setCompassReport(null);
      return;
    }
    try {
      setSensors(await getSensorStatus());
    } catch {
      // Status unavailable; keep the last known view.
    }
    try {
      setCompass(await getCompassCalStatus());
    } catch {
      // Compass status unavailable; keep the current view.
    }
    try {
      setCompassConfig(await getCompassConfiguration());
    } catch {
      // Compass configuration unavailable; keep the current view.
    }
    try {
      const capability = await getCompassMotCapability();
      setCompassMot((prev) => ({ ...prev, ...capability }));
    } catch {
      // CompassMot capability unavailable; keep the current view.
    }
  }, [connected]);

  const run = useCallback(
    async (key: string, api: () => Promise<SensorCalActionResponse>, setter: (s: SensorCalState) => void) => {
      if (busyKey !== null || !connected) return;
      setBusyKey(key);
      setMessage(null);
      setter({ busy: true, result: null, message: null });
      try {
        const result = await api();
        setter({ busy: false, result: result.success ? "success" : "failed", message: result.message });
      } catch (err) {
        setter({
          busy: false,
          result: "failed",
          message: err instanceof Error ? err.message : "Calibration failed.",
        });
      } finally {
        setBusyKey(null);
      }
    },
    [busyKey, connected],
  );

  const runGyro = useCallback(
    () => run("gyro", runGyroCalibration, setGyro),
    [run],
  );

  const runBaro = useCallback(
    () => run("baro", runBaroCalibration, setBaro),
    [run],
  );

  const runLevel = useCallback(
    () => run("level", runLevelCalibration, setLevel),
    [run],
  );

  const startCompass2 = useCallback(async () => {
    if (busyKey !== null || !connected) return;
    setBusyKey("compass");
    setMessage(null);
    setCompass((prev) => ({ ...prev, active: true, status: "waiting-to-start", completionPct: 0, result: null }));
    try {
      const result: CompassCalActionResponse = await startCompassCalibration();
      if (!result.success) {
        setCompass(idleCompass());
        setMessage(result.message || "Compass calibration could not be started.");
      }
    } catch (err) {
      setCompass(idleCompass());
      setMessage(err instanceof Error ? err.message : "Compass calibration start failed.");
    } finally {
      setBusyKey(null);
    }
  }, [busyKey, connected]);

  const acceptCompass2 = useCallback(async () => {
    if (busyKey !== null || !connected || !compass.active) return;
    setBusyKey("compass-accept");
    try {
      const result: CompassCalActionResponse = await acceptCompassCalibration();
      if (!result.success) {
        setMessage(result.message || "Compass calibration could not be accepted.");
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Accept compass calibration failed.");
    } finally {
      setBusyKey(null);
    }
  }, [busyKey, connected, compass.active]);

  const cancelCompass2 = useCallback(async () => {
    if (busyKey !== null || !connected) return;
    setBusyKey("compass-cancel");
    try {
      const result: CompassCalActionResponse = await cancelCompassCalibration();
      if (result.success) {
        setCompass(idleCompass());
        setCompassReport(null);
      } else {
        setMessage(result.message || "Compass calibration could not be cancelled.");
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Compass calibration cancel failed.");
    } finally {
      setBusyKey(null);
    }
  }, [busyKey, connected]);

  const startMotorTest = useCallback(async () => {
    if (busyKey !== null || !connected || compassMot.active) return;
    setBusyKey("compassmot");
    setMessage(null);
    setCompassMot((prev) => ({ ...prev, active: true, throttle: 0, interference: 0 }));
    try {
      const result: CompassMotActionResponse = await startCompassMot();
      if (!result.success) {
        setCompassMot((prev) => ({ ...prev, active: false }));
        setMessage(result.message || "Compass motor test could not be started.");
      }
    } catch (err) {
      setCompassMot((prev) => ({ ...prev, active: false }));
      setMessage(err instanceof Error ? err.message : "Compass motor test start failed.");
    } finally {
      setBusyKey(null);
    }
  }, [busyKey, connected, compassMot.active]);

  const cancelMotorTest = useCallback(async () => {
    if (busyKey !== null || !connected) return;
    setBusyKey("compassmot-cancel");
    try {
      const result: CompassMotActionResponse = await cancelCompassMot();
      if (result.success) {
        setCompassMot((prev) => ({ ...prev, active: false, throttle: 0, interference: 0 }));
      } else {
        setMessage(result.message || "Compass motor test could not be stopped.");
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Compass motor test cancel failed.");
    } finally {
      setBusyKey(null);
    }
  }, [busyKey, connected]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    socket.on("compass_cal:progress", handleProgress);
    socket.on("compass_cal:report", handleCompassReport);
    socket.on("compass_cal:result", handleResult);
    socket.on("compassmot:status", handleCompassMotStatus);
    socket.on("compassmot:result", handleCompassMotResult);
    return () => {
      socket.off("compass_cal:progress", handleProgress);
      socket.off("compass_cal:report", handleCompassReport);
      socket.off("compass_cal:result", handleResult);
      socket.off("compassmot:status", handleCompassMotStatus);
      socket.off("compassmot:result", handleCompassMotResult);
    };
  }, [handleProgress, handleCompassReport, handleResult, handleCompassMotStatus, handleCompassMotResult]);

  return {
    sensors,
    gyro,
    baro,
    level,
    compass,
    compassReport,
    compassConfig,
    compassMot,
    message,
    connectionLost,
    runGyro,
    runBaro,
    runLevel,
    startCompass: startCompass2,
    acceptCompass: acceptCompass2,
    cancelCompass: cancelCompass2,
    startMotorTest,
    cancelMotorTest,
    refresh,
  };
}