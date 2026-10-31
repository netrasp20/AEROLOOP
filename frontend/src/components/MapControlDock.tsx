import { useState } from "react";
import { MapPin, Plus, Minus, Crosshair } from "lucide-react";
import type L from "leaflet";

import type { ActivePage } from "../pages/MissionPlanner";

import "../styles/MapControlDock.css";

function MapControlDock({
  map,
  page,
}: {
  map: L.Map | null;
  page?: ActivePage;
}) {
  const [activeBtn, setActiveBtn] = useState<string | null>(null);

  const stop = (e: React.UIEvent) => {
    e.stopPropagation();
    e.preventDefault();
  };

  return (
    <div className="map-control-dock">
      <div className="map-control-dock-panel">
        {/* ===== Compass ===== */}
        {/* N is a fixed north indicator — it must NOT rotate with telemetry heading. */}
        <div className="dock-compass">
          <div className="dock-compass-n">N</div>
        </div>

        <div className="dock-divider" />

        {/* ===== Mission Tools (PLAN only) ===== */}
        {page === "PLAN" && (
          <>
            <button
              className={
                "dock-btn" + (activeBtn === "waypoint" ? " dock-btn--active" : "")
              }
              onMouseDown={stop}
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                setActiveBtn("waypoint");
              }}
              title="Waypoint Tool"
            >
              <MapPin size={18} />
            </button>

            <div className="dock-divider" />
          </>
        )}

        {/* ===== Recenter on Vehicle ===== */}
        <button
          className="dock-btn"
          onMouseDown={stop}
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            (window as any).__mapRecenter?.();
          }}
          title="Recenter on Vehicle"
        >
          <Crosshair size={18} />
        </button>

        <div className="dock-divider" />

        {/* ===== Zoom Controls ===== */}
        <button
          className={
            "dock-btn" + (activeBtn === "zoomIn" ? " dock-btn--active" : "")
          }
          onMouseDown={stop}
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            map?.zoomIn();
            setActiveBtn("zoomIn");
          }}
          title="Zoom In"
        >
          <Plus size={18} />
        </button>

        <button
          className={
            "dock-btn" + (activeBtn === "zoomOut" ? " dock-btn--active" : "")
          }
          onMouseDown={stop}
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            map?.zoomOut();
            setActiveBtn("zoomOut");
          }}
          title="Zoom Out"
        >
          <Minus size={18} />
        </button>
      </div>
    </div>
  );
}

export default MapControlDock;
