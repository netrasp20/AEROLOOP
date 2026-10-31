import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader,
  RefreshCw,
  RotateCcw,
  Save,
  Settings2,
  ShieldAlert,
  WifiOff,
  XCircle,
} from "lucide-react";

import { useTelemetry } from "../../hooks/useTelemetry";
import { useSafetySetup } from "../../hooks/useSafetySetup";
import { useParameters } from "../../context/ParameterContext";
import type { SafetyParamField } from "../../api/setup";

interface ConfirmChangeRow {
  pid: string;
  name: string;
  current: string;
  next: string;
  effect: string | null;
}

/* ------------------------------------------------------------------ */
/* Shell                                                               */
/* ------------------------------------------------------------------ */

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="setup-page setup-page-safety" data-testid="setup-safety">
      <div className="setup-page-header">
        <h2 className="setup-page-title">
          <ShieldAlert size={17} />
          Safety Setup
        </h2>
        <p className="setup-page-subtitle">
          Safety Setup is used to setup triggers for Return to Land as well as the
          settings for Return to Land itself.
        </p>
      </div>
      {children}
    </div>
  );
}

function SafetySection({
  title,
  testid,
  wide,
  children,
}: {
  title: string;
  testid: string;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section
      className={wide ? "safety-section safety-section-wide" : "safety-section"}
      data-testid={testid}
    >
      <h3 className="safety-section-title">{title}</h3>
      <div className="safety-section-body">{children}</div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Field controls — all values are read from / staged to the vehicle    */
/* ------------------------------------------------------------------ */

function UnsupportedField({ field }: { field: SafetyParamField }) {
  return (
    <div className="safety-row safety-row-na" data-testid={`safety-na-${field.id}`}>
      <span className="safety-label">{field.name}</span>
      <span className="safety-na" data-testid={`safety-na-control-${field.id}`}>
        Unavailable
      </span>
    </div>
  );
}

function NumericParamInput({
  field,
  value,
  onChange,
  disabled,
  dataTestid,
  error,
}: {
  field: SafetyParamField;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  dataTestid: string;
  error?: string | null;
}) {
  if (!field.supported) {
    return <UnsupportedField field={field} />;
  }
  return (
    <div className="safety-row">
      <label className="safety-label" htmlFor={dataTestid}>
        {field.name}
        {field.units && <em className="safety-unit"> · {field.units}</em>}
      </label>
      <div className="safety-control">
        <input
          id={dataTestid}
          type="number"
          step={field.increment != null && field.increment > 0 ? field.increment : "any"}
          min={field.min}
          max={field.max}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          data-testid={dataTestid}
          className="safety-input"
        />
        {field.zeroMeansDisabled && (value === "" || Number(value) === 0) && (
          <span className="safety-value-na" data-testid={`${dataTestid}-disabled`}>
            Disabled
          </span>
        )}
      </div>
      {error && (
        <span className="safety-field-error" data-testid={`${dataTestid}-error`}>
          {error}
        </span>
      )}
    </div>
  );
}

function EnumParamInput({
  field,
  value,
  onChange,
  disabled,
  dataTestid,
  error,
}: {
  field: SafetyParamField;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  dataTestid: string;
  error?: string | null;
}) {
  if (!field.supported) {
    return <UnsupportedField field={field} />;
  }
  if (field.options && field.options.length > 0) {
    return (
      <div className="safety-row">
        <label className="safety-label" htmlFor={dataTestid}>
          {field.name}
        </label>
        <div className="safety-control">
          <select
            id={dataTestid}
            value={value}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            data-testid={dataTestid}
            className="safety-select"
          >
            {field.options.map((o) => (
              <option key={String(o.code)} value={String(o.code)}>
                {o.label} ({o.code})
              </option>
            ))}
          </select>
        </div>
        {error && (
          <span className="safety-field-error" data-testid={`${dataTestid}-error`}>
            {error}
          </span>
        )}
      </div>
    );
  }
  return (
    <NumericParamInput
      field={field}
      value={value}
      onChange={onChange}
      disabled={disabled}
      dataTestid={dataTestid}
      error={error}
    />
  );
}

/** Compact horizontal bitmask checkbox row (QGC-style). */
function BitmaskEditor({
  field,
  value,
  disabled,
  onChange,
  dataTestid,
  error,
  selectAll,
}: {
  field: SafetyParamField;
  value: number;
  disabled: boolean;
  onChange: (newInt: number) => void;
  dataTestid: string;
  error?: string | null;
  selectAll?: boolean;
}) {
  if (!field.supported) {
    return <UnsupportedField field={field} />;
  }
  const bits = field.bits;
  if (!bits || field.bitmaskUnavailable) {
    const shown = field.value != null ? `Raw value: ${field.value}` : "Unavailable";
    return (
      <div className="safety-row" data-testid={`${dataTestid}-raw`}>
        <span className="safety-label">{field.name}</span>
        <span className="safety-value-na">
          {shown}
          <em className="safety-note"> · Bitmask details unavailable</em>
        </span>
      </div>
    );
  }
  const raw = Number.isFinite(value) ? value : (field.value ?? 0);
  const isOn = (code: number) => Boolean(raw & (1 << code));
  const allMask = bits.reduce((acc, b) => acc | (1 << b.code), 0);
  const allOn = allMask !== 0 && (raw & allMask) === allMask;
  return (
    <div className="safety-row safety-row-wide">
      <span className="safety-label">
        {field.name}
        {field.value != null && <em className="safety-note"> · {field.value}</em>}
      </span>
      <div className="safety-checks" data-testid={dataTestid}>
        {selectAll && (
          <label className="safety-check safety-check-all">
            <input
              type="checkbox"
              checked={allOn}
              disabled={disabled}
              onChange={(e) => onChange(e.target.checked ? raw | allMask : raw & ~allMask)}
              data-testid={`${dataTestid}-bit-all`}
            />
            <span>All</span>
          </label>
        )}
        {bits.map((b) => (
          <label key={b.code} className="safety-check">
            <input
              type="checkbox"
              checked={isOn(b.code)}
              disabled={disabled}
              onChange={(e) => {
                const next = e.target.checked ? raw | (1 << b.code) : raw & ~(1 << b.code);
                onChange(next);
              }}
              data-testid={`${dataTestid}-bit-${b.code}`}
            />
            <span>{b.label}</span>
          </label>
        ))}
      </div>
      {error && (
        <span className="safety-field-error" data-testid={`${dataTestid}-error`}>
          {error}
        </span>
      )}
    </div>
  );
}

/**
 * One compact row per real metadata enum value, presented as a radio list —
 * the way QGroundControl presents GeoFence breach actions. No invented
 * values: every radio is one option the firmware actually publishes.
 */
function RadioParamList({
  field,
  value,
  onChange,
  disabled,
  dataTestid,
  error,
}: {
  field: SafetyParamField;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  dataTestid: string;
  error?: string | null;
}) {
  if (!field.supported) {
    return <UnsupportedField field={field} />;
  }
  const options = field.options ?? [];
  if (options.length === 0) {
    return (
      <EnumParamInput
        field={field}
        value={value}
        onChange={onChange}
        disabled={disabled}
        dataTestid={dataTestid}
        error={error}
      />
    );
  }
  return (
    <>
      {options.map((o) => {
        const id = `${dataTestid}-opt-${o.code}`;
        return (
          <div className="safety-row safety-row-radio" key={String(o.code)}>
            <label className="safety-label" htmlFor={id}>
              {o.label}
            </label>
            <div className="safety-control">
              <input
                id={id}
                type="radio"
                name={dataTestid}
                checked={String(value) === String(o.code)}
                disabled={disabled}
                onChange={() => onChange(String(o.code))}
                data-testid={id}
                className="safety-radio"
              />
            </div>
          </div>
        );
      })}
      {error && (
        <div className="safety-field-error" data-testid={`${dataTestid}-error`}>
          {error}
        </div>
      )}
    </>
  );
}

/**
 * A two-state "use an explicit value, or leave it to the vehicle" control:
 * a radio/checkbox on the left of the control, plus the parameter's own
 * number input. `0` means "vehicle default", which is how ArduCopter encodes
 * RTL_ALT / RTL_ALT_FINAL / RTL_LOIT_TIME / LAND_SPEED.
 */
/**
 * Value to stage when an optional 0-means-disabled field is switched on.
 *
 * 0 is the "off" encoding, so staging the plain minimum would leave the field
 * switched off. The smallest in-range value the vehicle's own metadata offers
 * that is not 0 is used instead (a positive minimum when it has one,
 * otherwise one increment step). If metadata cannot provide such a value,
 * the enable control is unavailable rather than guessing.
 */
function enableValue(field: SafetyParamField): string | null {
  const min = field.min;
  const max = field.max;
  const step = field.increment;
  const candidate = min != null && min > 0
    ? min
    : step != null && step > 0
      ? step
      : null;
  if (candidate == null) return null;
  if (min != null && candidate < min) return null;
  if (max != null && candidate > max) return null;
  return String(candidate);
}

function OptionalValueRow({
  field,
  value,
  onChange,
  disabled,
  dataTestid,
  label,
  control = "radio",
  error,
  onEnable,
}: {
  field: SafetyParamField;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  dataTestid: string;
  label: string;
  control?: "radio" | "checkbox";
  error?: string | null;
  /** Called with the value to stage when switching from off to on. */
  onEnable?: () => string;
}) {
  // While a number input is transiently empty (mid-edit) the row must not
  // disable itself, otherwise the value could never be retyped.
  const lastValue = useRef(value);
  useEffect(() => {
    if (value !== "") lastValue.current = value;
  }, [value]);
  if (!field.supported) {
    return <UnsupportedField field={field} />;
  }
  const num = Number(value);
  const on = value === "" ? Number(lastValue.current) !== 0 : Number.isFinite(num) && num !== 0;
  const valueToEnable = onEnable ? onEnable() : enableValue(field);
  const toggle = (checked: boolean) => {
    if (checked) {
      if (valueToEnable != null) onChange(valueToEnable);
    } else {
      onChange("0");
    }
  };
  const Input = control === "radio" ? "radio" : "checkbox";
  return (
    <div className="safety-row">
      <label className="safety-label" htmlFor={`${dataTestid}-toggle`}>
        {label}
      </label>
      <div className="safety-control">
        <input
          id={`${dataTestid}-toggle`}
          type={Input}
          name={control === "radio" ? dataTestid : undefined}
          checked={on}
          disabled={disabled || (!on && valueToEnable == null)}
          onChange={(e) => toggle(e.target.checked)}
          data-testid={`${dataTestid}-toggle`}
          className={control === "radio" ? "safety-radio" : "safety-check-box"}
        />
        <input
          id={dataTestid}
          type="number"
          step={field.increment != null && field.increment > 0 ? field.increment : "any"}
          min={field.min}
          max={field.max}
          value={value}
          disabled={disabled || !on}
          onChange={(e) => onChange(e.target.value)}
          data-testid={dataTestid}
          className="safety-input safety-input-inline"
        />
        {field.units && <span className="safety-unit">{field.units}</span>}
        {!on && valueToEnable == null && (
          <span className="safety-value-na" data-testid={`${dataTestid}-enable-unavailable`}>
            No valid enabled value in firmware metadata
          </span>
        )}
      </div>
      {error && (
        <span className="safety-field-error" data-testid={`${dataTestid}-error`}>
          {error}
        </span>
      )}
    </div>
  );
}

/**
 * "Return at current altitude" vs "Return at specified altitude": the QGC
 * radio pair. The alt/zero split is ArduCopter's own convention, so no
 * dropdown is shown and the altitude input only appears for the explicit
 * choice.
 */
function AltitudeChoiceRow({
  field,
  value,
  onChange,
  disabled,
  dataTestid,
  error,
}: {
  field: SafetyParamField;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  dataTestid: string;
  error?: string | null;
}) {
  const lastValue = useRef(value);
  useEffect(() => {
    if (value !== "") lastValue.current = value;
  }, [value]);
  if (!field.supported) {
    return <UnsupportedField field={field} />;
  }
  const num = Number(value);
  /**
   * ArduCopter encodes "return at the current altitude" as 0. The option is
   * only offered when the vehicle's own metadata actually accepts 0 as a
   * value — this firmware publishes RTL_ALT_M with a minimum of 0.3 m, so
   * staging 0 would always be rejected and the radio would be a dead control.
   */
  const currentAllowed =
    (field.min == null || field.min <= 0) &&
    (field.max == null || field.max >= 0);
  const specifiedValue = enableValue(field);
  const explicit = currentAllowed
    ? value === ""
      ? Number(lastValue.current) > 0
      : Number.isFinite(num) && num > 0
    : true;
  return (
    <>
      {currentAllowed && (
        <div className="safety-row safety-row-radio">
          <label className="safety-label" htmlFor={`${dataTestid}-current`}>
            Return at current altitude
          </label>
          <div className="safety-control">
            <input
              id={`${dataTestid}-current`}
              type="radio"
              name={dataTestid}
              checked={!explicit}
              disabled={disabled}
              onChange={() => onChange("0")}
              data-testid={`${dataTestid}-current`}
              className="safety-radio"
            />
          </div>
        </div>
      )}
      <div className="safety-row">
        <label className="safety-label" htmlFor={`${dataTestid}-specified`}>
          Return at specified altitude
        </label>
        <div className="safety-control">
          {currentAllowed && (
            <input
              id={`${dataTestid}-specified`}
              type="radio"
              name={dataTestid}
              checked={explicit}
              disabled={disabled || (!explicit && specifiedValue == null)}
              onChange={() => onChange(explicit ? value : specifiedValue ?? value)}
              data-testid={`${dataTestid}-specified`}
              className="safety-radio"
            />
          )}
          <input
            id={dataTestid}
            type="number"
            step={field.increment != null && field.increment > 0 ? field.increment : "any"}
            min={field.min}
            max={field.max}
            value={value}
            disabled={disabled || !explicit}
            onChange={(e) => onChange(e.target.value)}
            data-testid={dataTestid}
            className="safety-input safety-input-inline"
          />
          {field.units && <span className="safety-unit">{field.units}</span>}
        </div>
        {error && (
          <span className="safety-field-error" data-testid={`${dataTestid}-error`}>
            {error}
          </span>
        )}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Confirmation dialog for real safety-affecting changes                 */
/* ------------------------------------------------------------------ */

function ConfirmDialog({
  rows,
  onCancel,
  onOk,
}: {
  rows: ConfirmChangeRow[];
  onCancel: () => void;
  onOk: () => void;
}) {
  return (
    <div className="safety-confirm-backdrop" data-testid="safety-confirm-dialog">
      <div className="safety-confirm">
        <h3 className="safety-confirm-title">
          <AlertTriangle size={15} />
          Confirm safety changes
        </h3>
        <p className="safety-confirm-text">
          These values change the flight controller&apos;s failsafe behaviour. They are
          written to the vehicle only after you confirm.
        </p>
        <div className="safety-confirm-list">
          {rows.map((r) => (
            <div key={r.pid} className="safety-confirm-row" data-testid={`safety-confirm-${r.pid}`}>
              <span className="safety-confirm-name">{r.name}</span>
              <span className="safety-confirm-values">
                <span className="safety-confirm-current">{r.current}</span>
                <span className="safety-confirm-arrow">→</span>
                <span className="safety-confirm-next">{r.next}</span>
              </span>
              {r.effect && <span className="safety-confirm-effect">{r.effect}</span>}
            </div>
          ))}
        </div>
        <div className="safety-confirm-actions">
          <button
            type="button"
            className="setup-params-btn"
            onClick={onCancel}
            data-testid="safety-confirm-cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            className="setup-params-btn setup-params-btn-primary"
            onClick={onOk}
            data-testid="safety-confirm-ok"
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function SetupSafety() {
  const telemetry = useTelemetry();
  const store = useParameters();
  const { safety, connectionLost, refresh } = useSafetySetup(telemetry.connected);

  const [draft, setDraft] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [configError, setConfigError] = useState<string | null>(null);
  const [configNotice, setConfigNotice] = useState<string | null>(null);
  const [writeVisible, setWriteVisible] = useState(false);
  const [pendingWrite, setPendingWrite] = useState(false);
  const [rebootNote, setRebootNote] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [confirmRows, setConfirmRows] = useState<ConfirmChangeRow[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  /**
   * Editing a value stages it immediately in the shared parameter manager so
   * the pending state is visible and Revert is a real undo. Nothing reaches
   * the vehicle until Apply runs the verified write transaction.
   */
  const markTouched = (field: SafetyParamField, value: string) => {
    const pid = field.id;
    setDraft((prev) => ({ ...prev, [pid]: value }));
    setTouched((prev) => new Set(prev).add(pid));
    if (value.trim() === "" || !Number.isFinite(Number(value))) {
      setFieldErrors((prev) => ({ ...prev, [pid]: `${field.name} (${pid}) must be a numeric value.` }));
      return;
    }
    if (!store.entries[pid]) {
      setConfigNotice(`${field.name} not yet loaded from the vehicle — left unchanged.`);
      return;
    }
    const result = store.stageValue(pid, Number(value));
    if (result.ok) {
      setConfigNotice(null);
      setFieldErrors((prev) => {
        if (!(pid in prev)) return prev;
        const next = { ...prev };
        delete next[pid];
        return next;
      });
    } else {
      setFieldErrors((prev) => ({ ...prev, [pid]: result.error ?? `Unable to stage ${pid}.` }));
    }
  };
  const clearEdits = useCallback(() => {
    setTouched(new Set());
    setDraft({});
    setFieldErrors({});
    setRebootNote(false);
  }, []);
  const clearDrafts = useCallback(() => {
    setTouched(new Set());
    setDraft({});
    setFieldErrors({});
  }, []);

  const liveValue = (pid: string, fallback: number | null): number | null => {
    const v = store.entries[pid]?.live?.value;
    return typeof v === "number" ? v : fallback;
  };
  const fieldString = (pid: string, fallback: number | null): string => {
    if (touched.has(pid)) return draft[pid] ?? "";
    const v = liveValue(pid, fallback);
    return v === null ? "" : String(v);
  };
  const bitmaskInt = (field: SafetyParamField): number => {
    if (touched.has(field.id)) return Number(draft[field.id] ?? 0) || 0;
    return field.value ?? 0;
  };
  const rebootRequiredFor = (field: SafetyParamField): boolean => {
    if (field.rebootRequired) return true;
    return store.entries[field.id]?.metadata?.rebootRequired === true;
  };
  const decodedLabel = (field: SafetyParamField, value: number | null): string => {
    if (value == null) return "Unavailable";
    if (field.options && field.options.length > 0) {
      const opt = field.options.find((o) => String(o.code) === String(value));
      return opt ? `${opt.label} (${value})` : `Unknown value: ${value}`;
    }
    return String(value);
  };

  /* ---------------- collect every editable field ---------------- */

  const battery = safety?.battery?.fields;
  const radio = safety?.radio?.fields;
  const gcs = safety?.gcs;
  const fence = safety?.fence?.fields;
  const rtlFields = safety?.rtl?.fields;
  const rtlExtra = safety?.rtl?.extra ?? [];
  const arming = safety?.arming;
  /**
   * QGC's leading "All" toggle belongs to the "skip checks" bitmask. ArduCopter
   * has no consolidated ARMING_CHECK parameter, so that list arrives through
   * `arming.checks`; whichever field really carries the bits gets the toggle.
   */
  const armingBitmasks = (arming?.checks ?? []).filter(
    (f) => f.supported && !f.bitmaskUnavailable && (f.bits?.length ?? 0) > 0,
  );
  const skipAllField = arming?.field?.supported
    ? arming.field
    : (armingBitmasks.find((f) => f.id.includes("SKIPCHK")) ?? armingBitmasks[0] ?? null);
  const advancedCategories = safety?.advanced?.categories ?? [];
  /** Real battery parameters with no row in the QGC six-field block. */
  const batteryExtra = battery
    ? [battery.lowTimer, battery.fsVoltSrc].filter((f) => f.supported)
    : [];
  /**
   * Real GeoFence parameters that QGC keeps off the primary page (fence type,
   * fence options, minimum altitude, margin, margin-notification frequency).
   * They stay fully editable, just under Advanced, and only when the connected
   * firmware actually serves them.
   */
  const fenceExtra = fence
    ? [fence.types, fence.options, fence.altMin, fence.margin, fence.ntfFreq].filter((f) => f.supported)
    : [];

  const allFields: SafetyParamField[] = [];
  if (battery) {
    allFields.push(
      battery.lowVolt,
      battery.crtVolt,
      battery.lowMah,
      battery.crtMah,
      battery.lowTimer,
      battery.fsVoltSrc,
      battery.fsLowAct,
      battery.fsCrtAct,
    );
  }
  if (gcs) allFields.push(gcs.field, gcs.timeout);
  if (radio) allFields.push(radio.enable, radio.value, radio.options);
  if (fence) {
    allFields.push(
      fence.enable,
      fence.action,
      fence.radius,
      fence.altMax,
      fence.altMin,
      fence.margin,
      fence.types,
      fence.options,
      fence.ntfFreq,
    );
  }
  if (rtlFields) allFields.push(rtlFields.alt, rtlFields.loitTime, rtlFields.altFinal, rtlFields.landSpeed);
  allFields.push(...rtlExtra);
  if (arming?.field) allFields.push(arming.field);
  if (arming?.checks) allFields.push(...arming.checks);
  for (const cat of advancedCategories) allFields.push(...cat.params);

  /** Failsafe-affecting params get a confirmation step before writing. */
  const confirmIds = useMemo(() => {
    const ids = new Set<string>();
    if (battery) {
      if (battery.fsLowAct.supported) ids.add(battery.fsLowAct.id);
      if (battery.fsCrtAct.supported) ids.add(battery.fsCrtAct.id);
    }
    if (gcs?.field.supported) ids.add(gcs.field.id);
    if (radio) {
      if (radio.enable.supported) ids.add(radio.enable.id);
      if (radio.options.supported) ids.add(radio.options.id);
    }
    if (fence) {
      if (fence.enable.supported) ids.add(fence.enable.id);
      if (fence.action.supported) ids.add(fence.action.id);
    }
    return ids;
  }, [battery, gcs, radio, fence]);

  const handleApply = () => {
    setConfigError(null);
    if (!safety) return;

    const invalid = Object.entries(fieldErrors);
    if (invalid.length > 0) {
      setConfigError(invalid[0][1]);
      return;
    }
    if (safetyParamsStaged === 0) {
      setConfigNotice("No changes to apply.");
      return;
    }

    const stagedConfirm: ConfirmChangeRow[] = [];
    const rebootIds: string[] = [];

    for (const f of allFields) {
      if (!f || !f.supported || !touched.has(f.id)) continue;
      const staged = store.staged[f.id];
      if (!staged) continue;
      const n = staged.stagedValue;
      if (rebootRequiredFor(f)) rebootIds.push(f.id);

      if (confirmIds.has(f.id) && String(n) !== String(f.value)) {
        stagedConfirm.push({
          pid: f.id,
          name: f.name,
          current: decodedLabel(f, f.value),
          next: decodedLabel(f, n),
          effect:
            f.description && f.description.length > 0
              ? `${f.description.slice(0, 140)}${f.description.length > 140 ? "…" : ""}`
              : null,
        });
      }
    }

    setConfigNotice(null);
    setRebootNote(rebootIds.length > 0);
    if (stagedConfirm.length > 0) {
      setConfirmRows(stagedConfirm);
      setConfirmOpen(true);
    } else {
      setWriteVisible(true);
      setPendingWrite(true);
    }
  };

  const handleConfirmWrite = () => {
    setConfirmOpen(false);
    setWriteVisible(true);
    setPendingWrite(true);
  };

  // Count the controls actually rendered by this page. Prefix-based filtering
  // omitted legitimate metadata-grouped Safety fields such as WP_YAW_BEHAVIOR,
  // leaving them staged but never sending them when Apply was pressed.
  const safetyFieldIds = new Set(allFields.map((field) => field.id));
  const safetyParamsStaged = Object.keys(store.staged ?? {}).filter((pid) =>
    safetyFieldIds.has(pid),
  ).length;

  useEffect(() => {
    if (!pendingWrite) return;
    if (safetyParamsStaged > 0 && store.connection === "READY") {
      setPendingWrite(false);
      void store.executeWrite();
    } else if (safetyParamsStaged === 0) {
      setPendingWrite(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingWrite, safetyParamsStaged, store.connection, store.executeWrite]);

  const handleRevert = () => {
    setConfigError(null);
    setConfigNotice(null);
    if (safetyParamsStaged > 0) store.discardAll();
    clearEdits();
    setWriteVisible(false);
    setConfirmOpen(false);
  };

  const prevWritePhase = useRef<string | null>(null);
  useEffect(() => {
    const phase = store.writePhase;
    const cameFromRunning = prevWritePhase.current === "running";
    prevWritePhase.current = phase;
    if (!cameFromRunning) return;
    if (phase === "error" || phase === "interrupted") {
      store.discardAll();
      clearEdits();
      setWriteVisible(true);
    } else if (phase === "success") {
      clearDrafts();
      setWriteVisible(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.writePhase, clearDrafts]);

  const wasConnectedRef = useRef(telemetry.connected);
  useEffect(() => {
    if (!telemetry.connected && wasConnectedRef.current) {
      store.discardAll();
      clearEdits();
      setWriteVisible(false);
      setConfirmOpen(false);
    }
    wasConnectedRef.current = telemetry.connected;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [telemetry.connected]);

  const connecting = telemetry.connectionState === "CONNECTING";
  const lost = !telemetry.connected && !connecting && telemetry.disconnectReason != null;
  const unsupported = safety?.success === true && safety.supported === false;
  const syncing = safety === null || safety.state === "SYNCING";
  const failed =
    !syncing && !unsupported && (safety?.success !== true || safety.state === "ERROR");

  const writeDisabled = store.writePhase === "running";

  /**
   * Parameters the vehicle did not accept. A partially applied batch must name
   * the exact parameters that were left unwritten instead of reporting the
   * whole operation as a success.
   */
  const failedResults = (store.writeSummary?.results ?? []).filter(
    (r) => r.status !== "success",
  );

  /**
   * Headline for a rejected write. Only claim the previous values were kept
   * when nothing was written; a partially applied batch did change some
   * parameters, so it must be described as what it actually did.
   */
  const writeFailureHeadline = store.writeError?.message
    ?? (() => {
      const total = store.writeSummary?.total ?? failedResults.length;
      const applied = store.writeSummary?.succeeded ?? 0;
      if (applied > 0) {
        return `Could not apply ${failedResults.length} of ${total} parameter${total === 1 ? "" : "s"} — ${applied} applied, the rest were left unchanged.`;
      }
      return "Failed to apply parameter — previous values were preserved.";
    })();

  /* ---------------- connection states ---------------- */

  if (!telemetry.connected) {
    const reason = connecting
      ? "Establishing a MAVLink link with the flight controller."
      : lost
        ? `Reason: ${telemetry.disconnectReason}`
        : "Connect a Pixhawk or MAVLink vehicle to configure its failsafe parameters.";
    return (
      <PageShell>
        <div
          className="setup-disconnected"
          data-testid={
            connecting ? "setup-safety-connecting" : lost ? "setup-safety-lost" : "setup-safety-waiting"
          }
        >
          {connecting ? (
            <Loader size={26} className="setup-spinner" />
          ) : lost ? (
            <WifiOff size={26} />
          ) : (
            <ShieldAlert size={26} />
          )}
          <p className="setup-disconnected-title">
            {connecting ? "Connecting…" : lost ? "MAVLink connection lost" : "Waiting for vehicle"}
          </p>
          {lost && (
            <p className="setup-disconnected-reason" data-testid="setup-safety-lost-reason">
              {reason}
            </p>
          )}
          <p className="setup-disconnected-hint">{reason}</p>
          {connectionLost && (
            <p className="setup-note" data-testid="setup-safety-connection-lost">
              Staged safety changes were discarded and stale values cleared. They will be
              restored from the vehicle after reconnect.
            </p>
          )}
        </div>
      </PageShell>
    );
  }

  if (syncing) {
    return (
      <PageShell>
        <div className="safety-grid" data-testid="setup-safety-syncing">
          {["Battery Failsafe Triggers", "General Failsafe Triggers", "GeoFence", "Return to Launch"].map(
            (label) => (
              <div className="safety-section" key={label}>
                <h3 className="safety-section-title">{label}</h3>
                <div className="setup-fw-loading">
                  <Loader size={16} className="setup-spinner" />
                  Synchronizing…
                </div>
              </div>
            ),
          )}
        </div>
      </PageShell>
    );
  }

  if (failed) {
    return (
      <PageShell>
        <div className="setup-card" data-testid="setup-safety-error">
          <div className="frame-error">
            <XCircle size={16} />
            Safety configuration is unavailable for the connected vehicle.
          </div>
          <button
            type="button"
            className="setup-params-btn"
            onClick={() => {
              void refresh();
            }}
            data-testid="setup-safety-retry"
          >
            <RefreshCw size={13} />
            Retry
          </button>
        </div>
      </PageShell>
    );
  }

  if (unsupported) {
    return (
      <PageShell>
        <div className="setup-card" data-testid="setup-safety-unsupported">
          <div className="safety-warning">
            <AlertTriangle size={14} />
            {safety?.unsupportedReason || "Safety setup is not supported for this vehicle."}
          </div>
        </div>
      </PageShell>
    );
  }

  /* ---------------- ready: compact QGC-style configuration form ---------------- */

  return (
    <PageShell>
      {configError && (
        <div className="frame-error" data-testid="safety-config-error">
          <XCircle size={14} />
          {configError}
        </div>
      )}
      {configNotice && (
        <div className="safety-row-note" data-testid="safety-config-notice">
          {configNotice}
        </div>
      )}

      <div className="safety-grid">
        {/* --- Battery Failsafe Triggers --- */}
        <SafetySection title="Battery Failsafe Triggers" testid="safety-section-battery">
          {battery ? (
            <>
              <EnumParamInput field={battery.fsLowAct} value={fieldString(battery.fsLowAct.id, battery.fsLowAct.value)} onChange={(v) => markTouched(battery.fsLowAct, v)} disabled={writeDisabled} error={fieldErrors[battery.fsLowAct.id]} dataTestid="safety-batt-fslowact" />
              <EnumParamInput field={battery.fsCrtAct} value={fieldString(battery.fsCrtAct.id, battery.fsCrtAct.value)} onChange={(v) => markTouched(battery.fsCrtAct, v)} disabled={writeDisabled} error={fieldErrors[battery.fsCrtAct.id]} dataTestid="safety-batt-fscrtact" />
              <NumericParamInput field={battery.lowVolt} value={fieldString(battery.lowVolt.id, battery.lowVolt.value)} onChange={(v) => markTouched(battery.lowVolt, v)} disabled={writeDisabled} error={fieldErrors[battery.lowVolt.id]} dataTestid="safety-batt-lowvolt" />
              <NumericParamInput field={battery.crtVolt} value={fieldString(battery.crtVolt.id, battery.crtVolt.value)} onChange={(v) => markTouched(battery.crtVolt, v)} disabled={writeDisabled} error={fieldErrors[battery.crtVolt.id]} dataTestid="safety-batt-crtvolt" />
              <NumericParamInput field={battery.lowMah} value={fieldString(battery.lowMah.id, battery.lowMah.value)} onChange={(v) => markTouched(battery.lowMah, v)} disabled={writeDisabled} error={fieldErrors[battery.lowMah.id]} dataTestid="safety-batt-lowmah" />
              <NumericParamInput field={battery.crtMah} value={fieldString(battery.crtMah.id, battery.crtMah.value)} onChange={(v) => markTouched(battery.crtMah, v)} disabled={writeDisabled} error={fieldErrors[battery.crtMah.id]} dataTestid="safety-batt-crtmah" />
            </>
          ) : (
            <div className="safety-row-note">Battery failsafe parameters are not available.</div>
          )}
        </SafetySection>

        {/* --- General Failsafe Triggers --- */}
        <SafetySection title="General Failsafe Triggers" testid="safety-section-general">
          {gcs ? (
            <>
              <EnumParamInput field={gcs.field} value={fieldString(gcs.field.id, gcs.field.value)} onChange={(v) => markTouched(gcs.field, v)} disabled={writeDisabled} error={fieldErrors[gcs.field.id]} dataTestid="safety-gcs-enable" />
              <NumericParamInput field={gcs.timeout} value={fieldString(gcs.timeout.id, gcs.timeout.value)} onChange={(v) => markTouched(gcs.timeout, v)} disabled={writeDisabled} error={fieldErrors[gcs.timeout.id]} dataTestid="safety-gcs-timeout" />
            </>
          ) : null}
          {radio ? (
            <>
              <EnumParamInput field={radio.enable} value={fieldString(radio.enable.id, radio.enable.value)} onChange={(v) => markTouched(radio.enable, v)} disabled={writeDisabled} error={fieldErrors[radio.enable.id]} dataTestid="safety-radio-enable" />
              <NumericParamInput field={radio.value} value={fieldString(radio.value.id, radio.value.value)} onChange={(v) => markTouched(radio.value, v)} disabled={writeDisabled} error={fieldErrors[radio.value.id]} dataTestid="safety-radio-value" />
              <BitmaskEditor field={radio.options} value={bitmaskInt(radio.options)} disabled={writeDisabled} onChange={(n) => markTouched(radio.options, String(n))} error={fieldErrors[radio.options.id]} dataTestid="safety-radio-options" />
            </>
          ) : null}
          {(safety?.radio?.warnings ?? []).map((w) => (
            <div className="safety-row safety-row-warn" key={w} data-testid="safety-radio-warning">
              <AlertTriangle size={13} />
              <span>{w}</span>
            </div>
          ))}
        </SafetySection>

        {/* --- GeoFence --- */}
        <SafetySection title="GeoFence" testid="safety-section-fence">
          {fence ? (
            <>
              <RadioParamList field={fence.enable} value={fieldString(fence.enable.id, fence.enable.value)} onChange={(v) => markTouched(fence.enable, v)} disabled={writeDisabled} error={fieldErrors[fence.enable.id]} dataTestid="safety-fence-enable" />
              <RadioParamList field={fence.action} value={fieldString(fence.action.id, fence.action.value)} onChange={(v) => markTouched(fence.action, v)} disabled={writeDisabled} error={fieldErrors[fence.action.id]} dataTestid="safety-fence-action" />
              <NumericParamInput field={fence.radius} value={fieldString(fence.radius.id, fence.radius.value)} onChange={(v) => markTouched(fence.radius, v)} disabled={writeDisabled} error={fieldErrors[fence.radius.id]} dataTestid="safety-fence-radius" />
              <NumericParamInput field={fence.altMax} value={fieldString(fence.altMax.id, fence.altMax.value)} onChange={(v) => markTouched(fence.altMax, v)} disabled={writeDisabled} error={fieldErrors[fence.altMax.id]} dataTestid="safety-fence-altmax" />
            </>
          ) : (
            <div className="safety-row-note">GeoFence parameters are not available.</div>
          )}
        </SafetySection>

        {/* --- Return to Launch --- */}
        <SafetySection title="Return to Launch" testid="safety-section-rtl">
          {rtlFields ? (
            <>
              <AltitudeChoiceRow field={rtlFields.alt} value={fieldString(rtlFields.alt.id, rtlFields.alt.value)} onChange={(v) => markTouched(rtlFields.alt, v)} disabled={writeDisabled} error={fieldErrors[rtlFields.alt.id]} dataTestid="safety-rtl-alt" />
              <OptionalValueRow control="checkbox" label="Loiter above Home for" field={rtlFields.loitTime} value={fieldString(rtlFields.loitTime.id, rtlFields.loitTime.value)} onChange={(v) => markTouched(rtlFields.loitTime, v)} disabled={writeDisabled} error={fieldErrors[rtlFields.loitTime.id]} dataTestid="safety-rtl-loittime" />
              <OptionalValueRow control="radio" label="Land with descent speed" field={rtlFields.landSpeed} value={fieldString(rtlFields.landSpeed.id, rtlFields.landSpeed.value)} onChange={(v) => markTouched(rtlFields.landSpeed, v)} disabled={writeDisabled} error={fieldErrors[rtlFields.landSpeed.id]} dataTestid="safety-rtl-landspeed" />
              <OptionalValueRow control="radio" label="Final loiter altitude" field={rtlFields.altFinal} value={fieldString(rtlFields.altFinal.id, rtlFields.altFinal.value)} onChange={(v) => markTouched(rtlFields.altFinal, v)} disabled={writeDisabled} error={fieldErrors[rtlFields.altFinal.id]} dataTestid="safety-rtl-altfinal" />
            </>
          ) : (
            <div className="safety-row-note">Return to Launch parameters are not available.</div>
          )}
        </SafetySection>

        {/* --- Arming Checks (full width, compact) --- */}
        <SafetySection title="Arming Checks" testid="safety-section-arming" wide>
          {skipAllField ? (
            <BitmaskEditor
              selectAll
              field={skipAllField}
              value={bitmaskInt(skipAllField)}
              disabled={writeDisabled}
              onChange={(n) => markTouched(skipAllField, String(n))}
              error={fieldErrors[skipAllField.id]}
              dataTestid={
                arming?.field?.supported
                  ? "safety-arming-checks"
                  : `safety-arming-${skipAllField.id.toLowerCase()}`
              }
            />
          ) : null}
          {arming?.note && (
            <div className="safety-row safety-row-note" data-testid="safety-armcheck-note">
              <span>{arming.note}</span>
            </div>
          )}
          {(arming?.checks ?? [])
            .filter((f) => f.id !== skipAllField?.id)
            .map((f) =>
            f.bits && !f.bitmaskUnavailable ? (
              <BitmaskEditor key={f.id} field={f} value={bitmaskInt(f)} disabled={writeDisabled} onChange={(n) => markTouched(f, String(n))} error={fieldErrors[f.id]} dataTestid={`safety-arming-${f.id.toLowerCase()}`} />
            ) : f.options && f.options.length > 0 ? (
              <EnumParamInput key={f.id} field={f} value={fieldString(f.id, f.value)} onChange={(v) => markTouched(f, v)} disabled={writeDisabled} error={fieldErrors[f.id]} dataTestid={`safety-arming-${f.id.toLowerCase()}`} />
            ) : (
              <NumericParamInput key={f.id} field={f} value={fieldString(f.id, f.value)} onChange={(v) => markTouched(f, v)} disabled={writeDisabled} error={fieldErrors[f.id]} dataTestid={`safety-arming-${f.id.toLowerCase()}`} />
            ),
          )}
          {arming && !arming.supported && (
            <div className="safety-row-note" data-testid="safety-armcheck-unsupported">
              Arming check parameters are unavailable on this firmware.
            </div>
          )}
        </SafetySection>
      </div>

      {/* --- Actions --- */}
      <div className="safety-actions" data-testid="safety-config-actions">
        <button
          type="button"
          className="setup-params-btn"
          onClick={() => {
            void refresh();
          }}
          disabled={writeDisabled}
          data-testid="setup-safety-refresh"
        >
          <RefreshCw size={13} />
          Refresh
        </button>
        <button
          type="button"
          className="setup-params-btn setup-params-btn-danger"
          onClick={handleRevert}
          disabled={writeDisabled}
          data-testid="safety-config-revert"
        >
          <RotateCcw size={13} />
          Revert
        </button>
        <button
          type="button"
          className="setup-params-btn setup-params-btn-primary"
          onClick={handleApply}
          disabled={writeDisabled || store.connection !== "READY"}
          data-testid="safety-config-apply"
        >
          {writeDisabled ? <Loader size={13} className="setup-spinner" /> : <Save size={13} />}
          {writeDisabled ? "Applying…" : "Apply"}
        </button>

        {writeDisabled && (
          <div className="frame-write-running" data-testid="safety-config-writing">
            <Loader size={14} className="setup-spinner" />
            Writing
            {store.writeProgress.currentParamId ? ` ${store.writeProgress.currentParamId}` : ""}…
            <span>
              {store.writeProgress.completed} / {store.writeProgress.total} verified
            </span>
          </div>
        )}
        {safetyParamsStaged > 0 && (
          <div className="radio-unsaved">
            <RotateCcw size={14} />
            <span>
              {safetyParamsStaged} value{safetyParamsStaged === 1 ? "" : "s"} staged — the vehicle has
              not been modified yet.
            </span>
          </div>
        )}
        {writeVisible && (store.writeError || failedResults.length > 0) && !writeDisabled && (
          <div className="frame-error" data-testid="safety-config-write-error">
            <XCircle size={14} />
            <span>
              {writeFailureHeadline}
              {failedResults.length > 0 && (
                <>
                  {" Not written: "}
                  {failedResults
                    .map(
                      (r) =>
                        `${r.paramId} (${r.message || r.code || r.status})`,
                    )
                    .join(", ")}
                  .
                </>
              )}
            </span>
          </div>
        )}
        {writeVisible && store.writePhase === "success" && (
          <>
            <div className="radio-cal-success" data-testid="safety-config-write-success">
              <CheckCircle2 size={14} />
              <span>
                {store.writeSummary?.succeeded ?? store.writeSummary?.results?.length ?? 0} parameter
                {store.writeSummary?.succeeded === 1 ? "" : "s"} verified on the vehicle.
              </span>
            </div>
            {rebootNote && (
              <div className="power-reboot" data-testid="safety-reboot-required">
                <AlertTriangle size={14} />
                Reboot required for this change to take effect.
              </div>
            )}
          </>
        )}
      </div>

      {/* --- Advanced --- */}
      <div className="safety-advanced">
        <button
          type="button"
          className="safety-advanced-toggle"
          onClick={() => setAdvancedOpen((o) => !o)}
          data-testid="safety-advanced-toggle"
        >
          {advancedOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <Settings2 size={14} />
          Advanced Safety Parameters
        </button>
        {advancedOpen && (
          <div className="safety-advanced-body" data-testid="safety-advanced-list">
            <p className="safety-row-note" data-testid="safety-advanced-note">
              Additional parameters reported by the connected flight controller.
            </p>
            {advancedCategories.length === 0 && (
              <div className="safety-row-note">No additional safety parameters on this vehicle.</div>
            )}
            {batteryExtra.length > 0 && (
              <div className="safety-advanced-cat" data-testid="safety-advanced-category-battery">
                <h4 className="safety-advanced-cat-title">Battery</h4>
                {batteryExtra.map((f) =>
                  f.options && f.options.length > 0 ? (
                    <EnumParamInput
                      key={f.id}
                      field={f}
                      value={fieldString(f.id, f.value)}
                      onChange={(v) => markTouched(f, v)}
                      disabled={writeDisabled}
                      error={fieldErrors[f.id]}
                      dataTestid={`safety-advanced-${f.id.toLowerCase()}`}
                    />
                  ) : (
                    <NumericParamInput
                      key={f.id}
                      field={f}
                      value={fieldString(f.id, f.value)}
                      onChange={(v) => markTouched(f, v)}
                      disabled={writeDisabled}
                      error={fieldErrors[f.id]}
                      dataTestid={`safety-advanced-${f.id.toLowerCase()}`}
                    />
                  ),
                )}
              </div>
            )}
            {fenceExtra.length > 0 && (
              <div className="safety-advanced-cat" data-testid="safety-advanced-category-geofence">
                <h4 className="safety-advanced-cat-title">GeoFence</h4>
                {fenceExtra.map((f) => {
                  const testid = `safety-advanced-${f.id.toLowerCase()}`;
                  if (f.options && f.options.length > 0) {
                    return (
                      <EnumParamInput
                        key={f.id}
                        field={f}
                        value={fieldString(f.id, f.value)}
                        onChange={(v) => markTouched(f, v)}
                        disabled={writeDisabled}
                        error={fieldErrors[f.id]}
                        dataTestid={testid}
                      />
                    );
                  }
                  if (f.bits && f.bits.length > 0) {
                    return (
                      <BitmaskEditor
                        key={f.id}
                        field={f}
                        value={bitmaskInt(f)}
                        disabled={writeDisabled}
                        onChange={(n) => markTouched(f, String(n))}
                        error={fieldErrors[f.id]}
                        dataTestid={testid}
                      />
                    );
                  }
                  return (
                    <NumericParamInput
                      key={f.id}
                      field={f}
                      value={fieldString(f.id, f.value)}
                      onChange={(v) => markTouched(f, v)}
                      disabled={writeDisabled}
                      error={fieldErrors[f.id]}
                      dataTestid={testid}
                    />
                  );
                })}
              </div>
            )}
            {advancedCategories.map((cat) => (
              <div
                className="safety-advanced-cat"
                key={cat.name}
                data-testid={`safety-advanced-category-${cat.name}`}
              >
                <h4 className="safety-advanced-cat-title">{cat.name}</h4>
                {cat.params.map((f) => {
                  const testid = `safety-advanced-${f.id.toLowerCase()}`;
                  if (f.options && f.options.length > 0) {
                    return (
                      <EnumParamInput
                        key={f.id}
                        field={f}
                        value={fieldString(f.id, f.value)}
                        onChange={(v) => markTouched(f, v)}
                        disabled={writeDisabled}
                        dataTestid={testid}
                        error={fieldErrors[f.id]}
                      />
                    );
                  }
                  if (f.bits && f.bits.length > 0) {
                    return (
                      <BitmaskEditor
                        key={f.id}
                        field={f}
                        value={bitmaskInt(f)}
                        disabled={writeDisabled}
                        onChange={(n) => markTouched(f, String(n))}
                        error={fieldErrors[f.id]}
                        dataTestid={testid}
                      />
                    );
                  }
                  return (
                    <NumericParamInput
                      key={f.id}
                      field={f}
                      value={fieldString(f.id, f.value)}
                      onChange={(v) => markTouched(f, v)}
                      disabled={writeDisabled}
                      dataTestid={testid}
                      error={fieldErrors[f.id]}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>

      {confirmOpen && (
        <ConfirmDialog rows={confirmRows} onCancel={() => setConfirmOpen(false)} onOk={handleConfirmWrite} />
      )}
    </PageShell>
  );
}
