import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ParameterProvider } from "../../context/ParameterContext";
import SetupSafety from "./SetupSafety";

import { entry, makeMetadata, metadataAvailable, statusView } from "../../test/fixtures";
import type {
  SafetyArmingSection,
  SafetyFenceSection,
  SafetyGcsSection,
  SafetyParamField,
  SafetyStatusPayload,
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
      getSafetyInfo: vi.fn(),
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
  return { ...actual, getSafetyInfo: setupMocks.getSafetyInfo };
});

vi.mock("../../socket/socket", () => ({ default: emitter }));

vi.mock("../../hooks/useTelemetry", () => ({ useTelemetry: () => telemetry }));

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function field(data: Partial<SafetyParamField> & { id: string }): SafetyParamField {
  return {
    supported: false,
    value: null,
    name: data.id.replace(/_/g, " ").toLowerCase(),
    description: null,
    units: null,
    rebootRequired: false,
    ...data,
  };
}

function fenceSection(overrides: Partial<SafetyFenceSection["fields"]> = {}): SafetyFenceSection {
  return {
    fields: {
      enable: field({
        id: "FENCE_ENABLE",
        supported: true,
        value: 0,
        name: "Enable",
        decoded: "Disabled",
        options: [
          { code: 0, label: "Disabled" },
          { code: 1, label: "Enabled" },
          { code: 2, label: "EnabledAll" },
          { code: 3, label: "EnabledInside" },
        ],
        description: "Fence enable/disable.",
      }),
      action: field({
        id: "FENCE_ACTION",
        supported: true,
        value: 1,
        name: "Action",
        decoded: "RTL or Land",
        options: [
          { code: 0, label: "Disabled" },
          { code: 1, label: "RTL or Land" },
          { code: 2, label: "Land" },
          { code: 3, label: "Hold" },
        ],
        description: "Action on fence breach.",
      }),
      radius: field({
        id: "FENCE_RADIUS",
        supported: true,
        value: 300,
        name: "Radius",
        units: "m",
        min: 0,
        increment: 1,
      }),
      altMax: field({
        id: "FENCE_ALT_MAX",
        supported: true,
        value: 100,
        name: "Max Height",
        units: "m",
        min: 0,
        increment: 1,
      }),
      altMin: field({
        id: "FENCE_ALT_MIN",
        supported: true,
        value: -10,
        name: "Min Height",
        units: "m",
        min: 0,
        increment: 1,
      }),
      margin: field({ id: "FENCE_MARGIN", supported: true, value: 2, name: "Margin", units: "m" }),
      types: field({
        id: "FENCE_TYPE",
        supported: true,
        value: 7,
        name: "Fence types",
        bits: [
          { code: 0, label: "Altitude", present: true },
          { code: 1, label: "Distance", present: true },
          { code: 2, label: "Circle", present: true },
        ],
      }),
      options: field({
        id: "FENCE_OPTIONS",
        supported: true,
        value: 0,
        name: "Fence options",
        bits: [
          { code: 0, label: "Fence breach notification", present: false },
          { code: 1, label: "Fence return point", present: false },
        ],
      }),
      ntfFreq: field({
        id: "FENCE_NTF_FREQ",
        supported: true,
        value: 1,
        name: "Notification frequency",
        units: "s",
        min: 0,
        increment: 1,
      }),
      ...overrides,
    },
  };
}

function armingSplit(): SafetyArmingSection {
  return {
    supported: true,
    field: field({ id: "ARMING_CHECK", supported: false, name: "Arming Checks" }),
    checks: [
      field({
        id: "ARMING_OPTIONS",
        supported: true,
        value: 0,
        name: "Arming Options",
        options: [
          { code: 0, label: "Disabled" },
          { code: 1, label: "ArmingOnly" },
          { code: 2, label: "ArmingAndPreflight" },
        ],
      }),
      field({
        id: "ARMING_SKIPCHK",
        supported: true,
        value: 72,
        name: "Arm Checks to Skip",
        bits: [
          { code: 0, label: "Barometer", present: false },
          { code: 1, label: "Compass", present: false },
          { code: 2, label: "GPS lock", present: false },
          { code: 3, label: "INS", present: false },
          { code: 6, label: "Battery level", present: true },
          { code: 11, label: "Logging available", present: true },
        ],
      }),
      field({
        id: "ARMING_RUDDER",
        supported: true,
        value: 1,
        name: "Rudder",
        options: [
          { code: 0, label: "Disabled" },
          { code: 1, label: "ArmingOnly" },
          { code: 2, label: "ArmingAndPreflight" },
        ],
      }),
      field({
        id: "ARMING_MAGTHRESH",
        supported: true,
        value: 100,
        name: "Mag Thresh",
        units: "%",
      }),
    ],
    note: "This firmware reports arming checks as individual ARMING_* parameters.",
  };
}

function gcsSection(overrides: Partial<SafetyGcsSection> = {}): SafetyGcsSection {
  return {
    supported: true,
    field: field({
      id: "FS_GCS_ENABLE",
      supported: true,
      value: 0,
      decoded: "Disabled",
      name: "Enable",
      options: [
        { code: 0, label: "Disabled" },
        { code: 1, label: "Enabled always RTL" },
        { code: 2, label: "Enabled always Land" },
      ],
      description: "Action on GCS failsafe.",
    }),
    timeout: field({
      id: "FS_GCS_TIMEOUT",
      supported: true,
      value: 5,
      name: "Timeout",
      units: "s",
    }),
    ...overrides,
  };
}

function safetyStatus(overrides: Partial<SafetyStatusPayload> = {}): SafetyStatusPayload {
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
    sync: { state: "complete", complete: true },
    // The legacy derived summary is deliberately unused by the new form layout.
    status: null,
    battery: {
      fields: {
        lowVolt: field({
          id: "BATT_LOW_VOLT",
          supported: false,
          name: "Low Voltage Threshold",
          units: "V",
          zeroMeansDisabled: true,
        }),
        crtVolt: field({ id: "BATT_CRT_VOLT", supported: false, name: "Critical Voltage Threshold" }),
        lowMah: field({ id: "BATT_LOW_MAH", supported: false, name: "Low Capacity Threshold" }),
        crtMah: field({ id: "BATT_CRT_MAH", supported: false, name: "Critical Capacity Threshold" }),
        lowTimer: field({ id: "BATT_LOW_TIMER", supported: false, name: "Low Battery Timer" }),
        fsVoltSrc: field({ id: "BATT_FS_VOLTSRC", supported: false, name: "Failsafe Voltage Source" }),
        fsLowAct: field({ id: "BATT_FS_LOW_ACT", supported: false, name: "Low Battery Failsafe Action" }),
        fsCrtAct: field({ id: "BATT_FS_CRT_ACT", supported: false, name: "Critical Battery Failsafe Action" }),
      },
    },
    radio: {
      fields: {
        enable: field({
          id: "FS_THR_ENABLE",
          supported: true,
          value: 1,
          name: "Enable",
          decoded: "Enabled always RTL",
          options: [
            { code: 0, label: "Disabled" },
            { code: 1, label: "Enabled always RTL" },
            { code: 2, label: "Enabled continuous" },
          ],
          description: "Action on throttle failsafe.",
        }),
        value: field({
          id: "FS_THR_VALUE",
          supported: true,
          value: 975,
          name: "Throttle",
          units: "PWM",
          min: 910,
          max: 1100,
          increment: 1,
        }),
        options: field({
          id: "FS_OPTIONS",
          supported: true,
          value: 16,
          name: "Options",
          bits: [
            { code: 0, label: "Continue if in Auto on RC failsafe", present: false },
            { code: 1, label: "Continue if in Auto on GCS failsafe", present: false },
            { code: 2, label: "Continue if in Guided on RC failsafe", present: false },
            { code: 3, label: "Continue if landing on any failsafe", present: false },
            { code: 4, label: "Continue if in pilot controlled modes on GCS failsafe", present: true },
          ],
          description: "Additional failsafe options.",
        }),
      },
      warnings: [],
    },
    gcs: gcsSection(),
    fence: fenceSection(),
    rtl: {
      fields: {
        // ArduCopter publishes RTL_ALT_M with a 0.3 m minimum, so 0 ("return at
        // current altitude") is NOT a writable value on this firmware.
        alt: field({ id: "RTL_ALT_M", supported: true, value: 15, name: "Altitude", units: "m", min: 0.3, max: 3000, increment: 0.1 }),
        loitTime: field({
          id: "RTL_LOIT_TIME",
          supported: true,
          value: 5000,
          name: "Loiter Time",
          units: "s",
        }),
        altFinal: field({ id: "RTL_ALT_FINAL_M", supported: true, value: 0, name: "Final Altitude", units: "m", min: 0, max: 10, increment: 0.1 }),
        landSpeed: field({ id: "LAND_SPEED", supported: false, name: "Landing Descent Speed" }),
      },
      extra: [field({ id: "RTL_CONE_SLOPE", supported: true, value: 3, name: "RTL Cone Slope" })],
    },
    arming: armingSplit(),
    // Mirrors the live payload: the extra RTL params are reported both under
    // `rtl.extra` and, by their metadata group, under `advanced.categories`.
    advanced: {
      categories: [
        { name: "Failsafe", params: [field({ id: "FS_EKF_ACTION", supported: true, value: 1, name: "FS EKF Action" })] },
        {
          name: "RTL behaviour",
          params: [field({
            id: "RTL_CONE_SLOPE",
            supported: true,
            value: 3,
            name: "RTL Cone Slope",
            options: [
              { code: 0, label: "Disabled" },
              { code: 1, label: "Shallow" },
              { code: 3, label: "Steep" },
            ],
            decoded: "Steep",
          })],
        },
        {
          name: "SmartRTL / other",
          params: [field({
            id: "WP_YAW_BEHAVIOR",
            supported: true,
            value: 2,
            name: "Yaw behaviour during missions",
            options: [
              { code: 0, label: "Never change yaw" },
              { code: 1, label: "Face next waypoint" },
              { code: 2, label: "Face next waypoint except RTL" },
              { code: 3, label: "Face along GPS course" },
            ],
            decoded: "Face next waypoint except RTL",
          })],
        },
      ],
    },
    timestamp: Date.now(),
    ...overrides,
  };
}

/**
 * Mirrors the live ArduCopter parameter cache the backend is fed with.
 * Bounds are null because the real cache is populated from the vehicle's own
 * parameter download — validation must not be faked in the fixture.
 */
/** A vehicle with a battery monitor, so the battery rows are real controls. */
function withBatteryMonitor(): SafetyStatusPayload {
  const base = safetyStatus();
  return {
    ...base,
    battery: {
      fields: {
        lowVolt: field({
          id: "BATT_LOW_VOLT",
          supported: true,
          value: 10.5,
          name: "Low Voltage Threshold",
          units: "V",
          min: 0,
          increment: 0.1,
          zeroMeansDisabled: true,
        }),
        crtVolt: field({
          id: "BATT_CRT_VOLT",
          supported: true,
          value: 0,
          name: "Critical Voltage Threshold",
          units: "V",
          min: 0,
          increment: 0.1,
          zeroMeansDisabled: true,
        }),
        lowMah: field({ id: "BATT_LOW_MAH", supported: true, value: 0, name: "Low Capacity Threshold", units: "mAh" }),
        crtMah: field({ id: "BATT_CRT_MAH", supported: true, value: 0, name: "Critical Capacity Threshold", units: "mAh" }),
        lowTimer: field({ id: "BATT_LOW_TIMER", supported: true, value: 10, name: "Low Battery Timer", units: "s" }),
        fsVoltSrc: field({
          id: "BATT_FS_VOLTSRC",
          supported: true,
          value: 0,
          name: "Failsafe Voltage Source",
          options: [
            { code: 0, label: "Kongo" },
            { code: 1, label: "Analog" },
            { code: 2, label: "All" },
          ],
        }),
        fsLowAct: field({
          id: "BATT_FS_LOW_ACT",
          supported: true,
          value: 1,
          name: "Low Battery Failsafe Action",
          description: "Action on low battery condition.",
          options: [
            { code: 0, label: "Warn only" },
            { code: 1, label: "RTL" },
            { code: 2, label: "Land" },
          ],
        }),
        fsCrtAct: field({
          id: "BATT_FS_CRT_ACT",
          supported: true,
          value: 2,
          name: "Critical Battery Failsafe Action",
          description: "Action on critical battery condition.",
          options: [
            { code: 0, label: "Warn only" },
            { code: 1, label: "RTL" },
            { code: 2, label: "Land" },
          ],
        }),
      },
    },
  };
}

function cachedParam(
  id: string,
  value: number,
  index: number,
  liveType: string,
  metadataOverrides: Record<string, unknown> = {},
) {
  return entry({
    id,
    live: { value, type: liveType, index, count: 32, received: true },
    metadata: makeMetadata({
      id,
      name: id.replace(/_/g, " ").toLowerCase(),
      min: null,
      max: null,
      increment: null,
      units: null,
      unitText: null,
      values: null,
      bitmask: null,
      description: null,
      group: "Safety",
      user: "Advanced",
      ...metadataOverrides,
    }),
    metadataMissing: false,
  });
}

function cachedParameters() {
  return [
    cachedParam("FS_THR_ENABLE", 1, 0, "UINT8", {
      values: { "0": "Disabled", "1": "Enabled always RTL", "2": "Enabled continuous" },
    }),
    cachedParam("FS_THR_VALUE", 975, 1, "FLOAT", { units: "PWM", unitText: "PWM" }),
    cachedParam("FS_OPTIONS", 16, 2, "UINT16", {
      bitmask: {
        "0": "Continue if in Auto on RC failsafe",
        "1": "Continue if in Auto on GCS failsafe",
        "2": "Continue if in Guided on RC failsafe",
        "3": "Continue if landing on any failsafe",
        "4": "Continue if in pilot controlled modes on GCS failsafe",
      },
    }),
    cachedParam("FS_GCS_ENABLE", 0, 3, "UINT8", {
      values: { "0": "Disabled", "1": "Enabled always RTL", "2": "Enabled always Land" },
    }),
    cachedParam("FS_GCS_TIMEOUT", 5, 4, "UINT16", { units: "s", unitText: "s" }),
    cachedParam("RTL_ALT_M", 15, 5, "FLOAT", { units: "m", unitText: "m" }),
    cachedParam("RTL_ALT_FINAL_M", 0, 6, "INT16", { units: "m", unitText: "m" }),
    cachedParam("RTL_LOIT_TIME", 5000, 7, "UINT16", { units: "s", unitText: "s" }),
    cachedParam("RTL_CONE_SLOPE", 3, 8, "UINT8"),
    cachedParam("FENCE_ENABLE", 0, 9, "UINT8", {
      values: { "0": "Disabled", "1": "Enabled", "2": "EnabledAll", "3": "EnabledInside" },
    }),
    cachedParam("FENCE_ACTION", 1, 10, "UINT8", {
      values: { "0": "Disabled", "1": "RTL or Land", "2": "Land", "3": "Hold" },
    }),
    cachedParam("FENCE_RADIUS", 300, 11, "UINT16", { units: "m", unitText: "m" }),
    cachedParam("FENCE_ALT_MAX", 100, 12, "INT16", { units: "m", unitText: "m" }),
    cachedParam("FENCE_ALT_MIN", -10, 13, "INT16", { units: "m", unitText: "m" }),
    cachedParam("FENCE_MARGIN", 2, 14, "UINT8", { units: "m", unitText: "m" }),
    cachedParam("FENCE_TYPE", 7, 15, "UINT8", {
      bitmask: { "0": "Altitude", "1": "Distance", "2": "Circle" },
    }),
    cachedParam("FENCE_OPTIONS", 0, 16, "UINT8", {
      bitmask: { "0": "Fence breach notification", "1": "Fence return point" },
    }),
    cachedParam("FENCE_NTF_FREQ", 1, 17, "UINT8", { units: "s", unitText: "s" }),
    cachedParam("ARMING_OPTIONS", 0, 18, "UINT8", {
      values: { "0": "Disabled", "1": "ArmingOnly", "2": "ArmingAndPreflight" },
    }),
    cachedParam("ARMING_SKIPCHK", 0, 19, "INT32", { bitmask: { "0": "Barometer", "1": "Compass" } }),
    cachedParam("ARMING_RUDDER", 1, 20, "UINT8", {
      values: { "0": "Disabled", "1": "ArmingOnly", "2": "ArmingAndPreflight" },
    }),
    cachedParam("ARMING_MAGTHRESH", 100, 21, "UINT8", { units: "%", unitText: "%" }),
    cachedParam("FS_EKF_ACTION", 1, 22, "UINT8", { values: { "0": "Land", "1": "RTL and Land" } }),
  ];
}

function successTxn(pairs: { paramId: string; value: number }[]) {
  return {
    success: true,
    transaction: {
      transactionId: "txn-safety",
      sessionId: "abc123",
      status: "success",
      total: pairs.length,
      succeeded: pairs.length,
      failed: 0,
      notAttempted: 0,
      results: pairs.map((it) => ({
        paramId: it.paramId,
        requestedValue: it.value,
        originalValue: 1,
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
  const parameters = cachedParameters();
  apiMocks.getAllParameters.mockResolvedValue({
    success: true,
    connection: "READY",
    sync: statusView().sync,
    metadata: metadataAvailable,
    vehicle: { vehicleType: "QUADROTOR" },
    count: parameters.length,
    parameters,
  });
  apiMocks.getMetadataOverview.mockResolvedValue({
    success: true,
    vehicle: "copter",
    metadataStatus: metadataAvailable,
    groups: ["Safety"],
  });
  apiMocks.refreshParameters.mockResolvedValue({ success: true, sync: statusView().sync });
  setupMocks.getSafetyInfo.mockResolvedValue(safetyStatus());
}

function renderSafety() {
  return render(
    <ParameterProvider>
      <SetupSafety />
    </ParameterProvider>,
  );
}

/**
 * RTL_ALT_M with a firmware-controlled minimum. 0 means "return at the current
 * altitude" and is only offered when the vehicle's own metadata accepts it.
 */
function withRtlAltMin(min: number) {
  const base = safetyStatus();
  return safetyStatus({
    rtl: {
      ...base.rtl!,
      fields: {
        ...base.rtl!.fields,
        alt: field({
          id: "RTL_ALT_M",
          supported: true,
          value: 15,
          name: "Altitude",
          units: "m",
          min,
          max: 3000,
          increment: 0.1,
        }),
      },
    },
  });
}

async function waitForReady() {
  await screen.findByTestId("setup-safety");
  await waitFor(() => {
    expect(screen.getByTestId("safety-section-battery")).toBeInTheDocument();
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

/* ------------------------------------------------------------------ */

describe("SetupSafety — compact configuration form layout", () => {
  it("renders the QGC description line, never a status dashboard", async () => {
    renderSafety();
    await waitForReady();
    expect(
      screen.getByText(/Safety Setup is used to setup triggers for Return to Land as well as the settings for Return to Land itself/),
    ).toBeInTheDocument();
  });

  it("renders exactly the five required sections", async () => {
    renderSafety();
    await waitForReady();
    expect(screen.getByTestId("safety-section-battery")).toBeInTheDocument();
    expect(screen.getByTestId("safety-section-general")).toBeInTheDocument();
    expect(screen.getByTestId("safety-section-fence")).toBeInTheDocument();
    expect(screen.getByTestId("safety-section-rtl")).toBeInTheDocument();
    expect(screen.getByTestId("safety-section-arming")).toBeInTheDocument();
  });

  it("labels the sections with the required titles", async () => {
    renderSafety();
    await waitForReady();
    const sections: [string, string][] = [
      ["Battery Failsafe Triggers", "safety-section-battery"],
      ["General Failsafe Triggers", "safety-section-general"],
      ["GeoFence", "safety-section-fence"],
      ["Return to Launch", "safety-section-rtl"],
      ["Arming Checks", "safety-section-arming"],
    ];
    for (const [title, testid] of sections) {
      expect(screen.getByTestId(testid)).toBeInTheDocument();
      expect(screen.getAllByText(title).length).toBeGreaterThan(0);
    }
  });

  it("puts every section in one two-column grid and spans Arming Checks across it", async () => {
    renderSafety();
    await waitForReady();
    const grid = screen.getByTestId("safety-section-battery").parentElement!;
    expect(grid).toHaveClass("safety-grid");
    expect(screen.getByTestId("safety-section-arming")).toHaveClass("safety-section-wide");
    expect(screen.getByTestId("safety-section-battery")).not.toHaveClass("safety-section-wide");
  });

  it("does not render the retired dashboard status cards", async () => {
    renderSafety();
    await waitForReady();
    expect(screen.queryByTestId("safety-status-card")).not.toBeInTheDocument();
    expect(screen.queryByTestId("safety-configuration")).not.toBeInTheDocument();
    expect(screen.queryByTestId("safety-warning")).not.toBeInTheDocument();
  });

  it("renders every field as one horizontal label + control row", async () => {
    setupMocks.getSafetyInfo.mockResolvedValue(withBatteryMonitor());
    renderSafety();
    await waitForReady();
    for (const id of [
      "safety-batt-fslowact",
      "safety-batt-lowvolt",
      "safety-radio-value",
      "safety-gcs-timeout",
      "safety-fence-radius",
      "safety-rtl-alt",
      "safety-arming-arming_magthresh",
    ]) {
      const row = screen.getByTestId(id).closest(".safety-row")!;
      expect(row.className).toContain("safety-row");
      // A label and a control in the same row -> two grid children.
      expect(row.querySelectorAll(".safety-label")).toHaveLength(1);
      expect(row.querySelectorAll(".safety-control")).toHaveLength(1);
    }
  });

  it("keeps an Unavailable field on a single compact row, never a stacked block", async () => {
    renderSafety();
    await waitForReady();
    const row = screen.getByTestId("safety-na-BATT_LOW_VOLT");
    // Label and read-only control are siblings in one row.
    expect(row.querySelector(".safety-label")).not.toBeNull();
    expect(row.querySelector(".safety-na")).not.toBeNull();
    // And the row is a two-column horizontal grid, not a stacked single column.
    expect(row.className).toContain("safety-row-na");
  });

  it("orders Battery Failsafe with the actions first, as the QGC reference does", async () => {
    setupMocks.getSafetyInfo.mockResolvedValue(withBatteryMonitor());
    renderSafety();
    await waitForReady();
    const order = Array.from(document.querySelectorAll('[data-testid^="safety-batt-"]'))
      .map((r) => r.getAttribute("data-testid") ?? "")
      .filter((id) => !id.endsWith("-disabled"));
    expect(order.slice(0, 6)).toEqual([
      "safety-batt-fslowact",
      "safety-batt-fscrtact",
      "safety-batt-lowvolt",
      "safety-batt-crtvolt",
      "safety-batt-lowmah",
      "safety-batt-crtmah",
    ]);
  });

  it("presents GeoFence enable/action as radio lists built from the real enum metadata", async () => {
    renderSafety();
    await waitForReady();
    // No dropdowns remain for these two.
    expect(document.querySelector('[data-testid="safety-fence-enable"]')).toBeNull();
    expect(document.querySelector('[data-testid="safety-fence-action"]')).toBeNull();
    // Every radio is one option the vehicle actually publishes.
    const enableOpts = safetyStatus().fence!.fields.enable.options!;
    const opts = Array.from(
      document.querySelectorAll('[data-testid^="safety-fence-enable-opt-"]'),
    );
    // One radio per real enum value — nothing invented, nothing dropped.
    expect(opts).toHaveLength(enableOpts.length);
    expect(opts[0].closest(".safety-row")!.textContent).toContain(enableOpts[0].label);
    expect(opts[1].closest(".safety-row")!.textContent).toContain(enableOpts[1].label);
    const actionOpts = safetyStatus().fence!.fields.action.options!;
    const actions = Array.from(
      document.querySelectorAll('[data-testid^="safety-fence-action-opt-"]'),
    );
    expect(actions).toHaveLength(actionOpts.length);
    expect(actions[0].closest(".safety-row")!.textContent).toContain(actionOpts[0].label);
    expect(actions[1].closest(".safety-row")!.textContent).toContain(actionOpts[1].label);
    // label left, radio right, one compact row each
    for (const o of actions) {
      const row = o.closest(".safety-row")!;
      expect(row.className).toContain("safety-row-radio");
      expect(row.querySelectorAll(".safety-label")).toHaveLength(1);
    }
  });

  it("presents Return to Launch as a QGC radio pair plus toggle-and-input rows", async () => {
    // A firmware that accepts 0 as RTL_ALT_M gets the full QGC radio pair.
    setupMocks.getSafetyInfo.mockResolvedValue(withRtlAltMin(0));
    const first = renderSafety();
    await waitForReady();
    const altRow = document.querySelector('[data-testid="safety-rtl-alt-specified"]')!
      .closest(".safety-row")!;
    expect(altRow.textContent).toContain("Return at specified altitude");
    // The altitude input shares the row with its radio.
    expect(altRow.querySelector('[data-testid="safety-rtl-alt"]')).not.toBeNull();
    expect(
      screen.getByTestId("safety-rtl-alt-current").closest(".safety-row")!.textContent,
    ).toContain("Return at current altitude");
    first.unmount();

    // The live ArduCopter minimum of 0.3 removes the dead radio pair.
    setupMocks.getSafetyInfo.mockResolvedValue(withRtlAltMin(0.3));
    renderSafety();
    await waitForReady();
    const loit = screen.getByTestId("safety-rtl-loittime-toggle");
    const loitRow = loit.closest(".safety-row")!;
    expect(loitRow.textContent).toContain("Loiter above Home for");
    expect(loitRow.querySelector('[data-testid="safety-rtl-loittime"]')).not.toBeNull();
    // The unit shown is the vehicle's own, not a hardcoded one.
    expect(loitRow.textContent).toContain(
      safetyStatus().rtl!.fields.loitTime.units!,
    );
  });

  it("keeps a zero-valued optional parameter off instead of inventing a value", async () => {
    renderSafety();
    await waitForReady();
    // RTL_ALT_FINAL_M is 0, so its radio is off and its input is disabled.
    expect((screen.getByTestId("safety-rtl-altfinal-toggle") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByTestId("safety-rtl-altfinal") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId("safety-rtl-altfinal") as HTMLInputElement).value).toBe("0");
  });

  it("hides the current-altitude radio when the vehicle's own minimum rejects 0", async () => {
    renderSafety();
    await waitForReady();
    // The fixture mirrors live ArduCopter: RTL_ALT_M minimum is 0.3 m, so 0 is
    // not writable and the radio would be a dead control. It is not rendered.
    expect(screen.queryByTestId("safety-rtl-alt-current")).toBeNull();
    expect(screen.queryByTestId("safety-rtl-alt-specified")).toBeNull();
    // The real altitude stays bound to the live value and stays editable.
    const alt = screen.getByTestId("safety-rtl-alt") as HTMLInputElement;
    expect(alt.value).toBe("15");
    expect(alt.disabled).toBe(false);
  });

  it("switching to current altitude stages 0, and re-enabling uses metadata's first legal value", async () => {
    // A firmware whose minimum is 0 allows the QGC "current altitude" encoding.
    apiMocks.writeBatch.mockResolvedValue(successTxn([{ paramId: "RTL_ALT_M", value: 0 }]));
    setupMocks.getSafetyInfo.mockResolvedValue(withRtlAltMin(0));
    renderSafety();
    await waitForReady();
    // Live value is 15 -> "specified" is chosen. Choose "current altitude".
    await userEvent.click(screen.getByTestId("safety-rtl-alt-current"));
    expect((screen.getByTestId("safety-rtl-alt") as HTMLInputElement).value).toBe("0");
    expect(screen.getByTestId("safety-config-actions").textContent).toContain("staged");
    // Re-enable: the minimum is 0, so use the vehicle's 0.1 increment rather
    // than staging 0 (still off) or inventing an arbitrary altitude.
    await userEvent.click(screen.getByTestId("safety-rtl-alt-specified"));
    expect((screen.getByTestId("safety-rtl-alt") as HTMLInputElement).value).toBe("0.1");
    await userEvent.click(screen.getByTestId("safety-config-apply"));
    await waitFor(() => {
      expect(apiMocks.writeBatch).toHaveBeenCalled();
    });
  });

  it("stages a non-zero metadata value when a 0-means-disabled row is switched on", async () => {
    // RTL_ALT_FINAL_M is 0 ("Disabled") and its own minimum is also 0, so
    // staging the minimum would stage the off value and the toggle would do
    // nothing. The row must stage one of the vehicle's own increment steps.
    renderSafety();
    await waitForReady();
    expect((screen.getByTestId("safety-rtl-altfinal-toggle") as HTMLInputElement).checked).toBe(false);
    await userEvent.click(screen.getByTestId("safety-rtl-altfinal-toggle"));
    const staged = Number((screen.getByTestId("safety-rtl-altfinal") as HTMLInputElement).value);
    const field = safetyStatus().rtl!.fields.altFinal;
    expect(staged).not.toBe(0);
    expect(staged).toBe(field.increment!);
    expect(staged).toBeGreaterThanOrEqual(field.min!);
    expect(staged).toBeLessThanOrEqual(field.max!);
  });

  it("prefers a positive minimum over an increment step when switching on", async () => {
    const base = safetyStatus();
    setupMocks.getSafetyInfo.mockResolvedValue(safetyStatus({
      rtl: {
        ...base.rtl!,
        fields: {
          ...base.rtl!.fields,
          loitTime: field({
            id: "RTL_LOIT_TIME",
            supported: true,
            value: 0,
            name: "Loiter Time",
            units: "s",
            min: 1000,
            max: 60000,
            increment: 500,
          }),
        },
      },
    }));
    const parameters = cachedParameters().filter((param) => param.id !== "RTL_LOIT_TIME");
    parameters.push(
      entry({
        id: "RTL_LOIT_TIME",
        metadata: makeMetadata({
          id: "RTL_LOIT_TIME",
          name: "Loiter Time",
          min: 1000,
          max: 60000,
          increment: 500,
        }),
        live: { value: 0, type: "UINT16", received: true },
      }),
    );
    apiMocks.getAllParameters.mockResolvedValue({
      success: true,
      connection: "READY",
      sync: statusView().sync,
      metadata: metadataAvailable,
      vehicle: { vehicleType: "QUADROTOR" },
      count: parameters.length,
      parameters,
    });
    renderSafety();
    await waitForReady();
    const toggle = screen.getByTestId("safety-rtl-loittime-toggle");
    expect((toggle as HTMLInputElement).checked).toBe(false);
    await userEvent.click(toggle);
    expect((screen.getByTestId("safety-rtl-loittime") as HTMLInputElement).value).toBe("1000");
  });

  it("adds an All select-all to the arming checks without inventing any check", async () => {
    renderSafety();
    await waitForReady();
    // The toggle follows the field that actually carries the firmware's bits.
    const bits = armingSplit().checks.find((c) => (c.bits?.length ?? 0) > 0)!;
    const prefix = `safety-arming-${bits.id.toLowerCase()}`;
    const all = screen.getByTestId(`${prefix}-bit-all`) as HTMLInputElement;
    expect(all).not.toBeNull();
    // Some, but not all, skip bits are set on this vehicle.
    expect(all.checked).toBe(false);
    const bitIds = Array.from(document.querySelectorAll(`[data-testid^="${prefix}-bit-"]`)).map((n) =>
      n.getAttribute("data-testid"),
    );
    // "All" plus exactly the bits the firmware publishes.
    expect(bitIds).toHaveLength(bits.bits!.length + 1);
    await userEvent.click(all);
    for (const b of bits.bits!) {
      expect((screen.getByTestId(`${prefix}-bit-${b.code}`) as HTMLInputElement).checked).toBe(true);
    }
    // Turning it back off clears every bit.
    await userEvent.click(all);
    for (const b of bits.bits!) {
      expect((screen.getByTestId(`${prefix}-bit-${b.code}`) as HTMLInputElement).checked).toBe(false);
    }
  });

  it("keeps the QGC six-field Battery block and moves the extra parameters to Advanced", async () => {
    setupMocks.getSafetyInfo.mockResolvedValue(withBatteryMonitor());
    renderSafety();
    await waitForReady();
    const rows = Array.from(
      document.querySelectorAll('[data-testid="safety-section-battery"] .safety-row'),
    ).length;
    expect(rows).toBe(6);
    expect(screen.queryByTestId("safety-batt-lowtimer")).not.toBeInTheDocument();
    expect(screen.queryByTestId("safety-batt-fsvoltsrc")).not.toBeInTheDocument();
    // Still editable, just under the collapsed Advanced group.
    await userEvent.click(screen.getByTestId("safety-advanced-toggle"));
    expect(screen.getByTestId("safety-advanced-batt_low_timer")).toBeInTheDocument();
    expect(screen.getByTestId("safety-advanced-batt_fs_voltsrc")).toBeInTheDocument();
  });

  it("keeps the page free of explanatory failsafe panels", async () => {
    renderSafety();
    await waitForReady();
    const body = screen.getByTestId("setup-safety").textContent ?? "";
    expect(body).not.toMatch(/never independently executes RTL, Land, SmartRTL/);
  });
});

describe("SetupSafety — connection states", () => {
  it("shows WAITING when disconnected with no reason", async () => {
    telemetry.connected = false;
    telemetry.connectionState = "DISCONNECTED";
    renderSafety();
    await screen.findByTestId("setup-safety-waiting");
    expect(screen.getByText(/Waiting for vehicle/)).toBeInTheDocument();
    expect(screen.queryByTestId("safety-section-battery")).not.toBeInTheDocument();
  });

  it("shows CONNECTING during an active connect attempt", async () => {
    telemetry.connected = false;
    telemetry.connectionState = "CONNECTING";
    renderSafety();
    await screen.findByTestId("setup-safety-connecting");
    expect(screen.getByText(/Connecting…/)).toBeInTheDocument();
  });

  it("shows CONNECTION_LOST with the reason and no safety data", async () => {
    telemetry.connected = false;
    telemetry.connectionState = "DISCONNECTED";
    telemetry.disconnectReason = "Link timeout";
    renderSafety();
    await screen.findByTestId("setup-safety-lost");
    expect(screen.getByTestId("setup-safety-lost-reason").textContent).toContain("Link timeout");
    expect(screen.queryByTestId("safety-section-general")).not.toBeInTheDocument();
  });

  it("shows SYNCING skeleton until the parameter cache is complete", async () => {
    setupMocks.getSafetyInfo.mockResolvedValue(safetyStatus({ state: "SYNCING" }));
    renderSafety();
    await screen.findByTestId("setup-safety-syncing");
    expect(screen.getAllByText(/Synchronizing/).length).toBeGreaterThan(0);
    expect(screen.queryByTestId("safety-section-arming")).not.toBeInTheDocument();
  });

  it("shows ERROR with a retry when the snapshot fails", async () => {
    setupMocks.getSafetyInfo.mockResolvedValue(safetyStatus({ state: "ERROR", success: false }));
    renderSafety();
    await screen.findByTestId("setup-safety-error");
    expect(screen.getByTestId("setup-safety-retry")).toBeInTheDocument();
  });

  it("shows UNSUPPORTED for non-ArduCopter vehicles without inventing data", async () => {
    telemetry.vehicleType = "FIXED_WING";
    setupMocks.getSafetyInfo.mockResolvedValue(
      safetyStatus({
        supported: false,
        state: "UNSUPPORTED",
        vehicleType: "FIXED_WING",
        unsupportedReason: "Safety setup is available only for ArduCopter in this version (FIXED_WING detected).",
      }),
    );
    renderSafety();
    await screen.findByTestId("setup-safety-unsupported");
    expect(screen.getByText(/only for ArduCopter/)).toBeInTheDocument();
    expect(screen.queryByTestId("safety-section-fence")).not.toBeInTheDocument();
  });
});

describe("SetupSafety — live values, no hardcoding", () => {
  it("renders general failsafe values from the real parameter cache", async () => {
    renderSafety();
    await waitForReady();
    expect((screen.getByTestId("safety-radio-value") as HTMLInputElement).value).toBe("975");
    expect((screen.getByTestId("safety-gcs-timeout") as HTMLInputElement).value).toBe("5");
    expect((screen.getByTestId("safety-gcs-enable") as HTMLSelectElement).value).toBe("0");
    expect((screen.getByTestId("safety-radio-enable") as HTMLSelectElement).value).toBe("1");
  });

  it("renders GeoFence values from the real parameter cache", async () => {
    renderSafety();
    await waitForReady();
    // FENCE_ENABLE / FENCE_ACTION are real enums, shown as QGC radio lists.
    expect((screen.getByTestId("safety-fence-enable-opt-0") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId("safety-fence-enable-opt-1") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByTestId("safety-fence-action-opt-1") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId("safety-fence-action-opt-2") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByTestId("safety-fence-radius") as HTMLInputElement).value).toBe("300");
    expect((screen.getByTestId("safety-fence-altmax") as HTMLInputElement).value).toBe("100");
  });

  it("keeps the extra GeoFence parameters off the primary page", async () => {
    renderSafety();
    await waitForReady();
    for (const id of ["safety-fence-altmin", "safety-fence-margin", "safety-fence-ntffreq"]) {
      expect(screen.queryByTestId(id)).toBeNull();
    }
    expect(screen.queryByTestId("safety-fence-types-bits")).toBeNull();
    expect(screen.queryByTestId("safety-fence-options")).toBeNull();
  });

  it("moves the extra GeoFence parameters into Advanced, still bound to live values", async () => {
    renderSafety();
    await waitForReady();
    // Advanced is collapsed until asked for.
    expect(screen.queryByTestId("safety-advanced-list")).toBeNull();
    await userEvent.click(screen.getByTestId("safety-advanced-toggle"));
    expect((screen.getByTestId("safety-advanced-fence_alt_min") as HTMLInputElement).value).toBe("-10");
    expect((screen.getByTestId("safety-advanced-fence_margin") as HTMLInputElement).value).toBe("2");
    expect((screen.getByTestId("safety-advanced-fence_type-bit-0") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId("safety-advanced-fence_type-bit-1") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId("safety-advanced-fence_type-bit-2") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId("safety-advanced-fence_options-bit-0") as HTMLInputElement).checked).toBe(false);
  });

  it("renders Return to Launch values from the real parameter cache", async () => {
    renderSafety();
    await waitForReady();
    // RTL_ALT_M = 15 m and the input stays bound to the live cache value.
    expect((screen.getByTestId("safety-rtl-alt") as HTMLInputElement).value).toBe("15");
    expect((screen.getByTestId("safety-rtl-loittime") as HTMLInputElement).value).toBe("5000");
    // RTL_LOIT_TIME = 5000 -> loiter enabled, value in ms.
    expect((screen.getByTestId("safety-rtl-loittime-toggle") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId("safety-rtl-loittime") as HTMLInputElement).value).toBe("5000");
    // RTL_ALT_FINAL_M = 0 -> the "Final loiter altitude" radio is off, so its
    // input is disabled rather than showing a made-up altitude.
    expect((screen.getByTestId("safety-rtl-altfinal-toggle") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByTestId("safety-rtl-altfinal") as HTMLInputElement).value).toBe("0");
    expect((screen.getByTestId("safety-rtl-altfinal") as HTMLInputElement).disabled).toBe(true);
  });

  it("keeps the extra RTL params off the primary page but reachable in Advanced", async () => {
    renderSafety();
    await waitForReady();
    expect(screen.queryByTestId("safety-rtl-rtl_cone_slope")).toBeNull();
    await userEvent.click(screen.getByTestId("safety-advanced-toggle"));
    expect((screen.getByTestId("safety-advanced-rtl_cone_slope") as HTMLSelectElement).value).toBe("3");
    expect((screen.getByTestId("safety-advanced-wp_yaw_behavior") as HTMLSelectElement).value).toBe("2");
  });

  it("stages advanced enum dropdowns using the vehicle's declared option values", async () => {
    apiMocks.writeBatch.mockResolvedValue(
      successTxn([
        { paramId: "RTL_CONE_SLOPE", value: 1 },
        { paramId: "WP_YAW_BEHAVIOR", value: 3 },
      ]),
    );
    const parameters = cachedParameters();
    const yawEntry = entry({
      id: "WP_YAW_BEHAVIOR",
      metadata: makeMetadata({
        id: "WP_YAW_BEHAVIOR",
        name: "Yaw behaviour during missions",
        values: {
          "0": "Never change yaw",
          "1": "Face next waypoint",
          "2": "Face next waypoint except RTL",
          "3": "Face along GPS course",
        },
      }),
      live: { value: 2, type: "UINT8", received: true },
    });
    apiMocks.getAllParameters.mockResolvedValue({
      success: true,
      connection: "READY",
      sync: statusView().sync,
      metadata: metadataAvailable,
      vehicle: { vehicleType: "QUADROTOR" },
      count: parameters.length + 1,
      parameters: [...parameters, yawEntry],
    });
    renderSafety();
    await waitForReady();
    await userEvent.click(screen.getByTestId("safety-advanced-toggle"));
    await userEvent.selectOptions(
      screen.getByTestId("safety-advanced-rtl_cone_slope"),
      "1",
    );
    await userEvent.selectOptions(
      screen.getByTestId("safety-advanced-wp_yaw_behavior"),
      "3",
    );
    expect(screen.getByTestId("safety-config-actions").textContent).toContain("2 values staged");

    await userEvent.click(screen.getByTestId("safety-config-apply"));
    await waitFor(() => expect(apiMocks.writeBatch).toHaveBeenCalledTimes(1));
    const [items] = apiMocks.writeBatch.mock.calls[0];
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ paramId: "RTL_CONE_SLOPE", value: 1 }),
        expect.objectContaining({ paramId: "WP_YAW_BEHAVIOR", value: 3 }),
      ]),
    );
  });

  it("applies a Safety advanced parameter outside the usual BATT/FS/RTL/FENCE prefixes", async () => {
    apiMocks.writeBatch.mockResolvedValue(
      successTxn([{ paramId: "WP_YAW_BEHAVIOR", value: 3 }]),
    );
    const parameters = cachedParameters();
    const yawEntry = entry({
      id: "WP_YAW_BEHAVIOR",
      metadata: makeMetadata({ id: "WP_YAW_BEHAVIOR", values: { "2": "RTL default", "3": "Course" } }),
      live: { value: 2, type: "UINT8", received: true },
    });
    apiMocks.getAllParameters.mockResolvedValue({
      success: true,
      connection: "READY",
      sync: statusView().sync,
      metadata: metadataAvailable,
      vehicle: { vehicleType: "QUADROTOR" },
      count: parameters.length + 1,
      parameters: [...parameters, yawEntry],
    });
    renderSafety();
    await waitForReady();
    await userEvent.click(screen.getByTestId("safety-advanced-toggle"));
    await userEvent.selectOptions(screen.getByTestId("safety-advanced-wp_yaw_behavior"), "3");
    expect(screen.getByTestId("safety-config-actions").textContent).toContain("1 value staged");
    await userEvent.click(screen.getByTestId("safety-config-apply"));
    await waitFor(() => expect(apiMocks.writeBatch).toHaveBeenCalledTimes(1));
    const [items] = apiMocks.writeBatch.mock.calls[0];
    expect(items).toEqual([
      expect.objectContaining({ paramId: "WP_YAW_BEHAVIOR", value: 3 }),
    ]);
  });

  it("marks parameters the firmware does not publish as Unavailable instead of faking them", async () => {
    renderSafety();
    await waitForReady();
    expect(screen.getByTestId("safety-na-control-LAND_SPEED").textContent).toContain("Unavailable");
    expect(screen.getByTestId("safety-na-control-BATT_LOW_VOLT").textContent).toContain("Unavailable");
    expect(screen.queryByTestId("safety-batt-lowvolt")).not.toBeInTheDocument();
  });
});

describe("SetupSafety — arming checks", () => {
  it("renders ARMING_CHECK as a bitmask when the firmware publishes it", async () => {
    setupMocks.getSafetyInfo.mockResolvedValue(
      safetyStatus({
        arming: {
          supported: true,
          field: field({
            id: "ARMING_CHECK",
            supported: true,
            value: 1,
            name: "Arming Checks",
            bits: [
              { code: 0, label: "All", present: true },
              { code: 1, label: "Barometer", present: false },
              { code: 2, label: "Compass", present: false },
            ],
          }),
          checks: [],
          note: null,
        },
      }),
    );
    renderSafety();
    await waitForReady();
    const bit0 = screen.getByTestId("safety-arming-checks-bit-0") as HTMLInputElement;
    const bit1 = screen.getByTestId("safety-arming-checks-bit-1") as HTMLInputElement;
    expect(bit0.checked).toBe(true);
    expect(bit1.checked).toBe(false);
  });

  it("falls back to the individual ARMING_* controls when ARMING_CHECK is absent", async () => {
    renderSafety();
    await waitForReady();
    expect(screen.getByTestId("safety-armcheck-note").textContent).toContain("ARMING_");
    expect((screen.getByTestId("safety-arming-arming_options") as HTMLSelectElement).value).toBe("0");
    expect((screen.getByTestId("safety-arming-arming_rudder") as HTMLSelectElement).value).toBe("1");
    expect((screen.getByTestId("safety-arming-arming_magthresh") as HTMLInputElement).value).toBe("100");
    expect((screen.getByTestId("safety-arming-arming_skipchk-bit-0") as HTMLInputElement).checked).toBe(false);
  });

  it("stages a checkbox bitmask as a single integer and writes it", async () => {
    const bits = armingSplit().checks.find((c) => (c.bits?.length ?? 0) > 0)!;
    const live = bits.value!;
    const expected = live | 1; // set bit 0
    apiMocks.writeBatch.mockResolvedValue(successTxn([{ paramId: "ARMING_SKIPCHK", value: expected }]));
    renderSafety();
    await waitForReady();
    await userEvent.click(screen.getByTestId(`safety-arming-${bits.id.toLowerCase()}-bit-0`));
    await userEvent.click(screen.getByTestId("safety-config-apply"));
    await waitFor(() => {
      expect(apiMocks.writeBatch).toHaveBeenCalledTimes(1);
    });
    // The whole bitmask goes out as one integer, preserving the live bits.
    const body = JSON.parse(JSON.stringify(apiMocks.writeBatch.mock.calls[0][0]));
    expect(JSON.stringify(body)).toContain("ARMING_SKIPCHK");
    expect(JSON.stringify(body)).toContain(String(expected));
  });

  it("does not duplicate the individual ARMING_* controls inside Advanced", async () => {
    renderSafety();
    await waitForReady();
    await userEvent.click(screen.getByTestId("safety-advanced-toggle"));
    expect(screen.queryByTestId("safety-advanced-arming_options")).not.toBeInTheDocument();
  });
});

describe("SetupSafety — writes, confirmation and revert", () => {
  it("applies a plain numeric change through the verified pipeline", async () => {
    apiMocks.writeBatch.mockResolvedValue(successTxn([{ paramId: "RTL_LOIT_TIME", value: 3000 }]));
    renderSafety();
    await waitForReady();
    const input = screen.getByTestId("safety-rtl-loittime") as HTMLInputElement;
    await userEvent.clear(input);
    await userEvent.type(input, "3000");
    await userEvent.click(screen.getByTestId("safety-config-apply"));
    await waitFor(() => {
      expect(apiMocks.writeBatch).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.getByTestId("safety-config-write-success").textContent).toContain("1 parameter verified");
    });
  });

  it("confirms a failsafe action change before writing it", async () => {
    apiMocks.writeBatch.mockResolvedValue(successTxn([{ paramId: "FS_THR_ENABLE", value: 2 }]));
    renderSafety();
    await waitForReady();
    await userEvent.selectOptions(screen.getByTestId("safety-radio-enable"), "2");
    await userEvent.click(screen.getByTestId("safety-config-apply"));
    await screen.findByTestId("safety-confirm-dialog");
    const row = screen.getByTestId("safety-confirm-FS_THR_ENABLE");
    expect(row.textContent).toContain("Enabled always RTL");
    expect(row.textContent).toContain("Enabled continuous");
    await userEvent.click(screen.getByTestId("safety-confirm-ok"));
    await waitFor(() => {
      expect(apiMocks.writeBatch).toHaveBeenCalledTimes(1);
    });
  });

  it("confirms a fence enable change before writing it", async () => {
    apiMocks.writeBatch.mockResolvedValue(successTxn([{ paramId: "FENCE_ENABLE", value: 1 }]));
    renderSafety();
    await waitForReady();
    await userEvent.click(screen.getByTestId("safety-fence-enable-opt-1"));
    await userEvent.click(screen.getByTestId("safety-config-apply"));
    await screen.findByTestId("safety-confirm-dialog");
    await userEvent.click(screen.getByTestId("safety-confirm-ok"));
    await waitFor(() => {
      expect(apiMocks.writeBatch).toHaveBeenCalledTimes(1);
    });
  });

  it("cancelling the confirmation never writes and keeps the staged value", async () => {
    renderSafety();
    await waitForReady();
    await userEvent.selectOptions(screen.getByTestId("safety-radio-enable"), "2");
    await userEvent.click(screen.getByTestId("safety-config-apply"));
    await screen.findByTestId("safety-confirm-dialog");
    await userEvent.click(screen.getByTestId("safety-confirm-cancel"));
    await waitFor(() => {
      expect(apiMocks.writeBatch).not.toHaveBeenCalled();
    });
    expect(screen.getByTestId("safety-config-actions").textContent).toContain("staged");
  });

  it("keeps working when a reported field is not yet in the local cache", async () => {
    apiMocks.writeBatch.mockResolvedValue(successTxn([{ paramId: "RTL_LOIT_TIME", value: 3000 }]));
    renderSafety();
    await waitForReady();
    const input = screen.getByTestId("safety-rtl-loittime") as HTMLInputElement;
    await userEvent.clear(input);
    await userEvent.type(input, "3000");
    await userEvent.click(screen.getByTestId("safety-config-apply"));
    await waitFor(() => {
      expect(apiMocks.writeBatch).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByTestId("safety-config-notice")).not.toBeInTheDocument();
  });

  it("rejects a non-numeric staged value without writing", async () => {
    renderSafety();
    await waitForReady();
    const input = screen.getByTestId("safety-rtl-loittime") as HTMLInputElement;
    await userEvent.clear(input);
    await userEvent.type(input, "abc");
    await userEvent.click(screen.getByTestId("safety-config-apply"));
    await waitFor(() => {
      expect(screen.getByTestId("safety-config-error").textContent).toContain("RTL_LOIT_TIME");
    });
    expect(apiMocks.writeBatch).not.toHaveBeenCalled();
  });

  it("surfaces the throttle-range warning without changing the value", async () => {
    const base = safetyStatus();
    setupMocks.getSafetyInfo.mockResolvedValue(
      safetyStatus({
        radio: {
          fields: base.radio!.fields,
          warnings: [
            "Radio failsafe threshold may be inconsistent with the configured throttle range (RC3_MIN=1006, RC3_MAX=1995).",
          ],
        },
      }),
    );
    renderSafety();
    await waitForReady();
    expect(screen.getByTestId("safety-radio-warning").textContent).toContain("inconsistent");
    expect((screen.getByTestId("safety-radio-value") as HTMLInputElement).value).toBe("975");
  });

  it("shows an inline error preserving previous values when a write fails", async () => {
    apiMocks.writeBatch.mockResolvedValue({
      success: false,
      error: { code: "PARAM_WRITE_FAILED", message: "Write FAILED for RTL_ALT_M" },
    });
    renderSafety();
    await waitForReady();
    const input = screen.getByTestId("safety-rtl-loittime") as HTMLInputElement;
    await userEvent.clear(input);
    await userEvent.type(input, "3000");
    await userEvent.click(screen.getByTestId("safety-config-apply"));
    await waitFor(() => {
      expect(screen.getByTestId("safety-config-write-error").textContent).toContain("RTL_ALT_M");
    });
  });

  it("names the exact parameters the vehicle rejected in a partial failure", async () => {
    // One of the two staged parameters is refused by the vehicle. The panel
    // must not report a success and must identify the unwritten parameter.
    apiMocks.writeBatch.mockResolvedValue({
      success: true,
      transaction: {
        transactionId: "txn-partial",
        status: "partial_failure",
        total: 2,
        succeeded: 1,
        failed: 1,
        notAttempted: 0,
        interruptedReason: null,
        results: [
          {
            paramId: "FS_GCS_TIMEOUT",
            requestedValue: 6,
            originalValue: 5,
            status: "success",
            verifiedValue: 6,
          },
          {
            paramId: "RTL_LOIT_TIME",
            requestedValue: 3000,
            originalValue: 5000,
            status: "failed",
            verifiedValue: null,
            code: "VERIFY_MISMATCH",
            message: "Vehicle echoed a different value",
          },
        ],
      },
    });
    renderSafety();
    await waitForReady();
    const timeout = screen.getByTestId("safety-gcs-timeout") as HTMLInputElement;
    await userEvent.clear(timeout);
    await userEvent.type(timeout, "6");
    const loit = screen.getByTestId("safety-rtl-loittime") as HTMLInputElement;
    await userEvent.clear(loit);
    await userEvent.type(loit, "3000");
    await userEvent.click(screen.getByTestId("safety-config-apply"));

    await waitFor(() => {
      expect(screen.getByTestId("safety-config-write-error")).toBeInTheDocument();
    });
    const error = screen.getByTestId("safety-config-write-error");
    // The failing parameter is named, with the reason the vehicle gave.
    expect(error.textContent).toContain("RTL_LOIT_TIME");
    expect(error.textContent).toContain("Vehicle echoed a different value");
    // The one that was written is not reported as failed.
    expect(error.textContent).not.toContain("FS_GCS_TIMEOUT");
    // The headline must not claim nothing was written: one parameter did change.
    expect(error.textContent).not.toContain("previous values were preserved");
    expect(error.textContent).toContain("1 of 2 parameters");
    // A partial batch is never reported as a success.
    expect(screen.queryByTestId("safety-config-write-success")).toBeNull();
  });

  it("shows the reboot-required note after a success when a staged param needs a reboot", async () => {
    apiMocks.writeBatch.mockResolvedValue(successTxn([{ paramId: "FS_OPTIONS", value: 17 }]));
    const base = safetyStatus();
    setupMocks.getSafetyInfo.mockResolvedValue(
      safetyStatus({
        radio: {
          fields: { ...base.radio!.fields, enable: { ...base.radio!.fields.enable, rebootRequired: true } },
          warnings: [],
        },
      }),
    );
    renderSafety();
    await waitForReady();
    await userEvent.selectOptions(screen.getByTestId("safety-radio-enable"), "2");
    await userEvent.click(screen.getByTestId("safety-config-apply"));
    await screen.findByTestId("safety-confirm-dialog");
    await userEvent.click(screen.getByTestId("safety-confirm-ok"));
    await waitFor(() => {
      expect(apiMocks.writeBatch).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.getByTestId("safety-reboot-required")).toBeInTheDocument();
    });
  });

  it("Apply is disabled while a write is running", async () => {
    let resolveWrite: (v: unknown) => void = () => {};
    apiMocks.writeBatch.mockImplementation(() => new Promise((resolve) => (resolveWrite = resolve)));
    renderSafety();
    await waitForReady();
    const input = screen.getByTestId("safety-rtl-loittime") as HTMLInputElement;
    await userEvent.clear(input);
    await userEvent.type(input, "3000");
    await userEvent.click(screen.getByTestId("safety-config-apply"));
    await waitFor(() => {
      expect(screen.getByTestId("safety-config-writing")).toBeInTheDocument();
    });
    expect((screen.getByTestId("safety-config-apply") as HTMLButtonElement).disabled).toBe(true);
    resolveWrite(successTxn([{ paramId: "RTL_LOIT_TIME", value: 3000 }]));
    await waitFor(() => {
      expect(screen.getByTestId("safety-config-write-success")).toBeInTheDocument();
    });
  });

  it("Revert discards staged edits, restores the live value and never writes", async () => {
    renderSafety();
    await waitForReady();
    const input = screen.getByTestId("safety-rtl-loittime") as HTMLInputElement;
    await userEvent.clear(input);
    await userEvent.type(input, "3000");
    await userEvent.click(screen.getByTestId("safety-config-revert"));
    await waitFor(() => {
      expect((screen.getByTestId("safety-rtl-loittime") as HTMLInputElement).value).toBe("5000");
    });
    expect(apiMocks.writeBatch).not.toHaveBeenCalled();
  });
});

describe("SetupSafety — refresh and reconnect", () => {
  it("refresh re-fetches the safety snapshot", async () => {
    renderSafety();
    await waitForReady();
    await userEvent.click(screen.getByTestId("setup-safety-refresh"));
    await waitFor(() => {
      expect(setupMocks.getSafetyInfo.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("refreshes after a parameter:updated socket event without a reload", async () => {
    renderSafety();
    await waitForReady();
    const updated = safetyStatus();
    updated.fence = fenceSection({ radius: field({ id: "FENCE_RADIUS", supported: true, value: 500, name: "Radius", units: "m" }) });
    setupMocks.getSafetyInfo.mockResolvedValue(updated);
    emitter.emit("parameter:updated", { id: "FENCE_RADIUS", value: 500 });
    await waitFor(
      () => {
        expect((screen.getByTestId("safety-fence-radius") as HTMLInputElement).value).toBe("500");
      },
      { timeout: 3000 },
    );
  });

  it("discards staged changes on disconnect, never writes them, and restores on reconnect", async () => {
    const { rerender } = renderSafety();
    await waitForReady();
    const input = screen.getByTestId("safety-rtl-loittime") as HTMLInputElement;
    await userEvent.clear(input);
    await userEvent.type(input, "3000");
    await waitFor(() => {
      expect(screen.getByTestId("safety-config-actions").textContent).toContain("staged");
    });
    telemetry.connected = false;
    telemetry.connectionState = "DISCONNECTED";
    telemetry.disconnectReason = "Link timeout";
    rerender(
      <ParameterProvider>
        <SetupSafety />
      </ParameterProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("setup-safety-lost")).toBeInTheDocument();
    });
    expect(screen.getByTestId("setup-safety-connection-lost")).toBeInTheDocument();
    expect(apiMocks.writeBatch).not.toHaveBeenCalled();

    telemetry.connected = true;
    telemetry.connectionState = "CONNECTED";
    telemetry.disconnectReason = null;
    setupMocks.getSafetyInfo.mockResolvedValue(safetyStatus());
    rerender(
      <ParameterProvider>
        <SetupSafety />
      </ParameterProvider>,
    );
    await waitFor(
      () => {
        expect((screen.getByTestId("safety-rtl-loittime") as HTMLInputElement).value).toBe("5000");
      },
      { timeout: 3000 },
    );
  });
});

describe("SetupSafety — no fabricated safety behaviour", () => {
  it("never claims YantraYug will RTL or Land the vehicle", async () => {
    renderSafety();
    await waitForReady();
    const body = screen.getByTestId("setup-safety").textContent?.toLowerCase() ?? "";
    expect(body).not.toContain("will rtl");
    expect(body).not.toContain("will land");
  });
});
