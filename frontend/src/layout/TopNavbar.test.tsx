import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import TopNavbar from "./TopNavbar";
import type { TelemetryData } from "../providers/TelemetryProvider";

const { telemetry, apiMocks, operator } = vi.hoisted(() => ({
  telemetry: {
    connected: false,
    connectionState: "DISCONNECTED",
    disconnectReason: null,
    systemId: 0,
    componentId: 0,
    vehicleType: "UNKNOWN",
    autopilot: "UNKNOWN",
    mode: "DISCONNECTED",
    armed: false,
    latitude: 0,
    longitude: 0,
    altitude: 0,
    relativeAltitude: 0,
    homeLatitude: 0,
    homeLongitude: 0,
    homeAltitude: 0,
    groundSpeed: 0,
    airSpeed: 0,
    verticalSpeed: 0,
    heading: 0,
    roll: 0,
    pitch: 0,
    yaw: 0,
    batteryVoltage: 0,
    batteryCurrent: 0,
    batteryRemaining: 0,
    gpsFix: 0,
    satellites: 0,
    hdop: 0,
    distance: 0,
    distanceToHome: 0,
    atHome: false,
    missionUploaded: false,
    missionCurrent: 0,
    missionReached: 0,
    missionRunning: false,
    missionCompleted: false,
    missionTotalDistance: 0,
    statusText: "",
    timestamp: 0,
  } as TelemetryData,
  apiMocks: {
    connectVehicle: vi.fn(),
    disconnectVehicle: vi.fn(),
    changeMode: vi.fn(),
    getVehicleStatus: vi.fn(),
    getSerialPorts: vi.fn(),
  },
  operator: {
    loading: false,
    error: null,
    latitude: 0,
    longitude: 0,
    isFallback: false,
    isFixed: false,
  },
}));

vi.mock("../providers/TelemetryProvider", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, useTelemetry: () => telemetry };
});

vi.mock("../context/OperatorLocationContext", () => ({
  useOperatorLocation: () => operator,
}));

vi.mock("../api/vehicle", () => apiMocks);

describe("TopNavbar — MAVLink connection indicator", () => {
  it("shows CONNECTED chip + live heartbeat when connected", () => {
    telemetry.connected = true;
    telemetry.connectionState = "CONNECTED";
    telemetry.disconnectReason = null;
    telemetry.mode = "STABILIZE";
    render(
      <TopNavbar page="DATA" setPage={vi.fn()} />
    );

    const chip = screen.getByTestId("connection-state-chip");
    expect(chip.textContent).toBe("CONNECTED");
    expect(chip.dataset.state).toBe("connected");

    const indicator = screen.getByTestId("heartbeat-indicator");
    expect(indicator.className).toContain("alive");
    expect(indicator.getAttribute("title")).toContain("Heartbeat OK — STABILIZE");
  });

  it("shows CONNECTING... after a connect request", () => {
    telemetry.connected = false;
    telemetry.connectionState = "CONNECTING";
    telemetry.disconnectReason = null;
    render(
      <TopNavbar page="DATA" setPage={vi.fn()} />
    );

    const chip = screen.getByTestId("connection-state-chip");
    expect(chip.textContent).toBe("CONNECTING...");
    expect(chip.dataset.state).toBe("connecting");
  });

  it("shows MAVLink CONNECTION LOST + heartbeat reason when disconnected with a reason", () => {
    telemetry.connected = false;
    telemetry.connectionState = "DISCONNECTED";
    telemetry.disconnectReason = "heartbeat_timeout";
    render(
      <TopNavbar page="DATA" setPage={vi.fn()} />
    );

    const chip = screen.getByTestId("connection-state-chip");
    expect(chip.textContent).toBe("MAVLink CONNECTION LOST");
    expect(chip.dataset.state).toBe("lost");
    expect(chip.getAttribute("title")).toContain("heartbeat_timeout");

    const indicator = screen.getByTestId("heartbeat-indicator");
    expect(indicator.className).toContain("dead");
    expect(indicator.getAttribute("title")).toContain("heartbeat_timeout");
  });

  it("shows NO VEHICLE when never connected (no reason)", () => {
    telemetry.connected = false;
    telemetry.connectionState = "DISCONNECTED";
    telemetry.disconnectReason = null;
    render(
      <TopNavbar page="DATA" setPage={vi.fn()} />
    );

    const chip = screen.getByTestId("connection-state-chip");
    expect(chip.textContent).toBe("NO VEHICLE");
    expect(chip.dataset.state).toBe("no-vehicle");

    const indicator = screen.getByTestId("heartbeat-indicator");
    expect(indicator.className).toContain("dead");
  });
});