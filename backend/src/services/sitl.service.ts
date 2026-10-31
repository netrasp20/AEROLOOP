import { spawn, ChildProcess } from "child_process";
import path from "path";
import os from "os";

export interface SitlParams {
  vehicle: string;
  frame: string;
  latitude: number;
  longitude: number;
  altitude: number;
  heading: number;
  udpPort?: number;
}

const ARDUPILOT_DIR = path.join(os.homedir(), "ardupilot");

const READY_INDICATORS = [
  "GPS",
  "Ready to FLY",
  "MAVLink",
  "EKF",
];

const STARTUP_TIMEOUT_MS = 30000;

let sitlProcess: ChildProcess | null = null;

function buildSimVehicleArgs(params: SitlParams): string[] {
  const port = params.udpPort ?? 14550;
  return [
    "Tools/autotest/sim_vehicle.py",
    "-v", params.vehicle,
    "-f", params.frame,
    "-l", `${params.latitude},${params.longitude},${params.altitude},${params.heading}`,
    "--no-rebuild",
    "--out", `udp:127.0.0.1:${port}`,
  ];
}

export async function startSitl(params: SitlParams): Promise<{ success: boolean; message: string; pid?: number }> {
  if (sitlProcess) {
    return { success: true, message: `SITL is already running (PID ${sitlProcess.pid})`, pid: sitlProcess.pid };
  }

  const args = buildSimVehicleArgs(params);

  console.log("[SITL] Starting sim_vehicle.py...");
  console.log(`  CWD:  ${ARDUPILOT_DIR}`);
  console.log(`  Args: python3 ${args.join(" ")}`);

  return new Promise((resolve) => {
    const child = spawn("python3", args, {
      cwd: ARDUPILOT_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    sitlProcess = child;

    let ready = false;
    let output = "";

    child.stdout?.on("data", (data: Buffer) => {
      const text = data.toString();
      output += text;
      process.stdout.write(`[SITL:out] ${text}`);

      if (!ready && READY_INDICATORS.some((ind) => text.includes(ind))) {
        ready = true;
        console.log(`[SITL] Ready indicator detected — SITL initialized successfully`);
        resolve({ success: true, message: `SITL ready (PID ${child.pid})`, pid: child.pid });
      }
    });

    child.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      output += text;
      process.stderr.write(`[SITL:err] ${text}`);
    });

    child.on("error", (err) => {
      console.error(`[SITL] Failed to spawn: ${err.message}`);
      sitlProcess = null;
      resolve({ success: false, message: `Failed to start SITL: ${err.message}` });
    });

    child.on("exit", (code, signal) => {
      console.log(`[SITL] Process exited (code=${code}, signal=${signal})`);
      sitlProcess = null;

      if (!ready) {
        const tail = output.slice(-1000).trim();
        const reason = tail
          ? `SITL exited early (code=${code}, signal=${signal}). Last output: ${tail}`
          : `SITL exited early (code=${code}, signal=${signal})`;
        resolve({ success: false, message: reason });
      }
    });

    setTimeout(() => {
      if (!ready) {
        if (sitlProcess) {
          console.log("[SITL] Timeout — process alive but no ready indicator seen");
          resolve({ success: true, message: `SITL started (PID ${child.pid})`, pid: child.pid });
        } else {
          console.log("[SITL] Timeout — process is no longer running");
          resolve({ success: false, message: "SITL failed to start within timeout" });
        }
      }
    }, STARTUP_TIMEOUT_MS);
  });
}

export function stopSitl(): { success: boolean; message: string } {
  if (sitlProcess) {
    console.log("[SITL] Stopping SITL process...");
    sitlProcess.kill("SIGTERM");
    sitlProcess = null;
  }

  return { success: true, message: "SITL stopped" };
}

export function getSitlStatus(): { running: boolean } {
  return { running: sitlProcess !== null };
}
