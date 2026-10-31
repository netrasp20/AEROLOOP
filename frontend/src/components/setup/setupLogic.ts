/**
 * Setup summary presentation helpers (frontend view-model).
 *
 * Capability detection happens on the backend (`GET /api/setup/summary`),
 * which evaluates the live downloaded PARAM_VALUE set. This module keeps only
 * the pure view helpers: tone/count types and tallies for the Summary badge.
 */

import type { SetupCounts, SetupStatusItem, SetupTone } from "../../api/setup";

export type { SetupStatusItem, SetupTone };

/** Tone counts mirror the backend one-for-one (good/warn/unsupported/unknown/waiting). */
export type ConfigCounts = SetupCounts;

export function summarizeStatus(items: SetupStatusItem[]): ConfigCounts {
  const counts: ConfigCounts = { good: 0, warn: 0, unsupported: 0, unknown: 0, waiting: 0 };
  for (const item of items) {
    counts[item.tone] += 1;
  }
  return counts;
}

/**
 * Reduce raw counts to the SetupNav badge shape ({warn, bad}).
 * Only issues that need attention count — "unknown"/"waiting" mean the vehicle
 * is still resolving, never a configuration problem.
 */
export function summaryBadge(counts: ConfigCounts): { warn: number; bad: number } {
  return { warn: counts.warn, bad: counts.unsupported };
}