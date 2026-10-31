import { Request, Response } from "express";
import { getTelemetryData } from "../services/telemetry.service";

export function getTelemetry(_req: Request, res: Response) {
  res.json(getTelemetryData());
}
