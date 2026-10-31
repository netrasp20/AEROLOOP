import HUD from "./components/HUD";
import FlightMap from "./components/FlightMap";
import TelemetryPanel from "./components/TelemetryPanel";
import CompassWidget from "./components/CompassWidget";
import StatusConsole from "./components/StatusConsole";

import "../styles/data.css";

function DataLayout() {
  return (
    <div className="data-layout">

      <div className="left-panel">

        <HUD />

        <CompassWidget />

      </div>

      <div className="center-panel">

        <FlightMap />

      </div>

      <div className="right-panel">

        <TelemetryPanel />

      </div>

      <div className="bottom-console">

        <StatusConsole />

      </div>

    </div>
  );
}

export default DataLayout;