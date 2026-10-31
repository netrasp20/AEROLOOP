"""RTSP -> MJPEG proxy + recording using the bundled static FFmpeg binary.

Mirrors the retired Node rtspProxy.service.ts so the frontend camera panels keep
working against the same endpoints (/api/video/start, /api/video/stop,
/api/video/stream/<id>).

Key design decisions (fixes over the original):
  * MULTI-CONSUMER frames: the live ffmpeg process publishes every decoded JPEG
    to a broadcast "hub". ANY number of HTTP clients (<img> previews, the
    expanded camera view, the recorder) independently read the newest frame.
    The old single-slot queue allowed ONE consumer to pop a frame — any second
    connection (e.g. the expanded view) usually got nothing and showed black.
  * RECORDING FROM THE LIVE FRAMES: recording reads the SAME frames the UI is
    showing and re-encodes them to H.264 (.mp4). It never opens a second RTSP
    session (many cameras lock out a second client, producing a black file).
  * STREAM-LOSS DETECTION: a watcher thread notices when ffmpeg dies in the
    middle of a stream and broadcasts "camera-stream-status connected=False"
    over Socket.IO so the frontend drops the REC control / badge immediately.
"""

import asyncio
import collections
import logging
import shutil
import signal
import subprocess
import threading
import time
from pathlib import Path
from urllib.parse import urlparse
from typing import Any, Dict, List, Optional

_BASE_DIR = Path(__file__).resolve().parent.parent
FFMPEG = _BASE_DIR / "ffmpeg"
RECORDINGS_DIR = _BASE_DIR / "recordings"

RECORDINGS_DIR.mkdir(parents=True, exist_ok=True)

_SOI = b"\xff\xd8"
_EOI = b"\xff\xd9"

# How long to wait for ffmpeg to negotiate the RTSP source and produce the
# first MJPEG frame before declaring the stream failed / undecodable.
_CONNECT_WAIT_S = 1.5
_FIRST_FRAME_WAIT_S = 3.5
_TOTAL_BUDGET_S = _CONNECT_WAIT_S + _FIRST_FRAME_WAIT_S

logger = logging.getLogger("video")


def is_valid_stream_url(url: str) -> bool:
    """Accept rtsp:// / rtsps:// (and http(s):// MJPEG endpoints)."""
    if not url or not isinstance(url, str):
        return False
    try:
        parsed = urlparse(url.strip())
        return parsed.scheme.lower() in ("rtsp", "rtsps", "http", "https") and bool(parsed.netloc)
    except Exception:  # noqa: BLE001 - defensive
        return False


class _FrameHub:
    """Latest-frame broadcast hub.

    Every reader (HTTP <img> connections + the recorder) tracks its own
    last-seen generation counter and always receives the newest available
    frame. Publishing never consumes a frame for any single subscriber.
    """

    def __init__(self) -> None:
        self._cond = threading.Condition()
        self.latest: Optional[bytes] = None
        self.gen = 0
        self._ended = False
        self._buffers: set = set()

    def publish(self, frame: bytes) -> None:
        buffer = self._cond
        with self._cond:
            self.latest = frame
            self.gen += 1
            self._cond.notify_all()
            buffers = list(self._buffers)
        for buff in buffers:
            buff.push(frame)

    def end(self) -> None:
        with self._cond:
            self._ended = True
            self._cond.notify_all()
            buffers = list(self._buffers)
        for buff in buffers:
            buff.end()

    def subscribe(self) -> "_FrameBuffer":
        """Create a per-subscriber FIFO for lossless consumption (recording)."""
        with self._cond:
            buff = _FrameBuffer(self)
            self._buffers.add(buff)
            if self._ended:
                buff.end()
            return buff

    def unsubscribe(self, buff: "_FrameBuffer") -> None:
        with self._cond:
            self._buffers.discard(buff)

    @property
    def ended(self) -> bool:
        with self._cond:
            return self._ended

    def wait_frame(self, last_seen: int, timeout: float):
        """Block until a newer frame is available, a timeout elapses, or the
        hub ends. Returns (frame, generation, ended). When `ended` is True the
        consumer should stop; when a timeout happens with no new frame the
        frame is None and generation unchanged."""
        deadline = time.monotonic() + timeout
        with self._cond:
            while self.gen == last_seen:
                if self._ended:
                    return None, last_seen, True
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return None, last_seen, False
                self._cond.wait(max(remaining, 0.001))
            return self.latest, self.gen, False


class _FrameBuffer:
    """Bounded FIFO so a slow recorder never loses frames during a burst.
    Older frames are dropped only if the recorder is catastrophically behind."""

    def __init__(self, hub: _FrameHub) -> None:
        self._hub = hub
        self._cond = threading.Condition()
        self._frames: collections.deque = collections.deque(maxlen=1500)
        self._ended = False

    def push(self, frame: bytes) -> None:
        with self._cond:
            self._frames.append(frame)
            self._cond.notify()

    def end(self) -> None:
        with self._cond:
            self._ended = True
            self._cond.notify_all()

    def get(self, timeout: float):
        """Pop the oldest frame, or block `timeout` for the next one.
        Returns None on end or timeout."""
        deadline = time.monotonic() + timeout
        with self._cond:
            while not self._frames:
                if self._ended:
                    return None, True
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return None, False
                self._cond.wait(max(remaining, 0.001))
            return self._frames.popleft(), False


class _StreamSession:
    """One live camera: an ffmpeg process plus a broadcast frame hub."""

    def __init__(self, stream_id: str, url: str) -> None:
        self.id = stream_id
        self.url = url
        self.proc: Optional[subprocess.Popen] = None
        self.hub = _FrameHub()
        # `alive` mirrors whether ffmpeg is currently producing frames.
        self.first_frame = threading.Event()
        self.stop_event = threading.Event()
        self.error: Optional[str] = None
        self.stderr_tail: List[str] = []

    def close(self) -> None:
        self.stop_event.set()
        proc = self.proc
        if proc is not None and proc.poll() is None:
            try:
                proc.terminate()
                try:
                    proc.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    proc.kill()
            except Exception:  # noqa: BLE001 - process may already be gone
                pass
        self.hub.end()


class _Recorder:
    """Encodes frames to H.264 (.mp4) either from a live stream's frame hub or
    (fallback when no live session exists) from a direct RTSP session."""

    def __init__(self, stream_id: str, url: str, file_path: Path, hub: Optional[_FrameHub]) -> None:
        self.id = stream_id
        self.url = url
        self.file_path = file_path
        self.hub = hub
        self.buffer: Optional[_FrameBuffer] = None
        if hub is not None:
            self.buffer = hub.subscribe()
        self.proc: Optional[subprocess.Popen] = None
        self.stop_event = threading.Event()

    def start(self) -> bool:
        """Spawn ffmpeg. Returns True if the process was launched."""
        args = self._record_args()
        try:
            self.proc = subprocess.Popen(
                args,
                stdin=subprocess.PIPE if self.hub is not None else subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
            )
        except Exception:  # noqa: BLE001
            logger.error("[REC %s] failed to start ffmpeg", self.id)
            return False
        threading.Thread(target=self._read_stderr, args=(self.proc,), daemon=True).start()
        return True

    def _record_args(self) -> List[str]:
        if self.hub is not None:
            # Re-encode the SAME frames the UI shows — no second RTSP connection.
            return [
                str(FFMPEG),
                "-y",
                "-f", "image2pipe",
                "-c:v", "mjpeg",
                "-i", "-",
                "-an",
                "-c:v", "libx264",
                "-preset", "veryfast",
                "-pix_fmt", "yuv420p",
                "-profile:v", "baseline",
                "-level", "3.1",
                "-movflags", "+faststart",
                str(self.file_path),
            ]
        # No live hub available — open the RTSP source directly (e.g. recording
        # requested while the live view is not running).
        return [
            str(FFMPEG),
            "-rtsp_transport", "tcp",
            "-i", self.url,
            "-an",
            "-c:v", "libx264",
            "-preset", "veryfast",
            "-pix_fmt", "yuv420p",
            "-profile:v", "baseline",
            "-level", "3.1",
            "-movflags", "+faststart",
            "-y",
            str(self.file_path),
        ]

    def run(self) -> None:
        """Feed frames from the live hub into ffmpeg until stopped. Only used
        in hub mode (direct RTSP mode has no feeding thread). Uses the
        per-subscriber FIFO so NOTHING is skipped even during frame bursts."""
        if self.hub is None or self.buffer is None or self.proc is None or self.proc.stdin is None:
            return
        try:
            while not self.stop_event.is_set():
                # Drain any pending burst first, then block for the next frame.
                frame, ended = self.buffer.get(0.0)
                if frame is None and not ended:
                    frame, ended = self.buffer.get(3.0)
                if ended:
                    break
                if frame is None:
                    continue
                try:
                    self.proc.stdin.write(frame)
                except (BrokenPipeError, OSError):
                    logger.error("[REC %s] ffmpeg closed stdin — recording aborted", self.id)
                    break
        finally:
            try:
                self.buffer.end()
            except Exception:  # noqa: BLE001
                pass
            try:
                self.proc.stdin.flush()
            except Exception:  # noqa: BLE001
                pass
            try:
                self.proc.stdin.close()
            except Exception:  # noqa: BLE001
                pass
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self._terminate()

    def stop(self) -> None:
        """Finalize the recording (clean mp4 → playable in standard players)."""
        self.stop_event.set()
        if self.buffer is not None:
            self.buffer.end()
        if self.hub is not None and self.proc is not None:
            # Closing stdin gives ffmpeg a clean EOF so it flushes the moov atom.
            try:
                self.proc.stdin.close()
            except Exception:  # noqa: BLE001
                pass
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self._terminate()
            self.hub.unsubscribe(self.buffer)
            return
        self._terminate()

    def _terminate(self) -> None:
        proc = self.proc
        if proc is None or proc.poll() is not None:
            return
        try:
            # SIGINT makes ffmpeg finalize the container on exit.
            proc.send_signal(signal.SIGINT)
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=3)
        except Exception:  # noqa: BLE001 - process may already be gone
            pass

    def _read_stderr(self, proc: subprocess.Popen) -> None:
        if proc.stderr is None:
            return
        for raw in proc.stderr:
            line = raw.decode(errors="replace").strip()
            if line and not line.startswith(("frame=", "fps=", "size=", "bitrate=")):
                logger.info("[REC %s] %s", self.id, line)


class _RecordSession:
    def __init__(self, stream_id: str, recorder: _Recorder) -> None:
        self.id = stream_id
        self.rec = recorder
        self.start_time = time.time()

    @property
    def file_path(self) -> Path:
        return self.rec.file_path


def _emit_camera_status(payload: Dict[str, Any]) -> None:
    """Broadcast a camera connection event to all frontends (thread-safe)."""
    try:
        from sio import server as sio_server

        sio_server.emit("camera-stream-status", payload)
    except Exception:  # noqa: BLE001 - socket loop may be gone at shutdown
        pass


class VideoService:
    def __init__(self) -> None:
        self._streams: Dict[str, _StreamSession] = {}
        self._recordings: Dict[str, _RecordSession] = {}
        self._lock = threading.Lock()

    # ------------------------------------------------------------------
    # MJPEG proxy
    # ------------------------------------------------------------------
    async def start(self, stream_id: str, url: str) -> Dict:
        """Begin proxying `url` as MJPEG for `stream_id`.

        Runs the ffmpeg negotiation off the event loop. Returns
        {"success": True} when the first frame has been read, otherwise a
        friendly error message.
        """
        with self._lock:
            existing = self._streams.pop(stream_id, None)
        if existing:
            existing.close()

        session = _StreamSession(stream_id, url)
        with self._lock:
            self._streams[stream_id] = session

        error = await asyncio.to_thread(self._spawn_and_wait, session)

        if error:
            with self._lock:
                self._streams.pop(stream_id, None)
            session.close()
            _emit_camera_status({"id": stream_id, "connected": False, "error": error})
            return {"success": False, "message": error, "id": stream_id}

        logger.info("[RTSP] Stream %s running (%s)", stream_id, url)
        _emit_camera_status({"id": stream_id, "connected": True})
        return {"success": True, "message": f'Stream "{stream_id}" started', "id": stream_id, "url": url}

    def stop(self, stream_id: str) -> None:
        with self._lock:
            session = self._streams.pop(stream_id, None)
            rec = self._recordings.pop(stream_id, None)
        # Finalize any recording (it feeds from this stream's frames).
        if rec:
            rec.rec.stop()
            logger.info("[REC] Stopped recording %s -> %s", stream_id, rec.file_path)
        if session:
            session.close()
            logger.info("[RTSP] Stopped stream %s", stream_id)
        _emit_camera_status({"id": stream_id, "connected": False})

    def get_session(self, stream_id: str) -> Optional[_StreamSession]:
        with self._lock:
            return self._streams.get(stream_id)

    async def stream(self, stream_id: str):
        """Return an MJPEG StreamingResponse for a running stream, or None."""
        session = self.get_session(stream_id)
        if session is None:
            return None

        async def gen():
            last_seen = 0
            while not session.stop_event.is_set():
                try:
                    frame, new_seen, ended = await asyncio.to_thread(
                        session.hub.wait_frame, last_seen, 5.0
                    )
                except Exception:  # noqa: BLE001
                    break
                if ended:
                    break
                if frame is None:
                    continue
                last_seen = new_seen
                yield (
                    b"--frame\r\n"
                    b"Content-Type: image/jpeg\r\n"
                    b"Content-Length: " + str(len(frame)).encode() + b"\r\n\r\n"
                ) + frame

        from fastapi.responses import StreamingResponse

        return StreamingResponse(
            gen(),
            media_type="multipart/x-mixed-replace; boundary=frame",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "close",
                "Access-Control-Allow-Origin": "*",
                "X-Accel-Buffering": "no",
            },
        )

    # ------------------------------------------------------------------
    # ffmpeg plumbing
    # ------------------------------------------------------------------
    def _spawn_and_wait(self, session: _StreamSession) -> str:
        """Spawn ffmpeg and wait for either the first frame or a failure."""
        try:
            proc = subprocess.Popen(
                [
                    str(FFMPEG),
                    "-rtsp_transport", "tcp",
                    "-i", session.url,
                    "-f", "image2pipe",
                    "-vcodec", "mjpeg",
                    "-q:v", "2",
                    "-",
                ],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
        except FileNotFoundError:
            session.error = "FFmpeg binary not found"
            logger.error("[RTSP %s] %s", session.id, session.error)
            return session.error

        session.proc = proc
        threading.Thread(target=self._read_stderr, args=(session,), daemon=True).start()
        threading.Thread(target=self._read_frames, args=(session,), daemon=True).start()
        threading.Thread(target=self._watch_live, args=(session,), daemon=True).start()

        deadline = time.monotonic() + _TOTAL_BUDGET_S
        while time.monotonic() < deadline:
            if session.first_frame.is_set():
                return ""
            if proc.poll() is not None:
                return self._connect_error(session)
            time.sleep(0.1)

        if session.first_frame.is_set():
            return ""
        if proc.poll() is not None:
            return self._connect_error(session)
        return "RTSP connected, but video stream could not be decoded"

    def _read_frames(self, session: _StreamSession) -> None:
        proc = session.proc
        if proc is None or proc.stdout is None:
            return
        buffer = b""
        while not session.stop_event.is_set():
            try:
                chunk = proc.stdout.read(65536)
            except Exception:  # noqa: BLE001 - ffmpeg closed the pipe
                break
            if not chunk:
                break
            buffer += chunk
            start = buffer.find(_SOI)
            end = buffer.find(_EOI)
            while start != -1 and end != -1 and end > start:
                frame = buffer[start : end + 2]
                buffer = buffer[end + 2 :]
                session.first_frame.set()
                session.hub.publish(frame)
                start = buffer.find(_SOI)
                end = buffer.find(_EOI)
        session.hub.end()

    def _read_stderr(self, session: _StreamSession) -> None:
        proc = session.proc
        if proc is None or proc.stderr is None:
            return
        for raw in proc.stderr:
            line = raw.decode(errors="replace").strip()
            if line:
                logger.info("[RTSP %s] %s", session.id, line)
                session.stderr_tail.append(line)
                if len(session.stderr_tail) > 40:
                    session.stderr_tail.pop(0)

    def _watch_live(self, session: _StreamSession) -> None:
        """Detect unexpected ffmpeg death and tell the frontend immediately."""
        proc = session.proc
        if proc is None:
            return
        try:
            proc.wait()
        except Exception:  # noqa: BLE001
            pass
        if session.stop_event.is_set():
            return  # intentional stop — normal cleanup
        with self._lock:
            if self._streams.get(session.id) is session:
                self._streams.pop(session.id, None)
                sessions = dict(self._recordings)
            else:
                sessions = {}
        logger.error(
            "[RTSP %s] stream process exited unexpectedly — camera offline", session.id
        )
        # Finalize any recording that depended on this stream (never leave a
        # half-written file).
        for rid, rec_session in sessions.items():
            if rid == session.id:
                self._recordings.pop(session.id, None)
                rec_session.rec.stop()
                logger.info("[REC] Finalized recording on stream loss: %s", rec_session.file_path)
        _emit_camera_status(
            {
                "id": session.id,
                "connected": False,
                "error": "Stream lost: ffmpeg process exited",
            }
        )

    def _connect_error(self, session: _StreamSession) -> str:
        session.error = "Unable to connect to RTSP stream"
        details = "\n".join(session.stderr_tail[-8:])
        logger.error("[RTSP %s] connect failed: %s", session.id, details or "(no stderr)")
        return session.error

    # ------------------------------------------------------------------
    # Recording
    # ------------------------------------------------------------------
    async def start_recording(self, stream_id: str, url: str) -> bool:
        with self._lock:
            if stream_id in self._recordings:
                return False
            session = self._streams.get(stream_id)

        file_path = RECORDINGS_DIR / f"{stream_id}_{time.strftime('%Y%m%d_%H%M%S')}.mp4"
        hub = None if session is None else session.hub
        recorder = _Recorder(stream_id, url, file_path, hub)

        ok = await asyncio.to_thread(recorder.start)
        if not ok:
            return False

        with self._lock:
            self._recordings[stream_id] = _RecordSession(stream_id, recorder)

        if hub is not None:
            threading.Thread(target=recorder.run, daemon=True, name=f"rec-feed-{stream_id}").start()
        threading.Thread(target=self._watch_recording, args=(stream_id, recorder), daemon=True).start()

        logger.info(
            "[REC] Recording %s -> %s (%s)", stream_id, file_path,
            "from live frames" if hub is not None else "direct RTSP",
        )
        return True

    def stop_recording(self, stream_id: str) -> Optional[str]:
        with self._lock:
            rec = self._recordings.pop(stream_id, None)
        if not rec:
            return None
        rec.rec.stop()
        logger.info("[REC] Stopped recording %s -> %s", stream_id, rec.file_path)
        return str(rec.file_path)

    def list_recordings(self) -> List[Dict]:
        result: List[Dict] = []
        with self._lock:
            for rec in self._recordings.values():
                result.append(
                    {
                        "id": rec.id,
                        "filePath": str(rec.file_path),
                        "startTime": int(rec.start_time * 1000),
                        "duration": int(time.time() - rec.start_time),
                    }
                )
        return result

    def _watch_recording(self, stream_id: str, recorder: _Recorder) -> None:
        proc = recorder.proc
        if proc is None:
            return
        try:
            proc.wait()
        except Exception:  # noqa: BLE001
            pass
        if recorder.stop_event.is_set() or proc.returncode == 0:
            return
        logger.error("[REC %s] recorder exited with code %s", stream_id, proc.returncode)
        with self._lock:
            self._recordings.pop(stream_id, None)


video_service = VideoService()


def save_recording_file(source: str, dest_dir: str, dest_name: str) -> Optional[str]:
    """Copy a finalized recording to a user-chosen folder. Only recordings
    inside RECORDINGS_DIR may be used as the source (path-traversal guard)."""
    if not source or not dest_dir or not dest_name:
        return None
    src_rel = Path(source).name  # basename only
    src_path = RECORDINGS_DIR / src_rel
    if not src_path.is_file() or src_path.parent != RECORDINGS_DIR:
        return None
    dest = Path(dest_dir).expanduser() / dest_name
    if not dest.parent.is_dir():
        return None
    # Enforce the .mp4 container recorded by this service.
    if dest.suffix.lower() != ".mp4":
        dest = dest.with_suffix(".mp4")
    try:
        shutil.copy2(src_path, dest)
    except OSError as err:  # noqa: BLE001
        logger.error("[REC] save failed: %s", err)
        return None
    logger.info("[REC] Saved %s -> %s", src_path, dest)
    return str(dest)