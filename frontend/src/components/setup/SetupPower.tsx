import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  Battery,
  BatteryCharging,
  BatteryLow,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader,
  RefreshCw,
  RotateCcw,
  Save,
  Settings2,
  WifiOff,
  XCircle,
  Zap,
} from "lucide-react";

import { useTelemetry } from "../../hooks/useTelemetry";
import { usePowerSetup } from "../../hooks/usePowerSetup";
import { useParameters } from "../../context/ParameterContext";
import {
  calculateAmpsPerVolt,
  calculateVoltageMultiplier,
  type BatteryInstance,
  type PowerParamField,
  type PowerStatus,
  type PowerTelemetry,
} from "../../api/setup";

const HEALTH_LABELS: Record<string, string> = {
  NORMAL: "NORMAL",
  LOW: "LOW",
  CRITICAL: "CRITICAL",
  CHARGING: "CHARGING",
  DISABLED: "DISABLED",
  UNAVAILABLE: "UNAVAILABLE",
  STALE: "STALE",
  UNKNOWN: "UNKNOWN",
};

function HealthBadge({ status }: { status: string; detail?: string }) {
  const cls =
    status === "NORMAL" || status === "CHARGING"
      ? "power-health-good"
      : status === "LOW"
        ? "power-health-warn"
        : status === "CRITICAL"
          ? "power-health-bad"
          : "power-health-neutral";
  return (
    <span className={`power-health-badge ${cls}`} data-testid="power-health">
      {status === "CHARGING" ? <BatteryCharging size={13} /> : status === "LOW" ? <BatteryLow size={13} /> : <Battery size={13} />}
      {HEALTH_LABELS[status] ?? status}
    </span>
  );
}

function freshnessClass(telemetry: PowerTelemetry | undefined): string {
  if (!telemetry) return "power-telemetry-neutral";
  if (telemetry.stale) return "power-telemetry-bad";
  if (
    telemetry.voltage === null &&
    telemetry.current === null &&
    telemetry.remaining === null
  ) {
    return "power-telemetry-neutral";
  }
  return "power-telemetry-good";
}

function formatVoltage(v: number): string {
  return `${v.toFixed(2)} V`;
}
function formatCurrent(v: number): string {
  return `${v.toFixed(2)} A`;
}
function formatMah(v: number): string {
  return `${Math.round(v)} mAh`;
}
function formatTemp(v: number): string {
  return `${v.toFixed(1)} °C`;
}

function TelemetryCell({
  label,
  value,
  stale,
  formatter,
  dataTestid,
}: {
  label: string;
  value: number | null | undefined;
  stale: boolean;
  formatter: (v: number) => string;
  dataTestid: string;
}) {
  if (stale) {
    return (
      <div className="setup-fw-row power-cell" data-testid={dataTestid}>
        <span className="setup-fw-label">{label}</span>
        <span className="power-value-stale">Stale</span>
      </div>
    );
  }
  const shown = value === null || value === undefined ? "Unavailable" : formatter(value);
  return (
    <div className="setup-fw-row power-cell" data-testid={dataTestid}>
      <span className="setup-fw-label">{label}</span>
      <span className={value === null || value === undefined ? "power-value-na" : "setup-fw-value"}>
        {shown}
      </span>
    </div>
  );
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="setup-page" data-testid="setup-power">
       <div className="setup-page-header">
        <h2 className="setup-page-title">Power Setup</h2>
        <p className="setup-page-subtitle">
          Configure battery and power settings for the vehicle.
        </p>
      </div>
      {children}
    </div>
  );
}

function UnsupportedField({ field }: { field: PowerParamField }) {
  return (
    <div className="setup-fw-row power-cell" data-testid={`power-unsupported-${field.id}`}>
      <span className="setup-fw-label">{field.name}</span>
      <span className="power-value-na">Unsupported</span>
    </div>
  );
}

function NumericParamInput({
  field,
  stub,
  value,
  onChange,
  disabled,
  dataTestid,
}: {
  field: PowerParamField;
  stub: string;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  dataTestid: string;
}) {
  if (!field.supported) {
    return <UnsupportedField field={field} />;
  }
  const bounds =
    field.units === "V"
      ? "Voltage"
      : field.units === "mAh"
        ? "Capacity"
        : field.units === "s"
          ? "Time"
          : field.units === "A/V"
            ? "Scale"
            : "";
  return (
    <div className="setup-fw-row power-cell">
      <span className="setup-fw-label">
        {stub}
        {bounds ? <em className="power-bound-note">· {bounds}</em> : null}
      </span>
      <input
        type="number"
        step={field.increment != null && field.increment > 0 ? field.increment : "any"}
        min={field.min}
        max={field.max}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        data-testid={dataTestid}
        className="power-param-input"
      />
    </div>
  );
}

function EnumParamInput({
  field,
  value,
  onChange,
  disabled,
  dataTestid,
}: {
  field: PowerParamField;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  dataTestid: string;
}) {
  if (!field.supported) {
    return <UnsupportedField field={field} />;
  }
  if (field.options && field.options.length > 0) {
    return (
      <div className="setup-fw-row power-cell">
        <span className="setup-fw-label">{field.name}</span>
        <div className="power-enum-wrap">
          <select
            value={value}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            data-testid={dataTestid}
            className="power-param-select"
          >
            {field.options.map((o) => (
              <option key={String(o.code)} value={String(o.code)}>
                {o.label} ({o.code})
              </option>
            ))}
          </select>
          {field.decoded != null && value !== String(field.value ?? "") && (
            <span className="power-value-na">current: {field.decoded}</span>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="setup-fw-row power-cell">
      <span className="setup-fw-label">{field.name}</span>
      <input
        type="number"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        data-testid={dataTestid}
        className="power-param-input"
      />
    </div>
  );
}

function ReadOnlyParam({ field, notice }: { field: PowerParamField; notice?: string }) {
  if (!field.supported) {
    return <UnsupportedField field={field} />;
  }
  return (
    <div className="setup-fw-row power-cell" data-testid={`power-readonly-${field.id}`}>
      <span className="setup-fw-label">{field.name}</span>
      <span className="setup-fw-value">
        {field.decoded != null ? `${field.decoded} (${field.value})` : field.value != null ? field.value : "Unavailable"}
        {notice && <em className="power-safety-notice"> · {notice}</em>}
      </span>
    </div>
  );
}

export default function SetupPower() {
  const telemetry = useTelemetry();
  const store = useParameters();
  const { power, connectionLost, refresh } = usePowerSetup(telemetry.connected);

  const [draft, setDraft] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [configError, setConfigError] = useState<string | null>(null);
  const [writeVisible, setWriteVisible] = useState(false);
  const [pendingWrite, setPendingWrite] = useState(false);
  const [rebootNote, setRebootNote] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState<Record<number, boolean>>({});
  const [uavcanOpen, setUavcanOpen] = useState(false);
  const [calcVolt, setCalcVolt] = useState<{
    measured: string;
    sensor: string;
    result: string | null;
    error: string | null;
  }>({ measured: "", sensor: "", result: null, error: null });
  const [calcAmp, setCalcAmp] = useState<{
    measured: string;
    sensor: string;
    result: string | null;
    error: string | null;
  }>({ measured: "", sensor: "", result: null, error: null });

  const markTouched = (pid: string, value: string) => {
    setDraft((prev) => ({ ...prev, [pid]: value }));
    setTouched((prev) => new Set(prev).add(pid));
  };
  const clearEdits = useCallback(() => {
    setTouched(new Set());
    setDraft({});
    setRebootNote(false);
  }, []);

  const clearDrafts = useCallback(() => {
    setTouched(new Set());
    setDraft({});
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

  const rebootRequiredFor = (field: PowerParamField): boolean => {
    if (field.rebootRequired) return true;
    const meta = store.entries[field.id]?.metadata;
    return meta?.rebootRequired === true;
  };

  const handleApply = () => {
    setConfigError(null);
    const toStage: { pid: string; value: number }[] = [];
    const rebootIds: string[] = [];
    if (!power) return;
    for (const inst of power.instances) {
      const fields = [
        inst.monitor,
        inst.capacity,
        inst.thresholds.lowVolt,
        inst.thresholds.crtVolt,
        inst.thresholds.lowMah,
        inst.thresholds.crtMah,
        inst.thresholds.lowTimer,
        inst.calibration.voltMult,
        inst.calibration.ampPerVlt,
        inst.calibration.ampOffset,
        inst.calibration.vltOffset,
      ];
      for (const f of fields) {
        if (!f.supported) continue;
        const raw = fieldString(f.id, f.value);
        if (raw.trim() === "" || !Number.isFinite(Number(raw))) {
          setConfigError(`${f.name} (${f.id}) must be a numeric value.`);
          return;
        }
        const n = Number(raw);
        toStage.push({ pid: f.id, value: n });
        if (rebootRequiredFor(f)) rebootIds.push(f.id);
      }
    }
    for (const item of toStage) {
      const result = store.stageValue(item.pid, item.value);
      if (!result.ok) {
        setConfigError(result.error ?? `Unable to stage ${item.pid}.`);
        return;
      }
    }
    setRebootNote(rebootIds.length > 0);
    setWriteVisible(true);
    setPendingWrite(true);
  };

  const powerParamsStaged = useMemo(() => {
    if (!store.staged) return 0;
    return Object.keys(store.staged).filter((pid) =>
      power?.instances.some(
        (i) => pid === i.prefix ? true : pid.startsWith(i.prefix),
      ),
    ).length;
  }, [store.staged, power]);

  useEffect(() => {
    if (!pendingWrite) return;
    if (powerParamsStaged > 0 && store.connection === "READY") {
      setPendingWrite(false);
      void store.executeWrite();
    } else if (powerParamsStaged === 0) {
      setPendingWrite(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingWrite, powerParamsStaged, store.connection, store.executeWrite]);

  const handleRevert = () => {
    setConfigError(null);
    if (powerParamsStaged > 0) store.discardAll();
    clearEdits();
    setWriteVisible(false);
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

  const runVoltageCalc = async () => {
    setCalcVolt((p) => ({ ...p, result: null, error: null }));
    const m = Number(calcVolt.measured);
    const s = Number(calcVolt.sensor);
    const base = power?.instances[0]?.calibration.voltMult?.value ?? 10.1;
    if (!Number.isFinite(m) || m <= 0) {
      setCalcVolt((p) => ({ ...p, error: "Enter the measured (multimeter) voltage." }));
      return;
    }
    if (!Number.isFinite(s) || s <= 0) {
      setCalcVolt((p) => ({ ...p, error: "Enter the sensor-reported voltage." }));
      return;
    }
    try {
      const res = await calculateVoltageMultiplier({
        currentMultiplier: base,
        measuredVoltage: m,
        sensorVoltage: s,
      });
      if (res.success && res.calculatedMultiplier != null) {
        setCalcVolt((p) => ({
          ...p,
          result: `New voltage multiplier: ${res.calculatedMultiplier}`,
        }));
      } else {
        setCalcVolt((p) => ({ ...p, error: res.message || "Calculation failed." }));
      }
    } catch {
      setCalcVolt((p) => ({ ...p, error: "Calculation could not be completed." }));
    }
  };

  const runAmpCalc = async () => {
    setCalcAmp((p) => ({ ...p, result: null, error: null }));
    const m = Number(calcAmp.measured);
    const s = Number(calcAmp.sensor);
    const base = power?.instances[0]?.calibration.ampPerVlt?.value ?? 17.0;
    if (!Number.isFinite(m) || m <= 0) {
      setCalcAmp((p) => ({ ...p, error: "Enter the measured (clamp meter) current." }));
      return;
    }
    if (!Number.isFinite(s) || s <= 0) {
      setCalcAmp((p) => ({ ...p, error: "Enter the sensor-reported current." }));
      return;
    }
    try {
      const res = await calculateAmpsPerVolt({
        currentAmpsPerVolt: base,
        measuredCurrent: m,
        sensorCurrent: s,
      });
      if (res.success && res.calculatedAmpsPerVolt != null) {
        setCalcAmp((p) => ({
          ...p,
          result: `New amps per volt: ${res.calculatedAmpsPerVolt}`,
        }));
      } else {
        setCalcAmp((p) => ({ ...p, error: res.message || "Calculation failed." }));
      }
    } catch {
      setCalcAmp((p) => ({ ...p, error: "Calculation could not be completed." }));
    }
  };

  const connecting = telemetry.connectionState === "CONNECTING";
  const lost =
    !telemetry.connected && !connecting && telemetry.disconnectReason != null;
  const unsupported = power?.success === true && power.supported === false;
  const syncing = power === null || power.state === "SYNCING";
  const failed =
    !syncing &&
    !unsupported &&
    (power?.success !== true || power.state === "ERROR");

  if (!telemetry.connected) {
    const reason = connecting
      ? "Establishing a MAVLink link with the flight controller."
      : lost
        ? `Reason: ${telemetry.disconnectReason}`
        : "Connect a Pixhawk or MAVLink vehicle to inspect its battery power.";
    return (
      <PageShell>
        <div
          className="setup-disconnected"
          data-testid={connecting ? "setup-power-connecting" : lost ? "setup-power-lost" : "setup-power-waiting"}
        >
          {connecting ? (
            <Loader size={26} className="setup-spinner" />
          ) : lost ? (
            <WifiOff size={26} />
          ) : (
            <Battery size={26} />
          )}
          <p className="setup-disconnected-title">
            {connecting
              ? "Connecting…"
              : lost
                ? "MAVLink connection lost"
                : "Waiting for vehicle"}
          </p>
          {lost && (
            <p className="setup-disconnected-reason" data-testid="setup-power-lost-reason">
              {reason}
            </p>
          )}
          <p className="setup-disconnected-hint">{reason}</p>
          {connectionLost && (
            <p className="setup-note" data-testid="setup-power-connection-lost">
              Battery telemetry was cleared. It will be restored automatically after reconnect.
            </p>
          )}
        </div>
      </PageShell>
    );
  }

  if (syncing) {
    return (
      <PageShell>
        <section className="setup-card">
          <div className="setup-fw-loading" data-testid="setup-power-syncing">
            <Loader size={18} className="setup-spinner" />
            Synchronizing power configuration…
          </div>
        </section>
      </PageShell>
    );
  }

  if (failed) {
    return (
      <PageShell>
        <section className="setup-card" data-testid="setup-power-error">
          <div className="setup-fw-error">
            <AlertCircle size={18} />
            <span>
              {power?.state === "ERROR"
                ? "Parameter synchronization failed — the power configuration could not be read."
                : "Power information could not be retrieved."}
            </span>
          </div>
          <button
            type="button"
            className="setup-refresh-btn"
            onClick={refresh}
            data-testid="setup-power-retry"
          >
            <RefreshCw size={13} />
            Retry
          </button>
        </section>
      </PageShell>
    );
  }

  const info = power as PowerStatus & { success: true };

  if (unsupported) {
    return (
      <PageShell>
        <section className="setup-card" data-testid="setup-power-unsupported">
          <div className="setup-fw-error">
            <AlertTriangle size={18} />
            <div>
              <p className="setup-fw-error-title">Unsupported vehicle</p>
              <p>
                YantraYug Power Setup is ArduCopter-only. The connected vehicle is
                not supported.
              </p>
              {info.unsupportedReason && (
                <p className="setup-fw-error-reason">{info.unsupportedReason}</p>
              )}
            </div>
          </div>
        </section>
      </PageShell>
    );
  }

  const noBatteryTelemetry = info.state === "NO_BATTERY_TELEMETRY";
  const staleTelemetry = info.state === "STALE_TELEMETRY";

  return (
    <PageShell>
      {configError && (
        <div className="frame-error" data-testid="power-config-error">
          <AlertTriangle size={14} />
          {configError}
        </div>
      )}

      {noBatteryTelemetry && (
        <div className="power-page-message" data-testid="power-no-battery-telemetry">
          <AlertCircle size={14} />
          No battery telemetry received yet — values are shown as unavailable until the
          vehicle reports a SYS_STATUS or BATTERY_STATUS frame.
        </div>
      )}
      {staleTelemetry && (
        <div className="power-page-message power-page-message-stale" data-testid="power-stale-telemetry">
          <AlertTriangle size={14} />
          Battery telemetry stale — live values are not being refreshed.
        </div>
      )}

      {info.instances.map((inst: BatteryInstance) => (
        <CompactPowerInstance
          key={inst.instance}
          inst={inst}
          staleTelemetry={staleTelemetry || inst.telemetry.stale}
          advancedOpen={advancedOpen[inst.instance] ?? false}
          onToggleAdvanced={() =>
            setAdvancedOpen((prev) => ({ ...prev, [inst.instance]: !(prev[inst.instance] ?? false) }))
          }
          fieldString={(pid, fb) => fieldString(pid, fb)}
          markTouched={markTouched}
          disabled={store.writePhase === "running"}
          writeRunning={store.writePhase === "running"}
          calcVolt={calcVolt}
          calcAmp={calcAmp}
          setCalcVolt={setCalcVolt}
          setCalcAmp={setCalcAmp}
          onVoltCalc={runVoltageCalc}
          onAmpCalc={runAmpCalc}
        />
      ))}

      <section className="power-esc-section" data-testid="power-esc-calibration">
        <h3 className="setup-card-title"><Zap size={14} /> ESC PWM Minimum and Maximum Calibration</h3>
        <div className="power-esc-warning">
          <AlertTriangle size={15} />
          <span>Propellers must be removed before ESC calibration. You must use a USB connection. ESC calibration is unavailable in this build.</span>
        </div>
        <button type="button" className="setup-params-btn" disabled data-testid="power-esc-calibrate">
          Calibrate unavailable
        </button>
      </section>

      <div className="power-actions" data-testid="power-config-actions">
        <div className="power-config-actions">
          <button
            type="button"
            className="setup-params-btn setup-params-btn-danger"
            onClick={handleRevert}
            disabled={store.writePhase === "running"}
            data-testid="power-config-revert"
          >
            <RotateCcw size={13} />
            Revert
          </button>
          <button
            type="button"
            className="setup-params-btn setup-params-btn-primary"
            onClick={handleApply}
            disabled={store.writePhase === "running" || store.connection !== "READY"}
            data-testid="power-config-apply"
          >
            {store.writePhase === "running" ? (
              <Loader size={13} className="setup-spinner" />
            ) : (
              <Save size={13} />
            )}
            {store.writePhase === "running" ? "Applying…" : "Apply Power Configuration"}
          </button>
        </div>
        {store.writePhase === "running" && (
          <div className="frame-write-running" data-testid="power-config-writing">
            <Loader size={14} className="setup-spinner" />
            Writing
            {store.writeProgress.currentParamId ? ` ${store.writeProgress.currentParamId}` : ""}…
            <span>
              {store.writeProgress.completed} / {store.writeProgress.total} verified
            </span>
          </div>
        )}
        {powerParamsStaged > 0 && (
          <div className="radio-unsaved">
            <RotateCcw size={14} />
            <span>
              {powerParamsStaged} value{powerParamsStaged === 1 ? "" : "s"} staged — the vehicle
              has not been modified yet.
            </span>
          </div>
        )}
        {writeVisible && store.writeError && store.writePhase !== "running" && (
          <div className="frame-error" data-testid="power-config-write-error">
            <XCircle size={14} />
            {store.writeError.message ?? "Failed to apply parameter — previous values were preserved."}
          </div>
        )}
        {writeVisible && store.writePhase === "success" && (
          <>
            <div className="radio-cal-success" data-testid="power-config-write-success">
              <CheckCircle2 size={14} />
              <span>
                {store.writeSummary?.succeeded ?? store.writeSummary?.results?.length ?? 0} parameter
                {store.writeSummary?.succeeded === 1 ? "" : "s"} verified on the vehicle.
              </span>
            </div>
            {rebootNote && (
              <div className="power-reboot" data-testid="power-reboot-required">
                <AlertTriangle size={14} />
                Reboot required for this change to take effect.
              </div>
            )}
          </>
        )}
      </div>

      <div className="power-options" data-testid="power-options">
        <label className="power-checkbox-row">
          <input type="checkbox" checked={uavcanOpen} onChange={(e) => setUavcanOpen(e.target.checked)} />
          <span>Show UAVCAN Settings</span>
        </label>
        <label className="power-checkbox-row">
          <input
            type="checkbox"
            checked={Object.values(advancedOpen).some(Boolean)}
            onChange={(e) => setAdvancedOpen(Object.fromEntries(info.instances.map((instance) => [instance.instance, e.target.checked])))}
          />
          <span>Show Advanced Settings</span>
        </label>
        {uavcanOpen && <span className="power-inline-note">No UAVCAN power parameters are exposed by this firmware.</span>}
      </div>

    </PageShell>
  );
}

function CompactPowerInstance({
  inst,
  staleTelemetry,
  advancedOpen,
  onToggleAdvanced,
  fieldString,
  markTouched,
  disabled,
  writeRunning,
  calcVolt,
  calcAmp,
  setCalcVolt,
  setCalcAmp,
  onVoltCalc,
  onAmpCalc,
}: {
  inst: BatteryInstance;
  staleTelemetry: boolean;
  advancedOpen: boolean;
  onToggleAdvanced: () => void;
  fieldString: (pid: string, fb: number | null) => string;
  markTouched: (pid: string, value: string) => void;
  disabled: boolean;
  writeRunning: boolean;
  calcVolt: { measured: string; sensor: string; result: string | null; error: string | null };
  calcAmp: { measured: string; sensor: string; result: string | null; error: string | null };
  setCalcVolt: React.Dispatch<React.SetStateAction<{ measured: string; sensor: string; result: string | null; error: string | null }>>;
  setCalcAmp: React.Dispatch<React.SetStateAction<{ measured: string; sensor: string; result: string | null; error: string | null }>>;
  onVoltCalc: () => void;
  onAmpCalc: () => void;
}) {
  void setCalcVolt;
  void setCalcAmp;
  const t = inst.telemetry;
  const hasTelemetry = t.voltage != null || t.current != null || t.remaining != null || t.consumedMah != null;
  const supportedThresholds = [
    [inst.thresholds.lowVolt, "Low voltage"],
    [inst.thresholds.crtVolt, "Critical voltage"],
    [inst.thresholds.lowMah, "Low capacity"],
    [inst.thresholds.crtMah, "Critical capacity"],
    [inst.thresholds.lowTimer, "Low voltage timer"],
  ] as const;
  const supportedScaling = [
    [inst.calibration.voltMult, "Voltage divider"],
    [inst.calibration.ampPerVlt, "Amps per volt"],
    [inst.calibration.ampOffset, "Current offset"],
    [inst.calibration.vltOffset, "Voltage offset"],
  ] as const;
  return (
    <section className="power-battery-form" data-testid={`power-instance-${inst.instance}`}>
      {hasTelemetry && <div className="power-inline-telemetry" data-testid={`power-status-${inst.instance}`}>
        <strong>{inst.label}</strong>
        <span data-testid={inst.instance === 1 ? "power-health" : `power-health-${inst.instance}`}>{inst.health.status}</span>
        <span data-testid={`power-telemetry-freshness-${inst.instance}`}>{staleTelemetry ? "STALE" : t.receivedAt ? "LIVE" : "UNAVAILABLE"}</span>
        <span data-testid={`power-voltage-${inst.instance}`}>Battery: {staleTelemetry ? "Stale" : t.voltage == null ? "Unavailable" : `${t.voltage.toFixed(2)} V`}</span>
        <span data-testid={`power-current-${inst.instance}`}>{staleTelemetry ? "Stale" : t.current == null ? "Unavailable" : `${t.current.toFixed(2)} A`}</span>
        <span data-testid={`power-consumed-${inst.instance}`}>{staleTelemetry || t.consumedMah == null ? "Unavailable" : `${Math.round(t.consumedMah)} mAh`}</span>
        <span data-testid={`power-remaining-${inst.instance}`}>{staleTelemetry || t.remaining == null ? "Unavailable" : `${Math.round(t.remaining)} %`}</span>
        <span data-testid={`power-temperature-${inst.instance}`}>{t.temperature == null ? "Unavailable" : `${t.temperature.toFixed(1)} °C`}</span>
        <span data-testid={`power-chargestate-${inst.instance}`}>{t.chargeState === "UNDEFINED" ? "Unavailable" : t.chargeState}</span>
      </div>}

      <div className="power-form-section" data-testid={`power-monitor-${inst.instance}`}>
        <h3>Battery</h3>
        <div className="power-form-grid">
          <UnavailablePowerField label="Number of Cells (in Series)" unit="S" testId="power-cell-count" />
          <UnavailablePowerField label="Full Voltage (per cell)" unit="V" testId="power-full-cell-voltage" />
          <UnavailablePowerField label="Empty Voltage (per cell)" unit="V" testId="power-empty-cell-voltage" />
          <EnumParamInput field={inst.monitor} value={fieldString(inst.monitor.id, inst.monitor.value)} onChange={(v) => markTouched(inst.monitor.id, v)} disabled={disabled} dataTestid={`power-monitor-select-${inst.instance}`} />
          {inst.capacity.supported && <NumericParamInput field={inst.capacity} stub="Battery Capacity" value={fieldString(inst.capacity.id, inst.capacity.value)} onChange={(v) => markTouched(inst.capacity.id, v)} disabled={disabled} dataTestid={`power-capacity-${inst.instance}`} />}
          {supportedScaling.filter(([f]) => f.supported && f.id !== "BATT_VOLT_MULT" && f.id !== "BATT_AMP_PERVLT").map(([field, label]) => (
            <NumericParamInput key={field.id} field={field} stub={label} value={fieldString(field.id, field.value)} onChange={(v) => markTouched(field.id, v)} disabled={disabled} dataTestid={`power-${field.id.toLowerCase()}-${inst.instance}`} />
          ))}
          {inst.calibration.voltMult.supported ? <ScalingRow field={inst.calibration.voltMult} label="Voltage divider" value={fieldString(inst.calibration.voltMult.id, inst.calibration.voltMult.value)} onChange={(v) => markTouched(inst.calibration.voltMult.id, v)} onCalculate={onVoltCalc} calculateTestId="power-calc-volt-run" disabled={disabled || writeRunning} /> : <UnavailablePowerField label="Voltage divider" unit="" testId="power-voltage-divider" actionTestId="power-calc-volt-run" />}
          {inst.calibration.ampPerVlt.supported ? <ScalingRow field={inst.calibration.ampPerVlt} label="Amps per volt" value={fieldString(inst.calibration.ampPerVlt.id, inst.calibration.ampPerVlt.value)} onChange={(v) => markTouched(inst.calibration.ampPerVlt.id, v)} onCalculate={onAmpCalc} calculateTestId="power-calc-amp-run" disabled={disabled || writeRunning} /> : <UnavailablePowerField label="Amps per volt" unit="" testId="power-amps-per-volt" actionTestId="power-calc-amp-run" />}
        </div>
        <div className="power-battery-range" data-testid="power-battery-range">
          <span>Battery Max: unavailable</span>
          <span>Battery Min: unavailable</span>
        </div>
        {inst.monitor.value === 0 && <span className="power-inline-note" data-testid="power-monitor-disabled">Battery monitoring disabled.</span>}
        {!inst.capacity.supported && <span className="power-inline-note" data-testid={`power-unsupported-${inst.capacity.id}`}> · Unsupported on this firmware.</span>}
      </div>

      {supportedThresholds.some(([f]) => f.supported) && (
        <div className="power-form-section" data-testid={`power-thresholds-${inst.instance}`}>
          <h3>Battery limits</h3>
          <div className="power-form-grid">
            {supportedThresholds.filter(([f]) => f.supported).map(([field, label]) => (
              <NumericParamInput key={field.id} field={field} stub={label} value={fieldString(field.id, field.value)} onChange={(v) => markTouched(field.id, v)} disabled={disabled} dataTestid={`power-${field.id.toLowerCase()}-${inst.instance}`} />
            ))}
          </div>
        </div>
      )}

      {(inst.thresholds.fsLowAct.supported || inst.thresholds.fsCrtAct.supported) && (
        <div className="power-inline-note">
          Battery failsafe actions are configured in Safety.
          {inst.thresholds.fsLowAct.supported && <span data-testid={`power-readonly-${inst.thresholds.fsLowAct.id}`}>{inst.thresholds.fsLowAct.decoded ?? "Unavailable"} Configured in Safety</span>}
          {inst.thresholds.fsCrtAct.supported && <span data-testid={`power-readonly-${inst.thresholds.fsCrtAct.id}`}>{inst.thresholds.fsCrtAct.decoded ?? "Unavailable"} Configured in Safety</span>}
        </div>
      )}

      {(
        <div className="power-form-section" data-testid={`power-calibration-${inst.instance}`}>
          <h3 className="power-form-subheading">Calibration helpers</h3>
          <div className="power-calc-measurements">
            {inst.calibration.voltMult.supported && <>
              <input type="number" value={calcVolt.measured} onChange={(e) => setCalcVolt((p) => ({ ...p, measured: e.target.value }))} data-testid="power-calc-volt-measured" />
              <input type="number" value={calcVolt.sensor} onChange={(e) => setCalcVolt((p) => ({ ...p, sensor: e.target.value }))} data-testid="power-calc-volt-sensor" />
              <button type="button" className="setup-params-btn" onClick={onVoltCalc} disabled={writeRunning} data-testid="power-calc-volt-measure">Calculate</button>
            </>}
            {inst.calibration.ampPerVlt.supported && <>
              <input type="number" value={calcAmp.measured} onChange={(e) => setCalcAmp((p) => ({ ...p, measured: e.target.value }))} data-testid="power-calc-amp-measured" />
              <input type="number" value={calcAmp.sensor} onChange={(e) => setCalcAmp((p) => ({ ...p, sensor: e.target.value }))} data-testid="power-calc-amp-sensor" />
              <button type="button" className="setup-params-btn" onClick={onAmpCalc} disabled={writeRunning} data-testid="power-calc-amp-measure">Calculate</button>
            </>}
          </div>
          {calcVolt.result && <span className="power-calc-result" data-testid="power-calc-volt-result">{calcVolt.result}</span>}
          {calcVolt.error && <span className="power-calc-error" data-testid="power-calc-volt-error">{calcVolt.error}</span>}
          {calcAmp.result && <span className="power-calc-result" data-testid="power-calc-amp-result">{calcAmp.result}</span>}
          {calcAmp.error && <span className="power-calc-error" data-testid="power-calc-amp-error">{calcAmp.error}</span>}
        </div>
      )}

      {inst.advanced.length > 0 && (
        <div className="power-form-section" data-testid={`power-advanced-${inst.instance}`}>
          <button type="button" className="power-advanced-toggle" onClick={onToggleAdvanced} data-testid={`power-advanced-toggle-${inst.instance}`}>
            {advancedOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />} Show Advanced Settings
          </button>
          {advancedOpen && <div className="power-form-grid" data-testid={`power-advanced-list-${inst.instance}`}>
            {inst.advanced.map((field) => <div className="setup-fw-row power-cell" key={field.id} data-testid={`power-advanced-${field.id}`}><span className="setup-fw-label">{field.name}</span><span className="setup-fw-value">{field.value ?? "Unavailable"}</span></div>)}
          </div>}
        </div>
      )}
    </section>
  );
}

function UnavailablePowerField({ label, unit, testId, actionTestId }: { label: string; unit: string; testId: string; actionTestId?: string }) {
  return <div className="power-unavailable-field" data-testid={testId}>
    <span>{label}</span><input disabled placeholder="Unavailable" aria-label={label} /><em>{unit}</em>{actionTestId && <button type="button" className="setup-params-btn" disabled data-testid={actionTestId}>Calculate</button>}
  </div>;
}

function ScalingRow({ field, label, value, onChange, onCalculate, calculateTestId, disabled }: { field: PowerParamField; label: string; value: string; onChange: (value: string) => void; onCalculate: () => void; calculateTestId: string; disabled: boolean }) {
  return <div className="power-scaling-row">
    <label htmlFor={field.id}>{label}</label>
    <input id={field.id} type="number" value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} data-testid={`power-${field.id.toLowerCase()}-value`} />
    <button type="button" className="setup-params-btn" onClick={onCalculate} disabled={disabled} data-testid={calculateTestId}>Calculate</button>
  </div>;
}

function PowerInstance({
  inst,
  staleTelemetry,
  advancedOpen,
  onToggleAdvanced,
  fieldString,
  markTouched,
  disabled,
  writeRunning,
  calcVolt,
  calcAmp,
  setCalcVolt,
  setCalcAmp,
  onVoltCalc,
  onAmpCalc,
}: {
  inst: BatteryInstance;
  staleTelemetry: boolean;
  advancedOpen: boolean;
  onToggleAdvanced: () => void;
  fieldString: (pid: string, fb: number | null) => string;
  markTouched: (pid: string, value: string) => void;
  disabled: boolean;
  writeRunning: boolean;
  calcVolt: { measured: string; sensor: string; result: string | null; error: string | null };
  calcAmp: { measured: string; sensor: string; result: string | null; error: string | null };
  setCalcVolt: React.Dispatch<React.SetStateAction<{ measured: string; sensor: string; result: string | null; error: string | null }>>;
  setCalcAmp: React.Dispatch<React.SetStateAction<{ measured: string; sensor: string; result: string | null; error: string | null }>>;
  onVoltCalc: () => void;
  onAmpCalc: () => void;
}) {
  const t = inst.telemetry;
  return (
    <div className="power-instance" data-testid={`power-instance-${inst.instance}`}>
      <section className="power-battery-workflow" data-testid={`power-status-${inst.instance}`}>
        <h3 className="setup-card-title">
          <Zap size={14} />
          {inst.label} — Live telemetry
          <HealthBadge status={inst.health.status} detail={inst.health.detail} />
        </h3>
        <div className={`power-telemetry-frame ${freshnessClass(t)}`} data-testid={`power-telemetry-freshness-${inst.instance}`}>
          {t.stale ? "STALE TELEMETRY" : t.receivedAt ? "LIVE" : "UNAVAILABLE"}
        </div>
        <div className="setup-fw-grid">
          <TelemetryCell
            label="Voltage"
            value={t.voltage}
            stale={staleTelemetry}
            formatter={formatVoltage}
            dataTestid={`power-voltage-${inst.instance}`}
          />
          <TelemetryCell
            label="Current"
            value={t.current}
            stale={staleTelemetry}
            formatter={formatCurrent}
            dataTestid={`power-current-${inst.instance}`}
          />
          <TelemetryCell
            label="Consumed"
            value={t.consumedMah}
            stale={staleTelemetry}
            formatter={formatMah}
            dataTestid={`power-consumed-${inst.instance}`}
          />
          <TelemetryCell
            label="Remaining"
            value={t.remaining}
            stale={staleTelemetry}
            formatter={(v) => `${Math.round(v)} %`}
            dataTestid={`power-remaining-${inst.instance}`}
          />
          <TelemetryCell
            label="Temperature"
            value={t.temperature}
            stale={staleTelemetry}
            formatter={formatTemp}
            dataTestid={`power-temperature-${inst.instance}`}
          />
          <div className="setup-fw-row power-cell" data-testid={`power-chargestate-${inst.instance}`}>
            <span className="setup-fw-label">Status</span>
            <span className="setup-fw-value">
              {t.chargeState && t.chargeState !== "UNDEFINED" ? t.chargeState : "Unavailable"}
            </span>
          </div>
        </div>
        {inst.health.detail && (
          <p className="setup-note" data-testid={`power-health-detail-${inst.instance}`}>
            {inst.health.detail}
          </p>
        )}
      </section>

      {/* Battery monitor + capacity */}
      <div className="power-subsection" data-testid={`power-monitor-${inst.instance}`}>
        <h3 className="setup-card-title">Battery configuration</h3>
        <div className="setup-fw-grid">
          <EnumParamInput
            field={inst.monitor}
            value={fieldString(inst.monitor.id, inst.monitor.value)}
            onChange={(v) => markTouched(inst.monitor.id, v)}
            disabled={disabled}
            dataTestid={`power-monitor-select-${inst.instance}`}
          />
          <NumericParamInput
            field={inst.capacity}
            stub="Battery Capacity"
            value={fieldString(inst.capacity.id, inst.capacity.value)}
            onChange={(v) => markTouched(inst.capacity.id, v)}
            disabled={disabled}
            dataTestid={`power-capacity-${inst.instance}`}
          />
        </div>
        <p className="setup-note">
          BATT_MONITOR selects the battery monitoring hardware (Disabled = 0). Changes require a
          reboot before they take effect.
        </p>
      </div>

      {/* Thresholds */}
      <div className="power-subsection" data-testid={`power-thresholds-${inst.instance}`}>
        <h3 className="setup-card-title">Battery limits</h3>
        <div className="setup-fw-grid">
          <NumericParamInput
            field={inst.thresholds.lowVolt}
            stub="Low Voltage Threshold"
            value={fieldString(inst.thresholds.lowVolt.id, inst.thresholds.lowVolt.value)}
            onChange={(v) => markTouched(inst.thresholds.lowVolt.id, v)}
            disabled={disabled}
            dataTestid={`power-lowvolt-${inst.instance}`}
          />
          <NumericParamInput
            field={inst.thresholds.crtVolt}
            stub="Critical Voltage Threshold"
            value={fieldString(inst.thresholds.crtVolt.id, inst.thresholds.crtVolt.value)}
            onChange={(v) => markTouched(inst.thresholds.crtVolt.id, v)}
            disabled={disabled}
            dataTestid={`power-crtvolt-${inst.instance}`}
          />
          <NumericParamInput
            field={inst.thresholds.lowMah}
            stub="Low Capacity Threshold"
            value={fieldString(inst.thresholds.lowMah.id, inst.thresholds.lowMah.value)}
            onChange={(v) => markTouched(inst.thresholds.lowMah.id, v)}
            disabled={disabled}
            dataTestid={`power-lowmah-${inst.instance}`}
          />
          <NumericParamInput
            field={inst.thresholds.crtMah}
            stub="Critical Capacity Threshold"
            value={fieldString(inst.thresholds.crtMah.id, inst.thresholds.crtMah.value)}
            onChange={(v) => markTouched(inst.thresholds.crtMah.id, v)}
            disabled={disabled}
            dataTestid={`power-crtmah-${inst.instance}`}
          />
          <NumericParamInput
            field={inst.thresholds.lowTimer}
            stub="Low Battery Timer"
            value={fieldString(inst.thresholds.lowTimer.id, inst.thresholds.lowTimer.value)}
            onChange={(v) => markTouched(inst.thresholds.lowTimer.id, v)}
            disabled={disabled}
            dataTestid={`power-lowtimer-${inst.instance}`}
          />
          <ReadOnlyParam
            field={inst.thresholds.fsLowAct}
            notice={inst.thresholds.fsLowAct.readOnlyNotice ?? "Configured in Safety"}
          />
          <ReadOnlyParam
            field={inst.thresholds.fsCrtAct}
            notice={inst.thresholds.fsCrtAct.readOnlyNotice ?? "Configured in Safety"}
          />
        </div>
        <p className="setup-note">
          These thresholds are used by ArduPilot for low/critical battery detection. The GCS
          only reads and configures the vehicle's own failsafe parameters — it never triggers
          a failsafe itself.
        </p>
      </div>

      {/* Calibration */}
      <div className="power-subsection" data-testid={`power-calibration-${inst.instance}`}>
        <h3 className="setup-card-title">Voltage and current scaling</h3>
        <div className="setup-fw-grid">
          <NumericParamInput
            field={inst.calibration.voltMult}
            stub="Voltage Multiplier"
            value={fieldString(inst.calibration.voltMult.id, inst.calibration.voltMult.value)}
            onChange={(v) => markTouched(inst.calibration.voltMult.id, v)}
            disabled={disabled}
            dataTestid={`power-voltmult-${inst.instance}`}
          />
          <NumericParamInput
            field={inst.calibration.ampPerVlt}
            stub="Amps per Volt"
            value={fieldString(inst.calibration.ampPerVlt.id, inst.calibration.ampPerVlt.value)}
            onChange={(v) => markTouched(inst.calibration.ampPerVlt.id, v)}
            disabled={disabled}
            dataTestid={`power-amppervlt-${inst.instance}`}
          />
          <NumericParamInput
            field={inst.calibration.ampOffset}
            stub="Amps Offset"
            value={fieldString(inst.calibration.ampOffset.id, inst.calibration.ampOffset.value)}
            onChange={(v) => markTouched(inst.calibration.ampOffset.id, v)}
            disabled={disabled}
            dataTestid={`power-ampoffset-${inst.instance}`}
          />
          <NumericParamInput
            field={inst.calibration.vltOffset}
            stub="Voltage Offset"
            value={fieldString(inst.calibration.vltOffset.id, inst.calibration.vltOffset.value)}
            onChange={(v) => markTouched(inst.calibration.vltOffset.id, v)}
            disabled={disabled}
            dataTestid={`power-vltoffset-${inst.instance}`}
          />
        </div>

        <div className="power-calc-grid">
          <div className="power-calc" data-testid="power-calc-voltage">
            <p className="power-calc-title">Voltage Multiplier Calculation</p>
            <label className="power-calc-field">
              <span>Measured voltage (multimeter)</span>
              <input
                type="number"
                step="any"
                value={calcVolt.measured}
                disabled={writeRunning}
                onChange={(e) => setCalcVolt((p) => ({ ...p, measured: e.target.value }))}
                data-testid="power-calc-volt-measured"
              />
            </label>
            <label className="power-calc-field">
              <span>Sensor-reported voltage</span>
              <input
                type="number"
                step="any"
                value={calcVolt.sensor}
                disabled={writeRunning}
                onChange={(e) => setCalcVolt((p) => ({ ...p, sensor: e.target.value }))}
                data-testid="power-calc-volt-sensor"
              />
            </label>
            <button
              type="button"
              className="setup-params-btn setup-params-btn-primary"
              onClick={onVoltCalc}
              disabled={writeRunning}
              data-testid="power-calc-volt-run"
            >
              Calculate
            </button>
            {calcVolt.result && (
              <p className="power-calc-result" data-testid="power-calc-volt-result">
                {calcVolt.result}
              </p>
            )}
            {calcVolt.error && (
              <p className="power-calc-error" data-testid="power-calc-volt-error">
                {calcVolt.error}
              </p>
            )}
          </div>

          <div className="power-calc" data-testid="power-calc-amps">
            <p className="power-calc-title">Amps per Volt Calculation</p>
            <label className="power-calc-field">
              <span>Measured current (clamp meter)</span>
              <input
                type="number"
                step="any"
                value={calcAmp.measured}
                disabled={writeRunning}
                onChange={(e) => setCalcAmp((p) => ({ ...p, measured: e.target.value }))}
                data-testid="power-calc-amp-measured"
              />
            </label>
            <label className="power-calc-field">
              <span>Sensor-reported current</span>
              <input
                type="number"
                step="any"
                value={calcAmp.sensor}
                disabled={writeRunning}
                onChange={(e) => setCalcAmp((p) => ({ ...p, sensor: e.target.value }))}
                data-testid="power-calc-amp-sensor"
              />
            </label>
            <button
              type="button"
              className="setup-params-btn setup-params-btn-primary"
              onClick={onAmpCalc}
              disabled={writeRunning}
              data-testid="power-calc-amp-run"
            >
              Calculate
            </button>
            {calcAmp.result && (
              <p className="power-calc-result" data-testid="power-calc-amp-result">
                {calcAmp.result}
              </p>
            )}
            {calcAmp.error && (
              <p className="power-calc-error" data-testid="power-calc-amp-error">
                {calcAmp.error}
              </p>
            )}
          </div>
        </div>
        <p className="setup-note">
          The calculation assistants are configuration helpers only — they never measure
          anything and never write to the vehicle. You must enter both readings yourself;
          apply the resulting value through the verified pipeline above.
        </p>
      </div>

      {inst.advanced.length > 0 && (
        <div className="power-subsection power-advanced-section" data-testid={`power-advanced-${inst.instance}`}>
          <button
            type="button"
            className="power-advanced-toggle"
            onClick={onToggleAdvanced}
            data-testid={`power-advanced-toggle-${inst.instance}`}
          >
            {advancedOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
            <Settings2 size={15} />
            Advanced Power Settings
          </button>
          {advancedOpen && (
            <div className="setup-fw-grid" data-testid={`power-advanced-list-${inst.instance}`}>
              {inst.advanced.map((a) => (
                <div className="setup-fw-row power-cell" key={a.id} data-testid={`power-advanced-${a.id}`}>
                  <span className="setup-fw-label">
                    {a.name}
                    {a.units && <em className="power-bound-note"> · {a.units}</em>}
                  </span>
                  <span className="setup-fw-value">
                    {a.value != null ? a.value : "Unavailable"}
                    {a.rebootRequired && (
                      <em className="power-safety-notice"> · reboot required</em>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}
          <p className="setup-note">
            Only parameters actually present on the connected vehicle are listed here. No
            values are invented.
          </p>
        </div>
      )}
    </div>
  );
}

void PowerInstance;
