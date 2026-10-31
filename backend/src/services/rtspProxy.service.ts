import { spawn, ChildProcess } from "child_process";
import type { Response } from "express";
import path from "path";
import fs from "fs";
import { getIO } from "../socket/socket";

const FFPEG_PATH = path.join(__dirname, "..", "..", "ffmpeg");
export const RECORDINGS_DIR = path.join(__dirname, "..", "..", "recordings");

if (!fs.existsSync(RECORDINGS_DIR)) {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
}

// Notify the frontend of real camera-stream connectivity so the recording
// control can appear/disappear with the actual hardware connection.
function emitStreamStatus(id: string, connected: boolean) {
  const io = getIO();
  if (io) io.emit("camera-stream-status", { id, connected });
}

interface StreamSession {
  url: string;
  process: ChildProcess | null;
  clients: Set<Response>;
  /** True only after the first real MJPEG frame has been received from ffmpeg. */
  connected: boolean;
  /** Timestamp (ms) of the last MJPEG frame actually parsed from ffmpeg. */
  lastFrameTs: number;
}

interface RecordSession {
  process: ChildProcess;
  startTime: number;
  filePath: string;
}

interface WebrtcPublishSession {
  process: ChildProcess;
}

const MEDIAMTX_RTSP = "rtsp://localhost:8554";

class RtspProxyService {
  private streams: Map<string, StreamSession> = new Map();
  private recordings: Map<string, RecordSession> = new Map();
  private webrtcPublishers: Map<string, WebrtcPublishSession> = new Map();

  constructor() {
    // Self-heal streams whose ffmpeg has stalled (stops producing frames) so a
    // long-lived/idle session can never leave new viewers stuck on a dead pipe
    // while the process itself still appears "alive".
    setInterval(() => this.watchdog(), 10000);
  }

  private watchdog() {
    const now = Date.now();
    for (const [id, session] of this.streams) {
      if (session.connected && session.lastFrameTs && now - session.lastFrameTs > 20000) {
        console.log(`[RTSP] Stream "${id}" stalled (no frames >20s) — restarting ffmpeg`);
        const url = session.url;
        this.stop(id);
        this.start(id, url);
      }
    }
  }

  // Returns true ONLY when the RTSP source actually starts producing frames.
  // This is what lets the UI show the recording control strictly on a real
  // hardware connection instead of a fake "ffmpeg spawned" success.
  start(id: string, url: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const existing = this.streams.get(id);
      if (existing && existing.url === url && existing.process) {
        if (existing.connected) {
          emitStreamStatus(id, true);
          resolve(true);
          return;
        }
        // Already spawning but not yet confirmed — restart to get a real verdict.
      }
      this.stop(id);

      console.log(`[RTSP] Starting stream "${id}" -> ${url}`);

      const proc = spawn(FFPEG_PATH, [
        "-rtsp_transport", "tcp",
        "-i", url,
        "-f", "image2pipe",
        "-vcodec", "mjpeg",
        "-q:v", "2",
        "-",
      ], { stdio: ["ignore", "pipe", "pipe"] });

      const session: StreamSession = { url, process: proc, clients: new Set(), connected: false, lastFrameTs: 0 };
      this.streams.set(id, session);

      let buffer = Buffer.alloc(0);
      let settled = false;

      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        session.connected = ok;
        clearTimeout(timer);
        if (ok) emitStreamStatus(id, true);
        resolve(ok);
      };

      // If no frame arrives within this window the RTSP source is unreachable,
      // so report failure (the UI must not show a connected/recording control).
      const timer = setTimeout(() => {
        if (!settled) {
          console.log(`[RTSP ${id}] No frames within timeout — source likely unreachable`);
          try { proc.kill("SIGTERM"); } catch { /* ignore */ }
          finish(false);
        }
      }, 5000);

      proc.stdout!.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);

        const SOI = Buffer.from([0xFF, 0xD8]);
        const EOI = Buffer.from([0xFF, 0xD9]);

        let startIdx = buffer.indexOf(SOI);
        let endIdx = buffer.indexOf(EOI);

        while (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          const frame = buffer.slice(startIdx, endIdx + 2);
          buffer = buffer.slice(endIdx + 2);

          const header =
            "\r\n--frame\r\nContent-Type: image/jpeg\r\nContent-Length: " +
            frame.length +
            "\r\n\r\n";

          for (const client of session.clients) {
            try {
              client.write(Buffer.concat([Buffer.from(header), frame]));
            } catch {
              session.clients.delete(client);
            }
          }

          if (!settled) finish(true);
          session.lastFrameTs = Date.now();
          startIdx = buffer.indexOf(SOI);
          endIdx = buffer.indexOf(EOI);
        }
      });

      proc.stderr!.on("data", (data: Buffer) => {
        const text = data.toString().trim();
        if (
          text &&
          !text.startsWith("frame=") &&
          !text.startsWith("fps=") &&
          !text.startsWith("size=") &&
          !text.startsWith("bitrate=")
        ) {
          console.log(`[RTSP ${id}] ${text}`);
        }
      });

      proc.on("exit", (code) => {
        clearTimeout(timer);
        const wasConnected = session.connected;
        console.log(`[RTSP ${id}] FFmpeg exited (code=${code})`);
        this.streams.delete(id);
        for (const client of session.clients) {
          try { client.end(); } catch { /* ignore */ }
        }
        if (!settled) finish(false);
        // Tell the UI the stream dropped so the recording control disappears.
        if (wasConnected) emitStreamStatus(id, false);
      });

      proc.on("error", (err) => {
        console.error(`[RTSP ${id}] FFmpeg error: ${err.message}`);
        if (!settled) finish(false);
      });
    });
  }

  stop(id: string): void {
    this.stopRecording(id);
    this.unpublishFromMediaMTX(id);
    const session = this.streams.get(id);
    if (session) {
      if (session.process) {
        session.process.kill("SIGTERM");
      }
      for (const client of session.clients) {
        try { client.end(); } catch { /* ignore */ }
      }
      this.streams.delete(id);
      console.log(`[RTSP] Stopped stream "${id}"`);
    }
  }

  addClient(id: string, res: Response): boolean {
    const session = this.streams.get(id);
    if (!session || !session.process) {
      console.log(`[RTSP] addClient("${id}") — stream not running`);
      return false;
    }

    res.writeHead(200, {
      "Content-Type": "multipart/x-mixed-replace; boundary=frame",
      "Cache-Control": "no-cache",
      Connection: "close",
      "Access-Control-Allow-Origin": "*",
    });

    session.clients.add(res);
    res.on("close", () => {
      session.clients.delete(res);
    });

    console.log(`[RTSP] Client connected to "${id}" (${session.clients.size} total)`);
    return true;
  }

  // --- Recording ---

  startRecording(id: string, url: string): boolean {
    if (this.recordings.has(id)) {
      console.log(`[RTSP] Already recording "${id}"`);
      return false;
    }

    const timestamp = Date.now();
    const dateStr = new Date(timestamp).toISOString().replace(/[:.]/g, "-");
    const filename = `${id}_${dateStr}.webm`;
    const filePath = path.join(RECORDINGS_DIR, filename);

    console.log(`[RTSP] Starting recording "${id}" -> ${filePath}`);

    // Record from the ALREADY-RUNNING live stream this backend serves
    // (http://localhost:<port>/api/video/stream/<id>), NOT a second direct RTSP
    // connection to the camera. Many cameras return a black/"no-signal" feed on
    // a second session, which produced valid-duration but all-black recordings.
    // Reading the live MJPEG stream guarantees the recording contains exactly
    // the frames the user is currently seeing, and uses only the single camera
    // connection the live view already holds.
    const streamInput = `http://127.0.0.1:${process.env.PORT || 5000}/api/video/stream/${id}`;
    console.log(`[REC ${id}] source = live stream ${streamInput} (camera url was ${url})`);

    const proc = spawn(FFPEG_PATH, [
      "-f", "mjpeg",
      "-i", streamInput,
      // Record to WebM + VP8 (libvpx). H.264 is NOT decodable by a default
      // Ubuntu "Videos" install (the H.264 decoder plugin is proprietary and
      // missing), which produced the "requires a H.264 decoder plugin" error.
      // VP8 in a WebM container is decoded out-of-the-box by GStreamer's
      // "good" plugins (used by Totem/Videos) AND by all modern browsers, so
      // the saved file plays without the user installing any codec.
      "-c:v", "libvpx",
      "-b:v", "2M",
      "-cpu-used", "8",
      "-deadline", "realtime",
      "-pix_fmt", "yuv420p",
      "-an",
      "-y",
      filePath,
    ], { stdio: ["ignore", "pipe", "pipe"] });

    proc.stderr!.on("data", (data: Buffer) => {
      const text = data.toString().trim();
      if (text && !text.startsWith("frame=") && !text.startsWith("fps=")) {
        console.log(`[REC ${id}] ${text}`);
      }
    });

    proc.on("exit", (code) => {
      console.log(`[REC ${id}] Recording FFmpeg exited (code=${code})`);
      this.recordings.delete(id);
    });

    proc.on("error", (err) => {
      console.error(`[REC ${id}] FFmpeg error: ${err.message}`);
    });

    this.recordings.set(id, { process: proc, startTime: timestamp, filePath });
    return true;
  }

  stopRecording(id: string): Promise<string | null> {
    return new Promise((resolve) => {
      const rec = this.recordings.get(id);
      if (!rec) {
        resolve(null);
        return;
      }
      const { process: proc, filePath } = rec;
      this.recordings.delete(id);
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        // Only report success if a real, non-trivial file was produced.
        // Otherwise the caller (and ultimately the user) must see a failure
        // rather than a silently-corrupt/empty recording that plays black.
        try {
          const st = fs.statSync(filePath);
          if (st.isFile() && st.size >= 1024) {
            resolve(filePath);
          } else {
            resolve(null);
          }
        } catch {
          resolve(null);
        }
      };
      proc.once("exit", finish);
      proc.once("error", finish);
      try {
        proc.kill("SIGTERM");
      } catch {
        finish();
      }
      // Safety net: don't hang the request if ffmpeg is slow to exit.
      setTimeout(finish, 3000);
    });
  }

  isRecording(id: string): boolean {
    return this.recordings.has(id);
  }

  getRecordingDuration(id: string): number {
    const rec = this.recordings.get(id);
    if (!rec) return 0;
    return Math.floor((Date.now() - rec.startTime) / 1000);
  }

  listRecordings(): { id: string; filePath: string; startTime: number; duration: number }[] {
    const list: { id: string; filePath: string; startTime: number; duration: number }[] = [];
    for (const [id, rec] of this.recordings) {
      list.push({ id, filePath: rec.filePath, startTime: rec.startTime, duration: Math.floor((Date.now() - rec.startTime) / 1000) });
    }
    return list;
  }

  // --- WebRTC / MediaMTX ---

  publishToMediaMTX(id: string, sourceUrl: string): boolean {
    if (this.webrtcPublishers.has(id)) {
      return true;
    }
    const targetUrl = `${MEDIAMTX_RTSP}/${id}`;
    console.log(`[WEBRTC] Publishing "${id}" -> ${targetUrl}`);

    const proc = spawn(FFPEG_PATH, [
      "-rtsp_transport", "tcp",
      "-i", sourceUrl,
      "-vcodec", "libx264",
      "-preset", "ultrafast",
      "-tune", "zerolatency",
      "-f", "rtsp",
      targetUrl,
    ], { stdio: ["ignore", "pipe", "pipe"] });

    proc.stderr!.on("data", (data: Buffer) => {
      const text = data.toString().trim();
      if (text && !text.startsWith("frame=") && !text.startsWith("fps=")) {
        console.log(`[WEBRTC ${id}] ${text}`);
      }
    });

    proc.on("exit", (code) => {
      console.log(`[WEBRTC ${id}] FFmpeg exited (code=${code})`);
      this.webrtcPublishers.delete(id);
    });

    proc.on("error", (err) => {
      console.error(`[WEBRTC ${id}] FFmpeg error: ${err.message}`);
    });

    this.webrtcPublishers.set(id, { process: proc });
    return true;
  }

  unpublishFromMediaMTX(id: string): void {
    const pub = this.webrtcPublishers.get(id);
    if (pub) {
      pub.process.kill("SIGTERM");
      this.webrtcPublishers.delete(id);
      console.log(`[WEBRTC] Unpublished "${id}"`);
    }
  }

  isWebrtcActive(id: string): boolean {
    return this.webrtcPublishers.has(id);
  }

  getWebrtcWhepUrl(id: string): string {
    return `http://localhost:8889/${id}/whep`;
  }

  stopAll(): void {
    for (const [id] of this.streams) {
      this.stop(id);
    }
    for (const [id] of this.recordings) {
      this.stopRecording(id);
    }
    for (const [id] of this.webrtcPublishers) {
      this.unpublishFromMediaMTX(id);
    }
  }
}

export const rtspProxy = new RtspProxyService();
