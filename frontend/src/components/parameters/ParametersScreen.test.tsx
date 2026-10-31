import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ParameterProvider } from "../../context/ParameterContext";
import ParametersScreen from "./ParametersScreen";

import {
  entry,
  listView,
  makeMetadata,
  metadataAvailable,
  sampleEntries,
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

function renderScreen() {
  return render(
    <ParameterProvider>
      <ParametersScreen />
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
    groups: ["Waypoints", "Waypoint Options", "Frame Type", "FailSafe", "Wheel", "GeoFence", "Uncategorized"],
  });
  apiMocks.refreshParameters.mockResolvedValue({ success: true, sync: syncComplete });
}

async function renderReady() {
  renderScreen();
  await screen.findByTestId("param-table");
}

beforeEach(() => {
  window.localStorage.clear();
  readyDefaults();
});

describe("ParametersScreen – connection & lifecycle", () => {
  it("shows a NOT CONNECTED state when the vehicle is disconnected with no data", async () => {
    apiMocks.getParameterStatus.mockResolvedValue(
      statusView({ connection: "DISCONNECTED", sessionId: null })
    );
    apiMocks.getAllParameters.mockResolvedValue(
      listView({ connection: "DISCONNECTED", count: 0, parameters: [] })
    );
    renderScreen();

    expect(await screen.findByTestId("param-state-notconnected")).toBeInTheDocument();
    expect(screen.getByText("NOT CONNECTED")).toBeInTheDocument();
  });

  it("loads the vehicle params on mount without triggering a download", async () => {
    await renderReady();
    expect(screen.getByTestId("param-table")).toBeInTheDocument();
    expect(apiMocks.getAllParameters).toHaveBeenCalledTimes(1);
    expect(apiMocks.refreshParameters).not.toHaveBeenCalled();
  });

  it("shows vehicle type and metadata status in the top bar", async () => {
    await renderReady();
    expect(screen.getByText("QUADROTOR")).toBeInTheDocument();
    expect(screen.getByText(/metadata available/)).toBeInTheDocument();
    expect(screen.getByText(/5691 defs/)).toBeInTheDocument();
  });

  it("clears the table and returns to NOT CONNECTED on session disconnect", async () => {
    await renderReady();
    expect(screen.getByTestId("param-table")).toBeInTheDocument();

    act(() => {
      emitter.emit("parameter:session", {
        connection: "disconnected",
        sessionId: null,
      });
    });

    expect(await screen.findByTestId("param-state-notconnected")).toBeInTheDocument();
  });

  it("drives the sync progress bar from socket progress events", async () => {
    await renderReady();

    act(() => {
      emitter.emit("parameter:session", { connection: "connected", sessionId: "s1" });
      emitter.emit("parameter:sync:start", { sessionId: "s1", expectedCount: 1379 });
      emitter.emit("parameter:sync:progress", { sessionId: "s1", receivedCount: 300, expectedCount: 1379 });
    });

    const progress = await screen.findByTestId("sync-row");
    expect(within(progress).getByText(/300 \/ 1379/)).toBeInTheDocument();
    expect(within(progress).getByText(/22%|21%/)).toBeInTheDocument();
  });
});

describe("ParametersScreen – search", () => {
  it("filters the table client-side with case-insensitive id matching", async () => {
    const user = userEvent.setup();
    await renderReady();

    await user.type(screen.getByTestId("param-search"), "wp_radius");

    await waitFor(() => {
      expect(screen.queryByTestId("param-row-WP_RADIUS_M")).toBeInTheDocument();
      expect(screen.queryByTestId("param-row-FRAME_TYPE")).not.toBeInTheDocument();
    });
  });

  it("never issues HTTP per keystroke while searching", async () => {
    const user = userEvent.setup();
    await renderReady();
    const callsAfterLoad = apiMocks.getAllParameters.mock.calls.length;

    await user.type(screen.getByTestId("param-search"), "frame typ");

    expect(apiMocks.getAllParameters.mock.calls.length).toBe(callsAfterLoad);
  });

  it("shows a no-results state for a miss", async () => {
    const user = userEvent.setup();
    await renderReady();

    await user.type(screen.getByTestId("param-search"), "zzz_nothing");

    expect(await screen.findByTestId("param-state-noresults")).toBeInTheDocument();
    expect(screen.getByText(/No parameters match/)).toBeInTheDocument();
  });

  it("clears the search and restores all rows", async () => {
    const user = userEvent.setup();
    await renderReady();

    await user.type(screen.getByTestId("param-search"), "fence");
    await waitFor(() =>
      expect(screen.queryByTestId("param-row-FENCE_ENABLE")).toBeInTheDocument()
    );

    await user.click(screen.getByRole("button", { name: "Clear search" }));

    await waitFor(() =>
      expect(screen.getByTestId("param-row-FRAME_TYPE")).toBeInTheDocument()
    );
  });
});

describe("ParametersScreen – nav filter counts", () => {
  it("renders nav counts derived from live data", async () => {
    await renderReady();
    const all = screen.getByTestId("param-tab-all");
    const standard = screen.getByTestId("param-tab-standard");
    const advanced = screen.getByTestId("param-tab-advanced");
    expect(within(all).getByText(String(sampleEntries().length))).toBeInTheDocument();
    expect(within(standard).getByText("5")).toBeInTheDocument();
    expect(within(advanced).getByText("2")).toBeInTheDocument();
  });

  it("Standard nav hides Advanced parameters but keeps metadata-less ones", async () => {
    const user = userEvent.setup();
    await renderReady();

    await user.click(screen.getByTestId("param-tab-standard"));

    await waitFor(() => {
      expect(screen.getByTestId("param-row-WP_RADIUS_M")).toBeInTheDocument();
      expect(screen.getByTestId("param-row-SCR_USER1")).toBeInTheDocument();
      expect(screen.queryByTestId("param-row-FS_THR_ENABLE")).not.toBeInTheDocument();
    });
  });

  it("Advanced nav lists only Advanced parameters", async () => {
    const user = userEvent.setup();
    await renderReady();

    await user.click(screen.getByTestId("param-tab-advanced"));

    expect(await screen.findByTestId("param-row-FS_THR_ENABLE")).toBeInTheDocument();
    expect(screen.getByTestId("param-row-CRM_BALANCE")).toBeInTheDocument();
    expect(screen.queryByTestId("param-row-WP_RADIUS_M")).not.toBeInTheDocument();
  });

  it("Full Parameter List restores every parameter after filtering", async () => {
    const user = userEvent.setup();
    await renderReady();

    await user.click(screen.getByTestId("param-tab-advanced"));
    await screen.findByTestId("param-row-FS_THR_ENABLE");

    await user.click(screen.getByTestId("param-tab-all"));

    await waitFor(() =>
      expect(screen.getByTestId("param-row-WP_RADIUS_M")).toBeInTheDocument()
    );
  });
});

describe("ParametersScreen – group tree", () => {
  it("derives groups from the live data including the uncategorized bucket", async () => {
    await renderReady();
    const tree = screen.getByTestId("param-group-tree");
    expect(within(tree).getByText("Waypoints")).toBeInTheDocument();
    expect(within(tree).getByText("Uncategorized")).toBeInTheDocument();
    expect(within(tree).getByText("All Parameters")).toBeInTheDocument();
  });

  it("clicking a group filters the table to that group", async () => {
    const user = userEvent.setup();
    await renderReady();

    await user.click(
      within(screen.getByTestId("param-group-tree")).getByText("Waypoints")
    );

    await waitFor(() => {
      expect(screen.getByTestId("param-row-WP_RADIUS_M")).toBeInTheDocument();
      expect(screen.queryByTestId("param-row-FRAME_TYPE")).not.toBeInTheDocument();
    });
  });

  it("clicking All Parameters clears the group filter", async () => {
    const user = userEvent.setup();
    await renderReady();

    await user.click(
      within(screen.getByTestId("param-group-tree")).getByText("GeoFence")
    );
    await waitFor(() =>
      expect(screen.queryByTestId("param-row-FRAME_TYPE")).not.toBeInTheDocument()
    );

    await user.click(screen.getByTestId("param-group-all"));

    await waitFor(() =>
      expect(screen.getByTestId("param-row-FRAME_TYPE")).toBeInTheDocument()
    );
  });
});

describe("ParametersScreen – inline editing & staging", () => {
  async function stageRadius(user: ReturnType<typeof userEvent.setup>, value: string) {
    await user.click(screen.getByTestId("param-row-WP_RADIUS_M"));
    const input = await screen.findByTestId("param-numeric-input");
    await user.clear(input);
    await user.type(input, value);
    await user.keyboard("{Enter}");
  }

  it("stages a numeric edit on Enter without any write to the vehicle", async () => {
    const user = userEvent.setup();
    await renderReady();
    const downloadsBefore = apiMocks.getAllParameters.mock.calls.length;

    await stageRadius(user, "3");

    expect(screen.getByTestId("param-modified-badge")).toBeInTheDocument();
    expect(
      within(screen.getByTestId("param-staged-banner")).getByText("2 → 3")
    ).toBeInTheDocument();
    expect(screen.getByTestId("param-staged-chip")).toHaveTextContent(
      "1 modified"
    );
    expect(screen.getByTestId("param-current-value")).toHaveTextContent("2");
    expect(apiMocks.refreshParameters).not.toHaveBeenCalled();
    expect(apiMocks.getAllParameters.mock.calls.length).toBe(downloadsBefore);
  });

  it("blur commits the local draft too (still no writes)", async () => {
    const user = userEvent.setup();
    await renderReady();

    await user.click(screen.getByTestId("param-row-WP_RADIUS_M"));
    const input = await screen.findByTestId("param-numeric-input");
    await user.clear(input);
    await user.type(input, "4");
    await user.click(screen.getByTestId("param-row-WPNAV_SPEED")); // blur away

    await user.click(screen.getByTestId("param-row-WP_RADIUS_M"));
    expect(await screen.findByTestId("param-modified-badge")).toBeInTheDocument();
    expect(
      within(screen.getByTestId("param-staged-banner")).getByText("2 → 4")
    ).toBeInTheDocument();
    expect(apiMocks.refreshParameters).not.toHaveBeenCalled();
  });

  it("invalid numeric input shows a validation error and creates no staged state", async () => {
    const user = userEvent.setup();
    await renderReady();
    await user.click(screen.getByTestId("param-row-WP_RADIUS_M"));
    const input = await screen.findByTestId("param-numeric-input");
    await user.clear(input);
    await user.type(input, "150");
    await user.keyboard("{Enter}");

    expect(screen.getByTestId("param-stage-error")).toHaveTextContent(
      /between 0 and 100/
    );
    expect(screen.queryByTestId("param-staged-chip")).not.toBeInTheDocument();
    expect(screen.queryByTestId("param-modified-badge")).not.toBeInTheDocument();
  });

  it("editing back to the vehicle value removes the modified state", async () => {
    const user = userEvent.setup();
    await renderReady();
    await stageRadius(user, "3");
    expect(screen.getByTestId("param-staged-chip")).toBeInTheDocument();

    await stageRadius(user, "2");
    expect(screen.queryByTestId("param-staged-chip")).not.toBeInTheDocument();
    expect(screen.queryByTestId("param-modified-badge")).not.toBeInTheDocument();
  });

  it("integer parameters reject decimals", async () => {
    const user = userEvent.setup();
    await renderReady();
    await user.click(screen.getByTestId("param-row-WPNAV_SPEED"));
    const input = await screen.findByTestId("param-numeric-input");
    await user.clear(input);
    await user.type(input, "1200.5");
    await user.keyboard("{Enter}");

    expect(screen.getByTestId("param-stage-error")).toHaveTextContent(
      /must be an integer/
    );
    expect(screen.queryByTestId("param-staged-chip")).not.toBeInTheDocument();
  });

  it("stages an enum selection via the select and shows range text", async () => {
    const user = userEvent.setup();
    await renderReady();

    await user.click(screen.getByTestId("param-row-FRAME_TYPE"));
    const select = await screen.findByTestId("param-enum-select");
    await user.selectOptions(select, "1");

    expect(screen.getByTestId("param-modified-badge")).toBeInTheDocument();
    expect(screen.getByTestId("param-range-text")).toHaveTextContent("0 → 1");
    expect(apiMocks.refreshParameters).not.toHaveBeenCalled();
  });

  it("stages bitmask bits by toggling checkboxes", async () => {
    const user = userEvent.setup();
    await renderReady();

    await user.click(screen.getByTestId("param-row-CRM_BALANCE"));
    await screen.findByTestId("param-editor-bitmask");

    const learnBox = within(screen.getByTestId("param-editor-bitmask")).getByRole(
      "checkbox",
      { name: /Learn/ }
    );
    // live 5 = bits 0 (Learn) + 2 (Brake); unchecking Learn → 4
    await user.click(learnBox);

    expect(screen.getByTestId("param-range-text")).toHaveTextContent("5 → 4");
    expect(apiMocks.refreshParameters).not.toHaveBeenCalled();
  });

  it("read-only parameters expose no editor", async () => {
    const user = userEvent.setup();
    apiMocks.getAllParameters.mockResolvedValue(
      listView({
        parameters: [
          ...sampleEntries(),
          entry({
            id: "ARMING_REQUIRE",
            metadata: makeMetadata({
              id: "ARMING_REQUIRE",
              readOnly: true,
              group: "Arming",
            }),
            live: { value: 1, type: "UINT8", received: true },
          }),
        ],
      })
    );
    await renderReady();

    await user.click(screen.getByTestId("param-row-ARMING_REQUIRE"));
    expect(await screen.findByTestId("param-editor-readonly")).toBeInTheDocument();
    expect(screen.getByTestId("param-readonly-note")).toBeInTheDocument();
    expect(screen.queryByTestId("param-numeric-input")).not.toBeInTheDocument();
  });

  it("Modified checkbox shows only staged params; counts update dynamically", async () => {
    const user = userEvent.setup();
    await renderReady();

    await stageRadius(user, "3");

    await user.click(screen.getByTestId("param-tab-modified"));
    await waitFor(() =>
      expect(screen.getByTestId("param-row-WP_RADIUS_M")).toBeInTheDocument()
    );
    expect(screen.queryByTestId("param-row-FRAME_TYPE")).not.toBeInTheDocument();

    // Click into the row to open the editor and revert
    await user.click(screen.getByTestId("param-row-WP_RADIUS_M"));
    await user.click(screen.getByTestId("param-revert-action"));

    await waitFor(() =>
      expect(screen.queryByTestId("param-row-WP_RADIUS_M")).not.toBeInTheDocument()
    );
  });

  it("search, group and Modified filters combine correctly", async () => {
    const user = userEvent.setup();
    await renderReady();
    await stageRadius(user, "3");

    await user.click(screen.getByTestId("param-tab-modified"));
    await user.click(
      within(screen.getByTestId("param-group-tree")).getByText("Waypoints")
    );
    await screen.findByTestId("param-row-WP_RADIUS_M");

    const query = screen.getByTestId("param-search");
    await user.type(query, "radius");
    expect(screen.getByTestId("param-row-WP_RADIUS_M")).toBeInTheDocument();

    await user.type(query, "zzz");
    await waitFor(() =>
      expect(screen.getByTestId("param-state-noresults")).toBeInTheDocument()
    );
  });

  it("switching the selected parameter preserves staged edits", async () => {
    const user = userEvent.setup();
    await renderReady();
    await stageRadius(user, "3");
    expect(screen.getByTestId("param-staged-chip")).toBeInTheDocument();

    await user.click(screen.getByTestId("param-row-FRAME_TYPE"));
    const range = screen.getByTestId("param-range-WP_RADIUS_M");
    expect(range).toHaveTextContent("2 → 3");

    await user.click(screen.getByTestId("param-row-WP_RADIUS_M"));
    expect(screen.getByTestId("param-staged-banner")).toBeInTheDocument();
    expect(
      within(screen.getByTestId("param-staged-banner")).getByText("2 → 3")
    ).toBeInTheDocument();
  });

  it("Discard All confirms and clears; Confirm=false keeps staged edits", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm");
    await renderReady();
    await stageRadius(user, "3");
    expect(screen.getByTestId("param-staged-chip")).toBeInTheDocument();

    confirmSpy.mockReturnValue(false);
    await user.click(screen.getByTestId("param-discard-all"));
    expect(screen.getByTestId("param-staged-chip")).toBeInTheDocument();

    confirmSpy.mockReturnValue(true);
    await user.click(screen.getByTestId("param-discard-all"));
    expect(screen.queryByTestId("param-staged-chip")).not.toBeInTheDocument();

    confirmSpy.mockRestore();
  });

  it("Refresh prompts when modified; cancel aborts, accept downloads", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm");
    await renderReady();
    await stageRadius(user, "3");

    confirmSpy.mockReturnValue(false);
    await user.click(screen.getByRole("button", { name: /Refresh/ }));
    expect(apiMocks.refreshParameters).not.toHaveBeenCalled();

    confirmSpy.mockReturnValue(true);
    await user.click(screen.getByRole("button", { name: /Refresh/ }));
    expect(apiMocks.refreshParameters).toHaveBeenCalledTimes(1);

    confirmSpy.mockRestore();
  });

  it("Refresh does NOT prompt when nothing is modified", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm");
    await renderReady();

    await user.click(screen.getByRole("button", { name: /Refresh/ }));
    expect(apiMocks.refreshParameters).toHaveBeenCalledTimes(1);
    expect(confirmSpy).not.toHaveBeenCalled();

    confirmSpy.mockRestore();
  });

  it("an external parameter:updated while staged marks a conflict but keeps the edit", async () => {
    const user = userEvent.setup();
    await renderReady();
    await stageRadius(user, "3");

    act(() => {
      emitter.emit("parameter:updated", { id: "WP_RADIUS_M", value: 3.5, type: "FLOAT" });
    });

    await user.click(screen.getByTestId("param-row-WP_RADIUS_M"));

    expect(screen.getByTestId("param-conflict-note")).toHaveTextContent(
      /changed externally/
    );
    expect(screen.getByTestId("param-range-text")).toHaveTextContent("3.5 → 3");
    expect(screen.getByTestId("param-current-value")).toHaveTextContent("3.5");
  });

  it("staged edits survive a browser-style remount via localStorage", async () => {
    const user = userEvent.setup();
    const first = renderScreen();
    await screen.findByTestId("param-table");
    await stageRadius(user, "3");
    expect(screen.getByTestId("param-staged-chip")).toBeInTheDocument();

    first.unmount();
    renderScreen();
    await screen.findByTestId("param-table");

    const chip = await screen.findByTestId("param-staged-chip");
    expect(chip).toHaveTextContent("1 modified");

    await user.click(screen.getByTestId("param-row-WP_RADIUS_M"));
    expect(screen.getByTestId("param-current-value")).toHaveTextContent("2");
    expect(
      within(screen.getByTestId("param-staged-banner")).getByText("2 → 3")
    ).toBeInTheDocument();
  });
});

describe("ParametersScreen – Phase 7E navigation", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ json: () => ({ success: true, entries: [] }) })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows all Phase 7E nav items", async () => {
    await renderReady();
    expect(screen.getByText("Planner Settings")).toBeInTheDocument();
    expect(screen.getByText("OnBoard OSD")).toBeInTheDocument();
    expect(screen.getByText("MAVFTP")).toBeInTheDocument();
  });

  it("renders the Planner Settings page from nav", async () => {
    await renderReady();
    const user = userEvent.setup();
    await user.click(screen.getByText("Planner Settings"));
    expect(await screen.findByTestId("ps-screen")).toBeInTheDocument();
  });

  it("renders the OnBoard OSD page from nav", async () => {
    await renderReady();
    const user = userEvent.setup();
    await user.click(screen.getByText("OnBoard OSD"));
    expect(await screen.findByTestId("osd-screen")).toBeInTheDocument();
  });

  it("renders the MAVFTP page from nav", async () => {
    await renderReady();
    const user = userEvent.setup();
    await user.click(screen.getByText("MAVFTP"));
    expect(await screen.findByTestId("ftp-screen")).toBeInTheDocument();
  });

  it("hides the parameter actions panel on Phase 7E pages", async () => {
    await renderReady();
    const user = userEvent.setup();
    await user.click(screen.getByText("Planner Settings"));
    await screen.findByTestId("ps-screen");
    expect(screen.queryByText("Write to Vehicle")).not.toBeInTheDocument();
  });
});