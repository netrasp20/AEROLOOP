import { useMemo } from "react";
import { getMotorsInfo, type MotorsStatus } from "../api/setup";
import { useReadOnlySetup } from "./useReadOnlySetup";

export function useMotorsSetup(connected: boolean) {
  const events = useMemo(() => ["parameter:updated", "servo-output:update", "telemetry:update"], []);
  const result = useReadOnlySetup<MotorsStatus>(connected, getMotorsInfo, events);
  return { motors: result.data, ...result };
}
