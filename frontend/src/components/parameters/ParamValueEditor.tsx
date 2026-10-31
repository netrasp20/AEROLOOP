import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";

import type { ParamEntry } from "../../api/parameters";

import {
  bitmaskSummary,
  enumLabels,
  formatNumber,
} from "../../parameters/parametersLogic";

import { validateStagedValue } from "../../parameters/validation";
import { editorKindFor } from "../../parameters/stagedLogic";

import type { StageResult, StagedChange } from "../../parameters/stagedLogic";

interface Props {
  entry: ParamEntry;
  staged: StagedChange | null;
  onStage: (value: number) => StageResult;
}

/**
 * Compact inline editor shown inside a parameter row's Value cell once the
 * row is selected. Mirrors the read behaviour of the removed details panel:
 * numeric input, compact enum select, bitmask toggle grid, or read-only note.
 * Everything stages locally — nothing is written to the vehicle.
 */
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
    <div className="mp-inline-editor" data-testid="param-editor-numeric">
      <input
        id="param-numeric-input"
        className="mp-inline-input"
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
            event.stopPropagation();
            commit();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            setDraft(formatNumber(current));
            setError(null);
          }
        }}
        data-testid="param-numeric-input"
      />
      {error && (
        <div className="mp-inline-error" data-testid="param-stage-error">
          <AlertTriangle size={12} /> {error}
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
  const currentCode = formatNumber(current);

  return (
    <div className="mp-inline-editor" data-testid="param-editor-enum">
      <select
        className="mp-inline-select"
        value={String(currentCode)}
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
  const rows = bitsSource
    ? Object.entries(bitsSource)
        .map(([bit, label]) => {
          const n = Number(bit);
          return { bit: Number.isFinite(n) ? n : -1, label };
        })
        .sort((a, b) => a.bit - b.bit)
    : [];

  function toggle(bit: number) {
    onStage(current ^ (1 << bit));
  }

  return (
    <div className="mp-inline-editor" data-testid="param-editor-bitmask">
      <p className="mp-inline-bit-summary">
        Set: {bitsSource && bitmaskSummary(bitsSource, current)}
      </p>
      <ul className="mp-inline-bit-list">
        {rows.map((row) => (
          <li key={row.bit} className="mp-inline-bit-row">
            <label className="mp-inline-bit-check">
              <input
                type="checkbox"
                checked={((current >> row.bit) & 1) === 1}
                onChange={() => toggle(row.bit)}
              />
              <span className="mp-inline-bit-name">
                {row.label} <span className="mp-inline-bit-note">({row.bit})</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReadonlyEditor() {
  return (
    <div
      className="mp-inline-editor mp-inline-readonly"
      data-testid="param-editor-readonly"
    >
      <span className="mp-inline-readonly-note" data-testid="param-readonly-note">
        Read-only on the vehicle.
      </span>
    </div>
  );
}

export default function ParamValueEditor({ entry, staged, onStage }: Props) {
  const kind = editorKindFor(entry);
  if (kind === "readonly") return <ReadonlyEditor />;
  if (kind === "enum")
    return <EnumEditor entry={entry} staged={staged} onStage={onStage} />;
  if (kind === "bitmask")
    return <BitmaskEditor entry={entry} staged={staged} onStage={onStage} />;
  return <NumericEditor entry={entry} staged={staged} onStage={onStage} />;
}