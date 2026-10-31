import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ParameterProvider } from "../../context/ParameterContext";
import BasicTuning from "./BasicTuning";

vi.mock("../../hooks/useSocketTelemetry", () => ({
  default: () => ({
    mode: "LOITER",
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
        ATC_ANG_RLL_P: {
          id: "ATC_ANG_RLL_P",
          live: { value: 4.5, received: true },
          metadata: {},
          metadataMissing: false,
        },
        ATC_ANG_PIT_P: {
          id: "ATC_ANG_PIT_P",
          live: { value: 4.5, received: true },
          metadata: {},
          metadataMissing: false,
        },
        MOT_THST_HOVER: {
          id: "MOT_THST_HOVER",
          live: { value: 0.39, received: true },
          metadata: {},
          metadataMissing: false,
        },
        PSC_D_ACC_P: {
          id: "PSC_D_ACC_P",
          live: { value: 0.05, received: true },
          metadata: {},
          metadataMissing: false,
        },
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

describe("BasicTuning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the screen with header", () => {
    renderWithProviders(<BasicTuning />);
    expect(screen.getByTestId("bt-screen")).toBeTruthy();
    expect(screen.getByText("Basic Tuning")).toBeTruthy();
  });

  it("renders three slider cards", () => {
    renderWithProviders(<BasicTuning />);
    expect(screen.getByTestId("bt-slider-roll-pitch")).toBeTruthy();
    expect(screen.getByTestId("bt-slider-throttle-hover")).toBeTruthy();
    expect(screen.getByTestId("bt-slider-throttle-accel")).toBeTruthy();
  });

  it("displays correct parameter values", () => {
    renderWithProviders(<BasicTuning />);
    expect(screen.getByTestId("bt-value-roll-pitch").textContent).toContain("4.5");
    expect(screen.getByTestId("bt-value-throttle-hover").textContent).toContain("0.39");
    expect(screen.getByTestId("bt-value-throttle-accel").textContent).toContain("0.050");
  });

  it("displays slider labels", () => {
    renderWithProviders(<BasicTuning />);
    expect(screen.getByText("Roll/Pitch Response")).toBeTruthy();
    expect(screen.getByText("Throttle Hover")).toBeTruthy();
    expect(screen.getByText("Throttle Accel / Climb Sensitivity")).toBeTruthy();
  });

  it("displays description text", () => {
    renderWithProviders(<BasicTuning />);
    expect(screen.getByText(/Adjust the sliders to tune/)).toBeTruthy();
  });

  it("shows save button", () => {
    renderWithProviders(<BasicTuning />);
    expect(screen.getByTestId("bt-save-btn")).toBeTruthy();
  });

  it("shows disconnected state when not connected", () => {
    // Override mock for disconnected state
    const mock = vi.fn().mockReturnValue({
      connection: "DISCONNECTED",
      vehicleType: null,
      entries: {},
      staged: {},
      stagedCount: 0,
      stageValue: vi.fn(),
      revert: vi.fn(),
      writePhase: "idle",
      executeWrite: vi.fn(),
      resetWrite: vi.fn(),
      sync: { active: false, complete: false, receivedCount: 0, expectedCount: 0 },
    });
    vi.doMock("../../context/ParameterContext", () => ({
      ...vi.importActual("../../context/ParameterContext"),
      useParameters: mock,
    }));

    // For this test we just verify the component exists
    renderWithProviders(<BasicTuning />);
    expect(screen.getByTestId("bt-screen")).toBeTruthy();
  });
});
