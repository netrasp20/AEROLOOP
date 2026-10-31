import { useState, useEffect, useCallback } from "react";

import type { MissionInfo, MissionFile } from "../types/mission";
import { missionStorageService } from "../services/MissionStorageService";
import MissionItem from "./MissionItem";

type SavedMissionListProps = {
  onLoadMission: (mission: MissionFile) => void;
  refreshToken: number;
};

function SavedMissionList({
  onLoadMission,
  refreshToken,
}: SavedMissionListProps) {
  const [missions, setMissions] = useState<MissionInfo[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [toast, setToast] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  const showToast = useCallback((type: "success" | "error", message: string) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 4000);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const list = await missionStorageService.list();
      setMissions(list);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load missions."
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh, refreshToken]);

  const filtered = missions.filter((m) =>
    m.id.toLowerCase().includes(search.toLowerCase())
  );

  async function handleLoad(id: string) {
    try {
      const data = await missionStorageService.load(id);
      onLoadMission(data);
    } catch (err) {
      console.error("Load failed:", err);
    }
  }

  async function handleRename(id: string, name: string) {
    try {
      await missionStorageService.rename(id, name);
      await refresh();
    } catch (err) {
      console.error("Rename failed:", err);
    }
  }

  async function handleDeleteConfirm() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await missionStorageService.delete(deleteTarget);
      setMissions((prev) => prev.filter((m) => m.id !== deleteTarget));
      showToast("success", `✔ ${deleteTarget} deleted successfully.`);
      setDeleteTarget(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Delete failed.";
      console.error("[DELETE] Backend error:", msg);
      showToast("error", `Unable to delete ${deleteTarget}.`);
    } finally {
      setDeleting(false);
    }
  }

  function handleDeleteCancel() {
    setDeleteTarget(null);
  }

  return (
    <div className="saved-missions">
      <div className="saved-missions-header">
        <h4>Saved Missions</h4>
        <button
          className="saved-missions-refresh"
          onClick={refresh}
          disabled={loading}
          title="Refresh"
        >
          ↻
        </button>
      </div>

      <div className="saved-missions-search">
        <input
          type="text"
          placeholder="Search missions..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {loading && (
        <div className="saved-missions-status">Loading...</div>
      )}

      {error && (
        <div className="saved-missions-status error">{error}</div>
      )}

      {!loading && !error && filtered.length === 0 && (
        <div className="saved-missions-status">
          {search ? "No missions match your search." : "No saved missions yet."}
        </div>
      )}

      {toast && (
        <div className={`saved-missions-toast ${toast.type}`}>
          {toast.message}
        </div>
      )}

      <div className="saved-missions-list">
        {filtered.map((m) => (
          <MissionItem
            key={m.id}
            mission={m}
            onLoad={handleLoad}
            onRename={handleRename}
            onDeleteRequest={setDeleteTarget}
          />
        ))}
      </div>

      {deleteTarget && (
        <div className="modal-overlay" onClick={handleDeleteCancel}>
          <div
            className="modal-content confirm-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="confirm-modal-icon">🗑</div>
            <h3 className="confirm-modal-title">Delete Mission</h3>
            <p className="confirm-modal-message">
              Are you sure you want to permanently delete
            </p>
            <p className="confirm-modal-target">{deleteTarget}</p>
            <p className="confirm-modal-warning">This action cannot be undone.</p>
            <div className="confirm-modal-actions">
              <button
                className="confirm-btn cancel"
                onClick={handleDeleteCancel}
                disabled={deleting}
              >
                Cancel
              </button>
              <button
                className="confirm-btn delete"
                onClick={handleDeleteConfirm}
                disabled={deleting}
              >
                {deleting ? "Deleting..." : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default SavedMissionList;
