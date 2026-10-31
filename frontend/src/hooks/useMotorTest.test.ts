/**
 * Phase 8H — motor test + reverse direction state.
 *
 * The backend is the single source of truth for motor test state: the hook
 * must never infer "motor started" from local UI intent, and it must apply the
 * authoritative state pushed over the `motor:test` Socket.IO event.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

import { useMotorTest } from "./useMotorTest";
import type { MotorReverseState, MotorTestStatus } from "../api/setup";

const { emitter, api } = vi.hoisted(() => {
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
    api: {
      getMotorTestStatus: vi.fn(),
      getMotorReverseStates: vi.fn(),
      startMotorTest: vi.fn(),
      stopMotorTest: vi.fn(),
      setMotorReverse: vi.fn(),
    },
  };
});

vi.mock("../socket/socket", () => ({ default: emitter }));
vi.mock("../api/setup", () => api);

const bounds = {
  throttlePctMin: 0,
  throttlePctMax: 20,
  throttlePctDefault: 5,
  timeoutSMin: 1,
  timeoutSMax: 10,
  timeoutSDefault: 3,
};

const idleStatus: MotorTestStatus = {
  supported: true,
  environment: "SITL",
  readOnly: false,
  reasons: [],
  state: "IDLE",
  bounds,
  activeMotor: null,
  activeThrottlePct: null,
  activeTimeoutS: null,
  remainingMs: null,
  lastResult: null,
};

const reverseState: MotorReverseState = {
  motor: 1,
  output: 1,
  paramId: "SERVO1_REVERSED",
  configured: false,
  physicallyVerified: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getMotorTestStatus.mockResolvedValue(idleStatus);
  api.getMotorReverseStates.mockResolvedValue({ success: true, outputs: [reverseState] });
});

describe("useMotorTest — motor test state", () => {
  it("loads test status and reverse states on connect", async () => {
    const { result } = renderHook(() => useMotorTest(true));

    await waitFor(() => expect(result.current.testStatus?.state).toBe("IDLE"));
    expect(result.current.reverseStates).toHaveLength(1);
    expect(result.current.reverseStates[0].physicallyVerified).toBe(false);
  });

  it("applies authoritative state pushed by the motor:test event", async () => {
    const { result } = renderHook(() => useMotorTest(true));
    await waitFor(() => expect(result.current.testStatus).not.toBeNull());

    act(() => {
      emitter.emit("motor:test", {
        ...idleStatus,
        state: "TESTING",
        activeMotor: 2,
        activeThrottlePct: 5,
        activeTimeoutS: 2,
        remainingMs: 1500,
      });
    });

    await waitFor(() => expect(result.current.testStatus?.state).toBe("TESTING"));
    expect(result.current.testStatus?.activeMotor).toBe(2);
  });

  it("startTest returns the backend message and stores returned state", async () => {
    api.startMotorTest.mockResolvedValue({
      ...idleStatus,
      state: "TESTING",
      activeMotor: 1,
      success: true,
      message: "Motor 1 test running at 5% for 2s.",
    });
    const { result } = renderHook(() => useMotorTest(true));
    await waitFor(() => expect(result.current.testStatus).not.toBeNull());

    let outcome = { ok: false, message: "" };
    await act(async () => {
      outcome = await result.current.startTest(1, 5, 2);
    });

    expect(api.startMotorTest).toHaveBeenCalledWith(1, 5, 2);
    expect(outcome).toEqual({ ok: true, message: "Motor 1 test running at 5% for 2s." });
    expect(result.current.testStatus?.state).toBe("TESTING");
  });

  it("startTest surfaces a rejected request without claiming success", async () => {
    api.startMotorTest.mockRejectedValue(new Error("Motor testing is enabled in the SITL/test environment only"));
    const { result } = renderHook(() => useMotorTest(true));
    await waitFor(() => expect(result.current.testStatus).not.toBeNull());

    let outcome = { ok: true, message: "" };
    await act(async () => {
      outcome = await result.current.startTest(1, 5, 2);
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain("SITL");
    // The authoritative state is re-read rather than guessed locally.
    expect(result.current.testStatus?.state).toBe("IDLE");
  });

  it("stopTest clears the active motor and reports success", async () => {
    api.stopMotorTest.mockResolvedValue({
      ...idleStatus,
      state: "STOPPED",
      success: true,
      message: "Motor test stopped.",
    });
    const { result } = renderHook(() => useMotorTest(true));
    await waitFor(() => expect(result.current.testStatus).not.toBeNull());

    let outcome = { ok: false, message: "" };
    await act(async () => {
      outcome = await result.current.stopTest();
    });

    expect(outcome).toEqual({ ok: true, message: "Motor test stopped." });
    expect(result.current.testStatus?.activeMotor).toBeNull();
  });
});

describe("useMotorTest — reverse direction", () => {
  it("setReverse writes through the API and re-reads confirmed state", async () => {
    api.setMotorReverse.mockResolvedValue({
      success: true,
      outputs: [{ ...reverseState, configured: true }],
      paramId: "SERVO1_REVERSED",
      configured: true,
      message: "Write confirmed: SERVO1_REVERSED = 1.0",
    });
    api.getMotorReverseStates.mockResolvedValue({
      success: true,
      outputs: [{ ...reverseState, configured: true }],
    });

    const { result } = renderHook(() => useMotorTest(true));
    await waitFor(() => expect(result.current.reverseStates).toHaveLength(1));

    let outcome = { ok: false, message: "" };
    await act(async () => {
      outcome = await result.current.setReverse(1, true);
    });

    expect(api.setMotorReverse).toHaveBeenCalledWith(1, true);
    expect(outcome.ok).toBe(true);
    await waitFor(() => expect(result.current.reverseStates[0].configured).toBe(true));
    // Configuration is never reported as physical verification.
    expect(result.current.reverseStates[0].physicallyVerified).toBe(false);
  });
});

describe("useMotorTest — connection handling", () => {
  it("clears motor test state when the vehicle disconnects", async () => {
    const { result, rerender } = renderHook(({ connected }) => useMotorTest(connected), {
      initialProps: { connected: true },
    });
    await waitFor(() => expect(result.current.testStatus).not.toBeNull());

    rerender({ connected: false });

    await waitFor(() => expect(result.current.testStatus).toBeNull());
    expect(result.current.reverseStates).toHaveLength(0);
  });

  it("unsubscribes from motor:test on unmount", async () => {
    const { unmount } = renderHook(() => useMotorTest(true));
    await waitFor(() => expect(api.getMotorTestStatus).toHaveBeenCalled());
    unmount();
    // A late event after unmount must not throw.
    expect(() => emitter.emit("motor:test", idleStatus)).not.toThrow();
  });
});
