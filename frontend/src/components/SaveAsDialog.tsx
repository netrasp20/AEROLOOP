import { useState, useEffect, useMemo } from "react";
import { useCameraContext } from "../context/CameraContext";
import "../styles/saveAsDialog.css";

type Shortcut = "desktop" | "downloads" | "home" | "documents" | "other";

const SHORTCUT_LABELS: Record<Exclude<Shortcut, "other">, string> = {
  desktop: "Desktop",
  downloads: "Downloads",
  home: "Home",
  documents: "Documents",
};

export default function SaveAsDialog() {
  const { pendingSaveId, pendingRecording, recordingFolders, commitSave, cancelSaveAs } = useCameraContext();

  const pending = pendingSaveId ? pendingRecording[pendingSaveId] : null;

  const [selected, setSelected] = useState<Shortcut>("desktop");
  const [customPath, setCustomPath] = useState("");
  const [filename, setFilename] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Reset the form each time a new Save As dialog opens.
  useEffect(() => {
    if (pendingSaveId && pending) {
      setSelected("desktop");
      setCustomPath("");
      setFilename(pending.suggestedName || "recording");
      setError(null);
      setSaving(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSaveId]);

  const effectiveDir = useMemo(() => {
    if (selected === "other") return customPath.trim();
    if (!recordingFolders) return "";
    return recordingFolders[selected];
  }, [selected, customPath, recordingFolders]);

  if (!pendingSaveId || !pending) return null;

  const canSave =
    !!filename.trim() &&
    !!effectiveDir &&
    (selected !== "other" || customPath.trim().length > 0) &&
    !saving;

  const handleSave = async () => {
    if (!pendingSaveId || !canSave) return;
    setSaving(true);
    setError(null);
    const ok = await commitSave(pendingSaveId, effectiveDir, filename.trim());
    setSaving(false);
    if (!ok) {
      setError("Could not save to that location. Check the folder exists / is writable and try again.");
    }
  };

  const handleCancel = () => {
    cancelSaveAs();
  };

  return (
    <div className="saveas-overlay" onMouseDown={handleCancel}>
      <div className="saveas-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="saveas-header">
          <span>Save Recording As</span>
          <button className="saveas-close" onClick={handleCancel} title="Cancel">×</button>
        </div>

        <div className="saveas-body">
          <div className="saveas-row">
            <label className="saveas-label">Recording</label>
            <span className="saveas-source">{pending.source}</span>
          </div>

          <div className="saveas-field">
            <label className="saveas-label">Save in</label>
            <div className="saveas-shortcuts">
              {(["desktop", "downloads", "home", "documents"] as const).map((key) => (
                <button
                  key={key}
                  type="button"
                  className={`saveas-shortcut${selected === key ? " active" : ""}`}
                  disabled={!recordingFolders}
                  onClick={() => setSelected(key)}
                  title={recordingFolders ? recordingFolders[key] : ""}
                >
                  {SHORTCUT_LABELS[key]}
                </button>
              ))}
              <button
                type="button"
                className={`saveas-shortcut${selected === "other" ? " active" : ""}`}
                onClick={() => setSelected("other")}
              >
                Other…
              </button>
            </div>
            {selected === "other" && (
              <input
                className="saveas-path-input"
                placeholder="/absolute/path/to/folder"
                value={customPath}
                onChange={(e) => setCustomPath(e.target.value)}
                autoFocus
              />
            )}
            {recordingFolders && selected !== "other" && (
              <div className="saveas-path-preview">{effectiveDir}</div>
            )}
          </div>

          <div className="saveas-field">
            <label className="saveas-label">File name</label>
            <input
              className="saveas-name-input"
              value={filename}
              onChange={(e) => setFilename(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canSave) handleSave();
                if (e.key === "Escape") handleCancel();
              }}
              autoFocus
            />
            <span className="saveas-ext">.mp4</span>
          </div>

          {error && <div className="saveas-error">{error}</div>}
        </div>

        <div className="saveas-footer">
          <button className="saveas-btn saveas-cancel" onClick={handleCancel} disabled={saving}>
            Cancel
          </button>
          <button className="saveas-btn saveas-save" onClick={handleSave} disabled={!canSave}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
