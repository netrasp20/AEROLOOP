import { useEffect, useState } from "react";
import {
  AlertTriangle,
  ChevronRight,
  Eraser,
  Info,
  Sparkles,
} from "lucide-react";

import type { ParamEntry } from "../../api/parameters";

import {
  bitmaskRows,
  bitmaskSummary,
  enumLabels,
  formatNumber,
  incrementText,
  rangeText,
} from "../../parameters/parametersLogic";

import { validateStagedValue } from "../../parameters/validation";

import type { StageResult } from "../../parameters/stagedLogic";

import { editorKindFor } from "../../parameters/stagedLogic";

import type { StagedChange } from "../../parameters/stagedLogic";

interface Props {
  entry: ParamEntry | null;
  staged: StagedChange | null;
  onStage: (value: number) => StageResult;
  onRevert: () => void;
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="param-meta-row">
      <span className="param-meta-label">{label}</span>
      <span className="param-meta-value">{children}</span>
    </div>
  );
}

function NumericEditor({
  entry,
  staged,
  onStage,
}: {
  entry: ParamEntry;
  staged: StagedChange | null;
  onStage: (value: number) => StageResult;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const current = staged?.stagedValue ?? entry.live?.value ?? 0;

  useEffect(() => {
    setDraft(formatNumber(current));
    setError(null);
  }, [current, entry.id]);

  function commit() {
    const raw = draft;
    const value = Number(raw.trim());
    if (raw.trim() === "" || !Number.isFinite(value)) {
      setError("Value must be a real number.");
      return;
    }
    const validation = validateStagedValue(entry, value);
    if (!validation.valid) {
      setError(validation.message ?? "Invalid value.");
      return;
    }
    const result = onStage(value);
    if (!result.ok) {
      setError(result.error ?? "Could not stage the value.");
      return;
    }
    setError(null);
  }

  return (
    <div className="param-editor" data-testid="param-editor-numeric">
      <div className="param-editor-field">
        <label className="param-editor-label" htmlFor="param-numeric-input">
          New value
        </label>
        <input
          id="param-numeric-input"
          className="param-numeric-input"
          inputMode="decimal"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            if (error) setError(null);
          }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            }
            if (event.key === "Escape") {
              setDraft(formatNumber(current));
              setError(null);
            }
          }}
          data-testid="param-numeric-input"
        />
        {entry.metadata?.unitText && (
          <span className="param-editor-units">{entry.metadata.unitText}</span>
        )}
      </div>
      <div className="param-editor-hints" data-testid="param-editor-hints">
        Enter to stage locally — nothing is sent to the vehicle.
      </div>
      {error && (
        <div className="param-stage-error" data-testid="param-stage-error">
          <AlertTriangle size={13} /> {error}
        </div>
      )}
    </div>
  );
}

function EnumEditor({
  entry,
  staged,
  onStage,
}: {
  entry: ParamEntry;
  staged: StagedChange | null;
  onStage: (value: number) => StageResult;
}) {
  const values = entry.metadata?.values;
  const current = staged?.stagedValue ?? entry.live?.value ?? 0;
  const rows = values ? enumLabels(values, current).rows : [];

  return (
    <div className="param-editor" data-testid="param-editor-enum">
      <label className="param-editor-label" htmlFor="param-enum-select">
        New value
      </label>
      <select
        id="param-enum-select"
        className="param-enum-select"
        value={formatNumber(current)}
        onChange={(event) => {
          const code = Number(event.target.value);
          if (Number.isFinite(code)) onStage(code);
        }}
        data-testid="param-enum-select"
      >
        {rows.map((row) => (
          <option key={row.codeText} value={row.codeText}>
            {row.label} ({row.codeText})
          </option>
        ))}
      </select>
      <div className="param-editor-hints">
        Selecting an option stages it locally.
      </div>
    </div>
  );
}

function BitmaskEditor({
  entry,
  staged,
  onStage,
}: {
  entry: ParamEntry;
  staged: StagedChange | null;
  onStage: (value: number) => StageResult;
}) {
  const bitsSource = entry.metadata?.bitmask;
  const current = staged?.stagedValue ?? entry.live?.value ?? 0;
  const rows = bitsSource ? bitmaskRows(bitsSource, current) : [];

  function toggle(bit: number) {
    onStage(current ^ (1 << bit));
  }

  return (
    <div className="param-editor" data-testid="param-editor-bitmask">
      <div className="param-editor-label">New value</div>
      <p className="param-bitmask-summary">
        Set: {bitsSource && bitmaskSummary(bitsSource, current)}
      </p>
      <ul className="param-bit-editor-list">
        {rows.map((row) => (
          <li key={row.bit} className="param-bit-editor-row">
            <label className="param-bit-check">
              <input
                type="checkbox"
                checked={row.set}
                onChange={() => toggle(row.bit)}
              />
              <span className="param-bit-name">
                {row.label}{" "}
                <span className="param-bit-note">(bit {row.bit})</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      <div className="param-editor-hints">
        Toggling an option stages the new value locally.
      </div>
    </div>
  );
}

export default function ParameterDetails({ entry, staged, onStage, onRevert }: Props) {
  if (!entry) {
    return (
      <div className="param-details-empty" data-testid="param-details-empty">
        <Info size={22} />
        <span>Select a parameter to view its details.</span>
      </div>
    );
  }

  const meta = entry.metadata;
  const live = entry.live;
  const value = live?.value ?? null;
  const enumData = meta?.values ? enumLabels(meta.values, value ?? 0) : null;
  const bitsSource = meta?.bitmask ?? null;
  const bits = bitsSource ? bitmaskRows(bitsSource, value ?? 0) : null;
  const editorKind = editorKindFor(entry);

  const stagedValue = staged?.stagedValue ?? null;
  const stagedDisplay =
    stagedValue !== null && value !== null ? formatNumber(stagedValue) : null;

  return (
    <div className="param-details" data-testid="param-details">
      <div className="param-details-head">
        <h3 className="param-details-id">{entry.id}</h3>
        <span className="param-details-name">
          {meta?.name ?? "No definition"}
        </span>
        {meta?.advanced && <span className="param-adv-badge">ADV</span>}
        {staged && (
          <span className="param-modified-badge" data-testid="param-modified-badge">
            <Sparkles size={12} /> Modified
          </span>
        )}
        {meta?.readOnly && <span className="param-readonly-badge">Read-only</span>}
      </div>

      <div className="param-current-value">
        <span className="param-current-label">Vehicle Value</span>
        <span className="param-current-text" data-testid="param-current-value">
          {value === null || value === undefined ? "—" : formatNumber(value)}
        </span>
        {meta?.unitText && (
          <span className="param-current-units">{meta.unitText}</span>
        )}
      </div>

      {staged && value !== null && stagedValue !== null && (
        <div className="param-staged-banner" data-testid="param-staged-banner">
          <div className="param-staged-row">
            <span className="param-staged-label">Staged</span>
            <span className="param-staged-value">
              {formatNumber(value)} → {stagedDisplay}
            </span>
          </div>
          {staged.conflict && (
            <div className="param-conflict-note" data-testid="param-conflict-note">
              <AlertTriangle size={13} />
              Vehicle value changed externally (staged edit kept).
            </div>
          )}
        </div>
      )}

      {enumData && enumData.currentLabel && !staged && (
        <div className="param-enum-current">{enumData.currentLabel}</div>
      )}

      {meta?.description && (
        <p className="param-description">{meta.description}</p>
      )}

      <div className="param-meta-group">
        <MetaRow label="Type">{live?.type ?? "—"}</MetaRow>
        <MetaRow label="Group">{meta?.group ?? "—"}</MetaRow>
        <MetaRow label="Level">{meta?.advanced ? "Advanced" : "Standard"}</MetaRow>
        <MetaRow label="Units">
          {meta?.unitText || meta?.units || "—"}
        </MetaRow>
        <MetaRow label="Range">{rangeText(meta) ?? "—"}</MetaRow>
        <MetaRow label="Increment">{incrementText(meta) ?? "—"}</MetaRow>
        <MetaRow label="Read only">{meta?.readOnly ? "Yes" : "No"}</MetaRow>
        <MetaRow label="Reboot required">
          {meta?.rebootRequired ? "Yes" : "No"}
        </MetaRow>
        <MetaRow label="Metadata">
          {meta && !entry.metadataMissing && meta.source ? "Available" : "Missing"}
        </MetaRow>
      </div>

      <div className="param-edit-area" data-testid="param-edit-area">
        {editorKind === "readonly" ? (
          <div
            className="param-editor param-editor-readonly"
            data-testid="param-editor-readonly"
          >
            <div className="param-editor-label">New value</div>
            <div className="param-readonly-note" data-testid="param-readonly-note">
              This parameter is read-only on the vehicle and cannot be changed.
            </div>
          </div>
        ) : editorKind === "enum" ? (
          <EnumEditor entry={entry} staged={staged} onStage={onStage} />
        ) : editorKind === "bitmask" ? (
          <BitmaskEditor entry={entry} staged={staged} onStage={onStage} />
        ) : (
          <NumericEditor entry={entry} staged={staged} onStage={onStage} />
        )}

        {staged && (
          <button
            className="param-revert-action"
            onClick={onRevert}
            data-testid="param-revert-action"
          >
            <Eraser size={14} /> Discard modified value
          </button>
        )}
      </div>

      {enumData && (
        <div className="param-enum" data-testid="param-enum">
          <h4 className="param-subsection">Options</h4>
          <ul className="param-enum-list">
            {enumData.rows.map((row) => (
              <li
                key={row.codeText}
                className={`param-enum-row ${
                  row.codeText === formatNumber(value ?? 0) ? "current" : ""
                }`}
              >
                <span className="param-enum-code">{row.codeText}</span>
                <ChevronRight size={13} className="param-enum-arrow" />
                <span className="param-enum-label">{row.label}</span>
                {row.codeText === formatNumber(value ?? 0) && (
                  <span className="param-enum-marker">← vehicle</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {bits && (
        <div className="param-bitmask" data-testid="param-bitmask">
          <h4 className="param-subsection">Bitmask</h4>
          <p className="param-bitmask-summary">
            Set: {bitmaskSummary(bitsSource!, value ?? 0)}
          </p>
          <ul className="param-bit-list">
            {bits.map((row) => (
              <li
                key={row.bit}
                className={`param-bit-row ${row.set ? "set" : ""}`}
              >
                <span className="param-bit-state">{row.set ? "X" : "·"}</span>
                <span className="param-bit-name">
                  {row.label}{" "}
                  <span className="param-bit-note">(bit {row.bit})</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!meta && (
        <p className="param-no-meta">
          No official definition for this parameter.
        </p>
      )}
    </div>
  );
}