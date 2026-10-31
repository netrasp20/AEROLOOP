/** Human-readable compass calibration progress text. */

import type { SensorCalState } from "../../api/setup";

const STATUS_LABELS: Record<string, string> = {
  "not-started": "Not started",
  "waiting-to-start": "Waiting to start — rotate the vehicle",
  "running-step-one": "Rotating…",
  "running-step-two": "Rotating…",
  success: "Finished — accept the result",
  failed: "Failed",
  "bad-orientation": "Bad orientation — retry",
  "bad-radius": "Bad radius — retry",
};

export function formatCompassStatus(status: string, completionPct: number): string {
  const label = STATUS_LABELS[status] ?? status;
  if (completionPct > 0 && (status === "running-step-one" || status === "running-step-two")) {
    return `${label} (${completionPct}%)`;
  }
  return label;
}

const SENSOR_STATE_LABELS: Record<SensorCalState, string> = {
  calibrated: "CALIBRATED",
  "not-calibrated": "NOT CALIBRATED",
  unsupported: "NOT SUPPORTED",
  unknown: "STATUS UNAVAILABLE",
};

/** The spec's differentiated sensor state, only ever derived on the backend. */
export function sensorStateLabel(state: SensorCalState | undefined): string {
  return SENSOR_STATE_LABELS[state ?? "unknown"];
}