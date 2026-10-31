import { describe, expect, it, beforeEach, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ParameterProvider } from "../../context/ParameterContext";
import ParametersScreen from "./ParametersScreen";

import {
  listView,
  metadataAvailable,
  statusView,
  syncComplete,
} from "../../test/fixtures";

import type { WriteTransactionSummary } from "../../api/parameters";

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
      writeBatch: vi.fn(),
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
    writeBatch: apiMocks.writeBatch,
  };
});

vi.mock("../../socket/socket", () => ({ default: emitter }));

function readyDefaults() {
  apiMocks.writeBatch.mockResolvedValue({
    success: false,
    error: { code: "WRITE_FAILED", message: "unmocked" },
  });
}

function okTxn(
  overrides: Partial<WriteTransactionSummary>
): WriteTransactionSummary {
  return {
    transactionId: "txn-1",
    sessionId: "abc123",
    status: "success",
    interruptedReason: null,
    total: 1,
    succeeded: 1,
    failed: 0,
    notAttempted: 0,
    startedAt: 1,
    completedAt: 2,
    results: [
      {
        paramId: "WP_RADIUS_M",
        requestedValue: 3,
        originalValue: 2,
        status: "success",
        verifiedValue: 3,
      },
    ],
    ...overrides,
  };
}

async function renderReady() {
  apiMocks.getParameterStatus.mockResolvedValue(statusView());
  apiMocks.getAllParameters.mockResolvedValue(listView());
  apiMocks.getMetadataOverview.mockResolvedValue({
    success: true,
    vehicle: "copter",
    metadataStatus: metadataAvailable,
    groups: ["Waypoints", "FailSafe"],
  });
  apiMocks.refreshParameters.mockResolvedValue({ success: true, sync: syncComplete });
  render(
    <ParameterProvider>
      <ParametersScreen />
    </ParameterProvider>
  );
  await screen.findByTestId("param-table");
}

async function stageRadius(user: ReturnType<typeof userEvent.setup>, value: string) {
  await user.click(screen.getByTestId("param-row-WP_RADIUS_M"));
  const input = await screen.findByTestId("param-numeric-input");
  await user.clear(input);
  await user.type(input, value);
  await user.keyboard("{Enter}");
}

async function stageSpeed(user: ReturnType<typeof userEvent.setup>, value: string) {
  await user.click(screen.getByTestId("param-row-WPNAV_SPEED"));
  const input = await screen.findByTestId("param-numeric-input");
  await user.clear(input);
  await user.type(input, value);
  await user.keyboard("{Enter}");
}

beforeEach(() => {
  window.localStorage.clear();
  readyDefaults();
});

describe("Write Params – review dialog", () => {
  it("shows Write Params permanently, disabled until something is staged", async () => {
    const user = userEvent.setup();
    await renderReady();

    const idle = screen.getByTestId("write-params-button");
    expect(idle).toBeInTheDocument();
    expect(idle).toBeDisabled();
    expect(idle).toHaveTextContent("Write Params");

    await stageRadius(user, "3");

    const button = await screen.findByTestId("write-params-button");
    expect(button).toBeEnabled();
    expect(button).toHaveTextContent("Write Params (1)");
  });

  it("opens the review table with Parameter | Current | New when clicked", async () => {
    const user = userEvent.setup();
    await renderReady();
    await stageRadius(user, "3");

    await user.click(screen.getByTestId("write-params-button"));

    expect(await screen.findByTestId("write-review")).toBeInTheDocument();
    const table = within(screen.getByTestId("write-review")).getByRole("table");
    expect(
      within(table).getByRole("columnheader", { name: "Parameter" })
    ).toBeInTheDocument();
    expect(
      within(table).getByRole("columnheader", { name: "Current" })
    ).toBeInTheDocument();
    expect(
      within(table).getByRole("columnheader", { name: "New" })
    ).toBeInTheDocument();

    const row = within(table).getByRole("row", { name: /WP_RADIUS_M/ });
    expect(within(row).getByText("2")).toBeInTheDocument();
    expect(within(row).getByText("3")).toBeInTheDocument();
  });
});

describe("Write Params – verified write flow", () => {
  it("writes the staged snapshot in one batch and reports verification", async () => {
    const user = userEvent.setup();
    await renderReady();
    await stageRadius(user, "3");
    await stageSpeed(user, "2000");

    apiMocks.writeBatch.mockResolvedValue({
      success: true,
      transaction: okTxn({
        transactionId: "txn-1",
        total: 2,
        succeeded: 2,
        results: [
          {
            paramId: "WP_RADIUS_M",
            requestedValue: 3,
            originalValue: 2,
            status: "success",
            verifiedValue: 3,
          },
          {
            paramId: "WPNAV_SPEED",
            requestedValue: 2000,
            originalValue: 1200,
            status: "success",
            verifiedValue: 2000,
          },
        ],
      }),
    });

    await user.click(screen.getByTestId("write-params-button"));
    await user.click(screen.getByTestId("write-submit"));

    await waitFor(() =>
      expect(apiMocks.writeBatch).toHaveBeenCalledWith(
        [
          { paramId: "WP_RADIUS_M", value: 3, originalValue: 2 },
          { paramId: "WPNAV_SPEED", value: 2000, originalValue: 1200 },
        ],
        [],
        undefined
      )
    );

    await waitFor(() =>
      expect(screen.getByTestId("write-success")).toHaveTextContent(
        "Parameter write complete — 2 / 2 verified"
      )
    );

    // Staged entries are cleared: the button remains visible but disabled.
    await user.click(screen.getByTestId("write-done"));
    const cleared = screen.getByTestId("write-params-button");
    expect(cleared).toBeInTheDocument();
    expect(cleared).toBeDisabled();
    expect(cleared).toHaveTextContent("Write Params");
  });

  it("shows progress via batch-write:start/progress socket events", async () => {
    const user = userEvent.setup();
    await renderReady();
    await stageRadius(user, "3");
    await stageSpeed(user, "2000");
    await user.click(screen.getByTestId("write-params-button"));

    act(() => {
      emitter.emit("parameter:batch-write:start", {
        transactionId: "txn-1",
        status: "running",
        total: 2,
      });
      emitter.emit("parameter:batch-write:progress", {
        transactionId: "txn-1",
        total: 2,
        completed: 1,
        currentParamId: "WPNAV_SPEED",
      });
    });

    const progress = await screen.findByTestId("write-progress");
    expect(within(progress).getByText(/Writing parameters/)).toBeInTheDocument();
    expect(
      within(progress).getByText(/1 \/ 2 · Current: WPNAV_SPEED/)
    ).toBeInTheDocument();

    act(() => {
      emitter.emit(
        "parameter:batch-write:complete",
        okTxn({
          transactionId: "txn-1",
          total: 2,
          succeeded: 2,
          results: [
            {
              paramId: "WP_RADIUS_M",
              requestedValue: 3,
              originalValue: 2,
              status: "success",
              verifiedValue: 3,
            },
            {
              paramId: "WPNAV_SPEED",
              requestedValue: 2000,
              originalValue: 1200,
              status: "success",
              verifiedValue: 2000,
            },
          ],
        })
      );
    });

    await waitFor(() =>
      expect(screen.getByTestId("write-success")).toBeInTheDocument()
    );
    expect(screen.queryByTestId("write-review")).not.toBeInTheDocument();
  });

  it("does not report success when the backend rejects the batch", async () => {
    const user = userEvent.setup();
    await renderReady();
    await stageRadius(user, "3");
    apiMocks.writeBatch.mockResolvedValue({
      success: false,
      error: {
        code: "NOT_CONNECTED",
        message: "The vehicle is not connected.",
      },
    });

    await user.click(screen.getByTestId("write-params-button"));
    await user.click(screen.getByTestId("write-submit"));

    await waitFor(() =>
      expect(screen.getByTestId("write-error")).toBeInTheDocument()
    );
    expect(screen.getByTestId("write-error")).toHaveTextContent(
      "The vehicle is not connected."
    );
    expect(screen.queryByTestId("write-success")).not.toBeInTheDocument();

    // Staging is retained — nothing was verified.
    await user.click(screen.getByTestId("write-close-error"));
    expect(screen.getByTestId("write-params-button")).toBeInTheDocument();
  });
});

describe("Write Params – conflicts", () => {
  it("blocks until the user acknowledges conflicts, then writes with the ack", async () => {
    const user = userEvent.setup();
    await renderReady();
    await stageRadius(user, "3");

    // First attempt: backend reports a live-change conflict.
    apiMocks.writeBatch.mockResolvedValueOnce({
      success: false,
      error: { code: "CONFLICT", message: "Parameter values changed." },
      conflicts: [
        {
          paramId: "WP_RADIUS_M",
          currentValue: 2.5,
          originalValue: 2,
          stagedValue: 3,
        },
      ],
    });
    // Acknowledged attempt succeeds.
    apiMocks.writeBatch.mockResolvedValueOnce({
      success: true,
      transaction: okTxn({
        transactionId: "txn-2",
        results: [
          {
            paramId: "WP_RADIUS_M",
            requestedValue: 3,
            originalValue: 2,
            status: "success",
            verifiedValue: 3,
          },
        ],
      }),
    });

    await user.click(screen.getByTestId("write-params-button"));
    await user.click(screen.getByTestId("write-submit"));

    await waitFor(() =>
      expect(screen.getByTestId("write-conflicts")).toBeInTheDocument()
    );
    expect(screen.getByTestId("write-conflicts")).toHaveTextContent(
      "Original 2 · Vehicle 2.5 · Staged 3"
    );
    // No write happened yet.
    expect(apiMocks.writeBatch).toHaveBeenCalledTimes(1);

    await user.click(screen.getByTestId("write-conflict-ack"));

    await waitFor(() =>
      expect(apiMocks.writeBatch).toHaveBeenLastCalledWith(
        [{ paramId: "WP_RADIUS_M", value: 3, originalValue: 2 }],
        ["WP_RADIUS_M"],
        undefined
      )
    );
    await waitFor(() =>
      expect(screen.getByTestId("write-success")).toHaveTextContent(
        "Parameter write complete — 1 / 1 verified"
      )
    );
  });
});

describe("Write Params – partial failure", () => {
  it("reports exact written/failed/not-written counts and keeps the failed parameter staged", async () => {
    const user = userEvent.setup();
    await renderReady();
    await stageRadius(user, "3");
    await stageSpeed(user, "2000");

    apiMocks.writeBatch.mockResolvedValue({
      success: true,
      transaction: {
        transactionId: "txn-3",
        sessionId: "abc123",
        status: "partial_failure",
        interruptedReason: null,
        total: 2,
        succeeded: 1,
        failed: 1,
        notAttempted: 0,
        startedAt: 1,
        completedAt: 2,
        results: [
          {
            paramId: "WP_RADIUS_M",
            requestedValue: 3,
            originalValue: 2,
            status: "success",
            verifiedValue: 3,
          },
          {
            paramId: "WPNAV_SPEED",
            requestedValue: 2000,
            originalValue: 1200,
            status: "failed",
            code: "WRITE_MISMATCH",
            message: "Write failed for 'WPNAV_SPEED'.",
          },
        ],
      },
    });

    await user.click(screen.getByTestId("write-params-button"));
    await user.click(screen.getByTestId("write-submit"));

    await waitFor(() =>
      expect(screen.getByTestId("write-partial")).toBeInTheDocument()
    );
    expect(screen.getByTestId("write-partial")).toHaveTextContent(
      "1 written, 1 failed, 0 not written"
    );
    const failedRow = within(screen.getByTestId("write-partial")).getByText(
      "WPNAV_SPEED"
    );
    expect(failedRow).toBeInTheDocument();

    // The failed item stays staged; the successful one is cleared.
    await user.click(screen.getByTestId("write-close-partial"));
    const button = await screen.findByTestId("write-params-button");
    expect(button).toHaveTextContent("Write Params (1)");
  });
});

describe("Write Params – session protection", () => {
  it("interrupts an active write when the session changes", async () => {
    const user = userEvent.setup();
    await renderReady();
    await stageRadius(user, "3");
    await user.click(screen.getByTestId("write-params-button"));

    act(() => {
      emitter.emit("parameter:batch-write:start", {
        transactionId: "txn-1",
        status: "running",
        total: 1,
      });
    });
    expect(await screen.findByTestId("write-progress")).toBeInTheDocument();

    act(() => {
      emitter.emit("parameter:session", {
        connection: "connected",
        sessionId: "session-b",
      });
    });

    await waitFor(() =>
      expect(screen.getByTestId("write-interrupted")).toBeInTheDocument()
    );
    expect(screen.getByTestId("write-interrupted")).toHaveTextContent(
      "interrupted"
    );
  });
});