/**
 * Staged (user-intent) parameter changes (Phase 4).
 *
 * The live store remains authoritative for LIVE values; this module only
 * tracks the user's local edit intent and the information needed to review
 * it before any (Phase 5) write:
 *
 *   originalValue — live value captured on the FIRST edit of a parameter
 *   liveValue     — most recent live value for that parameter
 *   stagedValue   — the user's current staged (edited) value
 *
 * Modified  ⇔  stagedValue differs from the baseline live value.
 * Principal rule: a staged value can never write, and live state is never
 * mutated by this module.
 */

import { valuesEqual } from "./parametersLogic";

import type { ParamEntry } from "../api/parameters";

/* ------------------------------------------------------------------ */
/* Model                                                               */
/* ------------------------------------------------------------------ */

export interface StagedChange {
  paramId: string;
  originalValue: number;
  liveValue: number;
  stagedValue: number;
  changedAt: number;
  /** True when the vehicle's live value drifted from the original while
      this staged edit exists. */
  conflict: boolean;
  /** The conflict reason (first class, stable). */
  conflictKind: ConflictKind;
}

export type ConflictKind =
  | "NONE"
  | "EXTERNAL_LIVE_CHANGE"
  | "SESSION_RECONNECT_CHANGE"
  | "PARAMETER_REMOVED";

export type StagedMap = Record<string, StagedChange>;

export interface StageResult {
  ok: boolean;
  error?: string;
  changed: boolean;
}

/* ------------------------------------------------------------------ */
/* Core operations (all pure)                                          */
/* ------------------------------------------------------------------ */

/**
 * Stage a validated value for `paramId`.
 *
 * - First edit: captures the current live value as `originalValue`.
 * - Later edits: keep `originalValue`, replace `stagedValue`.
 * - Editing back to the current live value removes the staged change.
 *
 * Returns a `StageResult` describing whether anything changed. Live state is
 * never touched; validation must have already happened via the validation
 * module.
 */
export function stageChange(
  staged: StagedMap,
  entry: ParamEntry,
  value: number,
  now = Date.now()
): { next: StagedMap; result: StageResult } {
  const id = entry.id;
  const liveValue = normalizeLive(entry.live?.value);
  const type = entry.live?.type ?? null;

  const existing = staged[id];
  const originalValue =
    existing === undefined ? liveValue : existing.originalValue;

  // Back to the baseline live value → not modified.
  if (valuesEqual(liveValue, value, type)) {
    if (existing === undefined) {
      return { next: staged, result: { ok: true, changed: false } };
    }
    const next = { ...staged };
    delete next[id];
    return { next, result: { ok: true, changed: true } };
  }

  if (existing !== undefined && valuesEqual(existing.stagedValue, value, type)) {
    return { next: staged, result: { ok: true, changed: false } };
  }

  const next: StagedMap = {
    ...staged,
    [id]: {
      paramId: id,
      originalValue,
      liveValue,
      stagedValue: value,
      changedAt: now,
      conflict: !valuesEqual(originalValue, liveValue, type),
      conflictKind: valuesEqual(originalValue, liveValue, type)
        ? "NONE"
        : "EXTERNAL_LIVE_CHANGE",
    },
  };
  return { next, result: { ok: true, changed: true } };
}

/** Remove one staged change. Live state untouched. */
export function revertStaged(
  staged: StagedMap,
  paramId: string
): { next: StagedMap; changed: boolean } {
  if (!(paramId in staged)) {
    return { next: staged, changed: false };
  }
  const next = { ...staged };
  delete next[paramId];
  return { next, changed: true };
}

/** Remove every staged change. Live state untouched. */
export function discardAllStaged(
  _staged: StagedMap
): { next: StagedMap; changed: boolean } {
  if (Object.keys(_staged).length === 0) {
    return { next: _staged, changed: false };
  }
  return { next: {}, changed: true };
}

export function modifiedCount(staged: StagedMap): number {
  return Object.keys(staged).length;
}

export function modifiedIds(staged: StagedMap): Set<string> {
  return new Set(Object.keys(staged));
}

/* ------------------------------------------------------------------ */
/* Reconcile with new/authoritative live state                         */
/* ------------------------------------------------------------------ */

/**
 * Reconcile staged changes against a freshly downloaded live map.
 *
 * - surviving parameter: refresh `liveValue`, recompute conflict
 * - vanished parameter: drop the staged change (nothing to write later)
 *
 * Staged values are NEVER overwritten here.
 */
export function reconcileStaged(
  staged: StagedMap,
  liveMap: Record<string, ParamEntry>
): StagedMap {
  const keys = Object.keys(staged);
  if (keys.length === 0) return staged;

  const next: StagedMap = {};

  for (const id of keys) {
    const entry = staged[id];
    const live = liveMap[id];
    if (!live) {
      continue; // parameter disappeared — drop staging
    }
    const liveValue = normalizeLive(live.live?.value);
    const type = live.live?.type ?? null;
    const conflict = !valuesEqual(entry.originalValue, liveValue, type);
    next[id] = {
      ...entry,
      liveValue,
      conflict,
      conflictKind: conflict ? "SESSION_RECONNECT_CHANGE" : "NONE",
    };
  }

  return Object.keys(next).length === keys.length ? next : next;
}

/* ------------------------------------------------------------------ */
/* Editor classification                                               */
/* ------------------------------------------------------------------ */

export type EditorKind = "enum" | "bitmask" | "numeric" | "readonly";

export function editorKindFor(entry: ParamEntry): EditorKind {
  const meta = entry.metadata;
  if (meta?.readOnly) return "readonly";
  if (meta?.values) return "enum";
  if (meta?.bitmask) return "bitmask";
  return "numeric";
}

function normalizeLive(value: number | null | undefined): number {
  return value === null || value === undefined || !Number.isFinite(value)
    ? 0
    : value;
}