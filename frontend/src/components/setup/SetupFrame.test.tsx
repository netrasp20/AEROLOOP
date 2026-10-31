import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ParameterProvider, useParameters } from "../../context/ParameterContext";
import SetupFrame from "./SetupFrame";

import { entry, makeMetadata, metadataAvailable, statusView } from "../../test/fixtures";
import { FRAME_CLASS_PARAM, FRAME_TYPE_PARAM } from "./frameLogic";

const { emitter, apiMocks, telemetry } = vi.hoisted(() => {
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
  return { ...actual, ...apiMocks };
});

vi.mock("../../socket/socket", () => ({ default: emitter }));

vi.mock("../../hooks/useTelemetry", () => ({
  useTelemetry: () => telemetry,
}));

const COPTER_CLASS_VALUES = {
  "0": "Undefined",
  "1": "Quad",
  "2": "Hexa",
  "3": "Octa",
  "4": "OctaQuad",
};

const COPTER_TYPE_VALUES = { "0": "Plus", "1": "X", "2": "V" };

const frameParams = [
  entry({
    id: FRAME_CLASS_PARAM,
    live: { value: 1, type: "UINT8", index: 1, count: 1379, received: true },
    metadata: makeMetadata({
      id: FRAME_CLASS_PARAM,
      name: "Frame Class",
      values: COPTER_CLASS_VALUES,
      rebootRequired: true,
      group: "ArduCopter",
      source: "copter.xml",
    }),
    metadataMissing: false,
  }),
  entry({
    id: FRAME_TYPE_PARAM,
    live: { value: 1, type: "UINT8", index: 2, count: 1379, received: true },
    metadata: makeMetadata({
      id: FRAME_TYPE_PARAM,
      name: "Frame Type",
      values: COPTER_TYPE_VALUES,
      rebootRequired: true,
      group: "ArduCopter",
      source: "copter.xml",
    }),
    metadataMissing: false,
  }),
];

function renderFrame() {
  return render(
    <ParameterProvider>
      <SetupFrame />
    </ParameterProvider>
  );
}

function readyDefaults() {
  apiMocks.getParameterStatus.mockResolvedValue(statusView());
  apiMocks.getAllParameters.mockResolvedValue({
    success: true,
    connection: "READY",
    sync: statusView().sync,
    metadata: metadataAvailable,
    vehicle: { vehicleType: "QUADROTOR" },
    count: frameParams.length,
    parameters: frameParams,
  });
  apiMocks.getMetadataOverview.mockResolvedValue({
    success: true,
    vehicle: "copter",
    metadataStatus: metadataAvailable,
    groups: ["ArduCopter"],
  });
  apiMocks.refreshParameters.mockResolvedValue({ success: true, sync: statusView().sync });
}

const SUCCESS_TXN = {
  transaction: {
    transactionId: "txn1",
    sessionId: "abc123",
    status: "success",
    total: 2,
    succeeded: 2,
    failed: 0,
    notAttempted: 0,
    results: [
      { paramId: FRAME_CLASS_PARAM, requestedValue: 2, originalValue: 1, status: "success", verifiedValue: 2, code: null, message: null },
      { paramId: FRAME_TYPE_PARAM, requestedValue: 1, originalValue: 0, status: "success", verifiedValue: 1, code: null, message: null },
    ],
  },
};

beforeEach(() => {
  window.localStorage.clear();
  telemetry.connected = true;
  readyDefaults();
  apiMocks.writeBatch.mockResolvedValue({ success: true, ...SUCCESS_TXN });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SetupFrame — connected vehicle", () => {
  it("renders frame selectors with live current values and metadata options", async () => {
    renderFrame();
    await screen.findByTestId("setup-frame");

    expect(screen.getByTestId("frame-field-FRAME_CLASS")).toBeInTheDocument();
    expect(screen.getByTestId("frame-field-FRAME_TYPE")).toBeInTheDocument();

    const classCurrent = screen.getByTestId("frame-current-FRAME_CLASS");
    expect(classCurrent).toHaveTextContent("Quad");
    expect(classCurrent).toHaveTextContent("(1)");
    expect(screen.getByTestId("frame-current-FRAME_TYPE")).toHaveTextContent("X");

    // Options come from metadata (OctaQuad code 4, V type code 2).
    const classSelect = screen.getByTestId("frame-select-FRAME_CLASS") as HTMLSelectElement;
    const options = Array.from(classSelect.options).map((o) => o.textContent);
    expect(options).toContain("OctaQuad");
  });

  it("does not write anything before Apply is pressed", async () => {
    const user = userEvent.setup();
    renderFrame();
    await screen.findByTestId("setup-frame");

    await user.selectOptions(
      screen.getByTestId("frame-select-FRAME_CLASS"),
      "2" // Hexa
    );

    // Pending staged shown, vehicle untouched.
    expect(screen.getByTestId("frame-pending-FRAME_CLASS")).toHaveTextContent("Hexa");
    expect(screen.getByTestId("frame-current-FRAME_CLASS")).toHaveTextContent("Quad");
    expect(await screen.findByTestId("frame-apply-card")).toBeInTheDocument();
    expect(apiMocks.writeBatch).not.toHaveBeenCalled();
  });

  it("stages and applies both frame values with verified write", async () => {
    const user = userEvent.setup();
    renderFrame();
    await screen.findByTestId("setup-frame");

    await user.selectOptions(screen.getByTestId("frame-select-FRAME_CLASS"), "2");
    await user.selectOptions(screen.getByTestId("frame-select-FRAME_TYPE"), "0");

    await user.click(await screen.findByTestId("frame-apply"));

    await waitFor(() => {
      expect(apiMocks.writeBatch).toHaveBeenCalledTimes(1);
    });
    const [items] = apiMocks.writeBatch.mock.calls[0];
    expect(items).toEqual([
      expect.objectContaining({ paramId: FRAME_CLASS_PARAM, value: 2 }),
      expect.objectContaining({ paramId: FRAME_TYPE_PARAM, value: 0 }),
    ]);

    expect(await screen.findByTestId("frame-write-result")).toBeInTheDocument();
    expect(screen.getByText("Saved. Reboot required.")).toBeInTheDocument();
    // Verified value reflected as the new current state.
    expect(await screen.findByTestId("frame-current-FRAME_CLASS")).toHaveTextContent("Hexa");
    expect(screen.queryByTestId("frame-apply-card")).not.toBeInTheDocument();
  });

  it("reverts staged changes to the live vehicle values without writing", async () => {
    const user = userEvent.setup();
    renderFrame();
    await screen.findByTestId("setup-frame");

    await user.selectOptions(screen.getByTestId("frame-select-FRAME_CLASS"), "2");
    expect(await screen.findByTestId("frame-apply-card")).toBeInTheDocument();

    await user.click(screen.getByTestId("frame-revert"));

    await waitFor(() => {
      expect(screen.queryByTestId("frame-pending-FRAME_CLASS")).not.toBeInTheDocument();
    });
    expect(screen.queryByTestId("frame-apply-card")).not.toBeInTheDocument();
    expect(screen.getByTestId("frame-current-FRAME_CLASS")).toHaveTextContent("Quad");
    expect(apiMocks.writeBatch).not.toHaveBeenCalled();
  });

  it("shows the reboot warning when a staged frame change requires one", async () => {
    const user = userEvent.setup();
    renderFrame();
    await screen.findByTestId("setup-frame");

    expect(screen.queryByTestId("frame-reboot-warning")).not.toBeInTheDocument();

    await user.selectOptions(screen.getByTestId("frame-select-FRAME_CLASS"), "2");
    expect(await screen.findByTestId("frame-reboot-warning")).toBeInTheDocument();
    expect(screen.getByText(/may require a vehicle reboot/)).toBeInTheDocument();
  });

  it("reports a partial write failure and stops, keeping live value intact", async () => {
    const user = userEvent.setup();
    apiMocks.writeBatch.mockResolvedValue({
      success: true,
      transaction: {
        transactionId: "txn2",
        sessionId: "abc123",
        status: "partial_failure",
        total: 2,
        succeeded: 1,
        failed: 1,
        notAttempted: 0,
        results: [
          { paramId: FRAME_CLASS_PARAM, requestedValue: 2, originalValue: 1, status: "success", verifiedValue: 2, code: null, message: null },
          { paramId: FRAME_TYPE_PARAM, requestedValue: 0, originalValue: 1, status: "failed", code: "WRITE_MISMATCH", message: "Echo mismatch" },
        ],
      },
    });
    renderFrame();
    await screen.findByTestId("setup-frame");

    await user.selectOptions(screen.getByTestId("frame-select-FRAME_CLASS"), "2");
    await user.selectOptions(screen.getByTestId("frame-select-FRAME_TYPE"), "0");
    await user.click(await screen.findByTestId("frame-apply"));

    expect(await screen.findByTestId("frame-write-result")).toBeInTheDocument();
    expect(screen.getByText(/Partially saved/)).toBeInTheDocument();
    // The failed param keeps its staged state available for retry.
    expect(screen.getByTestId("frame-pending-FRAME_TYPE")).toBeInTheDocument();
  });
});

describe("SetupFrame — validation", () => {
  it("rejects an out-of-enum frame class through the shared store validator", async () => {
    function Probe() {
      void useParameters;
      return null;
    }
    // Use the provider directly: stageValue is the exact path the select uses.
    function Harness() {
      const store = useParameters();
      const result = store.stageValue(FRAME_CLASS_PARAM, 999); // not in metadata values
      return (
        <div data-testid="probe">
          {result.ok ? "ok" : `rejected: ${result.error ?? ""}`}
        </div>
      );
    }
    render(
      <ParameterProvider>
        <Harness />
        <Probe />
      </ParameterProvider>
    );
    await waitFor(() => {
      expect(screen.getByTestId("probe").textContent).toContain("rejected");
    });
  });
});

describe("SetupFrame — unsupported firmware", () => {
  it("shows an informative state when no frame parameters exist", async () => {
    apiMocks.getAllParameters.mockResolvedValue({
      success: true,
      connection: "READY",
      sync: statusView().sync,
      metadata: metadataAvailable,
      vehicle: { vehicleType: "QUADROTOR" },
      count: 0,
      parameters: [],
    });
    renderFrame();
    expect(await screen.findByTestId("setup-frame-unsupported")).toBeInTheDocument();
    expect(screen.getByText(/not exposed by the connected firmware/)).toBeInTheDocument();
    expect(screen.queryByTestId("frame-field-FRAME_CLASS")).not.toBeInTheDocument();
  });
});

describe("SetupFrame — disconnected / reconnect", () => {
  it("shows the disconnected state with no live values", async () => {
    telemetry.connected = false;
    apiMocks.getParameterStatus.mockResolvedValue(
      statusView({ connection: "DISCONNECTED", sessionId: null })
    );
    apiMocks.getAllParameters.mockResolvedValue({
      success: true,
      connection: "DISCONNECTED",
      sync: statusView().sync,
      metadata: metadataAvailable,
      vehicle: { vehicleType: "QUADROTOR" },
      count: 0,
      parameters: [],
    });
    renderFrame();
    expect(await screen.findByTestId("setup-frame-disconnected")).toBeInTheDocument();
    expect(screen.queryByTestId("frame-field-FRAME_CLASS")).not.toBeInTheDocument();
  });

  it("still allows reverting locally staged changes while disconnected", async () => {
    const user = userEvent.setup();
    const view = renderFrame();
    await screen.findByTestId("setup-frame");

    await user.selectOptions(screen.getByTestId("frame-select-FRAME_CLASS"), "2");
    expect(await screen.findByTestId("frame-pending-FRAME_CLASS")).toBeInTheDocument();

    // Simulate connection loss.
    telemetry.connected = false;
    view.rerender(
      <ParameterProvider>
        <SetupFrame />
      </ParameterProvider>
    );

    expect(await screen.findByTestId("setup-frame-disconnected")).toBeInTheDocument();
    await user.click(screen.getByTestId("setup-frame-revert-disconnected"));
    expect(apiMocks.writeBatch).not.toHaveBeenCalled();
  });

  it("reloads and shows live vehicle values again after reconnect", async () => {
    const view = renderFrame();
    await screen.findByTestId("setup-frame");

    telemetry.connected = false;
    view.rerender(
      <ParameterProvider>
        <SetupFrame />
      </ParameterProvider>
    );
    expect(await screen.findByTestId("setup-frame-disconnected")).toBeInTheDocument();

    // Reconnect: shared store re-syncs; page follows telemetry.
    telemetry.connected = true;
    view.rerender(
      <ParameterProvider>
        <SetupFrame />
      </ParameterProvider>
    );
    expect(await screen.findByTestId("frame-field-FRAME_CLASS")).toBeInTheDocument();
    expect(screen.getByTestId("frame-current-FRAME_CLASS")).toHaveTextContent("Quad");
  });
});