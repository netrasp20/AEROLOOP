import { useMemo } from "react";
import { getScriptingInfo, type ScriptingStatus } from "../api/setup";
import { useReadOnlySetup } from "./useReadOnlySetup";

export function useScriptingSetup(connected: boolean) {
  const events = useMemo(
    () => ["parameter:updated", "telemetry:update"],
    [],
  );
  const result = useReadOnlySetup<ScriptingStatus>(connected, getScriptingInfo, events);
  return { scripting: result.data, ...result };
}
