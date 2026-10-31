import { Router } from "express";

import {
  saveMissionController,
  getMissionController,
  clearMissionController,
} from "../controllers/mission.controller";
import { startMissionController } from "../controllers/missionStart.controller";

const router = Router();

router.get("/", getMissionController);

router.post("/", saveMissionController);

router.delete("/", clearMissionController);

router.post("/start", startMissionController);

export default router;
