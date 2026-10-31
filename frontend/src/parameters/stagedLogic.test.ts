import { describe, expect, it } from "vitest";

import {
  discardAllStaged,
  editorKindFor,
  modifiedCount,
  modifiedIds,
  reconcileStaged,
  revertStaged,
  stageChange,
} from "./stagedLogic";

import type { StagedMap } from "./stagedLogic";

import { arrayToMap } from "./parametersLogic";

import { entry, makeMetadata, sampleEntries } from "../test/fixtures";

const params = Object.fromEntries(
  sampleEntries().map((p) => [p.id, p])
);

const wp = params["WP_RADIUS_M"]!;
const speed = params["WPNAV_SPEED"]!;
const frame = params["FRAME_TYPE"]!;
const crm = params["CRM_BALANCE"]!;

describe("stageChange — first edit", () => {
  it("captures the live value as original on first edit", () => {
    const { next, result } = stageChange({}, wp, 3);
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    const change = next["WP_RADIUS_M"];
    expect(change).toMatchObject({
      paramId: "WP_RADIUS_M",
      originalValue: 2,
      liveValue: 2,
      stagedValue: 3,
      conflict: false,
      conflictKind: "NONE",
    });
  });

  it("never touches live state", () => {
    stageChange({}, wp, 3);
    expect(wp.live?.value).toBe(2);
  });
});

describe("stageChange — repeated edits", () => {
  it("keeps original value across 2 → 3 → 4 → 5 edits", () => {
    let staged: StagedMap = {};
    for (const value of [3, 4, 5]) {
      const r = stageChange(staged, wp, value);
      staged = r.next;
    }
    expect(staged["WP_RADIUS_M"].originalValue).toBe(2);
    expect(staged["WP_RADIUS_M"].stagedValue).toBe(5);
    expect(staged["WP_RADIUS_M"].liveValue).toBe(2);
  });

  it("no-ops when staged value is unchanged", () => {
    const first = stageChange({}, wp, 3).next;
    const { next, result } = stageChange(first, wp, 3);
    expect(result.changed).toBe(false);
    expect(next).toBe(first);
  });

  it("removes the modified state when the value returns to live", () => {
    const first = stageChange({}, wp, 3).next;
    const { next, result } = stageChange(first, wp, 2);
    expect(result.changed).toBe(true);
    expect(next["WP_RADIUS_M"]).toBeUndefined();
  });

  it("treats REAL32-representation noise as unchanged", () => {
    const noisy = entry({
      id: "NOISE_F",
      live: { value: 0.30000000000000004, type: "FLOAT", received: true },
    });
    const { result } = stageChange({}, noisy, 0.3);
    expect(result.changed).toBe(false);
  });

  it("treats integer 2 and 2.0 as equal on integer types", () => {
    const intEntry = entry({
      id: "INT_F",
      live: { value: 2, type: "INT32", received: true },
    });
    const { result } = stageChange({}, intEntry, 2.0);
    expect(result.changed).toBe(false);
  });
});

describe("revertStaged / discardAllStaged / counts", () => {
  it("reverts a single parameter", () => {
    const staged = stageChange(
      stageChange({}, wp, 3).next,
      frame,
      1
    ).next;
    const { next, changed } = revertStaged(staged, "FRAME_TYPE");
    expect(changed).toBe(true);
    expect(next["FRAME_TYPE"]).toBeUndefined();
    expect(next["WP_RADIUS_M"]).toBeDefined();
  });

  it("no-ops reverting an unmodified parameter", () => {
    const { changed, next } = revertStaged({}, "NOOP");
    expect(changed).toBe(false);
    expect(next).toEqual({});
  });

  it("discards all staged changes", () => {
    const staged = stageChange(
      stageChange({}, wp, 3).next,
      frame,
      1
    ).next;
    const { next, changed } = discardAllStaged(staged);
    expect(changed).toBe(true);
    expect(next).toEqual({});
  });

  it("modifiedCount counts parameters, not edits", () => {
    let staged = stageChange({}, wp, 3).next;
    staged = stageChange(staged, wp, 4).next;
    staged = stageChange(staged, frame, 1).next;
    expect(modifiedCount(staged)).toBe(2);
    expect(modifiedIds(staged)).toEqual(
      new Set(["WP_RADIUS_M", "FRAME_TYPE"])
    );
  });
});

describe("reconcileStaged", () => {
  it("refreshes liveValue and marks an external conflict without overwriting staged", () => {
    const staged = stageChange({}, wp, 3).next; // original 2, staged 3
    const liveMap = arrayToMap([
      entry({
        id: "WP_RADIUS_M",
        metadata: wp.metadata,
        live: { value: 2.5, type: "FLOAT", received: true },
      }),
    ]);

    const next = reconcileStaged(staged, liveMap);
    const change = next["WP_RADIUS_M"];
    expect(change.stagedValue).toBe(3); // user intent preserved
    expect(change.originalValue).toBe(2);
    expect(change.liveValue).toBe(2.5);
    expect(change.conflict).toBe(true);
    expect(change.conflictKind).toBe("SESSION_RECONNECT_CHANGE");
  });

  it("keeps staged changes when live matches original (no new conflict)", () => {
    const staged = stageChange({}, wp, 3).next;
    const liveMap = arrayToMap([
      entry({ id: "WP_RADIUS_M", metadata: wp.metadata }),
    ]);
    const next = reconcileStaged(staged, liveMap);
    expect(next).toEqual(staged);
  });

  it("drops staged changes for parameters that vanished from the vehicle", () => {
    const staged = stageChange({}, wp, 3).next;
    const next = reconcileStaged(staged, {});
    expect(next["WP_RADIUS_M"]).toBeUndefined();
  });

  it("is a no-op when nothing is staged", () => {
    const liveMap = arrayToMap(sampleEntries());
    expect(reconcileStaged({}, liveMap)).toEqual({});
  });
});

describe("editorKindFor", () => {
  it("classifies by metadata shape", () => {
    expect(editorKindFor(wp)).toBe("numeric");
    expect(editorKindFor(speed)).toBe("numeric");
    expect(editorKindFor(frame)).toBe("enum");
    expect(editorKindFor(crm)).toBe("bitmask");
    expect(
      editorKindFor(
        entry({
          id: "RO",
          metadata: makeMetadata({ id: "RO", readOnly: true }),
        })
      )
    ).toBe("readonly");
  });
});