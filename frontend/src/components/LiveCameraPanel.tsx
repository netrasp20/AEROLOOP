import { Camera, RefreshCw, Monitor } from "lucide-react";
import DraggablePanel from "./DraggablePanel";

type Props = {
  onActivate?: () => void;
  isActive?: boolean;
  streamUrl?: string | null;
};

function LiveCameraPanel({ onActivate, isActive, streamUrl }: Props) {
  return (
    <DraggablePanel
      id="live-camera-panel"
      title="Live Camera"
      defaultWidth={380}
      defaultHeight={220}
      anchor="bottomleft"
      icon={<Camera size={14} />}
      onActivate={onActivate}
      isActive={isActive}
      actions={
        <>
          <button className="dock-panel-btn" title="Refresh">
            <RefreshCw size={14} />
          </button>
          <button className="dock-panel-btn" title="Screenshot">
            <Monitor size={14} />
          </button>
        </>
      }
    >
      {streamUrl ? (
        <img
          src={streamUrl}
          alt="Live Camera"
          style={{ width: "100%", height: "100%", objectFit: "contain", background: "#000" }}
        />
      ) : (
        <div className="camera-placeholder">
          <Camera size={32} strokeWidth={1} />
          <div className="camera-placeholder-text">No Camera Connected</div>
          <div className="camera-placeholder-hint">USB · RTSP · ESP32 · ROS</div>
        </div>
      )}
    </DraggablePanel>
  );
}

export default LiveCameraPanel;
