/**
 * Lightweight browser persistence for STAGED parameter changes only (Phase 4).
 *
 * Only user-intent (staged) edits are stored here — never live vehicle state,
 * which always comes from the backend after reload. This is deliberately NOT
 * parameter-file functionality (that belongs to a later phase).
 */

import type { StagedMap } from "./stagedLogic";

import { valuesEqual } from "./parametersLogic";

const STORAGE_KEY = "yantrayug.parameterStaged.v1";

export function saveStaged(staged: StagedMap): void {
  try {
    if (typeof window === "undefined") return;
    const payload = Object.values(staged).map((change) => ({
      paramId: change.paramId,
      originalValue: change.originalValue,
      stagedValue: change.stagedValue,
      changedAt: change.changedAt,
    }));
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* storage unavailable — staging still works for the session */
  }
}

export function loadStaged(): StagedMap {
  try {
    if (typeof window === "undefined") return {};
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Array<{
      paramId: string;
      originalValue: number;
      stagedValue: number;
      changedAt: number;
    }>;
    if (!Array.isArray(parsed)) return {};
    const map: StagedMap = {};
    for (const item of parsed) {
      if (
        !item ||
        typeof item.paramId !== "string" ||
        !Number.isFinite(item.stagedValue)
      ) {
        continue;
      }
      map[item.paramId] = {
        paramId: item.paramId,
        originalValue: Number.isFinite(item.originalValue)
          ? item.originalValue
          : item.stagedValue,
        stagedValue: item.stagedValue,
        liveValue: item.originalValue,
        changedAt: Number.isFinite(item.changedAt) ? item.changedAt : Date.now(),
        conflict: false,
        conflictKind: "NONE",
      };
    }
    // Drop entries that are actually equal to their baseline (shouldn't exist,
    // but be defensive about persisted junk).
    for (const [id, change] of Object.entries(map)) {
      if (valuesEqual(change.stagedValue, change.originalValue)) {
        delete map[id];
      }
    }
    return map;
  } catch {
    return {};
  }
}

export function clearStaged(): void {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}