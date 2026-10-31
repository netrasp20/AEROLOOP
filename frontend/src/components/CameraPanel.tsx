import { Camera, RefreshCw, Monitor } from "lucide-react";
import DraggablePanel from "./DraggablePanel";

function CameraPanel() {
  return (
    <DraggablePanel
      id="camera-panel"
      title="Camera"
      defaultWidth={360}
      defaultHeight={260}
      defaultPos={{ x: 12, y: 12 }}
      icon={<Camera size={14} />}
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
      <div className="camera-placeholder">
        <Camera size={48} strokeWidth={1} />
        <div className="camera-placeholder-text">No Camera Connected</div>
        <div className="camera-placeholder-hint">
          Connect a USB, IP, RTSP, or ESP32 camera
        </div>
      </div>
    </DraggablePanel>
  );
}

export default CameraPanel;
