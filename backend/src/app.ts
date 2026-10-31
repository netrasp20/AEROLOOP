import express from "express";
import cors from "cors";
import vehicleRoutes from "./routes/vehicle.routes";

import telemetryRoutes from "./routes/telemetry.routes";
import missionRoutes from "./routes/mission.routes";
import missionStorageRoutes from "./routes/missionStorage.routes";
import sitlRoutes from "./routes/sitl.routes";
import videoRoutes from "./routes/video.routes";

const app = express();

app.use(cors());

app.use(express.json());

app.use("/api/telemetry", telemetryRoutes);

app.use("/api/mission", missionRoutes);
app.use("/api/missions", missionStorageRoutes);
app.use("/api/vehicle", vehicleRoutes);
app.use("/api/sitl", sitlRoutes);
app.use("/api", videoRoutes);

export default app;