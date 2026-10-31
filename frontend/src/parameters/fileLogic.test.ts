import { describe, expect, it } from "vitest";

import {
  STAGED_MARKER,
  applySelected,
  buildExportContent,
  parseStagedMarkers,
  stagedNumbers,
  stripStagedMarkers,
} from "./fileLogic";

import type { StagedMap } from "./stagedLogic";
import type { ParamCompareRow } from "../api/parameters";

function stagedChange(
  paramId: string,
  stagedValue: number,
  originalValue = 2
): import("./stagedLogic").StagedChange {
  return {
    paramId,
    originalValue,
    liveValue: originalValue,
    stagedValue,
    changedAt: 1,
    conflict: false,
    conflictKind: "NONE",
  };
}

function row(overrides: Partial<ParamCompareRow>): ParamCompareRow {
  return {
    paramId: "A",
    category: "changed",
    vehicleValue: 2,
    fileValue: 5,
    stageable: true,
    stagedValue: null,
    stagedConflict: false,
    message: null,
    readOnly: false,
    group: null,
    rebootRequired: false,
    ...overrides,
  };
}

describe("fileLogic – staged export markers", () => {
  it("keeps an empty file comment-safe when nothing is staged", () => {
    const out = buildExportContent("A 1\nX 2\n", {});
    expect(out).toBe("A 1\nX 2\n");
    expect(out.includes(STAGED_MARKER.trim())).toBe(false);
  });

  it("appends a comment-marked block for staged values only", () => {
    const staged: StagedMap = {
      WPNAV_SPEED: stagedChange("WPNAV_SPEED", 2000),
    };
    const out = buildExportContent("WP_RADIUS_M 2\nWPNAV_SPEED 1200\n", staged);
    expect(out).toContain("# StagedValue: WPNAV_SPEED 2000");
    // real values keep a parseable line (no # prefix) — only the marker is a comment
    const paramLines = out
      .split("\n")
      .filter((l) => l.length && !l.trim().startsWith("#"));
    expect(paramLines).toEqual(["WP_RADIUS_M 2", "WPNAV_SPEED 1200"]);
  });

  it("reads markers back and ignores non-matching comments", () => {
    const out = buildExportContent("A 1\n", {
      WP_RADIUS_M: stagedChange("WP_RADIUS_M", 3),
    });
    const parsed = parseStagedMarkers(out);
    expect(parsed).toEqual([
      { paramId: "WP_RADIUS_M", value: 3, line: expect.any(Number) },
    ]);
    expect(parseStagedMarkers("# just a comment\n# StagedValue: BADNAME\n").length).toBe(0);
  });

  it("strips markers leaving a plain .param file", () => {
    const original = "A 1\nB 2\n";
    const out = buildExportContent(original, {
      B: stagedChange("B", 9),
    });
    expect(stripStagedMarkers(out)).toBe(original);
  });

  it("converts the store's staged map to a plain value map", () => {
    const staged: StagedMap = {
      A: stagedChange("A", 3),
      B: stagedChange("B", 4),
    };
    expect(stagedNumbers(staged)).toEqual({ A: 3, B: 4 });
  });
});

describe("fileLogic – applySelected", () => {
  it("stages only changed + stageable rows and reports the rest", () => {
    const stagedCalls: Array<[string, number]> = [];
    const result = applySelected(
      [
        row({ paramId: "A", category: "changed", fileValue: 5, stageable: true }),
        row({ paramId: "B", category: "same", stageable: false }),
        row({ paramId: "C", category: "unknown", stageable: false }),
        row({ paramId: "D", category: "read_only", readOnly: true, stageable: false }),
        row({
          paramId: "E",
          category: "changed",
          fileValue: 7,
          stageable: true,
        }),
      ],
      (paramId, value) => {
        stagedCalls.push([paramId, value]);
        return { ok: true, changed: true };
      }
    );

    expect(result.applied).toBe(2);
    expect(result.failed).toEqual([]);
    expect(result.skipped.map((s) => s.paramId).sort()).toEqual(["B", "C", "D"]);
    expect(stagedCalls).toEqual([
      ["A", 5],
      ["E", 7],
    ]);
  });

  it("reports validation failures per parameter", () => {
    const result = applySelected(
      [
        row({ paramId: "A", category: "changed", fileValue: 999, stageable: true }),
        row({ paramId: "B", category: "changed", fileValue: 4, stageable: true }),
      ],
      (paramId) =>
        paramId === "A"
          ? { ok: false, error: "Out of range.", changed: false }
          : { ok: true, changed: true }
    );

    expect(result.applied).toBe(1);
    expect(result.failed.map((f) => f.paramId)).toEqual(["A"]);
    expect(result.failed[0].reason).toContain("Out of range.");
  });
});