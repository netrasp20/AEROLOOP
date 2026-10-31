import { Request, Response } from "express";

import {
  connectVehicle,
  disconnectVehicle,
  getVehicleStatus,
} from "../services/vehicle.service";

import {
  armVehicle,
  disarmVehicle,
  setMode,
  setHome,
} from "../mavlink/command.service";

import { getAvailableSerialPorts } from "../services/serialPort.service";

import {
  isVehicleConnected,
  vehicleState,
} from "../mavlink/vehicleState";

// ---------------------------
// SERIAL PORTS
// ---------------------------

export async function serialPortsController(
  req: Request,
  res: Response
) {
  try {
    const ports = await getAvailableSerialPorts();

    res.json({
      success: true,
      ports,
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      success: false,
      error: String(err),
    });
  }
}

// ---------------------------
// CONNECT
// ---------------------------

export async function connectController(
  req: Request,
  res: Response
) {
  try {
    const {
      connectionType,
      host,
      port,
      device,
      baudRate,
    } = req.body;

    const result = await connectVehicle({
      connectionType,
      host,
      port,
      device,
      baudRate,
    } as any);

    res.status(result.success ? 200 : 503).json(result);
  } catch (err) {
    console.error(err);

    res.status(500).json({
      success: false,
      error: String(err),
    });
  }
}

// ---------------------------
// DISCONNECT
// ---------------------------

export function disconnectController(
  req: Request,
  res: Response
) {
  try {
    res.json(disconnectVehicle());
  } catch (err) {
    console.error(err);

    res.status(500).json({
      success: false,
      error: String(err),
    });
  }
}

// ---------------------------
// STATUS
// ---------------------------

export function statusController(
  req: Request,
  res: Response
) {
  try {
    res.json(getVehicleStatus());
  } catch (err) {
    console.error(err);

    res.status(500).json({
      success: false,
      error: String(err),
    });
  }
}

// ---------------------------
// ARM
// ---------------------------

export async function armController(
  req: Request,
  res: Response
) {
  try {
    const connected = isVehicleConnected();

    console.log("========== ARM REQUEST ==========");
    console.log(`Serial Open: ${vehicleState.serialPortOpen}`);
    console.log(`Heartbeat Received: ${vehicleState.lastHeartbeat > 0}`);
    console.log(`Vehicle Connected: ${connected}`);
    console.log(`System ID: ${vehicleState.systemId}`);
    console.log(`Component ID: ${vehicleState.componentId}`);
    console.log(`Current Mode: ${vehicleState.mode}`);
    console.log(`Current Armed State: ${vehicleState.armed}`);
    console.log("=================================");

    if (!connected) {
      const reason = !vehicleState.serialPortOpen
        ? "Serial port is not open"
        : vehicleState.lastHeartbeat === 0
          ? "No HEARTBEAT ever received"
          : `Last HEARTBEAT ${Date.now() - vehicleState.lastHeartbeat}ms ago (timeout: 10000ms)`;
      console.log(`[ARM] Rejected: ${reason}`);
      return res.status(400).json({
        success: false,
        message: "Vehicle is not connected.",
      });
    }

    if (!vehicleState.missionUploaded) {
      console.log("[ARM] Rejected: Mission not uploaded");
      return res.status(400).json({
        success: false,
        message: "Mission not uploaded. Please upload a mission first.",
      });
    }

    const result = await armVehicle();

    if (result.success) {
      console.log("[ARM] SUCCESS — vehicle armed");
      res.json({
        success: true,
        message: result.message,
      });
    } else {
      console.log(`[ARM] FAILURE — ${result.message}`);
      res.status(400).json({
        success: false,
        message: result.message,
        ackCode: result.ackCode,
        ackLabel: result.ackLabel,
        statusText: result.statusText,
      });
    }
  } catch (err) {
    console.error("[ARM] EXCEPTION:", err);

    res.status(500).json({
      success: false,
      error: String(err),
    });
  }
}

// ---------------------------
// DISARM
// ---------------------------

export async function disarmController(
  req: Request,
  res: Response
) {
  try {
    const connected = isVehicleConnected();

    console.log("========== DISARM REQUEST ==========");
    console.log(`Serial Open: ${vehicleState.serialPortOpen}`);
    console.log(`Heartbeat Received: ${vehicleState.lastHeartbeat > 0}`);
    console.log(`Vehicle Connected: ${connected}`);
    console.log(`System ID: ${vehicleState.systemId}`);
    console.log(`Component ID: ${vehicleState.componentId}`);
    console.log(`Current Mode: ${vehicleState.mode}`);
    console.log(`Current Armed State: ${vehicleState.armed}`);
    console.log("====================================");

    if (!connected) {
      const reason = !vehicleState.serialPortOpen
        ? "Serial port is not open"
        : vehicleState.lastHeartbeat === 0
          ? "No HEARTBEAT ever received"
          : `Last HEARTBEAT ${Date.now() - vehicleState.lastHeartbeat}ms ago (timeout: 10000ms)`;
      console.log(`[DISARM] Rejected: ${reason}`);
      return res.status(400).json({
        success: false,
        message: "Vehicle is not connected.",
      });
    }

    const result = await disarmVehicle();

    if (result.success) {
      console.log("[DISARM] SUCCESS — vehicle disarmed");
      res.json({
        success: true,
        message: "Vehicle disarmed successfully",
      });
    } else {
      console.log(`[DISARM] FAILURE — ${result.message}`);
      res.status(400).json({
        success: false,
        message: result.message,
        ackCode: result.ackCode,
        ackLabel: result.ackLabel,
      });
    }
  } catch (err) {
    console.error("[DISARM] EXCEPTION:", err);

    res.status(500).json({
      success: false,
      error: String(err),
    });
  }
}

// ---------------------------
// MODE CHANGE
// ---------------------------

export async function modeController(
  req: Request,
  res: Response
) {
  try {
    const connected = isVehicleConnected();

    console.log("========== MODE CHANGE REQUEST ==========");
    console.log(`Serial Open: ${vehicleState.serialPortOpen}`);
    console.log(`Heartbeat Received: ${vehicleState.lastHeartbeat > 0}`);
    console.log(`Vehicle Connected: ${connected}`);
    console.log(`System ID: ${vehicleState.systemId}`);
    console.log(`Component ID: ${vehicleState.componentId}`);
    console.log(`Current Mode: ${vehicleState.mode}`);
    console.log(`Armed State: ${vehicleState.armed}`);
    console.log("========================================");

    if (!connected) {
      const reason = !vehicleState.serialPortOpen
        ? "Serial port is not open"
        : vehicleState.lastHeartbeat === 0
          ? "No HEARTBEAT ever received"
          : `Last HEARTBEAT ${Date.now() - vehicleState.lastHeartbeat}ms ago (timeout: 10000ms)`;
      console.log(`[MODE] Rejected: ${reason}`);
      return res.status(400).json({
        success: false,
        message: "Vehicle is not connected.",
      });
    }

    const result = await setMode(req.body.mode);

    if (result.success) {
      console.log(`[MODE] SUCCESS — changed to ${req.body.mode}`);
      res.json({
        success: true,
        message: `Mode changed to ${req.body.mode}`,
        mode: req.body.mode,
      });
    } else {
      console.log(`[MODE] FAILURE — ${result.message}`);
      res.status(400).json({
        success: false,
        message: result.message,
        ackCode: result.ackCode,
        ackLabel: result.ackLabel,
      });
    }
  } catch (err) {
    console.error("[MODE] EXCEPTION:", err);

    res.status(500).json({
      success: false,
      error: String(err),
    });
  }
}

// ---------------------------
// SET HOME
// ---------------------------
export async function setHomeController(req: Request, res: Response) {
  console.log("========================================");
  console.log("[HOME] SET HOME requested");

  if (!isVehicleConnected()) {
    console.log("[HOME] Rejected: vehicle not connected");
    return res.status(400).json({
      success: false,
      message: "Vehicle is not connected.",
    });
  }

  try {
    const { lat, lon, alt } = req.body ?? {};
    const result = await setHome(
      lat !== undefined && lon !== undefined ? { lat, lon, alt } : undefined
    );

    if (result.success) {
      console.log(`[HOME] SUCCESS — home set`);
      res.json({
        success: true,
        message: "Home location set.",
      });
    } else {
      console.log(`[HOME] FAILURE — ${result.message}`);
      res.status(400).json({
        success: false,
        message: result.message,
        ackCode: result.ackCode,
        ackLabel: result.ackLabel,
      });
    }
  } catch (err) {
    console.error("[HOME] EXCEPTION:", err);
    res.status(500).json({
      success: false,
      error: String(err),
    });
  }
}