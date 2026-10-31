import { Polyline, Tooltip } from "react-leaflet";
import { useTelemetry } from "../providers/TelemetryProvider";
import { useOperatorLocation } from "../context/OperatorLocationContext";

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function OperatorRoverLink() {
  const t = useTelemetry();
  const geo = useOperatorLocation();

  const hasRover = t.connected && t.latitude !== 0 && t.longitude !== 0;
  const hasOperator = geo.latitude !== null && geo.longitude !== null;

  if (!hasRover || !hasOperator) return null;

  const roverPos: [number, number] = [t.latitude, t.longitude];
  const operatorPos: [number, number] = [geo.latitude as number, geo.longitude as number];
  const distance = haversineM(
    operatorPos[0], operatorPos[1],
    roverPos[0], roverPos[1]
  );

  const distanceLabel = distance >= 1000
    ? `${(distance / 1000).toFixed(2)} km`
    : `${distance.toFixed(1)} m`;

  return (
    <Polyline
      positions={[operatorPos, roverPos]}
      pathOptions={{
        color: "#3B82F6",
        weight: 2,
        dashArray: "8, 8",
        opacity: 0.5,
      }}
    >
      <Tooltip
        permanent
        direction="center"
        className="link-distance-tooltip"
      >
        <span style={{ fontSize: 11, fontWeight: 600, background: "#1e293b", padding: "2px 8px", borderRadius: 4, whiteSpace: "nowrap" }}>
          📡 {distanceLabel}
        </span>
      </Tooltip>
    </Polyline>
  );
}

export default OperatorRoverLink;
