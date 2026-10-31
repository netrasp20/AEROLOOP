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

import type { ParamAnalysisView } from "../../api/parameters";

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
      getPresets: vi.fn(),
      exportParameters: vi.fn(),
      importParameters: vi.fn(),
      compareParameters: vi.fn(),
      presetAnalyze: vi.fn(),
      resetParameters: vi.fn(),
      getResetStatus: vi.fn(),
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
    getPresets: apiMocks.getPresets,
    exportParameters: apiMocks.exportParameters,
    importParameters: apiMocks.importParameters,
    compareParameters: apiMocks.compareParameters,
    presetAnalyze: apiMocks.presetAnalyze,
    resetParameters: apiMocks.resetParameters,
    getResetStatus: apiMocks.getResetStatus,
  };
});

vi.mock("../../socket/socket", () => ({ default: emitter }));

function readyDefaults() {
  apiMocks.getParameterStatus.mockResolvedValue(statusView());
  apiMocks.getAllParameters.mockResolvedValue(listView());
  apiMocks.getMetadataOverview.mockResolvedValue({
    success: true,
    vehicle: "copter",
    metadataStatus: metadataAvailable,
    groups: ["Waypoints", "GeoFence", "Uncategorized"],
  });
  apiMocks.refreshParameters.mockResolvedValue({ success: true, sync: syncComplete });
}

function analysisView(overrides: Partial<ParamAnalysisView> = {}): ParamAnalysisView {
  return {
    success: true,
    filename: "custom.param",
    parse: {
      total: 3,
      valid: 3,
      malformed: 0,
      duplicate: 0,
      skipped: 0,
      commentLines: 0,
      malformedLines: [],
      duplicateParams: [],
      entries: [
        { paramId: "WP_RADIUS_M", value: 30 },
        { paramId: "WPNAV_SPEED", value: 1800 },
        { paramId: "FRAME_TYPE", value: 0 },
      ],
    },
    compare: {
      counts: { changed: 2, same: 1, unknown: 0, read_only: 0, invalid: 0 },
      diffCount: 2,
      rows: [
        {
          paramId: "WP_RADIUS_M",
          category: "changed",
          vehicleValue: 2,
          fileValue: 30,
          stageable: true,
          stagedValue: null,
          stagedConflict: false,
          message: null,
          readOnly: false,
          group: "Waypoints",
          rebootRequired: false,
        },
        {
          paramId: "WPNAV_SPEED",
          category: "changed",
          vehicleValue: 1200,
          fileValue: 1800,
          stageable: true,
          stagedValue: null,
          stagedConflict: false,
          message: null,
          readOnly: false,
          group: "Waypoint Options",
          rebootRequired: false,
        },
        {
          paramId: "FRAME_TYPE",
          category: "same",
          vehicleValue: 0,
          fileValue: 0,
          stageable: true,
          stagedValue: null,
          stagedConflict: false,
          message: null,
          readOnly: false,
          group: "Frame Type",
          rebootRequired: false,
        },
      ],
      fileIds: ["WP_RADIUS_M", "WPNAV_SPEED", "FRAME_TYPE"],
    },
    ...overrides,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  readyDefaults();
  apiMocks.exportParameters.mockResolvedValue({
    success: true,
    filename: "QUADROTOR_v2.param",
    content: "WP_RADIUS_M 2\n",
    count: 1,
    source: "vehicle",
  });
  apiMocks.importParameters.mockResolvedValue(analysisView());
  apiMocks.compareParameters.mockResolvedValue(analysisView());
  apiMocks.getPresets.mockResolvedValue({
    success: true,
    vehicle: "copter",
    allowed: true,
    presets: [
      { id: "preset-1", name: "Angle Mode", description: "Stabilize preset", vehicle: "copter", paramCount: 2 },
    ],
  });
  apiMocks.presetAnalyze.mockResolvedValue(analysisView());
  apiMocks.resetParameters.mockResolvedValue({ success: true, resetId: "reset-1" });
  apiMocks.getResetStatus.mockResolvedValue({
    success: true,
    active: false,
    resetId: null,
    state: "idle",
    message: "",
    error: null,
    summary: null,
    startedAt: null,
    completedAt: null,
  });
});

async function renderReady() {
  render(
    <ParameterProvider>
      <ParametersScreen />
    </ParameterProvider>
  );
  await screen.findByTestId("param-table");
}

describe("ParametersScreen – Phase 6 file actions", () => {
  it("action buttons wire to the file / write / reset dialogs", async () => {
    await renderReady();
    expect(screen.queryByTestId("file-dialog")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Load from File/ }));
    expect(await screen.findByTestId("file-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("file-dialog")).toHaveTextContent(/Load parameters/);

    userEvent.click(screen.getByRole("button", { name: /Close/ }));
    await userEvent.click(screen.getByRole("button", { name: /Compare Params/ }));
    expect(await screen.findByTestId("file-dialog")).toHaveTextContent(/Compare parameters/);

    userEvent.click(screen.getByRole("button", { name: /Close/ }));
    await userEvent.click(screen.getByRole("button", { name: /Save to File/ }));
    expect(await screen.findByTestId("save-dialog")).toBeInTheDocument();

    userEvent.click(screen.getByTestId("save-cancel"));
    await userEvent.click(screen.getByRole("button", { name: /Reset to Default/ }));
    expect(await screen.findByTestId("reset-dialog")).toBeInTheDocument();
  });

  it("imports a file, shows the diff and stages the changed selection", async () => {
    const user = userEvent.setup();
    await renderReady();

    await user.click(screen.getByRole("button", { name: /Load from File/ }));
    await user.click(screen.getByTestId("file-pick"));

    const input = screen.getByTestId("file-pick").parentElement?.querySelector("input");
    expect(input).not.toBeNull();

    const file = new File(["WP_RADIUS_M 30\n"], "custom.param", { type: "text/plain" });
    await user.upload(input!, file);

    expect(await screen.findByTestId("file-analysis")).toBeInTheDocument();
    expect(apiMocks.importParameters).toHaveBeenCalled();

    expect(screen.getByTestId("compare-row-WP_RADIUS_M")).toBeInTheDocument();
    expect(screen.getByTestId("compare-row-FRAME_TYPE")).toBeInTheDocument();

    expect(screen.getByTestId("file-apply")).toHaveTextContent("Apply selected (2)");

    await user.click(screen.getByTestId("file-apply"));
    expect(await screen.findByTestId("file-apply-result")).toBeInTheDocument();
    expect(screen.getByTestId("file-apply-result")).toHaveTextContent("2 changes staged");

    // The staged chip reflects the file-driven changes (2 values staged).
    expect(screen.getByTestId("param-staged-chip")).toHaveTextContent("2 modified");
  });

  it("compare flow highlights read-only / unknown rows and never stages them", async () => {
    const user = userEvent.setup();
    const withUnusable = analysisView();
    withUnusable.compare.rows = [
      ...withUnusable.compare.rows,
      {
        paramId: "ARMING_REQUIRE",
        category: "read_only",
        vehicleValue: 1,
        fileValue: 0,
        stageable: false,
        stagedValue: null,
        stagedConflict: false,
        message: "Read-only parameter.",
        readOnly: true,
        group: "Arming",
        rebootRequired: false,
      },
      {
        paramId: "SOME_EXTRA",
        category: "unknown",
        vehicleValue: null,
        fileValue: 9,
        stageable: false,
        stagedValue: null,
        stagedConflict: false,
        message: "Not present on the vehicle.",
        readOnly: false,
        group: null,
        rebootRequired: false,
      },
    ];
    apiMocks.compareParameters.mockResolvedValue(withUnusable);

    await renderReady();
    await user.click(screen.getByRole("button", { name: /Compare Params/ }));
    await user.click(screen.getByTestId("file-pick"));

    const input = screen.getByTestId("file-pick").parentElement?.querySelector("input");
    await user.upload(input!, new File(["A 1\n"], "compare.param", { type: "text/plain" }));

    await screen.findByTestId("file-analysis");
    expect(screen.getByTestId("compare-row-ARMING_REQUIRE")).toHaveTextContent(/read-only/);
    expect(screen.getByTestId("compare-row-SOME_EXTRA")).toHaveTextContent(/not on vehicle/);

    const row = screen.getByTestId("compare-row-SOME_EXTRA");
    expect(row.className).toContain("is-unknown");
  });

  it("presets dialog lists sets and applies their staged changes", async () => {
    const user = userEvent.setup();
    await renderReady();

    await user.click(screen.getByRole("button", { name: /Load Presaved/ }));
    expect(await screen.findByTestId("presets-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("preset-preset-1")).toBeInTheDocument();

    await user.click(screen.getByTestId("preset-preset-1"));
    expect(apiMocks.presetAnalyze).toHaveBeenCalledWith("preset-1");
    expect(await screen.findByTestId("preset-analysis")).toBeInTheDocument();

    await user.click(screen.getByTestId("preset-apply"));
    await waitFor(() =>
      expect(screen.getByTestId("param-staged-chip")).toHaveTextContent("2 modified")
    );
  });

  it("save dialog builds a file from live values", async () => {
    const user = userEvent.setup();
    await renderReady();

    await user.click(screen.getByRole("button", { name: /Save to File/ }));
    await user.click(screen.getByTestId("save-go"));

    await waitFor(() => expect(apiMocks.exportParameters).toHaveBeenCalledWith("vehicle"));
    expect(await screen.findByTestId("save-summary")).toHaveTextContent("1 parameters");
    expect(screen.getByTestId("save-download")).toBeInTheDocument();
  });

  it("reset dialog requires confirmation and reports completion via socket events", async () => {
    const user = userEvent.setup();
    await renderReady();

    await user.click(screen.getByRole("button", { name: /Reset to Default/ }));
    expect(await screen.findByTestId("reset-dialog")).toBeInTheDocument();

    const go = screen.getByTestId("reset-go");
    expect(go).toBeDisabled();

    await user.click(screen.getByTestId("reset-confirm"));

    const goEnabled = await within(screen.getByTestId("reset-dialog")).findByTestId("reset-go");
    expect(goEnabled).not.toBeDisabled();

    await user.click(goEnabled);
    await waitFor(() => expect(apiMocks.resetParameters).toHaveBeenCalledWith(true));
    expect(screen.getByTestId("reset-status")).toBeInTheDocument();

    act(() => {
      emitter.emit("parameter:reset:complete", {
        resetId: "reset-1",
        state: "complete",
        backupCount: 7,
        parameterCount: 7,
        changedCount: 3,
        unchangedCount: 4,
        changedParams: ["WP_RADIUS_M", "FRAME_TYPE", "FS_THR_ENABLE"],
        sync: { state: "complete", receivedCount: 7, expectedCount: 7 },
      });
    });

    expect(await screen.findByTestId("reset-complete")).toHaveTextContent(
      "3 changed, 4 unchanged"
    );
  });
});