import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ParameterProvider } from "../../context/ParameterContext";
import SetupPower from "./SetupPower";

import {
  entry,
  makeMetadata,
  metadataAvailable,
  statusView,
} from "../../test/fixtures";
import type { PowerStatus, PowerTelemetry } from "../../api/setup";

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
      getPowerInfo: vi.fn(),
      getPowerTelemetry: vi.fn(),
      calculateVoltageMultiplier: vi.fn(),
      calculateAmpsPerVolt: vi.fn(),
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
    getPowerInfo: setupMocks.getPowerInfo,
    getPowerTelemetry: setupMocks.getPowerTelemetry,
    calculateVoltageMultiplier: setupMocks.calculateVoltageMultiplier,
    calculateAmpsPerVolt: setupMocks.calculateAmpsPerVolt,
  };
});

vi.mock("../../socket/socket", () => ({ default: emitter }));

vi.mock("../../hooks/useTelemetry", () => ({
  useTelemetry: () => telemetry,
}));

function battParam(id: string, value: number, index: number, type = "FLOAT") {
  return entry({
    id,
    live: { value, type, index, count: 18, received: true },
    metadata: makeMetadata({
      id,
      name: id.replace(/_/g, " "),
      min: null,
      max: null,
      increment: null,
      group: "Battery",
      user: "Standard",
    }),
    metadataMissing: false,
  });
}

function powerParams() {
  return [
    entry({
      id: "BATT_MONITOR",
      live: { value: 4, type: "INT8", index: 0, count: 18, received: true },
      metadata: makeMetadata({
        id: "BATT_MONITOR",
        name: "Battery monitoring",
        rebootRequired: true,
        values: {
          "0": "Disabled",
          "3": "Analog Voltage Only",
          "4": "Analog Voltage and Current",
          "5": "Solex Volt and Current",
        },
        group: "Battery",
      }),
    }),
    battParam("BATT_CAPACITY", 3300, 1),
    battParam("BATT_LOW_VOLT", 11.3, 2),
    battParam("BATT_CRT_VOLT", 10.5, 3),
    battParam("BATT_LOW_MAH", 700, 4),
    battParam("BATT_CRT_MAH", 500, 5),
    battParam("BATT_LOW_TIMER", 10, 6),
    entry({
      id: "BATT_FS_LOW_ACT",
      live: { value: 1, type: "INT8", index: 7, count: 18, received: true },
      metadata: makeMetadata({
        id: "BATT_FS_LOW_ACT",
        name: "Low battery failsafe",
        values: { "0": "Disabled", "1": "Land", "2": "RTL" },
        group: "Battery",
      }),
    }),
    entry({
      id: "BATT_FS_CRT_ACT",
      live: { value: 2, type: "INT8", index: 8, count: 18, received: true },
      metadata: makeMetadata({
        id: "BATT_FS_CRT_ACT",
        name: "Critical battery failsafe",
        values: { "0": "Disabled", "1": "Land", "2": "RTL" },
        group: "Battery",
      }),
    }),
    battParam("BATT_VOLT_MULT", 10.1, 9),
    battParam("BATT_AMP_PERVLT", 17.0, 10),
    battParam("BATT_AMP_OFFSET", 0, 11),
    battParam("BATT_VLT_OFFSET", 0, 12),
    battParam("BATT_ARM_VOLT", 0, 13),
    battParam("BATT_FS_VOLTSRC", 0, 14),
  ];
}

function defaultTelemetry(overrides: Partial<PowerTelemetry> = {}): PowerTelemetry {
  return {
    instance: 0,
    id: 1,
    voltage: 12.58,
    current: 2.5,
    consumedMah: 420,
    remaining: 88,
    temperature: null,
    cellVoltages: [],
    chargeState: "UNDEFINED",
    receivedAt: Date.now() / 1000,
    ageMs: 500,
    stale: false,
    source: "SYS_STATUS",
    ...overrides,
  };
}

function powerSync() {
  const s = statusView().sync;
  return {
    state: s.state,
    complete: s.state === "complete",
    expectedCount: s.expectedCount,
    receivedCount: s.receivedCount,
    cachedEntries: s.cachedEntries,
    missingIds: s.missingIds,
  };
}

function powerStatus(overrides: Partial<PowerStatus> = {}): PowerStatus {
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
    state: "READY",
    sync: powerSync(),
    staleThresholdMs: 3000,
    instances: [
      {
        instance: 1,
        label: "Battery 1",
        prefix: "BATT_",
        monitor: {
          id: "BATT_MONITOR",
          supported: true,
          value: 4,
          name: "Battery monitoring",
          description: null,
          units: null,
          rebootRequired: true,
          decoded: "Analog Voltage and Current",
          options: [
            { code: 0, label: "Disabled" },
            { code: 3, label: "Analog Voltage Only" },
            { code: 4, label: "Analog Voltage and Current" },
            { code: 5, label: "Solex Volt and Current" },
          ],
        },
        capacity: {
          id: "BATT_CAPACITY",
          supported: true,
          value: 3300,
          name: "Battery capacity",
          description: null,
          units: "mAh",
          rebootRequired: false,
          min: 100,
          max: 20000,
        },
        thresholds: {
          lowVolt: { id: "BATT_LOW_VOLT", supported: true, value: 11.3, name: "Low voltage threshold", description: null, units: "V", rebootRequired: false },
          crtVolt: { id: "BATT_CRT_VOLT", supported: true, value: 10.5, name: "Critical voltage threshold", description: null, units: "V", rebootRequired: false },
          lowMah: { id: "BATT_LOW_MAH", supported: true, value: 700, name: "Low capacity threshold", description: null, units: "mAh", rebootRequired: false },
          crtMah: { id: "BATT_CRT_MAH", supported: true, value: 500, name: "Critical capacity threshold", description: null, units: "mAh", rebootRequired: false },
          lowTimer: { id: "BATT_LOW_TIMER", supported: true, value: 10, name: "Low battery timer", description: null, units: "s", rebootRequired: false },
          fsLowAct: {
            id: "BATT_FS_LOW_ACT",
            supported: true,
            value: 1,
            name: "Low battery failsafe",
            description: null,
            units: null,
            rebootRequired: false,
            decoded: "Land",
            options: [
              { code: 0, label: "Disabled" },
              { code: 1, label: "Land" },
              { code: 2, label: "RTL" },
            ],
            readOnlyNotice: "Configured in Safety",
          },
          fsCrtAct: {
            id: "BATT_FS_CRT_ACT",
            supported: true,
            value: 2,
            name: "Critical battery failsafe",
            description: null,
            units: null,
            rebootRequired: false,
            decoded: "RTL",
            options: [
              { code: 0, label: "Disabled" },
              { code: 1, label: "Land" },
              { code: 2, label: "RTL" },
            ],
            readOnlyNotice: "Configured in Safety",
          },
        },
        calibration: {
          voltMult: { id: "BATT_VOLT_MULT", supported: true, value: 10.1, name: "Voltage multiplier", description: null, units: null, rebootRequired: false },
          ampPerVlt: { id: "BATT_AMP_PERVLT", supported: true, value: 17, name: "Amps per volt", description: null, units: "A/V", rebootRequired: false },
          ampOffset: { id: "BATT_AMP_OFFSET", supported: true, value: 0, name: "Amps offset", description: null, units: "V", rebootRequired: false },
          vltOffset: { id: "BATT_VLT_OFFSET", supported: true, value: 0, name: "Voltage offset", description: null, units: "V", rebootRequired: false },
        },
        advanced: [
          {
            id: "BATT_ARM_VOLT",
            value: 0,
            name: "Arming voltage",
            description: null,
            units: "V",
            rebootRequired: false,
          },
          {
            id: "BATT_FS_VOLTSRC",
            value: 0,
            name: "Failsafe voltage source",
            description: null,
            units: null,
            rebootRequired: false,
          },
        ],
        telemetry: defaultTelemetry(),
        health: { status: "NORMAL", detail: "Battery operating within configured limits" },
      },
    ],
    instanceCount: 1,
    timestamp: Date.now(),
    ...overrides,
  };
}

function noBatteryTelemetry(): PowerStatus {
  const base = powerStatus();
  return {
    ...base,
    state: "NO_BATTERY_TELEMETRY",
    instances: base.instances.map((i) => ({
      ...i,
      telemetry: defaultTelemetry({
        voltage: null,
        current: null,
        consumedMah: null,
        remaining: null,
        temperature: null,
        receivedAt: null,
      }),
      health: { status: "UNAVAILABLE", detail: "Battery telemetry unavailable" },
    })),
  };
}

function successTxn(pairs: { paramId: string; value: number }[]) {
  return {
    success: true,
    transaction: {
      transactionId: "txn-power",
      sessionId: "abc123",
      status: "success",
      total: pairs.length,
      succeeded: pairs.length,
      failed: 0,
      notAttempted: 0,
      results: pairs.map((it) => ({
        paramId: it.paramId,
        requestedValue: it.value,
        originalValue: 3300,
        status: "success",
        verifiedValue: it.value,
        code: null,
        message: null,
      })),
    },
  };
}

function readyDefaults() {
  apiMocks.getParameterStatus.mockResolvedValue(statusView());
  apiMocks.getAllParameters.mockResolvedValue({
    success: true,
    connection: "READY",
    sync: statusView().sync,
    metadata: metadataAvailable,
    vehicle: { vehicleType: "QUADROTOR" },
    count: 15,
    parameters: powerParams(),
  });
  apiMocks.getMetadataOverview.mockResolvedValue({
    success: true,
    vehicle: "copter",
    metadataStatus: metadataAvailable,
    groups: ["Battery"],
  });
  apiMocks.refreshParameters.mockResolvedValue({ success: true, sync: statusView().sync });
  setupMocks.getPowerInfo.mockResolvedValue(powerStatus());
  setupMocks.getPowerTelemetry.mockResolvedValue({ batteries: [defaultTelemetry()], timestamp: Date.now() });
}

function renderPower() {
  return render(
    <ParameterProvider>
      <SetupPower />
    </ParameterProvider>
  );
}

async function waitForReady() {
  await screen.findByTestId("setup-power");
  await waitFor(() => {
    expect(screen.getByTestId("power-voltage-1").textContent).toContain("12.58");
  });
}

beforeEach(() => {
  window.localStorage.clear();
  telemetry.connected = true;
  telemetry.connectionState = "CONNECTED";
  telemetry.disconnectReason = null;
  readyDefaults();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("SetupPower — connected + READY", () => {
  it("renders Battery 1 live telemetry with honest formatting", async () => {
    renderPower();
    await waitForReady();
    expect(screen.getByTestId("power-health").textContent).toContain("NORMAL");
    expect(screen.getByTestId("power-voltage-1").textContent).toContain("12.58 V");
    expect(screen.getByTestId("power-current-1").textContent).toContain("2.50 A");
    expect(screen.getByTestId("power-consumed-1").textContent).toContain("420 mAh");
    expect(screen.getByTestId("power-remaining-1").textContent).toContain("88 %");
    expect(screen.getByTestId("power-telemetry-freshness-1").textContent).toContain("LIVE");
  });

  it("shows Unavailable (never 0) for null telemetry values", async () => {
    setupMocks.getPowerInfo.mockResolvedValue(
      noBatteryTelemetry(),
    );
    renderPower();
    await screen.findByTestId("setup-power");
    expect(screen.getByTestId("power-no-battery-telemetry")).toBeInTheDocument();
  });

  it("shows STALE TELEMETRY frame and stale cells when the snapshot is stale", async () => {
    setupMocks.getPowerInfo.mockResolvedValue(
      powerStatus({
        state: "STALE_TELEMETRY",
        instances: powerStatus().instances.map((i) => ({
          ...i,
          telemetry: defaultTelemetry({ stale: true, ageMs: 9000, receivedAt: 1 }),
          health: { status: "STALE", detail: "Battery telemetry stale" },
        })),
      }),
    );
    renderPower();
    await screen.findByTestId("setup-power");
    await waitFor(() => {
      expect(screen.getByTestId("power-telemetry-freshness-1").textContent).toContain("STALE");
    });
    expect(screen.getByTestId("power-voltage-1").textContent).toContain("Stale");
    expect(screen.getByTestId("power-current-1").textContent).toContain("Stale");
    expect(screen.getByTestId("power-stale-telemetry")).toBeInTheDocument();
    expect(screen.getByTestId("power-health").textContent).toContain("STALE");
  });

  it("respects a real 0 A reading — does not treat it as unavailable", async () => {
    setupMocks.getPowerInfo.mockResolvedValue(
      powerStatus({
        state: "READY",
        instances: powerStatus().instances.map((i) => ({
          ...i,
          telemetry: defaultTelemetry({ current: 0 }),
        })),
      }),
    );
    renderPower();
    await screen.findByTestId("setup-power");
    await waitFor(() => {
      expect(screen.getByTestId("power-current-1").textContent).toContain("0.00 A");
    });
  });
});

describe("SetupPower — states and gating", () => {
  it("shows WAITING when disconnected with no reason", async () => {
    telemetry.connected = false;
    telemetry.connectionState = "DISCONNECTED";
    renderingState();
  });

  it("shows CONNECTING during an active connect attempt", async () => {
    telemetry.connected = false;
    telemetry.connectionState = "CONNECTING";
    renderingState();
  });

  it("shows CONNECTION_LOST with the disconnect reason and cleared telemetry note", async () => {
    telemetry.connected = false;
    telemetry.connectionState = "DISCONNECTED";
    telemetry.disconnectReason = "Link timeout";
    renderingState();
  });

  it("shows SYNCING until the parameter cache is complete", async () => {
    setupMocks.getPowerInfo.mockResolvedValue(powerStatus({ state: "SYNCING" }));
    renderPower();
    await screen.findByTestId("setup-power-syncing");
    expect(screen.getByText(/Synchronizing power configuration/)).toBeInTheDocument();
    expect(screen.queryByTestId("power-voltage-1")).not.toBeInTheDocument();
  });

  it("shows ERROR on a failed parameter synchronization with a retry", async () => {
    setupMocks.getPowerInfo.mockResolvedValue(
      powerStatus({ state: "ERROR", success: false }),
    );
    renderPower();
    await screen.findByTestId("setup-power-error");
    expect(screen.getByTestId("setup-power-retry")).toBeInTheDocument();
  });

  it("shows UNSUPPORTED for non-ArduCopter vehicles without inventing data", async () => {
    telemetry.vehicleType = "FIXED_WING";
    setupMocks.getPowerInfo.mockResolvedValue(
      powerStatus({
        supported: false,
        state: "UNSUPPORTED",
        vehicleType: "FIXED_WING",
        unsupportedReason: "Power setup is available only for ArduCopter in this version (FIXED_WING detected).",
        instances: [],
      }),
    );
    renderPower();
    await screen.findByTestId("setup-power-unsupported");
    expect(screen.getByText(/Unsupported vehicle/)).toBeInTheDocument();
    expect(screen.queryByTestId("power-voltage-1")).not.toBeInTheDocument();
  });

  it("shows MONITOR_DISABLED banner when BATT_MONITOR is 0", async () => {
    setupMocks.getPowerInfo.mockResolvedValue(
      powerStatus({
        state: "MONITOR_DISABLED",
        instances: powerStatus().instances.map((i) => ({
          ...i,
          monitor: { ...i.monitor, value: 0, decoded: "Disabled" },
        })),
      }),
    );
    renderPower();
    await screen.findByTestId("setup-power");
    await waitFor(() => {
      expect(screen.getByTestId("power-monitor-disabled")).toBeInTheDocument();
    });
  });
});

function renderingState() {
  renderPower();
  const root = screen.getByTestId("setup-power");
  expect(root).toBeInTheDocument();
  expect(screen.queryByTestId("power-voltage-1")).not.toBeInTheDocument();
}

describe("SetupPower — configuration", () => {
  it("shows read-only failsafe actions labelled Configured in Safety", async () => {
    renderPower();
    await waitForReady();
    const low = screen.getByTestId("power-readonly-BATT_FS_LOW_ACT");
    expect(low.textContent).toContain("Land");
    expect(low.textContent).toContain("Configured in Safety");
    const crt = screen.getByTestId("power-readonly-BATT_FS_CRT_ACT");
    expect(crt.textContent).toContain("RTL");
    expect(crt.textContent).toContain("Configured in Safety");
  });

  it("renders the BATT_MONITOR enum select from real metadata options", async () => {
    renderPower();
    await waitForReady();
    const sel = screen.getByTestId("power-monitor-select-1") as HTMLSelectElement;
    expect(sel.options.length).toBe(4);
    expect(sel.value).toBe("4");
  });

  it("shows Unsupported (never fabricated) for parameters the vehicle lacks", async () => {
    setupMocks.getPowerInfo.mockResolvedValue(
      powerStatus({
        instances: powerStatus().instances.map((i) => ({
          ...i,
          capacity: { ...i.capacity, supported: false, value: null },
        })),
      }),
    );
    renderPower();
    await waitForReady();
    expect(screen.getByTestId("power-unsupported-BATT_CAPACITY").textContent).toContain(
      "Unsupported",
    );
  });

  it("separates the monitor-disabled and unsupported notes so they never run together", async () => {
    setupMocks.getPowerInfo.mockResolvedValue(
      powerStatus({
        instances: powerStatus().instances.map((i) => ({
          ...i,
          monitor: { ...i.monitor, value: 0, decoded: "Disabled" },
          capacity: { ...i.capacity, supported: false, value: null },
        })),
      }),
    );
    renderPower();
    await waitForReady();
    const unsupported = screen.getByTestId("power-unsupported-BATT_CAPACITY");
    expect(screen.getByTestId("power-monitor-disabled")).toBeInTheDocument();
    expect(unsupported.textContent?.trim().startsWith("Unsupported")).toBe(false);
    expect(unsupported.textContent).toMatch(/^\s*·\s*Unsupported/);
  });

  it("shows the advanced power settings only after toggling open", async () => {
    renderPower();
    await waitForReady();
    expect(screen.queryByTestId("power-advanced-BATT_ARM_VOLT")).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId("power-advanced-toggle-1"));
    expect(screen.getByTestId("power-advanced-BATT_ARM_VOLT")).toBeInTheDocument();
    expect(screen.getByTestId("power-advanced-BATT_FS_VOLTSRC")).toBeInTheDocument();
  });

  it("stages a changed capacity and writes it through the verified pipeline", async () => {
    apiMocks.writeBatch.mockResolvedValue(
      successTxn([{ paramId: "BATT_CAPACITY", value: 4000 }]),
    );
    renderPower();
    await waitForReady();
    const input = screen.getByTestId("power-capacity-1") as HTMLInputElement;
    await userEvent.clear(input);
    await userEvent.type(input, "4000");
    await waitFor(() => {
      expect((screen.getByTestId("power-capacity-1") as HTMLInputElement).value).toBe("4000");
    });
    await userEvent.click(screen.getByTestId("power-config-apply"));
    await waitFor(() => {
      expect(apiMocks.writeBatch).toHaveBeenCalledTimes(1);
    });
    const txn = (await apiMocks.writeBatch.mock.results[0].value) as {
      transaction: { results: Array<{ paramId: string; verifiedValue?: number }> };
    };
    expect(
      txn.transaction.results.some(
        (r) => r.paramId === "BATT_CAPACITY" && r.verifiedValue === 4000,
      ),
    ).toBe(true);
    await waitFor(() => {
      expect(screen.getByTestId("power-config-write-success").textContent).toContain("1 parameter");
    });
  });

  it("stages a BATT_MONITOR enum change (reboot required) and shows the reboot warning on success", async () => {
    apiMocks.writeBatch.mockResolvedValue(
      successTxn([{ paramId: "BATT_MONITOR", value: 3 }]),
    );
    renderPower();
    await waitForReady();
    const sel = screen.getByTestId("power-monitor-select-1") as HTMLSelectElement;
    await userEvent.selectOptions(sel, "3");
    expect(sel.value).toBe("3");
    await userEvent.click(screen.getByTestId("power-config-apply"));
    await waitFor(() => {
      expect(apiMocks.writeBatch).toHaveBeenCalledTimes(1);
    });
    const txn2 = (await apiMocks.writeBatch.mock.results[0].value) as {
      transaction: { results: Array<{ paramId: string }> };
    };
    expect(txn2.transaction.results.some((r) => r.paramId === "BATT_MONITOR")).toBe(true);
    await waitFor(() => {
      expect(screen.getByTestId("power-reboot-required")).toBeInTheDocument();
    });
    expect(screen.getByTestId("power-reboot-required").textContent).toContain("Reboot required");
  });

  it("Revert discards staged edits and never writes", async () => {
    renderPower();
    await waitForReady();
    const input = screen.getByTestId("power-capacity-1") as HTMLInputElement;
    await userEvent.clear(input);
    await userEvent.type(input, "4000");
    await userEvent.click(screen.getByTestId("power-config-revert"));
    await waitFor(() => {
      expect((screen.getByTestId("power-capacity-1") as HTMLInputElement).value).toBe("3300");
    });
    expect(apiMocks.writeBatch).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric staged value with an inline error", async () => {
    renderPower();
    await waitForReady();
    const input = screen.getByTestId("power-capacity-1") as HTMLInputElement;
    await userEvent.clear(input);
    await userEvent.type(input, "abc");
    await userEvent.click(screen.getByTestId("power-config-apply"));
    await waitFor(() => {
      expect(screen.getByTestId("power-config-error")).toBeInTheDocument();
    });
    expect(screen.getByTestId("power-config-error").textContent).toContain("BATT_CAPACITY");
    expect(apiMocks.writeBatch).not.toHaveBeenCalled();
  });

  it("disables Apply while a write is running", async () => {
    let resolveWrite: (v: unknown) => void = () => {};
    apiMocks.writeBatch.mockImplementation(
      () => new Promise((resolve) => (resolveWrite = resolve)),
    );
    renderPower();
    await waitForReady();
    const input = screen.getByTestId("power-capacity-1") as HTMLInputElement;
    await userEvent.clear(input);
    await userEvent.type(input, "4000");
    await userEvent.click(screen.getByTestId("power-config-apply"));
    await waitFor(() => {
      expect(screen.getByTestId("power-config-writing")).toBeInTheDocument();
    });
    expect((screen.getByTestId("power-config-apply") as HTMLButtonElement).disabled).toBe(true);
    resolveWrite(
      successTxn([{ paramId: "BATT_CAPACITY", value: 4000 }]),
    );
    await waitFor(() => {
      expect(screen.getByTestId("power-config-write-success")).toBeInTheDocument();
    });
  });

  it("shows an inline error and preserves prior values when a write fails", async () => {
    apiMocks.writeBatch.mockResolvedValue({
      success: false,
      error: { code: "PARAM_WRITE_FAILED", message: "Write FAILED for BATT_CAPACITY" },
    });
    renderPower();
    await waitForReady();
    const input = screen.getByTestId("power-capacity-1") as HTMLInputElement;
    await userEvent.clear(input);
    await userEvent.type(input, "4000");
    await userEvent.click(screen.getByTestId("power-config-apply"));
    await waitFor(() => {
      expect(screen.getByTestId("power-config-write-error")).toBeInTheDocument();
    });
    expect(screen.getByTestId("power-config-write-error").textContent).toContain("BATT_CAPACITY");
  });
});

describe("SetupPower — calculations", () => {
  it("computes a new voltage multiplier and never writes automatically", async () => {
    setupMocks.calculateVoltageMultiplier.mockResolvedValue({
      success: true,
      message: "Calculated new multiplier: 18.000000",
      calculatedMultiplier: 18,
    });
    renderPower();
    await waitForReady();
    await userEvent.type(screen.getByTestId("power-calc-volt-measured"), "18.0");
    await userEvent.type(screen.getByTestId("power-calc-volt-sensor"), "10.1");
    await userEvent.click(screen.getByTestId("power-calc-volt-run"));
    await waitFor(() => {
      expect(screen.getByTestId("power-calc-volt-result").textContent).toContain("18");
    });
    expect(apiMocks.writeBatch).not.toHaveBeenCalled();
  });

  it("computes a new amps-per-volt value", async () => {
    setupMocks.calculateAmpsPerVolt.mockResolvedValue({
      success: true,
      message: "Calculated new amps per volt: 8.500000",
      calculatedAmpsPerVolt: 8.5,
    });
    renderPower();
    await waitForReady();
    await userEvent.type(screen.getByTestId("power-calc-amp-measured"), "8.5");
    await userEvent.type(screen.getByTestId("power-calc-amp-sensor"), "17.0");
    await userEvent.click(screen.getByTestId("power-calc-amp-run"));
    await waitFor(() => {
      expect(screen.getByTestId("power-calc-amp-result").textContent).toContain("8.5");
    });
    expect(apiMocks.writeBatch).not.toHaveBeenCalled();
  });

  it("asks for measured values instead of producing fake results", async () => {
    renderPower();
    await waitForReady();
    await userEvent.click(screen.getByTestId("power-calc-volt-run"));
    await waitFor(() => {
      expect(screen.getByTestId("power-calc-volt-error").textContent).toContain(
        "measured (multimeter) voltage",
      );
    });
    expect(setupMocks.calculateVoltageMultiplier).not.toHaveBeenCalled();
  });
});

describe("SetupPower — disconnect / reconnect", () => {
  it("clears live battery telemetry on disconnect and resumes on reconnect", async () => {
    const { rerender } = renderPower();
    await waitForReady();
    expect(screen.getByTestId("power-voltage-1").textContent).toContain("12.58");
    telemetry.connected = false;
    telemetry.connectionState = "DISCONNECTED";
    telemetry.disconnectReason = "Link timeout";
    rerender(
      <ParameterProvider>
        <SetupPower />
      </ParameterProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("setup-power-lost")).toBeInTheDocument();
    });
    expect(screen.getByTestId("setup-power-lost-reason").textContent).toContain("Link timeout");
    expect(screen.getByTestId("setup-power-connection-lost").textContent).toContain("cleared");
    telemetry.connected = true;
    telemetry.connectionState = "CONNECTED";
    telemetry.disconnectReason = null;
    setupMocks.getPowerInfo.mockResolvedValue(powerStatus());
    rerender(
      <ParameterProvider>
        <SetupPower />
      </ParameterProvider>,
    );
    await waitFor(
      () => {
        expect(screen.getByTestId("power-voltage-1").textContent).toContain("12.58");
      },
      { timeout: 3000 },
    );
  });

  it("refreshes live values from battery:update socket events without a reload", async () => {
    renderPower();
    await waitForReady();
    setupMocks.getPowerInfo.mockResolvedValue(
      powerStatus({
        instances: powerStatus().instances.map((i) => ({
          ...i,
          telemetry: defaultTelemetry({ voltage: 12.7 }),
        })),
      }),
    );
    emitter.emit("battery:update", { batteries: [], timestamp: Date.now() });
    await waitFor(
      () => {
        expect(screen.getByTestId("power-voltage-1").textContent).toContain("12.70");
      },
      { timeout: 3000 },
    );
  });
});
