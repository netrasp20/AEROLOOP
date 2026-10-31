import { Socket } from "socket.io";
import { send, common, MavLinkProtocolV2 } from "node-mavlink";

import {
  validateMission,
  uploadMission,
} from "../services/missionUpload.service";
import type { UploadProgressCallback } from "../services/missionUpload.service";
import { vehicleState } from "../mavlink/vehicleState";
import { telemetry } from "../mavlink/telemetry";
import { getTransport } from "../mavlink/mavlink.service";
import { broadcastVehicleStatus } from "./socket";
import { startMission, validateStart } from "../services/missionStart.service";
import { armVehicle, setMode, setMissionCurrent, getSafeArmMode, isModeArmable } from "../mavlink/command.service";
import { setMissionRunning, setAutoRtlOnCompletion, setActiveMissionWaypoints } from "../mavlink/telemetryManager";
import { returnToLaunch, validateRtl } from "../services/rtl.service";
import {
  downloadMissionFromArduPilot,
  verifyMission,
  getMissionCountFromArduPilot,
} from "../services/missionDownload.service";

/* One mission = HOME → WP1..WPn → RTL → HOME → "mission completed".
   Register the auto-RTL handler that runs when the rover reaches the last
   waypoint: switch to RTL, wait (live telemetry) until it arrives home, and
   only then does telemetryManager emit mission:completed. */
setAutoRtlOnCompletion((onProgress) => {
  return returnToLaunch(onProgress);
});

/* The first executable mission item is ALWAYS seq=1 (ArduPilot reserves
   seq=0 for HOME): for ground vehicles it is the first real waypoint, for
   air vehicles it is the NAV_TAKEOFF. Pointing the active item here before
   MISSION_START lets both vehicle types restart cleanly. Matches the item
   layout produced by waypointsToMavlinkItems. */
function firstMissionItemSeq(): number {
  return 1;
}

export function registerMissionHandlers(socket: Socket): void {
  socket.on(
    "mission:upload",
    async (payload: {
      home: { lat: number; lng: number } | null;
      waypoints: Array<{
        id: number;
        lat: number;
        lng: number;
        altitude: number;
        hoverTime: number;
        sequence: number;
      }>;
    }) => {
      const { home, waypoints } = payload;

      console.log("========================================");
      console.log("[MISSION] Upload requested - starting validation");
      console.log(`[MISSION] Waypoints received: ${waypoints.length}`);
      waypoints.forEach((wp, i) => {
        console.log(`[MISSION]   WP${wp.sequence}: lat=${wp.lat} lon=${wp.lng} alt=${wp.altitude} hover=${wp.hoverTime}`);
      });
      console.log(`[MISSION] Home: ${home ? `lat=${home.lat} lon=${home.lng}` : "NOT SET"}`);
      const validation = validateMission(home, waypoints);

      if (!validation.valid) {
        console.log(`[MISSION] Validation FAILED: ${validation.errors.join(", ")}`);
        console.log("========================================");
        socket.emit("mission:error", {
          message: "Mission validation failed.",
          errors: validation.errors,
        });
        return;
      }

      console.log("[MISSION] Validation PASSED - starting upload");

      try {
        const onProgress: UploadProgressCallback = (
          phase,
          current,
          total,
          message
        ) => {
          socket.emit("mission:progress", {
            phase,
            current,
            total,
            message,
          });
        };

        onProgress("connecting", 0, waypoints.length);

        console.log(`[MISSION] Sending ${waypoints.length} waypoints as MAVLink mission items (seq 0 = HOME reserved by ArduPilot; seq 1 = first real command: waypoint for ground vehicles, NAV_TAKEOFF for air vehicles)`);
        const { items: uploadedItems, ackCode } = await uploadMission(home, waypoints, onProgress);

        console.log(`[MISSION] Upload complete - MISSION_ACK=${ackCode} (ACCEPTED)`);

        /* ---- Verification: download mission back from ArduPilot and compare ---- */
        onProgress("verifying", 0, waypoints.length);
        console.log("[MISSION] Verifying upload — downloading mission from ArduPilot...");

        const downloadResult = await downloadMissionFromArduPilot();

        if (!downloadResult.success) {
          const msg = `Upload verification failed: ${downloadResult.error}`;
          console.log(`[MISSION] ${msg}`);
          throw new Error(msg);
        }

        const verification = verifyMission(uploadedItems, downloadResult.items);

        if (!verification.match) {
          const diffStr = verification.differences.join("; ");
          const msg = `Upload verification FAILED — mission on ArduPilot does not match uploaded mission: ${diffStr}`;
          console.log(`[MISSION] ${msg}`);
          throw new Error(msg);
        }

        console.log(`[MISSION] Verification PASSED — ${uploadedItems.length} items match ArduPilot`);

        vehicleState.missionUploaded = true;
        vehicleState.missionCompleted = false;
        vehicleState.missionRunning = false;
        vehicleState.missionTotalWaypoints = waypoints.length;
        telemetry.missionCurrent = 0;
        telemetry.missionReached = 0;
        telemetry.missionRunning = false;
        telemetry.missionCompleted = false;
        /* Remember the waypoint coordinates so the arrival guard can confirm a
           "reached" signal only when the rover is physically at the waypoint. */
        setActiveMissionWaypoints(
          waypoints.map((wp) => ({
            seq: wp.sequence,
            lat: wp.lat,
            lng: wp.lng,
          }))
        );
        broadcastVehicleStatus();

        /* Reset ArduPilot's current waypoint to 0 (HOME) so the
           mission always starts from the beginning when triggered. */
        try {
          const t = getTransport();
          if (t) {
            const cmd = new common.CommandLong();
            cmd.targetSystem = vehicleState.systemId || 1;
            cmd.targetComponent = vehicleState.componentId || 1;
            (cmd as any).command = 52;
            cmd.confirmation = 0;
            cmd._param1 = 0;
            cmd._param2 = 0; cmd._param3 = 0; cmd._param4 = 0;
            cmd._param5 = 0; cmd._param6 = 0; cmd._param7 = 0;
            await send(t, cmd);
            console.log("[MISSION] DO_SET_MISSION_CURRENT seq=0 sent — current waypoint reset to HOME");
          }
        } catch (err: any) {
          console.log(`[MISSION] DO_SET_MISSION_CURRENT failed (non-fatal): ${err.message}`);
        }

        onProgress("done", waypoints.length, waypoints.length);

        console.log(`[MISSION] Emitting mission:success (${waypoints.length} waypoints uploaded and verified)`);
        socket.emit("mission:success", {
          message: "Mission uploaded successfully.",
          waypointCount: waypoints.length,
          verifiedCount: downloadResult.count,
          vehicleMode: vehicleState.mode,
        });

        /* Auto-return to launch: every new mission must start from HOME, so if
           the vehicle is physically away from HOME the GCS automatically switches
           to RTL and waits (live telemetry) until the vehicle arrives. */
        if (!telemetry.atHome) {
          console.log(`[MISSION] Vehicle is away from home (distanceToHome=${telemetry.distanceToHome.toFixed(1)}m) — auto RTL`);
          const rtlResult = await runRtlOnSocket(socket, "auto");
          if (rtlResult.success) {
            console.log("[MISSION] Auto-RTL complete — vehicle is at home");
          }
        } else {
          console.log("[MISSION] Vehicle is already at home — no RTL needed");
          socket.emit("mission:rtl:success", {
            message: "Vehicle is already at home.",
            distanceM: telemetry.distanceToHome,
            auto: true,
          });
        }
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : "Upload failed.";

        console.log(`[MISSION] Upload FAILED: ${msg}`);
        socket.emit("mission:error", {
          message: msg,
          errors: [msg],
        });
      }
      console.log("========================================");
    }
  );

  socket.on("mission:verify", async () => {
    console.log("[MISSION] Verification requested from frontend");
    const result = await downloadMissionFromArduPilot();
    socket.emit("mission:verify:result", {
      success: result.success,
      count: result.count,
      error: result.error,
      items: result.items,
    });
  });

  socket.on("mission:start", async () => {
    console.log("========================================");
    console.log("[MISSION] Start requested — validating preconditions");
    console.log(`[MISSION]   connected=${vehicleState.connected} uploaded=${vehicleState.missionUploaded} armed=${vehicleState.armed} mode=${vehicleState.mode}`);

    /* Check ArduPilot has an actual mission */
    const apCount = await getMissionCountFromArduPilot();
    console.log(`[MISSION] ArduPilot mission count: ${apCount}`);
    if (apCount <= 0) {
      const msg = "Cannot start mission — no mission stored on ArduPilot (mission count = 0). Upload a mission first.";
      console.log(`[MISSION] Start rejected: ${msg}`);
      socket.emit("mission:start:error", { message: msg });
      console.log("========================================");
      return;
    }

    const validation = validateStart();
    if (!validation.success) {
      console.log(`[MISSION] Start rejected: ${validation.message}`);
      console.log("========================================");
      socket.emit("mission:start:error", {
        message: validation.message,
      });
      return;
    }

    try {
      const transport = getTransport();
      if (!transport) {
        console.log("[MISSION] Start rejected: No transport available");
        socket.emit("mission:start:error", {
          message: "No transport available.",
        });
        return;
      }

      const sysId = vehicleState.systemId || 1;
      const compId = vehicleState.componentId || 1;

      /* ArduPilot only resumes/restarts the mission reliably when the active
         waypoint is pointed at the first executable item (seq=1: the first
         real waypoint for ground vehicles, NAV_TAKEOFF for air vehicles)
         before MAV_CMD_MISSION_START. Without this the state machine can
         stay stuck on a stale "completed" seq and the vehicle won't execute. */
      const firstSeq = firstMissionItemSeq();
      console.log(`[MISSION] Setting active waypoint to seq=${firstSeq} (first executable command)...`);
      const setCurResult = await setMissionCurrent(firstSeq);
      if (!setCurResult.success) {
        console.log(`[MISSION] Warning: could not set mission current (non-fatal): ${setCurResult.message}`);
      }

      console.log("[MISSION] Sending MAV_CMD_MISSION_START...");
      const result = await startMission(transport, sysId, compId);

      if (result.success) {
        console.log("[MISSION] Mission STARTED successfully");
        setMissionRunning(true);
        broadcastVehicleStatus();
        socket.emit("mission:start:success", {
          message: result.message,
        });
      } else {
        console.log(`[MISSION] Start FAILED: ${result.message}`);
        socket.emit("mission:start:error", {
          message: result.message,
          ackCode: result.ackCode,
          ackLabel: result.ackLabel,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Mission start failed.";
      console.log(`[MISSION] Start EXCEPTION: ${msg}`);
      socket.emit("mission:start:error", {
        message: msg,
      });
    }
    console.log("========================================");
  });

  socket.on("mission:start:auto", async () => {
    console.log("=============================================");
    console.log("[MISSION:AUTO] START MISSION clicked");
    console.log(`[MISSION:AUTO] connected=${vehicleState.connected}`);
    console.log(`[MISSION:AUTO] missionUploaded=${vehicleState.missionUploaded}`);
    console.log(`[MISSION:AUTO] mode=${vehicleState.mode}`);
    console.log(`[MISSION:AUTO] armed=${vehicleState.armed}`);
    console.log(`[MISSION:AUTO] gpsFix=${vehicleState.gpsFix}`);
    console.log(`[MISSION:AUTO] satellites=${vehicleState.satellites}`);
    console.log("=============================================");

    const emit = (event: string, data: any) => {
      if (socket.connected) socket.emit(event, data);
    };

    if (!vehicleState.connected) {
      console.log("[MISSION:AUTO] FAILED: Vehicle not connected");
      emit("mission:auto:error", { message: "Vehicle not connected.", step: "connected" });
      return;
    }
    console.log("[MISSION:AUTO] PASS: Vehicle connected");

    if (!vehicleState.missionUploaded) {
      console.log("[MISSION:AUTO] FAILED: No mission uploaded");
      emit("mission:auto:error", { message: "Please upload a mission first.", step: "uploaded" });
      return;
    }
    console.log("[MISSION:AUTO] PASS: Mission uploaded");

    /* Verify ArduPilot actually has a mission */
    const apCount = await getMissionCountFromArduPilot();
    console.log(`[MISSION:AUTO] ArduPilot mission count: ${apCount}`);
    if (apCount <= 0) {
      const msg = "No uploaded mission found on ArduPilot (mission count = 0). Upload a mission first.";
      console.log(`[MISSION:AUTO] FAILED: ${msg}`);
      emit("mission:auto:error", { message: msg, step: "uploaded" });
      return;
    }
    console.log(`[MISSION:AUTO] PASS: ArduPilot has ${apCount} mission items`);

    /* Missions must start from HOME. If the vehicle is physically away from
       HOME, run RTL first and wait until it arrives (live telemetry). */
    if (!telemetry.atHome) {
      emit("mission:auto:progress", { step: "rtl", message: "Vehicle is away from home — returning to launch (RTL)..." });
      console.log(`[MISSION:AUTO] Vehicle away from home (${telemetry.distanceToHome.toFixed(1)}m) — running RTL first`);
      const rtlResult = await runRtlOnSocket(socket, "auto");
      if (!rtlResult.success) {
        console.log(`[MISSION:AUTO] FAILED at RTL: ${rtlResult.message}`);
        emit("mission:auto:error", { message: rtlResult.message, step: "rtl" });
        return;
      }
      console.log("[MISSION:AUTO] PASS: Vehicle is at home");
    } else {
      console.log("[MISSION:AUTO] PASS: Vehicle already at home");
    }

    /* Never attempt to arm while the vehicle is in a mode that rejects arming
       (ArduCopter: RTL, LAND, THROW, ...). Normalize to the standard arming
       mode first (STABILIZE for air vehicles, HOLD for ground), matching
       Mission Planner / QGroundControl behaviour. The actual mode is reported
       back so a failed mode change surfaces the real ArduPilot reason. */
    if (!isModeArmable(vehicleState.mode)) {
      const safeMode = getSafeArmMode();
      emit("mission:auto:progress", {
        step: "mode",
        message: `Switching from ${vehicleState.mode} to ${safeMode} before arming...`,
      });
      console.log(`[MISSION:AUTO] Current mode ${vehicleState.mode} is not armable — switching to ${safeMode}`);
      const modeFix = await setMode(safeMode);
      if (!modeFix.success) {
        const reason = modeFix.statusText || modeFix.message || `Failed to switch to ${safeMode}.`;
        console.log(`[MISSION:AUTO] FAILED to switch to ${safeMode}: ${reason}`);
        emit("mission:auto:error", { message: reason, step: "mode" });
        return;
      }
      console.log(`[MISSION:AUTO] PASS: Switched to ${safeMode} (armable)`);
    }

    emit("mission:auto:progress", { step: "arm", message: "Arming vehicle..." });
    console.log("[MISSION:AUTO] Attempting to ARM...");
    try {
      const armResult = await armVehicle();
      console.log(`[MISSION:AUTO] Arm result: success=${armResult.success} message="${armResult.message}" ackLabel=${armResult.ackLabel}`);
      if (!armResult.success) {
        const reason = armResult.statusText || armResult.message || "Arm command rejected.";
        console.log(`[MISSION:AUTO] FAILED at ARM: ${reason}`);
        emit("mission:auto:error", { message: reason, step: "arm" });
        return;
      }
    } catch (err: any) {
      const msg = err?.message || "Arm failed.";
      console.log(`[MISSION:AUTO] FAILED at ARM (exception): ${msg}`);
      emit("mission:auto:error", { message: msg, step: "arm" });
      return;
    }
    console.log("[MISSION:AUTO] PASS: Vehicle armed");

    /* Point ArduPilot's active waypoint at the first executable item BEFORE
       switching to AUTO. For air vehicles this is the NAV_TAKEOFF (seq=1);
       ArduCopter rejects AUTO mode while armed on the ground unless the next
       nav command is a takeoff (mode_auto.cpp). For ground vehicles it is
       the first real waypoint. */
    const firstSeq = firstMissionItemSeq();
    console.log(`[MISSION:AUTO] Setting active waypoint to seq=${firstSeq} (first executable command)...`);
    try {
      const setCurResult = await setMissionCurrent(firstSeq);
      if (!setCurResult.success) {
        console.log(`[MISSION:AUTO] Warning: could not set mission current (non-fatal): ${setCurResult.message}`);
      }
    } catch (err: any) {
      console.log(`[MISSION:AUTO] Warning: exception setting mission current (non-fatal): ${err?.message}`);
    }

    emit("mission:auto:progress", { step: "mode", message: "Switching to AUTO mode..." });
    console.log("[MISSION:AUTO] Attempting mode change to AUTO...");
    try {
      const modeResult = await setMode("AUTO");
      console.log(`[MISSION:AUTO] Mode change result: success=${modeResult.success} message="${modeResult.message}" ackLabel=${modeResult.ackLabel}`);
      if (!modeResult.success) {
        const reason = modeResult.message || "Failed to set AUTO mode.";
        console.log(`[MISSION:AUTO] FAILED at AUTO: ${reason}`);
        emit("mission:auto:error", { message: reason, step: "mode" });
        return;
      }
    } catch (err: any) {
      const msg = err?.message || "Mode change failed.";
      console.log(`[MISSION:AUTO] FAILED at AUTO (exception): ${msg}`);
      emit("mission:auto:error", { message: msg, step: "mode" });
      return;
    }
    console.log("[MISSION:AUTO] PASS: AUTO mode confirmed (COMMAND_ACK=ACCEPTED)");

    /* ------------------------------------------------------------------ */
    /* Mission is now armed + in AUTO mode. For ArduPilot this is        */
    /* sufficient to begin mission execution. MAV_CMD_MISSION_START is    */
    /* sent as a courtesy; if it fails (e.g. UNSUPPORTED) the mission     */
    /* is still running and we treat it as success.                       */
    /* ------------------------------------------------------------------ */
    emit("mission:auto:progress", { step: "start", message: "Starting mission..." });
    console.log("[MISSION:AUTO] Sending MAV_CMD_MISSION_START...");
    try {
      const transport = getTransport();
      if (!transport) {
        console.log("[MISSION:AUTO] FAILED: No transport");
        emit("mission:auto:error", { message: "No transport available.", step: "start" });
        return;
      }
      const sysId = vehicleState.systemId || 1;
      const compId = vehicleState.componentId || 1;

      const result = await startMission(transport, sysId, compId);
      console.log(`[MISSION:AUTO] Mission start result: success=${result.success} message="${result.message}" ackLabel=${result.ackLabel}`);
      if (result.success) {
        console.log("[MISSION:AUTO] SUCCESS: Mission started");
      } else {
        console.log(`[MISSION:AUTO] MAV_CMD_MISSION_START returned ${result.ackLabel} — vehicle is already in AUTO mode, mission is running`);
      }
      /* Non-fatal: vehicle is armed + AUTO, mission runs regardless */
      setMissionRunning(true);
      broadcastVehicleStatus();
      emit("mission:auto:success", { message: "Mission Started Successfully." });
    } catch (err: any) {
      const msg = err instanceof Error ? err.message : "Mission start failed.";
      console.log(`[MISSION:AUTO] FAILED (exception): ${msg}`);
      emit("mission:auto:error", { message: msg, step: "start" });
    }

    console.log("=============================================");
  });

  socket.on("mission:rtl", async () => {
    console.log("=============================================");
    console.log("[MISSION:RTL] Return-to-Launch requested");
    const validation = validateRtl();
    if (!validation.success) {
      console.log(`[MISSION:RTL] Rejected: ${validation.message}`);
      socket.emit("mission:rtl:error", { message: validation.message });
      console.log("=============================================");
      return;
    }
    const result = await runRtlOnSocket(socket, "manual");
    console.log(`[MISSION:RTL] Result: success=${result.success} message="${result.message}"`);
    console.log("=============================================");
  });

  socket.on("mission:set-current", async (seq: number) => {
    console.log(`[MISSION] Setting current waypoint to seq=${seq}`);
    try {
      const transport = getTransport();
      if (!transport) { socket.emit("mission:error", { message: "No transport." }); return; }
      const sysId = vehicleState.systemId || 1;
      const compId = vehicleState.componentId || 1;
      const cmd = new common.CommandLong();
      cmd.targetSystem = sysId;
      cmd.targetComponent = compId;
      (cmd as any).command = 52;
      cmd.confirmation = 0;
      cmd._param1 = seq;
      cmd._param2 = 0; cmd._param3 = 0; cmd._param4 = 0;
      cmd._param5 = 0; cmd._param6 = 0; cmd._param7 = 0;
      await send(transport, cmd, new MavLinkProtocolV2());
      console.log(`[MISSION] DO_SET_MISSION_CURRENT seq=${seq} sent`);
      socket.emit("mission:status", { message: `Jumped to waypoint ${seq}` });
    } catch (err: any) {
      socket.emit("mission:error", { message: err.message });
    }
  });
}

async function runRtlOnSocket(
  socket: Socket,
  source: "auto" | "manual"
): Promise<{ success: boolean; message: string }> {
  socket.emit("mission:rtl:progress", {
    step: "switching",
    message: "Switching to RTL mode...",
    distanceM: telemetry.distanceToHome,
    auto: source === "auto",
  });

  const result = await returnToLaunch((message, distanceM) => {
    socket.emit("mission:rtl:progress", {
      step: "returning",
      message,
      distanceM,
      auto: source === "auto",
    });
  });

  if (result.success) {
    socket.emit("mission:rtl:success", {
      message: result.message,
      distanceM: telemetry.distanceToHome,
      auto: source === "auto",
    });
  } else {
    socket.emit("mission:rtl:error", {
      message: result.message,
      statusText: result.statusText,
      auto: source === "auto",
    });
  }

  return { success: result.success, message: result.message };
}
