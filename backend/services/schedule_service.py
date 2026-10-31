"""Mission scheduling service.

REAL backend scheduler. A background thread checks (every second) whether any
enabled scheduled mission is due and, when one is, uploads the stored mission to
the flight controller through the existing MAVLink mission-upload service.

Timezone strategy
-----------------
Every date/time related to scheduling is stored as a NAVIVE LOCAL ISO string
(e.g. "2026-09-05T10:30:00"). The frontend and backend run on the same host, so
"local" is the operator's timezone in both places and comparisons are consistent.
No UTC conversions happen anywhere in this module.

Status machine
--------------
  scheduled   -> waiting for `nextRun`.
  waiting     -> due, but the flight controller is (was) disconnected. The
                 mission stays pending; as soon as the controller reconnects the
                 scheduler executes it. It is never silently marked completed.
  uploading   -> execution (upload + verify) in progress.
  completed   -> a "once" mission has been fully uploaded (terminal).
  failed      -> the last attempt failed; `lastError` holds the reason. The entry
                 is kept so it can be retried (re-enabled) instead of being lost.
  cancelled   -> disabled by the operator.

Repeat behaviour
----------------
  once   - upload at the scheduled time, then mark completed.
  daily  - upload each day at the configured time until endDateTime.
  weekly - upload on the configured weekdays until endDateTime.
  custom - upload on the configured YYYY-MM-DD dates.

Duplicate-execution protection
------------------------------
A due entry is flipped to `uploading` (and persisted) BEFORE the worker thread
starts, so a later tick can never re-queue the same occurrence. `occurrence`
records the exact occurrence being attempted. Entries in `_inflight` are a second
in-memory guard.
"""

import json
import threading
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from core.state import is_vehicle_connected

_SCHED_FILE = Path(__file__).resolve().parent.parent / "scheduled_missions.json"
_CHECK_INTERVAL_S = 1.0

# Module-level state
_scheduled: List[Dict[str, Any]] = []
_lock = threading.Lock()
_execute_lock = threading.Lock()
_timer_thread: Optional[threading.Thread] = None
_stop_event = threading.Event()
_execute_fn: Optional[Callable[[Dict[str, Any]], Any]] = None
_emit_fn: Optional[Callable[[str, Any], None]] = None
_inflight: set = set()


# ------------------------------------------------------------------
# Date/time helpers (all NAVIVE LOCAL — see module docstring)
# ------------------------------------------------------------------

def _as_naive(value: Any) -> Optional[datetime]:
    """Parse a stored datetime. Naive values are already local. Legacy
    timezone-aware values are converted to local and stripped."""
    if not value:
        return None
    try:
        text = str(value).strip()
        if not text:
            return None
        dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
        if dt.tzinfo is not None:
            dt = dt.astimezone().replace(tzinfo=None)
        return dt
    except (ValueError, AttributeError, TypeError):
        return None


def _fmt(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%S")


def _now() -> datetime:
    return datetime.now()


# ------------------------------------------------------------------
# Persistence
# ------------------------------------------------------------------

def _load() -> List[Dict[str, Any]]:
    if not _SCHED_FILE.exists():
        return []
    try:
        data = json.loads(_SCHED_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except (json.JSONDecodeError, OSError):
        return []


def _save() -> None:
    try:
        _SCHED_FILE.write_text(
            json.dumps(_scheduled, indent=2, default=str), encoding="utf-8"
        )
    except OSError as err:
        print(f"[SCHEDULE] Failed to save: {err}")


# ------------------------------------------------------------------
# Repeat logic
# ------------------------------------------------------------------

def _next_occurrence(entry: Dict[str, Any], now: datetime) -> Optional[datetime]:
    """Return the next future occurrence for this schedule, or None if expired."""
    start_dt = _as_naive(entry.get("startDateTime"))
    if start_dt is None:
        return None
    repeat = entry.get("repeat", "once")
    end_dt = _as_naive(entry.get("endDateTime"))

    if repeat == "once":
        return start_dt if start_dt > now else None

    if repeat == "daily":
        candidate = start_dt
        days_diff = (now.date() - start_dt.date()).days
        if days_diff > 0:
            candidate = start_dt + timedelta(days=days_diff)
        if candidate <= now:
            candidate += timedelta(days=1)
        if end_dt and candidate.date() > end_dt.date():
            return None
        return candidate

    if repeat == "weekly":
        # weeklyDays uses the frontend's 0=Sunday .. 6=Saturday convention.
        weekly_days = entry.get("weeklyDays") or []
        if not weekly_days:
            return None
        for offset in range(8):
            check_weekday = ((now + timedelta(days=offset)).date()).weekday()  # 0=Mon
            sun_format = (check_weekday + 1) % 7  # 0=Sun
            if sun_format in weekly_days:
                candidate = datetime.combine(
                    (now + timedelta(days=offset)).date(), start_dt.time()
                )
                if candidate > now:
                    if end_dt and candidate.date() > end_dt.date():
                        return None
                    return candidate
        return None

    if repeat == "custom":
        custom = entry.get("customDates") or []
        if not custom:
            return None
        today_str = now.strftime("%Y-%m-%d")
        for ds in sorted(d for d in custom if d >= today_str):
            try:
                d = datetime.strptime(ds, "%Y-%m-%d").date()
            except (ValueError, TypeError):
                continue
            candidate = datetime.combine(d, start_dt.time())
            if candidate > now:
                return candidate
        return None

    return None


def _refresh_next_run(entry: Dict[str, Any], now: Optional[datetime] = None) -> None:
    """Persist the next-run field from the repeat configuration."""
    now = now or _now()
    nr = _next_occurrence(entry, now)
    entry["nextRun"] = _fmt(nr) if nr else None
    if nr is None and entry.get("repeat") == "once" and entry.get("status") != "completed":
        entry["status"] = "completed"


# ------------------------------------------------------------------
# Emit helpers
# ------------------------------------------------------------------

def _emit_update(entry: Dict[str, Any]) -> None:
    if _emit_fn:
        _emit_fn("schedule:update", dict(entry))
        _emit_fn("schedule:status", {
            "id": entry.get("id"),
            "status": entry.get("status"),
            "nextRun": entry.get("nextRun"),
            "lastError": entry.get("lastError"),
        })


# ------------------------------------------------------------------
# CRUD
# ------------------------------------------------------------------

def list_schedules() -> List[Dict[str, Any]]:
    with _lock:
        return [dict(s) for s in _scheduled]


def add_schedule(entry: Dict[str, Any]) -> Dict[str, Any]:
    if not is_vehicle_connected():
        raise ValueError("Connect to the flight controller before scheduling a mission.")

    clean = dict(entry)
    clean.setdefault("enabled", True)
    clean.setdefault("status", "scheduled")
    clean.setdefault("occurrence", None)
    clean.setdefault("lastError", None)
    clean.setdefault("lastExecutedAt", None)

    now = _now()
    nr = _next_occurrence(clean, now)
    if nr is None:
        raise ValueError("Please select a valid date and time in the future.")
    clean["nextRun"] = _fmt(nr)

    with _lock:
        _scheduled.append(clean)
        _save()
    print(
        f"[SCHEDULE] Added '{clean.get('name')}' (id={clean.get('id')}) "
        f"nextRun={clean.get('nextRun')} repeat={clean.get('repeat')} — needs "
        f"flight controller to execute"
    )
    _emit_update(clean)
    return clean


def update_schedule(schedule_id: str, patch: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    with _lock:
        for s in _scheduled:
            if s.get("id") != schedule_id:
                continue
            prev_status = s.get("status")
            s.update(patch)
            if s.get("status") == "cancelled":
                s["enabled"] = False
            # Re-activation (retry a failed schedule / manual re-enable) rewinds
            # the state so the next tick picks the pending occurrence back up —
            # overdue occurrences are retried, not silently skipped.
            reactivating = prev_status == "failed" and s.get("enabled") and s.get("status") != "cancelled"
            if reactivating:
                s["status"] = "scheduled"
                if not s.get("nextRun"):
                    s["nextRun"] = s.get("startDateTime") or _fmt(_now())
            elif s.get("enabled") and s.get("status") == "scheduled":
                _refresh_next_run(s)
            _save()
            _emit_update(s)
            return dict(s)
    return None


def remove_schedule(schedule_id: str) -> bool:
    with _lock:
        before = len(_scheduled)
        _scheduled[:] = [s for s in _scheduled if s.get("id") != schedule_id]
        removed = len(_scheduled) < before
        if removed:
            _save()
    return removed


# ------------------------------------------------------------------
# Execution lifecycle
# ------------------------------------------------------------------

def _execute_mission(entry: Dict[str, Any]) -> None:
    """Run one occurrence (upload + verify). Runs in its own thread.

    Only one MAVLink mission-upload handshake may be in flight at a time (they
    share the same packet listeners), so execution is serialized with a lock.
    """
    sid = entry.get("id", "unknown")
    name = entry.get("name", "Untitled")
    occurrence = entry.get("nextRun")

    # Flag as in-flight BEFORE starting the worker so no later tick re-queues it.
    with _lock:
        _inflight.add(sid)
        for s in _scheduled:
            if s.get("id") == sid:
                s["status"] = "uploading"
                s["occurrence"] = occurrence
                s["lastError"] = None
                _save()
                snap = dict(s)
                break
        else:
            _inflight.discard(sid)
            return
    _emit_update(snap)
    print(f"[SCHEDULE] Uploading '{name}' (id={sid}) occurrence={occurrence}")

    if _execute_fn is None:
        print("[SCHEDULE] ERROR: No execute function registered")
        _finalize_failure(entry, RuntimeError("No scheduler executor registered."))
        return

    with _execute_lock:
        try:
            _execute_fn(entry)
            _finalize_success(entry, occurrence)
        except Exception as err:  # noqa: BLE001
            print(f"[SCHEDULE] Execution failed for '{name}': {err}")
            _finalize_failure(entry, err)
        finally:
            with _lock:
                _inflight.discard(sid)


def _finalize_success(entry: Dict[str, Any], occurrence: Any) -> None:
    sid = entry.get("id")
    name = entry.get("name", "Untitled")
    now = _now()
    with _lock:
        for s in _scheduled:
            if s.get("id") != sid:
                continue
            s["lastExecutedAt"] = now.isoformat()
            s["occurrence"] = occurrence
            if s.get("repeat") == "once":
                s["status"] = "completed"
                s["nextRun"] = None
                _save()
                snap = dict(s)
                _emit_update(snap)
                print(f"[SCHEDULE] '{name}' completed (once).")
                if _emit_fn:
                    _emit_fn("schedule:completed", {"id": sid, "name": name})
                return
            nr = _next_occurrence(s, now)
            s["nextRun"] = _fmt(nr) if nr else None
            if nr is None:
                s["status"] = "completed"
                print(f"[SCHEDULE] '{name}' has no more occurrences — completed.")
            else:
                s["status"] = "scheduled"
                print(f"[SCHEDULE] '{name}' executed OK — next run {s['nextRun']}")
            _save()
            snap = dict(s)
            _emit_update(snap)
            return
    # Schedule no longer exists — nothing to finalize.


def _finalize_failure(entry: Dict[str, Any], err: Exception) -> None:
    sid = entry.get("id")
    name = entry.get("name", "Untitled")
    msg = str(err) or "Unknown failure"
    with _lock:
        for s in _scheduled:
            if s.get("id") != sid:
                continue
            s["status"] = "failed"
            s["lastError"] = msg
            _save()
            snap = dict(s)
            break
        else:
            return
    print(f"[SCHEDULE] '{name}' upload failed: {msg}")
    if _emit_fn:
        _emit_fn("schedule:error", {"id": sid, "name": name, "message": msg})
    _emit_update(snap)


# ------------------------------------------------------------------
# Timer
# ------------------------------------------------------------------

def _timer_tick() -> None:
    now = _now()
    to_execute: List[Dict[str, Any]] = []

    with _lock:
        for entry in _scheduled:
            if not entry.get("enabled", True):
                continue
            status = entry.get("status", "scheduled")

            if status in ("completed", "cancelled", "uploading", "failed"):
                continue
            if entry.get("id") in _inflight:
                continue

            connected = is_vehicle_connected()
            if status == "waiting":
                # Mission is pending because the flight controller was down.
                # Keep it pending until the controller is back, then execute.
                if connected:
                    to_execute.append(entry)
                continue

            # "scheduled" (or unknown) — evaluate the due check.
            next_run = _as_naive(entry.get("nextRun"))
            if next_run is None:
                _refresh_next_run(entry, now)
                _save()
                next_run = _as_naive(entry.get("nextRun"))
                if next_run is None:
                    continue

            if next_run <= now:
                if connected:
                    to_execute.append(entry)
                else:
                    # Due but flight controller disconnected — hold as pending.
                    entry["status"] = "waiting"
                    _save()
                    if _emit_fn:
                        _emit_fn("schedule:status", {
                            "id": entry.get("id"),
                            "status": "waiting",
                            "nextRun": entry.get("nextRun"),
                            "lastError": "Waiting for flight controller connection.",
                        })
                        _emit_fn("schedule:update", dict(entry))
                    print(
                        f"[SCHEDULE] '{entry.get('name')}' due at {entry.get('nextRun')} "
                        "but flight controller is NOT connected — holding as WAITING"
                    )

    for entry in to_execute:
        t = threading.Thread(
            target=_execute_mission,
            args=(entry,),
            daemon=True,
            name=f"schedule-exec-{str(entry.get('id', '??'))[:8]}",
        )
        t.start()


def _timer_loop() -> None:
    print("[SCHEDULE] Timer started")
    while not _stop_event.wait(_CHECK_INTERVAL_S):
        try:
            _timer_tick()
        except Exception as err:  # noqa: BLE001
            print(f"[SCHEDULE] Timer error: {err}")
    print("[SCHEDULE] Timer stopped")


# ------------------------------------------------------------------
# Public API
# ------------------------------------------------------------------

def start_timer(
    execute_fn: Callable[[Dict[str, Any]], Any],
    emit_fn: Callable[[str, Any], None],
) -> None:
    """Start the background scheduler. Called once at server startup."""
    global _execute_fn, _emit_fn, _timer_thread, _inflight

    _execute_fn = execute_fn
    _emit_fn = emit_fn

    with _lock:
        _scheduled.clear()
        _scheduled.extend(_load())
        _inflight.clear()
        # Recover from a crash / restart: an in-progress upload is not "running"
        # anymore — put it back into the queue so an overdue mission can retry.
        for s in _scheduled:
            if s.get("status") == "uploading":
                s["status"] = "scheduled"
            # failed/waiting/completed keep their persisted nextRun so a pending
            # or failed occurrence is preserved across restarts.
            if s.get("status") == "scheduled" and not _as_naive(s.get("nextRun")):
                _refresh_next_run(s)

    print(f"[SCHEDULE] Loaded {len(_scheduled)} scheduled missions")

    if _timer_thread is not None and _timer_thread.is_alive():
        return

    _stop_event.clear()
    _timer_thread = threading.Thread(target=_timer_loop, daemon=True, name="schedule-timer")
    _timer_thread.start()


def stop_timer() -> None:
    """Stop the background scheduler."""
    _stop_event.set()