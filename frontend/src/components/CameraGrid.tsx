import { Camera, Thermometer, Video, WifiOff } from "lucide-react";
import { useCameraContext } from "../context/CameraContext";

type Props = {
  onSelectCamera?: (id: string) => void;
};

function CameraGrid({ onSelectCamera }: Props) {
  const { cameras, streams } = useCameraContext();

  if (cameras.length === 0) {
    return (
      <div className="camera-full">
        <Camera size={48} strokeWidth={1} style={{ opacity: 0.3 }} />
        <div className="camera-full-text">No Cameras Configured</div>
        <div className="camera-full-hint">Open Camera Manager to add a camera</div>
      </div>
    );
  }

  const cols = Math.min(cameras.length, 3);

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${cols}, 1fr)`,
        gap: 8,
        padding: 8,
        width: "100%",
        height: "100%",
      }}
    >
      {cameras.map((cam) => {
        const streamUrl = streams[cam.id];
        const Icon = cam.type === "thermal" ? Thermometer : cam.type === "live" ? Camera : Video;
        return (
          <div
            key={cam.id}
            onClick={() => onSelectCamera?.(cam.id)}
            style={{
              position: "relative",
              borderRadius: 8,
              overflow: "hidden",
              background: "#000",
              cursor: "pointer",
              border: "1px solid rgba(124,58,237,0.3)",
              transition: "border-color 0.2s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = "rgba(124,58,237,0.8)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = "rgba(124,58,237,0.3)"; }}
          >
            {streamUrl ? (
              <img
                src={streamUrl}
                alt={cam.name}
                style={{ width: "100%", height: "100%", objectFit: "contain" }}
              />
            ) : (
              <div style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                width: "100%",
                height: "100%",
                color: "#4b5563",
                gap: 6,
                minHeight: 180,
              }}>
                <Icon size={32} strokeWidth={1} />
                <WifiOff size={14} style={{ color: "#ef4444" }} />
              </div>
            )}
            <div style={{
              position: "absolute",
              bottom: 0,
              left: 0,
              right: 0,
              padding: "6px 10px",
              background: "linear-gradient(transparent, rgba(0,0,0,0.8))",
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 11,
              fontWeight: 600,
              color: streamUrl ? "#22c55e" : "#ef4444",
            }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: streamUrl ? "#22c55e" : "#ef4444" }} />
              {cam.name}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default CameraGrid;
