import { Router } from "express";
import type { Request, Response } from "express";
import fs from "fs";
import path from "path";
import os from "os";
import { rtspProxy, RECORDINGS_DIR } from "../services/rtspProxy.service";

function commonFolders() {
  const home = os.homedir();
  return {
    home,
    desktop: path.join(home, "Desktop"),
    downloads: path.join(home, "Downloads"),
    documents: path.join(home, "Documents"),
  };
}

const router = Router();

router.post("/video/start", async (req: Request, res: Response) => {
  const { id, url } = req.body;
  if (!id || !url) {
    res.status(400).json({ success: false, message: "id and url required" });
    return;
  }
  // Only report success once the RTSP source is actually producing frames.
  const ok = await rtspProxy.start(id, url);
  rtspProxy.publishToMediaMTX(id, url);
  const whepUrl = rtspProxy.getWebrtcWhepUrl(id);
  res.json({
    success: ok,
    message: ok ? `Stream "${id}" connected` : `Stream "${id}" failed to connect`,
    id,
    url,
    whepUrl,
  });
});

router.post("/video/stop", (req: Request, res: Response) => {
  const { id } = req.body;
  rtspProxy.stop(id);
  res.json({ success: true, message: `Stream "${id}" stopped` });
});

router.get("/video/stream/:id", (req: Request, res: Response) => {
  const id = req.params.id as string;
  const ok = rtspProxy.addClient(id, res);
  if (!ok) {
    res.status(404).json({ success: false, message: `Stream "${id}" not found or not running` });
  }
});

router.post("/video/record/start", (req: Request, res: Response) => {
  const { id, url } = req.body;
  if (!id || !url) {
    res.status(400).json({ success: false, message: "id and url required" });
    return;
  }
  const ok = rtspProxy.startRecording(id, url);
  res.json({ success: ok, message: ok ? `Recording "${id}" started` : `Already recording "${id}"` });
});

router.post("/video/record/stop", async (req: Request, res: Response) => {
  const { id } = req.body;
  const filePath = await rtspProxy.stopRecording(id);
  res.json({ success: !!filePath, filePath, message: filePath ? `Recording "${id}" stopped` : `No active recording for "${id}"` });
});

router.get("/video/record/file/:filename", (req: Request, res: Response) => {
  const filename = String(req.params.filename);
  // Reject anything that could be used for path traversal.
  if (!filename || filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
    res.status(400).json({ success: false, message: "Invalid filename" });
    return;
  }
  const filePath = path.join(RECORDINGS_DIR, filename);
  if (!filePath.startsWith(RECORDINGS_DIR) || !fs.existsSync(filePath)) {
    res.status(404).json({ success: false, message: "Recording not found" });
    return;
  }
  // Reject empty/truncated recordings so the client never sees a silent black
  // screen — it gets a clear error instead.
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile() || st.size < 1024) {
      res.status(404).json({ success: false, message: "Recording is empty or corrupt" });
      return;
    }
  } catch {
    res.status(404).json({ success: false, message: "Recording not found" });
    return;
  }
  res.setHeader("Content-Type", "video/webm");
  // Inline (not attachment) so the browser can play the recording directly in a
  // <video> element instead of forcing a download. sendFile already supports
  // HTTP Range requests, which is required for seeking/playback.
  res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
  res.sendFile(filePath, (err) => {
    if (err && !res.headersSent) {
      res.status(500).json({ success: false, message: "Failed to read recording" });
    }
  });
});

router.get("/video/record/status", (_req: Request, res: Response) => {
  const recordings = rtspProxy.listRecordings();
  res.json({ success: true, recordings });
});

// Returns absolute paths for common save locations so the in-app "Save As"
// dialog can offer Desktop / Downloads / Home / Documents shortcuts.
router.get("/video/record/folders", (_req: Request, res: Response) => {
  res.json({ success: true, folders: commonFolders() });
});

// Copies a finalized recording from the backend's temporary RECORDINGS_DIR to a
// location the user chose in the Save As dialog. The actual filesystem write is
// performed by this native Node process, so the browser never needs unrestricted
// filesystem access — it only sends the chosen folder + filename.
router.post("/video/record/save", (req: Request, res: Response) => {
  const { source, destDir, destName } = req.body as {
    source?: string;
    destDir?: string;
    destName?: string;
  };

  if (!source || !destDir || !destName) {
    res.status(400).json({ success: false, message: "source, destDir and destName required" });
    return;
  }

  // Source must be a plain filename inside RECORDINGS_DIR (no traversal).
  if (source.includes("/") || source.includes("\\") || source.includes("..")) {
    res.status(400).json({ success: false, message: "Invalid source filename" });
    return;
  }
  const srcPath = path.join(RECORDINGS_DIR, source);
  if (!srcPath.startsWith(RECORDINGS_DIR) || !fs.existsSync(srcPath)) {
    res.status(404).json({ success: false, message: "Recording not found" });
    return;
  }

  // Destination must be an absolute path chosen by the user.
  if (!path.isAbsolute(destDir)) {
    res.status(400).json({ success: false, message: "destDir must be an absolute path" });
    return;
  }
  const cleanDir = path.resolve(destDir);

  // Sanitize the filename: strip any path separators, keep a safe subset.
  const safeBase = path.basename(destName).replace(/[^\w.\- ]/g, "_");
  const finalName = safeBase.toLowerCase().endsWith(".webm") ? safeBase : `${safeBase}.webm`;
  const destPath = path.join(cleanDir, finalName);

  try {
    fs.mkdirSync(cleanDir, { recursive: true });
    fs.copyFileSync(srcPath, destPath);
    // Recording is now safely stored where the user asked; remove the temp copy.
    try {
      fs.unlinkSync(srcPath);
    } catch {
      /* keep temp if deletion fails — not fatal */
    }
    res.json({ success: true, path: destPath, message: `Saved to ${destPath}` });
  } catch (err) {
    res.status(500).json({ success: false, message: `Failed to save: ${(err as Error).message}` });
  }
});

// --- WebRTC ---

router.post("/video/webrtc/start", (req: Request, res: Response) => {
  const { id, url } = req.body;
  if (!id || !url) {
    res.status(400).json({ success: false, message: "id and url required" });
    return;
  }
  const ok = rtspProxy.publishToMediaMTX(id, url);
  const whepUrl = ok ? rtspProxy.getWebrtcWhepUrl(id) : null;
  res.json({ success: ok, whepUrl, message: ok ? `WebRTC "${id}" started` : `WebRTC already active for "${id}"` });
});

router.post("/video/webrtc/stop", (req: Request, res: Response) => {
  const { id } = req.body;
  rtspProxy.unpublishFromMediaMTX(id);
  res.json({ success: true, message: `WebRTC "${id}" stopped` });
});

router.get("/video/webrtc/status", (_req: Request, res: Response) => {
  res.json({ success: true });
});

export default router;
