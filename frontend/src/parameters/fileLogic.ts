/**
 * Phase 6 — parameter-file helpers (pure).
 *
 * The backend owns parsing/validation/compare and always returns the
 * authoritative live snapshot for exports. This module only:
 *  - annotates saved files with the user's staged (not-yet-written) values
 *  - reads those annotations back so a freshly saved file still diffable
 *  - decides which compare rows are safe to stage and applies them
 */

import type { StagedChange, StagedMap } from "./stagedLogic";
import type { ParamCompareRow } from "../api/parameters";

export const STAGED_MARKER = "# StagedValue: ";

/** Convert the store's StagedMap into a plain {paramId: value} map. */
export function stagedNumbers(staged: StagedMap): Record<string, number> {
  const out: Record<string, number> = {};
  for (const change of Object.values(staged)) {
    out[change.paramId] = change.stagedValue;
  }
  return out;
}

/**
 * Append a clearly-marked block describing staged (not-yet-written) changes
 * to a saved file. The block is comment-safe: every line begins with '#'
 * so Mission Planner / ArduPilot ignore it when loading a real .param file.
 */
export function buildExportContent(
  content: string,
  staged: StagedMap
): string {
  const changes = Object.values(staged)
    .filter((c) => c.paramId && Number.isFinite(c.stagedValue))
    .sort((a, b) => a.paramId.localeCompare(b.paramId));
  if (changes.length === 0) return content;

  const lines = changes.map(
    (c) => `${STAGED_MARKER}${c.paramId} ${c.stagedValue}`
  );
  const block: string[] = [];
  block.push(
    "# STAGED: YantraYug Phase 6 — values below are staged locally, not yet written to the vehicle"
  );
  block.push(...lines);
  if (!content) return `${block.join("\n")}\n`;
  const sep = content.endsWith("\n") ? "" : "\n";
  return `${content}${sep}${block.join("\n")}\n`;
}

export interface StagedMarker {
  paramId: string;
  value: number;
  line: number;
}

/** Read "# StagedValue: PARAM value" annotations from a file back in. */
export function parseStagedMarkers(content: string): StagedMarker[] {
  const out: StagedMarker[] = [];
  const lines = content.split(/\r?\n/);
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (!line.startsWith(STAGED_MARKER.trim())) return;
    const body = line.slice(STAGED_MARKER.length).trim();
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s+(-?[\d.]+)$/.exec(body);
    if (!match) return;
    const value = Number(match[2]);
    if (Number.isFinite(value)) {
      out.push({ paramId: match[1], value, line: index + 1 });
    }
  });
  return out;
}

/** Remove the marker block so the remaining content is a plain .param file. */
export function stripStagedMarkers(content: string): string {
  return content
    .split(/\r?\n/)
    .filter(
      (line) =>
        !line.startsWith(STAGED_MARKER.trim()) &&
        !line.startsWith("# STAGED:")
    )
    .join("\n");
}

export interface ApplySelection {
  applied: number;
  skipped: Array<{ paramId: string; reason: string }>;
  failed: Array<{ paramId: string; reason: string }>;
}

/**
 * Stage every selectable (changed + stageable) row from a compare result.
 * Rows that are unchanged, read-only or unknown are reported as skipped and
 * never touched. Returns per-parameter outcomes for the UI review list.
 */
export function applySelected(
  rows: ParamCompareRow[],
  stageValue: (paramId: string, value: number) => {
    ok: boolean;
    error?: string;
    changed: boolean;
  }
): ApplySelection {
  const result: ApplySelection = { applied: 0, skipped: [], failed: [] };

  for (const row of rows) {
    if (!row.stageable) {
      result.skipped.push({
        paramId: row.paramId,
        reason: row.readOnly
          ? "Read-only parameter."
          : row.message ?? "Not stageable.",
      });
      continue;
    }
    if (row.category !== "changed") {
      result.skipped.push({
        paramId: row.paramId,
        reason:
          row.category === "unknown"
            ? "Not present on the vehicle."
            : row.category === "same"
              ? "Already matches the vehicle."
              : "Invalid value.",
      });
      continue;
    }
    const outcome = stageValue(row.paramId, row.fileValue);
    if (outcome.ok) {
      result.applied += 1;
    } else {
      result.failed.push({
        paramId: row.paramId,
        reason: outcome.error ?? "Could not stage value.",
      });
    }
  }

  return result;
}

/** Compact per-parameter summary for the apply-result panel. */
export function summarizeApply(
  result: ApplySelection,
  rows: ParamCompareRow[]
): { changed: number; skipped: number; failed: number } {
  const changed = rows.filter((r) => r.category === "changed" && r.stageable)
    .length;
  return {
    changed,
    skipped: result.skipped.length,
    failed: result.failed.length,
  };
}

export type { StagedChange };