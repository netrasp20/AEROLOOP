import { describe, expect, it } from "vitest";

import {
  isIntegerType,
  isIntegerValue,
  parseNumericInput,
  validateStagedValue,
} from "./validation";

import { entry, makeMetadata, sampleEntries } from "../test/fixtures";

const params = Object.fromEntries(
  sampleEntries().map((p) => [p.id, p])
);

const wpRadius = params["WP_RADIUS_M"]!;
const wpnavSpeed = params["WPNAV_SPEED"]!;
const frameType = params["FRAME_TYPE"]!;
const crmBalance = params["CRM_BALANCE"]!;

describe("isIntegerType / isIntegerValue", () => {
  it("classifies MAVLink integer types correctly", () => {
    expect(isIntegerType("INT32")).toBe(true);
    expect(isIntegerType("UINT16")).toBe(true);
    expect(isIntegerType("INT8")).toBe(true);
    expect(isIntegerType("FLOAT")).toBe(false);
    expect(isIntegerType(null)).toBe(false);
  });

  it("distinguishes whole numbers from fractions", () => {
    expect(isIntegerValue(3)).toBe(true);
    expect(isIntegerValue(3.0)).toBe(true);
    expect(isIntegerValue(3.1)).toBe(false);
    expect(isIntegerValue(-2)).toBe(true);
  });
});

describe("parseNumericInput", () => {
  it("parses valid numeric strings", () => {
    expect(parseNumericInput("  42 ")).toEqual({ value: 42 });
    expect(parseNumericInput("1.25")).toEqual({ value: 1.25 });
    expect(parseNumericInput("-0.5")).toEqual({ value: -0.5 });
  });

  it("rejects empty input", () => {
    expect((parseNumericInput("") as { code: string }).code).toBe("EMPTY");
    expect((parseNumericInput("   ") as { code: string }).code).toBe("EMPTY");
  });

  it("rejects non-numeric garbage", () => {
    expect((parseNumericInput("abc") as { code: string }).code).toBe(
      "INVALID_NUMBER"
    );
    expect((parseNumericInput("12x") as { code: string }).code).toBe(
      "INVALID_NUMBER"
    );
  });
});

describe("validateStagedValue — basic numerics", () => {
  it("rejects NaN explicitly", () => {
    expect(validateStagedValue(wpRadius, NaN).valid).toBe(false);
    expect(validateStagedValue(wpRadius, NaN).code).toBe("INVALID_NUMBER");
  });

  it("rejects +/-Infinity", () => {
    expect(validateStagedValue(wpRadius, Infinity).valid).toBe(false);
    expect(validateStagedValue(wpRadius, -Infinity).valid).toBe(false);
  });
});

describe("validateStagedValue — integer parameters", () => {
  it("rejects decimals for integer MAVLink types", () => {
    const result = validateStagedValue(wpnavSpeed, 1200.5);
    expect(result.valid).toBe(false);
    expect(result.code).toBe("NOT_INTEGER");
  });

  it("accepts whole numbers for integer MAVLink types", () => {
    expect(validateStagedValue(wpnavSpeed, 1200).valid).toBe(true);
    expect(validateStagedValue(wpnavSpeed, 1250).valid).toBe(true);
  });
});

describe("validateStagedValue — range", () => {
  it("rejects values below min / above max with a helpful message", () => {
    const low = validateStagedValue(wpRadius, -1);
    expect(low.valid).toBe(false);
    expect(low.code).toBe("OUT_OF_RANGE");
    expect(low.message).toContain("between 0 and 100");

    const high = validateStagedValue(wpRadius, 150);
    expect(high.valid).toBe(false);
    expect(high.code).toBe("OUT_OF_RANGE");
  });

  it("accepts boundary values", () => {
    expect(validateStagedValue(wpRadius, 0).valid).toBe(true);
    expect(validateStagedValue(wpRadius, 100).valid).toBe(true);
  });
});

describe("validateStagedValue — increment", () => {
  it("rejects values that are not multiples of the increment", () => {
    const result = validateStagedValue(wpRadius, 1.15); // increment 0.1
    expect(result.valid).toBe(false);
    expect(result.code).toBe("BAD_INCREMENT");
  });

  it("accepts values aligned with the increment", () => {
    expect(validateStagedValue(wpRadius, 1.1).valid).toBe(true);
    expect(validateStagedValue(wpRadius, 2).valid).toBe(true);
  });

  it("tolerates binary floating-point noise", () => {
    const noisy = 0.1 + 0.2; // 0.30000000000000004
    expect(validateStagedValue(wpRadius, noisy).valid).toBe(true);
  });
});

describe("validateStagedValue — enum", () => {
  it("accepts only defined enum codes", () => {
    expect(validateStagedValue(frameType, 0).valid).toBe(true);
    expect(validateStagedValue(frameType, 3).valid).toBe(true);
    const result = validateStagedValue(frameType, 99);
    expect(result.valid).toBe(false);
    expect(result.code).toBe("INVALID_ENUM");
  });
});

describe("validateStagedValue — bitmask", () => {
  it("rejects negative bitmask values (unspecified fields kept open)", () => {
    const open = makeMetadata({
      id: "CRM_BALANCE",
      bitmask: { "0": "Learn", "1": "Turn", "2": "Brake" },
      min: null,
      max: null,
    });
    const bare = entry({ id: "CRM_BALANCE", metadata: open });
    const result = validateStagedValue(bare, -1);
    expect(result.valid).toBe(false);
    expect(result.code).toBe("INVALID_BITMASK");
    expect(validateStagedValue(crmBalance, 5).valid).toBe(true);
  });
});

describe("validateStagedValue — happy path", () => {
  it("accepts a legitimate change", () => {
    expect(validateStagedValue(wpRadius, 2.5)).toEqual({ valid: true });
    expect(validateStagedValue(wpnavSpeed, 1000)).toEqual({ valid: true });
  });
});