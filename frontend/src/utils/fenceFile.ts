import type { FencePoint } from "../api/fence";

export interface FenceFile {
  version: 1;
  timestamp: string;
  points: FencePoint[];
}

export function downloadFenceFile(points: FencePoint[], filename = "fence.json"): void {
  const data: FenceFile = {
    version: 1,
    timestamp: new Date().toISOString(),
    points,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function parseFenceFile(text: string): FencePoint[] {
  const data = JSON.parse(text) as FenceFile;
  if (!Array.isArray(data.points)) {
    throw new Error("Invalid fence file: missing points array.");
  }
  return data.points.map((pt) => ({
    lat: Number(pt.lat),
    lng: Number(pt.lng),
    command: Number(pt.command ?? 5001),
    param1: Number(pt.param1 ?? 0),
    param2: Number(pt.param2 ?? 0),
  }));
}

export function loadFenceFile(file: File): Promise<FencePoint[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        resolve(parseFenceFile(String(reader.result)));
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(new Error("Failed to read fence file."));
    reader.readAsText(file);
  });
}