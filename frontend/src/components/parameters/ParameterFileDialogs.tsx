import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader, X } from "lucide-react";

import type {
  ParamAnalysisView,
  ParamExportView,
  PresetListView,
  ResetStatusView,
} from "../../api/parameters";
import {
  compareParameters,
  exportParameters,
  getPresets,
  importParameters,
  presetAnalyze,
} from "../../api/parameters";

import { applySelected, summarizeApply } from "../../parameters/fileLogic";

import { useParameters } from "../../context/ParameterContext";

import type { ApplySelection } from "../../parameters/fileLogic";

/* ------------------------------------------------------------------ */
/* Shared Load / Compare file dialog                                   */
/* ------------------------------------------------------------------ */

export type FileDialogMode = "load" | "compare" | null;

interface FileDialogProps {
  mode: FileDialogMode;
  onClose: () => void;
}

function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("Could not read the file."));
    reader.readAsText(file);
  });
}

function diffLabel(analysis: ParamAnalysisView): string {
  const counts = analysis.compare.counts;
  return `${counts.changed} changed · ${counts.same} same · ${counts.unknown} unknown · ${counts.invalid} invalid`;
}

export function FileDialog({ mode, onClose }: FileDialogProps) {
  const store = useParameters();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<"pick" | "analyzing" | "done" | "error">(
    "pick"
  );
  const [analysis, setAnalysis] = useState<ParamAnalysisView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applyResult, setApplyResult] = useState<ApplySelection | null>(null);

  useEffect(() => {
    setPhase("pick");
    setAnalysis(null);
    setError(null);
    setApplyResult(null);
  }, [mode]);

  if (!mode) return null;

  const title = mode === "compare" ? "Compare parameters" : "Load parameters";

  async function handleFile(file: File) {
    setError(null);
    setApplyResult(null);
    setPhase("analyzing");
    try {
      const content = await readFileText(file);
      const view =
        mode === "compare"
          ? await compareParameters(content, file.name)
          : await importParameters(content, file.name);
      setAnalysis(view);
      setPhase("done");
    } catch (err) {
      setPhase("error");
      setError(err instanceof Error ? err.message : "The file could not be read.");
    }
  }

  function handleApply() {
    if (!analysis) return;
    const result = applySelected(analysis.compare.rows, store.stageValue);
    setApplyResult(result);
  }

  const summary = analysis ? summarizeApply(
    applyResult ?? { applied: 0, skipped: [], failed: [] },
    analysis.compare.rows
  ) : null;

  return (
    <div
      className="mp-dialog-overlay"
      data-testid="file-dialog"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="mp-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="mp-dialog-head">
          <h3 className="mp-dialog-title">{title}</h3>
          <button
            className="mp-dialog-close"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {phase === "error" && (
          <div className="mp-dialog-error" data-testid="file-dialog-error">
            <AlertTriangle size={14} />
            <span>{error ?? "The file could not be read."}</span>
          </div>
        )}

        {phase === "pick" ? (
          <div className="mp-dialog-body">
            <p className="mp-dialog-hint">
              {mode === "compare"
                ? "Choose a .param file to compare against the live vehicle."
                : "Choose a .param file to load and compare against the live vehicle. Nothing is written automatically."}
            </p>
            <button
              className="mp-action mp-action-primary"
              onClick={() => fileInputRef.current?.click()}
              data-testid="file-pick"
            >
              Choose file…
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".param,.txt,text/plain"
              style={{ display: "none" }}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void handleFile(file);
                event.target.value = "";
              }}
            />
          </div>
        ) : phase === "analyzing" ? (
          <div className="mp-dialog-body" data-testid="file-analyzing">
            <Loader size={16} className="spin-icon" />
            <span>Parsing and comparing…</span>
          </div>
        ) : (
          <div className="mp-dialog-body" data-testid="file-analysis">
            {analysis && (
              <>
                <p className="mp-parse-summary">
                  {analysis.filename}: {analysis.parse.valid} valid /{" "}
                  {analysis.parse.total} entries · {diffLabel(analysis)}
                </p>

                <div className="mp-parse-rows">
                  {analysis.parse.malformed > 0 && (
                    <p className="mp-parse-warn">
                      {analysis.parse.malformed} malformed line
                      {analysis.parse.malformed === 1 ? "" : "s"} ignored
                    </p>
                  )}
                  {analysis.compare.rows.length === 0 && (
                    <p className="mp-parse-empty">
                      No parameters found in the file.
                    </p>
                  )}
                  {analysis.compare.rows.slice(0, 200).map((row) => (
                    <div
                      key={row.paramId}
                      className={`mp-parse-row is-${row.category}`}
                      data-testid={`compare-row-${row.paramId}`}
                    >
                      <span className="mp-parse-id">{row.paramId}</span>
                      <span className="mp-parse-value">
                        file {row.fileValue}
                        {row.category === "changed" &&
                          typeof row.vehicleValue === "number" &&
                          ` · vehicle ${row.vehicleValue}`}
                        {row.category === "same"
                          ? " · matches"
                          : row.category === "unknown"
                            ? " · not on vehicle"
                            : row.category === "read_only"
                              ? " · read-only"
                              : row.category === "invalid"
                                ? " · invalid"
                                : ""}
                      </span>
                    </div>
                  ))}
                  {analysis.compare.rows.length > 200 && (
                    <p className="mp-parse-more">
                      + {analysis.compare.rows.length - 200} more
                    </p>
                  )}
                </div>

                {applyResult && (
                  <div className="mp-apply-result" data-testid="file-apply-result">
                    <p className="mp-apply-ok">
                      {applyResult.applied} change
                      {applyResult.applied === 1 ? "" : "s"} staged.
                    </p>
                    {applyResult.skipped.length > 0 && (
                      <p className="mp-apply-skip">
                        {applyResult.skipped.length} skipped (unchanged /
                        unknown / read-only).
                      </p>
                    )}
                    {applyResult.failed.length > 0 && (
                      <p className="mp-apply-fail">
                        {applyResult.failed.map((f) => f.paramId).join(", ")} could
                        not be staged.
                      </p>
                    )}
                  </div>
                )}

                <div className="mp-dialog-actions">
                  <button
                    className="mp-action"
                    onClick={() => fileInputRef.current?.click()}
                    data-testid="file-again"
                  >
                    Choose another…
                  </button>
                  <button
                    className="mp-action mp-action-primary"
                    onClick={handleApply}
                    disabled={summary !== null && summary.changed === 0}
                    data-testid="file-apply"
                  >
                    Apply selected ({summary?.changed ?? 0})
                  </button>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".param,.txt,text/plain"
                  style={{ display: "none" }}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void handleFile(file);
                    event.target.value = "";
                  }}
                />
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Save-to-file dialog                                                 */
/* ------------------------------------------------------------------ */

export function SaveDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const store = useParameters();
  const [phase, setPhase] = useState<"idle" | "saving" | "built" | "error">(
    "idle"
  );
  const [view, setView] = useState<ParamExportView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setPhase("idle");
      setView(null);
      setError(null);
    }
  }, [open]);

  if (!open) return null;

  async function handleSave() {
    setPhase("saving");
    setError(null);
    try {
      const res = await exportParameters("vehicle");
      setView(res);
      setPhase("built");
    } catch (err) {
      setPhase("error");
      setError(err instanceof Error ? err.message : "Could not export parameters.");
    }
  }

  function handleDownload() {
    if (!view) return;
    const blob = new Blob([view.content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = view.filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    onClose();
  }

  return (
    <div
      className="mp-dialog-overlay"
      data-testid="save-dialog"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="mp-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Save parameters"
      >
        <div className="mp-dialog-head">
          <h3 className="mp-dialog-title">Save to File</h3>
          <button className="mp-dialog-close" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        {phase === "error" && (
          <div className="mp-dialog-error" data-testid="save-error">
            <AlertTriangle size={14} />
            <span>{error}</span>
          </div>
        )}

        <div className="mp-dialog-body">
          <p className="mp-dialog-hint">
            Export the vehicle&apos;s authoritative parameter values as a
            .param file.
          </p>
          {phase === "built" && view && (
            <p className="mp-save-summary" data-testid="save-summary">
              {view.count} parameters · {view.source}
              {store.stagedCount > 0
                ? " · staged changes included as # StagedValue comments"
                : ""}
            </p>
          )}
          <div className="mp-dialog-actions">
            <button
              className="mp-action"
              onClick={onClose}
              data-testid="save-cancel"
            >
              Cancel
            </button>
            {phase === "built" && view ? (
              <button
                className="mp-action mp-action-primary"
                onClick={handleDownload}
                data-testid="save-download"
              >
                Download {view.filename}
              </button>
            ) : (
              <button
                className="mp-action mp-action-primary"
                onClick={() => void handleSave()}
                disabled={phase === "saving"}
                data-testid="save-go"
              >
                {phase === "saving" ? (
                  <>
                    <Loader size={13} className="spin-icon" /> Saving…
                  </>
                ) : (
                  "Build file"
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Presets dialog                                                      */
/* ------------------------------------------------------------------ */

export function PresetsDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const store = useParameters();
  const [presets, setPresets] = useState<PresetListView | null>(null);
  const [analysis, setAnalysis] = useState<ParamAnalysisView | null>(null);
  const [applyResult, setApplyResult] = useState<ApplySelection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setAnalysis(null);
    setApplyResult(null);
    setBusy(true);
    getPresets()
      .then((view) => {
        if (!view.success) {
          throw new Error("The server did not return presets.");
        }
        setPresets(view);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Could not load presets.");
      })
      .finally(() => setBusy(false));
  }, [open]);

  if (!open) return null;

  async function handleAnalyze(id: string) {
    setBusy(true);
    setError(null);
    setAnalysis(null);
    setApplyResult(null);
    try {
      const view = await presetAnalyze(id);
      setAnalysis(view);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not analyze the preset.");
    } finally {
      setBusy(false);
    }
  }

  function handleApply() {
    if (!analysis) return;
    const result = applySelected(analysis.compare.rows, store.stageValue);
    setApplyResult(result);
  }

  return (
    <div
      className="mp-dialog-overlay"
      data-testid="presets-dialog"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="mp-dialog" role="dialog" aria-modal="true" aria-label="Load preset">
        <div className="mp-dialog-head">
          <h3 className="mp-dialog-title">Load Presaved Parameters</h3>
          <button className="mp-dialog-close" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="mp-dialog-body">
          {error && (
            <div className="mp-dialog-error" data-testid="presets-error">
              <AlertTriangle size={14} />
              <span>{error}</span>
            </div>
          )}
          {busy && !presets && (
            <div className="mp-dialog-body" data-testid="presets-loading">
              <Loader size={16} className="spin-icon" /> Loading presets…
            </div>
          )}
          {presets && presets.presets.length === 0 && (
            <p className="mp-parse-empty" data-testid="presets-empty">
              No presaved parameter sets available.
            </p>
          )}
          {presets && presets.presets.length > 0 && (
            <ul className="mp-preset-list">
              {presets.presets.map((preset) => (
                <li key={preset.id} className="mp-preset-row">
                  <button
                    type="button"
                    className="mp-preset-select"
                    onClick={() => void handleAnalyze(preset.id)}
                    data-testid={`preset-${preset.id}`}
                  >
                    <span className="mp-preset-name">{preset.name}</span>
                    <span className="mp-preset-meta">
                      {preset.paramCount} params · {preset.description}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {analysis && (
            <div className="mp-preset-analysis" data-testid="preset-analysis">
              <p className="mp-parse-summary">
                {analysis.filename} · {diffLabel(analysis)}
              </p>
              {applyResult && (
                <div className="mp-apply-result" data-testid="file-apply-result">
                  <p className="mp-apply-ok">
                    {applyResult.applied} change
                    {applyResult.applied === 1 ? "" : "s"} staged.
                  </p>
                </div>
              )}
              <div className="mp-dialog-actions">
                <button
                  className="mp-action mp-action-primary"
                  onClick={handleApply}
                  disabled={!analysis || analysis.compare.counts.changed === 0}
                  data-testid="preset-apply"
                >
                  Apply selected ({analysis.compare.counts.changed})
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Reset dialog                                                        */
/* ------------------------------------------------------------------ */

export function ResetDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const store = useParameters();
  const [confirmed, setConfirmed] = useState(false);

  const status: ResetStatusView = store.resetState;

  if (!open) return null;

  const running = status.active;

  function handleReset() {
    if (running) return;
    if (!confirmed) return;
    void store.startReset();
  }

  return (
    <div
      className="mp-dialog-overlay"
      data-testid="reset-dialog"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !running) onClose();
      }}
    >
      <div className="mp-dialog" role="dialog" aria-modal="true" aria-label="Reset parameters">
        <div className="mp-dialog-head">
          <h3 className="mp-dialog-title">Reset to Default</h3>
          <button
            className="mp-dialog-close"
            onClick={onClose}
            disabled={running}
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="mp-dialog-body">
          {running || status.state === "complete" || status.state === "failed" ? (
            <div className="mp-reset-status" data-testid="reset-status">
              {running && (
                <p className="mp-reset-running">
                  <Loader size={14} className="spin-icon" />
                  {status.message || "Resetting parameters…"}
                </p>
              )}
              {status.state === "complete" && status.summary && (
                <p className="mp-reset-ok" data-testid="reset-complete">
                  Factory defaults restored. {status.summary.changedCount} changed,{" "}
                  {status.summary.unchangedCount} unchanged,{" "}
                  {status.summary.parameterCount} total.
                </p>
              )}
              {status.state === "failed" && (
                <p className="mp-reset-fail" data-testid="reset-failed">
                  <AlertTriangle size={14} />
                  {status.error?.message ?? status.message}
                </p>
              )}
            </div>
          ) : (
            <>
              <div className="mp-reset-warning">
                <AlertTriangle size={16} />
                <span>
                  This backs up the current parameters on the server, resets the
                  flight controller to factory defaults via{" "}
                  <code>MAV_CMD_PREFLIGHT_STORAGE</code>, reboots the autopilot and
                  re-downloads parameters. This will take a bit and reconnect the
                  vehicle.
                </span>
              </div>
              <label className="mp-reset-confirm" data-testid="reset-confirm">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                I understand — reset all parameters to factory defaults.
              </label>
              <div className="mp-dialog-actions">
                <button
                  className="mp-action"
                  onClick={onClose}
                  data-testid="reset-cancel"
                >
                  Cancel
                </button>
                <button
                  className="mp-action mp-action-danger"
                  onClick={handleReset}
                  disabled={!confirmed}
                  data-testid="reset-go"
                >
                  Reset to Default
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}