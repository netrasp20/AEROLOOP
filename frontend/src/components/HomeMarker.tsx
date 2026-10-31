import { Marker, Popup } from "react-leaflet";
import L from "leaflet";

import { useTelemetry } from "../providers/TelemetryProvider";

const homeIcon = new L.DivIcon({
  html: `
    <div
      style="
        width:42px;
        height:42px;
        border-radius:50%;
        background:#2563EB;
        display:flex;
        justify-content:center;
        align-items:center;
        font-size:20px;
        border:3px solid white;
        box-shadow:0 0 18px rgba(37,99,235,.45);
      "
    >
      H
    </div>
  `,
  className: "",
  iconSize: [42, 42],
  iconAnchor: [21, 21],
  popupAnchor: [0, -20],
});

function HomeMarker() {
  const t = useTelemetry();
  const hasHomePosition = t.homeLatitude !== 0 || t.homeLongitude !== 0;

  if (!hasHomePosition) return null;

  return (
    <Marker
      position={[t.homeLatitude, t.homeLongitude]}
      icon={homeIcon}
      zIndexOffset={1000}
    >
      <Popup>
        <div style={{ minWidth: 180 }}>
          <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Vehicle Home</div>
          <div style={{ fontSize: 12, color: "#22c55e", marginBottom: 8 }}>● Source: Vehicle Telemetry</div>
          <hr style={{ margin: "4px 0", border: "none", borderTop: "1px solid #374151" }} />
          <div style={{ lineHeight: 1.8 }}>
            <div>Latitude: <strong>{t.homeLatitude.toFixed(6)}</strong></div>
            <div>Longitude: <strong>{t.homeLongitude.toFixed(6)}</strong></div>
            <div>Altitude: <strong>{t.homeAltitude.toFixed(1)} m</strong></div>
          </div>
        </div>
      </Popup>
    </Marker>
  );
}

export default HomeMarker;