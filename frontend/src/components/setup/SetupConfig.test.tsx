import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ParameterProvider } from "../../context/ParameterContext";
import SetupConfig from "./SetupConfig";

import {
  listView,
  metadataAvailable,
  statusView,
} from "../../test/fixtures";
import type { SetupSummaryData, RadioStatus } from "../../api/setup";

const { emitter, apiMocks, setupMocks, telemetry } = vi.hoisted(() => {
  const handlers = new Map<string, Set<(payload?: unknown) => void>>();
  return {
    emitter: {
      on: (event: string, fn: (payload?: unknown) => void) => {
        if (!handlers.has(event)) handlers.set(event, new Set());
        handlers.get(event)!.add(fn);
      },
      off: (event: string, fn: (payload?: unknown) => void) => {
        handlers.get(event)?.delete(fn);
      },
      emit: (event: string, payload?: unknown) => {
        handlers.get(event)?.forEach((fn) => fn(payload));
      },
    },
    apiMocks: {
      getAllParameters: vi.fn(),
      getParameterStatus: vi.fn(),
      getMetadataOverview: vi.fn(),
      refreshParameters: vi.fn(),
    },
    setupMocks: {
      getFirmwareInfo: vi.fn(),
      getFirmwareCapability: vi.fn(),
      getAccelCalStatus: vi.fn(),
      getSensorStatus: vi.fn(),
      getCompassCalStatus: vi.fn(),
      getCompassConfiguration: vi.fn(),
      getCompassMotCapability: vi.fn(),
      getSetupSummary: vi.fn(),
      getRadioStatus: vi.fn(),
      getRadioCalibrationStatus: vi.fn(),
      getLoggingInfo: vi.fn(),
      getScriptingInfo: vi.fn(),
    },
    telemetry: {
      connected: true,
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
  };
});

vi.mock("../../api/parameters", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getAllParameters: apiMocks.getAllParameters,
    getParameterStatus: apiMocks.getParameterStatus,
    getMetadataOverview: apiMocks.getMetadataOverview,
    refreshParameters: apiMocks.refreshParameters,
  };
});

vi.mock("../../api/setup", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getFirmwareInfo: setupMocks.getFirmwareInfo,
    getFirmwareCapability: setupMocks.getFirmwareCapability,
    getAccelCalStatus: setupMocks.getAccelCalStatus,
    getSensorStatus: setupMocks.getSensorStatus,
    getCompassCalStatus: setupMocks.getCompassCalStatus,
    getCompassConfiguration: setupMocks.getCompassConfiguration,
    getCompassMotCapability: setupMocks.getCompassMotCapability,
      getSetupSummary: setupMocks.getSetupSummary,
      getRadioStatus: setupMocks.getRadioStatus,
      getRadioCalibrationStatus: setupMocks.getRadioCalibrationStatus,
      getLoggingInfo: setupMocks.getLoggingInfo,
      getScriptingInfo: setupMocks.getScriptingInfo,
    };
});

vi.mock("../../socket/socket", () => ({ default: emitter }));

vi.mock("../../hooks/useTelemetry", () => ({
  useTelemetry: () => telemetry,
}));

function renderSetup() {
  return render(
    <ParameterProvider>
      <SetupConfig />
    </ParameterProvider>
  );
}

function summaryData(overrides: Partial<ReturnType<typeof healthySummary>> = {}) {
  return { ...healthySummary(), ...overrides };
}

function healthySummary(): SetupSummaryData {
  return {
    success: true,
    connected: true,
    sync: { state: "complete", expectedCount: 991, receivedCount: 991, cachedEntries: 991 },
    items: [
      { id: "frame", label: "Frame / Airframe", tone: "good", message: "ok", nav: "frame" },
      { id: "accelerometer", label: "Accelerometer", tone: "good", message: "ok", nav: "sensors" },
      { id: "gyroscope", label: "Gyroscope", tone: "good", message: "ok", nav: "sensors" },
      { id: "compass", label: "Compass", tone: "good", message: "ok", nav: "sensors" },
      { id: "barometer", label: "Barometer", tone: "good", message: "ok", nav: "sensors" },
      { id: "level", label: "Level Horizon", tone: "good", message: "ok", nav: "sensors" },
      { id: "radio", label: "Radio", tone: "good", message: "ok", nav: "radio" },
      { id: "flightModes", label: "Flight Modes", tone: "good", message: "ok", nav: "modes" },
      { id: "power", label: "Power / Battery", tone: "good", message: "ok", nav: "power" },
      { id: "safety", label: "Safety / Failsafes", tone: "good", message: "ok", nav: "safety" },
      { id: "esc", label: "ESC", tone: "good", message: "ok", nav: "esc" },
      { id: "servoOutputs", label: "Servo Outputs", tone: "good", message: "ok", nav: "servos" },
      { id: "logging", label: "Logging", tone: "good", message: "ok", nav: "logging" },
      { id: "gps", label: "GPS", tone: "good", message: "ok", nav: "parameters" },
    ],
     counts: { good: 14, warn: 0, unsupported: 0, unknown: 0, waiting: 0 },
  };
}

beforeEach(() => {
  window.localStorage.clear();
  telemetry.connected = true;
  telemetry.mode = "STABILIZE";
  apiMocks.getParameterStatus.mockResolvedValue(statusView());
  apiMocks.getAllParameters.mockResolvedValue(listView());
  apiMocks.getMetadataOverview.mockResolvedValue({
    success: true,
    vehicle: "copter",
    metadataStatus: metadataAvailable,
    groups: ["Waypoints"],
  });
  apiMocks.refreshParameters.mockResolvedValue({ success: true, sync: statusView().sync });
  setupMocks.getFirmwareInfo.mockResolvedValue({
    success: true,
    version: "4.8.0 (Development)",
    custom: "d16ddbab",
    boardVersion: 0,
    middlewareSwVersion: 0,
    osSwVersion: 0,
    vendorId: 0,
    productId: 0,
  });
  setupMocks.getFirmwareCapability.mockResolvedValue({
    success: true,
    firmwareIdentification: "available",
    firmwareInstallation: "not-available",
    releaseCatalog: "unavailable",
    supportedTargets: [{ flightStack: "ArduPilot", vehicle: "Copter" }],
    installationMessage: "Firmware installation is not currently available in YantraYug.",
    catalogMessage: "Firmware catalog unavailable.",
  });
  setupMocks.getAccelCalStatus.mockResolvedValue({
    active: false,
    step: null,
    label: "",
    order: 0,
    total: 6,
    result: null,
  });
  setupMocks.getSensorStatus.mockResolvedValue({
    connected: true,
    armed: false,
    systemId: 1,
    componentId: 1,
    vehicleType: "QUADROTOR",
    autopilot: "ARDUPILOTMEGA",
    connectionType: "SERIAL",
    sensors: {
      accel: { status: "calibrated", ids: { INS_ACC_ID: { supported: true, value: 11 } }, offsets: {} },
      gyro: { status: "calibrated", ids: { INS_GYR_ID: { supported: true, value: 12 } }, offsets: {} },
      baro: { status: "calibrated", ids: { BARO_PRIMARY: { supported: true, value: 0 } }, offsets: {} },
      compass: {
        status: "unknown",
        ids: {},
        offsets: {},
        detected: 0,
        calFit: null,
        devices: [],
      },
      level: { status: "unknown", ids: {}, offsets: {}, trim: { x: 0, y: 0 } },
      compassMot: { supported: false, enabled: null, active: false },
    },
  });
  setupMocks.getCompassCalStatus.mockResolvedValue({
    active: false,
    mask: 0,
    status: "idle",
    completionPct: 0,
    result: null,
  });
  setupMocks.getCompassConfiguration.mockResolvedValue({
    connected: true,
    enabled: 1,
    detected: 0,
    primaryFit: null,
    orientations: {},
    orientation: { supported: true, value: 0 },
    devices: [],
  });
  setupMocks.getCompassMotCapability.mockResolvedValue({ supported: false, enabled: null, active: false });
  setupMocks.getSetupSummary.mockResolvedValue(summaryData());
  setupMocks.getRadioStatus.mockResolvedValue(radioStatus());
  setupMocks.getRadioCalibrationStatus.mockResolvedValue({
    state: "idle",
    message: "",
    phase: null,
    progress: null,
    result: null,
  });
  const phase8i = {
    success: true,
    connected: true,
    connectionState: "CONNECTED",
    disconnectReason: null,
    armed: false,
    vehicleType: "QUADROTOR",
    autopilot: "ARDUPILOTMEGA",
    transport: "USB",
    supported: true,
    state: "READY",
    sync: { state: "READY", complete: true, receivedCount: 1, expectedCount: 1 },
    writePipeline: "shared",
    timestamp: 0,
    config: [],
    configCount: 0,
  };
  setupMocks.getLoggingInfo.mockResolvedValue({
    ...phase8i,
    readOnly: false,
    status: "Disabled",
    logEntries: [],
    logEntryCount: 0,
    numLogs: null,
    lastLogNum: null,
  });
  setupMocks.getScriptingInfo.mockResolvedValue({
    ...phase8i,
    readOnly: false,
    executionEnabled: false,
    capability: { scriptingDetected: false, reason: "No scripting parameters." },
    userTokens: [],
  });
});

function radioStatus(overrides: Partial<RadioStatus> = {}): RadioStatus {
  return {
    success: true,
    connected: true,
    connectionState: "CONNECTED",
    disconnectReason: null,
    armed: false,
    mode: "STABILIZE",
    systemId: 1,
    componentId: 1,
    vehicleType: "QUADROTOR",
    autopilot: "ARDUPILOTMEGA",
    transport: "USB",
    supported: true,
    signal: "WAITING",
    rc: {
      channelCount: 4,
      rssi: 0,
      receivedAt: 0,
      ageMs: null,
      stale: false,
      rssiReport: {
        value: null,
        raw: 0,
        available: false,
        unavailableReason: "The vehicle reports no valid RC link (RSSI 0).",
      },
      channels: [
        { channel: 1, value: 1500, active: true },
        { channel: 2, value: 1500, active: true },
        { channel: 3, value: 1500, active: true },
        { channel: 4, value: 1500, active: true },
      ],
    },
    mainControls: {
      supported: true,
      mappings: [
        { function: "Roll", param: "RCMAP_ROLL", channel: 1 },
        { function: "Pitch", param: "RCMAP_PITCH", channel: 2 },
        { function: "Throttle", param: "RCMAP_THROTTLE", channel: 3 },
        { function: "Yaw", param: "RCMAP_YAW", channel: 4 },
      ],
      channels: [1, 2, 3, 4],
    },
    channelConfig: [1, 2, 3, 4].map((channel) => ({
      channel,
      min: 1100,
      max: 1900,
      trim: 1500,
      reversed: 0,
      supported: { min: true, trim: true, max: true, reversed: true },
    })),
    rcState: "WAITING_FOR_RC",
    auxChannels: { supported: false, channels: [] },
    calibrationStage: "IDLE",
    calibration: {
      state: "idle",
      stage: "IDLE",
      message: "",
      phase: null,
      progress: null,
      result: null,
    },
    ...overrides,
  };
}

describe("SetupConfig — shell and navigation", () => {
  it("renders the Vehicle Setup shell and all nav items", async () => {
    renderSetup();
    const nav = await screen.findByTestId("setup-nav");
    expect(nav).toBeInTheDocument();
    for (const id of [
      "summary",
      "firmware",
      "frame",
      "sensors",
      "radio",
      "modes",
      "power",
      "safety",
      "motors",
      "esc",
      "logging",
      "scripting",
      "parameters",
    ]) {
      expect(screen.getByTestId(`setup-nav-${id}`)).toBeInTheDocument();
    }
  });

  it("shows connection chips in the top bar", async () => {
    renderSetup();
    expect(await screen.findByTestId("setup-conn-chip")).toBeInTheDocument();
    expect(screen.getAllByText("STABILIZE").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("QUADROTOR").length).toBeGreaterThanOrEqual(1);
  });

  it("starts on the Summary page", async () => {
    renderSetup();
    expect(await screen.findByTestId("setup-summary")).toBeInTheDocument();
  });

  it("navigates to the Firmware page", async () => {
    const user = userEvent.setup();
    renderSetup();
    await user.click(await screen.findByTestId("setup-nav-firmware"));
    expect(await screen.findByTestId("setup-firmware")).toBeInTheDocument();
    expect(screen.getByTestId("setup-firmware-workflow")).toBeInTheDocument();
    expect(screen.getAllByText(/4.8.0/).length).toBeGreaterThanOrEqual(1);
  });

  it("navigates to the Frame / Airframe page (Phase 8B)", async () => {
    const user = userEvent.setup();
    renderSetup();
    await user.click(await screen.findByTestId("setup-nav-frame"));
    expect(await screen.findByTestId("setup-frame")).toBeInTheDocument();
    expect(screen.getByTestId("frame-field-FRAME_TYPE")).toBeInTheDocument();
  });

  it("navigates to the Sensors page (Phase 8C)", async () => {
    const user = userEvent.setup();
    renderSetup();
    await user.click(await screen.findByTestId("setup-nav-sensors"));
    expect(await screen.findByTestId("setup-sensors")).toBeInTheDocument();
    expect(await screen.findByTestId("setup-accel-card")).toBeInTheDocument();
    expect(await screen.findByTestId("setup-compass-card")).toBeInTheDocument();
  });

  it("navigates to the Radio page (Phase 8E)", async () => {
    const user = userEvent.setup();
    renderSetup();
    await user.click(await screen.findByTestId("setup-nav-radio"));
    expect(await screen.findByTestId("setup-radio")).toBeInTheDocument();
  });

  it("reuses the existing Flight Modes component under Setup", async () => {
    const user = userEvent.setup();
    renderSetup();
    await user.click(await screen.findByTestId("setup-nav-modes"));
    expect(await screen.findByTestId("fm-screen")).toBeInTheDocument();
  });

  it("opens the shared Parameters list under Setup", async () => {
    const user = userEvent.setup();
    renderSetup();
    await user.click(await screen.findByTestId("setup-nav-parameters"));
    expect(await screen.findByTestId("setup-parameters")).toBeInTheDocument();
    expect(screen.getByTestId("setup-params-save")).toBeInTheDocument();
  });

  it("shows a warning badge on Summary when the backend reports issues", async () => {
    const user = userEvent.setup();
    setupMocks.getSetupSummary.mockResolvedValue(
      summaryData({ counts: { good: 10, warn: 2, unsupported: 1, unknown: 0, waiting: 0 } })
    );
    renderSetup();
    // Badge = warn (2) + unsupported (1); waiting is never counted as a problem.
    expect(await screen.findByTestId("setup-nav-summary-badge")).toHaveTextContent("3");
    await user.click(screen.getByTestId("setup-nav-summary"));
    expect(screen.getByTestId("setup-summary")).toBeInTheDocument();
  });

  it("shows no badge when everything is OK", async () => {
    renderSetup();
    await screen.findByTestId("setup-summary");
    expect(screen.queryByTestId("setup-nav-summary-badge")).not.toBeInTheDocument();
  });

  it("navigates to the Logging page instead of the inactive stub", async () => {
    const user = userEvent.setup();
    renderSetup();
    await user.click(await screen.findByTestId("setup-nav-logging"));
    expect(await screen.findByTestId("setup-logging")).toBeInTheDocument();
    expect(screen.getByTestId("logging-status")).toHaveTextContent("Disabled");
    expect(screen.queryByText(/not implemented in Phase 8H/)).not.toBeInTheDocument();
  });

  it("navigates to the Scripting page instead of the inactive stub", async () => {
    const user = userEvent.setup();
    renderSetup();
    await user.click(await screen.findByTestId("setup-nav-scripting"));
    expect(await screen.findByTestId("setup-scripting")).toBeInTheDocument();
    expect(screen.getByTestId("scripting-detected")).toHaveTextContent("No");
    expect(screen.queryByText(/not implemented in Phase 8H/)).not.toBeInTheDocument();
  });
});

describe("SetupConfig — disconnected state", () => {
  it("shows Disconnected chip and disables vehicle-dependent content", async () => {
    telemetry.connected = false;
    telemetry.mode = "DISCONNECTED";
    apiMocks.getParameterStatus.mockResolvedValue(
      statusView({ connection: "DISCONNECTED", sessionId: null })
    );
    apiMocks.getAllParameters.mockResolvedValue(
      listView({ connection: "DISCONNECTED", count: 0, parameters: [] })
    );
    renderSetup();

    expect(await screen.findByText("Disconnected")).toBeInTheDocument();
    expect(screen.getByTestId("setup-summary-disconnected")).toBeInTheDocument();
    expect(screen.queryByTestId("setup-status-list")).not.toBeInTheDocument();
    expect(screen.queryByTestId("setup-nav-summary-badge")).not.toBeInTheDocument();
  });
});
