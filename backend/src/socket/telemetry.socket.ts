/**
 * Telemetry is now emitted on-change directly from telemetryManager.
 * This module is kept for startup logging / future extensions.
 */
let started = false;

export function startTelemetryBroadcast() {
  if (started) return;
  started = true;
  console.log("📡 Telemetry broadcast active (delta-based)");
}
