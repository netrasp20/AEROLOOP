/**
 * Pure, framework-free parameter logic (Phase 3).
 *
 * Everything here is a plain function over `ParamEntry` rows so it can be
 * unit-tested without React/DOM. The store hook only orchestrates state +
 * socket events; all derived views (search, filters, groups, details
 * formatting) go through this module.
 */

import type {
  ConnectionState,
  ParamEntry,
  ParamMetadata,
} from "../api/parameters";

/* ------------------------------------------------------------------ */
/* Numeric comparison (Phase 4)                                        */
/* ------------------------------------------------------------------ */

const MAV_FLOAT_TYPES = new Set(["FLOAT", "REAL32", "DOUBLE", "REAL64"]);

export function isNumericType(type: string | null | undefined): boolean {
  return !!type && MAV_FLOAT_TYPES.has(type);
}

/**
 * Type-aware equality used for "did this value actually change?" decisions.
 * - integer parameters: compare normalized whole numbers
 * - REAL32/DOUBLE: compare after float32/double rounding (fround) so tiny
 *   representation noise does not create false Modified states
 * - anything else: exact comparison
 */
export function valuesEqual(
  a: number | null | undefined,
  b: number | null | undefined,
  type?: string | null
): boolean {
  if (a === null || a === undefined || b === null || b === undefined) {
    return a === b;
  }
  if (isNumericType(type) && type !== "DOUBLE" && type !== "REAL64") {
    return Math.fround(a) === Math.fround(b);
  }
  return a === b;
}

/** e.g. live 2.0 → staged 3.0 as "2 → 3". */
export function stagedRangeText(
  liveValue: number,
  stagedValue: number
): string {
  return `${formatNumber(liveValue)} → ${formatNumber(stagedValue)}`;
}

/* ------------------------------------------------------------------ */
/* Search                                                              */
/* ------------------------------------------------------------------ */

/**
 * Case-insensitive substring match on parameter id, friendly name and
 * description. Empty / whitespace queries match everything. Client-side
 * only — no per-keystroke HTTP.
 */
export function searchParams(
  entries: ParamEntry[],
  query: string
): ParamEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter((entry) => {
    if (entry.id.toLowerCase().includes(q)) return true;
    const meta = entry.metadata;
    if (!meta) return false;
    if (meta.name && meta.name.toLowerCase().includes(q)) return true;
    if (meta.description && meta.description.toLowerCase().includes(q)) return true;
    if (meta.group && meta.group.toLowerCase().includes(q)) return true;
    return false;
  });
}

/* ------------------------------------------------------------------ */
/* All / Standard / Advanced filter                                    */
/* ------------------------------------------------------------------ */

export type VisibilityLevel = "all" | "standard" | "advanced" | "modified";

function metadataLevel(meta?: ParamMetadata | null): VisibilityLevel {
  if (!meta) return "standard";
  return meta.advanced ? "advanced" : "standard";
}

/**
 * "standard" → every parameter with a Standard (or no) definition;
 * "advanced" → parameters explicitly tagged Advanced;
 * "modified" → parameters that have a staged change;
 * "all" → everything the vehicle exposes.
 */
export function filterByLevel(
  entries: ParamEntry[],
  level: VisibilityLevel,
  stagedIds?: ReadonlySet<string>
): ParamEntry[] {
  if (level === "all") return entries;
  if (level === "modified") {
    return stagedIds ? entries.filter((e) => stagedIds.has(e.id)) : [];
  }
  return entries.filter(
    (entry) => metadataLevel(entry.metadata) === level
  );
}

/* ------------------------------------------------------------------ */
/* Grouping                                                            */
/* ------------------------------------------------------------------ */

export interface ParamGroup {
  name: string;
  entries: ParamEntry[];
}

const UNGROUPED_LABEL = "Uncategorized";

/**
 * Group a filtered param set by its metadata group. Entries without a
 * definition fall into an "Uncategorized" bucket. Groups are derived from
 * the data — never hardcoded.
 */
export function buildGroups(entries: ParamEntry[]): ParamGroup[] {
  const buckets = new Map<string, ParamEntry[]>();
  for (const entry of entries) {
    const name = entry.metadata?.group || UNGROUPED_LABEL;
    const list = buckets.get(name);
    if (list) list.push(entry);
    else buckets.set(name, [entry]);
  }
  return [...buckets.entries()]
    .map(([name, list]) => ({ name, entries: list }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Flat list of every distinct group name across the given entries. */
export function groupNames(entries: ParamEntry[]): string[] {
  return buildGroups(entries).map((g) => g.name);
}

/* ------------------------------------------------------------------ */
/* Row / detail display helpers (read-only text rendering)             */
/* ------------------------------------------------------------------ */

export interface ParamRowView {
  id: string;
  name: string | null;
  description: string | null;
  value: number | null;
  valueText: string;
  units: string | null;
  unitText: string | null;
  type: string | null;
  group: string | null;
  advanced: boolean;
  hasMetadata: boolean;
  readOnly: boolean;
  rebootRequired: boolean;
  /** Phase 4 staged change info (undefined when the param is unmodified). */
  modified: boolean;
  stagedValue: number | null;
  conflict: boolean;
}

function displayUnits(meta?: ParamMetadata | null): string | null {
  return meta?.unitText || meta?.units || null;
}

/** Number -> string, trimming trailing zeros like Mission Planner values. */
export function formatNumber(value: number): string {
  if (Number.isInteger(value)) return value.toString();
  return String(parseFloat(value.toFixed(4)));
}

/** Render a live value with its units as text (view-only). */
export function formatValueText(
  entry: ParamEntry,
  withUnits = true
): string {
  const value = entry.live?.value ?? null;
  if (value === null || value === undefined) return "—";
  const units = withUnits ? displayUnits(entry.metadata) : null;
  return units ? `${formatNumber(value)} ${units}` : formatNumber(value);
}

export function toRowView(
  entry: ParamEntry,
  staged?: {
    stagedValue: number;
    conflict: boolean;
  } | null
): ParamRowView {
  const meta = entry.metadata;
  return {
    id: entry.id,
    name: meta?.name ?? null,
    description: meta?.description ?? null,
    value: entry.live?.value ?? null,
    valueText: formatValueText(entry),
    units: meta?.units ?? null,
    unitText: meta?.unitText ?? null,
    type: entry.live?.type ?? null,
    group: meta?.group ?? null,
    advanced: meta?.advanced ?? false,
    hasMetadata: !!meta,
    readOnly: meta?.readOnly ?? false,
    rebootRequired: meta?.rebootRequired ?? false,
    modified: !!staged,
    stagedValue: staged?.stagedValue ?? null,
    conflict: staged?.conflict ?? false,
  };
}

/* ------------------------------------------------------------------ */
/* Enumerated-value display (read-only)                                */
/* ------------------------------------------------------------------ */

export interface EnumLabel {
  code: number;
  label: string;
  codeText: string;
}

/** Sorted enum rows; labels keyed by numeric code. */
export function enumLabels(
  known: Record<string, string>,
  current: number | null | undefined
): { rows: EnumLabel[]; currentLabel: string | null; currentCode: string } {
  const rows = Object.entries(known)
    .map(([code, label]) => {
      const numeric = Number(code);
      return {
        code: Number.isFinite(numeric) ? numeric : code.length,
        label,
        codeText: code,
      };
    })
    .sort((a, b) => a.code - b.code);

  let currentLabel: string | null = null;
  let currentCode = "";
  if (current !== null && current !== undefined) {
    currentCode = formatNumber(current);
    currentLabel = known[currentCode] ?? known[String(Math.trunc(current))] ?? null;
  }
  return { rows, currentLabel, currentCode };
}

/* ------------------------------------------------------------------ */
/* Bitmask breakdown (read-only)                                       */
/* ------------------------------------------------------------------ */

export interface BitRow {
  bit: number;
  label: string;
  set: boolean;
}

export function bitmaskRows(
  known: Record<string, string>,
  value: number | null | undefined
): BitRow[] {
  const numeric = value ?? 0;
  return Object.entries(known)
    .map(([bit, label]) => {
      const n = Number(bit);
      return {
        bit: Number.isFinite(n) ? n : -1,
        label,
        set: Number.isFinite(n) && (numeric & (1 << n)) !== 0,
      };
    })
    .sort((a, b) => a.bit - b.bit);
}

export function bitmaskSummary(
  known: Record<string, string>,
  value: number | null | undefined
): string {
  const set = bitmaskRows(known, value)
    .filter((row) => row.set)
    .map((row) => row.label);
  return set.length ? set.join(", ") : "None";
}

/* ------------------------------------------------------------------ */
/* Range / increment text                                              */
/* ------------------------------------------------------------------ */

function fmt(n: number | null | undefined): string {
  return n === null || n === undefined ? "" : formatNumber(n);
}

export function rangeText(meta?: ParamMetadata | null): string | null {
  if (!meta || (meta.min === null && meta.max === null)) return null;
  if (meta.min === null) return `${fmt(meta.max)} max`;
  if (meta.max === null) return `${fmt(meta.min)} min`;
  return `${fmt(meta.min)} – ${fmt(meta.max)}`;
}

export function incrementText(meta?: ParamMetadata | null): string | null {
  if (!meta || meta.increment === null || meta.increment === undefined) return null;
  return formatNumber(meta.increment);
}

/* ------------------------------------------------------------------ */
/* Store-level helpers (pure)                                          */
/* ------------------------------------------------------------------ */

export type ParamMap = Record<string, ParamEntry>;

export function arrayToMap(entries: ParamEntry[]): ParamMap {
  const map: ParamMap = {};
  for (const entry of entries) map[entry.id] = entry;
  return map;
}

export function countParams(map: ParamMap): number {
  return Object.keys(map).length;
}

export function entriesOf(map: ParamMap): ParamEntry[] {
  return Object.values(map);
}

/** Apply a single authoritative `parameter:updated` value onto the map. */
export function mergeUpdated(
  map: ParamMap,
  id: string,
  value: number,
  type?: string | null
): ParamMap {
  const existing = map[id];
  if (!existing) return map;
  return {
    ...map,
    [id]: {
      ...existing,
      live: {
        ...(existing.live ?? { received: true }),
        value,
        type: type ?? existing.live?.type ?? null,
        receivedAt: Date.now() / 1000,
      },
    },
  };
}

export function mergeLiveIntoEntry(
  existing: ParamEntry | undefined,
  entry: ParamEntry
): ParamEntry {
  if (!existing) return entry;
  // Server merge wins for everything except a value we already have and the
  // server doesn't (e.g. during rehydrate it always has one; safe either way).
  return {
    ...entry,
    live: entry.live?.value !== undefined && entry.live.value !== null
      ? entry.live
      : existing.live ?? entry.live,
    metadata: entry.metadata ?? existing.metadata,
  };
}

export function sortById(entries: ParamEntry[]): ParamEntry[] {
  return [...entries].sort((a, b) => a.id.localeCompare(b.id));
}

/* ------------------------------------------------------------------ */
/* Connection-state presentation                                       */
/* ------------------------------------------------------------------ */

export interface ConnectionView {
  label: string;
  tone: "good" | "warn" | "bad" | "idle";
}

export function connectionView(state: ConnectionState): ConnectionView {
  switch (state) {
    case "READY":
      return { label: "READY", tone: "good" };
    case "SYNCING":
      return { label: "SYNCING", tone: "warn" };
    case "CONNECTING":
      return { label: "CONNECTING", tone: "warn" };
    case "ERROR":
      return { label: "ERROR", tone: "bad" };
    default:
      return { label: "NOT CONNECTED", tone: "idle" };
  }
}

export function progressRatio(received: number, expected: number): number {
  if (expected <= 0) return 0;
  return Math.min(1, received / expected);
}