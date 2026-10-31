import { useEffect, useRef, useState } from "react";

import { getSetupSummary, type SetupSummaryData } from "../api/setup";
import socket from "../socket/socket";

interface UseSetupSummaryResult {
  /** Latest summary (null when disabled or nothing fetched yet). */
  summary: SetupSummaryData | null;
  loading: boolean;
}

const EMPTY: SetupSummaryData = {
  success: false,
  connected: false,
  sync: { state: "idle", expectedCount: 0, receivedCount: 0, cachedEntries: 0 },
  items: [],
  counts: { good: 0, warn: 0, unsupported: 0, unknown: 0, waiting: 0 },
};

/**
 * Events that imply the configuration health matrix changed and must be
 * re-read immediately instead of waiting for the next 5 s poll.
 */
const REFRESH_EVENTS = [
  "parameter:sync:progress",
  "parameter:sync:complete",
  "parameter:updated",
  "parameter:write:success",
  "accel_cal:result",
  "compass_cal:result",
];

/**
 * Keep the Setup Summary current. While `enabled` it polls the backend every
 * `intervalMs`, and additionally forces an immediate refresh whenever a socket
 * event signals the underlying vehicle state changed (parameter writes, sync
 * progress, calibration results). Clears all state the moment `enabled` flips
 * false so a disconnect can never leave stale configuration status on screen
 * (reconnect re-fetches everything).
 */
export function useSetupSummary(enabled: boolean, intervalMs = 5000): UseSetupSummaryResult {
  const [summary, setSummary] = useState<SetupSummaryData | null>(null);
  const [loading, setLoading] = useState(false);
  const loadRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!enabled) {
      setSummary(null);
      setLoading(false);
      loadRef.current = null;
      return;
    }

    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const data = await getSetupSummary();
        if (!cancelled) setSummary(data);
      } catch {
        if (!cancelled) setSummary(EMPTY);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    loadRef.current = load;

    load();
    const timer = setInterval(load, intervalMs);

    const refresh = () => {
      if (loadRef.current && !cancelled) loadRef.current();
    };
    for (const event of REFRESH_EVENTS) {
      socket.on(event, refresh);
    }

    return () => {
      cancelled = true;
      clearInterval(timer);
      loadRef.current = null;
      for (const event of REFRESH_EVENTS) {
        socket.off(event, refresh);
      }
    };
  }, [enabled, intervalMs]);

  return { summary, loading };
}