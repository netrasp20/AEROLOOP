import api from "./api";

export interface CameraConfig {
  liveUrl: string;
  thermalUrl: string;
}

export async function startCameraStream(id: string, url: string): Promise<{ success: boolean; whepUrl?: string }> {
  try {
    const res = await api.post("/video/start", { id, url });
    return { success: res.data.success === true, whepUrl: res.data.whepUrl };
  } catch {
    return { success: false };
  }
}

export async function stopCameraStream(id: string): Promise<void> {
  try {
    await api.post("/video/stop", { id });
  } catch { /* ignore */ }
}

export const STREAM_BASE = "/api/video/stream";

export function getStreamUrl(id: string): string {
  return `${STREAM_BASE}/${id}`;
}

// --- Recording ---

export async function startRecording(id: string, url: string): Promise<boolean> {
  try {
    const res = await api.post("/video/record/start", { id, url });
    return res.data.success === true;
  } catch {
    return false;
  }
}

export async function stopRecording(id: string): Promise<string | null> {
  try {
    const res = await api.post("/video/record/stop", { id });
    return res.data.filePath ?? null;
  } catch {
    return null;
  }
}

export async function downloadRecording(filename: string): Promise<Blob | null> {
  try {
    const res = await api.get(`/video/record/file/${encodeURIComponent(filename)}`, {
      responseType: "blob",
    });
    return res.data as Blob;
  } catch {
    return null;
  }
}

export async function getRecordingStatus(): Promise<{ id: string; duration: number }[]> {
  try {
    const res = await api.get("/video/record/status");
    return res.data.recordings ?? [];
  } catch {
    return [];
  }
}

export interface RecordingFolders {
  home: string;
  desktop: string;
  downloads: string;
  documents: string;
}

export async function getRecordingFolders(): Promise<RecordingFolders | null> {
  try {
    const res = await api.get("/video/record/folders");
    return res.data.folders ?? null;
  } catch {
    return null;
  }
}

/** Ask the native backend to copy a finalized recording to a user-chosen path. */
export async function saveRecordingToLocation(
  source: string,
  destDir: string,
  destName: string,
): Promise<string | null> {
  try {
    const res = await api.post("/video/record/save", { source, destDir, destName });
    return res.data.success ? (res.data.path as string) : null;
  } catch {
    return null;
  }
}
