import { telemetry } from "./telemetry";

export function updateTelemetry(
  key: keyof typeof telemetry,
  value: (typeof telemetry)[keyof typeof telemetry]
) {
  telemetry[key] = value as never;
}

export function getTelemetry() {
  return telemetry;
}

export function printTelemetry() {
  console.clear();

  console.table({
    Mode: telemetry.mode,
    Armed: telemetry.armed,
    Latitude: telemetry.latitude,
    Longitude: telemetry.longitude,
    Altitude: telemetry.altitude,
    GroundSpeed: telemetry.groundSpeed,
    Heading: telemetry.heading,
    Battery: telemetry.battery,
    Satellites: telemetry.satellites,
    Pitch: telemetry.pitch,
    Roll: telemetry.roll,
    Yaw: telemetry.yaw,
  });
}