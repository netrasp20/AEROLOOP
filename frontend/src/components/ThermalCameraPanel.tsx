import { Thermometer, RefreshCw, Palette } from "lucide-react";
import DraggablePanel from "./DraggablePanel";

type Props = {
  onActivate?: () => void;
  isActive?: boolean;
  streamUrl?: string | null;
};

function ThermalCameraPanel({ onActivate, isActive, streamUrl }: Props) {
  return (
    <DraggablePanel
      id="thermal-camera-panel"
      title="Thermal Camera"
      defaultWidth={380}
      defaultHeight={220}
      anchor="bottomright"
      icon={<Thermometer size={14} />}
      onActivate={onActivate}
      isActive={isActive}
      actions={
        <>
          <button className="dock-panel-btn" title="Refresh">
            <RefreshCw size={14} />
          </button>
          <button className="dock-panel-btn" title="Palette">
            <Palette size={14} />
          </button>
        </>
      }
    >
      {streamUrl ? (
        <img
          src={streamUrl}
          alt="Thermal Camera"
          style={{ width: "100%", height: "100%", objectFit: "contain", background: "#000" }}
        />
      ) : (
        <div className="camera-placeholder">
          <Thermometer size={32} strokeWidth={1} />
          <div className="camera-placeholder-text">No Thermal Camera Connected</div>
          <div className="camera-placeholder-hint">FLIR · Seek · USB Thermal · ROS</div>
        </div>
      )}
    </DraggablePanel>
  );
}

export default ThermalCameraPanel;
