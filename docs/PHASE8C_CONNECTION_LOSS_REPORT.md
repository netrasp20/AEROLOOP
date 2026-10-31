# Phase 8C-CONNECTION-LOSS-FIX — Heartbeat-Loss Disconnect Report

**Date:** 2026-09-23
**Status:** ✅ COMPLETE (live-validated on SITL)

## Bug

The backend disconnected by HELD HEARTBEAT TIMEOUT, but only flipped
`vehicle_state["connected"]`. Everything else stayed "live": parameter writes
were still accepted, the Parameters page still reported READY, calibration
wizards kept running, and stale battery/GPS numbers stayed on screen as if
current.

## Fix (backend-authoritative, single source of truth)

- `ConnectionManager._mark_connection_lost(reason)` — full soft-disconnect that
  keeps the transport open:
  - `parameter_manager.stop_session(reason)` → REST + socket writes rejected
    (`NOT_CONNECTED`), Parameters/Frame/Modes pages → DISCONNECTED.
  - `calibration_service.reset_session()` → accel/mag/compassmot safe-stop.
  - `reset_telemetry()` + `tm.reset_home_position()` + `gpsFix/satellites` zeroed
    → no stale telemetry is ever presented as current.
  - emits `connection_state {state: DISCONNECTED, reason}`,
    `telemetry:update` (zeros), `vehicleStatus`.
- `_check_watchdog()` (extracted from `_watchdog_loop`, unit-testable) fires on
  `CONNECTION_TIMEOUT_MS` (10 s) heartbeat silence.
- `_on_heartbeat()` resume path (via new `_was_lost` flag) re-binds the
  parameter session, re-runs the auto-download, emits
  `connection_state {CONNECTED, reason: reconnected}` — **no browser refresh**.
- `disconnectReason` propagated to `vehicle_state`, `/api/vehicle/status`,
  and the `vehicleStatus` socket payload. Reasons are factual only:
  `heartbeat_timeout` / `Transport lost — device unplugged or link reset` /
  `Connection closed` / `connection timeout — no HEARTBEAT received`.
- Frontend: `TelemetryProvider` subscribes to `connection_state` and hard-drops
  stale gauges on any `connected:false` surface; `TopNavbar` shows a pulsing red
  **"MAVLink connection lost"** label + reason tooltip.

## Live evidence (SITL → mavproxy → backend udp:14550)

| Step | Result |
|------|--------|
| Connect | `connection_state` CONNECTING → CONNECTED; mode STABILIZE, gps 6, sats 10 |
| Kill MAVProxy | ~10 s later: `connection_state` DISCONNECTED `heartbeat_timeout`; telemetry zeroed (bat/gps/sats/lat = 0); `/api/vehicle/status` `connected:false gpsFix:0 sats:0 mode:DISCONNECTED` |
| Write while disconnected | `400 NOT_CONNECTED`; param status `DISCONNECTED` |
| Restart MAVProxy (no reconnect click) | `connection_state` CONNECTED `reconnected`; mode STABILIZE, gps 6, sats 10; true reconnect + param re-download (READY, 1379) + write `200` |
| Reconnect restores session | param write `CIRCLE_RADIUS_M` verified 10→11→10 |

## Regression

- Backend pytest **410 passed** (+11 `tests/test_connection_loss.py`)
- Frontend vitest **346 passed** (+7 `TelemetryProvider.test.tsx`, +2 `TopNavbar.test.tsx`)
- `tsc --noEmit` clean · `npm run build` clean · oxlint 0 errors (pre-existing warnings only)

## Files

Backend: `mavlink/connection_manager.py`, `core/state.py`, `sio/server.py`,
`services/vehicle_service.py`, `tests/test_connection_loss.py`.
Frontend: `providers/TelemetryProvider.tsx`, `layout/TopNavbar.tsx`,
`styles/navbar.css`, `providers/TelemetryProvider.test.tsx`, `layout/TopNavbar.test.tsx`.
Docs: `docs/PHASE8_SETUP_REPORT.md` (appended section).

## Scope guard

No transport rewrite; no per-page rewiring (setup pages already gate on
`telemetry.connected`); no USB-removal guesswork; UDP/TCP auto-reconnect by
design (watchdog keeps the transport open); serial replug requires a reconnect
click (device layer cannot self-reopen).

> **Update (later phase):** superseded. Phase 8C-QGC-PARITY added a serial
> auto-connect watcher (`mavlink/serial_autodetect.py`) so serial replug now
> reconnects automatically with no click — see
> `docs/PHASE8C_QGC_PARITY_REPORT.md`.