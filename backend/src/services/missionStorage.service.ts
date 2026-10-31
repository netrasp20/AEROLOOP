import fs from "fs/promises";
import path from "path";

const MISSIONS_DIR = path.resolve(process.cwd(), "missions");

async function ensureDir(): Promise<void> {
  try {
    await fs.mkdir(MISSIONS_DIR, { recursive: true });
  } catch {
    throw new Error("Failed to create missions directory.");
  }
}

function parseMissionFile(filename: string): { id: string; number: number } | null {
  const match = filename.match(/^Mission_(\d{3})\.json$/);
  if (!match) return null;
  return { id: `Mission_${match[1]}`, number: parseInt(match[1], 10) };
}

export interface MissionEntry {
  id: string;
  filename: string;
  timestamp: string;
  waypointCount: number;
  hasHome: boolean;
}

export async function listMissions(): Promise<MissionEntry[]> {
  await ensureDir();

  const files = await fs.readdir(MISSIONS_DIR);
  const jsonFiles = files.filter((f) => f.endsWith(".json"));

  const entries: MissionEntry[] = [];

  for (const file of jsonFiles) {
    try {
      const raw = await fs.readFile(path.join(MISSIONS_DIR, file), "utf-8");
      const data = JSON.parse(raw);
      const id = file.replace(/\.json$/, "");

      entries.push({
        id,
        filename: file,
        timestamp: data.timestamp ?? "",
        waypointCount: Array.isArray(data.waypoints) ? data.waypoints.length : 0,
        hasHome: data.home !== null && data.home !== undefined,
      });
    } catch {
      continue;
    }
  }

  entries.sort(
    (a, b) =>
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );

  return entries;
}

export async function saveMission(data: {
  home: { lat: number; lng: number } | null;
  waypoints: Array<{
    id: number;
    lat: number;
    lng: number;
    altitude: number;
    hoverTime: number;
    command: string;
    frame: string;
    sequence: number;
  }>;
}): Promise<MissionEntry> {
  await ensureDir();

  const files = await fs.readdir(MISSIONS_DIR);
  let maxNumber = 0;

  for (const file of files) {
    const parsed = parseMissionFile(file);
    if (parsed && parsed.number > maxNumber) {
      maxNumber = parsed.number;
    }
  }

  const nextNumber = maxNumber + 1;
  const id = `Mission_${String(nextNumber).padStart(3, "0")}`;
  const filename = `${id}.json`;
  const timestamp = new Date().toISOString();

  const missionFile = {
    version: 1,
    timestamp,
    home: data.home,
    waypoints: data.waypoints,
  };

  await fs.writeFile(
    path.join(MISSIONS_DIR, filename),
    JSON.stringify(missionFile, null, 2),
    "utf-8"
  );

  return {
    id,
    filename,
    timestamp,
    waypointCount: data.waypoints.length,
    hasHome: data.home !== null,
  };
}

export async function loadMission(id: string): Promise<{
  version: number;
  timestamp: string;
  home: { lat: number; lng: number } | null;
  waypoints: Array<{
    id: number;
    lat: number;
    lng: number;
    altitude: number;
    hoverTime: number;
    command: string;
    frame: string;
    sequence: number;
  }>;
} | null> {
  await ensureDir();

  const filename = `${id}.json`;
  const filepath = path.join(MISSIONS_DIR, filename);

  try {
    const raw = await fs.readFile(filepath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function deleteMission(id: string): Promise<boolean> {
  const filepath = path.join(MISSIONS_DIR, `${id}.json`);
  try {
    await fs.unlink(filepath);
    return true;
  } catch {
    return false;
  }
}

export async function renameMission(id: string, newName: string): Promise<boolean> {
  const sanitized = newName.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (!sanitized) return false;

  const oldPath = path.join(MISSIONS_DIR, `${id}.json`);
  const newPath = path.join(MISSIONS_DIR, `${sanitized}.json`);

  try {
    await fs.access(oldPath);
    const exists = await fs.access(newPath).then(() => true).catch(() => false);
    if (exists) return false;
    await fs.rename(oldPath, newPath);
    return true;
  } catch {
    return false;
  }
}

export async function duplicateMission(id: string): Promise<MissionEntry | null> {
  const data = await loadMission(id);
  if (!data) return null;
  return saveMission(data);
}
