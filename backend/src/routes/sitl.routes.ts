import { Router } from "express";
import {
  startSitlController,
  stopSitlController,
  sitlStatusController,
} from "../controllers/sitl.controller";

const router = Router();

router.post("/start", startSitlController);
router.post("/stop", stopSitlController);
router.get("/status", sitlStatusController);

export default router;
