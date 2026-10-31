import { useEffect, useRef } from "react";
import { useMap } from "react-leaflet";
import L from "leaflet";
import { useTelemetry } from "../providers/TelemetryProvider";

function createVehicleIcon(heading: number, connected: boolean): L.DivIcon {
  const color = connected ? "#7c3aed" : "#4b5563";
  const pulse = connected
    ? `<div style="
        position: absolute; top: 50%; left: 50%;
        width: 40px; height: 40px;
        margin: -20px 0 0 -20px;
        border-radius: 50%;
        background: rgba(124,58,237,0.15);
        border: 2px solid rgba(124,58,237,0.3);
        animation: vpulse 2s ease infinite;
      "></div>`
    : "";
  return L.divIcon({
    html: `
      ${pulse}
      <div style="
        width: 28px; height: 28px;
        position: relative;
        transform: rotate(${heading}deg);
        transform-origin: center center;
        transition: transform 0.2s ease;
      ">
        <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
          <line x1="14" y1="2" x2="14" y2="10" stroke="${color}" stroke-width="1.5" stroke-linecap="round"/>
          <line x1="14" y1="18" x2="14" y2="26" stroke="${color}" stroke-width="1.5" stroke-linecap="round"/>
          <line x1="2" y1="14" x2="10" y2="14" stroke="${color}" stroke-width="1.5" stroke-linecap="round"/>
          <line x1="18" y1="14" x2="26" y2="14" stroke="${color}" stroke-width="1.5" stroke-linecap="round"/>
          <circle cx="14" cy="14" r="6" fill="${color}" stroke="white" stroke-width="1.2"/>
          <circle cx="14" cy="14" r="2.5" fill="white" opacity="0.5"/>
          <line x1="5" y1="5" x2="9.5" y2="9.5" stroke="${color}" stroke-width="1.2" stroke-linecap="round"/>
          <line x1="23" y1="5" x2="18.5" y2="9.5" stroke="${color}" stroke-width="1.2" stroke-linecap="round"/>
          <line x1="5" y1="23" x2="9.5" y2="18.5" stroke="${color}" stroke-width="1.2" stroke-linecap="round"/>
          <line x1="23" y1="23" x2="18.5" y2="18.5" stroke="${color}" stroke-width="1.2" stroke-linecap="round"/>
          <circle cx="5" cy="5" r="2.5" fill="${color}" stroke="white" stroke-width="0.8"/>
          <circle cx="23" cy="5" r="2.5" fill="${color}" stroke="white" stroke-width="0.8"/>
          <circle cx="5" cy="23" r="2.5" fill="${color}" stroke="white" stroke-width="0.8"/>
          <circle cx="23" cy="23" r="2.5" fill="${color}" stroke="white" stroke-width="0.8"/>
        </svg>
      </div>
      ${connected ? '<style>@keyframes vpulse { 0%,100% { transform: scale(1); opacity: 0.4; } 50% { transform: scale(1.3); opacity: 0.1; } }</style>' : ''}
    `,
    iconAnchor: [14, 18],
    iconSize: [40, 40],
    className: "",
  });
}

function VehicleMarker() {
  const map = useMap();
  const t = useTelemetry();
  const markerRef = useRef<L.Marker | null>(null);

  useEffect(() => {
    const hasGps = t.connected && t.latitude !== 0 && t.longitude !== 0;

    if (!hasGps) {
      if (markerRef.current) {
        map.removeLayer(markerRef.current);
        markerRef.current = null;
      }
      return;
    }

    if (markerRef.current) {
      markerRef.current.setLatLng([t.latitude, t.longitude]);
    } else {
      const icon = createVehicleIcon(t.heading, t.connected);
      markerRef.current = L.marker([t.latitude, t.longitude], { icon }).addTo(map);
    }

    return () => {
      if (markerRef.current) {
        map.removeLayer(markerRef.current);
        markerRef.current = null;
      }
    };
  }, [t.latitude, t.longitude, t.connected, map]);

  useEffect(() => {
    if (!markerRef.current || !t.connected) return;
    markerRef.current.setIcon(createVehicleIcon(t.heading, t.connected));
  }, [t.heading, t.connected]);

  return null;
}

export default VehicleMarker;
