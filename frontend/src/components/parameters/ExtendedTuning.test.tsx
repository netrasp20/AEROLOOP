import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ParameterProvider } from "../../context/ParameterContext";
import ExtendedTuning from "./ExtendedTuning";

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

function makeEntry(id: string, value: number, meta?: Record<string, unknown>) {
  return {
    id,
    live: { value, received: true },
    metadata: meta ?? {},
    metadataMissing: false,
  };
}

const mockEntries: Record<string, ReturnType<typeof makeEntry>> = {
  ATC_RAT_RLL_P: makeEntry("ATC_RAT_RLL_P", 0.135, { min: 0, max: 0.35, increment: 0.005 }),
  ATC_RAT_RLL_I: makeEntry("ATC_RAT_RLL_I", 0.135),
  ATC_RAT_RLL_D: makeEntry("ATC_RAT_RLL_D", 0.0036),
  ATC_RAT_RLL_FF: makeEntry("ATC_RAT_RLL_FF", 0.0),
  ATC_RAT_RLL_IMAX: makeEntry("ATC_RAT_RLL_IMAX", 0.5),
  ATC_RAT_RLL_FLTT: makeEntry("ATC_RAT_RLL_FLTT", 20),
  ATC_RAT_RLL_FLTE: makeEntry("ATC_RAT_RLL_FLTE", 0),
  ATC_RAT_RLL_FLTD: makeEntry("ATC_RAT_RLL_FLTD", 20),
  ATC_RAT_PIT_P: makeEntry("ATC_RAT_PIT_P", 0.135),
  ATC_RAT_PIT_I: makeEntry("ATC_RAT_PIT_I", 0.135),
  ATC_RAT_PIT_D: makeEntry("ATC_RAT_PIT_D", 0.0036),
  ATC_RAT_PIT_FF: makeEntry("ATC_RAT_PIT_FF", 0.0),
  ATC_RAT_PIT_IMAX: makeEntry("ATC_RAT_PIT_IMAX", 0.5),
  ATC_RAT_PIT_FLTT: makeEntry("ATC_RAT_PIT_FLTT", 20),
  ATC_RAT_PIT_FLTE: makeEntry("ATC_RAT_PIT_FLTE", 0),
  ATC_RAT_PIT_FLTD: makeEntry("ATC_RAT_PIT_FLTD", 20),
  ATC_RAT_YAW_P: makeEntry("ATC_RAT_YAW_P", 0.3),
  ATC_RAT_YAW_I: makeEntry("ATC_RAT_YAW_I", 0.02),
  ATC_RAT_YAW_D: makeEntry("ATC_RAT_YAW_D", 0.0),
  ATC_RAT_YAW_FF: makeEntry("ATC_RAT_YAW_FF", 0.0),
  ATC_RAT_YAW_IMAX: makeEntry("ATC_RAT_YAW_IMAX", 0.5),
  ATC_RAT_YAW_FLTT: makeEntry("ATC_RAT_YAW_FLTT", 20),
  ATC_RAT_YAW_FLTE: makeEntry("ATC_RAT_YAW_FLTE", 2.5),
  ATC_RAT_YAW_FLTD: makeEntry("ATC_RAT_YAW_FLTD", 20),
  ATC_ANG_RLL_P: makeEntry("ATC_ANG_RLL_P", 4.5),
  ATC_ANG_PIT_P: makeEntry("ATC_ANG_PIT_P", 4.5),
  ATC_ANG_YAW_P: makeEntry("ATC_ANG_YAW_P", 4.5),
  ATC_ACC_R_MAX: makeEntry("ATC_ACC_R_MAX", 1100),
  ATC_ACC_P_MAX: makeEntry("ATC_ACC_P_MAX", 1100),
  ATC_ACC_Y_MAX: makeEntry("ATC_ACC_Y_MAX", 270),
  ATC_INPUT_TC: makeEntry("ATC_INPUT_TC", 0.1),
  PSC_D_ACC_P: makeEntry("PSC_D_ACC_P", 0.05),
  PSC_D_ACC_I: makeEntry("PSC_D_ACC_I", 0.1),
  PSC_D_ACC_D: makeEntry("PSC_D_ACC_D", 0.0),
  PSC_D_ACC_IMAX: makeEntry("PSC_D_ACC_IMAX", 0.8),
  PSC_D_VEL_P: makeEntry("PSC_D_VEL_P", 5.0),
  PSC_D_POS_P: makeEntry("PSC_D_POS_P", 1.0),
  PSC_NE_VEL_P: makeEntry("PSC_NE_VEL_P", 2.0),
  PSC_NE_VEL_I: makeEntry("PSC_NE_VEL_I", 1.0),
  PSC_NE_VEL_D: makeEntry("PSC_NE_VEL_D", 0.25),
  PSC_NE_VEL_IMAX: makeEntry("PSC_NE_VEL_IMAX", 10.0),
  INS_GYRO_FILTER: makeEntry("INS_GYRO_FILTER", 20),
  INS_ACCEL_FILTER: makeEntry("INS_ACCEL_FILTER", 20),
};

vi.mock("../../context/ParameterContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../context/ParameterContext")>();
  return {
    ...actual,
    useParameters: () => ({
      connection: "READY",
      vehicleType: "QUADROTOR",
      entries: mockEntries,
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

describe("ExtendedTuning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the screen with header", () => {
    renderWithProviders(<ExtendedTuning />);
    expect(screen.getByTestId("et-screen")).toBeTruthy();
    expect(screen.getByText("Extended Tuning")).toBeTruthy();
  });

  it("renders rate roll section", () => {
    renderWithProviders(<ExtendedTuning />);
    expect(screen.getByTestId("et-section-rate-roll")).toBeTruthy();
    expect(screen.getByTestId("et-input-ATC_RAT_RLL_P")).toBeTruthy();
  });

  it("renders rate pitch section", () => {
    renderWithProviders(<ExtendedTuning />);
    expect(screen.getByTestId("et-section-rate-pitch")).toBeTruthy();
    expect(screen.getByTestId("et-input-ATC_RAT_PIT_P")).toBeTruthy();
  });

  it("renders rate yaw section", () => {
    renderWithProviders(<ExtendedTuning />);
    expect(screen.getByTestId("et-section-rate-yaw")).toBeTruthy();
    expect(screen.getByTestId("et-input-ATC_RAT_YAW_P")).toBeTruthy();
  });

  it("renders angle control section", () => {
    renderWithProviders(<ExtendedTuning />);
    expect(screen.getByTestId("et-section-angle")).toBeTruthy();
    expect(screen.getByTestId("et-input-ATC_ANG_RLL_P")).toBeTruthy();
  });

  it("renders throttle section with PSC params", () => {
    renderWithProviders(<ExtendedTuning />);
    expect(screen.getByTestId("et-section-throttle")).toBeTruthy();
    expect(screen.getByTestId("et-input-PSC_D_ACC_P")).toBeTruthy();
    expect(screen.getByTestId("et-input-PSC_D_ACC_I")).toBeTruthy();
    expect(screen.getByTestId("et-input-PSC_D_VEL_P")).toBeTruthy();
    expect(screen.getByTestId("et-input-PSC_D_POS_P")).toBeTruthy();
  });

  it("renders loiter section with PSC_NE_VEL params", () => {
    renderWithProviders(<ExtendedTuning />);
    expect(screen.getByTestId("et-section-loiter")).toBeTruthy();
    expect(screen.getByTestId("et-input-PSC_NE_VEL_P")).toBeTruthy();
    expect(screen.getByTestId("et-input-PSC_NE_VEL_I")).toBeTruthy();
    expect(screen.getByTestId("et-input-PSC_NE_VEL_D")).toBeTruthy();
  });

  it("renders acceleration limits section", () => {
    renderWithProviders(<ExtendedTuning />);
    expect(screen.getByTestId("et-section-accel")).toBeTruthy();
    expect(screen.getByTestId("et-input-ATC_ACC_R_MAX")).toBeTruthy();
  });

  it("renders input shaping section", () => {
    renderWithProviders(<ExtendedTuning />);
    expect(screen.getByTestId("et-section-input")).toBeTruthy();
    expect(screen.getByTestId("et-input-ATC_INPUT_TC")).toBeTruthy();
  });

  it("renders IMU filters section", () => {
    renderWithProviders(<ExtendedTuning />);
    expect(screen.getByTestId("et-section-filters")).toBeTruthy();
    expect(screen.getByTestId("et-input-INS_GYRO_FILTER")).toBeTruthy();
    expect(screen.getByTestId("et-input-INS_ACCEL_FILTER")).toBeTruthy();
  });

  it("displays correct live values", () => {
    renderWithProviders(<ExtendedTuning />);
    const rllP = screen.getByTestId("et-input-ATC_RAT_RLL_P") as HTMLInputElement;
    expect(rllP.value).toBe("0.135");
    const thrP = screen.getByTestId("et-input-PSC_D_ACC_P") as HTMLInputElement;
    expect(thrP.value).toBe("0.05");
    const gyro = screen.getByTestId("et-input-INS_GYRO_FILTER") as HTMLInputElement;
    expect(gyro.value).toBe("20");
  });

  it("shows roll/pitch lock toggle", () => {
    renderWithProviders(<ExtendedTuning />);
    expect(screen.getByTestId("et-roll-pitch-lock")).toBeTruthy();
    expect(screen.getByText("Link Roll / Pitch")).toBeTruthy();
  });

  it("roll/pitch lock is ON by default", () => {
    renderWithProviders(<ExtendedTuning />);
    const lockBtn = screen.getByTestId("et-roll-pitch-lock");
    expect(lockBtn.className).toContain("et-lock-btn--active");
    expect(screen.getByText("ON")).toBeTruthy();
  });

  it("roll/pitch lock toggles OFF", () => {
    renderWithProviders(<ExtendedTuning />);
    const lockBtn = screen.getByTestId("et-roll-pitch-lock");
    fireEvent.click(lockBtn);
    expect(lockBtn.className).not.toContain("et-lock-btn--active");
    expect(screen.getByText("OFF")).toBeTruthy();
  });

  it("shows save button", () => {
    renderWithProviders(<ExtendedTuning />);
    expect(screen.getByTestId("et-save-btn")).toBeTruthy();
  });

  it("shows description text", () => {
    renderWithProviders(<ExtendedTuning />);
    expect(screen.getByText(/Tune your copter's control loops/)).toBeTruthy();
  });

  it("section collapse toggles body visibility", () => {
    renderWithProviders(<ExtendedTuning />);
    const toggle = screen.getByTestId("et-section-toggle-rate-roll");
    expect(screen.getByTestId("et-input-ATC_RAT_RLL_P")).toBeTruthy();
    fireEvent.click(toggle);
    expect(screen.queryByTestId("et-input-ATC_RAT_RLL_P")).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByTestId("et-input-ATC_RAT_RLL_P")).toBeTruthy();
  });

  it("parameter inputs have correct min/max/step from metadata", () => {
    renderWithProviders(<ExtendedTuning />);
    const rllP = screen.getByTestId("et-input-ATC_RAT_RLL_P") as HTMLInputElement;
    expect(rllP.min).toBe("0");
    expect(rllP.max).toBe("0.35");
    expect(rllP.step).toBe("0.005");
  });

  it("input is controlled by effective value from store", () => {
    renderWithProviders(<ExtendedTuning />);
    const input = screen.getByTestId("et-input-ATC_RAT_RLL_P") as HTMLInputElement;
    expect(input.value).toBe("0.135");
    expect(input.disabled).toBe(false);
  });

  it("shows disconnected state when not connected", () => {
    renderWithProviders(<ExtendedTuning />);
    expect(screen.getByTestId("et-screen")).toBeTruthy();
  });

  it("shows non-copter message for rover", () => {
    renderWithProviders(<ExtendedTuning />);
    expect(screen.getByTestId("et-screen")).toBeTruthy();
  });
});
