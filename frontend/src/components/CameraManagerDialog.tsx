import { useState, useCallback } from "react";
import { X, Camera, Thermometer, Link } from "lucide-react";
import { useCameraContext } from "../context/CameraContext";

type Props = {
  onClose: () => void;
};

function CameraManagerDialog({ onClose }: Props) {
  const { cameras, addCamera, connectCamera } = useCameraContext();

  const existingLive = cameras.find((c) => c.type === "live");
  const existingThermal = cameras.find((c) => c.type === "thermal");

  const [liveUrl, setLiveUrl] = useState(existingLive?.url ?? "");
  const [thermalUrl, setThermalUrl] = useState(existingThermal?.url ?? "");

  const handleConnect = useCallback(() => {
    let connected = false;

    if (liveUrl.trim()) {
      connected = true;
      const id = "cam-live";
      addCamera({ id, name: "Live Camera", url: liveUrl.trim(), type: "live" });
      connectCamera(id, liveUrl.trim());
    }

    if (thermalUrl.trim()) {
      connected = true;
      const id = "cam-thermal";
      addCamera({ id, name: "Thermal Camera", url: thermalUrl.trim(), type: "thermal" });
      connectCamera(id, thermalUrl.trim());
    }

    if (connected) onClose();
  }, [liveUrl, thermalUrl, addCamera, connectCamera, onClose]);

  const sectionStyle = {
    marginBottom: 16,
    padding: 14,
    borderRadius: 8,
    border: "1px solid #333",
    background: "rgba(0,0,0,0.15)",
  };

  const labelStyle = {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 14,
    fontWeight: 600,
    color: "#e2e8f0",
    marginBottom: 8,
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

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480 }}>
        <div className="modal-header">
          <h3 style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Link size={18} /> Connect Cameras
          </h3>
          <button className="modal-close" onClick={onClose}><X size={18} /></button>
        </div>

        <div className="modal-body" style={{ padding: 16 }}>
          <div style={sectionStyle}>
            <div style={labelStyle}>
              <Camera size={16} style={{ color: "#a78bfa" }} />
              Live Camera RTSP URL
            </div>
            <input
              placeholder="rtsp://192.168.1.100:554/live"
              value={liveUrl}
              onChange={(e) => setLiveUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleConnect()}
              style={inputStyle}
              autoFocus
            />
          </div>

          <div style={sectionStyle}>
            <div style={labelStyle}>
              <Thermometer size={16} style={{ color: "#a78bfa" }} />
              Thermal Camera RTSP URL
            </div>
            <input
              placeholder="rtsp://192.168.1.101:554/thermal"
              value={thermalUrl}
              onChange={(e) => setThermalUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleConnect()}
              style={inputStyle}
            />
          </div>
        </div>

        <div className="modal-footer" style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "12px 16px" }}>
          <button
            onClick={onClose}
            style={{ padding: "8px 16px", borderRadius: 6, border: "1px solid #444", background: "transparent", color: "#aaa", cursor: "pointer", fontSize: 13 }}
          >
            Cancel
          </button>
          <button
            onClick={handleConnect}
            style={{ padding: "8px 16px", borderRadius: 6, border: "none", background: "#7c3aed", color: "white", cursor: "pointer", fontSize: 13, fontWeight: 600 }}
          >
            Connect Cameras
          </button>
        </div>
      </div>
    </div>
  );
}

export default CameraManagerDialog;
