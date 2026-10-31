import { beforeEach, describe, expect, it } from "vitest";

import { clearStaged, loadStaged, saveStaged } from "./stagedPersistence";

import type { StagedMap } from "./stagedLogic";

const STORAGE_KEY = "yantrayug.parameterStaged.v1";

function makeStaged(): StagedMap {
  return {
    WP_RADIUS_M: {
      paramId: "WP_RADIUS_M",
      originalValue: 2,
      liveValue: 2,
      stagedValue: 3,
      changedAt: 1234,
      conflict: false,
      conflictKind: "NONE",
    },
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("stagedPersistence", () => {
  it("round-trips staged edits through localStorage", () => {
    saveStaged(makeStaged());
    const restored = loadStaged();
    expect(restored["WP_RADIUS_M"]).toMatchObject({
      paramId: "WP_RADIUS_M",
      originalValue: 2,
      stagedValue: 3,
    });
    expect(restored["WP_RADIUS_M"].changedAt).toBe(1234);
    expect(restored["WP_RADIUS_M"].conflict).toBe(false);
  });

  it("stores only staged UI data, never writes live vehicle state", () => {
    saveStaged(makeStaged());
    const raw = window.localStorage.getItem(STORAGE_KEY);
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual({
      paramId: "WP_RADIUS_M",
      originalValue: 2,
      stagedValue: 3,
      changedAt: 1234,
    });
  });

  it("returns an empty map when nothing is stored", () => {
    expect(loadStaged()).toEqual({});
  });

  it("tolerates corrupt storage JSON", () => {
    window.localStorage.setItem(STORAGE_KEY, "not-json{{");
    expect(loadStaged()).toEqual({});
  });

  it("drops persisted entries whose staged value equals the baseline", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        {
          paramId: "WP_RADIUS_M",
          originalValue: 2,
          stagedValue: 2,
          changedAt: 1,
        },
      ])
    );
    expect(loadStaged()).toEqual({});
  });

  it("clearStaged removes the persisted key", () => {
    saveStaged(makeStaged());
    clearStaged();
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(loadStaged()).toEqual({});
  });
});