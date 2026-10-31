import { useCallback, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  Loader,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldAlert,
  WifiOff,
} from "lucide-react";

import { useTelemetry } from "../../hooks/useTelemetry";
import { useParameters } from "../../context/ParameterContext";
import { formatNumber } from "../../parameters/parametersLogic";

import {
  frameConfig,
  frameWriteResult,
  FRAME_CLASS_PARAM,
  FRAME_TYPE_PARAM,
  type FrameConfig,
  type FrameField,
} from "./frameLogic";

function SelectRow({
  field,
  onChange,
  onError,
  disabled,
}: {
  field: FrameField;
  onChange: (paramId: string, code: number) => void;
  onError: (message: string | null) => void;
  disabled: boolean;
}) {
  const live = field.currentCode;
  const effective = field.pendingCode ?? live;

  return (
    <div className="frame-field" data-testid={`frame-field-${field.paramId}`}>
      <div className="frame-field-head">
        <span className="frame-field-label">{field.supportLabel}</span>
        {field.rebootRequired && (
          <span className="frame-reboot-chip" data-testid={`frame-reboot-${field.paramId}`}>
            Reboot required
          </span>
        )}
        {!field.hasMetadata && (
          <span className="frame-meta-note">metadata unavailable — standard values</span>
        )}
      </div>

      <div className="frame-field-select-row">
        <select
          className="frame-select"
          value={String(effective ?? "")}
          onChange={(e) => {
            onError(null);
            onChange(field.paramId, Number(e.target.value));
          }}
          disabled={disabled}
          data-testid={`frame-select-${field.paramId}`}
        >
          {field.options.map((opt) => (
            <option key={opt.code} value={opt.code}>
              {opt.label}
            </option>
          ))}
        </select>

        <div className="frame-values">
          <span className="frame-current" data-testid={`frame-current-${field.paramId}`}>
            Current:{" "}
            <strong>
              {field.currentLabel ?? "—"}
              {field.currentCode !== null && ` (${formatNumber(field.currentCode)})`}
            </strong>
          </span>
          {field.modified && (
            <span className="frame-pending" data-testid={`frame-pending-${field.paramId}`}>
              Pending: <strong>{field.pendingLabel ?? "—"}</strong>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function AirframeIllustration({ classCode, typeCode, label }: { classCode: number; typeCode: number | null; label: string }) {
  const normalized = label.toLowerCase();
  const helicopter = normalized.includes("heli");
  const coaxial = normalized.includes("y6") || normalized.includes("coax");
  const motorCount = normalized.includes("bi") ? 2 : normalized.includes("tri") ? 3 : classCode === 2 ? 6 : classCode === 3 || classCode === 4 ? 8 : classCode === 5 ? 6 : 4;
  const points = Array.from({ length: motorCount }, (_, index) => {
    const angle = (Math.PI * 2 * index) / motorCount - Math.PI / 2;
    return `${50 + Math.cos(angle) * 31},${50 + Math.sin(angle) * 31}`;
  });
  return (
    <svg className={`frame-airframe-art${helicopter ? " is-helicopter" : ""}${coaxial ? " is-coaxial" : ""}`} viewBox="0 0 100 100" role="img" aria-label={`${label} airframe illustration`}>
      {helicopter && <><ellipse cx="50" cy="42" rx="35" ry="7" /><line x1="50" y1="48" x2="50" y2="78" /><path d="M30 78 Q50 68 70 78 Q50 89 30 78" /></>}
      {points.map((point, index) => <line key={index} x1="50" y1="50" x2={point.split(",")[0]} y2={point.split(",")[1]} />)}
      {points.map((point, index) => <circle key={index} cx={point.split(",")[0]} cy={point.split(",")[1]} r="6" />)}
      {coaxial && points.map((point, index) => <circle key={`coax-${index}`} cx={point.split(",")[0]} cy={point.split(",")[1]} r="3.5" className="frame-art-coax" />)}
      <rect x="43" y="43" width="14" height="14" rx="3" className={typeCode === 1 ? "frame-art-core frame-art-selected" : "frame-art-core"} />
    </svg>
  );
}

export default function SetupFrame() {
  const telemetry = useTelemetry();
  const store = useParameters();

  const [stageError, setStageError] = useState<string | null>(null);
  const [resultVisible, setResultVisible] = useState(false);

  const connected = telemetry.connected;
  const ready = store.connection === "READY";

  const config: FrameConfig = useMemo(
    () =>
      frameConfig(
        store.entries,
        ready ? store.staged : {}
      ),
    [store.entries, store.staged, ready]
  );

  const writeResult = useMemo(() => {
    if (
      store.writePhase === "success" ||
      store.writePhase === "partial_failure" ||
      store.writePhase === "interrupted" ||
      store.writePhase === "error"
    ) {
      return frameWriteResult(store.writeSummary);
    }
    return null;
  }, [store.writePhase, store.writeSummary]);

  // After a verified write, show the reboot note when a *written* frame param
  // requires one (metadata is authoritative).
  const writtenRebootRequired = useMemo(() => {
    if (!writeResult || writeResult.status !== "success") return false;
    return writeResult.items.some(
      (item) =>
        item.status === "success" && store.entries[item.paramId]?.metadata?.rebootRequired
    );
  }, [writeResult, store.entries]);

  const conflictIds = store.writeConflicts?.map((c) => c.paramId) ?? [];
  const frameConflict =
    conflictIds.includes(FRAME_CLASS_PARAM) || conflictIds.includes(FRAME_TYPE_PARAM);

  const hasConflicts = store.writeConflicts !== null && store.writeConflicts.length > 0;

  const handleStage = useCallback(
    (paramId: string, code: number) => {
      const result = store.stageValue(paramId, code);
      setResultVisible(false);
      if (!result.ok) {
        setStageError(result.error ?? "Unable to stage the selected value.");
      }
    },
    [store]
  );

  const handleApply = useCallback(() => {
    setStageError(null);
    setResultVisible(true);
    void store.executeWrite();
  }, [store]);

  const handleRevertAll = useCallback(() => {
    setStageError(null);
    setResultVisible(false);
    store.discardAll();
  }, [store]);

  const handleAcknowledge = useCallback(() => {
    setStageError(null);
    void store.acknowledgeAndWrite();
  }, [store]);

  /* ---------------- disconnected ---------------- */
  if (!connected) {
    return (
      <div className="setup-page setup-frame-page" data-testid="setup-frame">
        <div className="setup-page-header">
          <h2 className="setup-page-title">Frame / Airframe</h2>
          <p className="setup-page-subtitle">
            Configure the ArduCopter frame class and type
          </p>
        </div>
        <div className="setup-disconnected" data-testid="setup-frame-disconnected">
          <WifiOff size={26} />
          <p className="setup-disconnected-title">Connect to an ArduCopter vehicle to configure the frame.</p>
          <p className="setup-disconnected-hint">
            Disconnected. No live parameter values are shown, and no frame
            configuration is available.
          </p>
          {config.hasChanges && (
            <button
              type="button"
              className="setup-params-btn setup-params-btn-danger"
              onClick={handleRevertAll}
              data-testid="setup-frame-revert-disconnected"
            >
              <RotateCcw size={13} />
              Revert locally staged changes
            </button>
          )}
        </div>
      </div>
    );
  }

  /* ---------------- connected, parameters still loading ---------------- */
  if (!ready) {
    return (
      <div className="setup-page setup-frame-page" data-testid="setup-frame">
        <div className="setup-page-header">
          <h2 className="setup-page-title">Frame / Airframe</h2>
          <p className="setup-page-subtitle">
            Configure the ArduCopter frame class and type
          </p>
        </div>
        <div className="setup-frame-loading" data-testid="setup-frame-loading">
          <Loader size={18} className="setup-spinner" />
          Loading vehicle parameters…
        </div>
      </div>
    );
  }

  /* ---------------- unsupported firmware ---------------- */
  if (config.unsupported) {
    return (
      <div className="setup-page setup-frame-page" data-testid="setup-frame">
        <div className="setup-page-header">
          <h2 className="setup-page-title">Frame / Airframe</h2>
          <p className="setup-page-subtitle">
            Configure the ArduCopter frame class and type
          </p>
        </div>
        <div className="setup-disconnected" data-testid="setup-frame-unsupported">
          <ShieldAlert size={26} />
          <p className="setup-disconnected-title">
            Frame configuration is not exposed by the connected firmware.
          </p>
          <p className="setup-disconnected-hint">
            Neither FRAME_CLASS nor FRAME_TYPE is present in the running
            firmware's parameter set.
          </p>
        </div>
      </div>
    );
  }

  const showApply = config.hasChanges && !hasConflicts;

  return (
    <div className="setup-page setup-frame-page" data-testid="setup-frame">
      <div className="setup-page-header">
        <h2 className="setup-page-title">Frame / Airframe</h2>
        <p className="setup-page-subtitle">
          Configure the ArduCopter frame class and type
        </p>
      </div>

      <div className="frame-live-status" data-testid="frame-live-status">
        <span>Connected: <strong>{telemetry.vehicleType || "Vehicle"}</strong></span>
        <span>Vehicle: <strong>{telemetry.vehicleType || "Unavailable"}</strong></span>
        <span>Current Frame: <strong>{config.classField?.currentLabel ?? "Unavailable"}{config.typeField?.currentLabel ? ` ${config.typeField.currentLabel}` : ""}</strong></span>
        <span>Pending Change: <strong>{config.hasChanges ? "Staged" : "None"}</strong></span>
      </div>

      {(() => {
        const options = (config.classField?.options ?? []).filter((option) => option.code !== 0);
        const standard = options.filter((option) => !/scripting|6dof|dynamic|matrix|custom/i.test(option.label));
        const special = options.filter((option) => /scripting|6dof|dynamic|matrix|custom/i.test(option.label));
        const renderCards = (items: typeof options) => items.map((option) => {
          const current = config.classField?.currentCode === option.code;
          const pending = !!config.classField?.modified && config.classField?.pendingCode === option.code;
          const selected = current || pending;
          return (
            <article className={`frame-airframe-card${selected ? " is-selected" : ""}`} key={option.code} data-testid={`frame-card-${option.code}`}>
              <button
                type="button"
                className="frame-airframe-card-select"
                onClick={() => handleStage(FRAME_CLASS_PARAM, option.code)}
                disabled={store.writePhase === "running"}
                aria-pressed={selected}
              >
                <span className="frame-airframe-card-title">{option.label}</span>
                <AirframeIllustration classCode={option.code} label={option.label} typeCode={config.typeField?.pendingCode ?? config.typeField?.currentCode ?? null} />
                {current && <span className="frame-airframe-current">CURRENT</span>}
                {pending && <span className="frame-airframe-pending">PENDING</span>}
              </button>
              {selected && config.typeField?.supported && (
                <label className="frame-airframe-variant">
                  <span>Variant</span>
                  <select
                    className="frame-select"
                    value={String(config.typeField.pendingCode ?? config.typeField.currentCode ?? "")}
                    onChange={(event) => { setStageError(null); handleStage(FRAME_TYPE_PARAM, Number(event.target.value)); }}
                    disabled={store.writePhase === "running"}
                    data-testid={`frame-card-type-${option.code}`}
                  >
                    {config.typeField.options.map((type) => <option key={type.code} value={type.code}>{type.label}</option>)}
                  </select>
                </label>
              )}
            </article>
          );
        });
        return <>
          <section className="frame-airframe-group" data-testid="frame-standard-group">
            <h3>Standard Multicopters</h3>
            <div className="frame-airframe-grid" data-testid="frame-airframe-grid" aria-label="ArduCopter airframes">{renderCards(standard)}</div>
          </section>
          {special.length > 0 && <section className="frame-airframe-group" data-testid="frame-special-group"><h3>Advanced / Special Frames</h3><div className="frame-airframe-grid">{renderCards(special)}</div></section>}
        </>;
      })()}

      <section className="setup-card frame-parameter-controls" data-testid="frame-selectors">
        <h3 className="setup-card-title">Live Frame Parameters</h3>
        {config.classField && <SelectRow field={config.classField} onChange={handleStage} onError={setStageError} disabled={store.writePhase === "running"} />}
        {config.classField && !config.classField.supported && <p className="frame-unsupported-line" data-testid="frame-class-unsupported">FRAME_CLASS is not exposed by the connected firmware.</p>}
        {config.typeField?.supported && <SelectRow field={config.typeField} onChange={handleStage} onError={setStageError} disabled={store.writePhase === "running"} />}
      </section>

      {stageError && (
        <div className="frame-error" data-testid="frame-stage-error">
          <AlertTriangle size={14} />
          {stageError}
        </div>
      )}

      {/* Pending / apply / revert */}
      {showApply && (
        <section className="setup-card frame-apply-card" data-testid="frame-apply-card">
          <div className="frame-unsaved">
            <RefreshCw size={14} />
            <strong>Unsaved changes</strong>
            <span>
              {config.stagedCount} frame value{config.stagedCount === 1 ? "" : "s"} staged — the
              vehicle has not been modified yet.
            </span>
          </div>
          {config.rebootPending && (
            <div className="frame-reboot-warning" data-testid="frame-reboot-warning">
              <ShieldAlert size={14} />
              Applying these changes may require a vehicle reboot before taking
              effect.
            </div>
          )}
          <div className="frame-apply-actions">
            <button
              type="button"
              className="setup-params-btn setup-params-btn-danger"
              onClick={handleRevertAll}
              disabled={store.writePhase === "running"}
              data-testid="frame-revert"
            >
              <RotateCcw size={13} />
              Revert
            </button>
            <button
              type="button"
              className="setup-params-btn setup-params-btn-primary"
              onClick={handleApply}
              disabled={store.writePhase === "running"}
              data-testid="frame-apply"
            >
              {store.writePhase === "running" ? (
                <Loader size={13} className="setup-spinner" />
              ) : (
                <Save size={13} />
              )}
              {store.writePhase === "running" ? "Applying…" : "Apply and Restart"}
            </button>
          </div>
        </section>
      )}

      {/* Write progress */}
      {store.writePhase === "running" && (
        <div className="frame-write-running" data-testid="frame-write-running">
          <Loader size={14} className="setup-spinner" />
          Writing
          {store.writeProgress.currentParamId
            ? ` ${store.writeProgress.currentParamId}`
            : ""}…
          <span>
            {store.writeProgress.completed} / {store.writeProgress.total} verified
          </span>
        </div>
      )}

      {/* Conflicts */}
      {hasConflicts && frameConflict && store.writePhase !== "running" && (
        <section className="setup-card frame-conflict-card" data-testid="frame-conflicts">
          <div className="frame-conflict-title">
            <AlertTriangle size={14} />
            Frame values changed on the vehicle since you staged your edits
          </div>
          <ul className="frame-conflict-list">
            {store.writeConflicts!.map((c) => (
              <li key={c.paramId} className="frame-conflict-row">
                <span className="frame-conflict-id">{c.paramId}</span>
                <span className="frame-conflict-detail">
                  Vehicle {formatNumber(c.currentValue)} · Staged {formatNumber(c.stagedValue)}
                </span>
              </li>
            ))}
          </ul>
          <div className="frame-apply-actions">
            <button
              type="button"
              className="setup-params-btn setup-params-btn-danger"
              onClick={handleRevertAll}
              data-testid="frame-conflict-revert"
            >
              Revert
            </button>
            <button
              type="button"
              className="setup-params-btn setup-params-btn-primary"
              onClick={handleAcknowledge}
              data-testid="frame-conflict-ack"
            >
              Acknowledge and apply
            </button>
          </div>
        </section>
      )}

      {/* Post-write result */}
      {store.writePhase !== "running" && resultVisible && writeResult && (
        <section className="setup-card" data-testid="frame-write-result">
          {writeResult.status === "success" ? (
            <div className="frame-result-ok">
              <Check size={15} />
              <span>Saved{writtenRebootRequired ? ". Reboot required." : "."}</span>
            </div>
          ) : (
            <div className="frame-result-warn">
              <AlertTriangle size={15} />
              <span>
                {writeResult.status === "partial_failure"
                  ? `Partially saved — ${writeResult.succeeded} verified, ${writeResult.failed} failed, ${writeResult.notAttempted} not written.`
                  : writeResult.status === "interrupted"
                    ? "The write was interrupted (the session changed)."
                    : "The write failed. The vehicle value was not changed."}
              </span>
            </div>
          )}
          {writeResult.items.length > 0 && (
            <ul className="frame-result-items">
              {writeResult.items.map((item) => (
                <li key={item.paramId} data-testid={`frame-result-${item.paramId}`}>
                  <span className="frame-result-id">{item.paramId}</span>
                  <span className={`frame-result-status is-${item.status}`}>
                    {item.status}
                  </span>
                  {item.verifiedValue !== null && (
                    <span className="frame-result-verified">
                      verified {formatNumber(item.verifiedValue)}
                    </span>
                  )}
                  {item.message && (
                    <span className="frame-result-msg">{item.message}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* Persistent reboot note */}
      {!config.hasChanges && !writtenRebootRequired && (
        <p className="setup-note">
          Changing the frame configuration defines how ArduCopter mixes motor
          outputs for the physical frame and may require a vehicle reboot.
        </p>
      )}
    </div>
  );
}
