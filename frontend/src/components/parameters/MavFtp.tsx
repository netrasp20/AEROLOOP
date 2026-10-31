import { useState, useCallback, useEffect } from "react";
import {
  FolderOpen,
  Upload,
  Download,
  FolderPlus,
  Trash2,
  RefreshCw,
  AlertTriangle,
  Info,
  File,
  ChevronRight,
  Loader,
  X,
} from "lucide-react";

import { useParameters } from "../../context/ParameterContext";

import "../../styles/mavFtp.css";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

interface FtpEntry {
  name: string;
  type: "file" | "directory";
  size: number;
}

type FtpState = "idle" | "listing" | "uploading" | "downloading" | "creating" | "deleting" | "renaming" | "error" | "complete";

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

export default function MavFtp() {
  const store = useParameters();
  const connected = store.connection === "READY";

  const [path, setPath] = useState("/");
  const [entries, setEntries] = useState<FtpEntry[]>([]);
  const [state, setState] = useState<FtpState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState("");
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  /* ---- API helper ---- */
  const ftpApi = useCallback(
    async (endpoint: string, body: Record<string, unknown>) => {
      const resp = await fetch(`/api/ftp/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return resp.json();
    },
    []
  );

  /* ---- List directory ---- */
  const listDir = useCallback(
    async (dirPath: string) => {
      setState("listing");
      setError(null);
      try {
        const result = await ftpApi("list", { path: dirPath });
        if (result.success) {
          setEntries(result.entries || []);
          setPath(dirPath);
          setSelected(null);
        } else {
          setError(result.error?.message || "Failed to list directory.");
          setEntries([]);
        }
      } catch (e) {
        setError(`Connection error: ${e}`);
        setEntries([]);
      }
      setState("idle");
    },
    [ftpApi]
  );

  /* ---- Initial load ---- */
  useEffect(() => {
    if (connected) {
      listDir("/");
    }
  }, [connected, listDir]);

  /* ---- Navigate into directory ---- */
  const navigateInto = useCallback(
    (name: string) => {
      const sep = path.endsWith("/") ? "" : "/";
      listDir(`${path}${name}${sep}`);
    },
    [path, listDir]
  );

  /* ---- Navigate up ---- */
  const navigateUp = useCallback(() => {
    const parent = path.replace(/\/[^/]+\/?$/, "/") || "/";
    listDir(parent);
  }, [path, listDir]);

  /* ---- Download file ---- */
  const handleDownload = useCallback(async () => {
    if (!selected) return;
    const filePath = `${path}${selected}`;
    setState("downloading");
    setError(null);
    try {
      const result = await ftpApi("read", { path: filePath });
      if (result.success) {
        // Decode base64 and trigger browser download
        const binary = atob(result.data);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const blob = new Blob([bytes]);
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = selected;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } else {
        setError(result.error?.message || "Download failed.");
      }
    } catch (e) {
      setError(`Download error: ${e}`);
    }
    setState("idle");
  }, [selected, path, ftpApi]);

  /* ---- Upload file ---- */
  const handleUpload = useCallback(async () => {
    const input = document.createElement("input");
    input.type = "file";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      setState("uploading");
      setError(null);
      try {
        const arrayBuffer = await file.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);
        let binary = "";
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        const b64 = btoa(binary);
        const filePath = `${path}${file.name}`;
        const result = await ftpApi("write", { path: filePath, data: b64 });
        if (result.success) {
          await listDir(path);
        } else {
          setError(result.error?.message || "Upload failed.");
        }
      } catch (e) {
        setError(`Upload error: ${e}`);
      }
      setState("idle");
    };
    input.click();
  }, [path, ftpApi, listDir]);

  /* ---- Create directory ---- */
  const handleCreateDir = useCallback(async () => {
    const name = newFolderName.trim();
    if (!isValidEntryName(name)) {
      setError("Invalid folder name. Names cannot be empty, contain '/', or be '.' or '..'.");
      return;
    }
    const dirPath = `${path}${name}`;
    setState("creating");
    setError(null);
    try {
      const result = await ftpApi("mkdir", { path: dirPath });
      if (result.success) {
        setShowNewFolder(false);
        setNewFolderName("");
        await listDir(path);
      } else {
        setError(result.error?.message || "Create directory failed.");
      }
    } catch (e) {
      setError(`Create dir error: ${e}`);
    }
    setState("idle");
  }, [newFolderName, path, ftpApi, listDir]);

  /* ---- Delete file/dir ---- */
  const handleDelete = useCallback(async () => {
    if (!confirmDelete) return;
    const filePath = `${path}${confirmDelete}`;
    setState("deleting");
    setError(null);
    try {
      const entry = entries.find((e) => e.name === confirmDelete);
      const endpoint = entry?.type === "directory" ? "rmdir" : "remove";
      const result = await ftpApi(endpoint, { path: filePath });
      if (result.success) {
        setConfirmDelete(null);
        setSelected(null);
        await listDir(path);
      } else {
        setError(result.error?.message || "Delete failed.");
      }
    } catch (e) {
      setError(`Delete error: ${e}`);
    }
    setState("idle");
  }, [confirmDelete, path, entries, ftpApi, listDir]);

  /* ---- Rename ---- */
  const handleRename = useCallback(async () => {
    if (!renameTarget) return;
    const newName = renameValue.trim();
    if (!isValidEntryName(newName)) {
      setError("Invalid name. Names cannot be empty, contain '/', or be '.' or '..'.");
      return;
    }
    const oldPath = `${path}${renameTarget}`;
    const newPath = `${path}${newName}`;
    setState("renaming");
    setError(null);
    try {
      const result = await ftpApi("rename", { old_path: oldPath, new_path: newPath });
      if (result.success) {
        setRenameTarget(null);
        setRenameValue("");
        await listDir(path);
      } else {
        setError(result.error?.message || "Rename failed.");
      }
    } catch (e) {
      setError(`Rename error: ${e}`);
    }
    setState("idle");
  }, [renameTarget, renameValue, path, ftpApi, listDir]);

  /* ---- Disconnected ---- */
  if (!connected) {
    return (
      <div className="ftp-screen" data-testid="ftp-screen">
        <div className="ftp-header"><FolderOpen size={16} /><span>MAVFTP</span></div>
        <div className="ftp-disconnected" data-testid="ftp-disconnected">
          <AlertTriangle size={20} />
          <p>Vehicle not connected.</p>
          <p className="ftp-disconnected-hint">Connect to an ArduCopter vehicle to access the file system.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="ftp-screen" data-testid="ftp-screen">
      <div className="ftp-header">
        <FolderOpen size={16} />
        <span>MAVFTP</span>
        {state !== "idle" && state !== "error" && state !== "complete" && (
          <Loader size={14} className="ftp-spinner" />
        )}
      </div>

      <div className="ftp-description">
        <Info size={14} />
        <span>Browse the autopilot file system. Upload, download, and manage files on the connected vehicle.</span>
      </div>

      {/* Transfer progress */}
      {(state === "uploading" || state === "downloading") && (
        <div className="ftp-progress" data-testid="ftp-progress">
          <Loader size={13} className="ftp-spinner" />
          <span>
            {state === "uploading" ? "Uploading..." : "Downloading..."}
            <span className="ftp-progress-target"> {selected || (state === "uploading" ? "file" : "")}</span>
          </span>
        </div>
      )}

      {/* Breadcrumb */}
      <div className="ftp-breadcrumb" data-testid="ftp-breadcrumb">
        <button type="button" className="ftp-bread-btn" onClick={() => listDir("/")} data-testid="ftp-bread-btn">/</button>
        {path !== "/" && path.split("/").filter(Boolean).map((seg, i, arr) => {
          const segPath = "/" + arr.slice(0, i + 1).join("/") + "/";
          return (
            <span key={i} className="ftp-bread-segment">
              <ChevronRight size={12} />
              <button type="button" className="ftp-bread-btn" onClick={() => listDir(segPath)}>{seg}</button>
            </span>
          );
        })}
      </div>

      {/* Error */}
      {error && (
        <div className="ftp-error" data-testid="ftp-error">
          <AlertTriangle size={14} />
          <span>{error}</span>
          <button type="button" className="ftp-error-close" onClick={() => setError(null)} data-testid="ftp-error-close"><X size={12} /></button>
        </div>
      )}

      {/* Confirm delete dialog */}
      {confirmDelete && (
        <div className="ftp-confirm" data-testid="ftp-confirm-delete">
          <span>Delete <strong>{confirmDelete}</strong>?</span>
          <button type="button" className="ftp-confirm-cancel" onClick={() => setConfirmDelete(null)}>Cancel</button>
          <button type="button" className="ftp-confirm-delete" onClick={handleDelete} data-testid="ftp-confirm-delete-btn">Delete</button>
        </div>
      )}

      {/* New folder input */}
      {showNewFolder && (
        <div className="ftp-new-folder" data-testid="ftp-new-folder">
          <input
            type="text"
            className="ftp-new-folder-input"
            placeholder="Folder name"
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreateDir()}
            autoFocus
            data-testid="ftp-new-folder-input"
          />
          <button type="button" className="ftp-btn ftp-btn--primary" onClick={handleCreateDir}>Create</button>
          <button type="button" className="ftp-btn" onClick={() => { setShowNewFolder(false); setNewFolderName(""); }}>Cancel</button>
        </div>
      )}

      {/* Toolbar */}
      <div className="ftp-toolbar" data-testid="ftp-toolbar">
        <button type="button" className="ftp-btn" onClick={() => listDir(path)} disabled={state === "listing"} data-testid="ftp-refresh">
          <RefreshCw size={13} /> Refresh
        </button>
        <button type="button" className="ftp-btn" onClick={handleUpload} data-testid="ftp-upload">
          <Upload size={13} /> Upload
        </button>
        <button type="button" className="ftp-btn" onClick={handleDownload} disabled={!selected} data-testid="ftp-download">
          <Download size={13} /> Download
        </button>
        <button type="button" className="ftp-btn" onClick={() => setShowNewFolder(true)} data-testid="ftp-new-folder-btn">
          <FolderPlus size={13} /> New Folder
        </button>
        {selected && (
          <>
            <button type="button" className="ftp-btn" onClick={() => { setRenameTarget(selected); setRenameValue(selected); }} data-testid="ftp-rename-btn">
              Rename
            </button>
            <button type="button" className="ftp-btn ftp-btn--danger" onClick={() => setConfirmDelete(selected)} data-testid="ftp-delete-btn">
              <Trash2 size={13} /> Delete
            </button>
          </>
        )}
      </div>

      {/* Rename input */}
      {renameTarget && (
        <div className="ftp-rename" data-testid="ftp-rename">
          <span className="ftp-rename-label">Rename {renameTarget} to:</span>
          <input
            type="text"
            className="ftp-rename-input"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleRename()}
            autoFocus
            data-testid="ftp-rename-input"
          />
          <button type="button" className="ftp-btn ftp-btn--primary" onClick={handleRename} data-testid="ftp-rename-submit">Rename</button>
          <button type="button" className="ftp-btn" onClick={() => { setRenameTarget(null); setRenameValue(""); }}>Cancel</button>
        </div>
      )}

      {/* File list */}
      <div className="ftp-file-list" data-testid="ftp-file-list">
        {state === "listing" ? (
          <div className="ftp-loading"><Loader size={16} className="ftp-spinner" /> Loading...</div>
        ) : entries.length === 0 ? (
          <div className="ftp-empty">Directory is empty.</div>
        ) : (
          <>
            {path !== "/" && (
              <div className="ftp-row ftp-row--nav" onClick={navigateUp} data-testid="ftp-nav-up">
                <FolderOpen size={14} className="ftp-row-icon" />
                <span className="ftp-row-name">..</span>
                <span className="ftp-row-type">parent</span>
              </div>
            )}
            {entries.map((entry) => (
              <div
                key={entry.name}
                className={`ftp-row ${selected === entry.name ? "ftp-row--selected" : ""}`}
                onClick={() => setSelected(entry.name)}
                onDoubleClick={() => entry.type === "directory" && navigateInto(entry.name)}
                data-testid={`ftp-entry-${entry.name}`}
              >
                {entry.type === "directory" ? (
                  <FolderOpen size={14} className="ftp-row-icon ftp-row-icon--dir" />
                ) : (
                  <File size={14} className="ftp-row-icon" />
                )}
                <span className="ftp-row-name">{entry.name}</span>
                <span className="ftp-row-type">{entry.type}</span>
                <span className="ftp-row-size">{entry.type === "file" ? formatSize(entry.size) : "--"}</span>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isValidEntryName(name: string): boolean {
  if (!name || name.length === 0) return false;
  if (name === "." || name === "..") return false;
  if (name.includes("/")) return false;
  return true;
}
