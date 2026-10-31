/**
 * Phase 1 composition + Phase 2 guarded functionality.
 *
 * These tests lock both the approved visual composition and the safety
 * boundary. The page may reach the backend's SITL-gated motor test and the
 * confirmed reverse-config write, but it must never be able to arm the
 * vehicle, exceed the bounded test envelope, or act on a motor that was not
 * discovered on the vehicle.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import SetupMotors from "./SetupMotors";

const { telemetry, api, emitter, fetchMock } = vi.hoisted(() => {
  const handlers = new Map<string, Set<(payload?: unknown) => void>>();
  return {
    telemetry: {
      connected: true,
      connectionState: "CONNECTED",
      disconnectReason: null as string | null,
    },
    api: {
      motors: vi.fn(),
      testStatus: vi.fn(),
      reverseStates: vi.fn(),
      startTest: vi.fn(),
      setReverse: vi.fn(),
    },
    emitter: {
      on: (name: string, fn: (payload?: unknown) => void) => {
        if (!handlers.has(name)) handlers.set(name, new Set());
        handlers.get(name)!.add(fn);
      },
      off: (name: string, fn: (payload?: unknown) => void) => handlers.get(name)?.delete(fn),
      emit: (name: string, payload?: unknown) => handlers.get(name)?.forEach((fn) => fn(payload)),
    },
    fetchMock: vi.fn(),
  };
});

vi.mock("../../hooks/useTelemetry", () => ({ useTelemetry: () => telemetry }));
vi.mock("../../socket/socket", () => ({ default: emitter }));
vi.mock("../../api/setup", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  getMotorsInfo: api.motors,
  getMotorTestStatus: api.testStatus,
  getMotorReverseStates: api.reverseStates,
  startMotorTest: api.startTest,
  setMotorReverse: api.setReverse,
}));

const bounds = {
  throttlePctMin: 0,
  throttlePctMax: 20,
  throttlePctDefault: 5,
  timeoutSMin: 1,
  timeoutSMax: 10,
  timeoutSDefault: 3,
};

const sitlIdle = {
  success: true,
  supported: true,
  environment: "SITL",
  readOnly: false,
  reasons: [] as string[],
  state: "IDLE",
  bounds,
  activeMotor: null,
  activeThrottlePct: null,
  activeTimeoutS: null,
  remainingMs: null,
  lastResult: null,
};

const hardwareLocked = {
  ...sitlIdle,
  success: true,
  supported: false,
  environment: "HARDWARE",
  readOnly: true,
  reasons: [
    "Motor testing is enabled in the SITL/test environment only; the connected physical vehicle is read-only.",
  ],
};

const reverseIdle = {
  success: true,
  outputs: [
    { motor: 1, output: 1, paramId: "SERVO1_REVERSED", configured: false, physicallyVerified: false },
  ],
};

const sync = { state: "READY", complete: true, receivedCount: 12, expectedCount: 12 };
const ready = {
  success: true,
  connected: true,
  connectionState: "CONNECTED",
  disconnectReason: null,
  armed: false,
  supported: true,
  state: "READY",
  sync,
  timestamp: 10,
  outputCount: 1,
  outputs: [
    {
      output: 1,
      motorNumber: 1,
      motorLabel: "Motor 1",
      functionId: 33,
      functionLabel: "Motor1",
      configured: true,
      source: "SERVO1_FUNCTION",
    },
  ],
};

async function renderMotors() {
  const view = render(<SetupMotors />);
  await waitFor(() =>
    expect(screen.getByTestId("setup-motors-refresh")).toBeInTheDocument(),
  );
  return view;
}

beforeEach(() => {
  telemetry.connected = true;
  telemetry.connectionState = "CONNECTED";
  telemetry.disconnectReason = null;
  api.motors.mockReset().mockResolvedValue(ready);
  api.testStatus.mockReset().mockResolvedValue(sitlIdle);
  api.reverseStates.mockReset().mockResolvedValue(reverseIdle);
  api.startTest.mockReset().mockResolvedValue(sitlIdle);
  api.setReverse.mockReset().mockResolvedValue({ success: true, outputs: reverseIdle.outputs });
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

describe("Motors Setup — page header", () => {
  it("shows the reference title and one-line description", async () => {
    await renderMotors();
    expect(screen.getByRole("heading", { name: "Motors Setup" })).toBeInTheDocument();
    expect(
      screen.getByText("Motors Setup is used to manually test motor control and direction."),
    ).toBeInTheDocument();
  });
});

describe("Motors Setup — reference composition", () => {
  it("renders six vertical motor controls numbered 1 to 6", async () => {
    await renderMotors();
    for (let i = 1; i <= 6; i += 1) {
      expect(screen.getByTestId(`motor-slider-${i}`)).toBeInTheDocument();
      expect(screen.getByTestId(`motor-slider-track-${i}`)).toBeInTheDocument();
    }
    const numbers = screen
      .getAllByText(/^[1-6]$/)
      .filter((el) => el.getAttribute("class") === "motor-slider-number")
      .map((el) => el.textContent);
    expect(numbers).toEqual(["1", "2", "3", "4", "5", "6"]);
  });

  it("places the six sliders side by side in a single row", async () => {
    await renderMotors();
    const container = screen.getByTestId("motor-test-area").querySelector(
      ".motor-sliders",
    )!;
    expect(container).not.toBeNull();
    expect(container.children).toHaveLength(6);
  });

  it("puts the motor layout diagram on the right of the controls", async () => {
    await renderMotors();
    const area = screen.getByTestId("motor-test-area");
    const controls = area.querySelector(".motor-controls")!;
    const diagram = screen.getByTestId("motor-diagram");
    expect(area.contains(diagram)).toBe(true);
    // Right-hand column: the diagram follows the control column in the same grid.
    expect(
      Array.from(area.children).indexOf(diagram) >
      Array.from(area.children).indexOf(controls),
    ).toBe(true);
  });

  it("shows six motor positions in the diagram", async () => {
    await renderMotors();
    const labels = screen
      .getAllByText(/^[1-6]$/)
      .filter((el) => el.getAttribute("class") === "motor-diagram-label")
      .map((el) => el.textContent);
    expect(labels).toEqual(["1", "2", "3", "4", "5", "6"]);
  });

  it("marks the diagram as illustrative rather than a real mapping", async () => {
    await renderMotors();
    expect(screen.getByTestId("motor-diagram").textContent).toMatch(
      /will be resolved from the connected vehicle/i,
    );
  });

  it("shows six reverse-direction checkboxes aligned under the sliders", async () => {
    await renderMotors();
    expect(screen.getByText("Reverse Motor Direction")).toBeInTheDocument();
    const boxes = screen.getByTestId("motor-reverse").querySelectorAll("input[type=checkbox]");
    expect(boxes).toHaveLength(6);
    // Reverse row must live in the same left-hand control column as the sliders
    // so each box sits under its motor, not spread across the diagram column.
    const controls = screen.getByTestId("motor-test-area").querySelector(".motor-controls")!;
    expect(controls.contains(screen.getByTestId("motor-reverse"))).toBe(true);
    expect(controls.querySelector(".motor-sliders")).not.toBeNull();
  });

  it("keeps a compact locked safety control that can never arm the vehicle", async () => {
    await renderMotors();
    const knob = screen.getByTestId("motor-lock-knob") as HTMLButtonElement;
    expect(knob.tagName).toBe("BUTTON");
    expect(knob.disabled).toBe(true);
    expect(screen.getByTestId("motor-lock-title")).toHaveTextContent("Motor testing ready");
    expect(screen.getByTestId("motor-lock-hint")).toHaveTextContent(
      /cannot arm the vehicle or enable any actuator output/i,
    );
  });

  it("uses a compact status instead of a large warning card", async () => {
    await renderMotors();
    expect(screen.queryByTestId("motor-notice")).toBeNull();
  });

  it("builds no dashboard or status cards around the controls", async () => {
    await renderMotors();
    const body = screen.getByTestId("setup-motors");
    for (const label of [/motor health/i, /esc status/i, /output dashboard/i]) {
      expect(body.textContent ?? "").not.toMatch(label);
    }
  });
});

describe("Motors Setup — guarded actuator path", () => {
  it("reads motor test capability and reverse state on load", async () => {
    await renderMotors();
    await waitFor(() => expect(api.testStatus).toHaveBeenCalled());
    expect(api.reverseStates).toHaveBeenCalled();
  });

  it("runs one bounded test for the committed motor level", async () => {
    await renderMotors();
    const track = screen.getByTestId("motor-slider-track-1");
    expect(track).toHaveAttribute("aria-valuenow", "0");
    track.focus();
    await userEvent.keyboard("{ArrowUp}");
    await waitFor(() => expect(api.startTest).toHaveBeenCalledWith(1, 1, 3));
  });

  it("commits the level the user just asked for, not the previous value", async () => {
    await renderMotors();
    const track = screen.getByTestId("motor-slider-track-1");
    track.focus();
    // Keydown and keyup land before React re-renders, as a fast tap would.
    await act(async () => {
      track.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
      track.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowUp", bubbles: true }));
    });
    await waitFor(() => expect(api.startTest).toHaveBeenCalledWith(1, 1, 3));
  });

  it("clamps the slider to the backend's maximum test level", async () => {
    await renderMotors();
    for (let i = 1; i <= 6; i += 1) {
      expect(screen.getByTestId(`motor-slider-track-${i}`)).toHaveAttribute(
        "aria-valuemax",
        "20",
      );
    }
  });

  it("keeps undiscovered motor slots unavailable", async () => {
    await renderMotors();
    // Only motor 1 exists on this vehicle, so 2-6 must be inert.
    expect(screen.getByTestId("motor-slider-track-1")).toHaveAttribute("aria-disabled", "false");
    for (const i of [2, 3, 4, 5, 6]) {
      const track = screen.getByTestId(`motor-slider-track-${i}`);
      expect(track).toHaveAttribute("aria-disabled", "true");
      track.focus();
      await userEvent.keyboard("{ArrowUp}");
    }
    expect(api.startTest).not.toHaveBeenCalled();
  });

  it("blocks all motor tests and reverse writes on a physical vehicle", async () => {
    api.testStatus.mockResolvedValue(hardwareLocked);
    await renderMotors();
    await waitFor(() =>
      expect(screen.getByTestId("motor-lock-title")).toHaveTextContent("Motor testing unavailable"),
    );
    expect(screen.getByTestId("motor-lock-hint")).toHaveTextContent(/read-only/i);
    expect(screen.getByTestId("motor-slider-track-1")).toHaveAttribute("aria-disabled", "true");
    const box = screen.getByTestId("motor-reverse-1") as HTMLInputElement;
    expect(box.disabled).toBe(true);
  });

  it("blocks motor tests while the vehicle is armed", async () => {
    api.motors.mockResolvedValue({ ...ready, armed: true });
    await renderMotors();
    await waitFor(() =>
      expect(screen.getByTestId("motor-slider-track-1")).toHaveAttribute("aria-disabled", "true"),
    );
  });

  it("applies a confirmed reverse write for a discovered motor", async () => {
    await renderMotors();
    const box = screen.getByTestId("motor-reverse-1") as HTMLInputElement;
    await userEvent.click(box);
    await waitFor(() => expect(api.setReverse).toHaveBeenCalledWith(1, true));
  });

  it("does not offer any arm, stop, apply or save control", async () => {
    await renderMotors();
    for (const name of [/arm\b/i, /disarm/i, /test motor/i, /spin/i, /apply/i, /save/i, /stop/i]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });

  it("shows all six sliders in the same neutral default state", async () => {
    await renderMotors();
    for (let i = 1; i <= 6; i += 1) {
      expect(screen.getByTestId(`motor-slider-track-${i}`)).toHaveAttribute(
        "aria-valuenow",
        "0",
      );
      expect(screen.getByTestId(`motor-slider-fill-${i}`)).toHaveStyle({ height: "0%" });
    }
  });

  it("reports the active test from backend state, not local intent", async () => {
    await renderMotors();
    emitter.emit("motor:test", {
      ...sitlIdle,
      state: "TESTING",
      activeMotor: 1,
      activeThrottlePct: 5,
      activeTimeoutS: 2,
    });
    await waitFor(() =>
      expect(screen.getByTestId("motor-lock-title")).toHaveTextContent(
        "Testing Motor 1 at 5% for 2s",
      ),
    );
    expect(screen.getByTestId("motor-slider-track-1")).toHaveAttribute("aria-valuenow", "5");
  });

  it("never claims reverse direction is physically verified", async () => {
    await renderMotors();
    expect(screen.getByTestId("motor-lock-hint")).toHaveTextContent(
      /not physically verified/i,
    );
  });
});

describe("Motors Setup — read-only discovery retained for Phase 2", () => {
  it("still lists the outputs the backend reported", async () => {
    await renderMotors();
    const row = screen.getByTestId("motor-output-1");
    expect(row).toHaveTextContent("Motor 1");
    expect(row).toHaveTextContent("SERVO1_FUNCTION");
  });

  it("shows the vehicle arm state as information only", async () => {
    api.motors.mockResolvedValue({ ...ready, armed: true });
    await renderMotors();
    expect(screen.getByText("ARMED")).toBeInTheDocument();
  });
});
