import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

import SetupMotors from "./SetupMotors";
import SetupEsc from "./SetupEsc";

const { telemetry, api, emitter } = vi.hoisted(() => {
  const handlers = new Map<string, Set<() => void>>();
  return {
    telemetry: { connected: true, connectionState: "CONNECTED", disconnectReason: null as string | null },
    api: { motors: vi.fn(), esc: vi.fn() },
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
vi.mock("../../api/setup", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getMotorsInfo: api.motors,
  getEscInfo: api.esc,
}));

const sync = { state: "READY", complete: true, receivedCount: 12, expectedCount: 12 };
const base = { success: true, connected: true, connectionState: "CONNECTED", disconnectReason: null, armed: false, supported: true, state: "READY", sync, timestamp: 10 };
const motors = { ...base, outputs: [{ output: 1, motorNumber: 1, motorLabel: "Motor 1", functionId: 33, functionLabel: "Motor1", configured: true, source: "SERVO1_FUNCTION" }], outputCount: 1 };
const esc = { ...base, telemetry: [{ index: 1, rpm: 5200, voltage: 15.8, current: 8.25, temperature: 42.5, consumptionMah: 315, status: "OK", receivedAt: 9, ageMs: 40, freshness: "AVAILABLE" }], escCount: 1, config: [{ id: "MOT_PWM_TYPE", value: 6, name: "Motor PWM Type", description: "Protocol", units: null, decoded: "DShot600", supported: true, rebootRequired: true }] };

const pages = [
  { name: "Motors", id: "motors", Component: SetupMotors, mock: api.motors, ready: motors },
  { name: "ESC", id: "esc", Component: SetupEsc, mock: api.esc, ready: esc },
] as const;

beforeEach(() => {
  telemetry.connected = true;
  telemetry.connectionState = "CONNECTED";
  telemetry.disconnectReason = null;
  api.motors.mockReset().mockResolvedValue(motors);
  api.esc.mockReset().mockResolvedValue(esc);
});

describe.each(pages)("$name read-only page", ({ id, Component, mock, ready }) => {
  it("shows WAITING", () => {
    telemetry.connected = false;
    render(<Component />);
    expect(screen.getByTestId(`setup-${id}-waiting`)).toHaveTextContent("Waiting for vehicle");
  });

  it("shows CONNECTING", () => {
    telemetry.connected = false;
    telemetry.connectionState = "CONNECTING";
    render(<Component />);
    expect(screen.getByTestId(`setup-${id}-connecting`)).toHaveTextContent("Connecting");
  });

  it("shows SYNCING", () => {
    mock.mockResolvedValue({ ...ready, state: "SYNCING" });
    render(<Component />);
    expect(screen.getByTestId(`setup-${id}-syncing`)).toBeInTheDocument();
  });

  it("shows READY", async () => {
    render(<Component />);
    await waitFor(() => expect(screen.getByTestId(`setup-${id}-refresh`)).toBeInTheDocument());
  });

  it("shows UNSUPPORTED honestly", async () => {
    mock.mockResolvedValue({ ...ready, supported: false, state: "UNSUPPORTED", unsupportedReason: "No capability" });
    render(<Component />);
    expect(await screen.findByTestId(`setup-${id}-unsupported`)).toHaveTextContent("No capability");
  });

  it("shows CONNECTION_LOST and clears its snapshot", async () => {
    const view = render(<Component />);
    await screen.findByTestId(`setup-${id}-refresh`);
    telemetry.connected = false;
    telemetry.connectionState = "DISCONNECTED";
    telemetry.disconnectReason = "heartbeat timeout";
    view.rerender(<Component />);
    expect(screen.getByTestId(`setup-${id}-lost`)).toHaveTextContent("heartbeat timeout");
    expect(screen.queryByTestId(`setup-${id}-refresh`)).not.toBeInTheDocument();
  });

  it("shows ERROR", async () => {
    mock.mockResolvedValue({ ...ready, success: false, state: "ERROR" });
    render(<Component />);
    expect(await screen.findByTestId(`setup-${id}-error`)).toBeInTheDocument();
  });

  it("contains no output-editing or physical command controls", async () => {
    render(<Component />);
    await screen.findByTestId(`setup-${id}-refresh`);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    for (const label of [/test motor/i, /move servo/i, /calibrate now/i, /apply configuration/i, /write parameters/i]) {
      expect(screen.queryByRole("button", { name: label })).not.toBeInTheDocument();
    }
  });

  it("re-fetches after reconnect", async () => {
    telemetry.connected = false;
    const view = render(<Component />);
    expect(mock).not.toHaveBeenCalled();
    telemetry.connected = true;
    telemetry.connectionState = "CONNECTED";
    view.rerender(<Component />);
    await waitFor(() => expect(mock).toHaveBeenCalledTimes(1));
  });
});

describe("actual actuator data", () => {
  it("shows discovered motor assignment fields", async () => {
    render(<SetupMotors />);
    expect(await screen.findByTestId("motor-output-1")).toHaveTextContent("Motor 1");
    expect(screen.getByTestId("motor-output-1")).toHaveTextContent("SERVO1_FUNCTION");
  });

  it("shows motor armed state only as information", async () => {
    api.motors.mockResolvedValue({ ...motors, armed: true });
    render(<SetupMotors />);
    expect(await screen.findByText("ARMED")).toBeInTheDocument();
  });

  it("shows all actual ESC metrics", async () => {
    render(<SetupEsc />);
    const row = await screen.findByTestId("esc-telemetry-1");
    expect(row).toHaveTextContent("5200 rpm");
    expect(row).toHaveTextContent("15.80 V");
    expect(row).toHaveTextContent("315 mAh");
  });

  it("shows metadata-decoded present ESC parameters", async () => {
    render(<SetupEsc />);
    expect(await screen.findByTestId("esc-param-MOT_PWM_TYPE")).toHaveTextContent("DShot600 (6)");
  });

  it("shows an honest unavailable ESC telemetry state", async () => {
    api.esc.mockResolvedValue({ ...esc, telemetry: [], escCount: 0 });
    render(<SetupEsc />);
    expect(await screen.findByTestId("esc-telemetry-unavailable")).toHaveTextContent("No ESC telemetry frames");
  });
});
