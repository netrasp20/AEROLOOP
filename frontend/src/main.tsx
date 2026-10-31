import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";

import { TelemetryProvider } from "./providers/TelemetryProvider";

import "leaflet/dist/leaflet.css";
import "./styles/mission.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <TelemetryProvider>
      <App />
    </TelemetryProvider>
  </React.StrictMode>
);