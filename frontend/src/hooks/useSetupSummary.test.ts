import { describe, expect, it, beforeEach, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

import { useSetupSummary } from "./useSetupSummary";
import type { SetupSummaryData } from "../api/setup";

const { emitter, emitterAct } = vi.hoisted(() => {
  const handlers = new Map<string, Set<(payload?: unknown) => void>>();
  const emitter = {
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
  };
  return { emitter, emitterAct: emitter };
});

vi.mock("../socket/socket", () => ({ default: emitterAct }));

const getSetupSummary = vi.hoisted(() => vi.fn());

vi.mock("../api/setup", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, getSetupSummary };
});

function summaryData(): SetupSummaryData {
  return {
    success: true,
    connected: true,
    sync: { state: "complete", expectedCount: 991, receivedCount: 991, cachedEntries: 991 },
    items: [],
    counts: { good: 0, warn: 0, unsupported: 0, unknown: 0, waiting: 0 },
  };
}

beforeEach(() => {
  getSetupSummary.mockReset();
  getSetupSummary.mockResolvedValue(summaryData());
});

describe("useSetupSummary", () => {
  it("polls on the configured interval and refreshes on sync socket events", async () => {
    const { result } = renderHook(() => useSetupSummary(true, 30_000));
    await waitFor(() => expect(result.current.summary).not.toBeNull());

    // Parameter-sync activity should force an immediate re-read, not wait for
    // the next poll.
    emitter.emit("parameter:sync:progress", {});
    await waitFor(() => expect(getSetupSummary).toHaveBeenCalledTimes(2));
  });

  it("clears the summary immediately when disabled (no stale status)", async () => {
    const { result, rerender } = renderHook(({ enabled }) => useSetupSummary(enabled), {
      initialProps: { enabled: true },
    });
    await waitFor(() => expect(result.current.summary).not.toBeNull());

    rerender({ enabled: false });
    expect(result.current.summary).toBeNull();
  });

  it("stops polling when disabled even if the interval passes", async () => {
    const { rerender } = renderHook(({ enabled }) => useSetupSummary(enabled, 50), {
      initialProps: { enabled: true },
    });
    await waitFor(() => expect(getSetupSummary).toHaveBeenCalled());

    rerender({ enabled: false });
    await act(async () => {
      await vi.waitFor(() => expect(getSetupSummary).toHaveBeenCalledTimes(1));
    });
  });

  it("refetches and repopulates state when re-enabled after a disconnect (reconnect)", async () => {
    const { result, rerender } = renderHook(({ enabled }) => useSetupSummary(enabled), {
      initialProps: { enabled: true },
    });
    await waitFor(() => expect(result.current.summary).not.toBeNull());
    getSetupSummary.mockClear();

    rerender({ enabled: false });
    expect(result.current.summary).toBeNull();

    rerender({ enabled: true });
    await waitFor(() => expect(getSetupSummary).toHaveBeenCalled());
    await waitFor(() => expect(result.current.summary).not.toBeNull());
  });
});
