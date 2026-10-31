import { Request, Response } from "express";
import { validateStart, startMission } from "../services/missionStart.service";
import { vehicleState } from "../mavlink/vehicleState";
import { getTransport } from "../mavlink/mavlink.service";

export async function startMissionController(_req: Request, res: Response) {
  const validation = validateStart();
  if (!validation.success) {
    res.status(400).json({
      success: false,
      message: validation.message,
    });
    return;
  }

  try {
    const transport = getTransport();
    if (!transport) {
      res.status(500).json({
        success: false,
        message: "No transport available.",
      });
      return;
    }

    const sysId = vehicleState.systemId || 1;
    const compId = vehicleState.componentId || 1;

    const result = await startMission(transport, sysId, compId);

    if (result.success) {
      res.json({
        success: true,
        message: result.message,
      });
    } else {
      res.status(500).json({
        success: false,
        message: result.message,
        ackCode: result.ackCode,
        ackLabel: result.ackLabel,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Mission start failed.";
    res.status(500).json({
      success: false,
      message: msg,
    });
  }
}
