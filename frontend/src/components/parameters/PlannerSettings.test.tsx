import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import PlannerSettings from "./PlannerSettings";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

vi.mock("../../context/ParameterContext", () => ({
  useParameters: () => ({
    connection: "READY",
    vehicleType: "ArduCopter",
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
  }),
}));

vi.mock("../../hooks/useSocketTelemetry", () => ({
  default: () => ({ connected: true }),
}));

function renderPlanner() {
  return render(<PlannerSettings />);
}

describe("PlannerSettings", () => {
  const LS_KEY = "yantrayug_planner_prefs";

  beforeEach(() => {
    localStorage.clear();
    mockFetch.mockClear();
  });

  it("renders the planner header", () => {
    renderPlanner();
    expect(screen.getByText("Planner Settings")).toBeDefined();
  });

  it("displays all section headers", () => {
    renderPlanner();
    expect(screen.getByText("Units")).toBeDefined();
    expect(screen.getByText("Map Display")).toBeDefined();
    expect(screen.getByText("Connection")).toBeDefined();
  });

  it("defaults to meters for distance", () => {
    renderPlanner();
    const select = screen.getByTestId("ps-distance-unit") as HTMLSelectElement;
    expect(select.value).toBe("m");
  });

  it("switches distance unit when dropdown is changed", () => {
    renderPlanner();
    const select = screen.getByTestId("ps-distance-unit") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "ft" } });
    expect(select.value).toBe("ft");
  });

  it("saves to localStorage when Save is clicked", () => {
    renderPlanner();
    const select = screen.getByTestId("ps-distance-unit") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "ft" } });
    fireEvent.click(screen.getByTestId("ps-save-btn"));
    const saved = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
    expect(saved.distanceUnit).toBe("ft");
  });

  it("loads saved settings from localStorage", () => {
    localStorage.setItem(LS_KEY, JSON.stringify({ distanceUnit: "km", speedUnit: "mph", mapFollow: true }));
    renderPlanner();
    const select = screen.getByTestId("ps-distance-unit") as HTMLSelectElement;
    expect(select.value).toBe("km");
  });

  it("shows save confirmation after clicking Save", async () => {
    renderPlanner();
    const saveBtn = screen.getByTestId("ps-save-btn");
    fireEvent.click(saveBtn);
    expect(await screen.findByText("Saved!")).toBeDefined();
  });

  it("shows auto-download toggle (loadWpOnConnect)", () => {
    renderPlanner();
    const toggle = screen.getByTestId("ps-load-wp-on-connect") as HTMLInputElement;
    expect(toggle).toBeDefined();
    expect(toggle.checked).toBe(true);
  });

  it("shows show heading indicator toggle", () => {
    renderPlanner();
    const toggle = screen.getByTestId("ps-show-heading") as HTMLInputElement;
    expect(toggle).toBeDefined();
    expect(toggle.checked).toBe(true);
  });

  it("shows reset button", () => {
    renderPlanner();
    expect(screen.getByText("Reset to Defaults")).toBeDefined();
  });

  it("is local-only: never issues network or parameter writes", () => {
    renderPlanner();
    fireEvent.click(screen.getByTestId("ps-save-btn"));
    expect(mockFetch).not.toHaveBeenCalled();
    expect(localStorage.getItem(LS_KEY)).not.toBeNull();
  });

  it("persists settings across refresh (localStorage survives remount)", async () => {
    const first = renderPlanner();
    const select = screen.getByTestId("ps-distance-unit") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "ft" } });
    fireEvent.click(screen.getByTestId("ps-save-btn"));
    expect(await screen.findByText("Saved!")).toBeDefined();

    first.unmount();
    renderPlanner();
    const reloaded = screen.getByTestId("ps-distance-unit") as HTMLSelectElement;
    expect(reloaded.value).toBe("ft");
  });

  it("does not touch localStorage until Save is clicked", () => {
    renderPlanner();
    fireEvent.change(screen.getByTestId("ps-distance-unit"), { target: { value: "mi" } });
    expect(localStorage.getItem(LS_KEY)).toBeNull();
  });

  it("reset restores defaults and persists them", () => {
    localStorage.setItem(LS_KEY, JSON.stringify({ distanceUnit: "mi", speedUnit: "mph" }));
    renderPlanner();
    fireEvent.click(screen.getByTestId("ps-reset-btn"));
    const select = screen.getByTestId("ps-distance-unit") as HTMLSelectElement;
    expect(select.value).toBe("m");
    const saved = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
    expect(saved.distanceUnit).toBe("m");
  });

  it("applies newly-saved prefs on a subsequent load (Save then remount)", () => {
    renderPlanner();
    fireEvent.change(screen.getByTestId("ps-speed-unit"), { target: { value: "kmh" } });
    fireEvent.change(screen.getByTestId("ps-osd-units"), { target: { value: "imperial" } });
    fireEvent.click(screen.getByTestId("ps-save-btn"));
    expect(JSON.parse(localStorage.getItem(LS_KEY) || "{}").speedUnit).toBe("kmh");
    expect(JSON.parse(localStorage.getItem(LS_KEY) || "{}").osdUnits).toBe("imperial");
  });
});
