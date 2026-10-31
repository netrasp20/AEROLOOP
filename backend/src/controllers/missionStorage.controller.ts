import { Request, Response } from "express";
import {
  listMissions,
  saveMission,
  loadMission,
  deleteMission,
  renameMission,
  duplicateMission,
} from "../services/missionStorage.service";

export async function listMissionsController(
  req: Request,
  res: Response
) {
  try {
    const missions = await listMissions();
    res.json({ success: true, missions });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err instanceof Error ? err.message : "Failed to list missions.",
    });
  }
}

export async function saveMissionController(
  req: Request,
  res: Response
) {
  try {
    const { home, waypoints } = req.body;

    if (!Array.isArray(waypoints)) {
      res.status(400).json({
        success: false,
        message: "Invalid mission data: waypoints must be an array.",
      });
      return;
    }

    const entry = await saveMission({ home, waypoints });
    res.status(201).json({ success: true, mission: entry });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err instanceof Error ? err.message : "Failed to save mission.",
    });
  }
}

export async function loadMissionController(
  req: Request,
  res: Response
) {
  try {
      const id = req.params.id as string;
      const data = await loadMission(id);

    if (!data) {
      res.status(404).json({
        success: false,
        message: `Mission "${id}" not found.`,
      });
      return;
    }

    res.json({ success: true, mission: data });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err instanceof Error ? err.message : "Failed to load mission.",
    });
  }
}

export async function deleteMissionController(
  req: Request,
  res: Response
) {
  try {
      const id = req.params.id as string;
      const deleted = await deleteMission(id);

    if (!deleted) {
      res.status(404).json({
        success: false,
        message: `Mission "${id}" not found.`,
      });
      return;
    }

    res.json({ success: true, message: `Mission "${id}" deleted.` });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err instanceof Error ? err.message : "Failed to delete mission.",
    });
  }
}

export async function renameMissionController(
  req: Request,
  res: Response
) {
  try {
    const id = req.params.id as string;
    const { name } = req.body;

    if (!name || typeof name !== "string") {
      res.status(400).json({
        success: false,
        message: "New name is required.",
      });
      return;
    }

    const renamed = await renameMission(id, name);

    if (!renamed) {
      res.status(400).json({
        success: false,
        message: `Failed to rename "${id}". Name may already exist or be invalid.`,
      });
      return;
    }

    res.json({ success: true, message: `Mission renamed to "${name}".` });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err instanceof Error ? err.message : "Failed to rename mission.",
    });
  }
}

export async function duplicateMissionController(
  req: Request,
  res: Response
) {
  try {
    const id = req.params.id as string;
    const entry = await duplicateMission(id);

    if (!entry) {
      res.status(404).json({
        success: false,
        message: `Mission "${id}" not found.`,
      });
      return;
    }

    res.status(201).json({ success: true, mission: entry });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err instanceof Error ? err.message : "Failed to duplicate mission.",
    });
  }
}
