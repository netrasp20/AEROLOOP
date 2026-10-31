import { describe, expect, it, beforeEach, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ParameterProvider, useParameters } from "../../context/ParameterContext";

import {
  listView,
  metadataAvailable,
  sampleEntries,
  statusView,
  syncComplete,
} from "../../test/fixtures";

import type { ApiResult } from "../../api/parameters";

const { emitter, apiMocks } = vi.hoisted(() => {
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

vi.mock("../../socket/socket", () => ({ default: emitter }));

function Probe() {
  const store = useParameters();
  return (
    <>
      <pre data-testid="probe">
        {JSON.stringify({
          connection: store.connection,
          count: store.count,
          sessionId: store.sessionId,
          loadError: store.loadError,
          refreshing: store.refreshing,
          loading: store.loading,
          syncActive: store.sync.active,
          syncReceived: store.sync.receivedCount,
          syncExpected: store.sync.expectedCount,
          syncCompleteFlag: store.sync.complete,
          syncError: store.sync.error,
          value: store.entries["WP_RADIUS_M"]?.live?.value ?? null,
          stagedCount: store.stagedCount,
          stagedValue: store.staged["WP_RADIUS_M"]?.stagedValue ?? null,
          stagedOriginal: store.staged["WP_RADIUS_M"]?.originalValue ?? null,
          stagedLiveValue: store.staged["WP_RADIUS_M"]?.liveValue ?? null,
          stagedConflict: store.staged["WP_RADIUS_M"]?.conflict ?? null,
          stagedConflictKind:
            store.staged["WP_RADIUS_M"]?.conflictKind ?? null,
          stagedFrame: store.staged["FRAME_TYPE"]?.stagedValue ?? null,
        })}
      </pre>
      <button onClick={() => void store.refresh()}>refresh</button>
      <button onClick={() => store.stageValue("WP_RADIUS_M", 3)}>stage3</button>
      <button onClick={() => store.stageValue("WP_RADIUS_M", 4)}>stage4</button>
      <button onClick={() => store.stageValue("WP_RADIUS_M", 500)}>stage500</button>
      <button onClick={() => store.revert("WP_RADIUS_M")}>revertSel</button>
      <button onClick={() => store.discardAll()}>discard</button>
    </>
  );
}

function renderStore() {
  return render(
    <ParameterProvider>
      <Probe />
    </ParameterProvider>
  );
}

function readyDefaults() {
  apiMocks.getParameterStatus.mockResolvedValue(statusView());
  apiMocks.getAllParameters.mockResolvedValue(listView());
  apiMocks.getMetadataOverview.mockResolvedValue({
    success: true,
    vehicle: "copter",
    metadataStatus: metadataAvailable,
    groups: ["Waypoints", "FailSafe"],
  } as ApiResult<{ success: true; vehicle: string; metadataStatus: typeof metadataAvailable; groups: string[] }>);
  apiMocks.refreshParameters.mockResolvedValue({ success: true, sync: syncComplete });
}

function readProbe(): Record<string, unknown> {
  return JSON.parse(screen.getByTestId("probe").textContent ?? "{}");
}

beforeEach(() => {
  window.localStorage.clear();
  readyDefaults();
});

describe("ParameterStore", () => {
  it("rehydrates from REST without triggering a vehicle download", async () => {
    renderStore();
    await waitFor(() => expect(readProbe().loading).toBe(false));

    expect(apiMocks.getParameterStatus).toHaveBeenCalledTimes(1);
    expect(apiMocks.getAllParameters).toHaveBeenCalledTimes(1);
    expect(apiMocks.refreshParameters).not.toHaveBeenCalled();
    expect(readProbe()).toMatchObject({
      connection: "READY",
      count: sampleEntries().length,
      sessionId: "abc123",
    });
  });

  it("maps a disconnected status into the UI state", async () => {
    apiMocks.getParameterStatus.mockResolvedValue(
      statusView({ connection: "DISCONNECTED", sessionId: null })
    );
    apiMocks.getAllParameters.mockResolvedValue(
      listView({ connection: "DISCONNECTED", count: 0, parameters: [] })
    );
    renderStore();
    await waitFor(() => expect(readProbe().loading).toBe(false));
    expect(readProbe()).toMatchObject({
      connection: "DISCONNECTED",
      count: 0,
      sessionId: null,
    });
  });

  it("applies a parameter:updated value onto the store authoritatively", async () => {
    renderStore();
    await waitFor(() => expect(readProbe().count).toBe(sampleEntries().length));

    act(() => {
      emitter.emit("parameter:updated", {
        id: "WP_RADIUS_M",
        value: 9.25,
        type: "FLOAT",
        sessionId: "abc123",
      });
    });

    expect(readProbe().value).toBe(9.25);
  });

  it("clears the store when the session disconnects", async () => {
    renderStore();
    await waitFor(() => expect(readProbe().count).toBe(sampleEntries().length));

    act(() => {
      emitter.emit("parameter:session", {
        connection: "disconnected",
        sessionId: null,
        reason: "disconnect",
      });
    });

    expect(readProbe()).toMatchObject({
      connection: "DISCONNECTED",
      count: 0,
      sessionId: null,
      syncActive: false,
    });
  });

  it("walks a full sync lifecycle on a new session", async () => {
    renderStore();
    await waitFor(() => expect(readProbe().count).toBe(sampleEntries().length));

    act(() => {
      emitter.emit("parameter:session", {
        connection: "connected",
        sessionId: "new-session-9",
      });
    });
    expect(readProbe()).toMatchObject({ count: 0, connection: "CONNECTING" });

    act(() => {
      emitter.emit("parameter:sync:start", { sessionId: "new-session-9", expectedCount: 1379 });
    });
    expect(readProbe()).toMatchObject({
      connection: "SYNCING",
      syncActive: true,
      syncExpected: 1379,
    });

    act(() => {
      emitter.emit("parameter:sync:progress", {
        sessionId: "new-session-9",
        receivedCount: 500,
        expectedCount: 1379,
      });
    });
    expect(readProbe().syncReceived).toBe(500);

    act(() => {
      emitter.emit("parameter:sync:complete", {
        sessionId: "new-session-9",
        status: "complete",
        complete: true,
      });
    });

    await waitFor(() =>
      expect(readProbe()).toMatchObject({ connection: "READY", count: sampleEntries().length })
    );
  });

  it("marks ERROR and keeps partial data on sync:error", async () => {
    renderStore();
    await waitFor(() => expect(readProbe().count).toBe(sampleEntries().length));

    act(() => {
      emitter.emit("parameter:sync:error", {
        sessionId: "abc123",
        code: "TIMEOUT",
        message: "Parameter synchronization failed.",
      });
    });

    expect(readProbe()).toMatchObject({
      connection: "ERROR",
      syncActive: false,
      syncError: "Parameter synchronization failed.",
    });
  });

  it("blocks duplicate refresh downloads while one is in flight", async () => {
    const user = userEvent.setup();
    let resolveRefresh: (value: unknown) => void = () => undefined;
    apiMocks.refreshParameters.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve;
        })
    );

    renderStore();
    await waitFor(() => expect(readProbe().count).toBe(sampleEntries().length));

    const button = screen.getByRole("button", { name: "refresh" });
    await user.click(button);
    await user.click(button);

    expect(apiMocks.refreshParameters).toHaveBeenCalledTimes(1);
    expect(readProbe().refreshing).toBe(true);

    await act(async () => {
      resolveRefresh({ success: true, sync: syncComplete });
    });

    act(() => {
      emitter.emit("parameter:sync:complete", {
        sessionId: "abc123",
        status: "complete",
        complete: true,
      });
    });

    await waitFor(() => expect(readProbe().refreshing).toBe(false));

    await user.click(button);
    await act(async () => {
      resolveRefresh({ success: true, sync: syncComplete });
    });
    act(() => {
      emitter.emit("parameter:sync:complete", {
        sessionId: "abc123",
        status: "complete",
        complete: true,
      });
    });
    await waitFor(() => expect(readProbe().refreshing).toBe(false));

    expect(apiMocks.refreshParameters).toHaveBeenCalledTimes(2);
  });

  it("surfaces a refresh failure without leaving the UI stuck", async () => {
    const user = userEvent.setup();
    apiMocks.getParameterStatus.mockResolvedValue(
      statusView({ connection: "DISCONNECTED", sessionId: null })
    );
    apiMocks.getAllParameters.mockResolvedValue(
      listView({ connection: "DISCONNECTED", count: 0, parameters: [] })
    );
    renderStore();
    await waitFor(() => expect(readProbe().loading).toBe(false));

    apiMocks.refreshParameters.mockRejectedValue(new Error("Not connected to the flight controller."));
    await user.click(screen.getByRole("button", { name: "refresh" }));

    await waitFor(() =>
      expect(readProbe()).toMatchObject({
        refreshing: false,
        loadError: "Not connected to the flight controller.",
      })
    );
  });
});

describe("ParameterStore – Phase 4 staging", () => {
  it("stages a value locally without touching live state or the vehicle", async () => {
    const user = userEvent.setup();
    apiMocks.refreshParameters.mockClear();
    renderStore();
    await waitFor(() => expect(readProbe().count).toBe(sampleEntries().length));

    await user.click(screen.getByRole("button", { name: "stage3" }));

    expect(readProbe().stagedCount).toBe(1);
    expect(readProbe().stagedValue).toBe(3);
    expect(readProbe().stagedOriginal).toBe(2);
    // live vehicle value is still the original — nothing was written
    expect(readProbe().value).toBe(2);
    expect(apiMocks.refreshParameters).not.toHaveBeenCalled();
    expect(apiMocks.getAllParameters).toHaveBeenCalledTimes(1);
  });

  it("rejects out-of-range values through the store API", async () => {
    const user = userEvent.setup();
    renderStore();
    await waitFor(() => expect(readProbe().count).toBe(sampleEntries().length));

    await user.click(screen.getByRole("button", { name: "stage500" }));

    expect(readProbe().stagedCount).toBe(0);
    expect(readProbe().stagedValue).toBeNull();
    expect(readProbe().value).toBe(2);
  });

  it("keeps originalValue stable across repeated edits to the same parameter", async () => {
    const user = userEvent.setup();
    renderStore();
    await waitFor(() => expect(readProbe().count).toBe(sampleEntries().length));

    await user.click(screen.getByRole("button", { name: "stage3" }));
    expect(readProbe().stagedValue).toBe(3);
    expect(readProbe().stagedOriginal).toBe(2);

    await user.click(screen.getByRole("button", { name: "stage4" }));
    expect(readProbe()).toMatchObject({
      stagedValue: 4,
      stagedOriginal: 2,
      stagedCount: 1,
    });
  });

  it("revert returns the value to live, discardAll clears everything", async () => {
    const user = userEvent.setup();
    renderStore();
    await waitFor(() => expect(readProbe().count).toBe(sampleEntries().length));

    await user.click(screen.getByRole("button", { name: "stage3" }));
    expect(readProbe().stagedCount).toBe(1);

    await user.click(screen.getByRole("button", { name: "revertSel" }));
    expect(readProbe().stagedCount).toBe(0);
    expect(readProbe().stagedValue).toBeNull();

    await user.click(screen.getByRole("button", { name: "stage3" }));
    expect(readProbe().stagedCount).toBe(1);
    await user.click(screen.getByRole("button", { name: "discard" }));
    expect(readProbe().stagedCount).toBe(0);
  });

  it("parameter:updated while staged keeps staged value and flags an external conflict", async () => {
    const user = userEvent.setup();
    renderStore();
    await waitFor(() => expect(readProbe().count).toBe(sampleEntries().length));

    await user.click(screen.getByRole("button", { name: "stage3" }));
    expect(readProbe()).toMatchObject({ stagedCount: 1, stagedConflict: false });

    act(() => {
      emitter.emit("parameter:updated", {
        id: "WP_RADIUS_M",
        value: 3.5,
        type: "FLOAT",
        sessionId: "abc123",
      });
    });

    expect(readProbe()).toMatchObject({
      stagedValue: 3,
      stagedOriginal: 2,
      stagedLiveValue: 3.5,
      stagedConflict: true,
      stagedConflictKind: "EXTERNAL_LIVE_CHANGE",
      value: 3.5, // live store updated authoritatively
    });
  });

  it("reconciles staged state after a full sync without writing anything", async () => {
    const user = userEvent.setup();
    renderStore();
    await waitFor(() => expect(readProbe().count).toBe(sampleEntries().length));

    await user.click(screen.getByRole("button", { name: "stage3" }));

    // New session → fresh download reports a different live value.
    apiMocks.getAllParameters.mockResolvedValue(
      listView({
        parameters: sampleEntries().map((p) =>
          p.id === "WP_RADIUS_M"
            ? {
                ...p,
                live: { value: 2.5, type: "FLOAT" as const, received: true },
              }
            : p
        ),
      })
    );

    act(() => {
      emitter.emit("parameter:session", { connection: "connected", sessionId: "s2" });
      emitter.emit("parameter:sync:start", { sessionId: "s2", expectedCount: 7 });
      emitter.emit("parameter:sync:complete", { sessionId: "s2", status: "complete" });
    });

    await waitFor(() =>
      expect(readProbe()).toMatchObject({
        stagedCount: 1,
        stagedValue: 3,
        stagedOriginal: 2,
        stagedLiveValue: 2.5,
        stagedConflict: true,
        stagedConflictKind: "SESSION_RECONNECT_CHANGE",
      })
    );
    expect(apiMocks.refreshParameters).not.toHaveBeenCalled();
  });

  it("drops staged edits for parameters that disappear after reconnect", async () => {
    const user = userEvent.setup();
    renderStore();
    await waitFor(() => expect(readProbe().count).toBe(sampleEntries().length));

    await user.click(screen.getByRole("button", { name: "stage3" }));

    // Reconnect with a dataset lacking WP_RADIUS_M.
    apiMocks.getAllParameters.mockResolvedValue(
      listView({
        parameters: sampleEntries().filter((p) => p.id !== "WP_RADIUS_M"),
      })
    );

    act(() => {
      emitter.emit("parameter:session", { connection: "connected", sessionId: "s3" });
      emitter.emit("parameter:sync:start", { sessionId: "s3", expectedCount: 6 });
      emitter.emit("parameter:sync:complete", { sessionId: "s3", status: "complete" });
    });

    await waitFor(() => expect(readProbe().stagedCount).toBe(0));
  });

  it("keeps staged edits across a disconnect — never writes on resume", async () => {
    const user = userEvent.setup();
    renderStore();
    await waitFor(() => expect(readProbe().count).toBe(sampleEntries().length));

    await user.click(screen.getByRole("button", { name: "stage3" }));
    expect(readProbe().stagedCount).toBe(1);

    act(() => {
      emitter.emit("parameter:session", {
        connection: "disconnected",
        sessionId: null,
        reason: "link loss",
      });
    });

    expect(readProbe()).toMatchObject({
      connection: "DISCONNECTED",
      count: 0,
      stagedCount: 1, // staged survives, nothing was written
      stagedValue: 3,
    });
    expect(apiMocks.refreshParameters).not.toHaveBeenCalled();
  });

  it("persists staged edits across a remount and restores them", async () => {
    const user = userEvent.setup();
    const first = renderStore();
    await waitFor(() => expect(readProbe().count).toBe(sampleEntries().length));

    await user.click(screen.getByRole("button", { name: "stage3" }));
    expect(window.localStorage.getItem("yantrayug.parameterStaged.v1")).toBeTruthy();

    first.unmount();
    renderStore();
    await waitFor(() => expect(readProbe().count).toBe(sampleEntries().length));

    expect(readProbe()).toMatchObject({
      stagedCount: 1,
      stagedValue: 3,
      stagedOriginal: 2,
      stagedConflict: false,
      value: 2, // live value still from the vehicle, never restored from disk
    });
  });
});