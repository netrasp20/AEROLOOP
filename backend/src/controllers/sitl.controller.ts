import { Request, Response } from "express";
import { startSitl, stopSitl, getSitlStatus } from "../services/sitl.service";

export async function startSitlController(req: Request, res: Response) {
  try {
    const { vehicle, frame, latitude, longitude, altitude, heading } = req.body;

    if (!vehicle || !frame || latitude === undefined || longitude === undefined) {
      res.status(400).json({
        success: false,
        message: "Missing required params: vehicle, frame, latitude, longitude",
      });
      return;
    }

    const result = await startSitl({
      vehicle,
      frame,
      latitude: Number(latitude),
      longitude: Number(longitude),
      altitude: Number(altitude) || 900,
      heading: Number(heading) || 0,
    });

    res.status(result.success ? 200 : 500).json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
}

export function stopSitlController(req: Request, res: Response) {
  try {
    const result = stopSitl();
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
}

export function sitlStatusController(req: Request, res: Response) {
  res.json(getSitlStatus());
}
