import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ParameterProvider } from "../../context/ParameterContext";
import SetupSensors from "./SetupSensors";

import { entry, makeMetadata, metadataAvailable, statusView } from "../../test/fixtures";

const { emitter, setupMocks, apiMocks, telemetry } = vi.hoisted(() => {
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
    setupMocks: {
      getAccelCalStatus: vi.fn(),
      startAccelCalibration: vi.fn(),
      confirmAccelPosition: vi.fn(),
      cancelAccelCalibration: vi.fn(),
      getSensorStatus: vi.fn(),
      getCompassCalStatus: vi.fn(),
      getCompassConfiguration: vi.fn(),
      getCompassMotCapability: vi.fn(),
      startCompassMot: vi.fn(),
      cancelCompassMot: vi.fn(),
      runGyroCalibration: vi.fn(),
      runBaroCalibration: vi.fn(),
      runLevelCalibration: vi.fn(),
      startCompassCalibration: vi.fn(),
      acceptCompassCalibration: vi.fn(),
      cancelCompassCalibration: vi.fn(),
    },
    apiMocks: {
      getParameterStatus: vi.fn(),
      getAllParameters: vi.fn(),
      getMetadataOverview: vi.fn(),
      refreshParameters: vi.fn(),
      writeBatch: vi.fn(),
    },
    telemetry: {
      connected: true,
      armed: false,
    },
  };
});

vi.mock("../../api/setup", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getAccelCalStatus: setupMocks.getAccelCalStatus,
    startAccelCalibration: setupMocks.startAccelCalibration,
    confirmAccelPosition: setupMocks.confirmAccelPosition,
    cancelAccelCalibration: setupMocks.cancelAccelCalibration,
    getSensorStatus: setupMocks.getSensorStatus,
    getCompassCalStatus: setupMocks.getCompassCalStatus,
    getCompassConfiguration: setupMocks.getCompassConfiguration,
    getCompassMotCapability: setupMocks.getCompassMotCapability,
    startCompassMot: setupMocks.startCompassMot,
    cancelCompassMot: setupMocks.cancelCompassMot,
    runGyroCalibration: setupMocks.runGyroCalibration,
    runBaroCalibration: setupMocks.runBaroCalibration,
    runLevelCalibration: setupMocks.runLevelCalibration,
    startCompassCalibration: setupMocks.startCompassCalibration,
    acceptCompassCalibration: setupMocks.acceptCompassCalibration,
    cancelCompassCalibration: setupMocks.cancelCompassCalibration,
  };
});

vi.mock("../../api/parameters", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, ...apiMocks };
});

vi.mock("../../socket/socket", () => ({ default: emitter }));

vi.mock("../../hooks/useTelemetry", () => ({
  useTelemetry: () => ({
    connected: telemetry.connected,
    armed: telemetry.armed,
  }),
}));

const SENSOR_ORIENT_VALUES: Record<string, string> = {
  "0": "None",
  "1": "Yaw45",
  "2": "Yaw90",
  "24": "Pitch90",
};

const AHRS_VALUES: Record<string, string> = {
  "0": "None",
  "1": "Yaw45",
  "2": "Yaw90",
  "38": "Pitch270Yaw135",
};

const sensorParams = [
  entry({
    id: "AHRS_ORIENTATION",
    live: { value: 0, type: "UINT8", index: 1, count: 1379, received: true },
    metadata: makeMetadata({
      id: "AHRS_ORIENTATION",
      name: "Orientation",
      values: AHRS_VALUES,
      rebootRequired: false,
      group: "AHRS",
      source: "copter.xml",
    }),
  }),
  entry({
    id: "COMPASS_ENABLE",
    live: { value: 1, type: "UINT8", index: 2, count: 1379, received: true },
    metadata: makeMetadata({
      id: "COMPASS_ENABLE",
      name: "Enable Compass",
      values: { "0": "Disabled", "1": "Enabled" },
      rebootRequired: true,
      group: "Compass",
      source: "copter.xml",
    }),
  }),
  entry({
    id: "COMPASS_USE",
    live: { value: 1, type: "UINT8", index: 3, count: 1379, received: true },
    metadata: makeMetadata({
      id: "COMPASS_USE",
      name: "Use Compass 1",
      values: { "0": "Disabled", "1": "Enabled" },
      rebootRequired: false,
      group: "Compass",
      source: "copter.xml",
    }),
  }),
  entry({
    id: "COMPASS_USE2",
    live: { value: 1, type: "UINT8", index: 4, count: 1379, received: true },
    metadata: makeMetadata({
      id: "COMPASS_USE2",
      name: "Use Compass 2",
      values: { "0": "Disabled", "1": "Enabled" },
      rebootRequired: false,
      group: "Compass",
      source: "copter.xml",
    }),
  }),
  entry({
    id: "COMPASS_ORIENT",
    live: { value: 0, type: "UINT8", index: 5, count: 1379, received: true },
    metadata: makeMetadata({
      id: "COMPASS_ORIENT",
      name: "Compass 1 Orientation",
      values: SENSOR_ORIENT_VALUES,
      rebootRequired: false,
      group: "Compass",
      source: "copter.xml",
    }),
  }),
  entry({
    id: "COMPASS_ORIENT2",
    live: { value: 2, type: "UINT8", index: 6, count: 1379, received: true },
    metadata: makeMetadata({
      id: "COMPASS_ORIENT2",
      name: "Compass 2 Orientation",
      values: SENSOR_ORIENT_VALUES,
      rebootRequired: false,
      group: "Compass",
      source: "copter.xml",
    }),
  }),
  entry({
    id: "COMPASS_DEV_ID",
    live: { value: 97539, type: "INT32", index: 7, count: 1379, received: true },
    metadata: makeMetadata({ id: "COMPASS_DEV_ID", group: "Compass", source: "copter.xml" }),
  }),
];

function readyDefaults() {
  apiMocks.getParameterStatus.mockResolvedValue(statusView());
  apiMocks.getAllParameters.mockResolvedValue({
    success: true,
    connection: "READY",
    sync: statusView().sync,
    metadata: metadataAvailable,
    vehicle: { vehicleType: "QUADROTOR" },
    count: sensorParams.length,
    parameters: sensorParams,
  });
  apiMocks.getMetadataOverview.mockResolvedValue({
    success: true,
    vehicle: "copter",
    metadataStatus: metadataAvailable,
    groups: ["Compass", "AHRS"],
  });
  apiMocks.refreshParameters.mockResolvedValue({ success: true, sync: statusView().sync });
  apiMocks.writeBatch.mockResolvedValue({
    success: true,
    transaction: {
      transactionId: "txn1",
      sessionId: "abc123",
      status: "success",
      total: 1,
      succeeded: 1,
      failed: 0,
      notAttempted: 0,
      results: [
        { paramId: "AHRS_ORIENTATION", requestedValue: 1, originalValue: 0, status: "success", verifiedValue: 1, code: null, message: null },
      ],
    },
  });
}

function renderSensors() {
  return render(
    <ParameterProvider>
      <SetupSensors />
    </ParameterProvider>
  );
}

function idleStatus() {
  return { active: false, step: null, label: "", order: 0, total: 6, result: null };
}

function idleCompass() {
  return { active: false, mask: 0, status: "idle", completionPct: 0, result: null };
}

function idleSensors() {
  return {
    connected: true,
    armed: false,
    systemId: 1,
    componentId: 1,
    vehicleType: "QUADROTOR",
    autopilot: "ARDUPILOTMEGA",
    connectionType: "SERIAL",
    sensors: {
      accel: {
        status: "calibrated",
        ids: { INS_ACC_ID: { supported: true, value: 11 } },
        offsets: {},
      },
      gyro: {
        status: "calibrated",
        ids: { INS_GYR_ID: { supported: true, value: 12 } },
        offsets: {},
      },
      baro: {
        status: "calibrated",
        ids: { BARO_PRIMARY: { supported: true, value: 0 } },
        offsets: {},
      },
      compass: {
        status: "calibrated",
        ids: { COMPASS_DEV_ID: { supported: true, value: 1448800 } },
        offsets: {
          COMPASS_OFS_X: { supported: true, value: -18 },
          COMPASS_OFS_Y: { supported: true, value: 11 },
          COMPASS_OFS_Z: { supported: true, value: 14 },
        },
        detected: 1,
        calFit: 72,
        devices: [
          {
            index: 1,
            paramId: "COMPASS_DEV_ID",
            devid: 1448800,
            name: "Internal Compass 1",
            use: 1,
            useParam: "COMPASS_USE",
            orient: 0,
            orientParam: "COMPASS_ORIENT",
            orientName: "None",
            external: 0,
            priority: 1448800,
          },
        ],
      },
      level: {
        status: "calibrated",
        ids: { AHRS_TRIM_X: { supported: true, value: 0 }, AHRS_TRIM_Y: { supported: true, value: 0 } },
        offsets: {},
        trim: { x: 0, y: 0 },
      },
      compassMot: { supported: true, enabled: 0, active: false },
    },
  };
}

beforeEach(() => {
  window.localStorage.clear();
  readyDefaults();
  setupMocks.getAccelCalStatus.mockResolvedValue(idleStatus());
  setupMocks.getCompassCalStatus.mockResolvedValue(idleCompass());
  setupMocks.getSensorStatus.mockResolvedValue(idleSensors());
  setupMocks.getCompassConfiguration.mockResolvedValue({
    connected: true,
    enabled: 1,
    detected: 1,
    primaryFit: 72,
    orientations: {},
    orientation: { supported: true, value: 0 },
    devices: idleSensors().sensors.compass.devices,
  });
  setupMocks.getCompassMotCapability.mockResolvedValue({ supported: true, enabled: 0, active: false });
  setupMocks.startCompassMot.mockResolvedValue({ success: true, message: "Compass motor test started.", active: true });
  setupMocks.cancelCompassMot.mockResolvedValue({ success: true, message: "Compass motor test cancelled." });
  setupMocks.startAccelCalibration.mockResolvedValue({
    success: true,
    active: true,
    step: 1,
    label: "Place the vehicle LEVEL",
    order: 1,
    total: 6,
    result: null,
    message: "Accelerometer calibration started.",
  });
  setupMocks.confirmAccelPosition.mockResolvedValue({
    success: true,
    message: "Position 1 sampled.",
  });
  setupMocks.cancelAccelCalibration.mockResolvedValue({
    success: true,
    message: "Accelerometer calibration cancelled.",
  });
  setupMocks.runGyroCalibration.mockResolvedValue({ success: true, message: "Gyro calibration completed." });
  setupMocks.runBaroCalibration.mockResolvedValue({ success: true, message: "Barometer calibration completed." });
  setupMocks.runLevelCalibration.mockResolvedValue({ success: true, message: "Level horizon calibration completed." });
  setupMocks.startCompassCalibration.mockResolvedValue({ success: true, message: "Compass calibration started." });
  setupMocks.acceptCompassCalibration.mockResolvedValue({ success: true, message: "Compass calibration accepted." });
  setupMocks.cancelCompassCalibration.mockResolvedValue({ success: true, message: "Compass calibration cancelled." });
});

describe("SetupSensors — connection and identity", () => {
  it("prompts to connect when the vehicle is unavailable", async () => {
    telemetry.connected = false;
    renderSensors();
    expect(await screen.findByTestId("setup-sensors-disconnected")).toBeInTheDocument();
    expect(screen.queryByTestId("setup-accel-start")).not.toBeInTheDocument();
    telemetry.connected = true;
  });

  it("blocks calibration while armed", async () => {
    telemetry.armed = true;
    renderSensors();
    expect(await screen.findByTestId("setup-sensors-armed")).toBeInTheDocument();
    telemetry.armed = false;
  });

  it("shows the vehicle identity card with param readback", async () => {
    renderSensors();
    expect(await screen.findByTestId("setup-sensors-identity")).toBeInTheDocument();
    expect(screen.getByText("CONNECTED")).toBeInTheDocument();
    expect(screen.getByText("QUADROTOR")).toBeInTheDocument();
    expect(screen.getAllByText("1 / 1").length).toBeGreaterThanOrEqual(1);
  });
});

describe("SetupSensors — accelerometer calibration", () => {
  it("shows idle accelerometer card with a start button", async () => {
    renderSensors();
    expect(await screen.findByTestId("setup-accel-card")).toBeInTheDocument();
    expect(screen.getByTestId("setup-accel-start")).toBeInTheDocument();
  });

  it("starts the calibration wizard and shows the first orientation", async () => {
    const user = userEvent.setup();
    renderSensors();
    await user.click(await screen.findByTestId("setup-accel-start"));
    expect(setupMocks.startAccelCalibration).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId("setup-accel-prompt")).toBeInTheDocument();
    expect(screen.getByText("Place the vehicle LEVEL")).toBeInTheDocument();
  });

  it("advances through a position-driven socket event", async () => {
    const user = userEvent.setup();
    renderSensors();
    await user.click(await screen.findByTestId("setup-accel-start"));
    expect(await screen.findByText("Place the vehicle LEVEL")).toBeInTheDocument();

    emitter.emit("accel_cal:position", {
      position: 2,
      label: "Place the vehicle on its LEFT side",
      order: 2,
      total: 6,
    });
    expect(await screen.findByText("Place the vehicle on its LEFT side")).toBeInTheDocument();
    expect(screen.getByTestId("setup-accel-confirm")).toBeInTheDocument();
  });

  it("confirms the requested orientation", async () => {
    const user = userEvent.setup();
    renderSensors();
    await user.click(await screen.findByTestId("setup-accel-start"));
    const confirm = await screen.findByTestId("setup-accel-confirm");
    await waitFor(() => expect(confirm).toBeEnabled());
    await user.click(confirm);
    expect(setupMocks.confirmAccelPosition).toHaveBeenCalledWith(1);
  });

  it("cancels an active wizard", async () => {
    const user = userEvent.setup();
    renderSensors();
    await user.click(await screen.findByTestId("setup-accel-start"));
    await user.click(await screen.findByTestId("setup-accel-cancel"));
    expect(setupMocks.cancelAccelCalibration).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId("setup-accel-card")).toBeInTheDocument();
  });

  it("shows a success result banner when the vehicle finishes", async () => {
    const user = userEvent.setup();
    renderSensors();
    await user.click(await screen.findByTestId("setup-accel-start"));
    await screen.findByTestId("setup-accel-confirm");
    emitter.emit("accel_cal:result", { result: "success" });
    expect(await screen.findByTestId("setup-sensor-result-success")).toBeInTheDocument();
  });

  it("shows a failure result banner when the vehicle reports failure", async () => {
    const user = userEvent.setup();
    renderSensors();
    await user.click(await screen.findByTestId("setup-accel-start"));
    await screen.findByTestId("setup-accel-confirm");
    emitter.emit("accel_cal:result", { result: "failed" });
    expect(await screen.findByTestId("setup-sensor-result-failed")).toBeInTheDocument();
  });

  it("surfaces a start rejection message", async () => {
    setupMocks.startAccelCalibration.mockResolvedValue({
      success: false,
      active: false,
      step: null,
      label: "",
      order: 0,
      total: 6,
      result: null,
      message: "Disarm the vehicle first.",
    });
    const user = userEvent.setup();
    renderSensors();
    await user.click(await screen.findByTestId("setup-accel-start"));
    expect(await screen.findByTestId("setup-accel-message")).toBeInTheDocument();
    expect(screen.getByText("Disarm the vehicle first.")).toBeInTheDocument();
  });
});

describe("SetupSensors — gyro / baro / level", () => {
  it("runs gyro calibration and reports success", async () => {
    const user = userEvent.setup();
    renderSensors();
    await user.click(await screen.findByTestId("setup-gyro-start"));
    expect(setupMocks.runGyroCalibration).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId("setup-sensor-result-success")).toBeInTheDocument();
  });

  it("surfaces a gyro failure message", async () => {
    setupMocks.runGyroCalibration.mockResolvedValue({
      success: false,
      message: "Gyro calibration failed: FAILED.",
    });
    const user = userEvent.setup();
    renderSensors();
    await user.click(await screen.findByTestId("setup-gyro-start"));
    expect(await screen.findByTestId("setup-gyro-message")).toBeInTheDocument();
    expect(screen.getByText("Gyro calibration failed: FAILED.")).toBeInTheDocument();
  });

  it("runs barometer calibration", async () => {
    const user = userEvent.setup();
    renderSensors();
    await user.click(await screen.findByTestId("setup-baro-start"));
    expect(setupMocks.runBaroCalibration).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId("setup-sensor-result-success")).toBeInTheDocument();
  });

  it("runs level horizon calibration", async () => {
    const user = userEvent.setup();
    renderSensors();
    await user.click(await screen.findByTestId("setup-level-start"));
    expect(setupMocks.runLevelCalibration).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId("setup-sensor-result-success")).toBeInTheDocument();
  });
});

describe("SetupSensors — compass calibration", () => {
  it("shows an idle compass card with a start button", async () => {
    renderSensors();
    expect(await screen.findByTestId("setup-compass-card")).toBeInTheDocument();
    expect(screen.getByTestId("setup-compass-start")).toBeInTheDocument();
  });

  it("starts compass calibration and shows progress", async () => {
    const user = userEvent.setup();
    renderSensors();
    await user.click(await screen.findByTestId("setup-compass-start"));
    expect(setupMocks.startCompassCalibration).toHaveBeenCalledTimes(1);

    emitter.emit("compass_cal:progress", {
      compassId: 0,
      calMask: 255,
      status: "running-step-one",
      completionPct: 60,
      attempt: 1,
      direction: { x: 0.1, y: 0.2, z: 0.3 },
    });
    expect(await screen.findByTestId("setup-compass-progress")).toBeInTheDocument();
  });

  it("shows ready-to-accept state then accepts", async () => {
    const user = userEvent.setup();
    renderSensors();
    await user.click(await screen.findByTestId("setup-compass-start"));
    emitter.emit("compass_cal:result", { result: "ready-to-accept" });
    const accept = await screen.findByTestId("setup-compass-accept");
    await waitFor(() => expect(accept).toBeEnabled());
    await user.click(accept);
    expect(setupMocks.acceptCompassCalibration).toHaveBeenCalledTimes(1);
  });

  it("shows a success result when the vehicle reports it", async () => {
    const user = userEvent.setup();
    renderSensors();
    await user.click(await screen.findByTestId("setup-compass-start"));
    emitter.emit("compass_cal:result", { result: "success" });
    expect(await screen.findByTestId("setup-sensor-result-success")).toBeInTheDocument();
  });

  it("cancels a running calibration", async () => {
    const user = userEvent.setup();
    renderSensors();
    await user.click(await screen.findByTestId("setup-compass-start"));
    const cancel = await screen.findByTestId("setup-compass-cancel");
    await waitFor(() => expect(cancel).toBeEnabled());
    await user.click(cancel);
    expect(setupMocks.cancelCompassCalibration).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("setup-compass-start")).toBeInTheDocument();
  });
});

describe("SetupSensors — derived status chips", () => {
  it("shows CALIBRATED chips from real backend state", async () => {
    renderSensors();
    expect(await screen.findByTestId("setup-accel-card")).toBeInTheDocument();
    expect(screen.getByTestId("setup-accel-chip")).toHaveTextContent("CALIBRATED");
    expect(screen.getByTestId("setup-gyro-chip")).toHaveTextContent("CALIBRATED");
    expect(screen.getByTestId("setup-baro-chip")).toHaveTextContent("CALIBRATED");
    expect(screen.getByTestId("setup-level-chip")).toHaveTextContent("CALIBRATED");
    expect(screen.getByTestId("setup-compass-chip")).toHaveTextContent("CALIBRATED");
  });

  it("shows NOT SUPPORTED when the firmware lacks the capability", async () => {
    setupMocks.getCompassMotCapability.mockResolvedValue({ supported: false, enabled: null, active: false });
    setupMocks.getSensorStatus.mockResolvedValue({
      ...idleSensors(),
      sensors: {
        ...idleSensors().sensors,
        compassMot: { supported: false, enabled: null, active: false },
      },
    });
    renderSensors();
    expect(await screen.findByTestId("setup-compassmot-chip")).toHaveTextContent("NOT SUPPORTED");
    expect(await screen.findByTestId("setup-compassmot-unsupported")).toBeInTheDocument();
  });
});

describe("SetupSensors — compass fitness display", () => {
  it("renders the fit from the live report when calibrating", async () => {
    renderSensors();
    await screen.findByTestId("setup-compass-card");

    emitter.emit("compass_cal:report", {
      compassId: 0,
      calMask: 255,
      status: "success",
      autosaved: true,
      fitness: 0.71,
      ofsX: 5,
      ofsY: 13,
      ofsZ: -18,
      scaleFactor: 1,
    });

    await waitFor(() => {
      expect(screen.getByTestId("setup-compass-fit")).toHaveTextContent("Fitness: 71%");
    });
    const fit = screen.getByTestId("setup-compass-fit");
    expect(fit).toHaveTextContent(/Offsets: 5\.0 \/ 13\.0 \/ -18\.0/);
  });
});

describe("SetupSensors — compass settings and flight controller orientation", () => {
  it("shows detected compasses and stages + applies a settings change", async () => {
    const user = userEvent.setup();
    renderSensors();
    await screen.findByTestId("setup-compass-settings");

    expect(screen.getByTestId("setup-compass-device-1")).toBeInTheDocument();
    expect(screen.getByText("Internal Compass 1")).toBeInTheDocument();

    const orient = screen.getByTestId("setup-compass-orient-1");
    await user.selectOptions(orient, "2");
    await user.click(await screen.findByTestId("setup-compass-settings-apply"));

    await waitFor(() => expect(apiMocks.writeBatch).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId("setup-compass-settings-result-success")).toBeInTheDocument();
  });

  it("writes the flight controller orientation (AHRS_ORIENTATION) via the pipeline", async () => {
    const user = userEvent.setup();
    renderSensors();
    await screen.findByTestId("setup-orientation-card");

    const select = screen.getByTestId("setup-orientation-select");
    await user.selectOptions(select, "38");
    expect(await screen.findByTestId("setup-orientation-pending")).toHaveTextContent("Pitch270Yaw135");

    await user.click(await screen.findByTestId("setup-orientation-apply"));
    await waitFor(() => expect(apiMocks.writeBatch).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId("setup-orientation-result-success")).toBeInTheDocument();
  });

  it("shows the reboot-required note when a staged compass setting needs one", async () => {
    const user = userEvent.setup();
    renderSensors();
    await screen.findByTestId("setup-compass-settings");

    const toggle = screen.getByTestId("setup-compass-enable-toggle");
    await user.click(toggle);
    expect(await screen.findByTestId("setup-compass-settings-reboot")).toBeInTheDocument();
  });
});

describe("SetupSensors — compass motor test", () => {
  it("starts the motor test and reports hardware-required semantics", async () => {
    const user = userEvent.setup();
    renderSensors();
    await user.click(await screen.findByTestId("setup-compassmot-start"));
    expect(setupMocks.startCompassMot).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId("setup-compassmot-cancel")).toBeInTheDocument();
  });

  it("shows live throttle/interference from the stream while running", async () => {
    const user = userEvent.setup();
    renderSensors();
    await user.click(await screen.findByTestId("setup-compassmot-start"));

    emitter.emit("compassmot:status", { throttle: 40, interference: 120 });
    const readings = await screen.findByTestId("setup-compassmot-readings");
    expect(readings).toHaveTextContent("40%");
    expect(readings).toHaveTextContent("120");
  });

  it("stops the test", async () => {
    const user = userEvent.setup();
    renderSensors();
    await user.click(await screen.findByTestId("setup-compassmot-start"));
    expect(await screen.findByTestId("setup-compassmot-cancel")).toBeInTheDocument();
    await user.click(screen.getByTestId("setup-compassmot-cancel"));
    expect(setupMocks.cancelCompassMot).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId("setup-compassmot-start")).toBeInTheDocument();
  });
});