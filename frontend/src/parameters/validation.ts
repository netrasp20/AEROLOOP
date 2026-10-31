/**
 * Parameter value validation (Phase 4).
 *
 * Pure, framework-free rules used before a user edit can become a *staged*
 * (modified) value. Validation never touches the vehicle — it only decides
 * whether an edited value may be staged locally.
 *
 * Rules consulted, in order:
 *   1. basic numeric validity (NaN / Infinity / non-numeric strings)
 *   2. MAVLink parameter type (integer parameters reject decimals)
 *   3. metadata min/max
 *   4. metadata increment (with float tolerance)
 *   5. enum definitions (only defined codes)
 *   6. bitmask definitions (non-negative integer)
 *
 * Returns `{ valid: true }` or `{ valid: false, code, message }`.
 */

import type { ParamEntry } from "../api/parameters";

export interface ValidationResult {
  valid: boolean;
  code?: string;
  message?: string;
}

export type ValidationCode =
  | "INVALID_NUMBER"
  | "NOT_INTEGER"
  | "OUT_OF_RANGE"
  | "BAD_INCREMENT"
  | "INVALID_ENUM"
  | "INVALID_BITMASK"
  | "EMPTY";

const EPSILON = 1e-6;

/** MAVLink parameter types that must hold whole numbers. */
const INTEGER_TYPES = new Set([
  "INT8",
  "INT16",
  "INT32",
  "UINT8",
  "UINT16",
  "UINT32",
]);

export function isIntegerType(type: string | null | undefined): boolean {
  return !!type && INTEGER_TYPES.has(type);
}

/** Parse a user-entered string into a finite number (or null). */
export function parseNumericInput(
  raw: string
): { value: number } | { error: string; code: ValidationCode } {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { error: "Enter a value.", code: "EMPTY" };
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value)) {
    return {
      error: "Value must be a real number.",
      code: value !== value ? "INVALID_NUMBER" : "INVALID_NUMBER",
    };
  }
  return { value };
}

/** NaN rejection (explicit) — used by tests and pre-checks. */
export function isRejectedNumber(value: number): boolean {
  return Number.isNaN(value);
}

/** (+/-)Infinity rejection (explicit). */
export function isRejectedInfinity(value: number): boolean {
  return !Number.isFinite(value);
}

/** Approximate fraction check with tolerance (avoids binary float noise). */
function isMultiple(base: number, step: number, candidate: number): boolean {
  const quotient = (candidate - base) / step;
  return Math.abs(quotient - Math.round(quotient)) < EPSILON;
}

export function isWholeNumber(value: number): boolean {
  return Number.isInteger(value);
}

/** Fractional-part tolerances: 1.5 fails, 2.0 passes. */
export function isIntegerValue(value: number): boolean {
  return isWholeNumber(value) || Math.abs(value - Math.round(value)) < EPSILON;
}

/**
 * Validate a candidate numeric value for staging against the parameter's
 * type + metadata. Returns a plain `ValidationResult`.
 */
export function validateStagedValue(
  entry: ParamEntry,
  value: number
): ValidationResult {
  const meta = entry.metadata;

  // 1. basic numeric validity
  if (Number.isNaN(value)) {
    return invalid("INVALID_NUMBER", "Value must be a real number.");
  }
  if (!Number.isFinite(value)) {
    return invalid("INVALID_NUMBER", "Value must be finite.");
  }

  // 2. integer type
  const type = entry.live?.type ?? null;
  if (isIntegerType(type) && !isIntegerValue(value)) {
    return invalid("NOT_INTEGER", "Value must be an integer.");
  }

  // 3. min / max
  if (meta && meta.min !== null && meta.min !== undefined && value < meta.min) {
    const bound =
      meta.max !== null && meta.max !== undefined
        ? `between ${meta.min} and ${meta.max}`
        : `at least ${meta.min}`;
    return invalid("OUT_OF_RANGE", `Value must be ${bound}.`);
  }
  if (meta && meta.max !== null && meta.max !== undefined && value > meta.max) {
    const bound =
      meta.min !== null && meta.min !== undefined
        ? `between ${meta.min} and ${meta.max}`
        : `at most ${meta.max}`;
    return invalid("OUT_OF_RANGE", `Value must be ${bound}.`);
  }

  // 4. increment (measured from the metadata min)
  if (
    meta &&
    meta.increment !== null &&
    meta.increment !== undefined &&
    meta.increment > 0 &&
    meta.min !== null &&
    meta.min !== undefined &&
    !isMultiple(meta.min, meta.increment, value)
  ) {
    return invalid(
      "BAD_INCREMENT",
      `Value must be a multiple of the increment ${meta.increment} (from ${meta.min}).`
    );
  }

  // 5. enum — only defined codes are acceptable
  if (meta && meta.values) {
    const allowed = Object.keys(meta.values).map((code) => Number(code));
    const matches =
      allowed.some((code) => Math.abs(code - value) < EPSILON) &&
      !Number.isNaN(value);
    if (!matches) {
      return invalid(
        "INVALID_ENUM",
        "Value is not one of the allowed options."
      );
    }
  }

  // 6. bitmask — non-negative integer
  if (meta && meta.bitmask && value < 0) {
    return invalid("INVALID_BITMASK", "Bitmask value cannot be negative.");
  }

  return { valid: true };
}

function invalid(code: ValidationCode, message: string): ValidationResult {
  return { valid: false, code, message };
}