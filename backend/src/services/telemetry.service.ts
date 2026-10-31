import { telemetry, type TelemetryData } from "../mavlink/telemetry";

export function getTelemetryData(): TelemetryData {
  return { ...telemetry };
}

export function getTelemetrySnapshot(): string {
  return JSON.stringify(telemetry, null, 2);
}
