import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { act, render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import SetupFirmware from "./SetupFirmware";

const { setupMocks, telemetry } = vi.hoisted(() => ({
  setupMocks: {
    getFirmwareInfo: vi.fn(),
    getFirmwareCapability: vi.fn(),
    getFirmwareCatalog: vi.fn(),
    getFirmwareWorkflow: vi.fn(),
    getFirmwareInstallStatus: vi.fn(),
    postFirmwareConfirmation: vi.fn(),
    postFirmwareDownload: vi.fn(),
    postFirmwareInstall: vi.fn(),
    postFirmwareSimulation: vi.fn(),
    postFirmwareCancel: vi.fn(),
    getBootloaderValidationStatus: vi.fn(),
    prepareBootloaderIdentityValidation: vi.fn(),
  },
  telemetry: {
    connected: true,
    connectionState: "CONNECTED" as "CONNECTED" | "CONNECTING" | "DISCONNECTED",
    disconnectReason: null as string | null,
    systemId: 1,
    componentId: 1,
    vehicleType: "QUADROTOR",
    autopilot: "ARDUPILOTMEGA",
  },
}));

vi.mock("../../api/setup", async (importOriginal) => ({
  ...(await importOriginal()),
  getFirmwareInfo: setupMocks.getFirmwareInfo,
  getFirmwareCapability: setupMocks.getFirmwareCapability,
  getFirmwareCatalog: setupMocks.getFirmwareCatalog,
  getFirmwareWorkflow: setupMocks.getFirmwareWorkflow,
  getFirmwareInstallStatus: setupMocks.getFirmwareInstallStatus,
  postFirmwareConfirmation: setupMocks.postFirmwareConfirmation,
  postFirmwareDownload: setupMocks.postFirmwareDownload,
  postFirmwareInstall: setupMocks.postFirmwareInstall,
  postFirmwareSimulation: setupMocks.postFirmwareSimulation,
  postFirmwareCancel: setupMocks.postFirmwareCancel,
  getBootloaderValidationStatus: setupMocks.getBootloaderValidationStatus,
  prepareBootloaderIdentityValidation: setupMocks.prepareBootloaderIdentityValidation,
}));
vi.mock("../../hooks/useTelemetry", () => ({ useTelemetry: () => telemetry }));

const info = {
  success: true,
  connected: true,
  version: "4.7.0 (Official Release)",
  release: "Official Release",
  boardType: 0,
  boardRev: 9,
  vehicle: "ArduCopter",
  autopilot: "ARDUPILOTMEGA",
  autopilotLabel: "ArduPilot",
  connectionType: "USB",
  supported: true,
};
const capability = {
  success: true,
  firmwareIdentification: "available",
  firmwareInstallation: "not-available",
  releaseCatalog: "available",
  supportedTargets: [{ flightStack: "ArduPilot", vehicle: "Copter" }],
  installationMessage: "Firmware installation is blocked in this build.",
  catalogMessage: "Firmware catalog unavailable.",
  installation: {
    success: true,
    firmwareIdentification: "available",
    firmwareInstallation: "not-available",
    installationState: "BLOCKED_IN_VALIDATION_MODE",
    environment: "HARDWARE" as const,
    hardcodedEnable: false as const,
    blockedOperations: ["enter-bootloader", "bootloader-erase", "firmware-install"],
    blockedOnHardware: true,
    testAdapter: {
      enabled: true,
      label: "TEST / SIMULATION",
      exposedOverHttp: false,
      note: "in-process only",
    },
    installationMessage: "Firmware installation is blocked in this build.",
  },
};

const candidate = {
  id: "Copter/CubeBlack/apj/4.7.1/OFFICIAL",
  url: "https://firmware.ardupilot.org/Copter/stable/CubeBlack/arducopter.apj",
  platform: "CubeBlack",
  vehicle: "Copter",
  vehicleType: "Copter",
  format: "apj",
  version: "4.7.1",
  versionStr: "V4.7.1",
  versionMajor: 4,
  versionMinor: 7,
  versionPatch: 1,
  releaseType: "OFFICIAL",
  boardId: 9,
  bootloaderStr: ["CubeBlack-BL"],
  usbId: ["0x1209/0x5741"],
  brandName: "CubeBlack",
  manufacturer: "ArduPilot",
  imageSize: 1742336,
  gitSha: "abc123",
  autopilot: "ARDUPILOTMEGA",
  latest: true,
};

function catalogWith(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    connected: true,
    current: {
      version: "4.7.0 (Official Release)",
      release: "Official Release",
      boardType: 0,
      boardRev: 9,
      connectionType: "USB",
    },
    identity: {
      connected: true,
      isSitl: false,
      autopilot: "ARDUPILOTMEGA",
      vehicleType: "QUADROTOR",
      manifestVehicle: "Copter",
      boardType: 0,
      boardRev: 9,
      boardId: null,
      vendorId: 4617,
      productId: 22337,
      usbId: "0x1209/0x5741",
      bootloaderStr: null,
      firmwareVersion: "4.7.0 (Official Release)",
      connectionType: "USB",
      evidence: [],
      hasBootloaderIdentity: false,
    },
    catalog: {
      available: true,
      source: "network",
      stale: false,
      formatVersion: "1.0.0",
      totalEntries: 97377,
      etag: '"abc"',
      message: "Firmware catalogue retrieved from the official ArduPilot server.",
      fetchedAt: 1,
      cacheAgeSeconds: 0,
      manifestUrl: "https://firmware.ardupilot.org/manifest.json.gz",
      candidateCount: 895,
    },
    resolution: {
      outcome: "AMBIGUOUS",
      reason: "No bootloader identity is available.",
      canConfirm: false,
      candidateCount: 895,
      platformCount: 3,
      platforms: ["CubeBlack", "Pixhawk1", "Pixhawk1-1M"],
      platformsTruncated: false,
      signalsUsed: [],
      evidence: [],
      selected: null,
    },
    candidates: [],
    installation: capability.installation,
    message: "No bootloader identity is available.",
    ...overrides,
  };
}

const ambiguousCatalog = catalogWith();
const exactCatalog = catalogWith({
  resolution: {
    outcome: "EXACT_MATCH",
    reason: "Bootloader product string 'CubeBlack-BL' matches a single platform.",
    canConfirm: true,
    candidateCount: 3,
    platformCount: 1,
    platforms: ["CubeBlack"],
    platformsTruncated: false,
    signalsUsed: ["bootloader product string"],
    evidence: [],
    selected: candidate,
  },
  candidates: [candidate],
});

/** Phase 1 status for a board in normal MAVLink mode: no bootloader identity. */
const identityUnavailableStatus = {
  success: true,
  state: "NORMAL_MAVLINK" as const,
  transport: "MAVLINK" as const,
  mavlinkConnected: true,
  mavlinkConnectionType: "USB",
  bootloaderIdentityAvailable: false,
  bootloaderIdentityReadPerformed: false,
  bootloaderRevision: null,
  boardId: null,
  flashSize: null,
  bootloaderProductString: null,
  usbVendorId: 0x1209,
  usbProductId: 0x5741,
  usbId: "0x1209/0x5741",
  usbSerialNumber: "3C0027000951363033383531",
  usbProductString: "Pixhawk1",
  usbProductIsBootloaderEvidence: false,
  boardVersion: 589824,
  boardType: 0,
  boardRev: 9,
  systemId: 1,
  componentId: 1,
  missingFields: ["bootloaderRevision", "boardId", "flashSize", "bootloaderProductString"],
  refusal: "The board is in normal MAVLink mode, so no bootloader identity can be read.",
  warnings: [],
  resolver: {
    outcome: "IDENTITY_UNAVAILABLE" as const,
    reason: "The connected board reports no bootloader identity.",
    canConfirm: false,
    selected: null,
    signalsUsed: [],
    crossCheck: null,
    platformCount: 3,
    platforms: ["CubeBlack", "Pixhawk1", "Pixhawk1-1M"],
  },
  validation: {
    state: "NORMAL_MAVLINK" as const,
    history: [],
    record: {
      prepared: false,
      connectionFingerprint: null,
      hardwareFingerprint: null,
      firmwareVersion: null,
      usbId: null,
      usbSerialNumber: null,
      usbProductString: null,
      vehicleType: null,
      autopilot: null,
      note: "",
      refusedReason: "",
    },
    identity: null,
    resolution: null,
    lastCleared: [],
  },
  installationBlocked: true,
  performedOperations: [] as string[],
};

beforeEach(() => {
  cleanup();
  telemetry.connected = true;
  telemetry.connectionState = "CONNECTED";
  telemetry.disconnectReason = null;
  setupMocks.getFirmwareInfo.mockReset().mockResolvedValue(info);
  setupMocks.getFirmwareCapability.mockReset().mockResolvedValue(capability);
  setupMocks.getFirmwareCatalog.mockReset().mockResolvedValue(ambiguousCatalog);
  setupMocks.postFirmwareConfirmation.mockReset().mockResolvedValue({
    success: true,
    confirmationRequired: true,
    confirmed: true,
    outcome: "EXACT_MATCH",
    message: "Firmware target confirmed. Installation remains blocked in this build; no firmware will be written.",
    current: ambiguousCatalog.current,
    target: candidate,
    installation: capability.installation,
  });
  setupMocks.getBootloaderValidationStatus
    .mockReset()
    .mockResolvedValue(identityUnavailableStatus);
  setupMocks.prepareBootloaderIdentityValidation.mockReset().mockResolvedValue({
    success: true,
    prepared: true,
    state: "AWAITING_BOOTLOADER",
    nextRequirement:
      "Exact hardware compatibility requires a bootloader identity. This service will not move the board into bootloader mode.",
    record: identityUnavailableStatus.validation.record,
    clearedStaleData: [],
    performedOperations: [],
    message: "Bootloader identity validation prepared.",
  });
  setupMocks.postFirmwareDownload.mockReset().mockResolvedValue({
    success: true,
    message: "Firmware image downloaded and transfer-verified.",
    executed: false,
    installed: false,
    integrity: "SIZE_VERIFIED",
    downloadStatus: "DOWNLOAD_VERIFIED",
    verifiedForInstall: true,
    integrityNote: "the official host declared 1742336 bytes and the transfer delivered exactly 1742336",
  });
  setupMocks.getFirmwareWorkflow.mockReset().mockImplementation(async () => {
    const res = await setupMocks.getFirmwareCatalog();
    return {
      success: res.success,
      state: res.resolution?.canConfirm ? "CONFIRMATION_REQUIRED" : "READY",
      outcome: res.resolution?.outcome,
      resolution: res.resolution ?? null,
      releases: [],
      defaultCandidateId: null,
      installation: res.installation,
      session: undefined,
    };
  });
  setupMocks.getFirmwareInstallStatus.mockReset().mockResolvedValue({
    success: false,
    state: "IDLE",
    mode: "TEST / SIMULATION",
    isSimulation: true,
    hardwareTouched: false,
    versionVerified: false,
    message: "Idle",
    error: "",
    progress: [],
    history: [],
    terminal: true,
    realInstallationAllowed: false,
    realInstallationRefusal:
      "Firmware installation is currently disabled for real hardware validation.",
    blockedOperations: [],
  });
  setupMocks.postFirmwareInstall.mockReset().mockResolvedValue({
    success: false,
    state: "BLOCKED",
    mode: "REAL HARDWARE",
    isSimulation: false,
    hardwareTouched: false,
    versionVerified: false,
    message: "Firmware installation is currently disabled for real hardware validation.",
    error: "blocked",
    progress: [],
    history: ["DETECTING", "IDENTIFYING", "RESOLVING", "BLOCKED"],
    terminal: true,
    realInstallationAllowed: false,
    realInstallationRefusal:
      "Firmware installation is currently disabled for real hardware validation.",
    blockedOperations: [],
  });
  setupMocks.postFirmwareSimulation.mockReset().mockResolvedValue({
    success: false,
    state: "DOWNLOADING",
    mode: "TEST / SIMULATION",
    isSimulation: true,
    hardwareTouched: false,
    versionVerified: false,
    message: "Downloading the official firmware artifact.",
    error: "",
    progress: [],
    history: ["DETECTING", "IDENTIFYING", "RESOLVING"],
    terminal: false,
    realInstallationAllowed: false,
    realInstallationRefusal:
      "Firmware installation is currently disabled for real hardware validation.",
    blockedOperations: [],
  });
  setupMocks.postFirmwareCancel.mockReset().mockResolvedValue({
    success: false,
    state: "CANCELLED",
    mode: "TEST / SIMULATION",
    isSimulation: true,
    hardwareTouched: false,
    versionVerified: false,
    message: "Cancelled.",
    error: "cancelled",
    progress: [],
    history: ["CANCELLED"],
    terminal: true,
    realInstallationAllowed: false,
    realInstallationRefusal:
      "Firmware installation is currently disabled for real hardware validation.",
    blockedOperations: [],
  });
});
afterEach(cleanup);

describe("SetupFirmware workflow", () => {
  it("shows the simple no-vehicle workflow without stale firmware", async () => {
    telemetry.connected = false;
    telemetry.connectionState = "DISCONNECTED";
    render(<SetupFirmware />);
    expect(await screen.findByTestId("setup-firmware-workflow")).toHaveTextContent("No vehicle connected");
    expect(screen.queryByText(/4\.7\.0/)).not.toBeInTheDocument();
  });

  it("shows connecting and lost states", async () => {
    telemetry.connected = false;
    telemetry.connectionState = "CONNECTING";
    render(<SetupFirmware />);
    expect(await screen.findByText(/connecting to vehicle/i)).toBeInTheDocument();
    telemetry.connectionState = "DISCONNECTED";
    telemetry.disconnectReason = "unplugged";
    cleanup();
    render(<SetupFirmware />);
    expect(await screen.findByText(/connection lost/i)).toBeInTheDocument();
  });

  it("automatically identifies the controller when it connects while Firmware is open", async () => {
    telemetry.connected = false;
    telemetry.connectionState = "DISCONNECTED";
    const { rerender } = render(<SetupFirmware />);
    expect(await screen.findByText("No vehicle connected")).toBeInTheDocument();

    telemetry.connected = true;
    telemetry.connectionState = "CONNECTED";
    rerender(<SetupFirmware />);
    expect(await screen.findAllByText("4.7.0 (Official Release)")).not.toHaveLength(0);
    expect(setupMocks.getFirmwareInfo).toHaveBeenCalled();
  });

  it("renders live detected board and current firmware information", async () => {
    render(<SetupFirmware />);
    expect(await screen.findByText("ArduCopter")).toBeInTheDocument();
    expect(screen.getAllByText("4.7.0 (Official Release)").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("0.9").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("USB").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Ready · firmware identified")).toBeInTheDocument();
    expect(screen.getByText("ArduPilot")).toBeInTheDocument();
    expect(screen.getAllByText("Official Release").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("ArduPilot Flight Stack")).toBeInTheDocument();
  });

  it("shows catalog unavailable and keeps real installation blocked", async () => {
    render(<SetupFirmware />);
    const blocked = await screen.findByTestId("setup-firmware-install-blocked");
    expect(blocked).toHaveTextContent("Firmware installation is blocked in this build.");
    expect(blocked).toHaveTextContent("cannot be flashed");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("offers the synthetic simulation workflow only with no vehicle attached", async () => {
    telemetry.connected = false;
    telemetry.connectionState = "DISCONNECTED";
    render(<SetupFirmware />);
    const simulate = await screen.findByTestId("setup-firmware-simulate");
    expect(simulate).toBeEnabled();
    expect(screen.getByTestId("setup-firmware-simulate-warning")).toHaveTextContent("synthetic identity");
  });

  it("runs the TEST/SIMULATION workflow without any vehicle and reports no hardware", async () => {
    const user = userEvent.setup();
    telemetry.connected = false;
    telemetry.connectionState = "DISCONNECTED";
    render(<SetupFirmware />);
    await user.click(await screen.findByTestId("setup-firmware-simulate"));

    await waitFor(() => expect(setupMocks.postFirmwareSimulation).toHaveBeenCalled());
    // The real install endpoint is never used for the synthetic path.
    expect(setupMocks.postFirmwareInstall).not.toHaveBeenCalled();
    expect(setupMocks.postFirmwareSimulation).toHaveBeenCalledWith(
      expect.objectContaining({ asynchronous: true, confirmed: true }),
    );
    expect(await screen.findByTestId("setup-firmware-install-status")).toHaveTextContent(
      "TEST / SIMULATION",
    );
  });

  it("re-queries live firmware information", async () => {
    const user = userEvent.setup();
    setupMocks.getFirmwareInfo.mockResolvedValueOnce(info).mockResolvedValueOnce({ ...info, version: "4.10.0 (Beta)" });
    render(<SetupFirmware />);
    await screen.findAllByText("4.7.0 (Official Release)");
    await user.click(screen.getByTestId("setup-firmware-refresh"));
    expect((await screen.findAllByText("4.10.0 (Beta)")).length).toBeGreaterThanOrEqual(1);
  });

  it("keeps an AUTOPILOT_VERSION timeout in an error state until identity is actually received", async () => {
    const user = userEvent.setup();
    setupMocks.getFirmwareInfo
      .mockResolvedValueOnce({ success: false, connected: true, message: "AUTOPILOT_VERSION timeout" })
      .mockResolvedValueOnce(info);
    render(<SetupFirmware />);
    expect(await screen.findByText("Firmware information unavailable")).toBeInTheDocument();
    expect(screen.queryByText(/Ready · firmware identified/)).not.toBeInTheDocument();

    await user.click(screen.getByTestId("setup-firmware-retry"));
    expect(await screen.findByText("Ready · firmware identified")).toBeInTheDocument();
  });

  it("reports unsupported vehicles without showing install controls", async () => {
    setupMocks.getFirmwareInfo.mockResolvedValue({ ...info, vehicle: "FIXED_WING", supported: false, unsupportedReason: "ArduCopter only" });
    render(<SetupFirmware />);
    expect(await screen.findByText("Unsupported vehicle")).toBeInTheDocument();
    expect(screen.queryByTestId("setup-firmware-installation")).not.toBeInTheDocument();
  });
});

describe("SetupFirmware official catalogue", () => {
  it("shows the real catalogue metadata and candidate count", async () => {
    render(<SetupFirmware />);
    expect(await screen.findByTestId("setup-firmware-available")).toBeInTheDocument();
    expect(screen.getByText("895 images")).toBeInTheDocument();
    expect(screen.getByText("3 distinct")).toBeInTheDocument();
  });

  it("reports AMBIGUOUS truthfully and never forces a selection", async () => {
    render(<SetupFirmware />);
    expect(await screen.findByTestId("setup-firmware-incompatible")).toHaveTextContent(
      /Identity unavailable\..*cannot currently be proven\..*Installation remains blocked\./s,
    );
    expect(screen.getByText("Ambiguous")).toBeInTheDocument();
    // The incompatible platforms are surfaced instead of a chosen image.
    expect(screen.getByTestId("setup-firmware-ambiguous-platforms")).toHaveTextContent(
      "CubeBlack, Pixhawk1, Pixhawk1-1M",
    );
    expect(screen.queryByTestId("setup-firmware-confirmation")).not.toBeInTheDocument();
    expect(screen.queryByTestId("setup-firmware-confirm")).not.toBeInTheDocument();
  });

  it("does not show any install control for an ambiguous result", async () => {
    render(<SetupFirmware />);
    await screen.findByTestId("setup-firmware-incompatible");
    expect(screen.queryByTestId("setup-firmware-download-prepare")).not.toBeInTheDocument();
    expect(screen.queryByTestId("setup-firmware-confirm")).not.toBeInTheDocument();
    // Real hardware can never be flashed, so no install control exists at all.
    expect(screen.queryByTestId("setup-firmware-install")).not.toBeInTheDocument();
    expect(screen.queryByTestId("setup-firmware-install-disabled")).not.toBeInTheDocument();
  });

  it("surfaces the real catalogue when it is unavailable", async () => {
    setupMocks.getFirmwareCatalog.mockResolvedValue(
      catalogWith({
        catalog: {
          available: false,
          source: "none",
          stale: false,
          message: "Firmware catalogue request failed: network unreachable",
          manifestUrl: "https://firmware.ardupilot.org/manifest.json.gz",
        },
        resolution: {
          outcome: "UNAVAILABLE",
          reason: "Compatibility could not be evaluated because the official firmware catalogue is unavailable.",
          canConfirm: false,
          candidateCount: 0,
          platformCount: 0,
          platforms: [],
          platformsTruncated: false,
          signalsUsed: [],
          evidence: [],
          selected: null,
        },
      }),
    );
    render(<SetupFirmware />);
    expect(await screen.findByTestId("setup-firmware-catalog-unavailable")).toHaveTextContent(
      "network unreachable",
    );
  });

  it("marks a stale cached catalogue as such", async () => {
    setupMocks.getFirmwareCatalog.mockResolvedValue(
      catalogWith({
        catalog: {
          ...ambiguousCatalog.catalog,
          source: "cache",
          stale: true,
        },
      }),
    );
    render(<SetupFirmware />);
    expect(await screen.findByTestId("setup-firmware-catalog-stale")).toHaveTextContent(
      "validated local cache",
    );
  });

  it("shows a confirmed candidate as the available firmware", async () => {
    setupMocks.getFirmwareCatalog.mockResolvedValue(exactCatalog);
    render(<SetupFirmware />);
    expect(await screen.findByTestId("setup-firmware-available")).toHaveTextContent("V4.7.1");
    expect(screen.getByText("Exact match")).toBeInTheDocument();
    expect(screen.getAllByText("OFFICIAL").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("CubeBlack").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("1742336 bytes")).toBeInTheDocument();
  });

  it("enters CONFIRMATION_REQUIRED with current, target, board and release", async () => {
    setupMocks.getFirmwareCatalog.mockResolvedValue(exactCatalog);
    render(<SetupFirmware />);
    const panel = await screen.findByTestId("setup-firmware-confirmation");
    expect(panel).toHaveTextContent("Confirm Firmware");
    expect(panel).toHaveTextContent("4.7.0 (Official Release)");
    expect(panel).toHaveTextContent("V4.7.1");
    expect(panel).toHaveTextContent("OFFICIAL");
    expect(panel).toHaveTextContent("CubeBlack");
  });

  it("requires explicit confirmation and never installs", async () => {
    const user = userEvent.setup();
    setupMocks.getFirmwareCatalog.mockResolvedValue(exactCatalog);
    render(<SetupFirmware />);
    await screen.findByTestId("setup-firmware-confirm");
    await user.click(screen.getByTestId("setup-firmware-confirm"));

    expect(await screen.findByTestId("setup-firmware-confirmed")).toBeInTheDocument();
    expect(screen.getByTestId("setup-firmware-confirmed-note")).toHaveTextContent(
      "Installation remains blocked",
    );
    // Confirming a selection must never install, and no install control exists
    // while a real flight controller is attached.
    expect(screen.queryByTestId("setup-firmware-install")).not.toBeInTheDocument();
    expect(setupMocks.postFirmwareInstall).not.toHaveBeenCalled();
    expect(screen.getByTestId("setup-firmware-installation")).toHaveTextContent(
      "Firmware installation is blocked for real hardware.",
    );
  });

  it("prepares a download without executing or installing it", async () => {
    const user = userEvent.setup();
    setupMocks.getFirmwareCatalog.mockResolvedValue(exactCatalog);
    render(<SetupFirmware />);
    await user.click(await screen.findByTestId("setup-firmware-download-prepare"));
    expect(await screen.findByTestId("setup-firmware-download")).toHaveTextContent(
      "transfer-verified",
    );
    // The resolved payload must report that nothing was run or written.
    expect(await setupMocks.postFirmwareDownload.mock.results[0].value).toMatchObject({
      executed: false,
      installed: false,
    });
  });

  it("lists the blocked operations reported by the backend gate", async () => {
    render(<SetupFirmware />);
    expect(await screen.findByTestId("setup-firmware-blocked-operations")).toHaveTextContent(
      "enter-bootloader, bootloader-erase, firmware-install",
    );
  });

  it("does not resolve compatibility before a vehicle identity exists", async () => {
    setupMocks.getFirmwareInfo.mockResolvedValue({
      success: false,
      connected: true,
      message: "AUTOPILOT_VERSION timeout",
    });
    render(<SetupFirmware />);
    expect(await screen.findByText("Firmware information unavailable")).toBeInTheDocument();
    expect(setupMocks.getFirmwareCatalog).not.toHaveBeenCalled();
  });

  it("clears the catalogue when the vehicle disconnects", async () => {
    const { rerender } = render(<SetupFirmware />);
    await screen.findByTestId("setup-firmware-available");
    telemetry.connected = false;
    telemetry.connectionState = "DISCONNECTED";
    rerender(<SetupFirmware />);
    expect(await screen.findByText("No vehicle connected")).toBeInTheDocument();
    expect(screen.queryByTestId("setup-firmware-available")).not.toBeInTheDocument();
  });

  it("discards a confirmation that arrives after disconnect", async () => {
    const user = userEvent.setup();
    let finish!: (result: unknown) => void;
    setupMocks.getFirmwareCatalog.mockResolvedValue(exactCatalog);
    setupMocks.postFirmwareConfirmation.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const { rerender } = render(<SetupFirmware />);
    await user.click(await screen.findByTestId("setup-firmware-confirm"));

    telemetry.connected = false;
    telemetry.connectionState = "DISCONNECTED";
    rerender(<SetupFirmware />);
    await screen.findByText("No vehicle connected");
    await act(async () => {
      finish({ confirmed: true, target: candidate, message: "Old vehicle selection" });
    });

    telemetry.connected = true;
    telemetry.connectionState = "CONNECTED";
    rerender(<SetupFirmware />);
    await screen.findByTestId("setup-firmware-confirm");
    expect(screen.queryByTestId("setup-firmware-confirmed")).not.toBeInTheDocument();
  });

  it("discards a download response after refreshing to an ambiguous target", async () => {
    const user = userEvent.setup();
    let finish!: (result: unknown) => void;
    setupMocks.getFirmwareCatalog.mockResolvedValueOnce(exactCatalog).mockResolvedValueOnce(ambiguousCatalog);
    setupMocks.postFirmwareDownload.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    render(<SetupFirmware />);
    await user.click(await screen.findByTestId("setup-firmware-download-prepare"));
    await user.click(screen.getByTestId("setup-firmware-refresh"));
    await screen.findByTestId("setup-firmware-incompatible");
    await act(async () => {
      finish({ success: true, message: "Old vehicle download" });
    });
    expect(screen.queryByTestId("setup-firmware-download")).not.toBeInTheDocument();
    expect(screen.queryByTestId("setup-firmware-confirmation")).not.toBeInTheDocument();
  });
});

describe("SetupFirmware bootloader identity requirement", () => {
  it("states that identity is unavailable and installation stays blocked", async () => {
    render(<SetupFirmware />);
    const el = await screen.findByTestId("setup-firmware-incompatible");
    expect(el).toHaveTextContent(/Identity unavailable/);
    expect(el).toHaveTextContent(/cannot currently be proven/);
    expect(el).toHaveTextContent(/Installation remains blocked/);
  });

  it("shows the bootloader identity status fields", async () => {
    render(<SetupFirmware />);
    const el = await screen.findByTestId("setup-firmware-bootloader-identity");
    expect(el).toHaveTextContent("NORMAL_MAVLINK");
    expect(el).toHaveTextContent("MAVLINK");
    expect(el).toHaveTextContent("0x1209/0x5741");
    expect(el).toHaveTextContent("3C0027000951363033383531");
    expect(el).toHaveTextContent("IDENTITY_UNAVAILABLE");
  });

  it("shows unavailable rather than invented bootloader fields", async () => {
    render(<SetupFirmware />);
    const el = await screen.findByTestId("setup-firmware-bootloader-identity");
    // The normal-mode product string must not be shown as a bootloader product.
    expect(el).toHaveTextContent("Bootloader USB product");
    expect(el).toHaveTextContent("Pixhawk1");
    expect(setupMocks.getFirmwareCatalog).toHaveBeenCalled();
  });

  it("reports that the normal-mode product string is not bootloader evidence", async () => {
    render(<SetupFirmware />);
    const el = await screen.findByTestId("setup-firmware-bootloader-identity");
    expect(el).toHaveTextContent(/USB product is bootloader evidence/);
  });

  it("offers an informational action rather than entering bootloader mode", async () => {
    render(<SetupFirmware />);
    const action = await screen.findByTestId("setup-firmware-bootloader-prepare");
    expect(action).toHaveTextContent("Bootloader identity required");
  });

  it("preparation only records requirements and performs no operation", async () => {
    const user = userEvent.setup();
    render(<SetupFirmware />);
    const action = await screen.findByTestId("setup-firmware-bootloader-prepare");
    await user.click(action);

    await waitFor(() => {
      expect(setupMocks.prepareBootloaderIdentityValidation).toHaveBeenCalledTimes(1);
    });
    // No installation, download or simulation may be triggered by this action.
    expect(setupMocks.postFirmwareInstall).not.toHaveBeenCalled();
    expect(setupMocks.postFirmwareDownload).not.toHaveBeenCalled();
    expect(setupMocks.postFirmwareSimulation).not.toHaveBeenCalled();
    expect(setupMocks.postFirmwareConfirmation).not.toHaveBeenCalled();
  });

  it("displays the next validation requirement after preparing", async () => {
    const user = userEvent.setup();
    render(<SetupFirmware />);
    await user.click(await screen.findByTestId("setup-firmware-bootloader-prepare"));
    const next = await screen.findByTestId("setup-firmware-next-requirement");
    expect(next).toHaveTextContent(/requires a bootloader identity/i);
    expect(next).toHaveTextContent(/will not move the board into bootloader mode/i);
  });

  it("hides the action once a bootloader identity is available", async () => {
    setupMocks.getBootloaderValidationStatus.mockResolvedValue({
      ...identityUnavailableStatus,
      state: "IDENTITY_RESOLVED",
      bootloaderIdentityAvailable: true,
      bootloaderRevision: 4,
      boardId: 9,
      flashSize: 2097152,
      bootloaderProductString: "Pixhawk1-BL",
      usbProductIsBootloaderEvidence: true,
    });
    render(<SetupFirmware />);
    await screen.findByTestId("setup-firmware-bootloader-identity");
    expect(screen.queryByTestId("setup-firmware-bootloader-required")).toBeNull();
  });

  it("never offers a physical flashing control", async () => {
    render(<SetupFirmware />);
    await screen.findByTestId("setup-firmware-bootloader-identity");
    expect(screen.queryByTestId("setup-firmware-flash")).toBeNull();
    expect(screen.queryByTestId("setup-firmware-erase")).toBeNull();
    expect(screen.queryByTestId("setup-firmware-reboot")).toBeNull();
  });
});


// ---------------------------------------------------------------------------
// Release channels, and which build is current vs selected
// ---------------------------------------------------------------------------

function release(overrides: Record<string, unknown>) {
  return {
    candidateId: "Copter/CubeBlack/apj/4.7.1/OFFICIAL",
    version: "4.7.1",
    versionStr: "V4.7.1",
    releaseType: "OFFICIAL",
    releaseLabel: "Stable",
    platform: "CubeBlack",
    boardId: 9,
    url: "https://firmware.ardupilot.org/Copter/stable/CubeBlack/arducopter.apj",
    format: "apj",
    imageSize: 1742336,
    bootloaderStr: ["CubeBlack-BL"],
    usbId: ["0x1209/0x5741"],
    manufacturer: "ArduPilot",
    brandName: "CubeBlack",
    gitSha: "abc123",
    latest: true,
    vehicle: "Copter",
    isDefault: false,
    isSelected: false,
    isCurrent: false,
    compatibility: {
      status: "COMPATIBLE",
      reason: "Bootloader product string 'CubeBlack-BL' matches a single platform.",
      evidence: ["bootloader product string"],
    },
    ...overrides,
  };
}

function withReleases(releases: unknown[], defaultCandidateId: string | null = null) {
  setupMocks.getFirmwareWorkflow.mockImplementation(async () => {
    const res = await setupMocks.getFirmwareCatalog();
    return {
      success: res.success,
      state: res.resolution?.canConfirm ? "CONFIRMATION_REQUIRED" : "READY",
      outcome: res.resolution?.outcome,
      resolution: res.resolution ?? null,
      releases,
      defaultCandidateId,
      installation: res.installation,
      session: undefined,
    };
  });
}

describe("release channels", () => {
  it("groups releases into Stable, Beta and Development", async () => {
    withReleases([
      release({ candidateId: "stable", releaseType: "OFFICIAL" }),
      release({ candidateId: "beta", releaseType: "BETA", releaseLabel: "Beta" }),
      release({ candidateId: "dev", releaseType: "DEV", releaseLabel: "Development" }),
    ]);
    render(<SetupFirmware />);
    await screen.findByTestId("setup-firmware-channel-OFFICIAL");
    expect(screen.getByTestId("setup-firmware-channel-BETA")).toBeTruthy();
    expect(screen.getByTestId("setup-firmware-channel-DEV")).toBeTruthy();
    expect(screen.getByText("Stable")).toBeTruthy();
    expect(screen.getByText("Beta")).toBeTruthy();
    expect(screen.getByText("Development")).toBeTruthy();
  });

  it("omits channels the manifest does not offer", async () => {
    withReleases([release({ candidateId: "stable", releaseType: "OFFICIAL" })]);
    render(<SetupFirmware />);
    await screen.findByTestId("setup-firmware-channel-OFFICIAL");
    expect(screen.queryByTestId("setup-firmware-channel-BETA")).toBeNull();
    expect(screen.queryByTestId("setup-firmware-channel-DEV")).toBeNull();
  });

  it("keeps manifest order inside a channel", async () => {
    withReleases([
      release({ candidateId: "newer", versionStr: "V4.7.2" }),
      release({ candidateId: "older", versionStr: "V4.7.1" }),
    ]);
    render(<SetupFirmware />);
    const rows = await screen.findAllByTestId("setup-firmware-release");
    const labels = rows.map((row) => row.textContent ?? "");
    expect(labels.findIndex((t) => t.includes("V4.7.2"))).toBeLessThan(
      labels.findIndex((t) => t.includes("V4.7.1")),
    );
  });

  it("marks the installed version as Current", async () => {
    withReleases([
      release({ candidateId: "installed", versionStr: "V4.7.0", isCurrent: true }),
      release({ candidateId: "other", versionStr: "V4.7.1" }),
    ]);
    render(<SetupFirmware />);
    const rows = await screen.findAllByTestId("setup-firmware-release");
    const current = rows.filter((row) => row.querySelector('[data-testid="setup-firmware-badge-current"]'));
    expect(current).toHaveLength(1);
    expect(current[0].textContent).toContain("V4.7.0");
  });

  it("marks exactly one release as Selected", async () => {
    withReleases([
      release({ candidateId: "a", versionStr: "V4.7.1" }),
      release({ candidateId: "b", versionStr: "V4.7.2" }),
    ]);
    render(<SetupFirmware />);
    const rows = await screen.findAllByTestId("setup-firmware-release");
    const highlighted = rows.filter(
      (row) => row.querySelector('[data-testid="setup-firmware-badge-selected"]'),
    );
    expect(highlighted).toHaveLength(1);
    // The other row says "Available" rather than claiming a selection nobody
    // made, so CURRENT / SELECTED / AVAILABLE are three distinct things.
    const available = rows.filter(
      (row) => row.querySelector('[data-testid="setup-firmware-badge-available"]'),
    );
    expect(available).toHaveLength(1);
    expect(available[0].textContent).toContain("Available");
  });

  it("gives Current, Selected and Available distinct styling", async () => {
    withReleases(
      [
        release({ candidateId: "cur", versionStr: "V4.7.0", isCurrent: true }),
        release({ candidateId: "sel", versionStr: "V4.7.2" }),
        release({ candidateId: "avl", versionStr: "V4.7.3" }),
      ],
      "sel",
    );
    render(<SetupFirmware />);
    const rows = await screen.findAllByTestId("setup-firmware-release");
    const classesOf = (testId: string) =>
      rows
        .map((row) => row.querySelector(`[data-testid="${testId}"]`))
        .filter(Boolean)
        .map((node) => node!.className);

    const current = classesOf("setup-firmware-badge-current");
    const selected = classesOf("setup-firmware-badge-selected");
    const available = classesOf("setup-firmware-badge-available");

    expect(current[0]).toContain("setup-firmware-badge-current");
    expect(selected[0]).toContain("setup-firmware-badge-selected");
    expect(available[0]).toContain("setup-firmware-badge-available");
    // Three separate classes, so none of them can be mistaken for another.
    expect(new Set([current[0], selected[0], available[0]]).size).toBe(3);
  });

  it("shows Current and Selected together when the installed build is chosen", async () => {
    withReleases([release({ candidateId: "same", isCurrent: true })], "same");
    render(<SetupFirmware />);
    const row = (await screen.findAllByTestId("setup-firmware-release"))[0];
    expect(row.querySelector('[data-testid="setup-firmware-badge-current"]')).toBeTruthy();
    expect(row.textContent).toContain("Selected");
  });

  it("renders no release section when there is nothing to offer", async () => {
    withReleases([]);
    render(<SetupFirmware />);
    await screen.findByTestId("setup-firmware-bootloader-identity");
    expect(screen.queryByTestId("setup-firmware-releases")).toBeNull();
  });
});

describe("SetupFirmware release compatibility and integrity", () => {
  it("shows the vehicle and platform each release targets", async () => {
    withReleases([release({ candidateId: "a" }), release({ candidateId: "b" })]);
    render(<SetupFirmware />);
    const targets = await screen.findAllByTestId("setup-firmware-release-target");
    expect(targets.length).toBeGreaterThan(0);
    expect(targets[0]).toHaveTextContent("Copter · CubeBlack");
  });

  it("marks a compatible release and exposes the reason", async () => {
    withReleases([release({ candidateId: "a" })]);
    render(<SetupFirmware />);
    const badges = await screen.findAllByTestId("setup-firmware-release-compatibility");
    expect(badges[0]).toHaveTextContent("Compatible");
    expect(badges[0]).toHaveAttribute(
      "title",
      expect.stringContaining("CubeBlack-BL")
    );
  });

  it("never styles an unknown compatibility as a pass", async () => {
    withReleases([
      release({
        candidateId: "a",
        compatibility: {
          status: "UNKNOWN",
          reason: "The resolution outcome was AMBIGUOUS.",
          evidence: [],
        },
      }),
    ]);
    render(<SetupFirmware />);
    const badge = await screen.findByTestId("setup-firmware-release-compatibility");
    expect(badge).toHaveTextContent("Compatibility unknown");
    expect(badge.className).toContain("unknown");
    expect(badge.className).not.toContain("compatible");
  });

  it("marks the release the board is actually running", async () => {
    withReleases([
      release({ candidateId: "newer", versionStr: "V4.9.0", isCurrent: false }),
      release({ candidateId: "running", versionStr: "V4.7.0", isCurrent: true }),
    ]);
    render(<SetupFirmware />);
    expect(await screen.findByTestId("setup-firmware-badge-current")).toBeInTheDocument();
    expect(screen.getAllByTestId("setup-firmware-badge-current")).toHaveLength(1);
  });

  it("reports a verified download distinctly", async () => {
    const user = userEvent.setup();
    setupMocks.getFirmwareCatalog.mockResolvedValue(exactCatalog);
    render(<SetupFirmware />);
    await user.click(await screen.findByTestId("setup-firmware-download-prepare"));
    const status = await screen.findByTestId("setup-firmware-download-status");
    expect(status).toHaveAttribute("data-status", "DOWNLOAD_VERIFIED");
    expect(status).toHaveAttribute("data-integrity", "SIZE_VERIFIED");
    expect(status.className).toContain("verified");
  });

  it("shows a transfer-complete-only download as unverified, not verified", async () => {
    const user = userEvent.setup();
    setupMocks.getFirmwareCatalog.mockResolvedValue(exactCatalog);
    setupMocks.postFirmwareDownload.mockResolvedValue({
      success: true,
      message: "Firmware image downloaded.",
      integrity: "TRANSFER_COMPLETE_ONLY",
      downloadStatus: "TRANSFER_COMPLETE_ONLY",
      verifiedForInstall: false,
      integrityNote: "the official host published neither a digest nor a size",
    });
    render(<SetupFirmware />);
    await user.click(await screen.findByTestId("setup-firmware-download-prepare"));
    const status = await screen.findByTestId("setup-firmware-download-status");
    expect(status).toHaveAttribute("data-status", "TRANSFER_COMPLETE_ONLY");
    expect(status).toHaveTextContent("Transfer complete, not verified:");
    expect(status.className).toContain("unverified");
    expect(status.className).not.toContain("setup-firmware-integrity-verified");
  });

  it("shows a damaged artifact as a verification failure", async () => {
    const user = userEvent.setup();
    setupMocks.getFirmwareCatalog.mockResolvedValue(exactCatalog);
    setupMocks.postFirmwareDownload.mockResolvedValue({
      success: false,
      message: "The downloaded artifact failed its integrity verification.",
      integrity: "VERIFICATION_FAILED",
      downloadStatus: "DOWNLOAD_VERIFICATION_FAILED",
      verifiedForInstall: false,
      errorKind: "DOWNLOAD_VERIFICATION_FAILED",
      integrityNote: "the artifact was shorter than the declared size",
    });
    render(<SetupFirmware />);
    await user.click(await screen.findByTestId("setup-firmware-download-prepare"));
    const status = await screen.findByTestId("setup-firmware-download-status");
    expect(status).toHaveAttribute("data-status", "DOWNLOAD_VERIFICATION_FAILED");
    expect(status.className).toContain("verification-failed");
  });

  it("shows a transport failure separately from a verification failure", async () => {
    const user = userEvent.setup();
    setupMocks.getFirmwareCatalog.mockResolvedValue(exactCatalog);
    setupMocks.postFirmwareDownload.mockResolvedValue({
      success: false,
      message: "The firmware artifact could not be downloaded.",
      integrity: "",
      downloadStatus: "DOWNLOAD_FAILED",
      errorKind: "DOWNLOAD_FAILED",
    });
    render(<SetupFirmware />);
    await user.click(await screen.findByTestId("setup-firmware-download-prepare"));
    const status = await screen.findByTestId("setup-firmware-download-status");
    expect(status).toHaveAttribute("data-status", "DOWNLOAD_FAILED");
    expect(status).toHaveTextContent("Download failed:");
  });
});

// ---------------------------------------------------------------------------
// Every state the page can reach must render as itself, never as a neighbour
// ---------------------------------------------------------------------------

/** A backend session snapshot in ``state``, with everything else truthful. */
function sessionIn(state: string, overrides: Record<string, unknown> = {}) {
  return {
    success: state === "COMPLETED",
    state,
    mode: "TEST / SIMULATION",
    isSimulation: true,
    hardwareTouched: false,
    versionVerified: state === "COMPLETED",
    message: `Session is ${state}`,
    error: "",
    progress: [],
    history: [],
    terminal: ["COMPLETED", "FAILED", "CANCELLED", "DISCONNECTED"].includes(state),
    ...overrides,
  };
}

/**
 * Start a run with no board attached and let the page pick the given session
 * state up from the status poll -- the same path a real installation takes,
 * rather than a state pushed in from outside.
 */
async function renderSimulatedState(state: string, overrides: Record<string, unknown> = {}) {
  setupMocks.getFirmwareInstallStatus.mockResolvedValue(sessionIn(state, overrides));
  const user = userEvent.setup();
  telemetry.connected = false;
  telemetry.connectionState = "DISCONNECTED";
  render(<SetupFirmware />);
  await user.click(await screen.findByTestId("setup-firmware-simulate"));
  return screen.findByTestId("setup-firmware-install-status");
}

/**
 * Render the page for a connected, supported board whose workflow reports a
 * session -- the state a reload of the page would show.
 */
async function renderBoardSession(state: string, overrides: Record<string, unknown> = {}) {
  telemetry.connected = true;
  telemetry.connectionState = "CONNECTED";
  setupMocks.getFirmwareWorkflow.mockImplementation(async () => ({
    success: true,
    state,
    connected: true,
    outcome: "EXACT_MATCH",
    resolution: exactCatalog.resolution,
    releases: [release({})],
    defaultCandidateId: "Copter/CubeBlack/apj/4.7.1/OFFICIAL",
    session: sessionIn(state, overrides),
  }));
  render(<SetupFirmware />);
  return screen.findByTestId("setup-firmware-install-status");
}

describe("every reachable page state is represented as itself", () => {
  it("reports NO_MATCH as no match and offers nothing to install", async () => {
    setupMocks.getFirmwareCatalog.mockResolvedValue({
      ...exactCatalog,
      resolution: {
        ...exactCatalog.resolution,
        outcome: "NO_MATCH",
        canConfirm: false,
        reason: "No catalogue image declares bootloader product string 'CubeBlack-BL'.",
      },
    });
    withReleases([]);
    render(<SetupFirmware />);
    expect(await screen.findByText("No match")).toBeInTheDocument();
    // Nothing selectable, so no download control may appear.
    expect(screen.queryByTestId("setup-firmware-download-prepare")).toBeNull();
  });

  it("shows INSTALLING as in progress and never as verified", async () => {
    const status = await renderSimulatedState("INSTALLING", {
      progress: [{ state: "INSTALLING", percent: 40, message: "Writing" }],
    });
    // The page learns a new state from its 1.2s poll, not from the click.
    await waitFor(() => expect(status).toHaveTextContent("INSTALLING"), {
      timeout: 3000,
    });
    // The panel's own "Verified" row reads No: in progress is not a result.
    expect(status).toHaveTextContent(/Verified\s*No/);
  });

  it("shows VERIFYING as still running, because it is not a result yet", async () => {
    const status = await renderSimulatedState("VERIFYING", {
      progress: [{ state: "VERIFYING", percent: 90, message: "Reading back" }],
    });
    await waitFor(() => expect(status).toHaveTextContent("VERIFYING"), {
      timeout: 3000,
    });
    expect(status).toHaveTextContent(/Verified\s*No/);
  });

  it("shows COMPLETED only with a verified version behind it", async () => {
    await renderBoardSession("COMPLETED", { installedVersion: "V4.7.1" });
    expect(await screen.findByTestId("setup-firmware-install-verified")).toHaveTextContent(
      "Verified V4.7.1",
    );
    expect(screen.queryByTestId("setup-firmware-install-refused")).toBeNull();
  });

  it("shows FAILED as refused and never as verified", async () => {
    await renderBoardSession("FAILED", { error: "simulated-failure" });
    expect(await screen.findByTestId("setup-firmware-install-refused")).toHaveTextContent(
      "FAILED",
    );
    expect(screen.queryByTestId("setup-firmware-install-verified")).toBeNull();
  });

  it("shows CANCELLED as the operator's own doing, not a fault", async () => {
    await renderBoardSession("CANCELLED", { error: "cancelled-by-user" });
    expect(await screen.findByTestId("setup-firmware-install-refused")).toHaveTextContent(
      "CANCELLED",
    );
    // A cancelled run installed nothing, so there is nothing to have verified.
    expect(screen.queryByTestId("setup-firmware-install-verified")).toBeNull();
  });

  it("shows DISCONNECTED distinctly from an ordinary failure", async () => {
    await renderBoardSession("DISCONNECTED");
    expect(await screen.findByTestId("setup-firmware-install-refused")).toHaveTextContent(
      "DISCONNECTED",
    );
    expect(screen.queryByTestId("setup-firmware-install-verified")).toBeNull();
  });

  it("keeps a session visible across a reload instead of showing an empty panel", async () => {
    // The workflow carries the authoritative session, so a page opened while an
    // installation is in flight reports that state rather than nothing.
    await renderBoardSession("PREPARING");
    expect(await screen.findByTestId("setup-firmware-install-status")).toHaveTextContent(
      "PREPARING",
    );
  });
});

/* ---------------------------------------------------------------------------
 * GAP 9: exhaustive state and integrity rendering.
 *
 * The page is the only place an operator sees what the backend decided. Every
 * state the API can report is rendered here, so a state that appears without a
 * test is a state nobody has looked at.
 * ------------------------------------------------------------------------- */

/** Every state the workflow API can report, and where it appears. */
const ALL_STATES = [
  "NO_DEVICE",
  "DETECTING",
  "IDENTIFYING",
  "IDENTITY_UNAVAILABLE",
  "AMBIGUOUS",
  "UNSUPPORTED",
  "READY",
  "CONFIRMATION_REQUIRED",
  "DOWNLOADING",
  "DOWNLOAD_VERIFIED",
  "TRANSFER_COMPLETE_ONLY",
  "INSTALLING",
  "VERIFYING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "DISCONNECTED",
  "BLOCKED",
] as const;

/** Each integrity verdict, with the human wording the page must show for it. */
const ALL_INTEGRITY = [
  {
    integrity: "CHECKSUM_VERIFIED",
    status: "DOWNLOAD_VERIFIED",
    label: "Verified:",
    tone: "verified",
  },
  {
    integrity: "SIZE_VERIFIED",
    status: "DOWNLOAD_VERIFIED",
    label: "Verified:",
    tone: "verified",
  },
  {
    integrity: "TRANSFER_COMPLETE_ONLY",
    status: "TRANSFER_COMPLETE_ONLY",
    label: "Transfer complete, not verified:",
    tone: "unverified",
  },
  {
    integrity: "VERIFICATION_FAILED",
    status: "DOWNLOAD_VERIFICATION_FAILED",
    label: "Verification failed:",
    tone: "verification-failed",
  },
] as const;

function withState(state: string, overrides: Record<string, unknown> = {}) {
  setupMocks.getFirmwareInstallStatus.mockResolvedValue({
    success: false,
    state,
    mode: "REAL HARDWARE",
    isSimulation: false,
    hardwareTouched: false,
    versionVerified: false,
    message: `state ${state}`,
    error: "",
    progress: [],
    history: [state],
    terminal: ["COMPLETED", "FAILED", "CANCELLED", "DISCONNECTED", "BLOCKED"].includes(state),
    realInstallationAllowed: false,
    realInstallationRefusal: "Firmware installation is currently disabled for real hardware validation.",
    blockedOperations: [],
  });
  const session = {
    success: false,
    state,
    mode: "REAL HARDWARE",
    isSimulation: false,
    hardwareTouched: false,
    versionVerified: state === "COMPLETED",
    message: `state ${state}`,
    error: "",
    progress: [],
    history: [state],
    terminal: ["COMPLETED", "FAILED", "CANCELLED", "DISCONNECTED", "BLOCKED"].includes(state),
    realInstallationAllowed: false,
    realInstallationRefusal: "Firmware installation is currently disabled for real hardware validation.",
    blockedOperations: [],
    ...overrides,
  };
  setupMocks.getFirmwareInstallStatus.mockResolvedValue(session);
  setupMocks.getFirmwareWorkflow.mockResolvedValue({
    success: true,
    state,
    outcome: state === "NO_DEVICE" ? "NO_DEVICE" : "EXACT_MATCH",
    resolution: exactCatalog.resolution,
    releases: [],
    defaultCandidateId: null,
    installation: exactCatalog.installation,
    session,
  });
}

describe("every backend state renders", () => {
  it.each(ALL_STATES)("renders the %s state without crashing", async (state) => {
    withState(state);
    const { container } = render(<SetupFirmware />);
    await waitFor(() => {
      expect(container.textContent).toContain(state);
    });
  });

  it("covers every state in this list", () => {
    // Guards against a state being dropped or duplicated in the table above.
    expect(new Set(ALL_STATES).size).toBe(ALL_STATES.length);
  });

  it("renders a terminal failure without claiming success", async () => {
    for (const state of ["FAILED", "CANCELLED", "DISCONNECTED", "BLOCKED"]) {
      withState(state);
      const { unmount } = render(<SetupFirmware />);
      await screen.findByTestId("setup-firmware-install-status");
      const panel = screen.getByTestId("setup-firmware-install-status");
      expect(panel.textContent).toContain(state);
      // Verified is reported as "No": no terminal failure may imply an install.
      expect(panel.textContent).toContain("Verified");
      unmount();
    }
  });

  it("never invents a percentage when the backend gives none", async () => {
    // A run that is genuinely in flight and reporting no percentage: the bar
    // must be indeterminate rather than showing a made-up number.
    const inFlight = {
      success: false,
      state: "INSTALLING",
      mode: "TEST / SIMULATION",
      isSimulation: true,
      hardwareTouched: false,
      versionVerified: false,
      message: "installing",
      error: "",
      progress: [],
      history: ["INSTALLING"],
      terminal: false,
      realInstallationAllowed: false,
      realInstallationRefusal: "",
      blockedOperations: [],
    };
    telemetry.connected = false;
    telemetry.connectionState = "DISCONNECTED";
    setupMocks.postFirmwareSimulation.mockResolvedValue(inFlight);
    setupMocks.getFirmwareInstallStatus.mockResolvedValue(inFlight);
    const user = userEvent.setup();
    render(<SetupFirmware />);
    await user.click(await screen.findByTestId("setup-firmware-simulate"));

    expect(await screen.findByTestId("setup-firmware-progress-indeterminate")).toBeInTheDocument();
    // No valued bar, so nothing on screen claims a completion percentage.
    expect(screen.queryByTestId("setup-firmware-progress")).toBeNull();
  });

  it("shows a real percentage only when the backend supplies one", async () => {
    const inFlight = {
      success: false,
      state: "INSTALLING",
      mode: "TEST / SIMULATION",
      isSimulation: true,
      hardwareTouched: false,
      versionVerified: false,
      message: "installing",
      error: "",
      progress: [{ phase: "install", percent: 42, message: "writing" }],
      history: ["INSTALLING"],
      terminal: false,
      realInstallationAllowed: false,
      realInstallationRefusal: "",
      blockedOperations: [],
    };
    telemetry.connected = false;
    telemetry.connectionState = "DISCONNECTED";
    setupMocks.postFirmwareSimulation.mockResolvedValue(inFlight);
    setupMocks.getFirmwareInstallStatus.mockResolvedValue(inFlight);
    const user = userEvent.setup();
    render(<SetupFirmware />);
    await user.click(await screen.findByTestId("setup-firmware-simulate"));

    const bar = await screen.findByTestId("setup-firmware-progress");
    expect(bar).toHaveAttribute("value", "42");
  });
});

describe("every integrity outcome renders", () => {
  it.each(ALL_INTEGRITY)(
    "renders the $integrity outcome as '$label'",
    async ({ integrity, status, label, tone }) => {
      setupMocks.postFirmwareDownload.mockResolvedValue({
        success: integrity !== "VERIFICATION_FAILED",
        state: integrity === "VERIFICATION_FAILED" ? "FAILED" : "DOWNLOAD_VERIFIED",
        downloadStatus: status,
        integrity,
        checksumVerified: integrity === "CHECKSUM_VERIFIED",
        verifiedForInstall:
          integrity === "CHECKSUM_VERIFIED" || integrity === "SIZE_VERIFIED",
        path: "/tmp/firmware.apj",
        bytes: 1742336,
        sha256: "a".repeat(64),
        installed: false,
        message: `integrity ${integrity}`,
      });
      setupMocks.getFirmwareCatalog.mockResolvedValue(exactCatalog);
      const user = userEvent.setup();
      render(<SetupFirmware />);
      await user.click(await screen.findByTestId("setup-firmware-download-prepare"));

      const panel = await screen.findByTestId("setup-firmware-download-status");
      // The exact verdict is machine-readable, and the wording is human.
      expect(panel).toHaveAttribute("data-integrity", integrity);
      expect(panel).toHaveAttribute("data-status", status);
      expect(panel.textContent).toContain(label);
      // An unverified transfer is never styled as a pass.
      expect(panel.className).toContain(`setup-firmware-integrity-${tone}`);
      if (integrity !== "CHECKSUM_VERIFIED" && integrity !== "SIZE_VERIFIED") {
        expect(panel.className).not.toContain("setup-firmware-integrity-verified");
      }
    },
  );

  it("never presents a transfer-complete-only artifact as safe to write", async () => {
    setupMocks.postFirmwareDownload.mockResolvedValue({
      success: true,
      state: "DOWNLOAD_VERIFIED",
      downloadStatus: "TRANSFER_COMPLETE_ONLY",
      integrity: "TRANSFER_COMPLETE_ONLY",
      checksumVerified: false,
      verifiedForInstall: false,
      path: "/tmp/firmware.apj",
      bytes: 1742336,
      sha256: "b".repeat(64),
      installed: false,
      message: "only the transfer was observed",
    });
    setupMocks.getFirmwareCatalog.mockResolvedValue(exactCatalog);
    const user = userEvent.setup();
    render(<SetupFirmware />);
    await user.click(await screen.findByTestId("setup-firmware-download-prepare"));

    const panel = await screen.findByTestId("setup-firmware-download-status");
    expect(panel).toHaveAttribute("data-integrity", "TRANSFER_COMPLETE_ONLY");
    // The wording says "not verified", and the styling is not the verified tone.
    expect(panel.textContent).toContain("Transfer complete, not verified:");
    expect(panel.className).toContain("setup-firmware-integrity-unverified");
    expect(panel.className).not.toContain("setup-firmware-integrity-verified");
  });
});

/* ---------------------------------------------------------------------------
 * GAP 3: a release row must expose everything needed to choose with it.
 * ------------------------------------------------------------------------- */

describe("release rows expose their full identity", () => {
  const full = release({
    candidateId: "Copter/Pixhawk1/apj/4.7.1/OFFICIAL",
    version: "4.7.1",
    versionStr: "V4.7.1",
    releaseType: "OFFICIAL",
    releaseLabel: "Stable",
    platform: "Pixhawk1",
    vehicle: "Copter",
    imageSize: 1742336,
    format: "apj",
    url: "https://firmware.ardupilot.org/Copter/stable/Pixhawk1/arducopter.apj",
    gitSha: "dbe7921",
  });

  it("shows version, channel, platform and vehicle", async () => {
    withReleases([full]);
    render(<SetupFirmware />);
    const row = (await screen.findAllByTestId("setup-firmware-release"))[0];
    const text = row.textContent ?? "";
    expect(text).toContain("V4.7.1");
    expect(text).toContain("Stable");
    expect(row.querySelector('[data-testid="setup-firmware-release-target"]')?.textContent).toContain(
      "Pixhawk1",
    );
    expect(row.querySelector('[data-testid="setup-firmware-release-target"]')?.textContent).toContain(
      "Copter",
    );
  });

  it("shows the compatibility verdict and its reason", async () => {
    withReleases([
      release({
        candidateId: "c",
        compatibility: {
          status: "COMPATIBLE",
          reason: "Bootloader product string 'Pixhawk1-BL' matches a single platform.",
          evidence: ["bootloader product string"],
        },
      }),
    ]);
    render(<SetupFirmware />);
    const badge = await screen.findByTestId("setup-firmware-release-compatibility");
    expect(badge.textContent).toContain("Compatible");
    // The reason travels with the badge so the verdict is auditable.
    expect(badge.getAttribute("title")).toContain("matches a single platform");
  });

  it.each([
    ["COMPATIBLE", "Compatible"],
    ["INCOMPATIBLE", "Not compatible"],
    ["UNKNOWN", "Compatibility unknown"],
  ])("renders %s as '%s'", async (status, label) => {
    withReleases([
      release({
        candidateId: "c",
        compatibility: { status, reason: "because", evidence: [] },
      }),
    ]);
    render(<SetupFirmware />);
    const badge = await screen.findByTestId("setup-firmware-release-compatibility");
    expect(badge.textContent).toContain(label);
    expect(badge.className).toContain(
      `setup-firmware-badge-compat-${status.toLowerCase()}`,
    );
  });

  it("shows the artifact identity a user is approving", async () => {
    withReleases([full]);
    render(<SetupFirmware />);
    const row = (await screen.findAllByTestId("setup-firmware-release"))[0];
    const text = row.textContent ?? "";
    // Version, format and size: what would actually be written to the board.
    expect(text).toContain("V4.7.1");
    expect(text).toContain("1742336");
    // The candidate id is the exact thing a confirmation binds to.
    expect(row.querySelector('input[type="radio"]')?.getAttribute("value")).toBe(
      "Copter/Pixhawk1/apj/4.7.1/OFFICIAL",
    );
  });

  it("marks the running build Current and never infers it", async () => {
    withReleases([release({ candidateId: "a", versionStr: "V4.7.0", isCurrent: false })]);
    render(<SetupFirmware />);
    const row = (await screen.findAllByTestId("setup-firmware-release"))[0];
    expect(row.querySelector('[data-testid="setup-firmware-badge-current"]')).toBeNull();
  });

  it("offers nothing to select until the target resolves exactly", async () => {
    setupMocks.getFirmwareCatalog.mockResolvedValue(ambiguousCatalog);
    render(<SetupFirmware />);
    await screen.findByTestId("setup-firmware-incompatible");
    expect(screen.queryByTestId("setup-firmware-download-prepare")).toBeNull();
    expect(screen.queryAllByTestId("setup-firmware-release")).toHaveLength(0);
  });
});
