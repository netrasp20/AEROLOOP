import { Router } from "express";

import {
  connectController,
  disconnectController,
  statusController,
  serialPortsController,
  armController,
  disarmController,
  modeController,
  setHomeController,
} from "../controllers/vehicle.controller";

const router = Router();

// Connection
router.post("/connect", connectController);
router.post("/disconnect", disconnectController);

// Vehicle Status
router.get("/status", statusController);

// Available Serial Ports
router.get("/serial-ports", serialPortsController);

// Vehicle Commands
router.post("/arm", armController);
router.post("/disarm", disarmController);
router.post("/mode", modeController);
router.post("/home", setHomeController);

export default router;