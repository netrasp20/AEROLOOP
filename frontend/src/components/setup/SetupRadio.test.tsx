import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ParameterProvider } from "../../context/ParameterContext";
import SetupRadio from "./SetupRadio";

import {
  entry,
  makeMetadata,
  metadataAvailable,
  statusView,
} from "../../test/fixtures";
import type {
  MainControlsData,
  RadioCalibrationStatus,
  RadioRcData,
  RadioStatus,
} from "../../api/setup";

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
      writeBatch: vi.fn(),
    },
    setupMocks: {
      getRadioStatus: vi.fn(),
      getRadioCalibrationStatus: vi.fn(),
      startRadioCalibration: vi.fn(),
      captureRadioPhase: vi.fn(),
      cancelRadioCalibration: vi.fn(),
    },
    telemetry: {
      connected: true,
      connectionState: "CONNECTED",
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
      rcChannels: [] as number[],
      rcSignal: "NO_SIGNAL" as string,
      rcChannelCount: 0,
      rcRssi: 0,
      rcReceivedAt: 0,
    },
  };
});

vi.mock("../../api/parameters", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, ...apiMocks };
});

vi.mock("../../api/setup", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getRadioStatus: setupMocks.getRadioStatus,
    getRadioCalibrationStatus: setupMocks.getRadioCalibrationStatus,
    startRadioCalibration: setupMocks.startRadioCalibration,
    captureRadioPhase: setupMocks.captureRadioPhase,
    cancelRadioCalibration: setupMocks.cancelRadioCalibration,
  };
});

vi.mock("../../socket/socket", () => ({ default: emitter }));

vi.mock("../../hooks/useTelemetry", () => ({
  useTelemetry: () => telemetry,
}));

function rcParam(id: string, value: number, index: number) {
  return entry({
    id,
    live: { value, type: "INT16", index, count: 16, received: true },
    metadata: makeMetadata({
      id,
      name: id.replace(/_/g, " "),
      min: null,
      max: null,
      increment: null,
      group: "Radio",
      user: "Advanced",
    }),
    metadataMissing: false,
  });
}

function radioParams() {
  return [1, 2, 3, 4].flatMap((channel) => [
    rcParam(`RC${channel}_MIN`, 1100, (channel - 1) * 4),
    rcParam(`RC${channel}_TRIM`, 1500, (channel - 1) * 4 + 1),
    rcParam(`RC${channel}_MAX`, 1900, (channel - 1) * 4 + 2),
    rcParam(`RC${channel}_REVERSED`, 0, (channel - 1) * 4 + 3),
  ]);
}

/** The real RCMAP parameters the vehicle publishes alongside the RC endpoints. */
function mappingParams() {
  const axes: [string, number][] = [
    ["RCMAP_ROLL", 1],
    ["RCMAP_PITCH", 2],
    ["RCMAP_THROTTLE", 3],
    ["RCMAP_YAW", 4],
  ];
  return axes.map(([id, value], i) => rcParam(id, value, 100 + i));
}

function withParams(parameters: unknown[]) {
  apiMocks.getAllParameters.mockResolvedValue({
    success: true,
    connection: "READY",
    sync: statusView().sync,
    metadata: metadataAvailable,
    vehicle: { vehicleType: "QUADROTOR" },
    count: parameters.length,
    parameters,
  });
}

/**
 * Mirrors backend `radio_service._rssi_report`: 0 means no valid RC link and 255
 * means RSSI unknown, so neither may be surfaced as a signal strength.
 */
function rssiReportFor(rssi: number) {
  if (rssi >= 1 && rssi <= 254) {
    return { value: rssi, raw: rssi, available: true, unavailableReason: null };
  }
  return {
    value: null,
    raw: rssi,
    available: false,
    unavailableReason:
      rssi === 0 ? "No valid RC link reported." : "RSSI unknown (MAVLink sentinel 255).",
  };
}

/**
 * Builds a complete `RadioRcData`, deriving the honest RSSI/stale fields the
 * backend computes so a fixture can never drift from the real semantics.
 */
function rcPayload(partial: Partial<RadioRcData> = {}): RadioRcData {
  const merged = {
    channelCount: partial.channelCount ?? 4,
    rssi: partial.rssi ?? 0,
    receivedAt: partial.receivedAt ?? 0,
    ageMs: partial.ageMs ?? null,
    channels: partial.channels ?? [],
    ...partial,
  };
  return {
    ...merged,
    stale: merged.ageMs != null && merged.ageMs > 1500,
    rssiReport: rssiReportFor(merged.rssi),
  };
}

/** Overrides may supply a partial `rc` / `mainControls`; the factory fills the rest. */
type RadioOverrides = Omit<Partial<RadioStatus>, "rc" | "mainControls"> & {
  rc?: Partial<RadioRcData>;
  mainControls?: Partial<MainControlsData>;
};

function radioStatus(overrides: RadioOverrides = {}): RadioStatus {
  const base = {
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
    auxChannels: {
      supported: true,
      channels: [
        {
          channel: 5,
          param: "RC5_OPTION",
          label: "RC5_OPTION",
          supported: true,
          isMainControl: false,
          value: 0,
          options: [
            { value: 0, label: "Disabled" },
            { value: 1, label: "Servo" },
          ],
          unavailableReason: null,
        },
      ],
    },
    calibrationStage: "IDLE",
    calibration: {
      state: "idle",
      stage: "IDLE",
      message: "",
      phase: null,
      progress: null,
      result: null,
    },
  };

  const merged = {
    ...base,
    ...overrides,
    mainControls: { ...base.mainControls, ...overrides.mainControls },
  } as unknown as RadioStatus;
  const rc = rcPayload({ ...base.rc, ...overrides.rc });
  // Derived fields are recomputed from the merged rc unless the test set them
  // explicitly, so fixtures can never drift from the backend's own semantics.
  return {
    ...merged,
    rc,
    rcState:
      overrides.rcState ??
      (rc.channels.length > 0 && rc.rssiReport.available ? "RC_ACTIVE" : "WAITING_FOR_RC"),
  };
}

function idleCalibration(): RadioCalibrationStatus {
  return { state: "idle", stage: "IDLE", message: "", phase: null, progress: null, result: null };
}

function readyDefaults() {
  apiMocks.getParameterStatus.mockResolvedValue(statusView());
  apiMocks.getAllParameters.mockResolvedValue({
    success: true,
    connection: "READY",
    sync: statusView().sync,
    metadata: metadataAvailable,
    vehicle: { vehicleType: "QUADROTOR" },
    count: 16,
    parameters: radioParams(),
  });
  apiMocks.getMetadataOverview.mockResolvedValue({
    success: true,
    vehicle: "copter",
    metadataStatus: metadataAvailable,
    groups: ["Radio"],
  });
  apiMocks.refreshParameters.mockResolvedValue({ success: true, sync: statusView().sync });
  setupMocks.getRadioStatus.mockResolvedValue(radioStatus());
  setupMocks.getRadioCalibrationStatus.mockResolvedValue(idleCalibration());
}

/** Fresh, live RC telemetry so the monitor reads RECEIVING. */
function freshRc(values: number[], rssi = 100) {
  telemetry.rcChannels = values;
  telemetry.rcChannelCount = values.length;
  telemetry.rcRssi = rssi;
  telemetry.rcReceivedAt = Date.now() / 1000;
}

function renderRadio() {
  return render(
    <ParameterProvider>
      <SetupRadio />
    </ParameterProvider>
  );
}

/** Waits until the RC parameters have loaded so edits cannot be clobbered. */
async function waitForConfig() {
  await screen.findByTestId("setup-radio-config");
  await waitFor(() => {
    expect((screen.getByTestId("radio-config-trim-1") as HTMLInputElement).value).toBe("1500");
  });
}

function successTxn(items: { paramId: string; value: number }[]) {
  return {
    success: true,
    transaction: {
      transactionId: "txn-radio",
      sessionId: "abc123",
      status: "success",
      total: items.length,
      succeeded: items.length,
      failed: 0,
      notAttempted: 0,
      results: items.map((it) => ({
        paramId: it.paramId,
        requestedValue: it.value,
        originalValue: 1500,
        status: "success",
        verifiedValue: it.value,
        code: null,
        message: null,
      })),
    },
  };
}

beforeEach(() => {
  window.localStorage.clear();
  telemetry.connected = true;
  telemetry.connectionState = "CONNECTED";
  telemetry.disconnectReason = null;
  telemetry.rcChannels = [];
  telemetry.rcChannelCount = 0;
  telemetry.rcRssi = 0;
  telemetry.rcReceivedAt = 0;
  readyDefaults();
  apiMocks.writeBatch.mockResolvedValue(
    successTxn(radioParams().map((p) => ({ paramId: p.id, value: p.live!.value as number })))
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SetupRadio — page states", () => {
  it("shows the waiting screen when no vehicle is connected", async () => {
    telemetry.connected = false;
    telemetry.connectionState = "DISCONNECTED";
    renderRadio();
    expect(await screen.findByTestId("setup-radio-waiting")).toBeInTheDocument();
    expect(screen.getByText(/Waiting for vehicle/)).toBeInTheDocument();
  });

  it("shows the connecting screen while a link is being established", async () => {
    telemetry.connected = false;
    telemetry.connectionState = "CONNECTING";
    renderRadio();
    expect(await screen.findByTestId("setup-radio-connecting")).toBeInTheDocument();
    expect(screen.getByText(/Connecting to vehicle/)).toBeInTheDocument();
  });

  it("shows the connection-lost screen with reason and clears RC telemetry", async () => {
    const view = renderRadio();
    await screen.findByTestId("setup-radio");

    telemetry.connected = false;
    telemetry.connectionState = "DISCONNECTED";
    telemetry.disconnectReason = "link timeout";
    view.rerender(
      <ParameterProvider>
        <SetupRadio />
      </ParameterProvider>
    );

    expect(await screen.findByTestId("setup-radio-lost")).toBeInTheDocument();
    expect(screen.getByTestId("setup-radio-lost-reason")).toHaveTextContent("link timeout");
    expect(await screen.findByTestId("setup-radio-connection-lost")).toBeInTheDocument();
  });

  it("repopulates the channel configuration after a reconnect without a reload", async () => {
    const view = renderRadio();
    await waitForConfig();

    telemetry.connected = false;
    telemetry.connectionState = "DISCONNECTED";
    telemetry.disconnectReason = "link timeout";
    view.rerender(
      <ParameterProvider>
        <SetupRadio />
      </ParameterProvider>
    );

    expect(await screen.findByTestId("setup-radio-lost")).toBeInTheDocument();
    expect(screen.queryByTestId("setup-radio-config")).not.toBeInTheDocument();
    expect(screen.queryByTestId("radio-config-trim-1")).not.toBeInTheDocument();

    telemetry.connected = true;
    telemetry.connectionState = "CONNECTED";
    view.rerender(
      <ParameterProvider>
        <SetupRadio />
      </ParameterProvider>
    );

    await waitFor(() =>
      expect((screen.getByTestId("radio-config-trim-1") as HTMLInputElement).value).toBe("1500")
    );
    expect(screen.queryByTestId("setup-radio-connection-lost")).not.toBeInTheDocument();
  });

  it("shows the syncing state while the first radio snapshot is loading", async () => {
    setupMocks.getRadioStatus.mockReturnValue(new Promise(() => {}));
    renderRadio();
    expect(await screen.findByTestId("setup-radio-syncing")).toBeInTheDocument();
  });

  it("shows the error state with the backend message and allows retry", async () => {
    const user = userEvent.setup();
    setupMocks.getRadioStatus.mockResolvedValue({
      ...radioStatus(),
      success: false,
      message: "Radio telemetry unavailable.",
    });
    renderRadio();

    expect(await screen.findByTestId("setup-radio-error")).toBeInTheDocument();
    expect(screen.getByText("Radio telemetry unavailable.")).toBeInTheDocument();

    setupMocks.getRadioStatus.mockResolvedValue(radioStatus());
    await user.click(screen.getByTestId("setup-radio-retry"));
    expect(await screen.findByTestId("setup-radio-status-card")).toBeInTheDocument();
  });

  it("shows the unsupported state for a non-ArduCopter vehicle", async () => {
    setupMocks.getRadioStatus.mockResolvedValue(
      radioStatus({
        supported: false,
        unsupportedReason: "Vehicle is not an ArduCopter.",
      })
    );
    renderRadio();
    expect(await screen.findByTestId("setup-radio-unsupported")).toBeInTheDocument();
    expect(screen.getByText(/ArduCopter-only/)).toBeInTheDocument();
    expect(screen.getByText("Vehicle is not an ArduCopter.")).toBeInTheDocument();
  });
});

describe("SetupRadio — status card", () => {
  it("renders genuine vehicle, autopilot, transport, RSSI and channel count", async () => {
    renderRadio();
    await screen.findByTestId("setup-radio-status-card");

    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("QUADROTOR")).toBeInTheDocument();
    expect(screen.getByText("ARDUPILOTMEGA")).toBeInTheDocument();
    expect(screen.getByText("USB")).toBeInTheDocument();
    // rssi 255 is MAVLink's "RSSI unknown" sentinel, so the status strip must
    // label it as unavailable instead of printing a meaningless number.
    expect(screen.getByTestId("setup-radio-rssi")).toHaveTextContent("RSSI Unavailable");
    expect(screen.getByTestId("setup-radio-chancount")).toHaveTextContent("4");
  });

  // Transport comes from the backend connection manager and must be rendered
  // verbatim. Regression: the status strip used to show "USB" for every link.
  it.each([
    ["TCP", "SITL over TCP"],
    ["UDP", "SITL over UDP"],
    ["USB", "Pixhawk over USB serial"],
  ] as const)("reports the %s transport verbatim (%s)", async (transport, _label) => {
    setupMocks.getRadioStatus.mockResolvedValue(radioStatus({ transport }));
    renderRadio();
    await screen.findByTestId("setup-radio-status-card");
    expect(screen.getByText(transport)).toBeInTheDocument();
  });

  it.each([
    ["DISCONNECTED", "disconnected"],
    ["CONNECTING", "connecting"],
  ] as const)(
    "reports %s transport when there is no transport in use",
    async (transport, connectionState) => {
      setupMocks.getRadioStatus.mockResolvedValue(
        radioStatus({
          transport,
          connected: false,
          // The backend's raw vehicle_state is lowercase; only the socket
          // payload is uppercased. Fixtures must match the API payload.
          connectionState,
        }),
      );
      renderRadio();
      await screen.findByTestId("setup-radio-status-card");
      expect(screen.getByText(transport)).toBeInTheDocument();
    },
  );

  // A terminal stage is not part of the forward progress order. Without an
  // explicit chip it left the rail fully unhighlighted, which reads as
  // "nothing happened" instead of "calibration ended".
  it.each([
    ["FAILED", "failed"],
    ["CANCELLED", "cancelled"],
    ["DISCONNECTED", "idle"],
  ] as const)(
    "shows the %s stage on the calibration rail",
    async (stage, state) => {
      setupMocks.getRadioStatus.mockResolvedValue(
        radioStatus({
          calibrationStage: stage,
          calibration: { ...idleCalibration(), stage, state },
        }),
      );
      renderRadio();
      await screen.findByTestId("setup-radio-calibration");
      expect(screen.getByTestId("radio-cal-stage-terminal")).toHaveTextContent(stage);
    },
  );

  it("never marks SUCCESS without a genuine backend result", async () => {
    // A SUCCESS chip must not appear purely because a stage string says so; the
    // backend result has to back it.
    setupMocks.getRadioStatus.mockResolvedValue(
      radioStatus({
        calibrationStage: "SUCCESS",
        calibration: { ...idleCalibration(), stage: "SUCCESS", state: "completed" },
      }),
    );
    renderRadio();
    await screen.findByTestId("setup-radio-calibration");
    // No result payload => no success banner, even though stage says SUCCESS.
    expect(screen.queryByTestId("radio-cal-completed")).not.toBeInTheDocument();
    expect(screen.getByTestId("radio-cal-unverified")).toBeInTheDocument();
    expect(screen.queryByTestId(".radio-cal-success")).not.toBeInTheDocument();
  });

  it("shows SUCCESS only when the backend result confirms the write", async () => {
    setupMocks.getRadioStatus.mockResolvedValue(
      radioStatus({
        calibrationStage: "SUCCESS",
        calibration: {
          ...idleCalibration(),
          stage: "SUCCESS",
          state: "completed",
          message: "Radio calibration stored and verified on the vehicle.",
          result: {
            result: "success",
            message: "Radio calibration stored and verified on the vehicle.",
            values: [{ param: "RC1_MIN", value: 1100 }],
          },
        },
      }),
    );
    renderRadio();
    await screen.findByTestId("setup-radio-calibration");
    expect(screen.getByTestId("radio-cal-completed")).toBeInTheDocument();
    expect(screen.getByText(/stored and verified on the vehicle/)).toBeInTheDocument();
  });

  it("does not claim success when the backend result reports failure", async () => {
    setupMocks.getRadioStatus.mockResolvedValue(
      radioStatus({
        calibrationStage: "FAILED",
        calibration: {
          ...idleCalibration(),
          stage: "FAILED",
          state: "failed",
          message: "RC1_MIN was not confirmed by the vehicle.",
          result: { result: "failed", message: "RC1_MIN was not confirmed by the vehicle." },
        },
      }),
    );
    renderRadio();
    await screen.findByTestId("setup-radio-calibration");
    expect(screen.queryByTestId("radio-cal-completed")).not.toBeInTheDocument();
    expect(screen.getByTestId("radio-cal-failed")).toBeInTheDocument();
  });

  it("prints a real RSSI value only when the backend reports one", async () => {
    setupMocks.getRadioStatus.mockResolvedValue(
      radioStatus({
        rc: { channelCount: 4, rssi: 87, receivedAt: Date.now() / 1000, ageMs: 20, channels: [] },
        rcState: "RC_ACTIVE",
      }),
    );
    renderRadio();
    await screen.findByTestId("setup-radio-status-card");
    expect(screen.getByTestId("setup-radio-rssi")).toHaveTextContent("RSSI 87");
  });

  it("shows WAITING FOR TELEMETRY when no RC_CHANNELS frame has arrived", async () => {
    setupMocks.getRadioStatus.mockResolvedValue(
      radioStatus({ rc: { channelCount: 0, rssi: 0, receivedAt: 0, ageMs: null, channels: [] } })
    );
    renderRadio();
    await screen.findByTestId("setup-radio");
    expect(screen.getByTestId("setup-radio-signal")).toHaveTextContent("WAITING FOR TELEMETRY");
  });
});

describe("SetupRadio — channel monitor", () => {
  it("renders live bars from real telemetry with a Live badge", async () => {
    freshRc([1480, 1495, 1100, 1900]);
    renderRadio();

    await screen.findByTestId("setup-radio-monitor");
    expect(screen.getByTestId("setup-radio-live-badge")).toHaveTextContent("Live");
    expect(screen.getByTestId("setup-radio-signal")).toHaveTextContent("RECEIVING");
    expect(screen.getByTestId("radio-bar-value-1")).toHaveTextContent("1480");
    expect(screen.getByTestId("radio-bar-value-3")).toHaveTextContent("1100");
    expect(screen.getByTestId("setup-radio-last-update")).toHaveTextContent("fresh");
    expect(screen.getByTestId("radio-bar-1")).not.toHaveClass("radio-bar-stale");
  });

  it("dims the monitor as stale and shows NO SIGNAL when telemetry stops", async () => {
    telemetry.rcChannels = [1500, 1500, 1500, 1500];
    telemetry.rcChannelCount = 4;
    telemetry.rcRssi = 90;
    telemetry.rcReceivedAt = Date.now() / 1000 - 30; // 30s old
    renderRadio();

    await screen.findByTestId("setup-radio-monitor");
    expect(screen.getByTestId("radio-bar-1")).toHaveClass("radio-bar-stale");
    expect(screen.getByTestId("radio-bar-2")).toHaveClass("radio-bar-stale");
    expect(screen.getByTestId("setup-radio-last-update")).toHaveTextContent("stale");
    expect(screen.getByTestId("setup-radio-signal")).toHaveTextContent("NO SIGNAL");
  });

  it("treats fresh frames with rssi 0 as NO SIGNAL (ArduPilot semantics)", async () => {
    freshRc([1500, 1500, 1500, 1500], 0);
    renderRadio();

    await screen.findByTestId("setup-radio-monitor");
    expect(screen.getByTestId("setup-radio-signal")).toHaveTextContent("NO SIGNAL");
    expect(screen.getByTestId("radio-bar-1")).toHaveClass("radio-bar-stale");
  });

  it("shows an honest no-data notice rather than fake 1500 values", async () => {
    setupMocks.getRadioStatus.mockResolvedValue(
      radioStatus({ rc: { channelCount: 0, rssi: 0, receivedAt: 0, ageMs: null, channels: [] } })
    );
    renderRadio();
    await screen.findByTestId("setup-radio-no-channels");
    expect(screen.getByText(/Waiting for the first RC_CHANNELS frame/)).toBeInTheDocument();
    expect(screen.queryByTestId("radio-bar-1")).not.toBeInTheDocument();
  });
});

describe("SetupRadio — main control channels", () => {
  it("maps major axes from genuine RCMAP parameters", async () => {
    renderRadio();
    await screen.findByTestId("setup-radio-maincontrols");

    const roll = screen.getByTestId("setup-radio-map-roll");
    expect(roll).toHaveTextContent("RCMAP_ROLL");
    expect(roll).toHaveTextContent("CH1");
    expect(screen.getByTestId("setup-radio-map-throttle")).toHaveTextContent("CH3");
    expect(screen.getByTestId("setup-radio-map-yaw")).toHaveTextContent("CH4");
  });

  it("falls back to an unavailable notice when RCMAP params are missing", async () => {
    setupMocks.getRadioStatus.mockResolvedValue(
      radioStatus({ mainControls: { supported: false, mappings: [] } })
    );
    renderRadio();
    expect(await screen.findByTestId("setup-radio-map-unavailable")).toBeInTheDocument();
    expect(screen.getByText(/RCMAP parameters were not found/)).toBeInTheDocument();
  });
});

describe("SetupRadio — channel configuration", () => {
  it("renders MIN/TRIM/MAX/Reversed fields with live vehicle values", async () => {
    renderRadio();
    await screen.findByTestId("setup-radio-config");

    expect((screen.getByTestId("radio-config-min-1") as HTMLInputElement).value).toBe("1100");
    expect((screen.getByTestId("radio-config-trim-1") as HTMLInputElement).value).toBe("1500");
    expect((screen.getByTestId("radio-config-max-4") as HTMLInputElement).value).toBe("1900");
    expect((screen.getByTestId("radio-config-reversed-1") as HTMLInputElement).checked).toBe(false);
  });

  it("keeps edits local and does not write before Apply", async () => {
    const user = userEvent.setup();
    renderRadio();
    await waitForConfig();

    const input = screen.getByTestId("radio-config-trim-1");
    await user.clear(input);
    await user.type(input, "1600");

    expect((screen.getByTestId("radio-config-trim-1") as HTMLInputElement).value).toBe("1600");
    // Nothing was staged or written yet — Apply is what stages and verifies.
    expect(screen.queryByText(/radio value staged/)).not.toBeInTheDocument();
    expect(apiMocks.writeBatch).not.toHaveBeenCalled();
  });

  it("rejects MIN >= TRIM before writing anything", async () => {
    const user = userEvent.setup();
    renderRadio();
    await waitForConfig();

    const input = screen.getByTestId("radio-config-min-1");
    await user.clear(input);
    await user.type(input, "1600");
    await user.click(screen.getByTestId("radio-config-apply"));

    expect(await screen.findByTestId("radio-config-error")).toHaveTextContent(
      /must be less than TRIM/
    );
    expect(apiMocks.writeBatch).not.toHaveBeenCalled();
  });

  it("rejects endpoint values outside the 900–2200 µs range", async () => {
    const user = userEvent.setup();
    renderRadio();
    await waitForConfig();

    const input = screen.getByTestId("radio-config-max-1");
    await user.clear(input);
    await user.type(input, "2400");
    await user.click(screen.getByTestId("radio-config-apply"));

    expect(await screen.findByTestId("radio-config-error")).toHaveTextContent(/900–2200/);
    expect(apiMocks.writeBatch).not.toHaveBeenCalled();
  });

  it("applies channels through the verified write pipeline and shows verified values", async () => {
    const user = userEvent.setup();
    const expected = [
      { paramId: "RC1_TRIM", value: 1600 },
      { paramId: "RC1_MAX", value: 1800 },
    ];
    apiMocks.writeBatch.mockResolvedValue(successTxn(expected));
    renderRadio();
    await waitForConfig();

    const trim = screen.getByTestId("radio-config-trim-1");
    await user.clear(trim);
    await user.type(trim, "1600");
    const max = screen.getByTestId("radio-config-max-1");
    await user.clear(max);
    await user.type(max, "1800");
    await user.click(screen.getByTestId("radio-config-apply"));

    await waitFor(() => {
      expect(apiMocks.writeBatch).toHaveBeenCalledTimes(1);
    });
    const [items] = apiMocks.writeBatch.mock.calls[0] as [{ paramId: string; value: number }[]];
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ paramId: "RC1_TRIM", value: 1600 }),
        expect.objectContaining({ paramId: "RC1_MAX", value: 1800 }),
      ])
    );

    expect(await screen.findByTestId("radio-config-write-success")).toBeInTheDocument();
    expect(screen.getByText(/verified on the vehicle/)).toBeInTheDocument();
    await waitFor(() => {
      expect((screen.getByTestId("radio-config-trim-1") as HTMLInputElement).value).toBe("1600");
      expect((screen.getByTestId("radio-config-max-1") as HTMLInputElement).value).toBe("1800");
    });
    expect(screen.queryByText(/radio value staged/)).not.toBeInTheDocument();
  });

  it("reports a failed write and preserves the previous values", async () => {
    const user = userEvent.setup();
    apiMocks.writeBatch.mockRejectedValue(new Error("write timeout"));
    renderRadio();
    await waitForConfig();

    const trim = screen.getByTestId("radio-config-trim-2");
    await user.clear(trim);
    await user.type(trim, "1700");
    await user.click(screen.getByTestId("radio-config-apply"));

    expect(await screen.findByTestId("radio-config-write-error")).toBeInTheDocument();
    await waitFor(() => {
      expect((screen.getByTestId("radio-config-trim-2") as HTMLInputElement).value).toBe("1500");
    });
  });

  it("reverts edited values without writing", async () => {
    const user = userEvent.setup();
    renderRadio();
    await waitForConfig();

    const max = screen.getByTestId("radio-config-max-3");
    await user.clear(max);
    await user.type(max, "2000");
    expect((screen.getByTestId("radio-config-max-3") as HTMLInputElement).value).toBe("2000");

    await user.click(screen.getByTestId("radio-config-revert"));

    await waitFor(() => {
      expect((screen.getByTestId("radio-config-max-3") as HTMLInputElement).value).toBe("1900");
    });
    expect(apiMocks.writeBatch).not.toHaveBeenCalled();
  });
});

describe("SetupRadio — radio calibration", () => {
  it("starts the wizard and advances to the ready step", async () => {
    const user = userEvent.setup();
    setupMocks.startRadioCalibration.mockResolvedValue({
      success: true,
      state: "ready",
      message: "",
    });
    renderRadio();
    await screen.findByTestId("setup-radio-calibration");
    expect(screen.getByTestId("radio-cal-idle")).toBeInTheDocument();

    await user.click(screen.getByTestId("radio-cal-start"));
    expect(await screen.findByTestId("radio-cal-ready")).toBeInTheDocument();
    expect(setupMocks.startRadioCalibration).toHaveBeenCalledTimes(1);
  });

  it("warns that RC signal is required but still allows starting", async () => {
    renderRadio();
    await screen.findByTestId("setup-radio-calibration");
    expect(screen.getByTestId("radio-cal-no-signal")).toBeInTheDocument();
    // Capture buttons for later steps stay disabled until signal arrives.
    expect(screen.queryByTestId("radio-cal-capture-center")).not.toBeInTheDocument();
  });

  it("captures center, min then max and completes with verified values", async () => {
    const user = userEvent.setup();
    freshRc([1500, 1500, 1500, 1500]);
    setupMocks.startRadioCalibration.mockResolvedValue({
      success: true,
      state: "ready",
      message: "",
    });
    setupMocks.captureRadioPhase.mockResolvedValueOnce({
      success: true,
      state: "capturing-center",
      message: "Capturing center…",
    });
    setupMocks.captureRadioPhase.mockResolvedValueOnce({
      success: true,
      state: "capturing-min",
      message: "Capturing minimum…",
    });
    setupMocks.captureRadioPhase.mockResolvedValueOnce({
      success: true,
      state: "capturing-max",
      message: "Capturing maximum…",
    });
    setupMocks.getRadioCalibrationStatus
      .mockResolvedValueOnce({ ...idleCalibration(), state: "center-done" })
      .mockResolvedValueOnce({ ...idleCalibration(), state: "min-done" })
      .mockResolvedValueOnce({
        ...idleCalibration(),
        state: "completed",
        result: {
          result: "success",
          message: "Calibration complete.",
          values: [
            { param: "RC1_MIN", value: 1100 },
            { param: "RC1_TRIM", value: 1500 },
            { param: "RC1_MAX", value: 1900 },
          ],
        },
      });
    renderRadio();
    await screen.findByTestId("setup-radio-calibration");

    await user.click(screen.getByTestId("radio-cal-start"));
    expect(await screen.findByTestId("radio-cal-ready")).toBeInTheDocument();

    await user.click(screen.getByTestId("radio-cal-capture-center"));
    expect(await screen.findByTestId("radio-cal-center-done")).toBeInTheDocument();

    await user.click(screen.getByTestId("radio-cal-capture-min"));
    expect(await screen.findByTestId("radio-cal-min-done")).toBeInTheDocument();

    await user.click(screen.getByTestId("radio-cal-capture-max"));
    expect(await screen.findByTestId("radio-cal-completed")).toBeInTheDocument();
    const completed = screen.getByTestId("radio-cal-completed");
    expect(completed).toHaveTextContent("RC1_TRIM");
    expect(completed).toHaveTextContent("1500");
    expect(screen.getByTestId("radio-cal-restart")).toBeInTheDocument();
  });

  it("shows a timeout failure and lets the user restart", async () => {
    const user = userEvent.setup();
    freshRc([1500, 1500, 1500, 1500]);
    setupMocks.startRadioCalibration.mockResolvedValue({
      success: true,
      state: "ready",
      message: "",
    });
    setupMocks.captureRadioPhase.mockResolvedValue({
      success: true,
      state: "validating",
      message: "",
    });
    setupMocks.getRadioCalibrationStatus.mockResolvedValueOnce({
      ...idleCalibration(),
      state: "timeout",
      message: "No valid RC frames received on time.",
    });
    renderRadio();
    await screen.findByTestId("setup-radio-calibration");

    await user.click(screen.getByTestId("radio-cal-start"));
    await user.click(await screen.findByTestId("radio-cal-capture-center"));

    expect(await screen.findByTestId("radio-cal-timeout")).toBeInTheDocument();
    expect(screen.getByText("No valid RC frames received on time.")).toBeInTheDocument();

    await user.click(screen.getByTestId("radio-cal-restart-failed"));
    expect(await screen.findByTestId("radio-cal-ready")).toBeInTheDocument();
    expect(setupMocks.startRadioCalibration).toHaveBeenCalledTimes(2);
  });

  it("handles progress events pushed over the socket during captures", async () => {
    renderRadio();
    await screen.findByTestId("setup-radio-calibration");

    emitter.emit("radio:calibration:progress", {
      state: "capturing-min",
      progress: { phase: "min", frames: 12 },
    });

    expect(await screen.findByTestId("radio-cal-capturing-min")).toBeInTheDocument();
    expect(screen.getByText(/Capturing/)).toBeInTheDocument();
  });

  it("resets the wizard when the MAVLink link is lost mid-calibration", async () => {
    const user = userEvent.setup();
    freshRc([1500, 1500, 1500, 1500]);
    setupMocks.startRadioCalibration.mockResolvedValue({
      success: true,
      state: "ready",
      message: "",
    });
    const view = renderRadio();
    await screen.findByTestId("setup-radio-calibration");
    await user.click(screen.getByTestId("radio-cal-start"));
    expect(await screen.findByTestId("radio-cal-ready")).toBeInTheDocument();

    telemetry.connected = false;
    telemetry.connectionState = "DISCONNECTED";
    telemetry.disconnectReason = "radio timeout";
    view.rerender(
      <ParameterProvider>
        <SetupRadio />
      </ParameterProvider>
    );

    expect(await screen.findByTestId("setup-radio-lost")).toBeInTheDocument();
    expect(await screen.findByTestId("setup-radio-connection-lost")).toBeInTheDocument();
  });
});

describe("SetupRadio — RCMAP mapping edits", () => {
  beforeEach(() => {
    readyDefaults();
    withParams([...radioParams(), ...mappingParams()]);
  });

  it("shows the genuine RCMAP parameter and channel for every major axis", async () => {
    renderRadio();
    await waitForConfig();
    for (const axis of ["roll", "pitch", "throttle", "yaw"]) {
      const row = screen.getByTestId(`setup-radio-map-${axis}`);
      expect(row).toBeInTheDocument();
    }
    expect(screen.getByTestId("setup-radio-map-roll")).toHaveTextContent("RCMAP_ROLL");
    expect(screen.getByTestId("setup-radio-map-roll")).toHaveTextContent("CH1");
    expect(screen.getByTestId("setup-radio-map-yaw")).toHaveTextContent("CH4");
  });

  it("stages a mapping change locally and sends nothing before Apply", async () => {
    const user = userEvent.setup();
    renderRadio();
    await waitForConfig();

    const input = screen.getByTestId("setup-radio-map-input-roll");
    await user.clear(input);
    await user.type(input, "6");

    // The vehicle is untouched until Apply is pressed.
    expect(apiMocks.writeBatch).not.toHaveBeenCalled();
    expect(screen.getByTestId("setup-radio-map-current-roll")).toHaveTextContent("PENDING 6");
    expect(screen.getByTestId("setup-radio-map-current-roll")).toHaveTextContent("current 1");
    expect(screen.getByTestId("setup-radio-map-actions")).toBeInTheDocument();
  });

  it("applies the mapping through the verified write pipeline and echoes it back", async () => {
    const user = userEvent.setup();
    apiMocks.writeBatch.mockResolvedValue(successTxn([{ paramId: "RCMAP_ROLL", value: 6 }]));
    renderRadio();
    await waitForConfig();

    const input = screen.getByTestId("setup-radio-map-input-roll");
    await user.clear(input);
    await user.type(input, "6");
    await user.click(screen.getByTestId("setup-radio-map-apply"));

    await waitFor(() => {
      expect(apiMocks.writeBatch).toHaveBeenCalledTimes(1);
    });
    const [items] = apiMocks.writeBatch.mock.calls[0] as [{ paramId: string; value: number }[]];
    expect(items).toEqual([expect.objectContaining({ paramId: "RCMAP_ROLL", value: 6 })]);
    expect(await screen.findByTestId("setup-radio-map-write-success")).toBeInTheDocument();
  });

  it("reverts a staged mapping without writing to the vehicle", async () => {
    const user = userEvent.setup();
    renderRadio();
    await waitForConfig();

    const input = screen.getByTestId("setup-radio-map-input-roll");
    await user.clear(input);
    await user.type(input, "6");
    expect(screen.getByTestId("setup-radio-map-current-roll")).toHaveTextContent("PENDING 6");

    await user.click(screen.getByTestId("setup-radio-map-revert"));
    expect(apiMocks.writeBatch).not.toHaveBeenCalled();
    expect(screen.getByTestId("setup-radio-map-current-roll")).toHaveTextContent("CURRENT 1");
  });

  it("rejects an out-of-range mapping channel without staging it", async () => {
    const user = userEvent.setup();
    renderRadio();
    await waitForConfig();

    const input = screen.getByTestId("setup-radio-map-input-roll");
    await user.clear(input);
    await user.type(input, "99");

    // Nothing is staged: the intermediate "9" keystroke must be discarded so
    // the PENDING badge can never contradict the field contents.
    expect(screen.getByTestId("setup-radio-map-current-roll")).toHaveTextContent("CURRENT 1");
    expect(screen.queryByTestId("setup-radio-map-actions")).not.toBeInTheDocument();
    expect(screen.getByTestId("radio-config-error")).toHaveTextContent(
      "channel must be a whole number between 1 and 16",
    );
    expect(apiMocks.writeBatch).not.toHaveBeenCalled();
  });

  it("warns that a reboot is required only when the vehicle metadata says so", async () => {
    const user = userEvent.setup();
    apiMocks.getAllParameters.mockResolvedValue({
      success: true,
      connection: "READY",
      sync: statusView().sync,
      metadata: metadataAvailable,
      vehicle: { vehicleType: "QUADROTOR" },
      count: 1,
      parameters: [
        entry({
          id: "RCMAP_ROLL",
          live: { value: 1, type: "INT16", index: 0, count: 1, received: true },
          metadata: makeMetadata({
            id: "RCMAP_ROLL",
            name: "RCMAP_ROLL",
            min: null,
            max: null,
            increment: null,
            group: "Radio",
            rebootRequired: true,
          }),
          metadataMissing: false,
        }),
      ],
    });    renderRadio();
    await waitForConfig();

    const input = screen.getByTestId("setup-radio-map-input-roll");
    await user.clear(input);
    await user.type(input, "6");
    expect(await screen.findByTestId("setup-radio-map-reboot-warning")).toBeInTheDocument();
  });
});

describe("SetupRadio — additional radio setup (capability driven)", () => {
  beforeEach(() => {
    readyDefaults();
  });

  it("reports unsupported when the firmware exposes no function-assignment parameters", async () => {
    setupMocks.getRadioStatus.mockResolvedValue(
      radioStatus({
        auxChannels: {
          supported: false,
          channels: [
            {
              channel: 5,
              param: null,
              label: null,
              supported: false,
              isMainControl: false,
              value: null,
              options: [],
              unavailableReason: "RC5_OPTION not present on this firmware.",
            },
          ],
        },
      }),
    );
    renderRadio();
    await waitForConfig();
    expect(await screen.findByTestId("setup-radio-aux-unsupported")).toBeInTheDocument();
    expect(screen.queryByTestId("setup-radio-aux-grid")).not.toBeInTheDocument();
  });

  it("never lists a main control channel as an additional function", async () => {
    setupMocks.getRadioStatus.mockResolvedValue(
      radioStatus({
        auxChannels: {
          supported: true,
          channels: [
            {
              channel: 1,
              param: "RC1_OPTION",
              label: "RC1_OPTION",
              supported: true,
              isMainControl: true,
              value: 0,
              options: [{ value: 0, label: "Disabled" }],
              unavailableReason: null,
            },
            {
              channel: 5,
              param: "RC5_OPTION",
              label: "RC5_OPTION",
              supported: true,
              isMainControl: false,
              value: 0,
              options: [
                { value: 0, label: "Disabled" },
                { value: 1, label: "Servo" },
              ],
              unavailableReason: null,
            },
          ],
        },
      }),
    );
    renderRadio();
    await waitForConfig();
    const grid = await screen.findByTestId("setup-radio-aux-grid");
    expect(grid).toHaveTextContent("CH5");
    expect(screen.queryByTestId("setup-radio-aux-select-1")).not.toBeInTheDocument();
  });

  it("stages an aux function assignment and applies it through the verified pipeline", async () => {
    const user = userEvent.setup();
    apiMocks.getAllParameters.mockResolvedValue({
      success: true,
      connection: "READY",
      sync: statusView().sync,
      metadata: metadataAvailable,
      vehicle: { vehicleType: "QUADROTOR" },
      count: 1,
      parameters: [
        entry({
          id: "RC5_OPTION",
          live: { value: 0, type: "INT16", index: 0, count: 1, received: true },
          metadata: makeMetadata({
            id: "RC5_OPTION",
            name: "RC5 OPTION",
            min: null,
            max: null,
            increment: null,
            group: "Radio",
          }),
          metadataMissing: false,
        }),
      ],
    });
    apiMocks.writeBatch.mockResolvedValue(successTxn([{ paramId: "RC5_OPTION", value: 1 }]));
    renderRadio();
    await waitForConfig();

    const select = await screen.findByTestId("setup-radio-aux-select-5");
    await user.selectOptions(select, "1");

    // Staging alone must not touch the vehicle.
    expect(apiMocks.writeBatch).not.toHaveBeenCalled();
    expect(screen.getByTestId("setup-radio-aux-staged")).toBeInTheDocument();

    await user.click(screen.getByTestId("setup-radio-aux-apply"));
    await waitFor(() => {
      expect(apiMocks.writeBatch).toHaveBeenCalledTimes(1);
    });
    const [items] = apiMocks.writeBatch.mock.calls[0] as [{ paramId: string; value: number }[]];
    expect(items).toEqual([expect.objectContaining({ paramId: "RC5_OPTION", value: 1 })]);
    expect(await screen.findByTestId("setup-radio-aux-write-success")).toBeInTheDocument();
  });

  it("does not show an aux success banner for an unrelated channel write", async () => {
    const user = userEvent.setup();
    apiMocks.writeBatch.mockResolvedValue(successTxn([{ paramId: "RC1_TRIM", value: 1600 }]));
    renderRadio();
    await waitForConfig();

    const trim = screen.getByTestId("radio-config-trim-1");
    await user.clear(trim);
    await user.type(trim, "1600");
    await user.click(screen.getByTestId("radio-config-apply"));

    expect(await screen.findByTestId("radio-config-write-success")).toBeInTheDocument();
    expect(screen.queryByTestId("setup-radio-aux-write-success")).not.toBeInTheDocument();
  });

  it("names PX4-only controls as unsupported instead of faking them", async () => {
    renderRadio();
    await waitForConfig();
    expect(screen.getByText(/Spectrum Bind · Unsupported on ArduCopter/)).toBeInTheDocument();
    expect(screen.getByText(/Copy Trims · Unsupported on ArduCopter/)).toBeInTheDocument();
  });
});

describe("SetupRadio — transmitter visualization", () => {
  beforeEach(() => {
    readyDefaults();
  });

  it("offers all four standard mode layouts", async () => {
    renderRadio();
    await waitForConfig();
    for (const mode of ["1", "2", "3", "4"] as const) {
      expect(screen.getByTestId(`setup-radio-mode-${mode}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId("setup-radio-mode-1")).toHaveAttribute("aria-pressed", "true");
  });

  it("switches the drawn layout without altering the RCMAP mapping", async () => {
    const user = userEvent.setup();
    freshRc([1500, 1500, 1500, 1500]);
    renderRadio();
    await waitForConfig();

    await user.click(screen.getByTestId("setup-radio-mode-4"));
    expect(screen.getByTestId("setup-radio-mode-4")).toHaveAttribute("aria-pressed", "true");
    // Mode is presentation only: no parameter write and no mapping change.
    expect(apiMocks.writeBatch).not.toHaveBeenCalled();
    expect(screen.getByTestId("setup-radio-map-roll")).toHaveTextContent("CH1");
    expect(screen.getByTestId("setup-radio-mode-note")).toHaveTextContent("never altered");
  });

  it("parks the stick markers with no live input instead of inventing values", async () => {
    renderRadio();
    await waitForConfig();
    const visual = screen.getByTestId("setup-radio-transmitter");
    expect(visual).toHaveTextContent("Mode 1");
  });
});

describe("SetupRadio — calibration stage rail", () => {
  beforeEach(() => {
    readyDefaults();
  });

  it("starts in IDLE and reports WAITING FOR RC without live telemetry", async () => {
    renderRadio();
    await screen.findByTestId("setup-radio-calibration");
    expect(screen.getByTestId("radio-cal-stage-idle")).toHaveClass("is-current");
    expect(screen.getByTestId("radio-cal-stage-waiting")).toBeInTheDocument();
  });

  it("renders every requested calibration stage chip", async () => {
    renderRadio();
    await screen.findByTestId("setup-radio-calibration");
    for (const stage of ["idle", "ready", "calibrating", "finalizing", "success"]) {
      expect(screen.getByTestId(`radio-cal-stage-${stage}`)).toBeInTheDocument();
    }
  });
});
