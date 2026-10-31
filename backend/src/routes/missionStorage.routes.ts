import { Router } from "express";

import {
  listMissionsController,
  saveMissionController,
  loadMissionController,
  deleteMissionController,
  renameMissionController,
  duplicateMissionController,
} from "../controllers/missionStorage.controller";

const router = Router();

router.get("/", listMissionsController);
router.post("/save", saveMissionController);
router.get("/:id", loadMissionController);
router.delete("/:id", deleteMissionController);
router.put("/:id/rename", renameMissionController);
router.post("/:id/duplicate", duplicateMissionController);

export default router;
