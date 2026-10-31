import { Circle, Save } from "lucide-react";
import { useCameraContext } from "../context/CameraContext";

/**
 * Global recording control, pinned to the BOTTOM of the screen.
 * Mirrors the previous top-navbar recording pill but does not sit in the header.
 * Visibility/state logic is identical: it only appears when a camera stream is
 * actually connected, and it respects the camera-connection gate.
 */
export default function BottomRecControl() {
  const {
    cameras,
    streams,
    recording,
    recordingDuration,
    pendingRecording,
    toggleRecording,
    requestSaveAs,
  } = useCameraContext();

  // A camera is "really connected" only when its live stream URL exists
  // (set after connectCamera succeeds) — not merely because a config/URL exists.
  const connectedIds = Object.keys(streams).filter((k) => streams[k] != null);
  const anyStreamConnected = connectedIds.length > 0;

  // Only render when real hardware/camera is connected.
  if (!anyStreamConnected) return null;

  const activeId = Object.keys(recording).find((k) => recording[k]);
  // Only treat as "recording" if the recording camera still has a live stream,
  // so we never falsely show REC after the camera dropped.
  const activeConnected = activeId ? streams[activeId] != null : false;
  const anyRecording = !!activeId && activeConnected;

  // Prefer the currently-recording camera; otherwise the first actually
  // connected camera (so START always targets a live stream).
  const targetId =
    activeId ??
    connectedIds[0] ??
    cameras.find((c) => c.id === "cam-live")?.id ??
    cameras[0]?.id ??
    "cam-live";

  const duration = anyRecording && activeId ? (recordingDuration[activeId] ?? 0) : 0;
  const hasPending = anyStreamConnected && !!pendingRecording[targetId];

  const formatDuration = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  };

  return (
    <div className="bottom-rec-control">
      {anyRecording ? (
        <button
          className="rec-pill rec-active"
          onClick={() => toggleRecording(targetId)}
          title="Stop recording"
        >
          <Circle size={9} fill="#ef4444" className="rec-dot" />
          REC {formatDuration(duration)}
        </button>
      ) : hasPending ? (
        <button
          className="rec-pill rec-save"
          onClick={() => requestSaveAs(targetId)}
          title="Save pending recording"
        >
          <Save size={13} />
          Save
        </button>
      ) : (
        <button
          className="rec-pill rec-idle"
          onClick={() => toggleRecording(targetId)}
          title="Start recording"
        >
          <Circle size={9} fill="#ef4444" />
          REC
        </button>
      )}
    </div>
  );
}
