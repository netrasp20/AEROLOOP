import { useEffect } from "react";

import MissionPlanner from "./pages/MissionPlanner";
import { MissionProvider } from "./context/MissionContext";
import { ParameterProvider } from "./context/ParameterContext";
import { OperatorLocationProvider } from "./context/OperatorLocationContext";
import { CameraProvider } from "./context/CameraContext";
import DeveloperMissionDebugPanel from "./components/DeveloperMissionDebugPanel";

import socket from "./socket/socket";

function App() {
  useEffect(() => {
    socket.on("connect", () => {
      console.log("Connected to Backend Socket");
    });

    socket.on("disconnect", () => {
      console.log("Disconnected from Backend Socket");
    });

    return () => {
      socket.off("connect");
      socket.off("disconnect");
    };
  }, []);

  return (
    <OperatorLocationProvider>
      <CameraProvider>
        <MissionProvider>
          <ParameterProvider>
            <MissionPlanner />
          </ParameterProvider>
          <DeveloperMissionDebugPanel />
        </MissionProvider>
      </CameraProvider>
    </OperatorLocationProvider>
  );
}

export default App;
