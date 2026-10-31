import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ParameterProvider } from "../../context/ParameterContext";
import GeoFence from "./GeoFence";
import {
  decodeFenceType,
  encodeFenceType,
  FENCE_TYPE_BITS,
} from "../../parameters/geoFenceLogic";

vi.mock("../../hooks/useSocketTelemetry", () => ({
  default: () => ({
    mode: "STABILIZE",
    armed: false,
    vehicleType: "QUADROTOR",
    altitude: 0,
    groundSpeed: 0,
    heading: 0,
    battery: 0,
    satellites: 0,
    distance: 0,
    pitch: 0,
    roll: 0,
    yaw: 0,
  }),
}));

vi.mock("../../context/ParameterContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../context/ParameterContext")>();
  return {
    ...actual,
    useParameters: () => ({
      connection: "READY",
      vehicleType: "QUADROTOR",
      entries: {
        FENCE_ENABLE: { id: "FENCE_ENABLE", live: { value: 1, received: true }, metadata: {} },
        FENCE_TYPE: { id: "FENCE_TYPE", live: { value: 7, received: true }, metadata: {} },
        FENCE_ACTION: { id: "FENCE_ACTION", live: { value: 1, received: true }, metadata: {} },
        FENCE_ALT_MAX: { id: "FENCE_ALT_MAX", live: { value: 100, received: true }, metadata: {} },
        FENCE_ALT_MIN: { id: "FENCE_ALT_MIN", live: { value: -10, received: true }, metadata: {} },
        FENCE_RADIUS: { id: "FENCE_RADIUS", live: { value: 150, received: true }, metadata: {} },
        FENCE_MARGIN: { id: "FENCE_MARGIN", live: { value: 2, received: true }, metadata: {} },
        FENCE_TOTAL: { id: "FENCE_TOTAL", live: { value: 0, received: true }, metadata: {} },
        FENCE_AUTOENABLE: { id: "FENCE_AUTOENABLE", live: { value: 0, received: true }, metadata: {} },
        FENCE_MARGIN_XY: { id: "FENCE_MARGIN_XY", live: { value: 0, received: true }, metadata: {} },
        FENCE_OPTIONS: { id: "FENCE_OPTIONS", live: { value: 0, received: true }, metadata: {} },
      },
      staged: {},
      stagedCount: 0,
      stageValue: vi.fn(),
      revert: vi.fn(),
      writePhase: "idle",
      executeWrite: vi.fn(),
      resetWrite: vi.fn(),
      sync: { active: false, complete: true, receivedCount: 100, expectedCount: 100 },
    }),
  };
});

function renderWithProviders(ui: React.ReactNode) {
  return render(<ParameterProvider>{ui}</ParameterProvider>);
}

describe("GeoFence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the screen with header", () => {
    renderWithProviders(<GeoFence />);
    expect(screen.getByTestId("gf-screen")).toBeTruthy();
    expect(screen.getByText("GeoFence", { selector: ".gf-header span" })).toBeTruthy();
  });

  it("shows enabled state", () => {
    renderWithProviders(<GeoFence />);
    expect(screen.getByTestId("gf-enable-toggle").textContent).toBe("Enabled");
  });

  it("renders fence type checkboxes", () => {
    renderWithProviders(<GeoFence />);
    expect(screen.getByTestId("gf-type-checkboxes")).toBeTruthy();
    expect(screen.getByTestId("gf-type-alt_max")).toBeTruthy();
    expect(screen.getByTestId("gf-type-circle")).toBeTruthy();
    expect(screen.getByTestId("gf-type-polygon")).toBeTruthy();
    expect(screen.getByTestId("gf-type-alt_min")).toBeTruthy();
  });

  it("displays correct parameter values", () => {
    renderWithProviders(<GeoFence />);
    expect((screen.getByTestId("gf-alt-max-input") as HTMLInputElement).value).toBe("100");
    expect((screen.getByTestId("gf-alt-min-input") as HTMLInputElement).value).toBe("-10");
    expect((screen.getByTestId("gf-radius-input") as HTMLInputElement).value).toBe("150");
    expect((screen.getByTestId("gf-margin-input") as HTMLInputElement).value).toBe("2");
  });

  it("shows breach action dropdown", () => {
    renderWithProviders(<GeoFence />);
    expect(screen.getByTestId("gf-action-select")).toBeTruthy();
    expect((screen.getByTestId("gf-action-select") as HTMLSelectElement).value).toBe("1");
  });

  it("shows polygon points as read-only", () => {
    renderWithProviders(<GeoFence />);
    expect(screen.getByTestId("gf-total")).toBeTruthy();
  });

  it("shows save button", () => {
    renderWithProviders(<GeoFence />);
    expect(screen.getByTestId("gf-save-btn")).toBeTruthy();
  });

  it("decodes FENCE_TYPE bitmask correctly", () => {
    // 7 = ALT_MAX + CIRCLE + POLYGON
    const flags = decodeFenceType(7);
    expect(flags.ALT_MAX).toBe(true);
    expect(flags.CIRCLE).toBe(true);
    expect(flags.POLYGON).toBe(true);
    expect(flags.ALT_MIN).toBe(false);
  });

  it("encodes FENCE_TYPE bitmask correctly", () => {
    const value = encodeFenceType({
      ALT_MAX: true,
      CIRCLE: false,
      POLYGON: true,
      ALT_MIN: false,
    });
    expect(value).toBe(FENCE_TYPE_BITS.ALT_MAX | FENCE_TYPE_BITS.POLYGON); // 5
  });

  it("roundtrips encode/decode", () => {
    const original = { ALT_MAX: true, CIRCLE: true, POLYGON: false, ALT_MIN: true };
    const encoded = encodeFenceType(original);
    const decoded = decodeFenceType(encoded);
    expect(decoded).toEqual(original);
  });
});
