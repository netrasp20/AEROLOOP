import { useState } from "react";
import { X, Camera, Thermometer } from "lucide-react";

type Props = {
  cameraType: "live" | "thermal";
  initialUrl?: string;
  onConnect: (url: string) => Promise<boolean>;
  onClose: () => void;
};

const LABELS: Record<Props["cameraType"], { title: string; icon: React.ReactNode }> = {
  live: { title: "Live Camera Configuration", icon: <Camera size={18} /> },
  thermal: { title: "Thermal Camera Configuration", icon: <Thermometer size={18} /> },
};

const inputStyle = {
  width: "100%" as const,
  padding: "10px 12px",
  borderRadius: 6,
  border: "1px solid #444",
  background: "#1e1e2e",
  color: "#eee",
  fontSize: 14,
  outline: "none",
  boxSizing: "border-box" as const,
};

function CameraConfigDialog({ cameraType, initialUrl = "", onConnect, onClose }: Props) {
  const [url, setUrl] = useState(initialUrl);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { title, icon } = LABELS[cameraType];

  const handleConnect = async () => {
    const trimmed = url.trim();
    if (!trimmed || connecting) return;
    setConnecting(true);
    setError(null);
    const ok = await onConnect(trimmed);
    setConnecting(false);
    if (ok) {
      onClose();
    } else {
      setError("Camera offline / Stream error");
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480 }}>
        <div className="modal-header">
          <h3 style={{ display: "flex", alignItems: "center", gap: 8 }}>{icon} {title}</h3>
          <button className="modal-close" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="modal-body" style={{ display: "flex", flexDirection: "column", gap: 12, padding: 20 }}>
          <label style={{ fontSize: 13, fontWeight: 600, color: "#e2e8f0" }}>RTSP URL</label>
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleConnect()}
            placeholder="rtsp://192.168.1.100:554/stream"
            disabled={connecting}
            autoFocus
            style={inputStyle}
          />
          {connecting && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#a78bfa", fontSize: 13 }}>
              <span
                className="spin-icon"
                style={{ width: 12, height: 12, border: "2px solid rgba(255,255,255,0.2)", borderTopColor: "#a78bfa", borderRadius: "50%" }}
              />
              Connecting...
            </div>
          )}
          {error && <div style={{ color: "#ef4444", fontSize: 13, fontWeight: 600 }}>{error}</div>}
        </div>
        <div className="modal-footer" style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button className="upload-popup-btn" onClick={onClose} style={{ background: "#333" }} disabled={connecting}>
            Cancel
          </button>
          <button className="upload-popup-btn" onClick={handleConnect} style={{ background: "#7c3aed" }} disabled={connecting}>
            {connecting ? "Connecting..." : "Connect"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default CameraConfigDialog;
