import { useState, useCallback, useEffect } from "react";

import { useMissionContext } from "../context/MissionContext";
import { useMissionUpload } from "../hooks/useMissionUpload";
import { useTelemetry } from "../providers/TelemetryProvider";
import { missionStorageService } from "../services/MissionStorageService";
import ScheduledMissionService from "../services/ScheduledMissionService";
import SavedMissionList from "./SavedMissionList";
import SaveMissionDialog from "./mission/SaveMissionDialog";
import ScheduleMissionDialog from "./ScheduleMissionDialog";
import UploadErrorPopup from "./UploadErrorPopup";
import UploadCardMenu from "./UploadCardMenu";
import socket from "../socket/socket";
import { isScheduleDueSoon, formatCountdown } from "../utils/schedule";

import type { MissionFile, MissionInfo, ScheduledMission, MissionRepeat } from "../types/mission";

function repeatLabel(r: MissionRepeat): string {
  switch (r) {
    case "once": return "Once";
    case "daily": return "Every Day";
    case "weekly": return "Every Week";
    case "custom": return "Custom";
  }
}

function formatScheduledDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "--";
  return d.toLocaleString(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function PlanSidebar({
  onUploadSuccess,
}: {
  onUploadSuccess?: () => void;
}) {
  const {
    waypoints,
    home,
    setWaypoints,
    setSelectedWaypointId,
    clearMission,
  } = useMissionContext();

  const telemetry = useTelemetry();

  const {
    status: uploadStatus,
    progress: uploadProgress,
    popupError,
    showSuccess,
    upload,
    reset: resetUpload,
    dismissPopup,
  } = useMissionUpload();

  const [showSaved, setShowSaved] = useState(false);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [showUploadPanel, setShowUploadPanel] = useState(false);
  const [saveInfo, setSaveInfo] = useState<MissionInfo | null>(null);
  const [clearConfirm, setClearConfirm] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const [savedMissions, setSavedMissions] = useState<MissionInfo[]>([]);
  const [loadingMissions, setLoadingMissions] = useState(false);

  // --- Mission scheduling ---
  const [showScheduleDialog, setShowScheduleDialog] = useState(false);
  const [scheduledMissions, setScheduledMissions] = useState<ScheduledMission[]>([]);
  const [, setTick] = useState(0); // force re-render for countdown

  // Load from backend on mount, fallback to localStorage
  useEffect(() => {
    ScheduledMissionService.listFromBackend().then((list) => {
      setScheduledMissions(list);
    }).catch(() => {
      try {
        setScheduledMissions(ScheduledMissionService.list());
      } catch {
        setScheduledMissions([]);
      }
    });
  }, []);

  // Re-render every second for countdown display
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // Listen for real-time schedule status events from the backend
  useEffect(() => {
    const merge = (data: Partial<ScheduledMission>) => {
      setScheduledMissions((prev) =>
        prev.map((m) => (m.id === data.id ? { ...m, ...data } : m)),
      );
    };
    const onUpdate = (data: ScheduledMission) => {
      setScheduledMissions((prev) =>
        prev.some((m) => m.id === data.id)
          ? prev.map((m) => (m.id === data.id ? { ...m, ...data } : m))
          : [data, ...prev],
      );
    };
    const onStatus = (data: { id: string; status: string }) => {
      merge({ id: data.id, status: data.status as ScheduledMission["status"] });
    };
    const onCompleted = (data: { id: string; name: string }) => {
      merge({ id: data.id, status: "completed" as const });
    };
    const onError = (data: { id: string; name: string; message: string }) => {
      merge({ id: data.id, status: "failed" as const, lastError: data.message });
      console.error(`Schedule error for ${data.name}: ${data.message}`);
    };

    socket.on("schedule:update", onUpdate);
    socket.on("schedule:status", onStatus);
    socket.on("schedule:completed", onCompleted);
    socket.on("schedule:error", onError);

    return () => {
      socket.off("schedule:update", onUpdate);
      socket.off("schedule:status", onStatus);
      socket.off("schedule:completed", onCompleted);
      socket.off("schedule:error", onError);
    };
  }, []);

  /* Management state */
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [toastMsg, setToastMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const showToast = useCallback((type: "success" | "error", text: string) => {
    setToastMsg({ type, text });
    setTimeout(() => setToastMsg(null), 4000);
  }, []);

  const refreshMissions = useCallback(async () => {
    try {
      const list = await missionStorageService.list();
      setSavedMissions(list);
    } catch {
      setSavedMissions([]);
    }
  }, []);

  const isUploading = uploadStatus === "uploading";

  useEffect(() => {
    if (showUploadPanel) {
      setLoadingMissions(true);
      refreshMissions().finally(() => setLoadingMissions(false));
    }
  }, [showUploadPanel, refreshMissions]);

  const handleSaveNamed = useCallback(async (missionName: string) => {
    try {
      const info = await missionStorageService.save({ home: null, waypoints });
      let finalId = info.id;
      try {
        await missionStorageService.rename(info.id, missionName);
        finalId = missionName.trim().replace(/[^a-zA-Z0-9_-]/g, "_") || info.id;
      } catch {
        /* rename failed (e.g. name already used) — keep the auto-generated id */
      }
      setSaveInfo({ ...info, id: finalId, filename: `${finalId}.json` });
      setRefreshToken((t) => t + 1);
      setTimeout(() => setSaveInfo(null), 7000);
    } catch (err) {
      console.error("Save failed:", err);
    } finally {
      setShowSaveDialog(false);
    }
  }, [waypoints]);

  const loadMissionFromData = useCallback((data: MissionFile) => {
    console.log(`[LOAD] Loading mission: ${data.waypoints.length} waypoints`);
    clearMission();
    const wps = data.waypoints.map((wp, i) => ({
      id: i + 1,
      lat: wp.lat,
      lng: wp.lng,
      altitude: wp.altitude ?? 10,
      hoverTime: wp.hoverTime ?? 5,
      command: wp.command ?? "NAV_WAYPOINT",
      frame: wp.frame ?? "GLOBAL_RELATIVE_ALT",
      sequence: wp.sequence ?? i + 1,
    }));
    setWaypoints(wps);
    setSelectedWaypointId(null);
  }, [clearMission, setWaypoints, setSelectedWaypointId]);

  const handleLoad = useCallback(
    (data: MissionFile) => {
      loadMissionFromData(data);
      setShowSaved(false);
    },
    [loadMissionFromData]
  );

  const handleUploadCurrent = useCallback(async () => {
    if (isUploading) return;
    resetUpload();
    setShowUploadPanel(false);
    const homePos = telemetry.homeLatitude !== 0 || telemetry.homeLongitude !== 0
      ? { lat: telemetry.homeLatitude, lng: telemetry.homeLongitude }
      : null;
    const result = await upload({ home: homePos, waypoints }, telemetry.connected);
    if (result.success) onUploadSuccess?.();
  }, [waypoints, upload, resetUpload, onUploadSuccess, isUploading, telemetry.connected]);

  const handleUploadSaved = useCallback(async (missionId: string) => {
    if (isUploading) return;
    const data = await missionStorageService.load(missionId);
    if (!data) return;
    loadMissionFromData(data);
    resetUpload();
    setShowUploadPanel(false);
    const homePos = telemetry.homeLatitude !== 0 || telemetry.homeLongitude !== 0
      ? { lat: telemetry.homeLatitude, lng: telemetry.homeLongitude }
      : null;
    const result = await upload({ home: homePos, waypoints: data.waypoints }, telemetry.connected);
    if (result.success) onUploadSuccess?.();
  }, [upload, resetUpload, onUploadSuccess, isUploading, telemetry.connected, loadMissionFromData]);

  /* ---- Management handlers ---- */

  const handleRename = useCallback(async (id: string, name: string) => {
    try {
      await missionStorageService.rename(id, name);
      await refreshMissions();
    } catch (err) {
      console.error("Rename failed:", err);
    }
  }, [refreshMissions]);

  const handleDuplicate = useCallback(async (id: string) => {
    try {
      await missionStorageService.duplicate(id);
      await refreshMissions();
      showToast("success", `✔ ${id} duplicated.`);
    } catch {
      showToast("error", `Unable to duplicate ${id}.`);
    }
  }, [refreshMissions, showToast]);

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await missionStorageService.delete(deleteTarget);
      setSavedMissions((prev) => prev.filter((m) => m.id !== deleteTarget));
      showToast("success", `✔ ${deleteTarget} deleted successfully.`);
      setDeleteTarget(null);
    } catch {
      showToast("error", `Unable to delete ${deleteTarget}.`);
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, showToast]);

  const handleClearMission = useCallback(() => {
    if (!clearConfirm) {
      setClearConfirm(true);
      return;
    }
    clearMission();
    setClearConfirm(false);
  }, [clearConfirm, clearMission]);

  // Snapshot the ACTUAL current mission (waypoints + home) for scheduling.
  const buildSnapshot = useCallback((): MissionFile => {
    const homePos =
      telemetry.homeLatitude !== 0 || telemetry.homeLongitude !== 0
        ? { lat: telemetry.homeLatitude, lng: telemetry.homeLongitude }
        : home ?? null;
    return {
      version: 1,
      timestamp: new Date().toISOString(),
      home: homePos,
      waypoints: waypoints.map((wp) => ({ ...wp })),
    };
  }, [waypoints, telemetry.homeLatitude, telemetry.homeLongitude, home]);

  const handleScheduled = useCallback(async (entry: ScheduledMission) => {
    await ScheduledMissionService.add(entry);
    setScheduledMissions((prev) => [entry, ...prev]);
    setShowScheduleDialog(false);
    showToast("success", `✔ Mission "${entry.name}" scheduled.`);
  }, [showToast]);

  const handleCancelSchedule = useCallback(async (id: string) => {
    await ScheduledMissionService.update(id, { status: "cancelled" });
    setScheduledMissions((prev) =>
      prev.map((m) => (m.id === id ? { ...m, status: "cancelled", enabled: false } : m)),
    );
  }, []);

  const handleRetrySchedule = useCallback(async (id: string) => {
    await ScheduledMissionService.update(id, { status: "scheduled", enabled: true });
    setScheduledMissions((prev) =>
      prev.map((m) => (m.id === id ? { ...m, status: "scheduled", enabled: true } : m)),
    );
  }, []);

  const uploadBtnLabel = (() => {
    if (isUploading) {
      const p = uploadProgress;
      if (p?.phase === "validating") return "Validating...";
      if (p?.phase === "connecting") return "Connecting...";
      if (p?.phase === "uploading")
        return `Uploading ${p.current}/${p.total}...`;
      if (p?.phase === "verifying")
        return "Verifying upload...";
      return "Uploading...";
    }
    return showUploadPanel ? "Close Upload Panel" : "Upload Mission";
  })();

  return (
    <div className="plan-sidebar">
      <h3>MISSION</h3>

      {(popupError || showSuccess) && (
        <UploadErrorPopup
          type={showSuccess ? "success" : "error"}
          error={popupError}
          title={showSuccess ? "✅ Mission Uploaded Successfully" : undefined}
          message={showSuccess ? "Mission has been uploaded successfully to the flight controller." : undefined}
          onClose={dismissPopup}
          autoCloseMs={showSuccess ? 4000 : undefined}
        />
      )}

      {saveInfo && (
        <div className="plan-sidebar-toast success">
          <div className="plan-sidebar-toast-header">
            <span>✓</span>
            <span>Mission saved</span>
          </div>
          <div className="plan-sidebar-toast-body">
            {saveInfo.id}
          </div>
        </div>
      )}

      <button
        onClick={() => {
          setShowSaved(!showSaved);
          if (!showSaved) setRefreshToken((t) => t + 1);
        }}
        disabled={isUploading}
      >
        {showSaved ? "Close Saved Missions" : "Load Mission"}
      </button>

      <button onClick={() => setShowSaveDialog(true)} disabled={isUploading}>Save Mission</button>

      <button
        onClick={() => setShowUploadPanel(!showUploadPanel)}
        disabled={isUploading}
        style={{
          background: isUploading ? "#6d28d9" : "#7c3aed",
          color: "white",
          fontWeight: 600,
          opacity: isUploading ? 0.8 : 1,
        }}
      >
        {uploadBtnLabel}
      </button>

      <button
        onClick={() => setShowScheduleDialog(true)}
        disabled={waypoints.length === 0}
        title={waypoints.length === 0 ? "Add waypoints before scheduling" : "Schedule this mission"}
        style={{ marginTop: "10px", background: "#0ea5e9", color: "white", fontWeight: 600 }}
      >
        Schedule Mission
      </button>

      {(isUploading || uploadProgress) && (
        <div className="plan-sidebar-progress">
          <div className="plan-sidebar-progress-header">
            <span>{uploadBtnLabel}</span>
            {uploadProgress && (
              <span>
                {uploadProgress.current}/{uploadProgress.total}
              </span>
            )}
          </div>

          {uploadProgress && uploadProgress.total > 0 && (
            <div className="plan-sidebar-progress-bar">
              <div
                className="plan-sidebar-progress-fill"
                style={{
                  width: `${(uploadProgress.current / uploadProgress.total) * 100}%`,
                }}
              />
            </div>
          )}
        </div>
      )}

      <button
        onClick={handleClearMission}
        disabled={isUploading}
        style={{
          marginTop: "10px",
          background: clearConfirm ? "#b91c1c" : "#dc2626",
        }}
        onMouseLeave={() => {
          if (clearConfirm) setClearConfirm(false);
        }}
      >
        {clearConfirm ? "Confirm Clear?" : "Clear Mission"}
      </button>

      {showSaved && (
        <SavedMissionList
          onLoadMission={handleLoad}
          refreshToken={refreshToken}
        />
      )}

      <hr />

      <h4>Vehicle Home</h4>
      <p style={{ fontSize: 12, color: "#9ca3af" }}>Read from vehicle telemetry</p>
      <p>Lat : {telemetry.homeLatitude !== 0 ? telemetry.homeLatitude.toFixed(6) : "--"}</p>
      <p>Lon : {telemetry.homeLongitude !== 0 ? telemetry.homeLongitude.toFixed(6) : "--"}</p>
      <p>Alt : {telemetry.homeAltitude !== 0 ? `${telemetry.homeAltitude.toFixed(1)} m` : "--"}</p>

      <hr />

      <h4>Mission Info</h4>
      <p>Waypoints : {waypoints.length}</p>

      <div className="scheduled-missions">
        <h4>Scheduled Missions</h4>
        {scheduledMissions.length === 0 ? (
          <p className="scheduled-missions-empty">No missions scheduled.</p>
        ) : (
          <div className="scheduled-missions-list">
            {scheduledMissions.map((s) => {
              const countdownTarget = s.nextRun ?? s.startDateTime;
              const countdown =
                s.status === "scheduled"
                  ? formatCountdown(countdownTarget)
                  : null;
              const isDueSoon = isScheduleDueSoon(countdownTarget);
              const statusBadge =
                s.status === "uploading"
                  ? "🔵 Uploading..."
                  : s.status === "waiting"
                    ? "⏸ Waiting for flight controller"
                    : s.status === "completed"
                      ? "✅ Completed"
                      : s.status === "cancelled"
                        ? "⛔ Cancelled"
                        : s.status === "failed"
                          ? "❌ Upload Failed"
                          : null;
              return (
                <div
                  key={s.id}
                  className="scheduled-mission-row"
                  style={{
                    opacity: s.status === "cancelled" ? 0.5 : 1,
                  }}
                >
                  <div className="sm-info">
                    <div className="sm-name">{s.name}</div>
                    <div className="sm-meta">
                      {formatScheduledDate(s.startDateTime)} · {repeatLabel(s.repeat)}
                    </div>
                    {countdown && (
                      <div
                        className="sm-countdown"
                        style={{
                          fontSize: 11,
                          color: isDueSoon ? "#f59e0b" : "#60a5fa",
                          fontWeight: 600,
                          marginTop: 2,
                        }}
                      >
                        {s.repeat !== "once"
                          ? `Next run ${formatScheduledDate(countdownTarget)} · ⏱ ${countdown}`
                          : `⏱ ${countdown}`}
                      </div>
                    )}
                    {statusBadge && (
                      <div className="sm-status" style={{ fontSize: 11, marginTop: 2 }}>
                        {statusBadge}
                      </div>
                    )}
                    {s.status === "failed" && s.lastError && (
                      <div
                        className="sm-error-line"
                        style={{ fontSize: 11, color: "#fca5a5", marginTop: 2 }}
                      >
                        {s.lastError}
                      </div>
                    )}
                  </div>
                  <div className="sm-actions" style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    {s.status === "failed" && (
                      <button
                        className="sm-list-retry"
                        title="Retry upload"
                        onClick={(e) => { e.stopPropagation(); handleRetrySchedule(s.id); }}
                      >
                        ↻
                      </button>
                    )}
                    {(s.status === "scheduled" || s.status === "waiting" || s.status === "failed") && (
                      <button
                        className="sm-list-cancel"
                        title="Cancel schedule"
                        onClick={() => handleCancelSchedule(s.id)}
                      >
                        ×
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {showUploadPanel && (
        <div className="upload-panel">
          <div className="upload-panel-header">▼ Upload Mission</div>

          <div className="upload-panel-item">
            <div className="upload-panel-item-info">
              <div className="upload-panel-item-name">Current Unsaved Mission</div>
              <div className="upload-panel-item-meta">
                {waypoints.length} waypoint{waypoints.length !== 1 ? "s" : ""}
              </div>
            </div>
            <button
              className="upload-panel-item-btn"
              onClick={(e) => { e.stopPropagation(); handleUploadCurrent(); }}
              disabled={isUploading}
            >
              Upload
            </button>
          </div>

          <div className="upload-panel-divider" />

          {loadingMissions && (
            <div className="saved-missions-status">Loading saved missions...</div>
          )}

          {!loadingMissions && savedMissions.length === 0 && (
            <div className="saved-missions-status">No saved missions yet.</div>
          )}

          {!loadingMissions && savedMissions.map((m) => (
            <div key={m.id} className="upload-panel-item">
              <div className="upload-panel-item-info">
                <div className="upload-panel-item-name">{m.id}</div>
                <div className="upload-panel-item-meta">
                  {m.waypointCount} waypoint{m.waypointCount !== 1 ? "s" : ""}
                  {m.hasHome ? " • Home set" : ""}
                </div>
              </div>
              <div className="upload-panel-item-actions">
                <button
                  className="upload-panel-item-btn"
                  onClick={(e) => { e.stopPropagation(); handleUploadSaved(m.id); }}
                  disabled={isUploading}
                >
                  Upload
                </button>
                <UploadCardMenu
                  mission={m}
                  onLoad={async (id) => {
                    const data = await missionStorageService.load(id);
                    if (data) handleLoad(data);
                  }}
                  onRename={handleRename}
                  onDuplicate={handleDuplicate}
                  onUpload={handleUploadSaved}
                  onDelete={setDeleteTarget}
                  disabled={isUploading}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Toast notification */}
      {toastMsg && (
        <div className={`plan-sidebar-toast ${toastMsg.type}`}>
          <div className="plan-sidebar-toast-body">{toastMsg.text}</div>
        </div>
      )}

      {/* Delete confirmation modal */}
      {deleteTarget && (
        <div className="modal-overlay" onClick={() => setDeleteTarget(null)}>
          <div
            className="modal-content confirm-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="confirm-modal-icon">🗑</div>
            <h3 className="confirm-modal-title">Delete Mission?</h3>
            <p className="confirm-modal-message">Mission:</p>
            <p className="confirm-modal-target">{deleteTarget}</p>
            <p className="confirm-modal-warning">This action cannot be undone.</p>
            <div className="confirm-modal-actions">
              <button
                className="confirm-btn cancel"
                onClick={() => setDeleteTarget(null)}
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

      {/* Save Mission modal */}
      {showSaveDialog && (
        <SaveMissionDialog
          onSave={handleSaveNamed}
          onCancel={() => setShowSaveDialog(false)}
        />
      )}

      {/* Schedule Mission modal */}
      {showScheduleDialog && (
        <ScheduleMissionDialog
          missionData={buildSnapshot()}
          defaultName={saveInfo?.id}
          connected={telemetry.connected}
          onSchedule={handleScheduled}
          onClose={() => setShowScheduleDialog(false)}
        />
      )}
    </div>
  );
}

export default PlanSidebar;
