import { Request, Response } from "express";

import {
  saveMission,
  getMission,
  clearMission,
} from "../services/mission.service";

export function saveMissionController(
  req: Request,
  res: Response
) {
  saveMission(req.body);

  res.json({
    success: true,
    message: "Mission saved successfully.",
  });
}

export function getMissionController(
  req: Request,
  res: Response
) {
  res.json(getMission());
}

export function clearMissionController(
  req: Request,
  res: Response
) {
  clearMission();

  res.json({
    success: true,
    message: "Mission cleared.",
  });
}
