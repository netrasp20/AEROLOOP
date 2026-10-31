import { Sparkles, RefreshCw } from "lucide-react";

import { useParameters } from "../../context/ParameterContext";
import { connectionView, progressRatio } from "../../parameters/parametersLogic";

function formatClock(epochSeconds: number | null): string {
  if (epochSeconds === null) return "—";
  return new Date(epochSeconds * 1000).toLocaleTimeString();
}

export default function ParameterStatusBar() {
  const store = useParameters();
  const connection = connectionView(store.connection);
  const meta = store.metadataStatus;
  const sync = store.sync;
  const ratio = progressRatio(sync.receivedCount, sync.expectedCount);
  const percent = Math.round(ratio * 100);
  const syncing = sync.active || store.refreshing;

  return (
    <div className="param-statusbar">
      <div className="param-statusbar-left">
        <span className={`param-conn-chip tone-${connection.tone}`}>
          {connection.label}
        </span>
        {store.vehicleType && (
          <span className="param-vehicle-type">{store.vehicleType}</span>
        )}
        {store.stagedCount > 0 && (
          <span className="param-staged-chip" data-testid="param-staged-chip">
            <Sparkles size={12} />
            {store.stagedCount} modified
          </span>
        )}
      </div>

      {syncing ? (
        <div className="param-sync-row" data-testid="sync-row">
          <RefreshCw size={14} className="spin-icon" />
          <span className="param-sync-label">
            {store.refreshing ? "Refreshing" : "Synchronizing"}
          </span>
          <div className="param-progress-track">
            <div
              className="param-progress-fill"
              style={{ width: `${percent}%` }}
            />
          </div>
          <span className="param-sync-count">
            {sync.receivedCount} / {sync.expectedCount} ({percent}%)
          </span>
        </div>
      ) : (
        <div className="param-sync-summary" data-testid="sync-summary">
          <span className="param-count-badge">{store.count} parameters</span>
          {sync.complete && sync.expectedCount > 0 && (
            <span className="param-complete-note">
              complete
              {store.count !== sync.expectedCount ? " (partial)" : ""}
            </span>
          )}
        </div>
      )}

      <div className="param-statusbar-meta">
        {meta && meta.status && (
          <span
            className={`param-meta-chip status-${meta.status.toLowerCase()}`}
          >
            metadata {meta.status.toLowerCase()}
            {typeof meta.paramCount === "number" && meta.paramCount > 0
              ? ` · ${meta.paramCount} defs`
              : ""}
            {typeof meta.groupCount === "number" && meta.groupCount > 0
              ? ` · ${meta.groupCount} groups`
              : ""}
          </span>
        )}
        <span className="param-session-id" title={String(store.sessionId)}>
          session {(store.sessionId ?? "—").slice(0, 8)}
        </span>
        <span className="param-updated-at">
          updated {formatClock(store.lastUpdated)}
        </span>
      </div>
    </div>
  );
}