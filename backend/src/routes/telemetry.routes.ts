import { Router } from "express";
import {
  getTelemetry,
} from "../controllers/telemetry.controller";

const router = Router();

router.get("/", getTelemetry);

export default router;