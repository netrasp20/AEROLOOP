# Phase 8C-QGC-PARITY — QGroundControl-style Vehicle Connection / Setup / Summary

**Date:** 2026-09-24
**Status:** ✅ COMPLETE — live-validated on **real Pixhawk1 hardware**

> This phase reworked YantraYug GCS so the vehicle connection lifecycle and the
> Setup → Summary screen behave like QGroundControl: a plugged Pixhawk is
> detected and connected automatically (no CONNECT click), link loss is shown
> immediately with a factual reason, and a re-plug auto-reconnects and re-downloads
> the parameter set. The real Pixhawk connect → disconnect → reconnect lifecycle
> was executed and captured on this machine.

---

## Scope (QGC parity model implemented)

| QGC behaviour | YantraYug equivalent |
|---|---|
| USB device auto-detection on plug | Serial auto-connect watcher (daemon thread, `AUTO_CONNECT_SERIAL`) |
| Connect without pressing CONNECT | Auto-`manager.start("serial", device)` on first detected ArduPilot device |
| Vehicle discovery via HEARTBEAT (ArduCopter only) | Connection only completes on a genuine HEARTBEAT; UDP/TCP are never auto-connected |
| Parameter download on connect | Unchanged (991 params auto-downloaded on the real flight controller) |
| "Waiting for vehicle" Summary state | QGC-style Summary empty state (new) |
| Header connection states | `CONNECTED` / `CONNECTING...` / `MAVLink CONNECTION LOST` / `NO VEHICLE` (new, backend-authoritative) |
| Link lost → reason shown | `heartbeat_timeout` / `Transport lost — device unplugged or link reset` (reused) |
| Re-plug auto-reconnects (no click, no refresh) | Watcher reconnects the reappeared device and the param session is rebuilt |

## What was implemented

### Backend — serial auto-connect (`mavlink/serial_autodetect.py`)
- New QGC-style watcher: while idle (no active transport, vehicle not connected)
  it scans for ArduPilot-class serial devices (`serial_service._enumerate_ports()`
  — ttyACM/ttyUSB/cu, prefers the stable udev `/dev/serial/by-id` symlink) and
  calls `manager.start("serial", device=...)`, awaiting the first real HEARTBEAT.
- Poll interval `SERIAL_AUTO_SCAN_INTERVAL_S` (2.5 s); `SERIAL_AUTO_RETRY_COOLDOWN_S`
  (10 s) after a failed attempt — a port busy during Pixhawk reboot legs up
  gracefully, never steals a MAVProxy-owned port.
- Runs only for serial devices; UDP/TCP/SITL keep the existing heartbeat-resume
  reconnect (watchdog keeps the transport open).
- Lifecycle: started/stopped from the `app.py` lifespan; guarded by
  `AUTO_CONNECT_SERIAL` (env, default true). New `tests/test_serial_autodetect.py`
  (8 tests) covers no-op / running / connected / first-device / by-id preference /
  failure behaviour; `conftest.py` sets `AUTO_CONNECT_SERIAL=false` so tests can
  never hijack a transport on a Pixhawk-equipped machine.

### Frontend — authoritative header states (`layout/TopNavbar.tsx`)
- New `connection-state-chip` derived **only** from backend
  `telemetry.connectionState` + `telemetry.disconnectReason` (never a frontend
  timer):
  - `CONNECTED` (green) · `CONNECTING...` (amber pulse) ·
    `MAVLink CONNECTION LOST` (red pulse, reason in tooltip) · `NO VEHICLE` (slate).
- Replaces the old static "MAVLink connection lost" label; heartbeat indicator
  retained.

### Frontend — QGC-style Summary (`components/setup/SetupSummary.tsx`)
- Disconnected state is now QGC's "Waiting for vehicle" (`Connect a Pixhawk or
  MAVLink vehicle to view and configure vehicle settings.`) with a red
  `Reason:` line when the link was lost; stale values are never rendered.
- GPS tile now shows fix quality + satellite count (`RTK Fixed · 10 sats`,
  `No GPS`, …) matching MAVLink GPS fix type semantics.
- Vehicle card (Status/Vehicle/Autopilot/Mode/Armed/System-Component/Battery/GPS)
  and configuration-status matrix render only real live data.

## Real Pixhawk live evidence

Hardware: **ArduPilot Pixhawk1** — `/dev/ttyACM0`,
by-id `usb-ArduPilot_Pixhawk1_3C0027000951363033383531-if00`, autopilot
`ARDUPILOTMEGA`, vehicle class `QUADROTOR`, firmware mode `STABILIZE`.

Captured `/api/vehicle/status` + `/api/parameters/status` transitions:

| Time | Event | State |
|---|---|---|
| 08:32:52 | Plug-in (USB) | auto-connected `SERIAL`, 991/991 params complete |
| 08:33:56 | **Unplug** | `connected:false` → `Transport lost — device unplugged or link reset`, params 0/0 (idle) — immediate, no 10 s wait |
| 08:34:21 | Re-plug | auto-detect reopens → `CONNECTING` (serial) |
| 08:34:24→31 | First attempt legs up (device still booting USB) | transient drop → `connection timeout — no HEARTBEAT received` |
| 08:34:34 | Second attempt | **auto-reconnected** `SERIAL`, params re-download 138/991 → 991/991 complete |
| 08:34:53 | Stable | `connected:true`, session `complete` |

The re-plug auto-reconnected with **no CONNECT click and no browser refresh**,
and rebuilt the parameter session to full sync (991/991) — the full QGC replug
lifecycle. The one-leg transient on re-plug mirrors QGC itself re-opening the
USB port while the autopilot finishes booting.

## Regression

- Backend pytest **418 passed** (was 410; +8 `tests/test_serial_autodetect.py`)
- Frontend vitest **349 passed** (was 346; header-state tests 2→4, `SetupSummary`
  waiting/lost-reason states + GPS-fix assertions)
- `tsc --noEmit` clean · `npm run build` clean (pre-existing chunk-size warning)
- Backend same-state check on a Pixhawk-equipped bench (auto-connect) and SITL rig
  (UDP heartbeat-resume) both verified; SITL/MAVProxy path untouched.

## Files

Backend: `core/config.py` (`AUTO_CONNECT_SERIAL`, scan/cooldown), new
`mavlink/serial_autodetect.py`, `app.py` (lifespan start/stop), `tests/conftest.py`,
new `tests/test_serial_autodetect.py`.

Frontend: `layout/TopNavbar.tsx` (+chip), `styles/navbar.css` (chip states),
`components/setup/SetupSummary.tsx` (+waiting/lost states, GPS fix label),
`styles/setup.css` (reason style), `layout/TopNavbar.test.tsx`,
`components/setup/SetupSummary.test.tsx`.

Docs: this report.

## Scope guard

Serial-only auto-connect; UDP/TCP/SITL never auto-connected (heartbeat-resume
reconnect unchanged). No fabrication of connection/calibration/telemetry
values — every number comes from the live vehicle or is a “—”/“Waiting”.
YantraYug branding stays (purple/violet, dark professional UI; no bright-blue
primary). ArduCopter/ArduPilot only; no Rover/PX4 claim.

**HARD STOP** — Phase 8D not started.