import { useCallback, useEffect, useState } from "react";

import {
  getMotorReverseStates,
  getMotorTestStatus,
  setMotorReverse,
  startMotorTest,
  stopMotorTest,
  type MotorReverseState,
  type MotorTestStatus,
} from "../api/setup";
import socket from "../socket/socket";

export interface MotorTestActionResult {
  ok: boolean;
  message: string;
}

/**
 * SITL-gated motor test and reverse-direction configuration.
 *
 * The backend is the single source of truth for motor test state. A slider
 * value is never treated as proof that a motor started: the authoritative
 * `state` returned by the API, plus the `motor:test` Socket.IO event, drive
 * the UI.
 *
 * This hook is intentionally NOT mounted by the frozen Motors page. Wiring it
 * in adds live requests to a page that is currently a pure visual
 * composition, which is a UI change requiring explicit approval.
 */
export function useMotorTest(connected: boolean) {
  const [testStatus, setTestStatus] = useState<MotorTestStatus | null>(null);
  const [reverseStates, setReverseStates] = useState<MotorReverseState[]>([]);
  const [busy, setBusy] = useState(false);

  const loadTestStatus = useCallback(async () => {
    try {
      setTestStatus(await getMotorTestStatus());
    } catch {
      // Keep the last known status on transient request failures.
    }
  }, []);

  const loadReverseStates = useCallback(async () => {
    try {
      setReverseStates((await getMotorReverseStates()).outputs ?? []);
    } catch {
      // Reverse configuration is optional; leave the last known values.
    }
  }, []);

  const refresh = useCallback(async () => {
    await Promise.all([loadTestStatus(), loadReverseStates()]);
  }, [loadTestStatus, loadReverseStates]);

  useEffect(() => {
    if (!connected) {
      setTestStatus(null);
      setReverseStates([]);
      return;
    }
    void loadTestStatus();
    void loadReverseStates();
  }, [connected, loadTestStatus, loadReverseStates]);

  // Authoritative motor test state pushed by the backend.
  useEffect(() => {
    const onMotorTest = (data: MotorTestStatus) => {
      if (data && typeof data === "object") setTestStatus(data);
    };
    const onParameterUpdated = () => void loadReverseStates();

    socket.on("motor:test", onMotorTest);
    socket.on("parameter:updated", onParameterUpdated);
    return () => {
      socket.off("motor:test", onMotorTest);
      socket.off("parameter:updated", onParameterUpdated);
    };
  }, [loadReverseStates]);

  const startTest = useCallback(
    async (motor: number, throttlePct?: number, timeoutS?: number): Promise<MotorTestActionResult> => {
      setBusy(true);
      try {
        const status = await startMotorTest(motor, throttlePct, timeoutS);
        setTestStatus(status);
        return { ok: Boolean(status.success), message: status.message ?? status.lastResult?.message ?? "" };
      } catch (err) {
        // Never infer a result locally; re-read the authoritative state.
        await loadTestStatus();
        return { ok: false, message: err instanceof Error ? err.message : "Request failed." };
      } finally {
        setBusy(false);
      }
    },
    [loadTestStatus],
  );

  const stopTest = useCallback(async (): Promise<MotorTestActionResult> => {
    setBusy(true);
    try {
      const status = await stopMotorTest();
      setTestStatus(status);
      return { ok: Boolean(status.success), message: status.message ?? "Motor test stopped." };
    } catch (err) {
      await loadTestStatus();
      return { ok: false, message: err instanceof Error ? err.message : "Request failed." };
    } finally {
      setBusy(false);
    }
  }, [loadTestStatus]);

  const setReverse = useCallback(
    async (motor: number, reversed: boolean): Promise<MotorTestActionResult> => {
      setBusy(true);
      try {
        const status = await setMotorReverse(motor, reversed);
        await loadReverseStates();
        return { ok: Boolean(status.success), message: status.message ?? "" };
      } catch (err) {
        await loadReverseStates();
        return { ok: false, message: err instanceof Error ? err.message : "Request failed." };
      } finally {
        setBusy(false);
      }
    },
    [loadReverseStates],
  );

  return {
    testStatus,
    reverseStates,
    busy,
    refresh,
    startTest,
    stopTest,
    setReverse,
  };
}
