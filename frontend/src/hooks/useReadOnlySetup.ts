import { useCallback, useEffect, useRef, useState } from "react";

import socket from "../socket/socket";

export interface ReadOnlySetupResult<T> {
  data: T | null;
  connectionLost: boolean;
  lastUpdated: number | null;
  refresh: () => Promise<void>;
}

export function useReadOnlySetup<T>(
  connected: boolean,
  loader: () => Promise<T>,
  events: string[],
): ReadOnlySetupResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [connectionLost, setConnectionLost] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const wasConnected = useRef(connected);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!connected && wasConnected.current) {
      setData(null);
      setConnectionLost(true);
    }
    if (connected && !wasConnected.current) setConnectionLost(false);
    wasConnected.current = connected;
  }, [connected]);

  const refresh = useCallback(async () => {
    if (!connected) {
      setData(null);
      return;
    }
    try {
      const snapshot = await loader();
      setData(snapshot);
      setLastUpdated(Date.now());
    } catch {
      // Preserve an already-rendered snapshot for transient request failures.
    }
  }, [connected, loader]);

  useEffect(() => void refresh(), [refresh]);

  const coalescedRefresh = useCallback(() => {
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      void refresh();
    }, 700);
  }, [refresh]);

  useEffect(() => {
    events.forEach((event) => socket.on(event, coalescedRefresh));
    return () => {
      events.forEach((event) => socket.off(event, coalescedRefresh));
      if (timer.current) clearTimeout(timer.current);
    };
  }, [coalescedRefresh, events]);

  return { data, connectionLost, lastUpdated, refresh };
}
