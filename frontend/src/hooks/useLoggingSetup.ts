import { useMemo } from "react";
import { getLoggingInfo, type LoggingStatus } from "../api/setup";
import { useReadOnlySetup } from "./useReadOnlySetup";

export function useLoggingSetup(connected: boolean) {
  const events = useMemo(
    () => ["parameter:updated", "log-entries:update", "telemetry:update"],
    [],
  );
  const result = useReadOnlySetup<LoggingStatus>(connected, getLoggingInfo, events);
  return { logging: result.data, ...result };
}
