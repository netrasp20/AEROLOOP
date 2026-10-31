/**
 * Yantrayug SETUP API client (`/api/setup`) — Vehicle Configuration support.
 */

const API = "/api/setup";

export interface FirmwareInfo {
  success: boolean;
  connected?: boolean;
  message?: string;
  flightSwVersion?: number;
  version?: string;
  release?: string;
  custom?: string;
  middlewareSwVersion?: number;
  osSwVersion?: number;
  boardVersion?: number;
  boardType?: number;
  boardRev?: number;
  vendorId?: number;
  productId?: number;
  uid?: string;
  vehicleType?: string;
  vehicle?: string;
  autopilot?: string;
  autopilotLabel?: string;
  systemId?: number;
  componentId?: number;
  connectionType?: string;
  supported?: boolean;
  unsupportedReason?: string;
  unsupportedAutopilot?: string;
  unsupportedVehicle?: string;
}

export interface FirmwareCapability {
  success?: boolean;
  firmwareIdentification: string;
  firmwareInstallation: string;
  releaseCatalog: string;
  supportedTargets: { flightStack: string; vehicle: string }[];
  installationMessage?: string;
  identificationMessage?: string;
  catalogMessage?: string;
  catalog?: FirmwareCatalogStatus;
  installation?: FirmwareInstallationCapability;
}

export interface FirmwareCatalogStatus {
  available: boolean;
  source: "network" | "cache" | "none";
  stale: boolean;
  formatVersion?: string;
  totalEntries?: number;
  etag?: string;
  message: string;
  fetchedAt?: number | null;
  cacheAgeSeconds?: number | null;
  manifestUrl: string;
  candidateCount?: number;
}

export interface FirmwareInstallationCapability {
  success: boolean;
  firmwareIdentification: string;
  firmwareInstallation: string;
  installationState: string;
  environment: "SITL" | "HARDWARE" | "NONE";
  hardcodedEnable: false;
  blockedOperations: string[];
  blockedOnHardware: boolean;
  testAdapter: {
    enabled: boolean;
    label: string;
    exposedOverHttp: boolean;
    note: string;
  };
  installationMessage: string;
}

/** One real firmware image from the official ArduPilot manifest. */
export interface FirmwareCandidate {
  id: string;
  url: string;
  platform: string;
  vehicle: string;
  vehicleType: string;
  format: string;
  version: string;
  versionStr: string;
  versionMajor: number | null;
  versionMinor: number | null;
  versionPatch: number | null;
  releaseType: string;
  boardId: number | null;
  bootloaderStr: string[];
  usbId: string[];
  brandName: string;
  manufacturer: string;
  imageSize: number | null;
  gitSha: string;
  autopilot: string;
  latest: boolean;
}

export type FirmwareCompatibilityOutcome =
  | "EXACT_MATCH"
  | "CONFIRMED_COMPATIBLE"
  | "AMBIGUOUS"
  | "UNSUPPORTED"
  | "NO_MATCH"
  // A board is connected and answering, but no bootloader identity is available
  // to identify its physical platform. Different from AMBIGUOUS: nothing is in
  // conflict, the trustworthy signal is simply unobtainable.
  | "IDENTITY_UNAVAILABLE"
  // Nothing is connected, so there is no identity to resolve against.
  | "NO_DEVICE"
  | "UNKNOWN"
  | "UNAVAILABLE";

/** One independent official-manifest fact an exact match has to survive. */
export interface FirmwareCrossCheckItem {
  name: string;
  passed: boolean;
  detail: string;
}

/**
 * The independent verification of an exact match against the official
 * manifest. An exact match is only offered when every check passes.
 */
export interface FirmwareCrossCheck {
  candidate: string;
  platform: string;
  passed: boolean;
  failedChecks: string[];
  checks: FirmwareCrossCheckItem[];
}

export interface FirmwareResolution {
  outcome: FirmwareCompatibilityOutcome;
  reason: string;
  canConfirm: boolean;
  candidateCount: number;
  platformCount: number;
  platforms: string[];
  platformsTruncated: boolean;
  signalsUsed: string[];
  evidence: string[];
  selected: FirmwareCandidate | null;
  crossCheck: FirmwareCrossCheck | null;
}

/** The nine states of the explicit bootloader identity validation machine. */
export type BootloaderValidationState =
  | "NORMAL_MAVLINK"
  | "AWAITING_BOOTLOADER"
  | "BOOTLOADER_DETECTED"
  | "BOOTLOADER_IDENTITY_READING"
  | "BOOTLOADER_IDENTITY_READ"
  | "IDENTITY_RESOLVED"
  | "IDENTITY_AMBIGUOUS"
  | "IDENTITY_FAILED"
  | "DISCONNECTED";

/** What a bootloader identity read must recover before firmware can be chosen. */
export interface BootloaderValidationRecord {
  prepared: boolean;
  connectionFingerprint: string | null;
  hardwareFingerprint: string | null;
  firmwareVersion: string | null;
  usbId: string | null;
  usbSerialNumber: string | null;
  usbProductString: string | null;
  vehicleType: string | null;
  autopilot: string | null;
  note: string;
  refusedReason: string;
}

/** Phase 1: the read-only identity status, with every field or an honest null. */
export interface BootloaderValidationStatus {
  success: boolean;
  state: BootloaderValidationState;
  transport: "NONE" | "MAVLINK" | "BOOTLOADER" | "UNKNOWN";
  mavlinkConnected: boolean;
  mavlinkConnectionType: string | null;
  bootloaderIdentityAvailable: boolean;
  bootloaderIdentityReadPerformed: boolean;
  bootloaderRevision: number | null;
  boardId: number | null;
  flashSize: number | null;
  bootloaderProductString: string | null;
  usbVendorId: number | null;
  usbProductId: number | null;
  usbId: string | null;
  usbSerialNumber: string | null;
  usbProductString: string | null;
  /** False for a normal-mode product string: that is not bootloader evidence. */
  usbProductIsBootloaderEvidence: boolean;
  boardVersion: number | null;
  boardType: number | null;
  boardRev: number | null;
  systemId: number | null;
  componentId: number | null;
  missingFields: string[];
  refusal: string;
  warnings: string[];
  resolver: {
    outcome: FirmwareCompatibilityOutcome;
    reason: string;
    canConfirm: boolean;
    selected: FirmwareCandidate | null;
    signalsUsed: string[];
    crossCheck: FirmwareCrossCheck | null;
    platformCount: number | null;
    platforms: string[];
  };
  validation: {
    state: BootloaderValidationState;
    history: { from: string; to: string; reason: string }[];
    record: BootloaderValidationRecord;
    identity: Record<string, unknown> | null;
    resolution: Record<string, unknown> | null;
    lastCleared: string[];
  };
  installationBlocked: boolean;
  /** Always empty: this phase performs no physical operation. */
  performedOperations: string[];
}

/** Phase 3: the result of explicitly preparing a bootloader validation. */
export interface BootloaderValidationPrepareResult {
  success: boolean;
  prepared: boolean;
  state: BootloaderValidationState;
  nextRequirement?: string;
  reason?: string;
  refused?: boolean;
  treatedAsBootloader?: boolean;
  record: BootloaderValidationRecord;
  clearedStaleData: string[];
  performedOperations: string[];
  message: string;
}

/** USB descriptor identity of a port, read from the OS without opening it. */
export interface BootloaderUsbPortIdentity {
  device: string;
  vendorId: number | null;
  productId: number | null;
  usbId: string | null;
  serialNumber: string | null;
  manufacturer: string | null;
  product: string | null;
  description: string | null;
  /**
   * True only for the bootloader's `<BOARD>-BL` product string. A normal-mode
   * product string is explicitly NOT bootloader evidence.
   */
  isBootloaderProductString: boolean;
}

/** Which transport the port presents, and the evidence for that decision. */
export interface BootloaderTransportProbe {
  kind: "NONE" | "MAVLINK" | "BOOTLOADER" | "UNKNOWN";
  canReadBootloader: boolean;
  mavlinkAlive: boolean;
  port: BootloaderUsbPortIdentity | null;
  reason: string;
  evidence: string[];
}

/**
 * Every field the bootloader identity service could obtain, and why it could
 * not obtain the rest. Absent fields are null, never defaulted.
 */
export interface BootloaderIdentityReport {
  transport: BootloaderTransportProbe;
  mavlinkConnectionType: string | null;
  systemId: number | null;
  componentId: number | null;
  bootloaderRevision: number | null;
  boardId: number | null;
  flashSize: number | null;
  bootloaderUsbProductString: string | null;
  boardVersion: number | null;
  boardType: number | null;
  boardRev: number | null;
  usbVendorId: number | null;
  usbProductId: number | null;
  usbId: string | null;
  usbSerialNumber: string | null;
  usbManufacturer: string | null;
  usbProductString: string | null;
  usbProductIsBootloaderEvidence: boolean;
  bootloaderReadPerformed: boolean;
  refusal: string;
  missingFields: string[];
  requiredProtocolFieldsPresent: boolean;
  canResolvePlatform: boolean;
  evidence: string[];
  warnings: string[];
  state: "RESOLVED" | "BLOCKED";
}

export interface FirmwareIdentity {
  connected: boolean;
  isSitl: boolean;
  autopilot: string;
  vehicleType: string;
  manifestVehicle: string | null;
  boardType: number | null;
  boardRev: number | null;
  boardId: number | null;
  vendorId: number | null;
  productId: number | null;
  usbId: string | null;
  bootloaderStr: string | null;
  firmwareVersion: string;
  connectionType: string;
  evidence: string[];
  hasBootloaderIdentity: boolean;
}

export interface FirmwareCurrent {
  version?: string;
  release?: string;
  custom?: string | null;
  boardType?: number;
  boardRev?: number;
  connectionType?: string;
  vehicle?: string;
  autopilotLabel?: string;
  uid?: string;
}

export interface FirmwareCatalogResult {
  success: boolean;
  connected?: boolean;
  message?: string;
  current?: FirmwareCurrent;
  identity?: FirmwareIdentity | null;
  catalog?: FirmwareCatalogStatus | null;
  resolution?: FirmwareResolution | null;
  candidates?: FirmwareCandidate[];
  candidatesTruncated?: boolean;
  installation?: FirmwareInstallationCapability;
}

export interface FirmwareVerificationCheck {
  field: string;
  expected: unknown;
  observed: unknown;
  matches: boolean;
  detail: string;
}

/**
 * Post-install verification. A correct firmware version on the wrong board is
 * not a successful installation, so the board identity, vehicle type and
 * autopilot type are verified alongside the version.
 */
export interface FirmwareVerification {
  verified: boolean;
  /** "" when verified, VERIFICATION_MISMATCH or VERIFICATION_UNCONFIRMED otherwise. */
  error: string;
  expectedVersion: string;
  observedVersion: string | null;
  expectedIdentity?: Record<string, unknown> | null;
  observedIdentity?: Record<string, unknown> | null;
  checks?: FirmwareVerificationCheck[];
  mismatches?: string[];
  source?: string;
  message: string;
  /** Absent/false for TEST/SIMULATION runs, where no board identity applies. */
  identityApplicable?: boolean;
}

/**
 * Confirmation binds the approval to the hardware, catalogue generation and
 * installed version the user actually saw. `invalidatedReasons` is present when
 * that context has moved on and the approval no longer applies.
 */
export interface FirmwareConfirmationRecord {
  confirmed: boolean;
  candidateId: string | null;
  version: string | null;
  versionStr: string | null;
  release: string | null;
  platform: string | null;
  outcome: string | null;
  connectionFingerprint: string | null;
  hardwareFingerprint: string | null;
  catalogEtag: string | null;
  currentVersion: string | null;
  synthetic: boolean;
  confirmedAt: string | null;
  invalidatedReasons?: string[];
}

export interface FirmwarePreInstallCheck {
  check: string;
  passed: boolean;
  detail: string;
}

export interface FirmwarePreInstallResult {
  ok: boolean;
  state: string;
  checks: FirmwarePreInstallCheck[];
  failures: string[];
  message: string;
}

export interface FirmwareConfirmation {
  success: boolean;
  confirmationRequired: boolean;
  confirmed: boolean;
  outcome?: FirmwareCompatibilityOutcome;
  message: string;
  current?: FirmwareCurrent;
  target?: FirmwareCandidate;
  identity?: FirmwareIdentity;
  resolution?: FirmwareResolution | null;
  installation?: FirmwareInstallationCapability;
}

export interface FirmwareDownloadResult {
  success: boolean;
  message: string;
  candidateId?: string;
  url?: string;
  path?: string | null;
  bytesWritten?: number;
  contentLength?: number | null;
  contentType?: string;
  sha256?: string;
  checksumVerified?: boolean;
  checksumNote?: string;
  /** How much could be checked; "" when the transfer produced nothing to check. */
  integrity?: FirmwareIntegrity;
  /** The coarse outcome a client branches on. */
  downloadStatus?: FirmwareDownloadStatus;
  /** False unless a published digest or size actually matched. */
  verifiedForInstall?: boolean;
  integrityNote?: string;
  errorKind?: FirmwareErrorKind | null;
  errorMessage?: string | null;
  imageSize?: number | null;
  executed?: boolean;
  installed?: boolean;
  outcome?: FirmwareCompatibilityOutcome;
}

export async function getFirmwareInfo(): Promise<FirmwareInfo> {
  const res = await fetch(`${API}/firmware`);
  const body = (await res.json()) as FirmwareInfo;
  return body;
}

export async function getFirmwareCapability(): Promise<FirmwareCapability> {
  const res = await fetch(`${API}/firmware/capability`);
  const body = (await res.json()) as FirmwareCapability;
  return body;
}

export async function getFirmwareCatalog(refresh = false): Promise<FirmwareCatalogResult> {
  const res = await fetch(`${API}/firmware/catalog${refresh ? "?refresh=true" : ""}`);
  const body = (await res.json()) as FirmwareCatalogResult;
  return body;
}

export async function postFirmwareConfirmation(
  confirmed: boolean,
  candidateId?: string,
): Promise<FirmwareConfirmation> {
  const res = await fetch(`${API}/firmware/confirmation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirmed, candidateId: candidateId ?? null }),
  });
  const body = (await res.json()) as FirmwareConfirmation;
  return body;
}

/**
 * Read-only: runs every pre-install check against live state. Changes nothing,
 * downloads nothing, touches no hardware.
 */
export async function getFirmwarePreInstallChecks(
  candidateId?: string,
): Promise<FirmwarePreInstallResult> {
  const query = candidateId ? `?candidateId=${encodeURIComponent(candidateId)}` : "";
  const res = await fetch(`${API}/firmware/pre-install-checks${query}`);
  return (await res.json()) as FirmwarePreInstallResult;
}

/** Authoritative read-only detection, including the reported hardware identity. */
export async function getFirmwareDetection(): Promise<Record<string, unknown>> {
  const res = await fetch(`${API}/firmware/detection`);
  return (await res.json()) as Record<string, unknown>;
}

/**
 * Phase 1: the read-only identity status.
 *
 * Reports the transport, MAVLink connectivity, whether a bootloader identity is
 * available, the bootloader fields if available, the USB identity, and the
 * resolver's outcome. Fields that could not be read are null, never invented.
 */
export async function getBootloaderValidationStatus(): Promise<BootloaderValidationStatus> {
  const res = await fetch(`${API}/firmware/bootloader-validation/status`);
  return (await res.json()) as BootloaderValidationStatus;
}

/**
 * Phase 3: prepare an explicitly controlled bootloader identity validation.
 *
 * Records the connection fingerprint, current firmware identity and USB
 * identity, and marks the workflow as awaiting a bootloader. It does NOT
 * reboot, erase, flash, change parameters or command actuators, and it never
 * enters bootloader mode.
 */
export async function prepareBootloaderIdentityValidation(): Promise<BootloaderValidationPrepareResult> {
  const res = await fetch(`${API}/firmware/bootloader-validation/prepare`, { method: "POST" });
  return (await res.json()) as BootloaderValidationPrepareResult;
}

/** Abandon a prepared validation. Only forgets what was recorded. */
export async function cancelBootloaderIdentityValidation(): Promise<BootloaderValidationPrepareResult> {
  const res = await fetch(`${API}/firmware/bootloader-validation/cancel`, { method: "POST" });
  return (await res.json()) as BootloaderValidationPrepareResult;
}

/**
 * Read-only bootloader identity: the bootloader protocol fields, the USB
 * descriptor identity, the board identity, and the transport classification
 * that decided whether a bootloader read was permitted.
 *
 * Never opens a port, writes to a device, reboots or enters bootloader mode.
 */
export async function getBootloaderIdentity(): Promise<BootloaderIdentityReport> {
  const res = await fetch(`${API}/firmware/bootloader-identity`);
  return (await res.json()) as BootloaderIdentityReport;
}

export async function postFirmwareDownload(
  candidateId?: string,
): Promise<FirmwareDownloadResult> {
  const res = await fetch(`${API}/firmware/download`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(candidateId ? { candidateId } : {}),
  });
  const body = (await res.json()) as FirmwareDownloadResult;
  return body;
}

// ---------------------------------------------------------------------------
// Firmware workflow: versions, installation state, install
// ---------------------------------------------------------------------------

export type FirmwareWorkflowState =
  | "IDLE"
  | "DETECTING"
  | "IDENTIFYING"
  | "RESOLVING"
  | "READY"
  | "CONFIRMATION_REQUIRED"
  | "DOWNLOADING"
  | "DOWNLOAD_VERIFIED"
  | "PREPARING"
  | "INSTALLING"
  | "VERIFYING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "DISCONNECTED"
  | "BLOCKED";

export interface FirmwareRelease {
  candidateId: string;
  version: string;
  versionStr: string;
  releaseType: string;
  releaseLabel: string;
  platform: string;
  boardId: number | null;
  url: string;
  format: string;
  imageSize: number | null;
  bootloaderStr: string[];
  usbId: string[];
  manufacturer: string;
  brandName: string;
  gitSha: string;
  latest: boolean;
  vehicle: string;
  isDefault: boolean;
  isSelected: boolean;
  isCurrent: boolean;
  compatibility: ReleaseCompatibility;
}

export interface ReleaseCompatibility {
  status: "COMPATIBLE" | "INCOMPATIBLE" | "UNKNOWN";
  reason: string;
  evidence: string[];
}

/** How much could actually be checked about a downloaded artifact. */
export type FirmwareIntegrity =
  | "CHECKSUM_VERIFIED"
  | "SIZE_VERIFIED"
  | "TRANSFER_COMPLETE_ONLY"
  | "VERIFICATION_FAILED"
  | "";

export interface FirmwareWorkflowResult {
  success: boolean;
  state: FirmwareWorkflowState | string;
  connected?: boolean;
  message?: string;
  detection?: {
    success: boolean;
    state: string;
    connected: boolean;
    connectionType?: string | null;
    vehicleType?: string | null;
    autopilot?: string | null;
    message?: string;
  } | null;
  current?: {
    version?: string;
    release?: string;
    vehicle?: string;
    autopilot?: string;
    boardType?: number;
    boardRev?: number;
    connectionType?: string;
  } | null;
  outcome?: FirmwareCompatibilityOutcome;
  resolution?: FirmwareResolution | null;
  releases?: FirmwareRelease[];
  defaultCandidateId?: string | null;
  selected?: FirmwareCandidate | null;
  installation?: FirmwareInstallationCapability;
  session?: FirmwareSession;
  /** Always present: the single taxonomy kind, or null when nothing failed. */
  errorKind?: FirmwareErrorKind | null;
  errorMessage?: string | null;
  /** Coarse download outcome; `integrity` carries the precise verdict. */
  downloadStatus?: FirmwareDownloadStatus;
  integrity?: FirmwareIntegrity;
  verifiedForInstall?: boolean;
}

export type FirmwareErrorKind =
  | "DEVICE_NOT_CONNECTED"
  | "IDENTITY_UNAVAILABLE"
  | "IDENTITY_AMBIGUOUS"
  | "UNSUPPORTED_HARDWARE"
  | "CATALOG_UNAVAILABLE"
  | "FIRMWARE_NOT_FOUND"
  | "CONFIRMATION_INVALID"
  | "DOWNLOAD_FAILED"
  | "DOWNLOAD_VERIFICATION_FAILED"
  | "INSTALLATION_BLOCKED"
  | "INSTALLATION_FAILED"
  | "DISCONNECTED"
  | "VERIFICATION_MISMATCH"
  | "VERIFICATION_UNCONFIRMED";

export type FirmwareDownloadStatus =
  | "DOWNLOAD_VERIFIED"
  | "DOWNLOAD_FAILED"
  | "DOWNLOAD_VERIFICATION_FAILED"
  | "TRANSFER_COMPLETE_ONLY";

export interface FirmwareProgressEntry {
  state: string;
  percent: number | null;
  indeterminate: boolean;
  message: string;
  isSimulation: boolean;
}

export interface FirmwareSession {
  success: boolean;
  state: FirmwareWorkflowState | string;
  mode: string;
  isSimulation: boolean;
  hardwareTouched: boolean;
  currentVersion?: string | null;
  currentRelease?: string | null;
  targetVersion?: string | null;
  targetRelease?: string | null;
  targetPlatform?: string | null;
  installedVersion?: string | null;
  versionVerified: boolean;
  outcome?: FirmwareCompatibilityOutcome | null;
  message: string;
  error: string;
  progress: FirmwareProgressEntry[];
  history: string[];
  terminal: boolean;
  realInstallationAllowed: boolean;
  realInstallationRefusal: string;
  blockedOperations: string[];
  detection?: unknown;
  environment?: string;
}

export interface FirmwareVersionList {
  success: boolean;
  state: FirmwareWorkflowState | string;
  outcome?: FirmwareCompatibilityOutcome;
  message?: string;
  releases: FirmwareRelease[];
  defaultCandidateId?: string | null;
  selected?: FirmwareCandidate | null;
  installation?: FirmwareInstallationCapability;
}

export async function getFirmwareWorkflow(): Promise<FirmwareWorkflowResult> {
  const res = await fetch(`${API}/firmware/workflow`);
  return (await res.json()) as FirmwareWorkflowResult;
}

export async function getFirmwareVersions(): Promise<FirmwareVersionList> {
  const res = await fetch(`${API}/firmware/versions`);
  return (await res.json()) as FirmwareVersionList;
}

export async function getFirmwareInstallStatus(): Promise<FirmwareSession> {
  const res = await fetch(`${API}/firmware/status`);
  return (await res.json()) as FirmwareSession;
}

/**
 * Start the real-hardware installation attempt.
 *
 * The client never claims confirmation: the backend only proceeds when its own
 * confirmation record matches this exact candidate id, so a forged
 * `confirmed: true` here has no effect.
 */
export async function postFirmwareInstall(
  candidateId?: string,
  allowSimulation = false,
  asynchronous = true,
): Promise<FirmwareSession> {
  const res = await fetch(`${API}/firmware/install`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      candidateId: candidateId ?? null,
      allowSimulation,
      asynchronous,
    }),
  });
  return (await res.json()) as FirmwareSession;
}

/**
 * Start the synthetic, clearly-labelled TEST/SIMULATION workflow.
 *
 * Reachable only with no physical board attached; the backend never routes a
 * connected vehicle through this path.
 */
export async function postFirmwareSimulation(
  payload: {
    vehicle?: string;
    observedVersion?: string;
    candidateId?: string;
    confirmed?: boolean;
    asynchronous?: boolean;
  } = {},
): Promise<FirmwareSession> {
  const res = await fetch(`${API}/firmware/simulate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      vehicle: payload.vehicle ?? "Copter",
      observedVersion: payload.observedVersion ?? null,
      candidateId: payload.candidateId ?? null,
      // The backend records this explicit action server-side; without it the
      // synthetic run refuses exactly like a real one.
      confirmed: payload.confirmed ?? false,
      asynchronous: payload.asynchronous ?? true,
    }),
  });
  return (await res.json()) as FirmwareSession;
}

export async function postFirmwareCancel(): Promise<FirmwareSession> {
  const res = await fetch(`${API}/firmware/cancel`, { method: "POST" });
  return (await res.json()) as FirmwareSession;
}

// ---------------------------------------------------------------------------
// Accelerometer 6-position calibration
// ---------------------------------------------------------------------------

export interface AccelCalStatus {
  active: boolean;
  step: number | null;
  label: string;
  order: number;
  total: number;
  result: "success" | "failed" | "cancelled" | null;
  message?: string;
}

export interface AccelCalStartResponse extends AccelCalStatus {
  success: boolean;
  message: string;
}

export interface AccelCalActionResponse {
  success: boolean;
  message: string;
}

async function postJson(path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${API}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const err = await res.json().catch(() => ({ detail: res.statusText }));
  if (!res.ok) {
    throw new Error(err.detail || `${path} failed`);
  }
  return err;
}

async function getJson(path: string): Promise<unknown> {
  const res = await fetch(`${API}/${path}`);
  const body = (await res.json()) as Record<string, unknown>;
  return body;
}

/** Start the interactive 6-position accelerometer calibration. */
export async function startAccelCalibration(): Promise<AccelCalStartResponse> {
  return (await postJson("accel-cal/start")) as AccelCalStartResponse;
}

/** Confirm the vehicle is in the requested orientation (`position` 1..6). */
export async function confirmAccelPosition(position: number): Promise<AccelCalActionResponse> {
  return (await postJson("accel-cal/confirm", { position })) as AccelCalActionResponse;
}

/** Cancel the accelerometer calibration wizard (GCS side). */
export async function cancelAccelCalibration(): Promise<AccelCalActionResponse> {
  return (await postJson("accel-cal/cancel")) as AccelCalActionResponse;
}

/** Current wizard state. */
export async function getAccelCalStatus(): Promise<AccelCalStatus> {
  return (await getJson("accel-cal/status")) as AccelCalStatus;
}

// ---------------------------------------------------------------------------
// Gyro / Barometer / Level Horizon calibration
// ---------------------------------------------------------------------------

export interface SensorCalActionResponse {
  success: boolean;
  message: string;
}

/** Run gyroscope calibration (MAV_CMD_PREFLIGHT_CALIBRATION param1). */
export async function runGyroCalibration(): Promise<SensorCalActionResponse> {
  return (await postJson("gyro-cal")) as SensorCalActionResponse;
}

/** Run barometer (ground pressure) calibration. */
export async function runBaroCalibration(): Promise<SensorCalActionResponse> {
  return (await postJson("baro-cal")) as SensorCalActionResponse;
}

/** Run Level Horizon calibration (board level, separate from 6-position). */
export async function runLevelCalibration(): Promise<SensorCalActionResponse> {
  return (await postJson("level-cal")) as SensorCalActionResponse;
}

// ---------------------------------------------------------------------------
// Compass (magnetometer) calibration
// ---------------------------------------------------------------------------

export interface CompassCalStatus {
  active: boolean;
  mask: number;
  status: string;
  completionPct: number;
  result: "success" | "failed" | "cancelled" | null;
}

export interface CompassCalActionResponse {
  success: boolean;
  message: string;
}

/** Start magnetometer calibration (mask 0 = all detected compasses). */
export async function startCompassCalibration(mask = 0): Promise<CompassCalActionResponse> {
  return (await postJson("compass-cal/start", { mask })) as CompassCalActionResponse;
}

/** Accept and save the finished magnetometer calibration. */
export async function acceptCompassCalibration(mask = 0): Promise<CompassCalActionResponse> {
  return (await postJson("compass-cal/accept", { mask })) as CompassCalActionResponse;
}

/** Cancel the running magnetometer calibration. */
export async function cancelCompassCalibration(mask = 0): Promise<CompassCalActionResponse> {
  return (await postJson("compass-cal/cancel", { mask })) as CompassCalActionResponse;
}

/** Current compass calibration state. */
export async function getCompassCalStatus(): Promise<CompassCalStatus> {
  return (await getJson("compass-cal/status")) as CompassCalStatus;
}

// ---------------------------------------------------------------------------
// Sensor status (actual parameter readback from the vehicle)
// ---------------------------------------------------------------------------

/** Differentiated sensor state — never fabricated by the backend. */
export type SensorCalState =
  | "calibrated"
  | "not-calibrated"
  | "unsupported"
  | "unknown";

export interface SensorParamEntry {
  supported: boolean;
  value: number | null;
  index?: number;
  count?: number;
}

export interface DetectedDevice {
  index: number;
  paramId: string;
  devid: number;
  name: string;
  use: number | null;
  useParam?: string | null;
  orient: number | null;
  orientParam?: string | null;
  orientName?: string | null;
  external: number | null;
  priority: number | null;
}

export interface SensorState {
  status?: SensorCalState;
  ids: Record<string, SensorParamEntry>;
  offsets: Record<string, SensorParamEntry>;
  orientName?: string;
  detected?: number;
  devices?: DetectedDevice[];
  calFit?: number | null;
  gyroCalFlag?: number | null;
  gndPress?: number | null;
  trim?: { x: number; y: number };
}

export interface CompassMotState {
  supported: boolean;
  enabled: number | null;
  active: boolean;
  throttle?: number;
  interference?: number;
}

export interface SensorStatus {
  connected: boolean;
  armed: boolean;
  systemId: number;
  componentId: number;
  vehicleType: string;
  autopilot: string;
  connectionType: string;
  sensors: {
    accel: SensorState;
    gyro: SensorState;
    baro: SensorState;
    compass: SensorState;
    level: SensorState;
    compassMot: CompassMotState;
  };
}

/** Read the actual calibration parameters and derived states for every sensor. */
export async function getSensorStatus(): Promise<SensorStatus> {
  return (await getJson("sensors/status")) as SensorStatus;
}

// ---------------------------------------------------------------------------
// Compass settings + flight controller orientation
// ---------------------------------------------------------------------------

export interface CompassConfiguration {
  connected: boolean;
  enabled: number | null;
  devices: DetectedDevice[];
  detected: number;
  primaryFit: number | null;
  orientations: Record<string, SensorParamEntry>;
  orientation: { supported: boolean; value: number | null };
}

/** Detected compasses + live flight-controller orientation (AHRS_ORIENTATION). */
export async function getCompassConfiguration(): Promise<CompassConfiguration> {
  return (await getJson("compass/configuration")) as CompassConfiguration;
}

// ---------------------------------------------------------------------------
// CompassMot (motor interference test, ArduPilot)
// ---------------------------------------------------------------------------

export interface CompassMotActionResponse {
  success: boolean;
  message: string;
  active?: boolean;
  hardwareRequired?: boolean;
}

/** Capability detection (supported / enabled / running state). */
export async function getCompassMotCapability(): Promise<CompassMotState> {
  return (await getJson("compassmot/capability")) as CompassMotState;
}

/** Start a bounded motor-throttle ramp (hardware measurement required). */
export async function startCompassMot(
  motor = 0,
  throttle = 30,
): Promise<CompassMotActionResponse> {
  return (await postJson("compassmot/start", { motor, throttle })) as CompassMotActionResponse;
}

/** Stop the CompassMot test locally (ArduPilot has no MAVLink abort). */
export async function cancelCompassMot(): Promise<CompassMotActionResponse> {
  return (await postJson("compassmot/cancel")) as CompassMotActionResponse;
}

/** Live throttle / interference state reported by the vehicle stream. */
export async function getCompassMotStatus(): Promise<CompassMotState> {
  return (await getJson("compassmot/status")) as CompassMotState;
}

// ---------------------------------------------------------------------------
// Setup Summary (QGC-style configuration status matrix)
// ---------------------------------------------------------------------------

export type SetupTone = "good" | "warn" | "unsupported" | "unknown" | "waiting";

export interface SetupStatusItem {
  id: string;
  label: string;
  tone: SetupTone;
  message: string;
  detail?: string;
  /** Setup screen id this row navigates to when clicked. */
  nav: string;
  /** Extra display data (e.g. frame class/type codes for label enrichment). */
  meta?: {
    frameClass?: number;
    frameType?: number;
  };
}

export interface SetupCounts {
  good: number;
  warn: number;
  unsupported: number;
  unknown: number;
  waiting: number;
}

export interface SetupSyncState {
  state: string;
  expectedCount: number;
  receivedCount: number;
  cachedEntries: number;
}

export interface SetupSummaryData {
  success: boolean;
  connected: boolean;
  sync: SetupSyncState;
  items: SetupStatusItem[];
  counts: SetupCounts;
  flightModes?: Array<{ slot: number; value: number | null; name: string }>;
  capabilities?: { camera?: string; scripting?: string };
}

/** Live Setup Summary capability matrix (backend-computed, never fabricated). */
export async function getSetupSummary(): Promise<SetupSummaryData> {
  return (await getJson("summary")) as SetupSummaryData;
}

// ---------------------------------------------------------------------------
// Radio setup (channel monitor + calibration) — Phase 8E
// ---------------------------------------------------------------------------

export type RadioSignalState = "RECEIVING" | "NO_SIGNAL" | "UNKNOWN" | "WAITING";

export interface RadioChannelValue {
  channel: number;
  value: number;
  active: boolean;
}

export interface RadioRcData {
  channelCount: number;
  rssi: number;
  /** Honest RSSI: 0 and 255 are MAVLink sentinels, never a signal strength. */
  rssiReport: RadioRssiReport;
  receivedAt: number;
  ageMs: number | null;
  stale: boolean;
  channels: RadioChannelValue[];
}

export interface RadioRssiReport {
  value: number | null;
  raw: number | null;
  available: boolean;
  unavailableReason: string | null;
}

export interface MainControlMapping {
  function: string;
  param: string;
  channel: number | null;
}

export interface MainControlsData {
  supported: boolean;
  mappings: MainControlMapping[];
  channels: number[];
}

/** One genuine aux / parameter-channel assignment option from vehicle metadata. */
export interface RadioAuxOption {
  value: number;
  label: string;
}

export interface RadioAuxChannel {
  channel: number;
  param: string | null;
  label: string | null;
  supported: boolean;
  isMainControl: boolean;
  value: number | null;
  options: RadioAuxOption[];
  unavailableReason: string | null;
}

export interface RadioAuxChannels {
  supported: boolean;
  channels: RadioAuxChannel[];
}

/**
 * Explicit page state vocabulary.
 * Link axis: DISCONNECTED | CONNECTING | CONNECTED.
 * Receiver axis: WAITING_FOR_RC | RC_ACTIVE | RC_STALE.
 */
export type RadioRcState =
  | "DISCONNECTED"
  | "CONNECTING"
  | "CONNECTED"
  | "WAITING_FOR_RC"
  | "RC_ACTIVE"
  | "RC_STALE";

/** Documented calibration stage vocabulary reported by the backend. */
export type RadioCalibrationStage =
  | "IDLE"
  | "READY"
  | "WAITING_FOR_RC"
  | "CALIBRATING"
  | "FINALIZING"
  | "SUCCESS"
  | "FAILED"
  | "CANCELLED"
  | "DISCONNECTED";

export interface ChannelSupportedFlags {
  min: boolean;
  trim: boolean;
  max: boolean;
  reversed: boolean;
}

export interface RadioChannelConfig {
  channel: number;
  min: number | null;
  max: number | null;
  trim: number | null;
  reversed: number;
  supported: ChannelSupportedFlags;
}

export type RadioPathState =
  | "idle"
  | "ready"
  | "capturing-center"
  | "center-done"
  | "capturing-min"
  | "min-done"
  | "capturing-max"
  | "validating"
  | "completed"
  | "failed"
  | "cancelled"
  | "timeout";

export interface RadioCalibrationStatus {
  state: RadioPathState;
  stage: RadioCalibrationStage;
  message: string;
  phase: string | null;
  progress: {
    phase?: string;
    frames?: number;
    channels?: Record<string, unknown>;
  } | null;
  result: {
    result: "success" | "failed" | "timeout" | "cancelled";
    message: string;
    values?: { param: string; value: number }[];
  } | null;
}

export interface RadioStatus {
  success: boolean;
  message?: string;
  connected: boolean;
  connectionState: string;
  disconnectReason?: string | null;
  armed: boolean;
  mode: string;
  systemId: number;
  componentId: number;
  vehicleType: string;
  autopilot: string;
  /**
   * The transport actually in use, reported by the connection manager.
   * CONNECTING and DISCONNECTED mean no transport is currently in use.
   */
  transport: "USB" | "TCP" | "UDP" | "CONNECTING" | "DISCONNECTED" | "UNKNOWN" | (string & {});
  supported: boolean;
  unsupportedReason?: string;
  signal: RadioSignalState;
  rcState: RadioRcState;
  rc: RadioRcData;
  mainControls: MainControlsData;
  auxChannels: RadioAuxChannels;
  channelConfig: RadioChannelConfig[];
  calibration: RadioCalibrationStatus;
  calibrationStage: RadioCalibrationStage;
}

/** Live Radio page snapshot (real RC telemetry + genuine parameter cache). */
export async function getRadioStatus(): Promise<RadioStatus> {
  return (await getJson("radio")) as RadioStatus;
}

export interface RadioActionResponse {
  success: boolean;
  message: string;
  state?: RadioPathState;
  stage?: RadioCalibrationStage;
}

/** Begin the radio calibration wizard (requires a live RC signal). */
export async function startRadioCalibration(): Promise<RadioActionResponse> {
  return (await postJson("radio/calibration/start")) as RadioActionResponse;
}

/** Run one capture phase ("center" | "min" | "max") from real RC frames. */
export async function captureRadioPhase(phase: string): Promise<RadioActionResponse> {
  return (await postJson("radio/calibration/capture", { phase })) as RadioActionResponse;
}

/** Cancel a running radio calibration. */
export async function cancelRadioCalibration(): Promise<RadioActionResponse> {
  return (await postJson("radio/calibration/cancel")) as RadioActionResponse;
}

/** Current radio calibration wizard state. */
export async function getRadioCalibrationStatus(): Promise<RadioCalibrationStatus> {
  return (await getJson("radio/calibration/status")) as RadioCalibrationStatus;
}

// ---------------------------------------------------------------------------
// Power setup (battery monitor, capacity, thresholds, calibration) — Phase 8F
// ---------------------------------------------------------------------------

export type PowerState =
  | "WAITING"
  | "CONNECTING"
  | "SYNCING"
  | "READY"
  | "MONITOR_DISABLED"
  | "NO_BATTERY_TELEMETRY"
  | "STALE_TELEMETRY"
  | "CONNECTION_LOST"
  | "UNSUPPORTED"
  | "ERROR";

export type BatteryHealthStatus =
  | "NORMAL"
  | "LOW"
  | "CRITICAL"
  | "CHARGING"
  | "DISABLED"
  | "UNAVAILABLE"
  | "STALE"
  | "UNKNOWN";

export interface PowerParamField {
  id: string;
  supported: boolean;
  value: number | null;
  name: string;
  description: string | null;
  units: string | null;
  rebootRequired: boolean;
  min?: number;
  max?: number;
  increment?: number;
  decoded?: string | null;
  options?: { code: number | string; label: string }[];
  readOnlyNotice?: string;
}

export interface PowerTelemetry {
  instance: number;
  id: number;
  voltage: number | null;
  current: number | null;
  consumedMah: number | null;
  remaining: number | null;
  temperature: number | null;
  cellVoltages: number[];
  chargeState: string;
  receivedAt: number | null;
  ageMs: number | null;
  stale: boolean;
  source: string | null;
}

export interface PowerAdvancedParam {
  id: string;
  value: number | null;
  name: string;
  description: string | null;
  units: string | null;
  rebootRequired: boolean;
}

export interface BatteryInstance {
  instance: number;
  label: string;
  prefix: string;
  monitor: PowerParamField;
  capacity: PowerParamField;
  thresholds: {
    lowVolt: PowerParamField;
    crtVolt: PowerParamField;
    lowMah: PowerParamField;
    crtMah: PowerParamField;
    lowTimer: PowerParamField;
    fsLowAct: PowerParamField;
    fsCrtAct: PowerParamField;
  };
  calibration: {
    voltMult: PowerParamField;
    ampPerVlt: PowerParamField;
    ampOffset: PowerParamField;
    vltOffset: PowerParamField;
  };
  advanced: PowerAdvancedParam[];
  telemetry: PowerTelemetry;
  health: { status: BatteryHealthStatus; detail: string };
}

export interface PowerSyncState {
  state: string;
  complete: boolean;
  expectedCount?: number;
  receivedCount?: number;
  cachedEntries?: number;
  missingIds?: string[];
}

export interface PowerStatus {
  success: boolean;
  connected: boolean;
  connectionState: string;
  disconnectReason?: string | null;
  armed: boolean;
  mode: string;
  systemId: number;
  componentId: number;
  vehicleType: string;
  autopilot: string;
  transport: string;
  supported: boolean;
  unsupportedReason?: string;
  state: PowerState;
  sync: PowerSyncState;
  staleThresholdMs: number;
  instances: BatteryInstance[];
  instanceCount: number;
  timestamp: number;
}

/** Live Power Setup page snapshot (real battery telemetry + genuine params). */
export async function getPowerInfo(): Promise<PowerStatus> {
  return (await getJson("power")) as PowerStatus;
}

/** Live battery telemetry snapshot for every detected instance. */
export async function getPowerTelemetry(): Promise<{
  batteries: PowerTelemetry[];
  timestamp: number;
}> {
  return (await getJson("power/telemetry")) as {
    batteries: PowerTelemetry[];
    timestamp: number;
  };
}

export interface VoltageMultiplierCalcBody {
  currentMultiplier: number;
  measuredVoltage: number;
  sensorVoltage: number;
}

export interface VoltageMultiplierCalcResponse {
  success: boolean;
  message: string;
  calculatedMultiplier?: number;
}

export interface AmpsPerVoltCalcBody {
  currentAmpsPerVolt: number;
  measuredCurrent: number;
  sensorCurrent: number;
}

export interface AmpsPerVoltCalcResponse {
  success: boolean;
  message: string;
  calculatedAmpsPerVolt?: number;
}

/** Safe voltage-multiplier calculation (user measures both readings). */
export async function calculateVoltageMultiplier(
  body: VoltageMultiplierCalcBody,
): Promise<VoltageMultiplierCalcResponse> {
  return (await postJson("power/calculate-voltage-multiplier", body)) as VoltageMultiplierCalcResponse;
}

/** Safe amps-per-volt calculation (user measures both readings). */
export async function calculateAmpsPerVolt(
  body: AmpsPerVoltCalcBody,
): Promise<AmpsPerVoltCalcResponse> {
  return (await postJson("power/calculate-amps-per-volt", body)) as AmpsPerVoltCalcResponse;
}

// ---------------------------------------------------------------------------
// Safety setup (failsafes, RTL, arming checks) — Phase 8G
// ---------------------------------------------------------------------------

export type SafetyState =
  | "WAITING"
  | "CONNECTING"
  | "SYNCING"
  | "READY"
  | "CONNECTION_LOST"
  | "UNSUPPORTED"
  | "ERROR";

export type SafetyStatusValue =
  | "Configured"
  | "Disabled"
  | "Enabled"
  | "Partially configured"
  | "Unknown";

export interface SafetyCodeOption {
  code: number | string;
  label: string;
}

export interface SafetyBit {
  code: number;
  label: string;
  present: boolean;
}

export interface SafetyParamField {
  id: string;
  supported: boolean;
  value: number | null;
  name: string;
  description: string | null;
  units: string | null;
  rebootRequired: boolean;
  min?: number;
  max?: number;
  increment?: number;
  decoded?: string | null;
  options?: SafetyCodeOption[];
  bits?: SafetyBit[];
  bitmaskUnavailable?: boolean;
  zeroMeansDisabled?: boolean;
  readOnly?: boolean;
}

export interface SafetyStatus {
  configuration: string;
  armingChecks: SafetyStatusValue;
  batteryFailsafe: SafetyStatusValue;
  radioFailsafe: SafetyStatusValue;
  gcsFailsafe: SafetyStatusValue;
  rtl: SafetyStatusValue;
}

export interface SafetyBatterySection {
  fields: {
    lowVolt: SafetyParamField;
    crtVolt: SafetyParamField;
    lowMah: SafetyParamField;
    crtMah: SafetyParamField;
    lowTimer: SafetyParamField;
    fsLowAct: SafetyParamField;
    fsCrtAct: SafetyParamField;
    fsVoltSrc: SafetyParamField;
  };
}

export interface SafetyRadioSection {
  fields: {
    enable: SafetyParamField;
    value: SafetyParamField;
    options: SafetyParamField;
  };
  warnings: string[];
}

export interface SafetyGcsSection {
  supported: boolean;
  field: SafetyParamField;
  timeout: SafetyParamField;
}

export interface SafetyRtlSection {
  fields: {
    alt: SafetyParamField;
    loitTime: SafetyParamField;
    altFinal: SafetyParamField;
    landSpeed: SafetyParamField;
  };
  extra: SafetyParamField[];
}

export interface SafetyFenceSection {
  fields: {
    enable: SafetyParamField;
    action: SafetyParamField;
    radius: SafetyParamField;
    altMax: SafetyParamField;
    altMin: SafetyParamField;
    margin: SafetyParamField;
    types: SafetyParamField;
    options: SafetyParamField;
    ntfFreq: SafetyParamField;
  };
}

export interface SafetyArmingSection {
  supported: boolean;
  field: SafetyParamField | null;
  /** Individual ARMING_* parameters the connected firmware publishes. */
  checks: SafetyParamField[];
  note: string | null;
}

export interface SafetyAdvancedCategory {
  name: string;
  params: SafetyParamField[];
}

export interface SafetySyncState {
  state: string;
  complete: boolean;
  expectedCount?: number;
  receivedCount?: number;
  cachedEntries?: number;
  missingIds?: string[];
}

export interface SafetyStatusPayload {
  success: boolean;
  connected: boolean;
  connectionState: string;
  disconnectReason?: string | null;
  armed: boolean;
  mode: string;
  systemId: number;
  componentId: number;
  vehicleType: string;
  autopilot: string;
  transport: string;
  supported: boolean;
  unsupportedReason?: string;
  state: SafetyState;
  sync: SafetySyncState;
  status: SafetyStatus | null;
  battery: SafetyBatterySection | null;
  radio: SafetyRadioSection | null;
  gcs: SafetyGcsSection | null;
  fence: SafetyFenceSection | null;
  rtl: SafetyRtlSection | null;
  arming: SafetyArmingSection | null;
  advanced: { categories: SafetyAdvancedCategory[] } | null;
  timestamp: number;
}

/** Live Safety Setup page snapshot (derived from the vehicle's real params). */
export async function getSafetyInfo(): Promise<SafetyStatusPayload> {
  return (await getJson("safety")) as SafetyStatusPayload;
}

// ---------------------------------------------------------------------------
// Actuator outputs and ESC telemetry (read-only) — Phase 8H
// ---------------------------------------------------------------------------

export type ActuatorSetupState =
  | "WAITING"
  | "CONNECTING"
  | "SYNCING"
  | "READY"
  | "UNSUPPORTED"
  | "CONNECTION_LOST"
  | "ERROR";

export interface ActuatorSyncState {
  state: string;
  complete: boolean;
  expectedCount?: number;
  receivedCount?: number;
  cachedEntries?: number;
  missingIds?: string[];
}

export interface MotorOutput {
  output: number;
  motorNumber: number | null;
  motorLabel: string | null;
  functionId: number | null;
  functionLabel: string | null;
  configured: boolean;
  source: string | null;
  /**
   * Whether this motor sits on the current airframe. `null` means the frame
   * class does not imply a motor count, so the mapping is honestly unknown.
   * Physical motor positions are never inferred.
   */
  frameMapped?: boolean | null;
  frameMappingReason?: string | null;
  /** Live servo telemetry, null when nothing real has been received. */
  pwm?: number | null;
  receivedAt?: number | null;
  ageMs?: number | null;
  freshness?: "AVAILABLE" | "STALE" | "UNAVAILABLE";
}

export interface VehicleFrame {
  classParam: string;
  typeParam: string;
  class: number | null;
  type: number | null;
  classLabel: string | null;
  typeLabel: string | null;
  label: string | null;
  configured: boolean;
  armCount: number | null;
  armCountSource: string | null;
  source: "firmware-metadata" | "unavailable";
  supported: boolean;
  geometryAvailable: false;
  geometryReason: string;
}

export interface MotorsStatus {
  success: boolean;
  connected: boolean;
  connectionState: string;
  disconnectReason?: string | null;
  armed: boolean;
  supported: boolean;
  unsupportedReason?: string;
  state: ActuatorSetupState;
  sync: ActuatorSyncState;
  outputs: MotorOutput[];
  outputCount: number;
  frame?: VehicleFrame;
  timestamp: number;
}

export interface EscTelemetry {
  index: number;
  rpm: number | null;
  voltage: number | null;
  current: number | null;
  temperature: number | null;
  consumptionMah: number | null;
  status: string | null;
  receivedAt: number | null;
  ageMs: number | null;
  freshness: "AVAILABLE" | "STALE" | "UNAVAILABLE";
}

export interface EscConfigParam {
  id: string;
  value: number | null;
  name: string;
  description: string | null;
  units: string | null;
  decoded: string | null;
  supported: boolean;
  rebootRequired: boolean;
}

export interface EscStatus {
  success: boolean;
  connected: boolean;
  connectionState: string;
  disconnectReason?: string | null;
  armed: boolean;
  supported: boolean;
  unsupportedReason?: string;
  state: ActuatorSetupState;
  sync: ActuatorSyncState;
  telemetry: EscTelemetry[];
  escCount: number;
  config: EscConfigParam[];
  timestamp: number;
}

export async function getMotorsInfo(): Promise<MotorsStatus> {
  return (await getJson("motors")) as MotorsStatus;
}

export async function getEscInfo(): Promise<EscStatus> {
  return (await getJson("esc")) as EscStatus;
}

// ---------------------------------------------------------------------------
// Logging / Scripting (Phase 8I)
//
// Every field below is a value the vehicle actually reported. Nothing is
// synthesised: a log entry or scripting parameter that the flight
// controller never sent stays absent and is rendered as unavailable.
// ---------------------------------------------------------------------------

export interface PayloadOption {
  code: number;
  label: string;
}

export interface PayloadBit {
  code: number;
  label: string;
  present: boolean;
}

/** One configuration parameter on the Logging/Scripting pages. */
export interface PayloadParamField {
  id: string;
  supported: boolean;
  value: number | null;
  name: string;
  description: string | null;
  units: string | null;
  writable: boolean;
  decoded: string | null;
  options: PayloadOption[];
  rebootRequired: boolean;
  kind: "scalar" | "enum" | "bitmask";
  min?: number;
  max?: number;
  increment?: number;
  bits?: PayloadBit[];
  enabledCount?: number;
}

export interface LogEntry {
  id: number;
  timeUtc: number | null;
  sizeBytes: number | null;
  numLogs: number | null;
  lastLogNum: number | null;
  ageMs: number | null;
  freshness: "AVAILABLE" | "STALE";
}

export interface LoggingStatus {
  success: boolean;
  connected: boolean;
  connectionState: string;
  disconnectReason?: string | null;
  armed: boolean;
  vehicleType: string;
  autopilot: string;
  transport: string;
  supported: boolean;
  unsupportedReason?: string;
  state: ActuatorSetupState;
  sync: ActuatorSyncState;
  readOnly: boolean;
  writePipeline: string;
  status: "Enabled" | "Partially configured" | "Disabled" | "Unknown";
  config: PayloadParamField[];
  configCount: number;
  logEntries: LogEntry[];
  logEntryCount: number;
  numLogs: number | null;
  lastLogNum: number | null;
  timestamp: number;
}

export interface ScriptingStatus {
  success: boolean;
  connected: boolean;
  connectionState: string;
  disconnectReason?: string | null;
  armed: boolean;
  vehicleType: string;
  autopilot: string;
  transport: string;
  supported: boolean;
  unsupportedReason?: string;
  state: ActuatorSetupState;
  sync: ActuatorSyncState;
  readOnly: boolean;
  writePipeline: string;
  executionEnabled: boolean;
  capability: {
    scriptingDetected: boolean;
    reason: string;
  };
  userTokens: string[];
  config: PayloadParamField[];
  configCount: number;
  timestamp: number;
}


export async function getLoggingInfo(): Promise<LoggingStatus> {
  return (await getJson("logging")) as LoggingStatus;
}

export async function getScriptingInfo(): Promise<ScriptingStatus> {
  return (await getJson("scripting")) as ScriptingStatus;
}

// ---------------------------------------------------------------------------
// Motor test + reverse direction (SITL-only execution, read-only on hardware)

export type MotorTestState =
  | "IDLE"
  | "READY"
  | "TESTING"
  | "STOPPING"
  | "STOPPED"
  | "ERROR"
  | "DISCONNECTED"
  | "UNAVAILABLE";

export type MotorTestEnvironment = "SITL" | "HARDWARE" | "NONE";

export interface MotorTestBounds {
  throttlePctMin: number;
  throttlePctMax: number;
  throttlePctDefault: number;
  timeoutSMin: number;
  timeoutSMax: number;
  timeoutSDefault: number;
}

export interface MotorTestResult {
  success: boolean;
  message: string;
  motor?: number | null;
  output?: number | null;
  throttlePct?: number | null;
  timeoutS?: number | null;
}

export interface MotorTestStatus {
  supported: boolean;
  environment: MotorTestEnvironment;
  readOnly: boolean;
  reasons: string[];
  state: MotorTestState;
  bounds: MotorTestBounds;
  activeMotor: number | null;
  activeThrottlePct: number | null;
  activeTimeoutS: number | null;
  remainingMs: number | null;
  lastResult: MotorTestResult | null;
  success?: boolean;
  message?: string;
}

export interface MotorReverseState {
  motor: number;
  output: number;
  paramId: string;
  configured: boolean;
  physicallyVerified: false;
}

export interface MotorReverseStatus {
  success: boolean;
  outputs: MotorReverseState[];
  reason?: string;
  message?: string;
  motor?: number;
  output?: number;
  paramId?: string;
  configured?: boolean;
  configuredValue?: number | null;
  parameterStatus?: string;
}

export async function getMotorTestStatus(): Promise<MotorTestStatus> {
  return (await getJson("motors/test")) as MotorTestStatus;
}

export async function startMotorTest(
  motor: number,
  throttlePct?: number,
  timeoutS?: number,
): Promise<MotorTestStatus> {
  return (await postJson("motors/test", { motor, throttlePct, timeoutS })) as MotorTestStatus;
}

export async function stopMotorTest(): Promise<MotorTestStatus> {
  return (await postJson("motors/test/stop")) as MotorTestStatus;
}

export async function getMotorReverseStates(): Promise<MotorReverseStatus> {
  return (await getJson("motors/reverse")) as MotorReverseStatus;
}

export async function setMotorReverse(
  motor: number,
  reversed: boolean,
): Promise<MotorReverseStatus> {
  return (await postJson("motors/reverse", { motor, reversed })) as MotorReverseStatus;
}
