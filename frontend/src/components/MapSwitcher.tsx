type MapType = "sat" | "map" | "terrain";

// Esri ArcGIS Online basemaps genuinely serve tiles up to zoom level 23
// (verified via each service's tileInfo.lods). We let the map zoom all the way
// to that native maximum instead of imposing an artificial lower cap.
const TILE_MAX_ZOOM = 23;

const TILES: Record<MapType, { url: string; attribution: string; maxNativeZoom: number }> = {
  sat: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution: "Esri",
    maxNativeZoom: TILE_MAX_ZOOM,
  },
  map: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
    attribution: "Esri",
    maxNativeZoom: TILE_MAX_ZOOM,
  },
  terrain: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
    attribution: "Esri",
    maxNativeZoom: TILE_MAX_ZOOM,
  },
};

function MapSwitcher({
  active,
  onChange,
}: {
  active: MapType;
  onChange: (type: MapType) => void;
}) {
  return (
    <div className="map-switcher">
      {(Object.keys(TILES) as MapType[]).map((key) => (
        <button
          key={key}
          className={active === key ? "active" : ""}
          onClick={() => onChange(key)}
        >
          {key.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

export { TILES };
export type { MapType };
export default MapSwitcher;