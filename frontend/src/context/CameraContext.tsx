import { createContext, useContext, useCallback, useState, useRef, useEffect } from "react";
import type { ReactNode } from "react";
import { startCameraStream, stopCameraStream, getStreamUrl, startRecording, stopRecording, getRecordingFolders, saveRecordingToLocation } from "../api/video";
import type { RecordingFolders } from "../api/video";
import socket from "../socket/socket";
import SaveAsDialog from "../components/SaveAsDialog";

export interface CameraConfig {
  id: string;
  name: string;
  url: string;
  type: "live" | "thermal" | "generic";
  /** Whether the stream was actively connected before a page refresh.
      Used to auto-restore the stream after reload without reconnecting
      cameras the user explicitly disconnected. */
  connected?: boolean;
}

interface CameraContextType {
  cameras: CameraConfig[];
  streams: Record<string, string | null>;
  whepUrls: Record<string, string | null>;
  connecting: Record<string, boolean>;
  recording: Record<string, boolean>;
  recordingDuration: Record<string, number>;
  pendingRecording: Record<string, { source: string; suggestedName: string } | null>;
  /** Id of the pending recording whose Save As dialog is currently open (null = none). */
  pendingSaveId: string | null;
  /** Opens the Save As dialog for an already-finalized (pending) recording. */
  requestSaveAs: (id: string) => void;
  /** Performs the actual save to a user-chosen location via the native backend. */
  commitSave: (id: string, destDir: string, destName: string) => Promise<boolean>;
  /** Closes the Save As dialog without saving (recording stays pending/safe). */
  cancelSaveAs: () => void;
  recordingFolders: RecordingFolders | null;
  addCamera: (cfg: CameraConfig) => void;
  removeCamera: (id: string) => Promise<void>;
  connectCamera: (id: string, urlOverride?: string) => Promise<{ success: boolean; whepUrl?: string }>;
  disconnectCamera: (id: string) => Promise<void>;
  connectAll: () => Promise<void>;
  disconnectAll: () => Promise<void>;
  toggleRecording: (id: string) => Promise<void>;
}

const CameraContext = createContext<CameraContextType | null>(null);

const STORAGE_KEY = "yantrayug-cameras";

// First-run seed: two empty camera slots so the DATA page has something to
// configure. They are ALWAYS disconnected until the operator explicitly enters
// a real RTSP URL and connects — we never claim a camera exists or auto-connect
// to a hardcoded device IP.
function defaultCameras(): CameraConfig[] {
  return [
    { id: "cam-live", name: "Live Camera", url: "", type: "live", connected: false },
    { id: "cam-thermal", name: "Thermal Camera", url: "", type: "thermal", connected: false },
  ];
}

function loadSaved(): CameraConfig[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    // Only seed defaults on the very first run. If the operator has cleared the
    // list (even to []), respect that and never force entries back.
    if (raw === null) return defaultCameras();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : defaultCameras();
  } catch {
    return defaultCameras();
  }
}

export function CameraProvider({ children }: { children: ReactNode }) {
  const [cameras, setCameras] = useState<CameraConfig[]>(loadSaved);
  const [streams, setStreams] = useState<Record<string, string | null>>({});
  const [whepUrls, setWhepUrls] = useState<Record<string, string | null>>({});
  const [connecting, setConnecting] = useState<Record<string, boolean>>({});
  const [recording, setRecording] = useState<Record<string, boolean>>({});
  const [recordingDuration, setRecordingDuration] = useState<Record<string, number>>({});
  const [pendingRecording, setPendingRecording] = useState<Record<string, { source: string; suggestedName: string } | null>>({});
  const [pendingSaveId, setPendingSaveId] = useState<string | null>(null);
  const [recordingFolders, setRecordingFolders] = useState<RecordingFolders | null>(null);

  const streamsRef = useRef(streams);
  streamsRef.current = streams;

  const camerasRef = useRef(cameras);
  camerasRef.current = cameras;
  const connectCameraRef = useRef<
    ((id: string, urlOverride?: string) => Promise<{ success: boolean; whepUrl?: string }>) | null
  >(null);

  const recordingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cameras));
  }, [cameras]);

  // Resolve common save locations (Desktop / Downloads / Home / Documents) from
  // the native backend so the Save As dialog can offer them as shortcuts.
  useEffect(() => {
    getRecordingFolders().then(setRecordingFolders);
  }, []);

  useEffect(() => {
    const hasRecording = Object.values(recording).some(Boolean);
    if (hasRecording && !recordingIntervalRef.current) {
      recordingIntervalRef.current = setInterval(() => {
        setRecordingDuration((prev) => {
          const next: Record<string, number> = {};
          for (const key of Object.keys(prev)) {
            next[key] = (prev[key] ?? 0) + 1;
          }
          return next;
        });
      }, 1000);
    } else if (!hasRecording && recordingIntervalRef.current) {
      clearInterval(recordingIntervalRef.current);
      recordingIntervalRef.current = null;
    }
    return () => {
      if (recordingIntervalRef.current) {
        clearInterval(recordingIntervalRef.current);
        recordingIntervalRef.current = null;
      }
    };
  }, [recording]);

  /* Re-attach the frontend to an already-running backend stream after a page
     refresh. The backend owns the persistent RTSP/MJPEG stream, so this just
     calls /video/start again (idempotent on the backend — no duplicate ffmpeg
     process). Explicitly disconnected cameras (connected === false) are
     intentionally left alone. */
  const reconnectWithRetry = useCallback((id: string, attemptsLeft: number) => {
    const attempt = (n: number) => {
      connectCameraRef.current?.(id).then((res) => {
        if (!res.success && n > 1) {
          setTimeout(() => attempt(n - 1), 1500);
        }
      });
    };
    attempt(attemptsLeft);
  }, []);

  const didAutoConnect = useRef(false);
  useEffect(() => {
    if (didAutoConnect.current) return;
    didAutoConnect.current = true;
    for (const c of camerasRef.current) {
      if (c.connected) {
        reconnectWithRetry(c.id, 4);
      }
    }
  }, [reconnectWithRetry]);

  const addCamera = useCallback((cfg: CameraConfig) => {
    setCameras((prev) => {
      const idx = prev.findIndex((c) => c.id === cfg.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = cfg;
        return next;
      }
      return [...prev, cfg];
    });
  }, []);

  const removeCamera = useCallback(async (id: string) => {
    await stopCameraStream(id);
    setCameras((prev) => prev.filter((c) => c.id !== id));
    setStreams((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setWhepUrls((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setRecording((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setRecordingDuration((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const connectCamera = useCallback(async (id: string, urlOverride?: string) => {
    const url = urlOverride ?? cameras.find((c) => c.id === id)?.url;
    if (!url) return { success: false };
    setConnecting((prev) => ({ ...prev, [id]: true }));
    const result = await startCameraStream(id, url);
    setStreams((prev) => ({ ...prev, [id]: result.success ? getStreamUrl(id) : null }));
    setWhepUrls((prev) => ({ ...prev, [id]: result.success ? (result.whepUrl ?? null) : null }));
    setConnecting((prev) => ({ ...prev, [id]: false }));
    if (result.success) {
      setCameras((prev) => prev.map((c) => (c.id === id ? { ...c, connected: true } : c)));
    }
    return result;
  }, [cameras]);
  connectCameraRef.current = connectCamera;

  const disconnectCamera = useCallback(async (id: string) => {
    await stopCameraStream(id);
    setStreams((prev) => ({ ...prev, [id]: null }));
    setWhepUrls((prev) => ({ ...prev, [id]: null }));
    setCameras((prev) => prev.map((c) => (c.id === id ? { ...c, connected: false } : c)));
  }, []);

  const connectAll = useCallback(async () => {
    for (const c of cameras) {
      if (!streamsRef.current[c.id]) {
        await connectCamera(c.id);
      }
    }
  }, [cameras, connectCamera]);

  const disconnectAll = useCallback(async () => {
    for (const c of cameras) {
      await disconnectCamera(c.id);
    }
  }, [cameras, disconnectCamera]);

  // Called when the backend reports a camera stream actually dropped (hardware
  // disconnected). The recording control must disappear, and any in-progress
  // recording is finalized safely so we never leave a corrupted/orphaned file.
  const handleStreamLost = useCallback((id: string) => {
    if (recording[id]) {
      stopRecording(id).then((filePath) => {
        setRecording((prev) => ({ ...prev, [id]: false }));
        setRecordingDuration((prev) => ({ ...prev, [id]: 0 }));
        if (filePath) {
          const source = filePath.split(/[\\/]/).pop() || `${id}.mp4`;
          const suggestedName = source.replace(/\.mp4$/i, "");
          setPendingRecording((prev) => ({ ...prev, [id]: { source, suggestedName } }));
          setPendingSaveId(id);
        }
      });
    }
    setStreams((prev) => ({ ...prev, [id]: null }));
    setWhepUrls((prev) => ({ ...prev, [id]: null }));
    setCameras((prev) => prev.map((c) => (c.id === id ? { ...c, connected: false } : c)));
  }, [recording]);

  // Track real hardware connection state from the backend. Only a "disconnected"
  // event matters here — connection is established via connectCamera's real
  // success result, so we don't need to synthesize connection on the frontend.
  useEffect(() => {
    const onStatus = (payload: { id?: string; connected?: boolean }) => {
      if (payload && payload.id && payload.connected === false) {
        handleStreamLost(payload.id);
      }
    };
    socket.on("camera-stream-status", onStatus);
    return () => {
      socket.off("camera-stream-status", onStatus);
    };
  }, [handleStreamLost]);

  // Opens the in-app Save As dialog for a finalized (pending) recording. The
  // recording itself stays in the backend's RECORDINGS_DIR until the user picks
  // a location and confirms (or cancels — then it remains pending/safe).
  const requestSaveAs = useCallback((id: string) => {
    if (!pendingRecording[id]) return;
    setPendingSaveId(id);
  }, [pendingRecording]);

  // Cancelling the Save As dialog does NOT discard the recording — it simply
  // closes the dialog and keeps the pending recording so it can be saved later
  // via the "Save recording" button.
  const cancelSaveAs = useCallback(() => {
    setPendingSaveId(null);
  }, []);

  // Performs the real save: asks the native backend to copy the finalized
  // recording to the user-chosen folder + filename. Works in every browser
  // because the filesystem write happens in the local Node process.
  const commitSave = useCallback(async (id: string, destDir: string, destName: string) => {
    const pending = pendingRecording[id];
    if (!pending) return false;
    const finalPath = await saveRecordingToLocation(pending.source, destDir, destName);
    if (finalPath) {
      setPendingRecording((prev) => ({ ...prev, [id]: null }));
      setPendingSaveId(null);
      return true;
    }
    return false;
  }, [pendingRecording]);

  const toggleRecording = useCallback(async (id: string) => {
    const isRecording = recording[id];
    if (isRecording) {
      const filePath = await stopRecording(id);
      setRecording((prev) => ({ ...prev, [id]: false }));
      setRecordingDuration((prev) => ({ ...prev, [id]: 0 }));
      if (filePath) {
        const source = filePath.split(/[\\/]/).pop() || `${id}.mp4`;
        const suggestedName = source.replace(/\.mp4$/i, "");
        setPendingRecording((prev) => ({ ...prev, [id]: { source, suggestedName } }));
        // Immediately open the Save As dialog so the user chooses where to keep it.
        setPendingSaveId(id);
      }
    } else {
      const cfg = cameras.find((c) => c.id === id);
      if (!cfg) return;
      const ok = await startRecording(id, cfg.url);
      if (ok) {
        setRecording((prev) => ({ ...prev, [id]: true }));
        setRecordingDuration((prev) => ({ ...prev, [id]: 0 }));
      }
    }
  }, [cameras, recording]);

  return (
    <CameraContext.Provider
      value={{
        cameras,
        streams,
        whepUrls,
        connecting,
        recording,
        recordingDuration,
        pendingRecording,
        pendingSaveId,
        requestSaveAs,
        commitSave,
        cancelSaveAs,
        recordingFolders,
        addCamera,
        removeCamera,
        connectCamera,
        disconnectCamera,
        connectAll,
        disconnectAll,
        toggleRecording,
      }}
    >
      {children}
      <SaveAsDialog />
    </CameraContext.Provider>
  );
}

export function useCameraContext(): CameraContextType {
  const context = useContext(CameraContext);
  if (!context) {
    throw new Error("useCameraContext must be used inside CameraProvider");
  }
  return context;
}
