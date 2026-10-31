/**
 * Frame / Airframe configuration logic (pure, unit-testable).
 *
 * SETUP → Frame decodes the actual ArduCopter FRAME_CLASS / FRAME_TYPE values
 * reported by the vehicle and builds the option lists from the *connected
 * firmware's* parameter metadata (copter.xml) whenever it is available.
 *
 * Rules enforced here:
 *   - the vehicle's live FRAME_CLASS / FRAME_TYPE value is ALWAYS the current
 *     state shown to the user — never a local React default
 *   - when the firmware exposes an enum definition, only those codes render;
 *     the static fallbacks are used only when metadata is missing entirely
 *   - staging uses the shared parameter store; this module never writes
 */

import type { ParamEntry, WriteTransactionSummary } from "../../api/parameters";
import type { ParamMap } from "../../parameters/parametersLogic";
import type { StagedMap } from "../../parameters/stagedLogic";

/** Frame dimensions staged side-by-side. */
export const FRAME_CLASS_PARAM = "FRAME_CLASS";
export const FRAME_TYPE_PARAM = "FRAME_TYPE";

/** Standard base sets shown only when the connected firmware provides no
 *  metadata values for the parameter (metadataMissing). These mirror the
 *  official ArduCopter copter.xml definitions. */
export const FRAME_CLASS_FALLBACK: Record<string, string> = {
  "0": "Undefined",
  "1": "Quad",
  "2": "Hexa",
  "3": "Octa",
  "4": "OctaQuad",
  "5": "Y6",
  "6": "Heli",
  "7": "Tri",
  "8": "SingleCopter",
  "9": "CoaxCopter",
};

export const FRAME_TYPE_FALLBACK: Record<string, string> = {
  "0": "Plus",
  "1": "X",
  "2": "V",
  "3": "H",
  "4": "V-Tail",
  "5": "A-Tail",
  "10": "Y6B",
  "11": "Y6F",
  "19": "Y4",
};

export interface FrameOption {
  code: number;
  label: string;
}

export interface FrameField {
  paramId: string;
  supportLabel: string;
  /** Current live value reported by the vehicle (authoritative). */
  currentCode: number | null;
  currentLabel: string | null;
  /** Staged (unsaved local intent) value, if any. */
  pendingCode: number | null;
  pendingLabel: string | null;
  /** True when the user has a staged change different from live. */
  modified: boolean;
  hasMetadata: boolean;
  rebootRequired: boolean;
  /** Options from firmware metadata when present, otherwise fallback. */
  options: FrameOption[];
  metadataBased: boolean;
  /** True when the parameter exists in the running firmware's set. */
  supported: boolean;
}

export interface FrameConfig {
  classField: FrameField | null;
  typeField: FrameField | null;
  /** True when no FRAME_CLASS or FRAME_TYPE exists on the firmware. */
  unsupported: boolean;
  /** Any staged change (class or type) pending apply. */
  hasChanges: boolean;
  /** Count of frame parameters pending apply. */
  stagedCount: number;
  /** True when any staged frame change requires a reboot per metadata. */
  rebootPending: boolean;
  /** Human label for a raw code (metadata first, fallback second). */
  classLabelFor: (code: number) => string;
  typeLabelFor: (code: number) => string;
}

/** Option list: metadata enum values when present, fallback otherwise. */
function optionsFor(entry: ParamEntry | undefined, fallback: Record<string, string>): {
  options: FrameOption[];
  metadataBased: boolean;
} {
  const values = entry?.metadata?.values;
  if (values && Object.keys(values).length > 0) {
    return {
      options: Object.entries(values)
        .map(([code, label]) => ({ code: Number(code), label }))
        .sort((a, b) => a.code - b.code),
      metadataBased: true,
    };
  }
  return {
    options: Object.entries(fallback)
      .map(([code, label]) => ({ code: Number(code), label }))
      .sort((a, b) => a.code - b.code),
    metadataBased: false,
  };
}

function labelFor(
  entry: ParamEntry | undefined,
  fallback: Record<string, string>,
  code: number | null
): string | null {
  if (code === null || code === undefined) return null;
  const values = entry?.metadata?.values;
  const known = values && Object.keys(values).length > 0 ? values : fallback;
  return known[String(Math.trunc(code))] ?? known[String(code)] ?? `Code ${code}`;
}

/** Metadata-truthful labels shared with the Setup Summary. */
export function frameClassLabel(
  entry: ParamEntry | undefined,
  code: number | null
): string | null {
  return labelFor(entry, FRAME_CLASS_FALLBACK, code);
}

export function frameTypeLabel(
  entry: ParamEntry | undefined,
  code: number | null
): string | null {
  return labelFor(entry, FRAME_TYPE_FALLBACK, code);
}

function buildField(
  entries: ParamMap,
  staged: StagedMap,
  paramId: string,
  fallback: Record<string, string>,
  supportLabel: string
): FrameField | null {
  const entry = entries[paramId];
  if (!entry) {
    return {
      paramId,
      supportLabel,
      currentCode: null,
      currentLabel: null,
      pendingCode: null,
      pendingLabel: null,
      modified: false,
      hasMetadata: false,
      rebootRequired: false,
      options: [],
      metadataBased: false,
      supported: false,
    };
  }

  const liveValue = entry.live?.value;
  const currentCode =
    typeof liveValue === "number" && Number.isFinite(liveValue)
      ? Math.trunc(liveValue)
      : null;
  const stagedChange = staged[paramId];
  const pendingCode = stagedChange?.stagedValue ?? null;
  const modified = pendingCode !== null && pendingCode !== currentCode;

  const { options, metadataBased } = optionsFor(entry, fallback);

  return {
    paramId,
    supportLabel,
    currentCode,
    currentLabel: labelFor(entry, fallback, currentCode),
    pendingCode,
    pendingLabel: labelFor(entry, fallback, pendingCode),
    modified,
    hasMetadata: !!entry.metadata && !entry.metadataMissing,
    rebootRequired: !!entry.metadata?.rebootRequired,
    options,
    metadataBased,
    supported: true,
  };
}

/** Full Frame / Airframe state derived from the live store. */
export function frameConfig(
  entries: ParamMap,
  staged: StagedMap
): FrameConfig {
  const classField = buildField(
    entries,
    staged,
    FRAME_CLASS_PARAM,
    FRAME_CLASS_FALLBACK,
    "Frame Class"
  );
  const typeField = buildField(
    entries,
    staged,
    FRAME_TYPE_PARAM,
    FRAME_TYPE_FALLBACK,
    "Frame Type"
  );

  const hasChanges = !!(classField?.modified || typeField?.modified);
  const stagedCount =
    (classField?.modified ? 1 : 0) + (typeField?.modified ? 1 : 0);

  const rebootPending =
    !!classField?.modified && !!classField.rebootRequired
      ? true
      : !!typeField?.modified && !!typeField.rebootRequired;

  return {
    classField,
    typeField,
    unsupported: !classField?.supported && !typeField?.supported,
    hasChanges,
    stagedCount,
    rebootPending,
    classLabelFor: (code) => frameClassLabel(entries[FRAME_CLASS_PARAM], code) ?? `Code ${code}`,
    typeLabelFor: (code) => frameTypeLabel(entries[FRAME_TYPE_PARAM], code) ?? `Code ${code}`,
  };
}

export interface FrameWriteResult {
  /** True when the write completed (possibly with per-item errors handled). */
  status: "success" | "partial_failure" | "interrupted" | "error";
  succeeded: number;
  failed: number;
  notAttempted: number;
  /** Per-param results for the frame fields only. */
  items: { paramId: string; status: string; verifiedValue: number | null; message: string | null }[];
}

const FRAME_IDS = [FRAME_CLASS_PARAM, FRAME_TYPE_PARAM];

/** Reduce a backend write transaction to the frame parameters only. */
export function frameWriteResult(
  transaction: WriteTransactionSummary | null | undefined
): FrameWriteResult | null {
  if (!transaction) return null;
  const items = transaction.results
    .filter((r) => FRAME_IDS.includes(r.paramId))
    .map((r) => ({
      paramId: r.paramId,
      status: r.status,
      verifiedValue: r.verifiedValue ?? null,
      message: r.message ?? null,
    }));
  return {
    status:
      transaction.status === "success"
        ? "success"
        : transaction.status === "partial_failure"
          ? "partial_failure"
          : transaction.status === "interrupted"
            ? "interrupted"
            : "error",
    succeeded: items.filter((i) => i.status === "success").length,
    failed: items.filter((i) => i.status === "failed").length,
    notAttempted: items.filter((i) => i.status === "not_attempted").length,
    items,
  };
}