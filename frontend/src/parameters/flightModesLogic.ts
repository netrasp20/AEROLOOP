/**
 * Flight Modes — ArduCopter-specific logic.
 *
 * Everything in this module is derived from the ArduPilot firmware itself, not
 * from QGroundControl and not from "16 RC channels = 16 positions":
 *
 *   - FLTMODE_CH          (ArduCopter/Parameters.cpp:187-192) selects ONE logical
 *     RC channel. Valid values are 0 (Disabled) and 5..15. Channels 1-4 are the
 *     core flight controls (roll/pitch/throttle/yaw) and 16 is rejected outright
 *     by RC_Channels::flight_mode_channel() (libraries/RC_Channel/
 *     RC_Channels.cpp:257-267, NUM_RC_CHANNELS == 16).
 *   - FLTMODE1..FLTMODE6  (ArduCopter/Parameters.cpp:150-185) are exactly six
 *     switch positions, held in one GARRAY array.
 *   - PWM -> position     is RC_Channel::read_6pos_switch()
 *     (libraries/RC_Channel/RC_Channel.cpp:614-641). The band edges are
 *     immutable firmware constants — there are no FLTMODE*_TRIM parameters.
 *   - mode code -> name   is Mode::Number (ArduCopter/mode.h:77-109), which is
 *     identical to the @Values map the firmware advertises for FLTMODE1.
 *
 * A channel number is NOT a switch position and neither is a mode. The three
 * facts are kept strictly separate throughout.
 *
 * Research + audit: docs/FLIGHT_MODE_GCS_RESEARCH.md
 */

import type { ParamEntry } from "../api/parameters";

/* ------------------------------------------------------------------ */
/* Channel model — FLTMODE_CH valid values                             */
/* ------------------------------------------------------------------ */

export const FLTMODE_CH_PARAM = "FLTMODE_CH";

/** FLTMODE_CH == 0 means the autopilot monitors no flight-mode channel. */
export const FM_CHANNEL_DISABLED = 0;

/**
 * ArduPilot's own @Values enum for FLTMODE_CH:
 *   0:Disabled, 5:Channel5 ... 15:Channel15
 * Channels 1-4 (roll/pitch/throttle/yaw) and 16 (>= NUM_RC_CHANNELS) are
 * deliberately absent — the firmware cannot use them as a mode channel.
 */
export const FM_CHANNEL_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: FM_CHANNEL_DISABLED, label: "Disabled" },
  ...Array.from({ length: 11 }, (_, i) => i + 5).map((ch) => ({
    value: ch,
    label: `Channel ${ch}`,
  })),
];

export function isValidModeChannel(value: number): boolean {
  return FM_CHANNEL_OPTIONS.some((o) => o.value === value);
}

/** Human label for a FLTMODE_CH value, or null when the firmware rejects it. */
export function channelLabel(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const opt = FM_CHANNEL_OPTIONS.find((o) => o.value === value);
  return opt ? opt.label : null;
}

/* ------------------------------------------------------------------ */
/* Position model — six FLTMODE slots with firmware PWM bands         */
/* ------------------------------------------------------------------ */

/** RC_Channel.h:476-478 — PWM outside this span is an error condition. */
export const RC_PWM_MIN_LIMIT = 800;
export const RC_PWM_MAX_LIMIT = 2200;

export interface FmSlot {
  /** 1-based switch position. */
  index: number;
  paramId: string;
  label: string;
  /** Inclusive lower PWM bound in microseconds (null for the open-ended slot 1). */
  pwmMin: number | null;
  /** Inclusive upper PWM bound in microseconds (null for the open-ended slot 6). */
  pwmMax: number | null;
  /** Typical transmitter PWM for this position, per the ArduPilot wiki. */
  nominalPwm: number;
  /** Text form of the firmware band, e.g. "1231 – 1360". */
  pwmRange: string;
}

/**
 * Bands mirror read_6pos_switch() exactly:
 *   <1231 ->0, <1361 ->1, <1491 ->2, <1621 ->3, <1750 ->4, else 5
 */
export const FM_SLOTS: readonly FmSlot[] = [
  { index: 1, paramId: "FLTMODE1", label: "Mode 1", pwmMin: null, pwmMax: 1230, nominalPwm: 1165, pwmRange: "≤ 1230" },
  { index: 2, paramId: "FLTMODE2", label: "Mode 2", pwmMin: 1231, pwmMax: 1360, nominalPwm: 1295, pwmRange: "1231 – 1360" },
  { index: 3, paramId: "FLTMODE3", label: "Mode 3", pwmMin: 1361, pwmMax: 1490, nominalPwm: 1425, pwmRange: "1361 – 1490" },
  { index: 4, paramId: "FLTMODE4", label: "Mode 4", pwmMin: 1491, pwmMax: 1620, nominalPwm: 1555, pwmRange: "1491 – 1620" },
  { index: 5, paramId: "FLTMODE5", label: "Mode 5", pwmMin: 1621, pwmMax: 1749, nominalPwm: 1685, pwmRange: "1621 – 1749" },
  { index: 6, paramId: "FLTMODE6", label: "Mode 6", pwmMin: 1750, pwmMax: null, nominalPwm: 1815, pwmRange: "≥ 1750" },
];

export const FM_SLOT_COUNT = FM_SLOTS.length;

/* ------------------------------------------------------------------ */
/* Mode list                                                            */
/* ------------------------------------------------------------------ */

export interface FmMode {
  value: number;
  name: string;
}

/**
 * ArduCopter Mode::Number (ArduCopter/mode.h:77-109) — identical to the @Values
 * map advertised for FLTMODE1 (ArduCopter/Parameters.cpp:153). Used only when
 * the vehicle's own metadata is unavailable.
 *
 * Codes 8, 10 and 12 do not exist. 30/127 are reserved for offboard / Skybrush
 * and are intentionally absent.
 */
const COPTER_MODE_FALLBACK: readonly FmMode[] = [
  { value: 0, name: "Stabilize" },
  { value: 1, name: "Acro" },
  { value: 2, name: "AltHold" },
  { value: 3, name: "Auto" },
  { value: 4, name: "Guided" },
  { value: 5, name: "Loiter" },
  { value: 6, name: "RTL" },
  { value: 7, name: "Circle" },
  { value: 9, name: "Land" },
  { value: 11, name: "Drift" },
  { value: 13, name: "Sport" },
  { value: 14, name: "Flip" },
  { value: 15, name: "AutoTune" },
  { value: 16, name: "PosHold" },
  { value: 17, name: "Brake" },
  { value: 18, name: "Throw" },
  { value: 19, name: "Avoid_ADSB" },
  { value: 20, name: "Guided_NoGPS" },
  { value: 21, name: "Smart_RTL" },
  { value: 22, name: "FlowHold" },
  { value: 23, name: "Follow" },
  { value: 24, name: "ZigZag" },
  { value: 25, name: "SystemID" },
  { value: 26, name: "Heli_Autorotate" },
  { value: 27, name: "Auto RTL" },
  { value: 28, name: "Turtle" },
];

/** Extract the mode enum from a FLTMODE parameter's metadata values map. */
function modeEnumFromMetadata(
  entry: ParamEntry | undefined
): FmMode[] | null {
  const values = entry?.metadata?.values;
  if (!values || Object.keys(values).length === 0) return null;
  const modes = Object.entries(values)
    .map(([code, label]) => ({ value: Number(code), name: String(label) }))
    .filter((m) => Number.isFinite(m.value));
  if (modes.length === 0) return null;
  return modes.sort((a, b) => a.value - b.value);
}

/**
 * Available Copter modes for the FLTMODE1..6 dropdowns.
 *
 * Prefers the vehicle's own advertised metadata so the list stays correct across
 * firmware versions; falls back to the firmware's Mode::Number table.
 */
export function getCopterModes(entries: Record<string, ParamEntry>): FmMode[] {
  const fromMeta = modeEnumFromMetadata(entries["FLTMODE1"]);
  return fromMeta ?? [...COPTER_MODE_FALLBACK];
}

/** True when the mode list came from the vehicle rather than the fallback. */
export function modesFromVehicleMetadata(
  entries: Record<string, ParamEntry>
): boolean {
  return modeEnumFromMetadata(entries["FLTMODE1"]) !== null;
}

/** Look up a numeric mode value → display name. */
export function modeName(value: number | null | undefined, modes: FmMode[]): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const found = modes.find((m) => m.value === value);
  return found?.name ?? `Mode ${value}`;
}

/** Look up a display name → numeric value. Returns undefined if not found. */
export function modeValue(name: string, modes: FmMode[]): number | undefined {
  return modes.find((m) => m.name === name)?.value;
}

/* ------------------------------------------------------------------ */
/* Firmware support detection                                           */
/* ------------------------------------------------------------------ */

/**
 * Firmware without FLTMODE1..6 / FLTMODE_CH is not unsupported Copter firmware
 * in general — it simply has no flight-mode switch configuration. Reported
 * explicitly instead of rendering an empty form.
 */
export function isFlightModeCapable(entries: Record<string, ParamEntry>): boolean {
  return FM_SLOTS.some((slot) => entries[slot.paramId] !== undefined) ||
    entries[FLTMODE_CH_PARAM] !== undefined;
}

/* ------------------------------------------------------------------ */
/* Live switch position                                                 */
/* ------------------------------------------------------------------ */

export type SwitchPositionState =
  | { kind: "DISABLED" }
  | { kind: "UNASSIGNED" }
  | { kind: "NO_CHANNEL_DATA"; channelCount: number }
  | { kind: "NO_RC_SIGNAL" }
  | { kind: "STALE"; ageMs: number }
  | { kind: "OUT_OF_RANGE"; pwm: number }
  | { kind: "OK"; position: 1 | 2 | 3 | 4 | 5 | 6; pwm: number };

export interface RcTelemetry {
  rcChannels?: number[] | null;
  rcChannelCount?: number | null;
  rcRssi?: number | null;
  rcReceivedAt?: number | null;
  rcSignal?: string | null;
}

export const RC_STALE_MS = 1000;

/**
 * Resolve the live switch position from the mode channel's PWM.
 *
 * Mirrors RC_Channel::read_6pos_switch() including its out-of-range guard: PWM at
 * or outside [800, 2200] makes the autopilot perform NO mode change, so no
 * position may be reported. The channel index is used directly because ArduPilot
 * applies RCMAP before populating RC_CHANNELS
 * (GCS_Common.cpp:2176 -> RC_Channels::get_radio_in()).
 */
export function resolveSwitchPosition(
  modeChannel: number | null | undefined,
  rc: RcTelemetry | null | undefined,
  nowMs: number
): SwitchPositionState {
  if (modeChannel === null || modeChannel === undefined) return { kind: "UNASSIGNED" };
  if (modeChannel === FM_CHANNEL_DISABLED) return { kind: "DISABLED" };
  if (!rc) return { kind: "NO_CHANNEL_DATA", channelCount: 0 };

  const channels = rc.rcChannels ?? [];
  const count = rc.rcChannelCount ?? channels.length;

  // ArduPilot reports rssi == 0 as "no valid RC link" (MAV_RSSI_MAX inverted).
  if ((rc.rcRssi ?? 0) <= 0) return { kind: "NO_RC_SIGNAL" };

  if (!channels.length) return { kind: "NO_CHANNEL_DATA", channelCount: 0 };

  const receivedAt = rc.rcReceivedAt ?? 0;
  if (!receivedAt) return { kind: "NO_CHANNEL_DATA", channelCount: count };
  const ageMs = nowMs - receivedAt * 1000;
  if (ageMs > RC_STALE_MS) return { kind: "STALE", ageMs: Math.round(ageMs) };

  // The mode channel must actually be present in the stream.
  if (modeChannel > count) return { kind: "NO_CHANNEL_DATA", channelCount: count };

  const pwm = channels[modeChannel - 1];
  if (pwm === undefined || pwm === null) {
    return { kind: "NO_CHANNEL_DATA", channelCount: count };
  }

  if (pwm <= RC_PWM_MIN_LIMIT || pwm >= RC_PWM_MAX_LIMIT) {
    return { kind: "OUT_OF_RANGE", pwm };
  }

  const slot = FM_SLOTS.find(
    (s) => (s.pwmMin === null || pwm >= s.pwmMin) && (s.pwmMax === null || pwm <= s.pwmMax)
  );
  if (!slot) return { kind: "OUT_OF_RANGE", pwm };

  return { kind: "OK", position: slot.index as 1 | 2 | 3 | 4 | 5 | 6, pwm };
}

/** Human text for a switch-position state. Never invents a position. */
export function switchPositionText(state: SwitchPositionState): string {
  switch (state.kind) {
    case "DISABLED":
      return "Disabled";
    case "UNASSIGNED":
      return "UNKNOWN";
    case "NO_CHANNEL_DATA":
      return state.channelCount > 0
        ? `NO DATA — ${state.channelCount} RC channels in stream, mode channel absent`
        : "WAITING_FOR_RC";
    case "NO_RC_SIGNAL":
      return "NO_SIGNAL";
    case "STALE":
      return `STALE — last RC frame ${state.ageMs} ms ago`;
    case "OUT_OF_RANGE":
      return `OUT OF RANGE (${state.pwm} µs) — autopilot holds current mode`;
    case "OK":
      return `Position ${state.position}`;
  }
}

/* ------------------------------------------------------------------ */
/* Active mode                                                          */
/* ------------------------------------------------------------------ */

/**
 * Resolve the active mode name from the raw HEARTBEAT.custom_mode code using the
 * vehicle's own advertised metadata.
 *
 * Never derived from a dropdown selection, so an unsaved staged edit can never
 * make the UI claim a mode is active. An unknown code is surfaced verbatim rather
 * than guessed at.
 */
export function activeModeName(
  modeCode: number | null | undefined,
  entries: Record<string, ParamEntry>,
  modes: FmMode[]
): string | null {
  if (modeCode === null || modeCode === undefined || !Number.isFinite(modeCode)) {
    return null;
  }
  return modeName(modeCode, modes);
}

/** Mode code currently assigned to a switch position, or null when unknown. */
export function slotModeCode(
  slot: FmSlot,
  entries: Record<string, ParamEntry>
): number | null {
  const value = entries[slot.paramId]?.live?.value;
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return value;
}

/**
 * Which switch position the active mode corresponds to.
 *
 * Returns null when the mode is not assigned to any position, or when the same
 * mode is assigned to more than one position — in that case no single position
 * can be claimed to be the cause.
 */
export function positionForActiveMode(
  modeCode: number | null | undefined,
  entries: Record<string, ParamEntry>
): FmSlot | null {
  if (modeCode === null || modeCode === undefined || !Number.isFinite(modeCode)) {
    return null;
  }
  const matches = FM_SLOTS.filter((slot) => slotModeCode(slot, entries) === modeCode);
  return matches.length === 1 ? matches[0] : null;
}

/* ------------------------------------------------------------------ */
/* Vehicle gating                                                       */
/* ------------------------------------------------------------------ */

/**
 * Distinguish "definitely not a Copter" from "vehicle type not reported yet".
 * Conflating the two would show a misleading "only available for ArduCopter"
 * message on a perfectly valid Copter whose type string we have not matched.
 */
export type CopterGate = "COPTER" | "NOT_COPTER" | "UNKNOWN";

export function copterGate(vehicleType: string | null | undefined): CopterGate {
  if (!vehicleType) return "UNKNOWN";
  const vt = vehicleType.toUpperCase();
  if (vt === "UNKNOWN" || vt === "" || vt === "GENERIC") return "UNKNOWN";
  if (
    vt.includes("QUAD") ||
    vt.includes("HEXA") ||
    vt.includes("OCTO") ||
    vt.includes("TRI") ||
    vt.includes("HELI") ||
    vt.includes("COAX") ||
    vt.includes("VTOL")
  ) {
    return "COPTER";
  }
  return "NOT_COPTER";
}

/** @deprecated use {@link copterGate} */
export function isCopterVehicle(vehicleType: string | null | undefined): boolean {
  return copterGate(vehicleType) === "COPTER";
}