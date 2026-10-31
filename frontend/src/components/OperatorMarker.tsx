import { useEffect, useRef } from "react";
import { Marker, Popup, useMap } from "react-leaflet";
import L from "leaflet";
import { useOperatorLocation } from "../context/OperatorLocationContext";

const operatorIcon = L.divIcon({
  html: `
    <div style="
      width:28px;
      height:28px;
      border-radius:50%;
      background:#3B82F6;
      display:flex;
      justify-content:center;
      align-items:center;
      border:3px solid white;
      box-shadow:0 0 18px rgba(59,130,246,.5);
    ">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="white" xmlns="http://www.w3.org/2000/svg">
        <path d="M12 12c2.76 0 5-2.24 5-5s-2.24-5-5-5-5 2.24-5 5 2.24 5 5 5zm0 2c-3.33 0-10 1.67-10 5v2h20v-2c0-3.33-6.67-5-10-5z"/>
      </svg>
    </div>
  `,
  className: "",
  iconSize: [28, 28],
  iconAnchor: [14, 14],
  popupAnchor: [0, -16],
});

function OperatorMarker() {
  const { latitude, longitude, accuracy, error, loading, isFallback } = useOperatorLocation();
  const map = useMap();
  const markerRef = useRef<L.Marker | null>(null);
  const accuracyLayerRef = useRef<L.Circle | null>(null);

  useEffect(() => {
    if (!markerRef.current || latitude === null || longitude === null) return;
    markerRef.current.setLatLng([latitude, longitude]);
  }, [latitude, longitude]);

  useEffect(() => {
    if (latitude === null || longitude === null) return;
    // Accuracy could be null on the fallback dev position — only draw the
    // confidence circle when real browser geolocation provided a value.
    if (accuracy && accuracy > 0) {
      if (!accuracyLayerRef.current) {
        accuracyLayerRef.current = L.circle([latitude, longitude], {
          radius: accuracy,
          color: "#3B82F6",
          fillColor: "#3B82F6",
          fillOpacity: 0.1,
          weight: 1,
        }).addTo(map);
      } else {
        accuracyLayerRef.current.setLatLng([latitude, longitude]);
        accuracyLayerRef.current.setRadius(accuracy);
      }
    }
  }, [latitude, longitude, accuracy, map]);

  useEffect(() => {
    return () => {
      if (accuracyLayerRef.current) {
        accuracyLayerRef.current.remove();
        accuracyLayerRef.current = null;
      }
    };
  }, []);

  if (loading || latitude === null || longitude === null) return null;

  return (
    <Marker
      ref={markerRef}
      position={[latitude, longitude]}
      icon={operatorIcon}
    >
      <Popup>
        <div style={{ fontSize: 12, lineHeight: 1.7, minWidth: 160 }}>
          <strong style={{ fontSize: 14 }}>
            {isFallback ? "Operator (Fixed Test Location)" : "Operator"}
          </strong>
          <hr style={{ margin: "4px 0", border: "none", borderTop: "1px solid #374151" }} />
          <div>Lat: {latitude.toFixed(6)}</div>
          <div>Lng: {longitude.toFixed(6)}</div>
          {accuracy && accuracy > 0 ? (
            <div>Accuracy: ±{accuracy.toFixed(0)}m</div>
          ) : (
            <div>Accuracy: unavailable (fixed dev position)</div>
          )}
          {error && <div style={{ color: "#f59e0b", marginTop: 2 }}>{error}</div>}
        </div>
      </Popup>
    </Marker>
  );
}

export default OperatorMarker;
