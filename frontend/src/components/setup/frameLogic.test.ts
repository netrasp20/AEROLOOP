import { describe, expect, it } from "vitest";

import type { ParamEntry } from "../../api/parameters";
import type { ParamMap } from "../../parameters/parametersLogic";
import type { StagedMap } from "../../parameters/stagedLogic";
import { makeMetadata } from "../../test/fixtures";

import {
  frameConfig,
  frameWriteResult,
  frameClassLabel,
  frameTypeLabel,
  FRAME_CLASS_PARAM,
  FRAME_TYPE_PARAM,
} from "./frameLogic";

const COPTER_CLASS_VALUES = {
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
  "10": "BiCopter",
  "11": "Heli_Dual",
  "12": "DodecaHexa",
  "13": "HeliQuad",
  "14": "Deca",
};

const COPTER_TYPE_VALUES = {
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

function classEntry(overrides: Partial<ParamEntry> = {}): ParamEntry {
  return {
    id: FRAME_CLASS_PARAM,
    live: { value: 1, type: "UINT8", index: 1, count: 1379, received: true },
    metadata: makeMetadata({
      id: FRAME_CLASS_PARAM,
      name: "Frame Class",
      values: COPTER_CLASS_VALUES,
      rebootRequired: true,
      group: "ArduCopter",
      source: "copter.xml",
    }),
    metadataMissing: false,
    ...overrides,
  };
}

function typeEntry(overrides: Partial<ParamEntry> = {}): ParamEntry {
  return {
    id: FRAME_TYPE_PARAM,
    live: { value: 1, type: "UINT8", index: 2, count: 1379, received: true },
    metadata: makeMetadata({
      id: FRAME_TYPE_PARAM,
      name: "Frame Type",
      values: COPTER_TYPE_VALUES,
      rebootRequired: true,
      group: "ArduCopter",
      source: "copter.xml",
    }),
    metadataMissing: false,
    ...overrides,
  };
}

function map(entries: ParamEntry[]): ParamMap {
  return Object.fromEntries(entries.map((e) => [e.id, e]));
}

describe("frameConfig — metadata-driven options and current state", () => {
  it("builds class/type options from firmware metadata", () => {
    const config = frameConfig(map([classEntry(), typeEntry()]), {});
    expect(config.classField?.metadataBased).toBe(true);
    expect(config.classField?.options).toContainEqual({ code: 4, label: "OctaQuad" });
    expect(config.classField?.options).toContainEqual({ code: 9, label: "CoaxCopter" });
    expect(config.typeField?.options).toContainEqual({ code: 19, label: "Y4" });
  });

  it("uses the vehicle's live value as the current state, never a default", () => {
    const config = frameConfig(
      map([classEntry({ live: { value: 4, type: "UINT8", received: true } }), typeEntry()]),
      {}
    );
    expect(config.classField?.currentCode).toBe(4);
    expect(config.classField?.currentLabel).toBe("OctaQuad");
    expect(config.classField?.modified).toBe(false);
  });

  it("reports pending staged value distinct from current", () => {
    const staged: StagedMap = {
      [FRAME_CLASS_PARAM]: {
        paramId: FRAME_CLASS_PARAM,
        originalValue: 1,
        liveValue: 1,
        stagedValue: 2,
        changedAt: 1,
        conflict: false,
        conflictKind: "NONE",
      },
    };
    const config = frameConfig(map([classEntry(), typeEntry()]), staged);
    expect(config.classField?.pendingCode).toBe(2);
    expect(config.classField?.pendingLabel).toBe("Hexa");
    expect(config.classField?.modified).toBe(true);
    expect(config.hasChanges).toBe(true);
    expect(config.stagedCount).toBe(1);
  });

  it("detects reboot requirement from metadata for staged changes", () => {
    const staged: StagedMap = {
      [FRAME_CLASS_PARAM]: {
        paramId: FRAME_CLASS_PARAM,
        originalValue: 1,
        liveValue: 1,
        stagedValue: 2,
        changedAt: 1,
        conflict: false,
        conflictKind: "NONE",
      },
    };
    const config = frameConfig(map([classEntry(), typeEntry()]), staged);
    expect(config.rebootPending).toBe(true);
  });

  it("falls back to standard values when metadata is missing, and flags it", () => {
    const config = frameConfig(
      map([
        classEntry({ metadata: null, metadataMissing: true }),
        typeEntry({ metadata: null, metadataMissing: true }),
      ]),
      {}
    );
    expect(config.classField?.metadataBased).toBe(false);
    expect(config.classField?.options).toContainEqual({ code: 4, label: "OctaQuad" });
    expect(config.classField?.options).toContainEqual({ code: 8, label: "SingleCopter" });
    expect(config.typeField?.options).toContainEqual({ code: 19, label: "Y4" });
  });

  it("marks a missing FRAME_TYPE as unsupported without hiding FRAME_CLASS", () => {
    const config = frameConfig(map([classEntry()]), {});
    expect(config.typeField?.supported).toBe(false);
    expect(config.classField?.supported).toBe(true);
    expect(config.unsupported).toBe(false);
  });

  it("reports fully unsupported when neither parameter exists", () => {
    const config = frameConfig(map([]), {});
    expect(config.unsupported).toBe(true);
    expect(config.classField?.supported).toBe(false);
    expect(config.typeField?.supported).toBe(false);
  });
});

describe("decoders", () => {
  it("decodes class/type via metadata", () => {
    expect(frameClassLabel(classEntry(), 4)).toBe("OctaQuad");
    expect(frameTypeLabel(typeEntry(), 19)).toBe("Y4");
  });

  it("decodes via fallback when metadata absent", () => {
    expect(frameClassLabel(classEntry({ metadata: null, metadataMissing: true }), 8)).toBe("SingleCopter");
    expect(frameTypeLabel(typeEntry({ metadata: null, metadataMissing: true }), 1)).toBe("X");
  });

  it("labels unknown codes clearly", () => {
    expect(frameClassLabel(classEntry(), 999)).toBe("Code 999");
  });
});

describe("frameWriteResult — scoped write outcome", () => {
  const baseTxn = {
    transactionId: "t1",
    sessionId: "s1",
  };

  const frameResult = (status: "success" | "failed" | "not_attempted", verifiedValue: number | null = null) => ({
    paramId: FRAME_CLASS_PARAM,
    requestedValue: 1,
    originalValue: 1,
    status,
    code: status === "failed" ? "WRITE_MISMATCH" : null,
    verifiedValue,
    message: status === "failed" ? "Echo mismatch" : null,
  });

  it("maps a success transaction, filtered to frame params", () => {
    const result = frameWriteResult({
      ...baseTxn,
      total: 3,
      status: "success",
      succeeded: 2,
      failed: 0,
      notAttempted: 0,
      results: [
        { paramId: FRAME_CLASS_PARAM, requestedValue: 1, originalValue: 1, status: "success", verifiedValue: 4, code: null, message: null },
        { paramId: FRAME_TYPE_PARAM, requestedValue: 0, originalValue: 1, status: "success", verifiedValue: 1, code: null, message: null },
        { paramId: "WP_RADIUS", requestedValue: 5, originalValue: 5, status: "success", verifiedValue: 5, code: null, message: null },
      ],
    });
    expect(result?.status).toBe("success");
    expect(result?.succeeded).toBe(2);
    expect(result?.items).toHaveLength(2);
  });

  it("splits partial failure and keeps not_attempted visible", () => {
    const result = frameWriteResult({
      ...baseTxn,
      total: 3,
      status: "partial_failure",
      succeeded: 1,
      failed: 1,
      notAttempted: 1,
      results: [
        frameResult("success", 4),
        frameResult("failed"),
        { paramId: "WPNAV_SPEED", requestedValue: 50, originalValue: 50, status: "not_attempted", code: null, message: null },
      ],
    });
    expect(result?.status).toBe("partial_failure");
    expect(result?.failed).toBe(1);
    expect(result?.items[1].message).toBe("Echo mismatch");
  });

  it("returns null for a missing transaction", () => {
    expect(frameWriteResult(null)).toBeNull();
  });

  it("maps interrupted and error statuses", () => {
    expect(
      frameWriteResult({
        ...baseTxn,
        total: 2,
        status: "interrupted",
        succeeded: 0,
        failed: 0,
        notAttempted: 2,
        results: [],
      })?.status
    ).toBe("interrupted");
    expect(
      frameWriteResult({
        ...baseTxn,
        total: 1,
        status: "failed",
        succeeded: 0,
        failed: 0,
        notAttempted: 1,
        results: [],
      })?.status
    ).toBe("error");
  });
});