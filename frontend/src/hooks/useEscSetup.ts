import { useMemo } from "react";
import { getEscInfo, type EscStatus } from "../api/setup";
import { useReadOnlySetup } from "./useReadOnlySetup";

export function useEscSetup(connected: boolean) {
  const events = useMemo(() => ["parameter:updated", "esc-telemetry:update", "telemetry:update"], []);
  const result = useReadOnlySetup<EscStatus>(connected, getEscInfo, events);
  return { esc: result.data, ...result };
}
