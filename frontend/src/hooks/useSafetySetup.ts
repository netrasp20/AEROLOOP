import { useCallback, useEffect, useRef, useState } from "react";

import { getSafetyInfo, type SafetyStatusPayload } from "../api/setup";
import socket from "../socket/socket";

interface UseSafetySetupResult {
  safety: SafetyStatusPayload | null;
  connectionLost: boolean;
  lastUpdated: number | null;
  refresh: () => Promise<void>;
}

/**
 * Safety page data: the authoritative /api/setup/safety snapshot, derived
 * exclusively from real vehicle parameters — every value is the vehicle's own.
 *
 * The `parameter:updated` Socket.IO event (emitted by the backend whenever a
 * parameter's authoritative value changes — from the Parameter page, Power
 * page, back-end, or the vehicle itself) coalesces into a refresh so the
 * Safety page follows external changes without a reload.
 *
 * When the MAVLink link drops the snapshot is cleared immediately so stale
 * safety values are never presented as current. On reconnect the next refresh
 * restores the page from the vehicle.
 */
export function useSafetySetup(connected: boolean): UseSafetySetupResult {
  const [safety, setSafety] = useState<SafetyStatusPayload | null>(null);
  const [connectionLost, setConnectionLost] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);

  const wasConnected = useRef(connected);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!connected && wasConnected.current) {
      setConnectionLost(true);
      setSafety(null);
    }
    wasConnected.current = connected;
  }, [connected]);

  const refresh = useCallback(async () => {
    if (!connected) {
      setSafety(null);
      return;
    }
    try {
      const status = await getSafetyInfo();
      setSafety(status);
      setLastUpdated(Date.now());
    } catch {
      // Safety information unavailable; keep the last known view.
    }
  }, [connected]);

  useEffect(() => {
    void refresh();
  }, [refresh, connected]);

  // Parameter updates can arrive in bursts (downloads, batch writes); coalesce.
  const onParamUpdated = useCallback(() => {
    if (refreshTimer.current) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      void refresh();
    }, 700);
  }, [refresh]);

  useEffect(() => {
    socket.on("parameter:updated", onParamUpdated);
    return () => {
      socket.off("parameter:updated", onParamUpdated);
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [onParamUpdated]);

  return { safety, connectionLost, lastUpdated, refresh };
}