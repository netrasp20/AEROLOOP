import { AlertTriangle, Check, Loader, ShieldCheck, X } from "lucide-react";

import type { ParamConflict } from "../../api/parameters";

import { formatNumber } from "../../parameters/parametersLogic";

import { useParameters } from "../../context/ParameterContext";

import type { StagedChange } from "../../parameters/stagedLogic";

import type { WriteItemResult } from "../../api/parameters";

interface Props {
  open: boolean;
  onClose: () => void;
}

function statusLabel(status: string): string {
  if (status === "success") return "Verified";
  if (status === "failed") return "Failed";
  if (status === "not_attempted") return "Not written";
  return status;
}

function resultFor(
  staged: StagedChange,
  results: WriteItemResult[]
): { status: string; message?: string | null } {
  const item = results.find((r) => r.paramId === staged.paramId);
  if (!item) return { status: "not_attempted" };
  return { status: item.status, message: item.message };
}

function ConflictNotice({ conflicts }: { conflicts: ParamConflict[] }) {
  return (
    <div className="write-conflict-block" data-testid="write-conflicts">
      <div className="write-conflict-title">
        <AlertTriangle size={14} />
        Parameter values changed on the vehicle since you staged your edits
      </div>
      <ul className="write-conflict-list">
        {conflicts.map((c) => (
          <li key={c.paramId} className="write-conflict-row">
            <span className="write-conflict-id">{c.paramId}</span>
            <span className="write-conflict-detail">
              Original {formatNumber(c.originalValue)} · Vehicle{" "}
              {formatNumber(c.currentValue)} · Staged {formatNumber(c.stagedValue)}
            </span>
          </li>
        ))}
      </ul>
      <p className="write-conflict-note">
        Writing will overwrite the vehicle value with your staged value. Review
        before continuing.
      </p>
    </div>
  );
}

export default function WriteParamsDialog({ open, onClose }: Props) {
  const store = useParameters();

  if (!open) return null;

  const stagedList = Object.values(store.staged);
  const running = store.writePhase === "running";
  const hasConflicts = store.writeConflicts !== null && store.writeConflicts.length > 0;

  return (
    <div
      className="write-dialog-overlay"
      data-testid="write-dialog"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !running) onClose();
      }}
    >
      <div
        className="write-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Write parameters"
      >
        <div className="write-dialog-head">
          <h3 className="write-dialog-title">Write parameters</h3>
          {!running && (
            <button
              className="write-dialog-close"
              onClick={onClose}
              aria-label="Close"
              data-testid="write-dialog-close"
            >
              <X size={16} />
            </button>
          )}
        </div>

        {hasConflicts && !running ? (
          <>
            <ConflictNotice conflicts={store.writeConflicts!} />
            <div className="write-dialog-actions">
              <button
                className="btn-write-confirm"
                onClick={() => void store.acknowledgeAndWrite()}
                data-testid="write-conflict-ack"
              >
                Acknowledge conflicts and write
              </button>
              <button
                className="btn-write-secondary"
                onClick={onClose}
                data-testid="write-cancel"
              >
                Close
              </button>
            </div>
          </>
        ) : running ? (
          <div className="write-progress-block" data-testid="write-progress">
            <p className="write-progress-line">
              <Loader size={14} className="write-spinner" />
              Writing parameters...
            </p>
            <p className="write-progress-count">
              {store.writeProgress.completed} / {store.writeProgress.total}
              {store.writeProgress.currentParamId
                ? ` · Current: ${store.writeProgress.currentParamId}`
                : ""}
            </p>
          </div>
        ) : store.writePhase === "success" ? (
          <div className="write-result-block" data-testid="write-success">
            <p className="write-result-ok">
              <Check size={14} />
              Parameter write complete — {store.writeSummary?.succeeded ?? 0} /{" "}
              {store.writeSummary?.total ?? 0} verified
            </p>
            <div className="write-dialog-actions">
              <button
                className="btn-write-secondary"
                onClick={onClose}
                data-testid="write-done"
              >
                Done
              </button>
            </div>
          </div>
        ) : store.writePhase === "partial_failure" ? (
          <div className="write-result-block" data-testid="write-partial">
            <p className="write-result-warn">
              <AlertTriangle size={14} />
              Parameter write completed with errors:{" "}
              {store.writeSummary?.succeeded ?? 0} written,{" "}
              {store.writeSummary?.failed ?? 0} failed,{" "}
              {store.writeSummary?.notAttempted ?? 0} not written
            </p>
            <ul className="write-result-list">
              {store.writeSummary?.results
                .filter((r) => r.status === "failed" || r.status === "not_attempted")
                .map((r) => (
                  <li key={r.paramId} className="write-result-row">
                    <span className="write-result-id">{r.paramId}</span>
                    <span className={`write-result-status is-${r.status}`}>
                      {statusLabel(r.status)}
                    </span>
                    {r.message && (
                      <span className="write-result-msg">{r.message}</span>
                    )}
                  </li>
                ))}
            </ul>
            <div className="write-dialog-actions">
              <button
                className="btn-write-secondary"
                onClick={onClose}
                data-testid="write-close-partial"
              >
                Close
              </button>
            </div>
          </div>
        ) : store.writePhase === "interrupted" ? (
          <div className="write-result-block" data-testid="write-interrupted">
            <p className="write-result-warn">
              <AlertTriangle size={14} />
              The write was interrupted (session changed)
            </p>
            {store.writeError?.message && (
              <p className="write-error-text">{store.writeError.message}</p>
            )}
            <div className="write-dialog-actions">
              <button
                className="btn-write-secondary"
                onClick={onClose}
                data-testid="write-close-interrupted"
              >
                Close
              </button>
            </div>
          </div>
        ) : store.writePhase === "error" ? (
          <div className="write-result-block" data-testid="write-error">
            <p className="write-result-warn">
              <AlertTriangle size={14} />
              Parameter write failed
            </p>
            <p className="write-error-text">
              {store.writeError?.message ?? "An unknown error occurred."}
            </p>
            <div className="write-dialog-actions">
              <button
                className="btn-write-secondary"
                onClick={onClose}
                data-testid="write-close-error"
              >
                Close
              </button>
            </div>
          </div>
        ) : stagedList.length === 0 ? (
          <div className="write-empty" data-testid="write-empty">
            Nothing staged to write. Modify a parameter first.
          </div>
        ) : (
          <div className="write-review" data-testid="write-review">
            <div className="write-review-hint">
              <ShieldCheck size={13} />
              Writes apply sequentially and are verified against the vehicle
              echo before they count as written.
            </div>
            <table className="write-review-table">
              <thead>
                <tr>
                  <th>Parameter</th>
                  <th>Current</th>
                  <th>New</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {stagedList.map((change) => {
                  const { status, message } = resultFor(change, store.writeSummary?.results ?? []);
                  return (
                    <tr key={change.paramId}>
                      <td className="write-cell-id">{change.paramId}</td>
                      <td>{formatNumber(change.liveValue)}</td>
                      <td>{formatNumber(change.stagedValue)}</td>
                      <td>
                        <span className={`write-status-chip is-${status}`}>
                          {change.conflict && status !== "success"
                            ? "Conflict"
                            : statusLabel(status)}
                        </span>
                        {change.conflict && status !== "success" && (
                          <span className="write-status-note">
                            vehicle value changed
                          </span>
                        )}
                        {message && (
                          <span className="write-status-note">{message}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="write-dialog-actions">
              <button
                className="btn-write-secondary"
                onClick={onClose}
                data-testid="write-cancel"
              >
                Cancel
              </button>
              <button
                className="btn-write-confirm"
                onClick={() => void store.executeWrite()}
                data-testid="write-submit"
              >
                Write Params ({stagedList.length})
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}