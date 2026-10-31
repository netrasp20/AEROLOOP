import { useRef, useCallback, useState, useMemo, useEffect } from "react";
import { Camera, Thermometer, Video, RefreshCw, Monitor, Circle, Square, WifiOff, Settings, Maximize2, Save } from "lucide-react";
import DraggablePanel from "./DraggablePanel";
import type { CameraConfig } from "../context/CameraContext";
import WebRTCVideo from "./WebRTCVideo";

type Props = {
  camera: CameraConfig;
  streamUrl: string | null;
  whepUrl?: string | null;
  onActivate?: () => void;
  isActive?: boolean;
  anchor?: "bottomleft" | "bottomright";
  onRefresh?: () => void;
  onRetry?: () => void;
  onConfigure?: () => void;
  connecting?: boolean;
  recording?: boolean;
  recordingDuration?: number;
  onToggleRecording?: () => void;
  pendingRecording?: boolean;
  onSavePendingRecording?: () => void;
};

function CameraViewPanel({ camera, streamUrl, whepUrl, onActivate, isActive, anchor: anchorProp, onRefresh, onRetry, onConfigure, connecting, recording, recordingDuration, onToggleRecording, pendingRecording, onSavePendingRecording }: Props) {
  const imgRef = useRef<HTMLImageElement>(null);
  const mjpegRetries = useRef(0);
  const [webrtcFailed, setWebrtcFailed] = useState(false);
  // MJPEG is the primary renderer. WebRTC is ONLY a fallback for when MJPEG
  // actually fails to load — it must never be overlaid on top of a working
  // MJPEG feed, because the camera can't serve a 2nd RTSP session (MediaMTX
  // publish) and that track comes back black/"no-signal", painting black over
  // the live picture.
  const [mjpegFailed, setMjpegFailed] = useState(false);
  const icon = camera.type === "thermal" ? <Thermometer size={14} /> : camera.type === "live" ? <Camera size={14} /> : <Video size={14} />;

  // A transient MJPEG error (e.g. the backend restarted/self-healed its stream
  // ffmpeg) should NOT immediately fall back to the black WebRTC track. Retry
  // the MJPEG source a few times first; only give up to WebRTC after that.
  const handleMjpegError = useCallback(() => {
    if (mjpegRetries.current < 3 && imgRef.current && streamUrl) {
      mjpegRetries.current += 1;
      const img = imgRef.current;
      const sep = streamUrl.includes("?") ? "&" : "?";
      // Cache-bust so the browser opens a brand-new connection to the (now
      // freshly restarted) backend stream instead of reusing a dead one.
      img.src = `${streamUrl}${sep}_r=${Date.now()}`;
      return;
    }
    setMjpegFailed(true);
  }, [streamUrl]);

  // Reset the MJPEG-failure flag whenever we switch to a different stream.
  useEffect(() => {
    mjpegRetries.current = 0;
    setMjpegFailed(false);
  }, [streamUrl]);

  const showWebrtc = !!(whepUrl && streamUrl && !webrtcFailed);

  const handleScreenshot = useCallback(() => {
    const img = imgRef.current;
    if (!img || !streamUrl) return;
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth || 640;
    canvas.height = img.naturalHeight || 480;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    try {
      canvas.toBlob((blob) => {
        if (!blob) return;
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `${camera.name}_${Date.now()}.png`;
        a.click();
        URL.revokeObjectURL(a.href);
      }, "image/png");
    } catch {
      console.warn("[CameraViewPanel] Screenshot blocked: cross-origin stream without CORS approval");
    }
  }, [streamUrl, camera.name]);

  const handleWebrtcError = useCallback(() => {
    setWebrtcFailed(true);
  }, []);

  const formatDuration = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  };

  const badgeLabel = useMemo(() => {
    if (!streamUrl) return null;
    return showWebrtc ? "WebRTC" : "MJPEG";
  }, [showWebrtc, streamUrl]);

  return (
    <DraggablePanel
      id={`camera-panel-${camera.id}`}
      title={
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {camera.name}
          {badgeLabel && (
            <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 4, background: showWebrtc ? "rgba(34,197,94,0.15)" : "rgba(245,158,11,0.15)", color: showWebrtc ? "#22c55e" : "#f59e0b", border: `1px solid ${showWebrtc ? "rgba(34,197,94,0.3)" : "rgba(245,158,11,0.3)"}` }}>
              {badgeLabel}
            </span>
          )}
          {recording && (
            <span style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "#ef4444" }}>
              <Circle size={8} fill="#ef4444" />
              {formatDuration(recordingDuration ?? 0)}
            </span>
          )}
        </span>
      }
      defaultWidth={320}
      defaultHeight={200}
      anchor={anchorProp ?? (isActive ? "bottomleft" : "bottomright")}
      icon={icon}
      onActivate={onActivate}
      isActive={isActive}
      actions={
        <>
          {onConfigure && (
            <button
              className="dock-panel-btn camera-settings-btn"
              onClick={(e) => {
                e.stopPropagation();
                onConfigure();
              }}
              onMouseDown={(e) => e.stopPropagation()}
              title="Camera Settings"
            >
              <Settings size={14} />
            </button>
          )}
          {streamUrl && onToggleRecording && (
            <button
              className="dock-panel-btn"
              onClick={onToggleRecording}
              title={recording ? "Stop Recording" : "Start Recording"}
              style={{ color: recording ? "#ef4444" : "#6b7280" }}
            >
              {recording ? <Square size={14} /> : <Circle size={14} />}
            </button>
          )}
          {streamUrl && (
            <button className="dock-panel-btn" onClick={handleScreenshot} title="Screenshot">
              <Monitor size={14} />
            </button>
          )}
          {pendingRecording && !recording && onSavePendingRecording && (
            <button
              className="dock-panel-btn"
              onClick={(e) => {
                e.stopPropagation();
                onSavePendingRecording();
              }}
              onMouseDown={(e) => e.stopPropagation()}
              title="Save recording"
              style={{ color: "#22c55e" }}
            >
              <Save size={14} />
            </button>
          )}
          {onRefresh && (
            <button className="dock-panel-btn" onClick={onRefresh} title="Refresh">
              <RefreshCw size={14} />
            </button>
          )}
        </>
      }
    >
      {connecting ? (
        <div className="camera-status">
          <span
            className="spin-icon"
            style={{ width: 14, height: 14, border: "2px solid rgba(255,255,255,0.2)", borderTopColor: "#a78bfa", borderRadius: "50%" }}
          />
          <span>Connecting...</span>
        </div>
      ) : streamUrl ? (
        <div style={{ position: "absolute", inset: "8px 10px" }}>
          {/* MJPEG is always rendered as the base layer so the widget is never
              black. WebRTC overlays on top only once it actually connects. */}
          <img
            ref={imgRef}
            src={streamUrl}
            alt={camera.name}
            onError={handleMjpegError}
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain", background: "#000" }}
          />
          {/* WebRTC is a fallback only — it is shown solely when the MJPEG base
              layer failed to load, never as an overlay on top of a good feed. */}
          {showWebrtc && whepUrl && mjpegFailed && (
            <WebRTCVideo whepUrl={whepUrl} onError={handleWebrtcError} />
          )}
          <span className="camera-live-badge">Live Video</span>
        </div>
      ) : (
        <div className="camera-placeholder">
          <div style={{ position: "relative" }}>
            {icon}
            <WifiOff size={16} style={{ position: "absolute", bottom: -4, right: -8, color: "#ef4444" }} />
          </div>
          <div className="camera-placeholder-text" style={{ color: "#ef4444" }}>Camera offline / Stream error</div>
          <div className="camera-placeholder-hint">{camera.name} · {camera.url}</div>
          {onRetry && (
            <button className="connect-camera-btn" onClick={onRetry} style={{ marginLeft: 0 }}>
              <RefreshCw size={12} /> Retry
            </button>
          )}
        </div>
      )}
      {onActivate && (
        <button
          className="camera-expand-hint"
          title="Click to expand to main view"
          onClick={(e) => {
            e.stopPropagation();
            onActivate();
          }}
        >
          <Maximize2 size={12} /> Expand
        </button>
      )}
    </DraggablePanel>
  );
}

export default CameraViewPanel;
