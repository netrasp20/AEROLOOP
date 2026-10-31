/* ------------------------------------------------------------------ */
/* GeoFence logic — ArduCopter fence parameter helpers                 */
/* ------------------------------------------------------------------ */

export const FENCE_TYPE_BITS = {
  ALT_MAX: 1 << 0,   // 1
  CIRCLE: 1 << 1,    // 2
  POLYGON: 1 << 2,   // 4
  ALT_MIN: 1 << 3,   // 8
} as const;

export type FenceTypeBit = keyof typeof FENCE_TYPE_BITS;

export interface FenceTypeOption {
  label: string;
  bit: number;
  param: FenceTypeBit;
}

export const FENCE_TYPE_OPTIONS: FenceTypeOption[] = [
  { label: "Maximum Altitude", bit: FENCE_TYPE_BITS.ALT_MAX, param: "ALT_MAX" },
  { label: "Circular Fence", bit: FENCE_TYPE_BITS.CIRCLE, param: "CIRCLE" },
  { label: "Polygon Fence", bit: FENCE_TYPE_BITS.POLYGON, param: "POLYGON" },
  { label: "Minimum Altitude", bit: FENCE_TYPE_BITS.ALT_MIN, param: "ALT_MIN" },
];

/** Decode a FENCE_TYPE bitmask into individual flags. */
export function decodeFenceType(value: number): Record<FenceTypeBit, boolean> {
  return {
    ALT_MAX: (value & FENCE_TYPE_BITS.ALT_MAX) !== 0,
    CIRCLE: (value & FENCE_TYPE_BITS.CIRCLE) !== 0,
    POLYGON: (value & FENCE_TYPE_BITS.POLYGON) !== 0,
    ALT_MIN: (value & FENCE_TYPE_BITS.ALT_MIN) !== 0,
  };
}

/** Encode individual flags back into a FENCE_TYPE bitmask. */
export function encodeFenceType(flags: Record<FenceTypeBit, boolean>): number {
  let mask = 0;
  if (flags.ALT_MAX) mask |= FENCE_TYPE_BITS.ALT_MAX;
  if (flags.CIRCLE) mask |= FENCE_TYPE_BITS.CIRCLE;
  if (flags.POLYGON) mask |= FENCE_TYPE_BITS.POLYGON;
  if (flags.ALT_MIN) mask |= FENCE_TYPE_BITS.ALT_MIN;
  return mask;
}

/** Fence breach action values (from ArduCopter metadata). */
export const FENCE_ACTIONS = [
  { value: 0, label: "Report Only" },
  { value: 1, label: "RTL or Land" },
  { value: 2, label: "Always Land" },
  { value: 3, label: "SmartRTL or RTL or Land" },
  { value: 4, label: "Brake or Land" },
  { value: 5, label: "SmartRTL or Land" },
] as const;

/** Parameters that belong on the CONFIG → GeoFence screen. */
export const GEOFENCE_PARAMS = [
  "FENCE_ENABLE",
  "FENCE_TYPE",
  "FENCE_ACTION",
  "FENCE_ALT_MAX",
  "FENCE_ALT_MIN",
  "FENCE_RADIUS",
  "FENCE_MARGIN",
  "FENCE_TOTAL",
  "FENCE_AUTOENABLE",
  "FENCE_MARGIN_XY",
  "FENCE_OPTIONS",
] as const;

export type GeofenceParamId = (typeof GEOFENCE_PARAMS)[number];

/** Read-only fence parameters (not user-editable via slider/input). */
export const READONLY_PARAMS: readonly string[] = ["FENCE_TOTAL"];

/** Check if the connected vehicle is a Copter type. */
export function isCopterVehicleType(
  vehicleType: string | null | undefined
): boolean {
  if (!vehicleType) return false;
  const vt = vehicleType.toUpperCase();
  return (
    vt.includes("QUAD") ||
    vt.includes("HEXA") ||
    vt.includes("OCTO") ||
    vt.includes("COAXIAL") ||
    vt === "HELICOPTER" ||
    vt === "TRI" ||
    vt === "SINGLE_ROTOR" ||
    vt === "TAILSITTER" ||
    vt === "COPTER"
  );
}
