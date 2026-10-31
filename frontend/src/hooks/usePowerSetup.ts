import { useCallback, useEffect, useRef, useState } from "react";

import { getPowerInfo, type PowerStatus } from "../api/setup";
import socket from "../socket/socket";

export interface PowerBatteryUpdateEvent {
  batteries?: unknown[];
  timestamp?: number;
}

interface UsePowerSetupResult {
  power: PowerStatus | null;
  connectionLost: boolean;
  lastUpdated: number | null;
  refresh: () => Promise<void>;
}

/**
 * Power page data: the authoritative /api/setup/power snapshot. Live battery
 * numbers (voltage/current/consumed/remaining/temperature) come from the
 * snapshot's instance telemetry, which the backend derives exclusively from
 * real SYS_STATUS / BATTERY_STATUS frames — never fabricated.
 *
 * The `battery:update` Socket.IO event (emitted by the backend on every real
 * battery frame and on reset) triggers a refresh so the status card follows
 * the vehicle live, without a page reload.
 *
 * When the MAVLink link drops the snapshot is cleared immediately so stale
 * battery values are never presented as current.
 */
export function usePowerSetup(connected: boolean): UsePowerSetupResult {
  const [power, setPower] = useState<PowerStatus | null>(null);
  const [connectionLost, setConnectionLost] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);

  const wasConnected = useRef(connected);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!connected && wasConnected.current) {
      setConnectionLost(true);
      setPower(null);
    }
    wasConnected.current = connected;
  }, [connected]);

  const refresh = useCallback(async () => {
    if (!connected) {
      setPower(null);
      return;
    }
    try {
      const status = await getPowerInfo();
      setPower(status);
      setLastUpdated(Date.now());
    } catch {
      // Power information unavailable; keep the last known view.
    }
  }, [connected]);

  useEffect(() => {
    void refresh();
  }, [refresh, connected]);

  // Battery frames arrive several times a second; coalesce to one refresh.
  const onBatteryUpdate = useCallback(() => {
    if (refreshTimer.current) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      void refresh();
    }, 700);
  }, [refresh]);

  useEffect(() => {
    socket.on("battery:update", onBatteryUpdate);
    return () => {
      socket.off("battery:update", onBatteryUpdate);
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [onBatteryUpdate]);

  return { power, connectionLost, lastUpdated, refresh };
}