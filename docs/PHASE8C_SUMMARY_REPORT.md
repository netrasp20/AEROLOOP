# Phase 8C — Setup Summary: Live Capability Matrix Report

**Date:** 2026-09-22
**Status:** ✅ COMPLETE (live-validated on Pixhawk)

## Objective

Fix the false **"Unsupported on this firmware"** statuses on the YantraYug GCS
SETUP → Summary page and rebuild it as a QGC-style **live capability matrix**.
Capability detection moves from the browser to the backend, which uses the
**live 991-parameter set as the oracle of truth** for what the connected
ArduCopter actually supports. The rebuilt Summary shows live vehicle identity,
a live firmware card, a 4-tone (good / warn / unsupported / unknown) status
matrix, dynamic counts, and clickable rows that navigate to the relevant
setup panel. ArduCopter only.

## Root cause (two layers)

1. **Backend never auto-downloaded parameters.** On every fresh link,
   `parameter_manager.start_session()` resets the parameter cache; nothing called
   `request_all_parameters()` until the user manually hit "Re-query". The
   browser's parameter store therefore stayed (mostly) empty right after
   connecting.
2. **Zero data → pessimism.** The old `setupLogic/configStatus()` treated *every
   missing parameter* as "gray"/Unsupported because it could not distinguish
   "not synced yet" from "genuinely absent on this firmware".

Code sprinkling defaults into the browser to fake support was rejected: the
vehicle's live parameter set is the only honest capability oracle.

## Design decisions

- **Backend is authoritative.** `GET /api/setup/summary` computes the whole
  matrix on the server, from live parameters + sensor status + vehicle/firmware
  state + firmware-info endpoint. The frontend renders the payload; it never
  re-derives capability.
- **Four tones.** `good` (param present, sane), `warn` (present but needs
  attention), `unsupported` (defining param absent from the live set),
  `unknown` (sync in progress). **`unsupported` is never inferred from
  metadata or from a single missing secondary parameter** — only a missing
  *defining* param (e.g. `FRAME_CLASS`) marks an item unsupported.
- **Sync gating.** While the parameter download is not `complete`, all 13 items
  are `unknown` with a "Waiting for parameter sync (N/M)" note. Disconnected ⇒
  zero items, `connected:false`. Params that ArduCopter 4.7 transiently holds
  back (e.g. `BATT_FS_LOW_ACT` absent on this firmware) do **not** make battery
  unsupported — the item stays driven by its defining params.
- **13 items, ArduCopter-only.** Frame, Accelerometer, Gyroscope, Compass,
  Barometer, Level, Radio, Flight Modes, Power/Battery, Safety/Failsafes,
  Motors/Outputs, Logging, GPS. Sensor items consume the existing
  `calibration_service.get_sensor_status()`; the frame item ships
  `FRAME_CLASS`/`FRAME_TYPE` and the frontend enriches the message via the
  existing Phase 8B `frameLogic.ts`.
- **Auto param download (the fix).** `connection_manager._start()` now kicks a
  daemon thread (`_auto_param_download_worker`) that calls
  `request_all_parameters()` — after `start_session()` on fresh connect and in
  the reconnect branch (guarded so a completed download is not re-run). The
  browser gets parameters without any user click.
- **Badge semantics.** Attention count = warn + unsupported only; `unknown`
  while syncing is never a Setup badge problem. `summaryBadge` maps to the
  existing SetupNav `{warn, bad}`.
- **Live updates without refresh.** `useSetupSummary` polls every 5 s behind an
  `enabled` gate (driven by telemetry), stops on disconnect, and clears stale
  state — the page tracks sync progress and post-calibration tone changes live.

## API

- `GET /api/setup/summary` →
  `{ success, connected, sync: {state, expectedCount, receivedCount, …}, items: [{id, label, tone, message, detail?, nav, meta?}], counts: {good, warn, unsupported, unknown} }`
  - `nav` maps each row to a setup panel (frame, sensors, radio, modes, power,
    safety, motors, logging, parameters).

## Frontend

- `api/setup.ts` — `SetupTone`, `SetupStatusItem`, `SetupCounts`,
  `SetupSyncState`, `SetupSummaryData` types + `getSetupSummary()`.
- `hooks/useSetupSummary.ts` — enabled-gated 5 s polling hook; clears + falls
  back to empty summary on error/disable.
- `components/setup/SetupSummary.tsx` — props-driven rebuild: vehicle identity
  tiles (via `useTelemetry`), live firmware card (`useFirmwareInfo` with
  working Re-query), 4-tone matrix, tone-coded counts chip, sync note,
  disconnected early-return, and buttonized rows with chevrons (`data-testid
  setup-status-<id>`).
- `components/setup/SetupConfig.tsx` — owns `useSetupSummary(telemetry.connected)`,
  computes the Setup badge from summary counts, passes `summary` + `onNavigate`.
- `setupLogic.ts` — slimmed to re-exported types + `summarizeStatus` +
  `summaryBadge` (the bug-encoding per-param evaluators are deleted).
- `styles/setup.css` — `.setup-tone-unsupported`/`.setup-tone-unknown`
  (violet-toned for unsupported per YantraYug purple palette), `.setup-status-row`
  full-width button styling, `.setup-count-*` colors, `.setup-sync-note`.

## Tests

- Backend: new `tests/test_setup_summary_service.py` (**21**): disconnected /
  waiting-sync / healthy ArduCopter never unsupported / counts sum / nav
  targets / frame meta / `FRAME_CLASS`-absent → unsupported / one-missing-
  secondary never unsupported / warn values / API shape / auto-download guard.
  Full backend suite **347 passed**.
- Frontend: rewritten `SetupSummary.test.tsx` (8), `setupLogic.test.ts`,
  updated `SetupConfig.test.tsx` (badge now driven by `/api/setup/summary`
  counts). Full frontend suite **328 passed** (26 files).
- `tsc -b` clean; oxlint 0 errors (pre-existing warnings only); `npm run build`
  green.

## Live validation (Pixhawk1 `/dev/ttyACM0`, ArduCopter 4.7.0, 991 params)

| Step | Result |
|------|--------|
| Backend restart + reconnect | `POST /api/vehicle/connect` → HEARTBEAT received |
| **Auto param download** | Log shows `[PARAM] Requesting full parameter list` **with no user click**; download complete 991/991, 0 missing, 0 retries |
| `GET /api/setup/summary` (complete) | **unsupported: 0** (bug fixed) — counts good 9 / warn 4 / unknown 0 |
| Good items (real values) | frame `FRAME_CLASS=1 FRAME_TYPE=1`; accel `INS_ACC_ID=1246218`; gyro `INS_GYR_ID=2163722`; compass `COMPASS_USE=1 · OFS_X=-37.72`; baro ground `91137 Pa`; level `AHRS_TRIM` set; flightModes `FLTMODE_CH=Channel 5 · 6 slots`; safety Throttle; motors `MOT_PWM_TYPE=0` |
| Warn items (real values) | radio `RC1_MIN=1082 · RC1_MAX=1894` (endpoints uncalibrated); battery monitor disabled (`BATT_MONITOR`); logging disabled (`LOG_BITMASK`); GPS no fix — all genuine, none fabricated |
| Mid-sync state | 865/991 received → all 13 items `unknown`, correct "waiting" behavior |
| Disconnect | summary `connected:false`, `items:[]`, counts all 0 |
| Reconnect | auto-download re-runs → 991/991 → identical matrix (unsupported 0) |
| Firmware card source | `GET /api/setup/firmware` → `4.7.0 (Official Release)`, custom `1511f271` |
| Vite dev proxy | `http://localhost:5173/api/setup/summary` forwards and returns `unsupported: 0` |

> ArduCopter 4.7 with all defining params present **must** report zero
> unsupported — this is a regression test in `test_setup_summary_service.py`.

## Success criteria acceptance checklist

- [x] False "Unsupported on this firmware" eliminated on live Pixhawk (0/13).
- [x] Summary derives capability from live 991-param set + sensor status + firmware — never hardcoded.
- [x] All 13 ArduCopter items present with accurate 4-tone verdicts (9 good / 4 warn real).
- [x] Params auto-download on connect (log-verified) — no manual Re-query needed for capability.
- [x] Re-query button on firmware card actually refetches `GET /api/setup/firmware`.
- [x] Sync-in-progress → unknown state; disconnected → empty; reconnect → identical rebuild.
- [x] Rows are clickable and navigate to the matching setup panel (`nav`).
- [x] Disarmed ≠ unsupported; vehicle that is merely uncalibrated shows warn, not unsupported.
- [x] Backend 347 tests pass; frontend 328 tests pass; `tsc -b` / oxlint / build clean.
- [x] Param sync reused (no duplicate download path); ArduCopter-only; no scope creep.

## Files

- `backend/mavlink/connection_manager.py` — `_start_auto_param_download()` + `_auto_param_download_worker()` wired into fresh + reconnect branches.
- `backend/services/setup_summary_service.py` (new) — capability matrix, evaluators, `get_setup_summary()`.
- `backend/api/setup.py` — `GET /summary` route.
- `backend/tests/test_setup_summary_service.py` (new, 21 tests).
- `frontend/src/api/setup.ts` — summary types + `getSetupSummary()`.
- `frontend/src/hooks/useSetupSummary.ts` (new).
- `frontend/src/components/setup/SetupSummary.tsx` (rebuild), `SetupConfig.tsx`,
  `setupLogic.ts` (slimmed), `SetupSummary.test.tsx` / `setupLogic.test.ts` / `SetupConfig.test.tsx`.
- `frontend/src/styles/setup.css` — unsupported/unknown tones, buttonized rows, counts, sync-note.

## Scope guard

ArduCopter-only; no Rover/Plane/PX4 assumptions. No new connection layer
(reuses `parameter_manager`, `calibration_service`, `command_service`). No raw
MAVLink in React. Capability matrix is data-driven from live parameters;
nothing is sprinkled into the browser to fake support.