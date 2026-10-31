/**
 * Parameter REST client + types (Phase 3).
 *
 * Consumes the Phase 2 backend under /api/parameters. All payload shapes
 * mirror `backend/api/parameters.py`, `services/parameter_service.py` and
 * `services/parameter_metadata.py` exactly.
 *
 * View-only by design — no write endpoints are exposed here.
 */

const API = "/api/parameters";

/* ------------------------------------------------------------------ */
/* Types (server-shaped)                                               */
/* ------------------------------------------------------------------ */

export type ConnectionState =
  | "DISCONNECTED"
  | "CONNECTING"
  | "SYNCING"
  | "READY"
  | "ERROR";

export type MetadataStatusValue =
  | "AVAILABLE"
  | "UNAVAILABLE"
  | "LOADING"
  | "ERROR";

export interface SyncState {
  connected: boolean;
  state: "idle" | "requesting" | "receiving" | "complete" | "failed";
  expectedCount: number;
  receivedCount: number;
  missingIds: string[];
  cachedEntries: number;
  startedAt?: number | null;
  lastReceivedAt?: number | null;
  retryCount: number;
  needsRefresh: boolean;
}

export interface MetadataStatus {
  vehicle: string;
  status: MetadataStatusValue;
  source?: string | null;
  sourceFile?: string | null;
  loadedAt?: number | null;
  generatedAt?: number | null;
  paramCount: number;
  groupCount: number;
  message?: string | null;
}

export interface ParamMetadata {
  id: string;
  name?: string | null;
  description?: string | null;
  units?: string | null;
  unitText?: string | null;
  min?: number | null;
  max?: number | null;
  increment?: number | null;
  values?: Record<string, string> | null;
  bitmask?: Record<string, string> | null;
  readOnly: boolean;
  rebootRequired: boolean;
  user: "Standard" | "Advanced";
  advanced: boolean;
  group?: string | null;
  source: string;
}

export interface ParamLive {
  value?: number | null;
  type?: string | null;
  index?: number | null;
  count?: number | null;
  receivedAt?: number | null;
  received: boolean;
  writeState?: string | null;
}

export interface ParamEntry {
  id: string;
  live?: ParamLive | null;
  metadata?: ParamMetadata | null;
  metadataMissing: boolean;
}

export interface ParameterListView {
  success: true;
  connection: ConnectionState;
  sync: SyncState;
  metadata: MetadataStatus;
  metadataMissing: boolean;
  vehicle: { vehicleType: string | null };
  count: number;
  parameters: ParamEntry[];
}

export interface ParameterStatusView {
  success: true;
  connection: ConnectionState;
  sync: SyncState;
  sessionId: string | null;
  metadata: MetadataStatus;
  vehicle: { vehicleType: string | null };
}

export interface MetadataOverviewView {
  success: true;
  vehicle: string | null;
  metadataStatus: MetadataStatus;
  groups: string[];
}

export interface ParameterDetailView {
  success: true;
  parameter: ParamEntry;
  metadataStatus: MetadataStatusValue;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

interface ApiError {
  success: false;
  error?: { code?: string; message?: string };
  [key: string]: unknown;
}

export type ApiResult<T> = (T & { success: true }) | ApiError;

function isError<T>(result: ApiResult<T>): result is ApiError {
  return !result.success;
}

function validateOrThrow<T>(payload: ApiResult<T>, label: string): T {
  if (isError(payload)) {
    const message =
      payload.error?.message ?? `${label} failed with ${payload.error?.code ?? "unknown error"}.`;
    throw new Error(message);
  }
  return payload;
}

/** Normalize a server-side id (may repeat in the path). */
function encodeId(paramId: string): string {
  return encodeURIComponent(paramId);
}

/* ------------------------------------------------------------------ */
/* Endpoints (all read-only)                                           */
/* ------------------------------------------------------------------ */

/** Full merged live+metadata view. `q` is a client-side convenience. */
export async function getAllParameters(q?: string): Promise<ParameterListView> {
  const params = q ? `?q=${encodeURIComponent(q)}` : "";
  const res = await fetch(`${API}${params}`);
  return validateOrThrow(await res.json(), "getAllParameters");
}

/** Connection / sync / metadata / session status. */
export async function getParameterStatus(): Promise<ParameterStatusView> {
  const res = await fetch(`${API}/status`);
  return validateOrThrow(await res.json(), "getParameterStatus");
}

/** Metadata provider status + catalog group list for the connected vehicle. */
export async function getMetadataOverview(): Promise<MetadataOverviewView> {
  const res = await fetch(`${API}/metadata`);
  return validateOrThrow(await res.json(), "getMetadataOverview");
}

/** One merged parameter. */
export async function getParameter(paramId: string): Promise<ParameterDetailView> {
  const res = await fetch(`${API}/${encodeId(paramId)}`);
  return validateOrThrow(await res.json(), "getParameter");
}

/** Force a fresh full vehicle download (session stays identical). */
export async function refreshParameters(): Promise<{
  success: true;
  sync: SyncState;
}> {
  const res = await fetch(`${API}/refresh`, { method: "POST" });
  return validateOrThrow(await res.json(), "refreshParameters");
}

/* ------------------------------------------------------------------ */
/* Write endpoints (Phase 5)                                            */
/* ------------------------------------------------------------------ */

/** One staged item sent to the batch write transaction. */
export interface WriteItemInput {
  paramId: string;
  value: number;
  originalValue: number;
}

/** A conflict the user must acknowledge before the batch proceeds. */
export interface ParamConflict {
  paramId: string;
  currentValue: number;
  originalValue: number;
  stagedValue: number;
}

export type WriteItemStatus = "success" | "failed" | "not_attempted";

export interface WriteItemResult {
  paramId: string;
  requestedValue: number;
  originalValue: number;
  status: WriteItemStatus;
  verifiedValue?: number | null;
  code?: string | null;
  message?: string | null;
}

export type WriteTransactionStatus =
  | "running"
  | "success"
  | "partial_failure"
  | "interrupted"
  | "failed"
  | "pending";

export interface WriteTransactionSummary {
  transactionId: string;
  sessionId: string | null;
  status: WriteTransactionStatus;
  interruptedReason?: string | null;
  total: number;
  succeeded: number;
  failed: number;
  notAttempted: number;
  startedAt?: number | null;
  completedAt?: number | null;
  results: WriteItemResult[];
}

export interface BatchWriteSuccessView {
  success: true;
  transaction: WriteTransactionSummary;
}

export interface ConflictView {
  success: false;
  error?: { code?: string; message?: string };
  conflicts: ParamConflict[];
}

export interface PreflightRejectView {
  success: false;
  error?: { code?: string; message?: string };
  items?: Array<{ paramId: string; code?: string; message?: string }>;
}

/** Sequential, verified batch write of staged parameters. */
export async function writeBatch(
  items: WriteItemInput[],
  acknowledged: string[] = [],
  transactionId?: string
): Promise<BatchWriteSuccessView | ConflictView | PreflightRejectView> {
  const body: Record<string, unknown> = { items, acknowledged };
  if (transactionId) body.transactionId = transactionId;
  const res = await fetch(`${API}/write`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as BatchWriteSuccessView | ConflictView | PreflightRejectView;
}

/** Current/tail of the last write transaction. */
export interface WriteStatusView {
  success: true;
  hasActive: boolean;
  active?: WriteTransactionSummary | null;
  last?: WriteTransactionSummary | null;
}

export async function getWriteStatus(): Promise<WriteStatusView> {
  const res = await fetch(`${API}/write/status`);
  return validateOrThrow(await res.json(), "getWriteStatus");
}

/* ------------------------------------------------------------------ */
/* Phase 6 — parameter files / presets / reset                         */
/* ------------------------------------------------------------------ */

export type ParamCompareCategory =
  | "changed"
  | "same"
  | "unknown"
  | "read_only"
  | "invalid";

export interface ParamCompareRow {
  paramId: string;
  category: ParamCompareCategory;
  vehicleValue: number | null;
  fileValue: number;
  stageable: boolean;
  stagedValue: number | null;
  stagedConflict: boolean;
  message: string | null;
  readOnly: boolean;
  group: string | null;
  rebootRequired: boolean;
}

export interface ParamParseReport {
  total: number;
  valid: number;
  malformed: number;
  duplicate: number;
  skipped: number;
  commentLines: number;
  malformedLines: string[];
  duplicateParams: string[];
  entries: Array<{ paramId: string; value: number }>;
}

export interface ParamAnalysisView {
  success: true;
  filename: string;
  parse: ParamParseReport;
  compare: {
    counts: Record<ParamCompareCategory, number>;
    diffCount: number;
    rows: ParamCompareRow[];
    fileIds: string[];
  };
}

export interface ParamExportView {
  success: true;
  filename: string;
  content: string;
  count: number;
  source: string;
}

export interface PresetInfo {
  id: string;
  name: string;
  description: string;
  vehicle: string;
  paramCount: number;
}

export interface PresetListView {
  success: true;
  vehicle: string | null;
  allowed: boolean;
  presets: PresetInfo[];
}

export type ResetStateName =
  | "idle"
  | "backup"
  | "reset_requested"
  | "reboot_requested"
  | "waiting_for_reboot"
  | "reconnecting"
  | "parameter_sync"
  | "verify"
  | "complete"
  | "failed";

export interface ResetSummary {
  resetId: string;
  state: string;
  backupCount: number;
  parameterCount: number;
  changedCount: number;
  unchangedCount: number;
  changedParams: string[];
  sync: { state: string; receivedCount: number; expectedCount: number };
}

export interface ResetStatusView {
  success: boolean;
  active: boolean;
  resetId: string | null;
  state: ResetStateName;
  message: string;
  error: { code?: string; message?: string } | null;
  summary: ResetSummary | null;
  startedAt: number | null;
  completedAt: number | null;
}

/** Serialize the authoritative vehicle set as a .param file. */
export async function exportParameters(
  source: "vehicle" = "vehicle"
): Promise<ParamExportView> {
  const res = await fetch(`${API}/export?source=${source}`);
  return validateOrThrow(await res.json(), "exportParameters");
}

/** Parse + validate + compare a parameter file against the live vehicle. */
export async function importParameters(
  content: string,
  filename: string
): Promise<ParamAnalysisView> {
  const res = await fetch(`${API}/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, filename }),
  });
  return validateOrThrow(await res.json(), "importParameters");
}

/** Compare a parameter file against the live vehicle, showing file-vs-stage
    conflicts via the optional staged map ({paramId: value}). */
export async function compareParameters(
  content: string,
  filename: string,
  staged?: Record<string, number>
): Promise<ParamAnalysisView> {
  const res = await fetch(`${API}/compare`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, filename, staged }),
  });
  return validateOrThrow(await res.json(), "compareParameters");
}

export async function getPresets(): Promise<PresetListView> {
  const res = await fetch(`${API}/presets`);
  return validateOrThrow(await res.json(), "getPresets");
}

export async function presetAnalyze(
  presetId: string,
  staged?: Record<string, number>
): Promise<ParamAnalysisView> {
  const res = await fetch(`${API}/presets/${encodeURIComponent(presetId)}/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ staged: staged ?? {} }),
  });
  return validateOrThrow(await res.json(), "presetAnalyze");
}

export interface ResetStartView {
  success: true;
  resetId: string;
}

/** Begin the backup -> reset -> reboot -> resync -> verify flow. */
export async function resetParameters(confirm: boolean): Promise<ResetStartView> {
  const res = await fetch(`${API}/reset`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirm }),
  });
  return validateOrThrow(await res.json(), "resetParameters");
}

export async function getResetStatus(): Promise<ResetStatusView> {
  const res = await fetch(`${API}/reset/status`);
  return validateOrThrow(await res.json(), "getResetStatus");
}