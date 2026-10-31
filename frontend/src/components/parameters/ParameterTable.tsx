import { AlertTriangle, Loader2, Sparkles, WifiOff } from "lucide-react";

import type { ParamEntry } from "../../api/parameters";
import type { ConnectionState } from "../../api/parameters";
import type { ParamRowView } from "../../parameters/parametersLogic";
import {
  bitmaskSummary,
  enumLabels,
  formatNumber,
  stagedRangeText,
} from "../../parameters/parametersLogic";
import type { StageResult, StagedChange, StagedMap } from "../../parameters/stagedLogic";

import ParamValueEditor from "./ParamValueEditor";

interface Props {
  rows: ParamRowView[];
  entries: Record<string, ParamEntry>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  connection: ConnectionState;
  syncing: boolean;
  loading: boolean;
  error: string | null;
  query: string;
  count: number;
  staged: StagedMap;
  onStage: (id: string, value: number) => StageResult;
  onRevert: (id: string) => void;
}

function NotConnected() {
  return (
    <div className="param-table-state" data-testid="param-state-notconnected">
      <WifiOff size={26} />
      <span>Not connected</span>
      <p>Connect to the flight controller to view its parameters.</p>
    </div>
  );
}

function SyncingState({ received, expected }: { received: number; expected: number }) {
  return (
    <div className="param-table-state" data-testid="param-state-syncing">
      <Loader2 size={26} className="spin-icon" />
      <span>Downloading parameters…</span>
      <p>
        {received} of {expected} received so far
      </p>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="param-table-state" data-testid="param-state-error">
      <AlertTriangle size={26} />
      <span>Unable to load parameters</span>
      <p>{message}</p>
    </div>
  );
}

function NoResults({ query }: { query: string }) {
  return (
    <div className="param-table-state" data-testid="param-state-noresults">
      <span>No parameters match “{query}”</span>
      <p>Try a different name, id or description.</p>
    </div>
  );
}

interface OptionsProps {
  row: ParamRowView;
  entry: ParamEntry | undefined;
}

function OptionsCell({ row, entry }: OptionsProps) {
  const meta = entry?.metadata;
  if (meta?.values && row.value !== null) {
    const { currentLabel } = enumLabels(meta.values, row.value);
    return currentLabel ?? row.id;
  }
  if (meta?.bitmask && row.value !== null) {
    return bitmaskSummary(meta.bitmask, row.value);
  }
  return "";
}

interface ValueCellProps {
  row: ParamRowView;
  entry: ParamEntry | undefined;
  selected: boolean;
  staged: StagedChange | null;
  onStage: (value: number) => StageResult;
  onRevert: () => void;
}

function ValueCell({ row, entry, selected, staged, onStage, onRevert }: ValueCellProps) {
  if (selected && entry) {
    return (
      <div className="mp-cell-editor">
        <div className="mp-cell-live" data-testid="param-current-value">
          <span className="mp-cell-live-label">Live</span>
          <span className="mp-cell-live-text">
            {formatNumber(row.value ?? 0)}
          </span>
        </div>
        <ParamValueEditor entry={entry} staged={staged} onStage={onStage} />
        {staged && (
          <div className="mp-cell-staged" data-testid="param-staged-banner">
            <span className="mp-cell-staged-title">
              <span className="mp-mod-badge" data-testid="param-modified-badge">
                Modified
              </span>
              <span className="mp-cell-staged-range" data-testid="param-range-text">
                {stagedRangeText(row.value ?? 0, staged.stagedValue ?? 0)}
              </span>
            </span>
            {staged.conflict && (
              <span className="mp-cell-conflict" data-testid="param-conflict-note">
                <AlertTriangle size={12} /> changed externally
              </span>
            )}
          </div>
        )}
        {staged && (
          <button
            className="mp-cell-revert"
            onClick={(event) => {
              event.stopPropagation();
              onRevert();
            }}
            data-testid="param-revert-action"
          >
            Discard
          </button>
        )}
      </div>
    );
  }

  return (
    <span className="mp-cell-value-number" data-testid="param-cell-value">
      {row.value === null || row.value === undefined ? "—" : formatNumber(row.value)}
      {staged && row.value !== null && staged.stagedValue !== null && (
        <span className="mp-cell-modified" data-testid={`param-range-${row.id}`}>
          <Sparkles size={10} />
          {stagedRangeText(row.value, staged.stagedValue)}
          {staged.conflict && <span className="mp-cell-conflict-dot"> ⚠</span>}
        </span>
      )}
    </span>
  );
}

export default function ParameterTable({
  rows,
  entries,
  selectedId,
  onSelect,
  connection,
  syncing,
  loading,
  error,
  query,
  count,
  staged,
  onStage,
  onRevert,
}: Props) {
  if (loading) {
    return (
      <div className="param-table-state" data-testid="param-state-loading">
        <Loader2 size={26} className="spin-icon" />
        <span>Loading parameters…</span>
      </div>
    );
  }

  if (error && count === 0 && connection === "DISCONNECTED") {
    return <ErrorState message={error} />;
  }

  if (connection === "DISCONNECTED" && count === 0) {
    return <NotConnected />;
  }

  if (syncing && count === 0) {
    return <SyncingState received={0} expected={0} />;
  }

  if (rows.length === 0 && query.trim()) {
    return <NoResults query={query} />;
  }

  if (rows.length === 0) {
    return (
      <div className="param-table-state" data-testid="param-state-empty">
        <span>No parameters</span>
        <p>The flight controller has not reported any parameters yet.</p>
      </div>
    );
  }

  return (
    <div className="mp-table-scroll">
      <table className="mp-table" data-testid="param-table">
        <thead>
          <tr>
            <th className="mp-th cmd">Command</th>
            <th className="mp-th value">Value</th>
            <th className="mp-th units">Units</th>
            <th className="mp-th options">Options</th>
            <th className="mp-th desc">Desc</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const selected = selectedId === row.id;
            const change = staged[row.id] ?? null;
            const entry = entries[row.id];
            return (
              <tr
                key={row.id}
                className={`mp-row ${selected ? "selected" : ""} ${
                  change ? "modified" : ""
                }`}
                onClick={() => onSelect(row.id)}
                data-testid={`param-row-${row.id}`}
              >
                <td className="mp-cell cmd">
                  <span className="mp-cell-command">{row.id}</span>
                  {change && (
                    <span
                      className="mp-mod-badge"
                      data-testid={`param-mod-badge-${row.id}`}
                    >
                      Mod
                    </span>
                  )}
                </td>
                <td className="mp-cell value">
                  <ValueCell
                    row={row}
                    entry={entry}
                    selected={selected}
                    staged={change}
                    onStage={(value) => onStage(row.id, value)}
                    onRevert={() => onRevert(row.id)}
                  />
                </td>
                <td className="mp-cell units">{row.unitText ?? row.units ?? ""}</td>
                <td className="mp-cell options">
                  <OptionsCell row={row} entry={entry} />
                </td>
                <td className="mp-cell desc">{row.description ?? ""}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}