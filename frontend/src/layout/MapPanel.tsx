import { useState, useEffect, useRef } from "react";
import {
  MapContainer,
  TileLayer,
  useMap,
  useMapEvents,
} from "react-leaflet";
import type L from "leaflet";

import { useMissionContext } from "../context/MissionContext";

import MapControlDock from "../components/MapControlDock";
import MapAutoFit from "../components/MapAutoFit";
import MapSwitcher, { TILES, type MapType } from "../components/MapSwitcher";
import VehicleMarker from "../components/VehicleMarker";
import WaypointMarker from "../components/WaypointMarker";
import MissionPath from "../components/MissionPath";
import HomeMarker from "../components/HomeMarker";
import ContextMenu from "../components/ContextMenu";
import WaypointSettings from "../components/WaypointSettings";

import type { ActivePage } from "../pages/MissionPlanner";

import "../styles/map.css";

type MapPanelProps = {
  page: ActivePage;
};

function MapClickHandler({
  page,
}: {
  page: ActivePage;
}) {
  const {
    tool,
    addWaypoint,
    setHomePosition,
    contextMenu,
    setContextMenu,
  } = useMissionContext();

  useMapEvents({
    click(e) {
      // Hide context menu
      setContextMenu({
        ...contextMenu,
        visible: false,
      });

      // Only allow editing in PLAN page
      if (page !== "PLAN") {
        return;
      }

      // Home Tool
      if (tool === "home") {
        setHomePosition(
          e.latlng.lat,
          e.latlng.lng
        );
        return;
      }

      // Waypoint Tool
      if (tool === "waypoint") {
        addWaypoint(
          e.latlng.lat,
          e.latlng.lng
        );
        return;
      }
    },

    contextmenu(e) {
      e.originalEvent.preventDefault();

      setContextMenu({
        visible: true,
        x: e.containerPoint.x,
        y: e.containerPoint.y,
        lat: e.latlng.lat,
        lng: e.latlng.lng,
      });
    },
  });

  return null;
}

// Captures the underlying Leaflet instance so the floating control dock
// (rendered outside <MapContainer>) can drive zoom.
function MapInstanceBridge({ onReady }: { onReady: (map: L.Map) => void }) {
  const map = useMap();
  const ready = useRef(false);

  useEffect(() => {
    if (ready.current) return;
    ready.current = true;
    onReady(map);
  }, [map, onReady]);

  return null;
}

function MapPanel({ page }: MapPanelProps) {
  const [mapInstance, setMapInstance] = useState<L.Map | null>(null);
  const [mapType, setMapType] = useState<MapType>("sat");
  const mapWrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = mapWrapRef.current;
    if (!el || !mapInstance || typeof ResizeObserver === "undefined") return undefined;

    let raf = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        mapInstance.invalidateSize({ animate: false, pan: false });
      });
    });
    observer.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [mapInstance]);

  return (
    <div className="plan-map" ref={mapWrapRef}>
      {/* Floating Toolbar */}
      <MapControlDock map={mapInstance} page={page} />

      <MapContainer
        center={[12.9716, 77.5946]}
        zoom={18}
        zoomControl={false}
        className="leaflet-map"
      >
        <MapInstanceBridge onReady={setMapInstance} />
        <TileLayer
          attribution={TILES[mapType].attribution}
          url={TILES[mapType].url}
          maxNativeZoom={TILES[mapType].maxNativeZoom}
        />

        {/* Handles map click events */}
        <MapClickHandler page={page} />

        {/* Camera follow */}
        <MapAutoFit />

        {/* Mission */}
        <MissionPath />
        <WaypointMarker />
        <HomeMarker />
        <VehicleMarker />

        {/* Map Controls */}
        <MapSwitcher active={mapType} onChange={setMapType} />
      </MapContainer>

      {/* Waypoint Settings */}
      <WaypointSettings />

      {/* Right Click Menu */}
      <ContextMenu />
    </div>
  );
}

export default MapPanel;
