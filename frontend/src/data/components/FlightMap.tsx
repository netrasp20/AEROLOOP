import MapPanel from "../../layout/MapPanel";

function FlightMap() {
  return (
    <div className="data-card map-card">
      <h3>Live Map</h3>
      <MapPanel page="DATA" />
    </div>
  );
}

export default FlightMap;
