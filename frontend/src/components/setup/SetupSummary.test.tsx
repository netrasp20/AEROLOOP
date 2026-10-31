import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import SetupSummary from "./SetupSummary";
import type { SetupStatusItem, SetupSummaryData } from "../../api/setup";

const { setupMocks, telemetry } = vi.hoisted(() => ({
  setupMocks: {
    getFirmwareInfo: vi.fn(),
  },
  telemetry: {
    connected: true,
    connectionState: "CONNECTED" as "CONNECTED" | "CONNECTING" | "DISCONNECTED",
    disconnectReason: null as string | null,
    systemId: 1,
    componentId: 1,
    vehicleType: "QUADROTOR",
    autopilot: "ARDUPILOTMEGA",
    mode: "STABILIZE",
    armed: false,
    satellites: 10,
    batteryVoltage: 12.4,
    batteryRemaining: 80,
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
    batteryCurrent: 0,
    gpsFix: 6,
    hdop: 0,
    distance: 0,
    distanceToHome: 0,
    atHome: true,
    missionCurrent: 0,
    missionReached: 0,
    missionRunning: false,
    missionCompleted: false,
    missionTotalDistance: 0,
    statusText: "",
    fenceBreachStatus: 0,
    fenceBreachCount: 0,
    fenceBreachType: 0,
    timestamp: 0,
  },
}));

vi.mock("../../api/setup", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, getFirmwareInfo: setupMocks.getFirmwareInfo };
});

vi.mock("../../hooks/useTelemetry", () => ({
  useTelemetry: () => telemetry,
}));

function item(id: string, tone: SetupStatusItem["tone"], nav = "summary"): SetupStatusItem {
  return { id, label: id, tone, message: `${id} status`, nav };
}

function healthySummary(): SetupSummaryData {
  return {
    success: true,
    connected: true,
    sync: { state: "complete", expectedCount: 991, receivedCount: 991, cachedEntries: 991 },
    items: [
      {
        id: "frame",
        label: "Frame / Airframe",
        tone: "good",
        message: "Configured · Quad X",
        nav: "frame",
        meta: { frameClass: 1, frameType: 1 },
      },
      item("accelerometer", "good", "sensors"),
      item("gyroscope", "good", "sensors"),
      item("compass", "good", "sensors"),
      item("barometer", "good", "sensors"),
      item("level", "good", "sensors"),
      item("radio", "good", "radio"),
      item("flightModes", "good", "modes"),
      item("power", "good", "power"),
      item("safety", "good", "safety"),
      item("esc", "good", "esc"),
      item("servoOutputs", "good", "servos"),
      item("logging", "good", "logging"),
      item("gps", "good", "parameters"),
    ],
    counts: { good: 15, warn: 0, unsupported: 0, unknown: 0, waiting: 0 },
    capabilities: { camera: "Configured", scripting: "Enabled" },
  };
}

function renderSummary(
  summary: SetupSummaryData | null = healthySummary(),
  onNavigate = vi.fn()
) {
  return render(<SetupSummary summary={summary} onNavigate={onNavigate} />);
}

beforeEach(() => {
  setupMocks.getFirmwareInfo.mockResolvedValue({
    success: true,
    version: "4.7.0 (Official Release)",
    custom: "",
  });
});

describe("SetupSummary — connected vehicle", () => {
  it("shows the compact reference-style panel grid from live telemetry", async () => {
    renderSummary();
    expect(await screen.findByText("QUADROTOR")).toBeInTheDocument();
    expect(screen.getByText("ARDUPILOTMEGA")).toBeInTheDocument();
    expect(screen.getAllByText("STABILIZE").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("1 / 1")).toBeInTheDocument();
    expect(screen.getByText("RTK Fixed · 10 sats")).toBeInTheDocument();
    expect(screen.getByTestId("setup-summary-grid")).toBeInTheDocument();
    expect(screen.getByTestId("setup-summary-radio")).toBeInTheDocument();
    expect(screen.getByTestId("setup-summary-sensors")).toBeInTheDocument();
    expect(screen.getByTestId("setup-summary-modes")).toBeInTheDocument();
    expect(screen.getByTestId("setup-summary-power")).toBeInTheDocument();
    expect(screen.getByTestId("setup-summary-safety")).toBeInTheDocument();
  });

  it("shows the firmware version fetched via the AUTOPILOT_VERSION pipeline", async () => {
    renderSummary();
    expect(await screen.findByTestId("setup-firmware-version")).toHaveTextContent(
      "4.7.0 (Official Release)"
    );
  });

  it("re-queries firmware when Re-query is pressed", async () => {
    const user = userEvent.setup();
    renderSummary();
    await screen.findByText("4.7.0 (Official Release)");
    setupMocks.getFirmwareInfo.mockClear();
    await user.click(screen.getByTestId("setup-firmware-refresh"));
    await screen.findByText("4.7.0 (Official Release)");
    expect(setupMocks.getFirmwareInfo).toHaveBeenCalled();
  });

  it("links to the Firmware page from the firmware card", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    renderSummary(undefined, onNavigate);
    await screen.findByText("4.7.0 (Official Release)");
    await user.click(screen.getByTestId("setup-firmware-card-link"));
    expect(onNavigate).toHaveBeenCalledWith("firmware");
  });

  it("navigates from compact panels to their detailed Setup pages", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    renderSummary(healthySummary(), onNavigate);
    await user.click(await screen.findByText("Open Radio"));
    expect(onNavigate).toHaveBeenCalledWith("radio");
  });

  it("reports all items as WAITING (not unsupported) until the parameter sync completes", async () => {
    const summary = healthySummary();
    summary.sync = { state: "receiving", expectedCount: 991, receivedCount: 412, cachedEntries: 400 };
    summary.items = summary.items.map((i) => ({
      ...i,
      tone: "waiting" as const,
      message: "Waiting for parameter sync (412/991)",
    }));
    summary.counts = { good: 0, warn: 0, unsupported: 0, unknown: 0, waiting: 15 };
    renderSummary(summary);
    expect(await screen.findByText("412/991")).toBeInTheDocument();
    expect(screen.getAllByText("Waiting for parameter sync (412/991)").length).toBeGreaterThan(1);
  });
});

function panelDotTone(panelId: string): string | null {
  const panel = screen.getByTestId(panelId);
  return panel.querySelector(".setup-summary-dot")?.getAttribute("data-tone") ?? null;
}

describe("SetupSummary — panel status indicators", () => {
  it("derives the Sensors header dot from the real sensor items, not a nonexistent id", async () => {
    const onNavigate = vi.fn();
    const { rerender } = renderSummary(healthySummary(), onNavigate);
    await screen.findByTestId("setup-summary-sensors");
    expect(panelDotTone("setup-summary-sensors")).toBe("good");

    const warnSummary = healthySummary();
    warnSummary.items = warnSummary.items.map((i) =>
      i.id === "compass" ? { ...i, tone: "warn" as const } : i
    );
    rerender(<SetupSummary summary={warnSummary} onNavigate={onNavigate} />);
    expect(panelDotTone("setup-summary-sensors")).toBe("warn");
  });

  it("capabilities dot reflects logging and camera/scripting, not just ESC", async () => {
    const onNavigate = vi.fn();
    const { rerender } = renderSummary(healthySummary(), onNavigate);
    await screen.findByTestId("setup-summary-capabilities");
    expect(panelDotTone("setup-summary-capabilities")).toBe("good");

    const loggingWarn = healthySummary();
    loggingWarn.items = loggingWarn.items.map((i) =>
      i.id === "logging" ? { ...i, tone: "warn" as const } : i
    );
    rerender(<SetupSummary summary={loggingWarn} onNavigate={onNavigate} />);
    expect(panelDotTone("setup-summary-capabilities")).toBe("warn");

    const cameraUnavailable = healthySummary();
    cameraUnavailable.capabilities = { camera: "Unavailable", scripting: "Enabled" };
    rerender(<SetupSummary summary={cameraUnavailable} onNavigate={onNavigate} />);
    expect(panelDotTone("setup-summary-capabilities")).toBe("unsupported");
  });

  it("renders WAITING and UNKNOWN as distinct neutral states (never green)", async () => {
    const summary = healthySummary();
    summary.items = summary.items.map((i) =>
      i.id === "frame"
        ? { ...i, tone: "waiting" as const }
        : i.id === "power"
          ? { ...i, tone: "unknown" as const }
          : i
    );
    renderSummary(summary);
    await screen.findByTestId("setup-vehicle-card");

    const waitingDot = screen.getByTestId("setup-vehicle-card").querySelector(".setup-summary-dot");
    const unknownDot = screen.getByTestId("setup-summary-power").querySelector(".setup-summary-dot");
    expect(waitingDot).toHaveAttribute("data-tone", "waiting");
    expect(waitingDot?.className).toContain("setup-summary-tone-waiting");
    expect(waitingDot?.className).not.toContain("setup-summary-tone-muted");
    expect(unknownDot).toHaveAttribute("data-tone", "unknown");
    expect(unknownDot?.className).toContain("setup-summary-tone-muted");
    expect(unknownDot?.className).not.toContain("setup-summary-tone-waiting");
  });
});

describe("SetupSummary — disconnected", () => {
  it("shows the QGC-style waiting-for-vehicle state with no stale data", async () => {
    telemetry.connected = false;
    telemetry.connectionState = "DISCONNECTED";
    telemetry.disconnectReason = null;
    telemetry.mode = "DISCONNECTED";
    renderSummary(null);
    expect(await screen.findByTestId("setup-summary-disconnected")).toBeInTheDocument();
    expect(screen.getByTestId("setup-summary-waiting-title").textContent).toBe(
      "Waiting for vehicle"
    );
    expect(screen.getByTestId("setup-summary-waiting-hint").textContent).toContain(
      "Connect a Pixhawk or MAVLink vehicle"
    );
    expect(screen.queryByTestId("setup-summary-reason")).not.toBeInTheDocument();
    expect(screen.queryByTestId("setup-status-list")).not.toBeInTheDocument();
    expect(screen.queryByText("QUADROTOR")).not.toBeInTheDocument();
  });

  it("shows the lost-connection reason when the link drops (no stale values)", async () => {
    telemetry.connected = false;
    telemetry.connectionState = "DISCONNECTED";
    telemetry.disconnectReason = "heartbeat_timeout";
    telemetry.mode = "DISCONNECTED";
    telemetry.batteryVoltage = 14.8; // stale value must NOT be rendered
    renderSummary(null);
    expect(await screen.findByTestId("setup-summary-disconnected")).toBeInTheDocument();
    expect(screen.getByTestId("setup-summary-waiting-title").textContent).toBe(
      "Vehicle connection lost"
    );
    expect(screen.getByTestId("setup-summary-reason").textContent).toContain(
      "heartbeat_timeout"
    );
    expect(screen.queryByText(/14\.8/)).not.toBeInTheDocument();
  });
});
