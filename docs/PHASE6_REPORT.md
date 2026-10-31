# Phase 6 — Mission Planner Parameter Screen Recreation — Final Report

Status: **COMPLETE** (Phase 7 NOT started — hard stop in effect)

## Summary

The "Full Parameter List" screen now recreates Mission Planner's MissionPlanner
"config → Full Parameter Tree" layout, wired to a real ArduPilot **Rover SITL**
connection, and validated end-to-end. All backend and frontend quality gates are
green.

## 1. Backend (Phase 6 + reconnect fix)

New / verified endpoints (all `backend/api/parameters.py`):

- `GET /api/parameters/export?source=vehicle` — full CSV export (header comments
  + `name,value` rows), exports the **authoritative live set** with optional
  `# STAGED`/`# StagedValue` markers for staged (not-yet-written) edits.
- `POST /api/parameters/import` — parse + compare against the live set
  (counts: changed/same/unknown/read-only/invalid).
- `POST /api/parameters/compare` — file/preset text vs live vehicle, honoring
  the client's `staged` map so file↔staged conflicts are surfaced.
- `POST /api/parameters/presets/{id}/analyze`, `GET /api/parameters/presets` —
  vehicle-type-audience presets (rover_baseline / rover_conservative /
  rover_speed) with stageable diffs.
- `POST /api/parameters/reset` + `GET /api/parameters/reset/status` — real
  factory-default reset via `MAV_CMD_PREFLIGHT_STORAGE` (p1=2) + reboot
  (`MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN` 246) + reconnect + re-sync + verify.
  Socket.IO progress on `parameter:reset:start/progress/reconnect/complete/error`.

Services: `backend/services/parameter_file.py`, `parameter_presets.py`,
`parameter_reset.py` (workers run on a thread with injectable deps — the full
lifecycle is unit-tested without hardware).

**Reconnect fix** (`parameter_reset.py`): the reset `reconnect()` step now tears
down the prior transport (`conn_manager.stop()`) before rebinding. Some
vehicles/sims (incl. ArduRover SITL) only resume emitting heartbeats on fresh
sessions after an autopilot reboot, so waiting indefinitely on the old socket
failed 5/5 attempts. With the fix the reset completes:
`backup(1261) → factory defaults → reboot → reconnect → re-sync → verify`.

## 2. Frontend (Phase 6 MP recreation)

New `frontend/src/styles/mission-planner.css` (dense dark Dense UI) + components
under `frontend/src/components/parameters/` + helpers in
`frontend/src/parameters/fileLogic.ts`.

Layout (verified at 1280px: **18.0% / 68.1% / 13.9%** ≈ 18/68/14 spec):

- **Left nav** (`ParameterNav.tsx`): Flight Modes, GeoFence, Basic Tuning,
  Extended Tuning, `Standard Params (7 via test fixtures: 5)`, `Advanced Params
  (2)`, `Full Parameter List` (active), Full Parameter Tree, Planner, plus the
  group summary tree below. Inert items (Flight Modes/GeoFence/Basic/Extended/
  Full Parameter Tree/Planner) are selectable/decorative only — filtering is via
  Standard / Advanced / Full + the group tree (Phase 6 scope).
- **Center table** (`ParameterTable.tsx` + `ParamValueEditor.tsx`): columns
  exactly `Command | Value | Units | Options | Desc`; sticky header, dense rows,
  wrapped descriptions; inline editing in the **Value cell** of the selected row
  (numeric input w/ range hint, `<select>` for enum, checkbox list for bitmasks,
  read-only note). Enter/blur commits; Escape reverts the draft. Modified badge
  on the selected row; staged banner + conflict note + revert action inline.
- **Right panel** (`ParameterActions.tsx`): Load from File / Save to File /
  **Write Params (only when stagedCount > 0)** / Refresh Params / Compare
  Params / "All units are in raw format with no scaling." / Load Presaved /
  Reset to Default / Search / **Modified (N)** checkbox.
- **Dialogs** (`ParameterFileDialogs.tsx`): FileDialog (load/compare modes),
  SaveDialog, PresetsDialog (compare → apply → stage), ResetDialog (confirm).

Behavior: writes happen **only** through Phase 4 staging + Phase 5
`Write Params (N)` write transaction (staging never auto-writes). Load/compare/
presaved stage the selected diffs. Save exports the authoritative live set with
markers for staged-but-unwritten params.

## 3. Quality gates

- Backend: `python3 -m pytest -q` → **155 passed** (incl. test_parameter_file,
  test_parameter_preset, test_parameter_reset, test_parameter_api_phase6).
- Frontend: `npm test` → **144 passed / 9 files** (ParametersScreen +
  WriteParamsDialog + ParameterFileDialogs + fileLogic + prior suites);
  `npm run build` (tsc + vite) OK (only chunk-size warning);
  `npm run lint` (oxlint) → exit 0, only pre-existing warnings.

## 4. Manual validation with ArduPilot Rover SITL

Environment: `build/sitl/bin/ardurover` (ArduRover **V4.8.0-dev**,
1261 params) with MAVProxy keeping the link alive; backend connected over TCP
(5760 native / 5762 SERIAL1 — the repo's own `start-sitl-rover.sh` uses
TCP:5760, the load-bearing detail is that the SITL process keeps its stdin open
via the `tail -f /dev/null | mavproxy` pipe so it never exits on the
single-client close).

- Connect: `POST /api/vehicle/connect {tcp,127.0.0.1,5762}` → HEARTBEAT (MAV
  TYPE GROUND_ROVER, ArduPilot) → 1261 params synced (complete).
- Export `source=vehicle` → 1261 rows, header + valid CSV.
- Write transaction: staged `AHRS_GPS_MINSATS 6→5` → verified `5.0` → restored
  back to `6` (verified `6.0`).
- Compare file `test.param` → counts `changed:1, same:1, unknown:1` (as expected).
- Presets: `rover_baseline` analyze → 2 stageable diffs (`CRUISE_SPEED 5→2`,
  `WP_RADIUS 3→2`).
- **Reset**: `{confirm:true}` → status `complete`; backup 1261, factory
  defaults applied, 1248 unchanged + 13 environment/runtime params changed
  (COMPASS_DEC, BARO GND_PRESS, STAT_RUNTIME, MAV1_* STREAMs — values SITL
  re-derives each boot; no material restore needed; MINSATS already at default).
- Frontend on live data: 1261 rows rendered, row click opens inline editor,
  Write Params correctly hidden until something is staged, all right-panel
  controls present. Screenshots: `/tmp/opencode/mp-params-full.png` (live data),
  `/tmp/opencode/mp-params-layout.png` (disconnected-state layout).

## 5. Modified/new files

Backend
- `backend/api/parameters.py` (Phase 6 endpoints)
- `backend/services/parameter_file.py`, `parameter_presets.py`,
  `parameter_reset.py` (reset reconnect fix)
- `backend/tests/test_parameter_api_phase6.py`, `test_parameter_file.py`,
  `test_parameter_preset.py`, `test_parameter_reset.py`

Frontend
- `frontend/src/components/parameters/ParametersScreen.tsx`,
  `ParameterTable.tsx`, `ParamValueEditor.tsx`, `ParameterNav.tsx`,
  `ParameterActions.tsx`, `ParameterFileDialogs.tsx`, `ParameterStatusBar.tsx`
- `frontend/src/parameters/fileLogic.ts` (+ `fileLogic.test.ts`)
- `frontend/src/context/ParameterContext.tsx`, `frontend/src/api/parameters.ts`
- `frontend/src/styles/mission-planner.css`
- `frontend/src/components/parameters/ParametersScreen.test.tsx`,
  `ParameterFileDialogs.test.tsx` (WriteParamsDialog.test.tsx unchanged & green)

## 6. Remaining visual differences vs the MP reference

- Exact Mission Planner palette/typography is approximated (verified
  structurally at 18/68/14 ratios, not pixel-matched to the screenshot).
- Inert left-nav entries are decorative (no per-tab filtering in Phase 6).
- Search is implemented in the right panel (MP also has one in the tree view).
- "Not Connected" state shows the MP-style banner in the center panel.
- Range hint and override/bitmask editors render only for the selected row.

**HARD STOP** — Phase 7 (or any further scope) has NOT been started.

---

## 7. Final visual verification addendum (normal connection path)

Re-validated on the **exact normal YantraYug path** per `start-sitl-rover.sh`:
ArduRover SITL (`build/sitl/bin/ardurover`) TCP:5760 → MAVProxy
(`--master tcp:127.0.0.1:5760 --out udp:127.0.0.1:14550`) → backend
`POST /api/vehicle/connect {connectionType:"udp"}` (listens UDP:14550).

- Screenshot: `/tmp/opencode/yantrayug-phase6-verification.png` (the actual
  rendered YantraYug CONFIG → Full Parameter List on live data).
- Vehicle: **ArduRover V4.8.0-dev**, MAV_TYPE **GROUND_ROVER**, **1261**
  parameters synced (`state: complete`).
- Layout at 1280×860: left nav **18.0%**, table **68.1%**, actions **13.9%**
  (spec 18/68/14). Nav entries: Flight Modes, GeoFence, Basic Tuning, Extended
  Tuning, Standard Params (460), Advanced Params (801), Full Parameter List
  (1261), Full Parameter Tree, Planner + group tree with live counts (AHRS_ 16,
  SIM_ 214, …).
- Table columns: **COMMAND | VALUE | UNITS | OPTIONS | DESC**; 1261 rows at
  25.5px row height; dark theme `rgb(26,31,46)`.
- Right panel: Load from File / Save to File / Refresh Params / Compare Params /
  Load Presaved / Reset to Default / Search / Modified checkbox / the
  "All units are in raw format with no scaling." note — all present; Write
  Params hidden while no changes are staged.
- Live-not-mock: `ACRO_TURN_RATE` renders **180** in the table and its live API
  value is `180.0` (`live.value`, receivedAt recent); SIM_* (SITL-only) ids
  present — mock fixtures do not contain these.
- Inline editing: row click opens the numeric editor; Enter commits; staged chip
  appears; **Write Params (1)** button appears; **Discard All** (confirm) clears
  it (button + chip removed) with **no write transaction started** — vehicle
  value remains 180.0 (`/api/parameters/write/status` hasActive false).
- Note: earlier validation session used TCP:5762 (SERIAL1); the above re-run
  used the repo's own 5760/14550 path. No code was changed during this final
  verification pass.

---

## 8. Final visual-polish pass (old-school MP desktop look)

CSS-only pass in `frontend/src/styles/mission-planner.css` (no component,
backend, or functionality changes). Changes: near-black `#141414` overall
background; flattened status bar (no rounded floating card); flat squared
nav with **solid bright-green selected item** (`#5fa51a`, black text); center
table with `linear-gradient(#4e4e4e,#3a3a3a)` sticky header, **zebra rows**
(`#1e1e1e`/`#232323`), thin `#2d2d2d` cell gridlines, 1px `#4d4d4d` pane
borders, **blue selected row** (`#2a5fae`, white text), compact 11px
typography, natural desc wrapping, visible vertical scrollbar; right panel
with flat 21px-tall `0px`-radius Windows-style buttons and small 10px note;
MP column proportions Command 16% / Value 11% / Units 7% / Options 20% /
Desc 46% (measured px: 139/96/61/174/400 at 1024 wide), single-line row height
**18px**.

Measured via Playwright on the live screen (1024×768, normal SITL path UDP:14550):
- Panes still 18.0 / 68.1 / 13.9.
- Active nav `rgb(95,165,26)` fill, 12px/700 near-black text.
- Header cells text: `Command | Value | Units | Options | Desc`.
- Rows 1261; selected row `rgb(42,95,174)`; action buttons height 21px,
  radius 0, border `#545454`, width 161px; statusbar bg `#191919`, margin 0.
- Write Params hidden at 0 staged; Search + Modified (0) present; note text
  "All units are in raw format with no scaling." present.

Final screen: `/tmp/opencode/yantrayug-phase6-visualpolish.png`
Gates: frontend 144 passed / 9 files, build OK, lint OK (8 pre-existing
warnings, exit 0); backend 155 passed. SITL Rover GROUND_ROVER, 1261 params.

**HARD STOP** — Phase 7 (or any further scope) has NOT been started.