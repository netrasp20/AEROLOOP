import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

function makeContext(overrides: Record<string, any> = {}) {
  return {
    connection: "READY",
    vehicleType: "COPTER",
    entries: {},
    staged: {},
    stageValue: vi.fn(),
    revert: vi.fn(),
    executeWrite: vi.fn().mockResolvedValue({ written: 0 }),
    syncing: false,
    loading: false,
    loadError: null,
    count: 0,
    refreshing: false,
    sync: { active: false, phase: "idle", done: 0, total: 0 },
    writePhase: "idle",
    ...overrides,
  };
}

function makeEntries(scenario: "supported" | "unsupported" = "supported") {
  const entries: Record<string, any> = {};
  if (scenario === "supported") {
    entries["OSD_TYPE"] = { id: "OSD_TYPE", live: { value: 3 }, metadata: { min: 0, max: 5, increment: 1 } };
    entries["OSD1_ENABLE"] = { id: "OSD1_ENABLE", live: { value: 1 }, metadata: { min: 0, max: 1, increment: 1 } };
    entries["OSD2_ENABLE"] = { id: "OSD2_ENABLE", live: { value: 0 }, metadata: { min: 0, max: 1, increment: 1 } };
    for (const id of ["ALTITUDE", "BAT_VOLT", "RSSI", "CURRENT", "SATS"]) {
      entries[`OSD1_${id}_EN`] = { id: `OSD1_${id}_EN`, live: { value: 1 }, metadata: { min: 0, max: 1, increment: 1 } };
      entries[`OSD1_${id}_X`] = { id: `OSD1_${id}_X`, live: { value: 10 }, metadata: { min: 0, max: 59, increment: 1 } };
      entries[`OSD1_${id}_Y`] = { id: `OSD1_${id}_Y`, live: { value: 5 }, metadata: { min: 0, max: 23, increment: 1 } };
    }
  }
  return entries;
}

let ctx: ReturnType<typeof makeContext>;

vi.mock("../../context/ParameterContext", () => {
  const mocks = { ctx: null as null | ReturnType<typeof makeContext> };
  return {
    useParameters: () => mocks.ctx!,
    __mocks: mocks,
  };
});

vi.mock("../../hooks/useSocketTelemetry", () => ({
  default: () => ({}),
}));

import OsdConfig from "./OsdConfig";
import * as paramContext from "../../context/ParameterContext";

const paramMocks = (paramContext as unknown as { __mocks: { ctx: ReturnType<typeof makeContext> } }).__mocks;

function renderOsd(scenario: "supported" | "unsupported" = "supported", ctxOverrides: Record<string, any> = {}) {
  ctx = makeContext({ entries: makeEntries(scenario), ...ctxOverrides });
  paramMocks.ctx = ctx;
  return render(<OsdConfig />);
}

describe("OsdConfig", () => {
  it("renders the OSD header when supported", () => {
    renderOsd("supported");
    expect(screen.getByText("OnBoard OSD")).toBeDefined();
  });

  it("displays screen tabs 1-4", () => {
    renderOsd("supported");
    expect(screen.getByText("Screen 1")).toBeDefined();
    expect(screen.getByText("Screen 4")).toBeDefined();
  });

  it("shows only elements that exist on the firmware", () => {
    renderOsd("supported");
    const toggle = screen.getByTestId("osd-toggle-ALTITUDE");
    expect(toggle).toBeDefined();
    // FLTIME is not in the mock entries, so its toggle must not exist
    expect(screen.queryByTestId("osd-toggle-FLTIME")).toBeNull();
  });

  it("has position inputs for enabled elements", () => {
    renderOsd("supported");
    const x = screen.getByTestId("osd-x-ALTITUDE") as HTMLInputElement;
    const y = screen.getByTestId("osd-y-ALTITUDE") as HTMLInputElement;
    expect(x).toBeDefined();
    expect(y).toBeDefined();
  });

  it("stages a toggle change through the parameter store", () => {
    renderOsd("supported");
    fireEvent.click(screen.getByTestId("osd-toggle-ALTITUDE"));
    expect(ctx.stageValue).toHaveBeenCalledWith("OSD1_ALTITUDE_EN", 0);
  });

  it("stages a position change through the parameter store", () => {
    renderOsd("supported");
    const x = screen.getByTestId("osd-x-ALTITUDE");
    fireEvent.change(x, { target: { value: "42" } });
    expect(ctx.stageValue).toHaveBeenCalledWith("OSD1_ALTITUDE_X", 42);
  });

  it("shows the staged badge when entries are staged", () => {
    const staged: Record<string, any> = {
      OSD1_ALTITUDE_X: { stagedValue: 42, liveValue: 10 },
    };
    renderOsd("supported", { staged });
    expect(screen.getByTestId("osd-staged-count")).toBeDefined();
  });

  it("discard-all reverts each staged element param", () => {
    const staged: Record<string, any> = {
      OSD1_ALTITUDE_X: { stagedValue: 42, liveValue: 10 },
      OSD1_RSSI_EN: { stagedValue: 0, liveValue: 1 },
    };
    renderOsd("supported", { staged });
    fireEvent.click(screen.getByTestId("osd-discard-btn"));
    expect(ctx.revert).toHaveBeenCalledWith("OSD1_ALTITUDE_X");
    expect(ctx.revert).toHaveBeenCalledWith("OSD1_RSSI_EN");
  });

  it("save button calls executeWrite on the store", () => {
    const staged: Record<string, any> = {
      OSD1_ALTITUDE_X: { stagedValue: 42, liveValue: 10 },
    };
    renderOsd("supported", { staged });
    fireEvent.click(screen.getByTestId("osd-save-btn"));
    expect(ctx.executeWrite).toHaveBeenCalled();
  });

  it("switches screen tabs and keyed params off the active screen", () => {
    // Add OSD2 params for one element to test screen 2 staging
    const entries = makeEntries("supported");
    entries["OSD2_ALTITUDE_EN"] = { id: "OSD2_ALTITUDE_EN", live: { value: 1 }, metadata: { min: 0, max: 1, increment: 1 } };
    entries["OSD2_ALTITUDE_X"] = { id: "OSD2_ALTITUDE_X", live: { value: 10 }, metadata: { min: 0, max: 59, increment: 1 } };
    entries["OSD2_ALTITUDE_Y"] = { id: "OSD2_ALTITUDE_Y", live: { value: 5 }, metadata: { min: 0, max: 23, increment: 1 } };
    renderOsd("supported", { entries });
    fireEvent.click(screen.getByTestId("osd-screen-tab-2"));
    expect(screen.getByTestId("osd-toggle-ALTITUDE")).toBeDefined();
    fireEvent.click(screen.getByTestId("osd-toggle-ALTITUDE"));
    expect(ctx.stageValue).toHaveBeenCalledWith("OSD2_ALTITUDE_EN", 0);
  });

  it("shows unsupported message when OSD_TYPE is absent but vehicle is copter", () => {
    renderOsd("unsupported");
    expect(screen.getByTestId("osd-unsupported")).toBeDefined();
    expect(screen.getByText(/OSD_TYPE parameter was not found/)).toBeDefined();
  });

  it("shows no fake element controls when firmware exposes no element params", () => {
    // OSD_TYPE present, but zero OSD{e}_* element params (firmware OSD off)
    const entries = makeEntries("unsupported");
    entries["OSD_TYPE"] = { id: "OSD_TYPE", live: { value: 0 }, metadata: { min: 0, max: 5, increment: 1 } };
    renderOsd("supported", { entries });
    expect(screen.getByTestId("osd-elements-empty")).toBeDefined();
    expect(screen.queryByTestId("osd-toggle-ALTITUDE")).toBeNull();
  });

  it("shows disconnected state when not connected", () => {
    renderOsd("supported", { connection: "DISCONNECTED" });
    expect(screen.getByTestId("osd-disconnected")).toBeDefined();
  });

  it("shows non-copter notice for non-copter vehicles", () => {
    renderOsd("supported", { vehicleType: "ROVER" });
    expect(screen.getByTestId("osd-non-copter")).toBeDefined();
  });
});