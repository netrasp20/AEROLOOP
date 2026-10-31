import { Eraser, RefreshCw } from "lucide-react";

import { useParameters } from "../../context/ParameterContext";

import ParameterSearch from "./ParameterSearch";

interface Props {
  query: string;
  onQueryChange: (q: string) => void;
  modifiedOnly: boolean;
  onModifiedChange: (v: boolean) => void;
  onLoadFile: () => void;
  onSaveFile: () => void;
  onWrite: () => void;
  onCompare: () => void;
  onLoadPreset: () => void;
  onReset: () => void;
}

export default function ParameterActions({
  query,
  onQueryChange,
  modifiedOnly,
  onModifiedChange,
  onLoadFile,
  onSaveFile,
  onWrite,
  onCompare,
  onLoadPreset,
  onReset,
}: Props) {
  const store = useParameters();
  const syncing = store.sync.active || store.refreshing;
  const canRefresh =
    !syncing &&
    (store.connection === "READY" ||
      store.connection === "SYNCING" ||
      store.connection === "CONNECTING");

  function handleRefresh() {
    if (store.stagedCount > 0) {
      const confirmed = window.confirm(
        `You have ${store.stagedCount} unuploaded parameter change${
          store.stagedCount === 1 ? "" : "s"
        }. Refresh replaces vehicle values with the latest from the flight controller — staged changes are kept and checked for conflicts. Continue?`
      );
      if (!confirmed) return;
    }
    void store.refresh();
  }

  function handleDiscardAll() {
    if (store.stagedCount === 0) return;
    const confirmed = window.confirm(
      `Discard ${store.stagedCount} unuploaded parameter change${
        store.stagedCount === 1 ? "" : "s"
      }? This reverts to vehicle values.`
    );
    if (confirmed) store.discardAll();
  }

  return (
    <div className="mp-actions" data-testid="param-actions">
      <div className="mp-actions-group">
        <button type="button" className="mp-action" onClick={onLoadFile}>
          Load from File
        </button>
        <button type="button" className="mp-action" onClick={onSaveFile}>
          Save to File
        </button>
        <button
          type="button"
          className={`mp-action ${store.stagedCount > 0 ? "mp-action-primary" : ""}`}
          onClick={onWrite}
          disabled={store.stagedCount === 0}
          title="Write modified parameters to the flight controller"
          data-testid="write-params-button"
        >
          {store.stagedCount > 0
            ? `Write Params (${store.stagedCount})`
            : "Write Params"}
        </button>
        <button
          type="button"
          className="mp-action"
          onClick={handleRefresh}
          disabled={!canRefresh}
          title="Download parameters from the flight controller"
        >
          <RefreshCw size={13} /> Refresh Params
        </button>
        <button type="button" className="mp-action" onClick={onCompare}>
          Compare Params
        </button>
      </div>

      <p className="mp-actions-note">
        All units are in raw format with no scaling.
      </p>

      <div className="mp-actions-group">
        <button type="button" className="mp-action" onClick={onLoadPreset}>
          Load Presaved
        </button>
      </div>

      <div className="mp-actions-group">
        <button type="button" className="mp-action mp-action-danger" onClick={onReset}>
          Reset to Default
        </button>
      </div>

      <div className="mp-actions-spacer" />

      <div className="mp-actions-search">
        <ParameterSearch value={query} onChange={onQueryChange} />
        <label className="mp-modified-check" data-testid="param-tab-modified">
          <input
            type="checkbox"
            checked={modifiedOnly}
            onChange={(event) => onModifiedChange(event.target.checked)}
          />
          <span>
            Modified ({store.stagedCount})
          </span>
        </label>
      </div>

      {store.stagedCount > 0 && (
        <button
          type="button"
          className="mp-action mp-action-subtle"
          onClick={handleDiscardAll}
          data-testid="param-discard-all"
          title="Discard all locally modified values"
        >
          <Eraser size={13} /> Discard All
        </button>
      )}
    </div>
  );
}