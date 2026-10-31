import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ParameterProvider, useParameters } from "../../context/ParameterContext";
import ParametersScreen from "./ParametersScreen";
import WriteParamsControl from "./WriteParamsControl";

import {
  listView,
  metadataAvailable,
  statusView,
  syncComplete,
} from "../../test/fixtures";

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

function renderControl() {
  return render(
    <ParameterProvider>
      <WriteParamsControl />
    </ParameterProvider>
  );
}

function renderScreenWithControl() {
  return render(
    <ParameterProvider>
      <WriteParamsControl />
      <ParametersScreen />
    </ParameterProvider>
  );
}

/** Minimal consumer used to drive the shared write pipeline directly. */
function WriteProbe() {
  const { stageValue, executeWrite, writeActiveTxnId, count } = useParameters();
  return (
    <div>
      <span data-testid="probe-ready">{count}</span>
      <span data-testid="probe-txn">{writeActiveTxnId ?? ""}</span>
      <button
        type="button"
        data-testid="probe-stage-3"
        onClick={() => stageValue("WP_RADIUS_M", 3)}
      >
        stage 3
      </button>
      <button
        type="button"
        data-testid="probe-stage-4"
        onClick={() => stageValue("WP_RADIUS_M", 4)}
      >
        stage 4
      </button>
      <button
        type="button"
        data-testid="probe-write"
        onClick={() => void executeWrite()}
      >
        write
      </button>
    </div>
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
  });
  apiMocks.refreshParameters.mockResolvedValue({ success: true, sync: syncComplete });
  apiMocks.writeBatch.mockResolvedValue({
    success: false,
    error: { code: "WRITE_FAILED", message: "unmocked" },
  });
}

beforeEach(() => {
  window.localStorage.clear();
  readyDefaults();
});

describe("WriteParamsControl", () => {
  it("is hidden when no staged parameters exist", async () => {
    renderControl();
    await waitFor(() => expect(screen.queryByTestId("write-params-control")).not.toBeInTheDocument());
  });

  it("appears when staged params exist", async () => {
    const user = userEvent.setup();
    renderScreenWithControl();
    await screen.findByTestId("param-table");

    await user.click(screen.getByTestId("param-row-WP_RADIUS_M"));
    const input = await screen.findByTestId("param-numeric-input");
    await user.clear(input);
    await user.type(input, "3");
    await user.keyboard("{Enter}");

    const btn = await screen.findByTestId("write-params-control");
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveTextContent("Write (1)");
    expect(btn).toBeEnabled();
  });

  it("opens the write dialog on click", async () => {
    const user = userEvent.setup();
    renderScreenWithControl();
    await screen.findByTestId("param-table");

    await user.click(screen.getByTestId("param-row-WP_RADIUS_M"));
    const input = await screen.findByTestId("param-numeric-input");
    await user.clear(input);
    await user.type(input, "3");
    await user.keyboard("{Enter}");

    await user.click(await screen.findByTestId("write-params-control"));
    expect(await screen.findByTestId("write-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("write-review")).toBeInTheDocument();
  });

  it("is disabled while write is in progress", async () => {
    const user = userEvent.setup();
    renderScreenWithControl();
    await screen.findByTestId("param-table");

    await user.click(screen.getByTestId("param-row-WP_RADIUS_M"));
    const input = await screen.findByTestId("param-numeric-input");
    await user.clear(input);
    await user.type(input, "3");
    await user.keyboard("{Enter}");

    await user.click(await screen.findByTestId("write-params-control"));

    emitter.emit("parameter:batch-write:start", {
      transactionId: "txn-1",
      status: "running",
      total: 1,
    });

    await waitFor(() => {
      const btn = screen.getByTestId("write-params-control");
      expect(btn).toBeDisabled();
      expect(btn).toHaveTextContent("Writing...");
    });
  });

  it("never resends a completed transaction id to a later write", async () => {
    // Regression: a finished transactionId used to survive in
    // writeActiveTxnId, so the next write was sent as a resumption of a
    // completed transaction and the backend rejected it with
    // "This write request is stale: no active transaction matches...".
    const success = (transactionId: string, verifiedValue: number) => ({
      success: true,
      transaction: {
        transactionId,
        status: "success",
        total: 1,
        notAttempted: 0,
        interruptedReason: null,
        results: [
          {
            paramId: "WP_RADIUS_M",
            status: "success",
            verifiedValue,
            name: "WP Radius",
          },
        ],
      },
    });
    apiMocks.writeBatch
      .mockResolvedValueOnce(success("txn-a", 3))
      .mockResolvedValueOnce(success("txn-b", 4));

    const user = userEvent.setup();
    render(
      <ParameterProvider>
        <WriteProbe />
      </ParameterProvider>,
    );
    await screen.findByTestId("probe-ready");

    // First write: no transaction exists yet, so no id may be sent.
    await user.click(screen.getByTestId("probe-stage-3"));
    await user.click(screen.getByTestId("probe-write"));
    await waitFor(() => expect(apiMocks.writeBatch).toHaveBeenCalledTimes(1));
    expect(apiMocks.writeBatch.mock.calls[0][2]).toBeUndefined();

    // The backend then streams the full lifecycle of that transaction. The
    // completion event is what used to install its id for the NEXT write.
    emitter.emit("parameter:batch-write:start", {
      transactionId: "txn-a",
      status: "running",
      total: 1,
    });
    emitter.emit("parameter:batch-write:complete", {
      transactionId: "txn-a",
      status: "success",
      total: 1,
      notAttempted: 0,
      interruptedReason: null,
      results: [
        {
          paramId: "WP_RADIUS_M",
          status: "success",
          verifiedValue: 3,
          name: "WP Radius",
        },
      ],
    });
    await waitFor(() => {
      expect(screen.getByTestId("probe-txn").textContent).toBe("");
    });

    // Second write must start a brand new transaction.
    await user.click(screen.getByTestId("probe-stage-4"));
    await user.click(screen.getByTestId("probe-write"));
    await waitFor(() => expect(apiMocks.writeBatch).toHaveBeenCalledTimes(2));
    expect(apiMocks.writeBatch.mock.calls[1][2]).toBeUndefined();
    expect(apiMocks.writeBatch.mock.calls.flat().slice(2)).not.toContain(
      "txn-a",
    );
  });
});
