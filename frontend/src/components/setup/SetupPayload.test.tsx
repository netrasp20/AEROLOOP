import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import SetupLogging from "./SetupLogging";
import SetupScripting from "./SetupScripting";

const { telemetry, api, store, emitter } = vi.hoisted(() => {
  const handlers = new Map<string, Set<() => void>>();
  return {
    telemetry: { connected: true, connectionState: "CONNECTED", disconnectReason: null as string | null },
    api: { logging: vi.fn(), scripting: vi.fn() },
    store: {
      entries: {} as Record<string, unknown>,
      staged: {} as Record<string, unknown>,
      stageValue: vi.fn(() => ({ ok: true, changed: true })),
      revert: vi.fn(),
    },
    emitter: {
      on: (name: string, fn: () => void) => {
        if (!handlers.has(name)) handlers.set(name, new Set());
        handlers.get(name)!.add(fn);
      },
      off: (name: string, fn: () => void) => handlers.get(name)?.delete(fn),
      emit: (name: string) => handlers.get(name)?.forEach((fn) => fn()),
    },
  };
});

vi.mock("../../hooks/useTelemetry", () => ({ useTelemetry: () => telemetry }));
vi.mock("../../socket/socket", () => ({ default: emitter }));
vi.mock("../../context/ParameterContext", () => ({ useParameters: () => store }));
vi.mock("../parameters/ParamValueEditor", () => ({
  default: ({ entry, onStage }: { entry: { id: string }; onStage: (value: number) => unknown }) => (
    <button type="button" data-testid={`editor-${entry.id}`} onClick={() => onStage(7)}>
      edit
    </button>
  ),
}));
vi.mock("../../api/setup", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getLoggingInfo: api.logging,
  getScriptingInfo: api.scripting,
}));

const sync = { state: "READY", complete: true, receivedCount: 12, expectedCount: 12 };
const base = {
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
  sync,
  writePipeline: "shared",
  timestamp: 10,
};

const param = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  supported: true,
  value: 3,
  name: id,
  description: null,
  units: null,
  writable: true,
  decoded: null,
  options: [],
  rebootRequired: false,
  kind: "scalar",
  ...overrides,
});

const logging = {
  ...base,
  readOnly: false,
  status: "Partially configured",
  config: [
    param("LOG_BITMASK", {
      name: "Log bitmask",
      kind: "bitmask",
      value: 3,
      decoded: "Enabled (2/4)",
      enabledCount: 2,
      bits: [
        { code: 0, label: "IMU", present: true },
        { code: 1, label: "GPS", present: true },
        { code: 2, label: "Attitude", present: false },
        { code: 3, label: "RC", present: false },
      ],
    }),
    param("LOG_BACKEND_RATE", { name: "Backend rate", units: "Hz", value: 50 }),
  ],
  configCount: 2,
  logEntries: [
    {
      id: 2,
      timeUtc: 1700001000,
      sizeBytes: 4096,
      numLogs: 3,
      lastLogNum: 2,
      ageMs: 20,
      freshness: "AVAILABLE",
    },
  ],
  logEntryCount: 1,
  numLogs: 3,
  lastLogNum: 2,
};

const scripting = {
  ...base,
  readOnly: false,
  executionEnabled: false,
  capability: {
    scriptingDetected: true,
    reason: "Scripting parameters are present in the vehicle parameter cache.",
  },
  userTokens: ["SCR_USER1", "SCR_USER2"],
  config: [param("SCR_USER1", { name: "Script variable 1" }), param("SCR_USER3")],
  configCount: 2,
};

const pages = [
  { name: "Logging", id: "logging", Component: SetupLogging, mock: api.logging, ready: logging },
  { name: "Scripting", id: "scripting", Component: SetupScripting, mock: api.scripting, ready: scripting },
] as const;

beforeEach(() => {
  telemetry.connected = true;
  telemetry.connectionState = "CONNECTED";
  telemetry.disconnectReason = null;
  store.entries = {};
  store.staged = {};
  store.stageValue.mockClear();
  store.revert.mockClear();
  api.logging.mockReset().mockResolvedValue(logging);
  api.scripting.mockReset().mockResolvedValue(scripting);
});

describe.each(pages)("$name page state handling", ({ id, Component, mock, ready }) => {
  it("shows WAITING while no vehicle is connected", () => {
    telemetry.connected = false;
    render(<Component />);
    expect(screen.getByTestId(`setup-${id}-waiting`)).toHaveTextContent("Waiting for vehicle");
  });

  it("shows CONNECTING while the link is being established", () => {
    telemetry.connected = false;
    telemetry.connectionState = "CONNECTING";
    render(<Component />);
    expect(screen.getByTestId(`setup-${id}-connecting`)).toHaveTextContent("Connecting");
  });

  it("waits for the parameter sync before showing data", () => {
    mock.mockResolvedValue({ ...ready, state: "SYNCING" });
    render(<Component />);
    expect(screen.getByTestId(`setup-${id}-syncing`)).toBeInTheDocument();
  });

  it("shows READY content", async () => {
    render(<Component />);
    expect(await screen.findByTestId(`setup-${id}-refresh`)).toBeInTheDocument();
  });

  it("shows an honest UNSUPPORTED reason", async () => {
    mock.mockResolvedValue({
      ...ready,
      supported: false,
      state: "UNSUPPORTED",
      unsupportedReason: "Vehicle does not support it",
    });
    render(<Component />);
    expect(await screen.findByTestId(`setup-${id}-unsupported`)).toHaveTextContent(
      "Vehicle does not support it",
    );
  });

  it("clears the snapshot and shows CONNECTION_LOST", async () => {
    const view = render(<Component />);
    await screen.findByTestId(`setup-${id}-refresh`);
    telemetry.connected = false;
    telemetry.connectionState = "DISCONNECTED";
    telemetry.disconnectReason = "heartbeat timeout";
    view.rerender(<Component />);
    expect(screen.getByTestId(`setup-${id}-lost`)).toHaveTextContent("heartbeat timeout");
    expect(screen.queryByTestId(`setup-${id}-refresh`)).not.toBeInTheDocument();
  });

  it("refreshes after a reconnect", async () => {
    const view = render(<Component />);
    await screen.findByTestId(`setup-${id}-refresh`);
    expect(mock).toHaveBeenCalledTimes(1);
    telemetry.connected = false;
    telemetry.connectionState = "DISCONNECTED";
    view.rerender(<Component />);
    telemetry.connected = true;
    telemetry.connectionState = "CONNECTED";
    view.rerender(<Component />);
    await waitFor(() => expect(mock).toHaveBeenCalledTimes(2));
  });

  it("shows ERROR when the snapshot cannot be retrieved", async () => {
    mock.mockResolvedValue({ ...ready, success: false, state: "ERROR" });
    render(<Component />);
    expect(await screen.findByTestId(`setup-${id}-error`)).toBeInTheDocument();
  });

  it("reloads on a live telemetry event", async () => {
    render(<Component />);
    await screen.findByTestId(`setup-${id}-refresh`);
    expect(mock).toHaveBeenCalledTimes(1);
    emitter.emit("telemetry:update");
    await waitFor(() => expect(mock).toHaveBeenCalledTimes(2));
  });
});

describe("Logging page", () => {
  it("derives the logging status from the real bitmask", async () => {
    render(<SetupLogging />);
    expect(await screen.findByTestId("logging-status")).toHaveTextContent("Partially configured");
  });

  it("renders the on-board log entries broadcast by the vehicle", async () => {
    render(<SetupLogging />);
    const entry = await screen.findByTestId("logging-entry-2");
    expect(entry).toHaveTextContent("2023-11-14 22:30:00");
    expect(entry).toHaveTextContent("4.0 KiB");
    expect(entry).toHaveTextContent("Available");
  });

  it("shows an honest unavailable state when no log entries were broadcast", async () => {
    api.logging.mockResolvedValue({ ...logging, logEntries: [], logEntryCount: 0, numLogs: null, lastLogNum: null });
    render(<SetupLogging />);
    expect(await screen.findByTestId("logging-entries-unavailable")).toHaveTextContent(
      "This is not simulated",
    );
  });

  it("shows disabled logging when the bitmask is zero", async () => {
    api.logging.mockResolvedValue({
      ...logging,
      status: "Disabled",
      config: [param("LOG_BITMASK", { kind: "bitmask", value: 0, decoded: "Disabled", enabledCount: 0 })],
    });
    render(<SetupLogging />);
    expect(await screen.findByTestId("logging-status")).toHaveTextContent("Disabled");
  });
});

describe("Scripting page", () => {
  it("states that script upload and execution are disabled", async () => {
    render(<SetupScripting />);
    expect(await screen.findByTestId("scripting-readonly-warning")).toHaveTextContent(
      "Script upload and execution are disabled",
    );
  });

  it("reports detected scripting and the real user tokens", async () => {
    render(<SetupScripting />);
    expect(await screen.findByTestId("scripting-detected")).toHaveTextContent("Yes");
    expect(screen.getByTestId("scripting-execution")).toHaveTextContent("Disabled");
    expect(screen.getByTestId("scripting-user-tokens")).toHaveTextContent("SCR_USER1, SCR_USER2");
  });

  it("shows an honest unsupported state when scripting is not detected", async () => {
    api.scripting.mockResolvedValue({
      ...scripting,
      supported: false,
      state: "UNSUPPORTED",
      capability: {
        scriptingDetected: false,
        reason: "The connected ArduCopter firmware does not expose any SCR_* scripting parameters.",
      },
      userTokens: [],
      config: [],
      configCount: 0,
      unsupportedReason:
        "The connected ArduCopter firmware does not expose any SCR_* scripting parameters after a completed parameter sync, so scripting support cannot be verified.",
    });
    render(<SetupScripting />);
    expect(await screen.findByTestId("setup-scripting-unsupported")).toHaveTextContent(
      "does not expose any SCR_* scripting parameters",
    );
  });

  it("points at the existing MAVFTP browser instead of duplicating it", async () => {
    render(<SetupScripting />);
    expect(await screen.findByTestId("setup-scripting-refresh")).toBeInTheDocument();
    expect(screen.getByText(/existing MAVFTP file browser/)).toBeInTheDocument();
  });
});

describe("configuration fields use the shared staged write pipeline", () => {
  it("stages a change through ParameterContext rather than writing directly", async () => {
    const user = userEvent.setup();
    store.entries = { LOG_BITMASK: { id: "LOG_BITMASK", live: { value: 3 }, metadataMissing: false } };
    render(<SetupLogging />);
    await user.click(await screen.findByTestId("editor-LOG_BITMASK"));
    expect(store.stageValue).toHaveBeenCalledWith("LOG_BITMASK", 7);
  });

  it("reverts a staged value", async () => {
    const user = userEvent.setup();
    store.entries = { LOG_BACKEND_RATE: { id: "LOG_BACKEND_RATE", live: { value: 50 }, metadataMissing: false } };
    store.staged = { LOG_BACKEND_RATE: { paramId: "LOG_BACKEND_RATE", stagedValue: 99 } };
    render(<SetupLogging />);
    await user.click(await screen.findByTestId("payload-revert-LOG_BACKEND_RATE"));
    expect(store.revert).toHaveBeenCalledWith("LOG_BACKEND_RATE");
  });

  it("shows a read-only value when the parameter is not loaded for editing", async () => {
    store.entries = {};
    render(<SetupLogging />);
    expect(await screen.findByTestId("payload-value-LOG_BACKEND_RATE")).toHaveTextContent("50 Hz");
  });
});
