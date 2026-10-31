import { useMemo, useState, useCallback } from "react";
import {
  Sliders,
  Save,
  Loader,
  AlertTriangle,
  Info,
  ChevronDown,
  ChevronRight,
  RotateCcw,
  X,
  Link,
  AlertCircle,
} from "lucide-react";

import { useParameters } from "../../context/ParameterContext";
import useSocketTelemetry from "../../hooks/useSocketTelemetry";
import { isCopterVehicle } from "../../parameters/flightModesLogic";

import "../../styles/extendedTuning.css";

/* ------------------------------------------------------------------ */
/* Parameter definitions — Mission Planner Extended Tuning (Copter)    */
/* ------------------------------------------------------------------ */

interface ParamDef {
  id: string;
  label: string;
  description: string;
  /** When Roll/Pitch lock is active, editing this param also stages its linked counterpart */
  linkedParam?: string;
}

interface SectionDef {
  id: string;
  label: string;
  params: ParamDef[];
}

const SECTIONS: SectionDef[] = [
  {
    id: "rate-roll",
    label: "Rate — Roll",
    params: [
      { id: "ATC_RAT_RLL_P", label: "Roll Rate P", description: "Proportional gain for roll rate controller", linkedParam: "ATC_RAT_PIT_P" },
      { id: "ATC_RAT_RLL_I", label: "Roll Rate I", description: "Integral gain for roll rate controller", linkedParam: "ATC_RAT_PIT_I" },
      { id: "ATC_RAT_RLL_D", label: "Roll Rate D", description: "Derivative gain for roll rate controller", linkedParam: "ATC_RAT_PIT_D" },
      { id: "ATC_RAT_RLL_FF", label: "Roll Rate FF", description: "Feed-forward gain for roll rate controller", linkedParam: "ATC_RAT_PIT_FF" },
      { id: "ATC_RAT_RLL_IMAX", label: "Roll Rate IMAX", description: "Maximum I-term output for roll rate", linkedParam: "ATC_RAT_PIT_IMAX" },
      { id: "ATC_RAT_RLL_FLTT", label: "Roll Rate FLTT", description: "Target filter frequency for roll rate (Hz)", linkedParam: "ATC_RAT_PIT_FLTT" },
      { id: "ATC_RAT_RLL_FLTE", label: "Roll Rate FLTE", description: "Error filter frequency for roll rate (Hz)", linkedParam: "ATC_RAT_PIT_FLTE" },
      { id: "ATC_RAT_RLL_FLTD", label: "Roll Rate FLTD", description: "Derivative filter frequency for roll rate (Hz)", linkedParam: "ATC_RAT_PIT_FLTD" },
    ],
  },
  {
    id: "rate-pitch",
    label: "Rate — Pitch",
    params: [
      { id: "ATC_RAT_PIT_P", label: "Pitch Rate P", description: "Proportional gain for pitch rate controller" },
      { id: "ATC_RAT_PIT_I", label: "Pitch Rate I", description: "Integral gain for pitch rate controller" },
      { id: "ATC_RAT_PIT_D", label: "Pitch Rate D", description: "Derivative gain for pitch rate controller" },
      { id: "ATC_RAT_PIT_FF", label: "Pitch Rate FF", description: "Feed-forward gain for pitch rate controller" },
      { id: "ATC_RAT_PIT_IMAX", label: "Pitch Rate IMAX", description: "Maximum I-term output for pitch rate" },
      { id: "ATC_RAT_PIT_FLTT", label: "Pitch Rate FLTT", description: "Target filter frequency for pitch rate (Hz)" },
      { id: "ATC_RAT_PIT_FLTE", label: "Pitch Rate FLTE", description: "Error filter frequency for pitch rate (Hz)" },
      { id: "ATC_RAT_PIT_FLTD", label: "Pitch Rate FLTD", description: "Derivative filter frequency for pitch rate (Hz)" },
    ],
  },
  {
    id: "rate-yaw",
    label: "Rate — Yaw",
    params: [
      { id: "ATC_RAT_YAW_P", label: "Yaw Rate P", description: "Proportional gain for yaw rate controller" },
      { id: "ATC_RAT_YAW_I", label: "Yaw Rate I", description: "Integral gain for yaw rate controller" },
      { id: "ATC_RAT_YAW_D", label: "Yaw Rate D", description: "Derivative gain for yaw rate controller" },
      { id: "ATC_RAT_YAW_FF", label: "Yaw Rate FF", description: "Feed-forward gain for yaw rate controller" },
      { id: "ATC_RAT_YAW_IMAX", label: "Yaw Rate IMAX", description: "Maximum I-term output for yaw rate" },
      { id: "ATC_RAT_YAW_FLTT", label: "Yaw Rate FLTT", description: "Target filter frequency for yaw rate (Hz)" },
      { id: "ATC_RAT_YAW_FLTE", label: "Yaw Rate FLTE", description: "Error filter frequency for yaw rate (Hz)" },
      { id: "ATC_RAT_YAW_FLTD", label: "Yaw Rate FLTD", description: "Derivative filter frequency for yaw rate (Hz)" },
    ],
  },
  {
    id: "angle",
    label: "Angle Control",
    params: [
      { id: "ATC_ANG_RLL_P", label: "Roll Angle P", description: "Angle P gain for roll stabilization", linkedParam: "ATC_ANG_PIT_P" },
      { id: "ATC_ANG_PIT_P", label: "Pitch Angle P", description: "Angle P gain for pitch stabilization" },
      { id: "ATC_ANG_YAW_P", label: "Yaw Angle P", description: "Angle P gain for yaw stabilization" },
    ],
  },
  {
    id: "throttle",
    label: "Throttle",
    params: [
      { id: "PSC_D_ACC_P", label: "Throttle Accel P", description: "Proportional gain for altitude acceleration controller" },
      { id: "PSC_D_ACC_I", label: "Throttle Accel I", description: "Integral gain for altitude acceleration controller" },
      { id: "PSC_D_ACC_D", label: "Throttle Accel D", description: "Derivative gain for altitude acceleration controller" },
      { id: "PSC_D_ACC_IMAX", label: "Throttle Accel IMAX", description: "Maximum I-term output for altitude acceleration" },
      { id: "PSC_D_VEL_P", label: "Throttle Velocity P", description: "Proportional gain for vertical velocity controller" },
      { id: "PSC_D_POS_P", label: "Throttle Position P", description: "Proportional gain for altitude position controller" },
    ],
  },
  {
    id: "loiter",
    label: "Loiter / Position",
    params: [
      { id: "PSC_NE_VEL_P", label: "Loiter Velocity P", description: "Proportional gain for horizontal velocity controller" },
      { id: "PSC_NE_VEL_I", label: "Loiter Velocity I", description: "Integral gain for horizontal velocity controller" },
      { id: "PSC_NE_VEL_D", label: "Loiter Velocity D", description: "Derivative gain for horizontal velocity controller" },
      { id: "PSC_NE_VEL_IMAX", label: "Loiter Velocity IMAX", description: "Maximum I-term output for horizontal velocity" },
    ],
  },
  {
    id: "accel",
    label: "Acceleration Limits",
    params: [
      { id: "ATC_ACC_R_MAX", label: "Roll Accel Max", description: "Maximum roll acceleration (deg/s/s)" },
      { id: "ATC_ACC_P_MAX", label: "Pitch Accel Max", description: "Maximum pitch acceleration (deg/s/s)" },
      { id: "ATC_ACC_Y_MAX", label: "Yaw Accel Max", description: "Maximum yaw acceleration (deg/s/s)" },
    ],
  },
  {
    id: "input",
    label: "Input Shaping",
    params: [
      { id: "ATC_INPUT_TC", label: "Input Time Constant", description: "Attitude control input time constant (s). Lower = more responsive." },
    ],
  },
  {
    id: "filters",
    label: "IMU Filters",
    params: [
      { id: "INS_GYRO_FILTER", label: "Gyro Filter", description: "Gyro low-pass filter frequency (Hz)" },
      { id: "INS_ACCEL_FILTER", label: "Accel Filter", description: "Accelerometer low-pass filter frequency (Hz)" },
    ],
  },
];

/* ------------------------------------------------------------------ */
/* Metadata helpers                                                    */
/* ------------------------------------------------------------------ */

interface MetaInfo {
  min?: number;
  max?: number;
  increment?: number;
  unit?: string;
  reboot?: boolean;
}

function getMeta(entry: ReturnType<typeof useParameters>["entries"][string]): MetaInfo {
  const m = entry?.metadata;
  if (!m) return {};
  return {
    min: m.min ?? undefined,
    max: m.max ?? undefined,
    increment: m.increment ?? undefined,
    unit: m.units ?? undefined,
    reboot: m.rebootRequired ?? undefined,
  };
}

const FALLBACK_RANGES: Record<string, { min: number; max: number; step: number; unit?: string }> = {
  ATC_RAT_RLL_P: { min: 0.01, max: 0.5, step: 0.005, unit: "s/rad" },
  ATC_RAT_RLL_I: { min: 0.01, max: 2.0, step: 0.01, unit: "1/rad" },
  ATC_RAT_RLL_D: { min: 0, max: 0.05, step: 0.001, unit: "s²/rad" },
  ATC_RAT_RLL_FF: { min: 0, max: 0.5, step: 0.005, unit: "s/rad" },
  ATC_RAT_RLL_IMAX: { min: 0, max: 1, step: 0.05 },
  ATC_RAT_RLL_FLTT: { min: 5, max: 100, step: 1, unit: "Hz" },
  ATC_RAT_RLL_FLTE: { min: 0, max: 100, step: 1, unit: "Hz" },
  ATC_RAT_RLL_FLTD: { min: 5, max: 100, step: 1, unit: "Hz" },
  ATC_RAT_PIT_P: { min: 0.01, max: 0.5, step: 0.005, unit: "s/rad" },
  ATC_RAT_PIT_I: { min: 0.01, max: 2.0, step: 0.01, unit: "1/rad" },
  ATC_RAT_PIT_D: { min: 0, max: 0.05, step: 0.001, unit: "s²/rad" },
  ATC_RAT_PIT_FF: { min: 0, max: 0.5, step: 0.005, unit: "s/rad" },
  ATC_RAT_PIT_IMAX: { min: 0, max: 1, step: 0.05 },
  ATC_RAT_PIT_FLTT: { min: 5, max: 100, step: 1, unit: "Hz" },
  ATC_RAT_PIT_FLTE: { min: 0, max: 100, step: 1, unit: "Hz" },
  ATC_RAT_PIT_FLTD: { min: 5, max: 100, step: 1, unit: "Hz" },
  ATC_RAT_YAW_P: { min: 0.1, max: 2.5, step: 0.01, unit: "s/rad" },
  ATC_RAT_YAW_I: { min: 0.01, max: 1.0, step: 0.005, unit: "1/rad" },
  ATC_RAT_YAW_D: { min: 0, max: 0.02, step: 0.001, unit: "s²/rad" },
  ATC_RAT_YAW_FF: { min: 0, max: 0.5, step: 0.005, unit: "s/rad" },
  ATC_RAT_YAW_IMAX: { min: 0, max: 1, step: 0.05 },
  ATC_RAT_YAW_FLTT: { min: 1, max: 50, step: 1, unit: "Hz" },
  ATC_RAT_YAW_FLTE: { min: 0, max: 20, step: 1, unit: "Hz" },
  ATC_RAT_YAW_FLTD: { min: 5, max: 50, step: 1, unit: "Hz" },
  ATC_ANG_RLL_P: { min: 3, max: 12, step: 0.1 },
  ATC_ANG_PIT_P: { min: 3, max: 12, step: 0.1 },
  ATC_ANG_YAW_P: { min: 3, max: 12, step: 0.1 },
  ATC_ACC_R_MAX: { min: 0, max: 1800, step: 10, unit: "deg/s/s" },
  ATC_ACC_P_MAX: { min: 0, max: 1800, step: 10, unit: "deg/s/s" },
  ATC_ACC_Y_MAX: { min: 0, max: 720, step: 10, unit: "deg/s/s" },
  ATC_INPUT_TC: { min: 0, max: 1, step: 0.01, unit: "s" },
  PSC_D_ACC_P: { min: 0.01, max: 0.25, step: 0.001 },
  PSC_D_ACC_I: { min: 0.01, max: 1.0, step: 0.01 },
  PSC_D_ACC_D: { min: 0, max: 0.02, step: 0.001 },
  PSC_D_ACC_IMAX: { min: 0, max: 5, step: 0.1 },
  PSC_D_VEL_P: { min: 1, max: 15, step: 0.1 },
  PSC_D_POS_P: { min: 0.5, max: 5, step: 0.05 },
  PSC_NE_VEL_P: { min: 0.5, max: 15, step: 0.1 },
  PSC_NE_VEL_I: { min: 0.01, max: 5, step: 0.05 },
  PSC_NE_VEL_D: { min: 0, max: 2, step: 0.01 },
  PSC_NE_VEL_IMAX: { min: 0, max: 45, step: 0.5 },
  INS_GYRO_FILTER: { min: 10, max: 100, step: 1, unit: "Hz" },
  INS_ACCEL_FILTER: { min: 10, max: 100, step: 1, unit: "Hz" },
};

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

function formatValue(v: number, step: number): string {
  if (step >= 1) return v.toFixed(0);
  if (step >= 0.1) return v.toFixed(1);
  if (step >= 0.01) return v.toFixed(2);
  return v.toFixed(3);
}

/* ------------------------------------------------------------------ */
/* Large-change threshold (Mission Planner: warns if value > 2× original) */
/* ------------------------------------------------------------------ */

const LARGE_CHANGE_FACTOR = 2;

function isLargeChange(newValue: number, originalValue: number): boolean {
  if (originalValue === 0) return newValue !== 0;
  return Math.abs(newValue) > Math.abs(originalValue) * LARGE_CHANGE_FACTOR;
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

export default function ExtendedTuning() {
  const store = useParameters();
  const telemetry = useSocketTelemetry();

  const connected = store.connection === "READY";
  const vehicleType = store.vehicleType ?? telemetry?.vehicleType ?? null;
  const isCopter = isCopterVehicle(vehicleType);

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [rollPitchLock, setRollPitchLock] = useState(true);
  const [largeChangeWarnings, setLargeChangeWarnings] = useState<Record<string, boolean>>({});

  /* ---- resolve effective values + metadata for all params ---- */
  const paramState = useMemo(() => {
    const result: Record<
      string,
      {
        live: number | null;
        staged: number | null;
        effective: number;
        isModified: boolean;
        min: number;
        max: number;
        step: number;
        unit: string;
        exists: boolean;
      }
    > = {};

    const allIds = SECTIONS.flatMap((s) => s.params.map((p) => p.id));

    for (const id of allIds) {
      const entry = store.entries[id];
      const stagedEntry = store.staged[id];
      const live = entry?.live?.value ?? null;
      const staged = stagedEntry?.stagedValue ?? null;
      const effective = staged ?? live ?? 0;
      const isModified = staged !== null && live !== null && staged !== live;

      const meta = getMeta(entry);
      const fb = FALLBACK_RANGES[id];

      result[id] = {
        live,
        staged,
        effective,
        isModified,
        min: meta.min ?? fb?.min ?? 0,
        max: meta.max ?? fb?.max ?? 100,
        step: meta.increment ?? fb?.step ?? 0.01,
        unit: meta.unit ?? fb?.unit ?? "",
        exists: !!entry,
      };
    }
    return result;
  }, [store.entries, store.staged]);

  /* ---- which params exist on the vehicle ---- */
  const availableSections = useMemo(() => {
    return SECTIONS.map((section) => ({
      ...section,
      params: section.params.filter((p) => paramState[p.id]?.exists),
    })).filter((section) => section.params.length > 0);
  }, [paramState]);

  /* ---- staged count ---- */
  const stagedCount = useMemo(() => {
    let count = 0;
    for (const section of SECTIONS) {
      for (const p of section.params) {
        if (store.staged[p.id] !== undefined) count++;
      }
    }
    return count;
  }, [store.staged]);

  const hasChanges = stagedCount > 0;

  /* ---- handlers ---- */
  const handleValueChange = useCallback(
    (paramId: string, rawValue: string) => {
      const num = parseFloat(rawValue);
      if (isNaN(num)) return;

      const liveVal = paramState[paramId]?.live;
      if (liveVal !== null && liveVal !== undefined && isLargeChange(num, liveVal)) {
        setLargeChangeWarnings((prev) => ({ ...prev, [paramId]: true }));
      } else {
        setLargeChangeWarnings((prev) => {
          const next = { ...prev };
          delete next[paramId];
          return next;
        });
      }

      store.stageValue(paramId, num);

      /* Roll/Pitch lock: mirror to linked param */
      if (rollPitchLock) {
        const section = SECTIONS.find((s) =>
          s.params.some((p) => p.id === paramId && p.linkedParam)
        );
        const paramDef = section?.params.find((p) => p.id === paramId);
        const linkedId = paramDef?.linkedParam;
        if (linkedId) {
          store.stageValue(linkedId, num);
          if (liveVal !== null && liveVal !== undefined && isLargeChange(num, liveVal)) {
            setLargeChangeWarnings((prev) => ({ ...prev, [linkedId]: true }));
          }
        }
      }
    },
    [rollPitchLock, paramState, store]
  );

  const handleRevert = useCallback(
    (paramId: string) => {
      store.revert(paramId);
      setLargeChangeWarnings((prev) => {
        const next = { ...prev };
        delete next[paramId];
        return next;
      });
    },
    [store]
  );

  const handleDiscardAll = useCallback(() => {
    for (const section of SECTIONS) {
      for (const p of section.params) {
        if (store.staged[p.id] !== undefined) {
          store.revert(p.id);
        }
      }
    }
    setLargeChangeWarnings({});
  }, [store]);

  const handleSave = useCallback(() => {
    store.executeWrite();
  }, [store]);

  const toggleSection = useCallback((sectionId: string) => {
    setCollapsed((prev) => ({ ...prev, [sectionId]: !prev[sectionId] }));
  }, []);

  /* ---- guard: disconnected ---- */
  if (!connected) {
    return (
      <div className="et-screen" data-testid="et-screen">
        <div className="et-header">
          <Sliders size={16} />
          <span>Extended Tuning</span>
        </div>
        <div className="et-disconnected" data-testid="et-disconnected">
          <AlertTriangle size={20} />
          <p>Vehicle not connected.</p>
          <p className="et-disconnected-hint">
            Connect to an ArduCopter vehicle to configure extended tuning.
          </p>
        </div>
      </div>
    );
  }

  /* ---- guard: non-copter ---- */
  if (!isCopter) {
    return (
      <div className="et-screen" data-testid="et-screen">
        <div className="et-header">
          <Sliders size={16} />
          <span>Extended Tuning</span>
        </div>
        <div className="et-disconnected" data-testid="et-non-copter">
          <AlertTriangle size={20} />
          <p>Extended Tuning is available only for ArduCopter vehicles.</p>
          <p className="et-disconnected-hint">
            Detected vehicle: {vehicleType ?? "Unknown"}
          </p>
        </div>
      </div>
    );
  }

  /* ---- no params available ---- */
  if (availableSections.length === 0) {
    return (
      <div className="et-screen" data-testid="et-screen">
        <div className="et-header">
          <Sliders size={16} />
          <span>Extended Tuning</span>
        </div>
        <div className="et-disconnected" data-testid="et-no-params">
          <Info size={20} />
          <p>No extended tuning parameters found on this vehicle.</p>
          <p className="et-disconnected-hint">
            This may indicate a non-Copter firmware or unsupported configuration.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="et-screen" data-testid="et-screen">
      {/* Header */}
      <div className="et-header">
        <Sliders size={16} />
        <span>Extended Tuning</span>
        {stagedCount > 0 && (
          <span className="et-staged-badge" data-testid="et-staged-count">
            {stagedCount} modified
          </span>
        )}
      </div>

      <div className="et-description">
        <Info size={14} />
        <span>
          Tune your copter's control loops. Adjust rate PIDs, angle gains,
          throttle/position, loiter, acceleration limits, and IMU filters.
          Changes are staged and written on Save.
        </span>
      </div>

      {/* Roll/Pitch lock toggle */}
      <div className="et-lock-bar" data-testid="et-lock-bar">
        <button
          type="button"
          className={`et-lock-btn ${rollPitchLock ? "et-lock-btn--active" : ""}`}
          onClick={() => setRollPitchLock(!rollPitchLock)}
          data-testid="et-roll-pitch-lock"
        >
          <Link size={13} />
          <span>Link Roll / Pitch</span>
          <span className={`et-lock-indicator ${rollPitchLock ? "et-lock-indicator--on" : ""}`}>
            {rollPitchLock ? "ON" : "OFF"}
          </span>
        </button>
        {rollPitchLock && (
          <span className="et-lock-hint">
            Editing Roll values will also update the corresponding Pitch value.
          </span>
        )}
      </div>

      {/* Action bar */}
      {hasChanges && (
        <div className="et-action-bar" data-testid="et-action-bar">
          <button
            type="button"
            className="et-discard-btn"
            onClick={handleDiscardAll}
            data-testid="et-discard-btn"
          >
            <X size={13} />
            Discard All Changes
          </button>
        </div>
      )}

      {/* Sections */}
      <div className="et-sections">
        {availableSections.map((section) => {
          const isCollapsed = collapsed[section.id] ?? false;
          const sectionModified = section.params.some(
            (p) => store.staged[p.id] !== undefined
          );

          return (
            <div
              key={section.id}
              className="et-section"
              data-testid={`et-section-${section.id}`}
            >
              <button
                type="button"
                className="et-section-header"
                onClick={() => toggleSection(section.id)}
                data-testid={`et-section-toggle-${section.id}`}
              >
                {isCollapsed ? (
                  <ChevronRight size={14} />
                ) : (
                  <ChevronDown size={14} />
                )}
                <span className="et-section-label">{section.label}</span>
                {sectionModified && (
                  <span className="et-section-modified-dot" />
                )}
              </button>

              {!isCollapsed && (
                <div className="et-section-body">
                  {section.params.map((paramDef) => {
                    const state = paramState[paramDef.id];
                    if (!state) return null;
                    const hasWarning = largeChangeWarnings[paramDef.id] ?? false;

                    return (
                      <div
                        key={paramDef.id}
                        className={`et-param-row ${state.isModified ? "et-param-row--modified" : ""} ${hasWarning ? "et-param-row--warning" : ""}`}
                        data-testid={`et-param-${paramDef.id}`}
                      >
                        <div className="et-param-info">
                          <span className="et-param-label">{paramDef.label}</span>
                          <span className="et-param-desc">{paramDef.description}</span>
                          {hasWarning && state.live !== null && (
                            <span className="et-param-warning" data-testid={`et-warning-${paramDef.id}`}>
                              <AlertCircle size={11} />
                              Value is &gt;2× the vehicle value ({formatValue(state.live, state.step)}). Confirm change.
                            </span>
                          )}
                        </div>

                        <div className="et-param-controls">
                          {state.live !== null && state.isModified && (
                            <span className="et-param-live-val" data-testid={`et-live-${paramDef.id}`}>
                              {formatValue(state.live, state.step)}
                            </span>
                          )}

                          <input
                            type="number"
                            className={`et-param-input ${state.isModified ? "et-param-input--modified" : ""} ${hasWarning ? "et-param-input--warning" : ""}`}
                            value={state.effective}
                            min={state.min}
                            max={state.max}
                            step={state.step}
                            onChange={(e) =>
                              handleValueChange(paramDef.id, e.target.value)
                            }
                            disabled={!connected}
                            data-testid={`et-input-${paramDef.id}`}
                          />

                          {state.unit && (
                            <span className="et-param-unit">{state.unit}</span>
                          )}

                          {state.isModified && (
                            <button
                              type="button"
                              className="et-revert-btn"
                              onClick={() => handleRevert(paramDef.id)}
                              title="Revert to vehicle value"
                              data-testid={`et-revert-${paramDef.id}`}
                            >
                              <RotateCcw size={12} />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Save button */}
      <div className="et-actions">
        <button
          type="button"
          className="et-save-btn"
          onClick={handleSave}
          disabled={!hasChanges || store.writePhase === "running"}
          data-testid="et-save-btn"
        >
          {store.writePhase === "running" ? (
            <Loader size={14} className="et-spinner" />
          ) : (
            <Save size={14} />
          )}
          {store.writePhase === "running"
            ? "Saving..."
            : `Save Extended Tuning${stagedCount > 0 ? ` (${stagedCount})` : ""}`}
        </button>
      </div>
    </div>
  );
}
