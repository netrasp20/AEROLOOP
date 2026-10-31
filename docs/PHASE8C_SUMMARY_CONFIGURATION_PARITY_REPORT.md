# Phase 8C-SUMMARY-CONFIGURATION-PARITY — QGC-style Configuration Health Matrix

**Date:** 2026-09-24
**Status:** ✅ COMPLETE — live-validated on **real Pixhawk1 hardware**

> Setup → Summary "Configuration Status" is now a genuine parameter-driven
> configuration health system for ArduCopter, modeled on QGroundControl's
> Summary screen. Every status, count and message is derived from the live
> downloaded PARAM_VALUE set (the vehicle is the only authority). No health
> scores are fabricated, no counts are hardcoded, and the screen is strictly
> read-only — it never arms, moves actuators, starts calibration or writes a
> parameter to compute a status. The five-tone state model (OK / warn /
> unsupported / unknown / waiting) distinguishes "waiting for the vehicle to
> answer" from "this firmware genuinely has no such subsystem".

---

## Scope (QGC configuration-parity model implemented)

| QGC behaviour | YantraYug equivalent |
|---|---|
| Summary shows configuration-goodness per subsystem | `GET /api/setup/summary` matrix with **15 rows**, 5 tones, clickable navigation |
| Rows are green/amber/gray only when provable | `good` / `warn` / `unsupported` / `unknown` / `waiting`, all computed from the live PARAM_VALUE cache |
| "Waiting for Parameters" during download | All rows become `waiting` with `Parameters syncing — X/Y`; never `unsupported` |
| Green only for calibrated sensors | Accel/gyro/compass/barometric/level tones derive from `get_sensor_status()` readback (calibrated/not-calibrated/unsupported) |
| RC calibration shown by stored endpoints | Radio = OK only when `RC1_MIN ≤ 1100` **and** `RC1_MAX ≥ 1900` (QGC's own range criterion); message "RC calibration stored" / "RC calibration required" |
| Unsupported = capability absent | Unsupported **only** when the defining param is absent from the downloaded set (e.g. no `MNT_*` params → "No gimbal configured") |
| Summary rows navigate to the Setup page | Each row carries a `nav` target to the matching YantraYug Setup page |
| Header count beads | `X ok · Y warn · Z unsupported · W waiting` (waiting = `waiting + unknown`) |

## The five-tone state model (backend authority)

```
DISCONNECTED  -> connected:false, empty items. Frontend shows the QGC waiting
                / lost-reason state. Never "unsupported".
sync != done  -> every parameter-driven row is WAITING
                ("Waiting for parameter sync N/M" or "Syncing parameters…").
                A param that is simply not downloaded YET is NOT evidence of
                firmware incompatibility → waiting never collapses to unsupported.
sync complete -> each row evaluated against the live cache:
                   supported + configured  -> good
                   supported + needs work  -> warn
                   genuinely not applicable -> unsupported (ONLY when the
                                               defining param is absent;
                                               never inferred from metadata)
                   cannot determine        -> unknown (readback failure)
"waiting" and "unknown" are distinct tones, both reported unresolved in the
count header; neither is ever downgraded to "unsupported".
```

## What was implemented

### Backend — evaluator rewrite (`services/setup_summary_service.py`)
- `ITEM_ORDER` (15 rows, with nav targets):
  frame→`frame`, accelerometer→`sensors`, gyroscope→`sensors`,
  compass→`sensors`, barometer→`sensors`, level→`sensors`, radio→`radio`,
  flightModes→`modes`, power→`power`, safety→`safety`, esc→`esc`,
  servoOutputs→`servos`, gimbal→`gimbal`, logging→`logging`, gps→`parameters`.
- **WAITING tone** (`waiting`): a new tone + counts key. During sync every row is
  `waiting` with the download beat (`received/expected`); a fresh sync with no
  count shows `Syncing parameters…` only.
- **Sensor evaluators** driven by `get_sensor_status()` group statuses
  (calibrated / not-calibrated / unsupported) for accel, gyro, compass, baro:
  wired end-to-end with the sensor-status readback (this is the same authority
  the Sensors page uses — one source of truth, no duplication).
  - Compass special-case: `COMPASS_USE=0` → "Disabled" warn even if offsets exist.
  - Barometer: ground-pressure present → "Calibrated"; `BARO1_GND_PRESS` absent
    or zero → "Calibration required".
  - Level Horizon: a *leveled* multirotor stores a small AHRS_TRIM reset offset;
    near-zero (≤ 0.01 rad) is the healthy bound → "Level horizon set".
    Only a genuinely large offset → "Level horizon offset large" warn.
    (Catch: the readback-reported `not-calibrated` for trim ≈ 0.004 rad would
    otherwise have flagged a correctly-leveled aircraft — fixed with the
    threshold, see evidence.)
- **Radio = configuration-parity (QGC range criterion)**: merely having the RC
  params exist is NOT "calibrated". OK only when `RC1_MIN ≤ 1100` and
  `RC1_MAX ≥ 1900` (same numbers QGC uses for green). Message
  "RC calibration stored"/"RC calibration required" — the wording never claims
  live-RC input (handle_rc_channels is a no-op on this codebase).
- **New rows**: ESC (`MOT_PWM_TYPE` present → "Configured", never claims ESC
  calibration), Servo Outputs (`SERVO1_FUNCTION`/`SERVO1_MIN`/*/`RC1_FUNCTION`
  present), Gimbal (`MNT_TYPE`/`MNT_MODE`; both absent → "No gimbal configured"
  unsupported; present but 0 → "Gimbal present but disabled" warn).
- Power / Safety / Flight Modes / Logging / GPS rows unchanged in intent but
  re-lit from the same evaluator registry (power `BATT_MONITOR` disable → warn;
  safety lists enabled protections; logging `LOG_BITMASK=0` → "Disabled";
  gps no-fix → warn with satellite count).
- Counts are computed by tallying the emitted rows — never hardcoded.

### Frontend — five-tone view layer
- `api/setup.ts`: `SetupTone` and `SetupCounts` gain `"waiting"`.
- `components/setup/setupLogic.ts`: `summarizeStatus` tallies 5 tones;
  `summaryBadge` still counts **warn + unsupported only** — waiting/unknown are
  unresolved, not problems.
- `components/setup/SetupSummary.tsx`: `ToneIcon` shows a Clock for `waiting`
  (distinct from the `?` help icon for `unknown`); counts header
  `waiting = counts.waiting + counts.unknown` (treated unresolved); sync note
  unchanged. Disconnected / lost states unchanged (Phase 8C).
- `styles/setup.css`: `.setup-tone-waiting` + `.setup-count-waiting` (slate gold
  // same gray family as unknown).
- `hooks/useSetupSummary.ts`: **live update** — besides the 5 s poll, the hook
  now forces an immediate refetch whenever a socket event signals the vehicle
  state changed: `parameter:sync:progress`, `parameter:sync:complete`,
  `parameter:updated`, `parameter:write:success`, `accel_cal:result`,
  `compass_cal:result`. Still clears instantly when `enabled` flips false
  (disconnect → no stale config on screen; reconnect rebuilds everything).

## Real Pixhawk live evidence

Hardware: **ArduPilot Pixhawk1** — `/dev/ttyACM0`,
by-id `usb-ArduPilot_Pixhawk1_3C0027000951363033383531-if00`, `ARDUPILOTMEGA`,
`QUADROTOR`, `STABILIZE`, 991 params.

`GET /api/setup/summary` (backend restarted to new code, then brand-new auto
parameter download observed):

| Moment | `/api/setup/summary` | Meaning |
|---|---|---|
| 09:0x — mid-download | `connected:true`, `sync:receiving 510/991` | **15×`waiting`** "Waiting for parameter sync (510/991)", counts `{waiting:15}` |
| ✓ — sync complete | `sync:complete 991/991` | Matrix rebuilt: **10 good · 4 warn · 1 unsupported · 0 unknown · 0 waiting** |
| Live update | socket `parameter:sync:progress` (100→991) + `parameter:sync:complete` | The exact events the frontend hook listens to → immediate refetch (proved by full-download capture below) |

Fully-annotated row-by-row (after sync):

```
  frame         good      Configured · the selected airframe is valid
  accelerometer good      Calibrated
  gyroscope     good      Calibrated
  compass       good      Enabled · calibrated
  barometer     good      Calibrated
  level         good      Level horizon set
  radio         warn      RC calibration required      RC1_MIN=1082 · RC1_MAX=1894 · RC1_TRIM=1547
  flightModes   good      Configured
  power         warn      Battery monitoring disabled  BATT_MONITOR=0
  safety        good      Throttle
  esc           good      Configured                   MOT_PWM_TYPE present
  servoOutputs  good      Configured                   SERVO1_FUNCTION present
  gimbal        unsupported  No gimbal configured      no MNT_* params anywhere
  logging       warn      Disabled                     LOG_BITMASK=0
  gps           warn      No satellite fix yet         (indoors bench)
```

Directly-derived truths the rows prove:
- **Radio warning is real**: `RC1_MIN=1082 ≤ 1100` and `RC1_MAX=1894 < 1900` —
  endpoints are *outside* QGC's calibrated band, so this is an honest
  "calibration required" (the previous render just printed the stored values).
- **Level fix caught on hardware**: trims were `-0.0036 / -0.0011` rad — a
  correctly-leveled aircraft. The naive "not-calibrated" mapping would have shown
  a false `warn`; the threshold-based evaluator reports `Level horizon set`.
- **Gimbal unsupported is capability-absence**: the aircraft firmware exposes no
  `MNT_*` parameter at all → `No gimbal configured` (never "gimbal disabled").
- **No actuator/write side effects**: DISCONNECT → matrix empty; parameter set
  never modified (verified: identical `991/991`, values unchanged before/after).

### Live-update capture (read-only refresh)
A socket.io client attached to the running backend, then `POST /api/parameters/refresh`
(a plain PARAM_REQUEST_LIST re-download — read-only; no value written):

```
api  complete  991/991  {good:10 warn:4 unsupported:1}
api  receiving 18/991   {waiting:15}
api  receiving 36/991   {waiting:15}  ... 991/991 {waiting:15}   ← "Parameters syncing — X/Y"
progress 100/991 ... 991/991   (server-throttled socket events)
complete 991/991   status complete
api  complete  991/991  {good:10 warn:4 unsupported:1}   ← matrix rebuilds
```

The exact event stream the frontend `useSetupSummary` hook subscribes to — so a
parameter change, calibration result, or re-sync flips Summary live without
waiting for the 5 s poll.

## Regression

- Backend pytest **430 passed** (was 418; summary service reworked + **+10**
  summary-parity tests → 25 summary-specific scenarios: disconnected, waiting/
  syncing-count, healthy-never-unsupported, counts-sum=length, nav-map=15 ids,
  frame codes, missing-param unsupported, one-missing-secondary-never-unsupported,
  frame=0 warn, accel-id=0 warn-not-unsupported, gps no-fix warn, flight-mode slot
  count, esc/servo/gimbal rows, gimbal-absent unsupported, gimbal-disabled warn,
  radio-range-conf-only, compass-disabled, battery-disabled, logging-disabled,
  mixed-counts computed, indeterminate→unknown, level small-offset good,
  level large-offset warn, endpoint shape, disconnected endpoint).
- Frontend vitest **353 passed** (was 349; +unknown-vs-waiting tone row, +3
  `useSetupSummary` hook tests for socket-triggered refetch, poll, disable-clear).
- `tsc --noEmit` clean · `npm run build` clean (pre-existing chunk-size warning).
- Verified served end-to-end through the Vite proxy (`5173 → 5000`).

## Files

Backend: `services/setup_summary_service.py` (evaluator rewrite: WAITING tone,
15-row ITEM_ORDER, status-driven sensor evaluators, esc/servoOutputs/gimbal rows,
radio range criterion, level threshold, computed counts),
`tests/test_setup_summary_service.py` (updated + 10 new scenarios).

Frontend: `api/setup.ts` (`SetupTone`/`SetupCounts` + `waiting`),
`components/setup/setupLogic.ts` (5-tone tally, badge unaffected),
`components/setup/SetupSummary.tsx` (`ToneIcon` Clock, counts header
waiting+unknown), `styles/setup.css` (`.setup-tone-waiting`,
`.setup-count-waiting`), `hooks/useSetupSummary.ts` (socket-triggered live
refetch + disable-clear), tests: `components/setup/*.test.tsx`,
`hooks/useSetupSummary.test.ts`.

Docs: this report.

## Scope guard

- **Read-only end-to-end**: summary never arms, never runs MAV_CMD motor tests,
  never starts calibration to *compute* a status, never writes a parameter.
  The only thing it triggers is a parameter re-read (PARAM_REQUEST_LIST).
- ArduCopter/ArduPilot only; no Rover/PX4 claim. No fabricated GPS/sensor/cal
  values — every tone is provable from the vehicle's own download.
- **WAITING ≠ UNSUPPORTED**, **UNKNOWN ≠ UNSUPPORTED**: waiting/unknown are
  unresolved states shown in the count header, never flipped to unsupported.
- YantraYug branding stays (purple/violet, dark professional UI; no bright-blue
  primary). Summary rows navigate to existing YantraYug Setup pages — no
  duplicate Setup pages were created.
- No "85% configured"-style aggregate health score.

**HARD STOP** — Phase 8D not started.