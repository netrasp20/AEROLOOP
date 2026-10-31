import { describe, expect, it } from "vitest";

import {
  arrayToMap,
  bitmaskRows,
  bitmaskSummary,
  buildGroups,
  connectionView,
  countParams,
  enumLabels,
  entriesOf,
  filterByLevel,
  formatNumber,
  formatValueText,
  groupNames,
  incrementText,
  mergeUpdated,
  progressRatio,
  rangeText,
  searchParams,
  sortById,
  stagedRangeText,
  toRowView,
  valuesEqual,
} from "./parametersLogic";

import { entry, makeMetadata, sampleEntries } from "../test/fixtures";

const params = sampleEntries();

describe("valuesEqual (Phase 4 type-aware equality)", () => {
  it("compares REAL32 values with float32 rounding to ignore representation noise", () => {
    expect(valuesEqual(0.1 + 0.2, 0.3, "FLOAT")).toBe(true);
    // 2.5 vs 2.0 are both exactly representable in float32 and clearly differ.
    expect(valuesEqual(2.5, 2, "FLOAT")).toBe(false);
  });

  it("compares integer parameters exactly", () => {
    expect(valuesEqual(2, 2.0, "INT32")).toBe(true);
    expect(valuesEqual(2, 3, "INT32")).toBe(false);
  });

  it("treats null/undefined consistently", () => {
    expect(valuesEqual(null, null)).toBe(true);
    expect(valuesEqual(2, null)).toBe(false);
    expect(valuesEqual(undefined, undefined)).toBe(true);
  });
});

describe("stagedRangeText", () => {
  it("renders live → staged as text", () => {
    expect(stagedRangeText(2, 3)).toBe("2 → 3");
    expect(stagedRangeText(2.5, 3.25)).toBe("2.5 → 3.25");
  });
});

describe("filterByLevel modified", () => {
  it("returns only staged ids when provided", () => {
    const stagedIds = new Set(["FRAME_TYPE", "CRM_BALANCE"]);
    const ids = filterByLevel(params, "modified", stagedIds).map((p) => p.id);
    expect(ids.sort()).toEqual(["CRM_BALANCE", "FRAME_TYPE"]);
  });

  it("returns nothing when no staged ids are given", () => {
    expect(filterByLevel(params, "modified")).toEqual([]);
    expect(filterByLevel(params, "modified", new Set())).toEqual([]);
  });
});

describe("toRowView staged", () => {
  it("marks modified rows and carries staged/conflict info", () => {
    const row = toRowView(entry(), { stagedValue: 3, conflict: false });
    expect(row.modified).toBe(true);
    expect(row.stagedValue).toBe(3);
    expect(row.conflict).toBe(false);

    const plain = toRowView(entry());
    expect(plain.modified).toBe(false);
    expect(plain.stagedValue).toBeNull();
    expect(plain.conflict).toBe(false);
  });
});

describe("searchParams", () => {
  it("matches parameter ids case-insensitively", () => {
    const result = searchParams(params, "wp_radius");
    expect(result.map((p) => p.id)).toEqual(["WP_RADIUS_M"]);
  });

  it("matches friendly names and descriptions", () => {
    expect(searchParams(params, "maximum speed").map((p) => p.id)).toEqual([
      "WPNAV_SPEED",
    ]);
    expect(searchParams(params, "virtual boundary").map((p) => p.id)).toEqual([
      "FENCE_ENABLE",
    ]);
  });

  it("returns every parameter for an empty or whitespace query", () => {
    expect(searchParams(params, "  ")).toHaveLength(params.length);
    expect(searchParams(params, "")).toHaveLength(params.length);
  });

  it("returns nothing for a miss", () => {
    expect(searchParams(params, "zzz_nope")).toEqual([]);
  });

  it("never performs a fetch and is a pure function", () => {
    const before = params.map((p) => p.id);
    searchParams(params, "frame");
    expect(params.map((p) => p.id)).toEqual(before);
  });
});

describe("filterByLevel", () => {
  it("all returns every parameter", () => {
    expect(filterByLevel(params, "all")).toHaveLength(params.length);
  });

  it("standard hides Advanced params but keeps metadata-less ones", () => {
    const standard = filterByLevel(params, "standard").map((p) => p.id);
    expect(standard).toContain("WP_RADIUS_M");
    expect(standard).toContain("SCR_USER1");
    expect(standard).not.toContain("FS_THR_ENABLE");
  });

  it("advanced returns only metadata-tagged advanced params", () => {
    const advanced = filterByLevel(params, "advanced").map((p) => p.id);
    expect(advanced.sort()).toEqual(["CRM_BALANCE", "FS_THR_ENABLE"]);
  });
});

describe("buildGroups", () => {
  it("derives groups from metadata and buckets metadata-less params", () => {
    const groups = buildGroups(filterByLevel(params, "all"));
    const names = groups.map((g) => g.name);
    expect(names).toContain("Waypoints");
    expect(names).toContain("FailSafe");
    expect(names).toContain("Uncategorized");
    expect(names).toEqual([...names].sort());
    const wp = groups.find((g) => g.name === "Waypoints")!;
    expect(wp.entries.map((p) => p.id)).toEqual(["WP_RADIUS_M"]);
  });

  it("groupNames is unique and derived, never hardcoded", () => {
    expect(groupNames(params)).toEqual(expect.arrayContaining(["GeoFence", "Wheel"]));
  });
});

describe("formatNumber / formatValueText", () => {
  it("trims trailing zeros like Mission Planner", () => {
    expect(formatNumber(2)).toBe("2");
    expect(formatNumber(2.5)).toBe("2.5");
    expect(formatNumber(3.141592)).toBe("3.1416");
  });

  it("renders live value with metadata units", () => {
    expect(formatValueText(entry())).toBe("2 m");
  });

  it("renders nothing for a missing live value", () => {
    expect(
      formatValueText(entry({ live: { received: false } }))
    ).toBe("—");
  });
});

describe("toRowView", () => {
  it("maps id, name, value text, units, type, advanced and flags", () => {
    const row = toRowView(
      entry({
        id: "FS_THR_ENABLE",
        metadata: makeMetadata({
          id: "FS_THR_ENABLE",
          name: "Throttle Failsafe",
          user: "Advanced",
          advanced: true,
          group: "FailSafe",
        }),
      })
    );
    expect(row.id).toBe("FS_THR_ENABLE");
    expect(row.value).toBe(2);
    expect(row.name).toBe("Throttle Failsafe");
    expect(row.advanced).toBe(true);
    expect(row.group).toBe("FailSafe");

    const plain = toRowView(entry({ id: "SCR_USER1", metadata: null }));
    expect(plain.hasMetadata).toBe(false);
    expect(plain.advanced).toBe(false);
  });
});

describe("enumLabels", () => {
  const known = { "0": "Disabled", "1": "Enabled", "2": "Enabled Continuous" };

  it("sorts numerically and resolves the current label", () => {
    const { rows, currentLabel, currentCode } = enumLabels(known, 2);
    expect(rows.map((r) => r.code)).toEqual([0, 1, 2]);
    expect(currentLabel).toBe("Enabled Continuous");
    expect(currentCode).toBe("2");
    const selected = rows.find((r) => r.codeText === currentCode)!;
    expect(selected.label).toBe("Enabled Continuous");
  });

  it("falls back to the truncated code for float values", () => {
    expect(enumLabels(known, 2.5).currentLabel).toBe("Enabled Continuous");
  });

  it("resolves nothing when the value is unknown/null", () => {
    expect(enumLabels(known, null).currentLabel).toBeNull();
    expect(enumLabels(known, 99).currentLabel).toBeNull();
  });
});

describe("bitmaskRows / bitmaskSummary", () => {
  const known = { "0": "Learn", "1": "Turn", "2": "Brake" };

  it("computes which bits are set from the raw value", () => {
    const rows = bitmaskRows(known, 5);
    const set = rows.filter((r) => r.set).map((r) => r.label);
    expect(set).toEqual(["Learn", "Brake"]);
    expect(rows.find((r) => r.label === "Turn")!.set).toBe(false);
  });

  it("summarizes set labels and reports None when unset", () => {
    expect(bitmaskSummary(known, 5)).toBe("Learn, Brake");
    expect(bitmaskSummary(known, 0)).toBe("None");
    expect(bitmaskSummary(known, null)).toBe("None");
  });
});

describe("rangeText / incrementText", () => {
  it("formats a bounded range", () => {
    expect(rangeText(makeMetadata({ min: 0, max: 100 }))).toBe("0 – 100");
    expect(rangeText(makeMetadata({ min: 0, max: 100, increment: 0.1 }))).toBe(
      "0 – 100"
    );
  });

  it("handles open-ended ranges and missing metadata", () => {
    expect(rangeText(makeMetadata({ min: null, max: 8 }))).toBe("8 max");
    expect(rangeText(makeMetadata({ min: null, max: null }))).toBeNull();
    expect(rangeText(null)).toBeNull();
  });

  it("formats increment and omits it when absent", () => {
    expect(incrementText(makeMetadata({ increment: 0.1 }))).toBe("0.1");
    expect(incrementText(makeMetadata({ increment: null }))).toBeNull();
  });
});

describe("store helpers", () => {
  it("arrayToMap keys by param id and counts", () => {
    const map = arrayToMap(params);
    expect(map["FRAME_TYPE"]).toBeDefined();
    expect(countParams(map)).toBe(params.length);
    expect(entriesOf(map).length).toBe(params.length);
  });

  it("sortById orders deterministically by localeCompare", () => {
    const ids = sortById(params).map((p) => p.id);
    const expected = [...params.map((p) => p.id)].sort((a, b) =>
      a.localeCompare(b)
    );
    expect(ids).toEqual(expected);
  });

  it("mergeUpdated applies a single authoritative value", () => {
    const map = arrayToMap(params);
    const next = mergeUpdated(map, "WP_RADIUS_M", 5.5, "FLOAT");
    expect(next["WP_RADIUS_M"].live!.value).toBe(5.5);
    expect(next["FRAME_TYPE"].live!.value).toBe(0);
    expect(Object.keys(next)).toHaveLength(params.length);
  });

  it("mergeUpdated ignores unknown ids", () => {
    const map = arrayToMap(params);
    expect(mergeUpdated(map, "NOPE", 1)).toBe(map);
  });
});

describe("presentation helpers", () => {
  it("connectionView maps each state to a label and tone", () => {
    expect(connectionView("READY")).toEqual({ label: "READY", tone: "good" });
    expect(connectionView("SYNCING")).toEqual({ label: "SYNCING", tone: "warn" });
    expect(connectionView("CONNECTING")).toEqual({ label: "CONNECTING", tone: "warn" });
    expect(connectionView("ERROR")).toEqual({ label: "ERROR", tone: "bad" });
    expect(connectionView("DISCONNECTED")).toEqual({
      label: "NOT CONNECTED",
      tone: "idle",
    });
  });

  it("progressRatio clamps into [0, 1]", () => {
    expect(progressRatio(0, 0)).toBe(0);
    expect(progressRatio(7, 1379)).toBeCloseTo(7 / 1379);
    expect(progressRatio(2000, 1379)).toBe(1);
  });
});