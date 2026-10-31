import { useState } from "react";
import { X, Camera, Thermometer, Video } from "lucide-react";

type Props = {
  onConnect: (liveUrl: string, thermalUrl: string) => void;
  onClose: () => void;
};

function CameraConnectDialog({ onConnect, onClose }: Props) {
  const [liveUrl, setLiveUrl] = useState("");
  const [thermalUrl, setThermalUrl] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!liveUrl.trim()) return;
    onConnect(liveUrl.trim(), thermalUrl.trim() || liveUrl.trim());
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
        <div className="modal-header">
          <h3><Video size={18} /> Camera Connection</h3>
          <button className="modal-close" onClick={onClose}><X size={18} /></button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body" style={{ display: "flex", flexDirection: "column", gap: 16, padding: 20 }}>
            <div>
              <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, fontWeight: 600, fontSize: 13 }}>
                <Camera size={16} /> Live Camera RTSP URL
              </label>
              <input
                type="text"
                placeholder="rtsp://192.168.1.100:554/live"
                value={liveUrl}
                onChange={(e) => setLiveUrl(e.target.value)}
                style={{ width: "100%", padding: "8px 10px", borderRadius: 6, border: "1px solid #444", background: "#1e1e2e", color: "#eee", fontSize: 13 }}
                required
              />
            </div>
            <div>
              <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, fontWeight: 600, fontSize: 13 }}>
                <Thermometer size={16} /> Thermal Camera RTSP URL <span style={{ fontWeight: 400, color: "#888" }}>(optional — defaults to live URL)</span>
              </label>
              <input
                type="text"
                placeholder="rtsp://192.168.1.100:554/thermal"
                value={thermalUrl}
                onChange={(e) => setThermalUrl(e.target.value)}
                style={{ width: "100%", padding: "8px 10px", borderRadius: 6, border: "1px solid #444", background: "#1e1e2e", color: "#eee", fontSize: 13 }}
              />
            </div>
          </div>
          <div className="modal-footer" style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "12px 20px", borderTop: "1px solid #333" }}>
            <button type="button" className="upload-popup-btn" onClick={onClose} style={{ background: "#333" }}>Cancel</button>
            <button type="submit" className="upload-popup-btn" style={{ background: "#7c3aed" }}>Connect Cameras</button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default CameraConnectDialog;
