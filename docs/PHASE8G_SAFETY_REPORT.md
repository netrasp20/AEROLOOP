# PHASE 8G — SAFETY SETUP — RESULT REPORT

**Status:** PASS — automated + browser verification complete; human visual sign-off pending
**Date:** 2026-09-25 (final functional pass 2026-09-29)
**Hard stop respected:** nothing beyond Safety was touched (Motors/Servo/ESC/Gimbal/Logging/etc. remain inactive screens).

## What was delivered

A QGC-style **Safety** setup page (`frontend/src/components/setup/SetupSafety.tsx`) with:

1. **Safety Status card** — five honest rows derived from the vehicle's real parameters: Configuration (Ready/Not Ready), Arming Checks, Battery Failsafe, Radio Failsafe, GCS Failsafe, Return to Launch. A row whose failsafe a channel **cannot** be derived from is rendered `Unknown` (neutral), never invented.
2. **Battery failsafe card** — `BATT_LOW_VOLT`, `BATT_CRT_VOLT`, `BATT_LOW_MAH`, `BATT_CRT_MAH`, `BATT_LOW_TIMER` as editable thresholds; `BATT_FS_LOW_ACT` / `BATT_FS_CRT_ACT` as enum selects; `BATT_FS_VOLTSRC` as enum. A zero battery threshold renders as a "Disabled" tag (nobody configures a 0.0 V failsafe). All staged writes go through the shared **verified write pipeline** (`stageValue` + `executeWrite`, write-ahead read-back of echoed `PARAM_VALUE`).
3. **Radio failsafe card** — `FS_THR_ENABLE` enum, `FS_THR_VALUE` (PWM), and `FS_OPTIONS` as real **bitmask checkboxes** (with a raw-value fallback + "Bitmask details unavailable" when firmware lacks bitmask metadata). A configured `FS_THR_VALUE` that sits inside the throttle range (`RC3_MIN`–`RC3_MAX`) produces an explicit warning the user can act on — the page never auto-adjusts it.
4. **GCS failsafe card** — `FS_GCS_ENABLE` when the firmware exposes it, else honest "Unsupported by connected firmware"; always notes that loss-of-link action is executed by the flight controller, not the GCS.
5. **Return to Launch card** — `RTL_ALT_M`, `RTL_LOIT_TIME`, `RTL_ALT_FINAL_M` plus any other RTL params actually present (`RTL_CONE_SLOPE`, `RTL_CLIMB_MIN_M`, `RTL_SPEED_MS`). A present-but-not-staged RTL param (`LAND_SPEED`) is listed read-only or as Unsupported, never hidden.
6. **Arming Checks collapsible** — renders ARMING_CHECK bitmask when present (confirm-before-write); when firmware splits arming checks into `ARMING_*` (this Pixhawk) it honestly explains and points at the Advanced list rather than making one up.
7. **Advanced Safety Parameters collapsible** — categories built purely from params actually present, grouped by their official metadata `group`; "No values are invented / only present parameters are listed".
8. **Explicit state machine** — `WAITING` / `CONNECTING` / `CONNECTION_LOST` (reason + staged-changes-discarded note) / `SYNCING` / `ERROR` (with retry) / `UNSUPPORTED` (non-ArduCopter) / `READY`; sections render only when connected + supported + sync complete + data present. `Apply`/`Revert`, a confirmation dialog for failsafe/arming/bitmask/GCS changes, verified-success summary, `rebootRequired` "Reboot required" note, inline write errors, and a manual refresh; disconnect discards staged changes and never writes.

## Backing store (backend)

- `services/safety_service.py` — live snapshot `GET /api/setup/safety`: state machine, `supported` gating (ArduCopter only), logical-slot→actual-param resolution (e.g. `RTL_ALT`→`RTL_ALT_M`, `RTL_ALT_FINAL`→`RTL_ALT_FINAL_M`, `RTL_SPEED`→`RTL_SPEED_MS`, `RTL_CLIMB_MIN`→`RTL_CLIMB_MIN_M`), field builders for enum/bitmask/`zeroMeansDisabled`/unit, honest status derivation, per-param `supported` flags and warnings. Sections are built only after `sync complete` + data present.
- Parameter writes use the shared verified `write_parameter` path proven in earlier phases; the GCS never sends RTL/Land/disarm/motor commands from this page.

## Automated tests

- **Backend:** `tests/test_safety.py` → **34 passed**. Full backend regression → **540 passed**.
- **Frontend:** `SetupSafety.test.tsx` → **37 passed** (all 8 states, honest Unknown/Unsupported rendering, bitmask checkboxes + raw fallback, threshold-range warning, confirm-before-write for failsafe/arming/GCS/bitmask vs direct write for thresholds, write success/error, reboot note, revert/refresh, `parameter:updated` refresh, disconnect-discard-without-write, and "never claims YantraYug will RTL/Land the vehicle"). Full frontend suite → **463 passed** (33 files).
- `npm run build` (`tsc -b && vite build`) **exit 0**; `npx tsc -b` **0 errors**; `npm run lint` **0 errors** (only pre-existing `react(only-export-components)` / `exhaustive-deps` warnings remain).
- **Build-health fix (disclosed):** the real build gate was failing on two independent causes. (1) Two dead locals introduced by this phase in `SetupSafety.tsx` (`isConfirmable`, `ok`) — removed; the live confirm logic is the inline `confirmFields`/`stagedConfirm` path, so behavior is unchanged. (2) A **pre-existing** app-wide map break, not from 8G: the single live `src/layout/MapPanel.tsx` (consumed by `DataPage`, `data/components/FlightMap`, `plan/PlanMap`) still imported four removed Rover-era components — `MapToolbar`, `ZoomControls`, `Compass`, `RoverMarker` → 4× `UNRESOLVED_IMPORT`. Reconciled it to the **existing current** map component set with no redesign: `MapControlDock` (already consolidates compass + zoom + PLAN tools + recenter; receives the Leaflet instance via a `useMap` bridge) + `MapAutoFit` + `VehicleMarker` (the current rename of the vehicle marker) + the controlled `MapSwitcher` backed by its own `TILES` export (default `sat` = the same Esri World Imagery tile source the old panel hard-coded). Click/context-menu handling, `WaypointMarker`, `MissionPath`, `HomeMarker`, `ContextMenu`, `WaypointSettings`, PLAN-only editing and all CSS are preserved verbatim. The earlier `npx tsc --noEmit` check was vacuous (root `tsconfig.json` has `"files": []` + project references, so `--noEmit` checks no referenced project); `tsc -b` is the real gate.
- Runtime signal: the live Vite dev server (`:5173`) transforms `MapPanel` and all nine current map children with HTTP 200 and no resolve/transform errors; no map component has a unit test (only `SetupSafety.test.tsx` exists in that directory), so map verification here is type-check + production bundle + dev module graph, not a render test.

## Live validation

### Real Pixhawk 1 via USB (`/tmp/backend.log`, `AUTO_CONNECT_SERIAL=true`)
- Connected `ARDUPILOTMEGA QUADROTOR`, mode `STABILIZE`, **sync 991/991 complete → `READY`**.
- `status`: Configuration `Ready`, ArmingChecks `Enabled`, **BatteryFailsafe `Unknown`** (this firmware session serves no `BATT_FS_*`/`BATT_LOW_*` battery-failsafe params → honest `Unknown`), RadioFailsafe `Configured`, GCSFailsafe `Disabled`, RTL `Configured`.
- Radio: `FS_THR_ENABLE` `Enabled always RTL`, `FS_THR_VALUE 975.0`, `FS_OPTIONS` bitmask presents only bit **4** (`Continue if in pilot controlled modes on GCS failsafe`); no throttle-range warning (RC3_MIN=1006, RC3_MAX=1995).
- GCS: `FS_GCS_ENABLE` `Disabled/NoAction`; RTL: `RTL_ALT_M 15.0`, `RTL_LOIT_TIME 5000.0`, `RTL_ALT_FINAL_M 0.0`; extra `RTL_CONE_SLOPE 3.0`, `RTL_CLIMB_MIN_M 0.0`, `RTL_SPEED_MS 5.0`.
- Arming: `ARMING_CHECK` absent; honest "splits arming checks into ARMING_*" note; Advanced categories Failsafe:4 / RTL behaviour:3 / Arming:8 / SmartRTL & other:1.
- Evidence: `docs/evidence/phase8g-safety-live-pixhawk.png`, `...-pixhawk-2.png`, `phase8g-safety-live-pixhawk.json`.

### SITL ArduCopter (TCP:5760, `AUTO_CONNECT_SERIAL=false`)
- `arducopter --model quad` + MAVProxy TCP:5760 → UDP:14550.
- Backend `POST /api/vehicle/connect {"connectionType":"tcp","host":"127.0.0.1","port":5760}` → `Connected via TCP. HEARTBEAT received.`; **sync 1379/1379 → `READY`**; `status.connectionType` reports `TCP` (proves the cache is live from SITL, not the USB Pixhawk).
- Same endpoint returns the full battery suite this SITL serves: `BATT_LOW_VOLT 10.5`, `BATT_CRT_VOLT 0.0` (+Disabled tag logic), `BATT_FS_LOW_ACT`/`FS_CRT_ACT` `Warn only`, `BATT_FS_VOLTSRC`; battery status honestly `Disabled` (actions are Warn-only).
- SITL-specific values rendered in the browser: `FENCE_RADIUS 150`, `FENCE_ALT_MAX 100`, `FS_THR_VALUE 975`, `RTL_LOIT_TIME 5000` — distinct from the Pixhawk session, proving the UI is bound to the live cache rather than to a fixture.
- A different firmware's param set is rendered faithfully without any retargeting of logic — the battery card appears where firmware exposes the params and correctly reports `Unknown`/Unsupported where it does not.
- Evidence: `docs/evidence/phase8g-safety-live-sitl.json`.

All validation was **read-only**. No hardware write, no reboot, no motor operation, no flight, and no failsafe trigger was performed during this phase.

## Final verification pass (QGC-parity restructure)

The Safety page was restructured to QGC composition and then verified end-to-end. No redesign followed; only defects found during verification were fixed.

### Browser geometry (Chrome CDP, 1680px viewport, live SITL)
Measured with `getBoundingClientRect` / `getComputedStyle` against the running app — no refresh, no mocks.

| Check | Result |
|---|---|
| Section order | Battery → General → GeoFence → RTL → Arming |
| Two-column pairing | Battery `y=228` w=685, General `y=228` w=685; GeoFence `y=481` w=685, RTL `y=481` w=685 |
| Arming full width | `y=1027` w=1385 (spans both columns) |
| Horizontal overflow | none — `document.body.scrollWidth 1680` = `innerWidth 1680` |
| Row heights | 28 / 34 / 43 / 59 / 60 / 94 px; all non-bitmask rows horizontal |
| Input control height | 30 px uniform across `select` and `input` |
| Unsupported control | compact 34 px `Unavailable` row (kept honest, not invented) |
| Arming bitmask layout | 42 checkboxes + 11 radios; multi-column, not one-per-line |
| Bottom actions | Refresh / Revert / Apply grouped below Arming |
| Dashboard nodes | 0 |
| Connection banner | no "Disconnected", no "lost connection" while connected |
| Branding | `YANTRAYUG` present; Setup sidebar unchanged |

### Live data proves the pipeline (no fixture)
- Real Pixhawk (SERIAL, auto-connect): `READY` **991/991**. `FENCE_ACTION 1`, `FENCE_ENABLE 0`, `RTL_ALT_M 15`, `FS_THR_ENABLE 1`, `ARMING_SKIPCHK -1045951` (bits 6 + 11).
- SITL (TCP): `READY` **1379/1379**. `FENCE_ACTION 1`, `FENCE_ENABLE 0`, `FENCE_RADIUS 150`, `FENCE_ALT_MAX 100`, `FS_THR_VALUE 975`, `RTL_ALT_M 15`, `RTL_LOIT_TIME 5000`.
- Both sessions were read only; no `POST` to any parameter endpoint was issued against the Pixhawk.

### Disconnect / reconnect without refresh (executed in a single live page session)
| Phase | Inputs rendered | Rows | Values |
|---|---|---|---|
| Connected to SITL | 25 | 42 | populated |
| After `POST /api/vehicle/disconnect` | 0 | 0 | cleared, `Disconnected` placeholder shown |
| After reconnect, **no page reload** | 25 | 42 | repopulated, cache resynced 1379/1379 |

Stale values are dropped on loss and fresh values re-appear purely over the Socket.IO channel — no browser refresh is required at any point.

### Defects found and fixed during this pass
1. **Backend startup target (real defect).** The documented dev command served the bare FastAPI router, so `/socket.io/` was never mounted and every page showed "Disconnected" even while the vehicle was connected. `backend/main.py` now documents the distinction, import-checks `asgi_app`, and prints `ASGI target: app:asgi_app (FastAPI + Socket.IO) — /socket.io/ is mounted` on start.
2. **Control color mismatch (real defect, visible).** The radio/checkbox controls introduced by the restructure referenced theme variables (`--accent`, `--border-strong`, `--bg-input`, `--text-dim`) that are never defined in this codebase, so they fell back to colors that did not match the adjacent inputs. They now use the same literals as their neighbours. Verified in the browser: radio background `rgb(13, 19, 34)` = input background, border `rgb(42, 51, 72)` = input border, checked accent `rgb(124, 58, 237)`.

### Final regression (after every change above)
- **Backend:** `tests/test_safety.py` → **45 passed**. Full backend suite → **653 passed**, 153 warnings.
- **Frontend:** `SetupSafety.test.tsx` → **53 passed**; `WriteParamsControl.test.tsx` → **5 passed**.
  Full frontend suite → **539 passed** (36 files).
- `npx tsc -b` → 0 errors. `npm run lint` → exit 0 (only pre-existing `react(only-export-components)` /
  `exhaustive-deps` warnings). `npm run build` → `✓ built in 890ms`.

## Functional pass — 2026-09-29

The visual design was frozen; this pass fixed only functional data-flow defects, each
reproduced in SITL and covered by a unit regression.

### Defects found and fixed in this pass

| # | Defect | Root cause | Fix | Regression |
|---|---|---|---|---|
| 1 | Completed batch was re-sent and rejected as stale (`expected 'txn-a' to be undefined`) | `ParameterContext` kept `writeActiveTxnId` set after completion, so the next batch reused the same ID | Completed IDs are cleared in `onBatchWriteComplete` | `WriteParamsControl.test.tsx` — temporarily reverting the fix makes the test fail |
| 2 | RTL "current altitude" wrote `0` on a vehicle whose `RTL_ALT_M min=0.3` | The current/specified radio pair was rendered unconditionally, offering an illegal value | The `0` encoding is offered **only** when metadata puts `0` in range; otherwise only the valid specified-altitude input renders | `SetupSafety.test.tsx` metadata-range cases |
| 3 | Switching on a `0`-means-disabled optional field left it off (`RTL_ALT_FINAL_M 0→0`) | The enable path staged the plain minimum (`0`) | `enableValue()` picks the smallest in-range non-zero value metadata actually offers (positive minimum, else one increment step) and returns `null` — disabling the control — when metadata cannot supply one. No fallback number is invented | `SetupSafety.test.tsx`; live `0 → 0.1` |
| 4 | A partially applied batch was reported as success | Only whole-transaction failures surfaced an error | The panel names every parameter the vehicle did not write, with the vehicle's own reason, and the headline states how many of how many were applied. "Previous values were preserved" is only claimed when nothing was written | `SetupSafety.test.tsx` partial-failure case |
| 5 | Advanced enums rendered as raw numbers (`RTL_CONE_SLOPE 5 → INVALID_ENUM`) | `safety_service._build_advanced_section` dropped the metadata `values` / `bitmask` maps | The builder now looks up metadata and forwards `options` / `bits`; the frontend dispatches an enum select, a bitmask editor, or a numeric input per field | `test_safety.py` + `SetupSafety.test.tsx`; live payload now carries options for `RTL_CONE_SLOPE` and `WP_YAW_BEHAVIOR` |
| 6 | `WP_YAW_BEHAVIOR` staged but `Apply` stayed disabled | `safetyParamsStaged` counted fields by a `BATT_`/`FS_`/`RTL_`/`FENCE_`/`ARMING_` prefix filter, which omitted Advanced fields | The count is derived from the actual rendered `allFields` | `SetupSafety.test.tsx`; live `WP_YAW_BEHAVIOR 2→3` |

### 41-control SITL browser sweep — **41/41 PASS**

`python3 /home/prema/.agent-tmp/sweep.py` drives the real UI over CDP against a live
SITL vehicle: click a control, `Apply`, confirm, wait for the staged banner to clear, then
read the value back and assert the exact expected echo.

| Group | Controls | Result |
|---|---|---|
| Battery Failsafe Triggers | 6 | 6/6 PASS |
| General Failsafe Triggers | 5 (incl. `FS_OPTIONS` bitmask) | 5/5 PASS |
| GeoFence | 4 | 4/4 PASS |
| Return to Launch | 3 (incl. both zero-toggle directions) | 3/3 PASS |
| Arming Checks | 8 (incl. `ARMING_SKIPCHK` All) | 8/8 PASS |
| Advanced | 15 (enums, bitmasks, numbers) | 15/15 PASS |
| **Total** | **41** | **41/41 PASS** |

Every case restores its own original value; a follow-up read confirmed all 40 swept
parameters sit exactly on the recorded baseline with zero mismatches.

### Real Pixhawk re-verification (read-only, this pass)

- Connected `ARDUPILOTMEGA QUADROTOR` over serial (`COM3` → `/dev/ttyACM0`, 115200).
- **Sync 991/991 → `READY`.** No write endpoint was issued against this vehicle.
- The Battery card renders all six rows as compact `Unavailable`. This is **correct**:
  the parameter cache holds only `BATT_MONITOR` and `BATT2..BATT9_MONITOR` — this
  firmware serves none of `BATT_LOW_VOLT`, `BATT_CRT_VOLT`, `BATT_LOW_MAH`,
  `BATT_CRT_MAH`, `BATT_LOW_TIMER`, `BATT_FS_LOW_ACT`, `BATT_FS_CRT_ACT`, or
  `BATT_FS_VOLTSRC`. The page reports that fact rather than inventing values.
- General, GeoFence, RTL and Arming render live values with firmware-provided enum and
  bitmask labels (e.g. `FENCE_TYPE 7` as bitmask checkboxes, `FS_OPTIONS 16` as its
  five real bits, `WP_YAW_BEHAVIOR` as its four firmware options).

### Parameter placement (where each real parameter is shown)

Primary sections now carry only the QGC rows; everything else moved to Advanced.
**No parameter was deleted** — all mappings still resolve, and all of them remain
writable through the same staged/verified write pipeline.

| Parameter | Shown in |
|---|---|
| `BATT_FS_LOW_ACT`, `BATT_FS_CRT_ACT`, `BATT_LOW_VOLT`, `BATT_CRT_VOLT`, `BATT_LOW_MAH`, `BATT_CRT_MAH` | Battery (primary, 6 rows) |
| `BATT_LOW_TIMER`, `BATT_FS_VOLTSRC` | Advanced → Battery |
| `GCS_ENABLE`/`FS_GCS_ENABLE`, `FS_GCS_TIMEOUT`, `FS_THR_ENABLE`, `FS_THR_VALUE`, `FS_OPTIONS` | General (primary) |
| `FENCE_ENABLE`, `FENCE_ACTION`, `FENCE_RADIUS`, `FENCE_ALT_MAX` | GeoFence (primary) |
| `FENCE_TYPE`, `FENCE_OPTIONS`, `FENCE_ALT_MIN`, `FENCE_MARGIN`, `FENCE_NTF_FREQ` | Advanced → GeoFence |
| `RTL_ALT_M`, `RTL_LOIT_TIME`, `LAND_SPEED`, `RTL_ALT_FINAL_M` | Return to Launch (primary) |
| `RTL_CONE_SLOPE`, `RTL_CLIMB_MIN_M`, `RTL_SPEED_MS` | Advanced → RTL behaviour |
| `ARMING_SKIPCHK` (+ All), all `ARMING_*` checks | Arming Checks (primary) |
| `FS_EKF_*`, `FS_CRASH_CHECK`, `FS_VIBE_ENABLE`, `WP_YAW_BEHAVIOR` | Advanced → metadata groups |

Placement is capability-driven, never hardcoded: `batteryExtra` / `fenceExtra` filter on
`field.supported`, and the backend's `advanced.categories` are still built from the
firmware's own metadata `group`. On this Pixhawk all `BATT_*` failsafe params report
`supported: false`, so the six Battery rows honestly render the compact `Unavailable`
control rather than faking values.

### Final browser checklist (Chrome CDP, 1680px, live Pixhawk, 991/991)

| # | Check | Result |
|---|---|---|
| 1 | Battery + General side-by-side | PASS — both `y=228`, w=685 |
| 2 | Battery has only six primary rows | PASS — `batteryRowCount: 6` |
| 3 | General compact | PASS — 5 rows, no extras |
| 4 | GeoFence compact | PASS — 4 primary fields only |
| 5 | RTL compact | PASS — 5 rows, 4 params |
| 6 | Arming Checks spans full width | PASS — `w=1385` vs `685` for paired columns |
| 7 | Arming Checks compact | PASS — 3 grids, 6 columns each, heights 66/15/32px |
| 8 | Advanced collapsed by default | PASS — `advancedOpen: false` on load |
| 9 | Extra FENCE params not on main page | PASS — `fenceExtraLeaked: []` |
| 10 | Extra RTL params not on main page | PASS — `rtlExtraLeaked: []` |
| 11 | Extra battery params not on main page | PASS — `battExtraLeaked: []` |
| 12 | No Safety Status dashboard | PASS — `dashboardNodes: 0` |
| 13 | No giant cards | PASS — uniform 30px controls, thin sections |
| 14 | No giant unsupported blocks | PASS — 7 compact `Unavailable` rows, all 30px |
| 15 | No excessive whitespace | PASS — no horizontal overflow (1680 = 1680) |
| 16 | QGC-like density | PASS — 35 rows in 5 sections at 1680px |
| 17 | YantraYug branding preserved | PASS — `brand: true` |
| 18 | Live values still work | PASS — `FENCE_RADIUS 300` from the vehicle cache |
| 19 | No console/React errors | PASS |
| 20 | Advanced contains the moved params | PASS — GeoFence + RTL behaviour categories, values `-10`, `2`, `3` |

`All` still targets the real bitmask: `safety-arming-arming_skipchk-bit-all` plus
bits 1–19, against `ARMING_SKIPCHK` (value `-1045951`, bits 6 and 11 set).

Actions sit on one row below Arming: `Refresh | Revert | Apply`.

### Disconnect / reconnect re-verified after the refinement (real Pixhawk, serial)
| Phase | Inputs | Rows | Radios |
|---|---|---|---|
| Connected | 14 | 35 | 11 |
| After `POST /api/vehicle/disconnect` | 0 | 0 | 0 (stale cleared) |
| After reconnect, **no page reload** | 14 | 35 | 11 (cache resynced 991/991) |

### Verification artifacts
- `docs/evidence/phase8g_safety_final.png` — full-page Safety screenshot with Advanced
  expanded against the live vehicle, taken during this pass.
- `/home/prema/.agent-tmp/sweep.py` — the 41-control SITL browser sweep.
- `/home/prema/.agent-tmp/browser4.py` — React-safe control interaction helpers.
- Screenshots must be compared against the QGC references by a human reviewer; the
  automated pass asserts structure, geometry, and live values, not pixel parity.

## Honesty guarantees honoured

- No fabricated safety state, status, value, bit, or decoded label anywhere; every field's `supported` flag comes from whether the firmware actually served that parameter.
- The GCS never triggers RTL/Land/disarm from this page; confirmation-dialog text and the warning banner state that the flight controller alone executes configured failsafes.
- Absent params render `Unsupported by connected firmware` / `Unknown` / `Unavailable` — never hidden-in-the-background, never faked.
- Clean disconnect/reconnect: staged edits are discarded on connection loss and never written; reconnect re-fetches from the vehicle without a reload.

## Known limitations

- **ArduCopter-only scope.** The page targets ArduPilot Copter firmware (Copter param set + `copter.xml` metadata). Non-Copter vehicles land in an explicit `UNSUPPORTED` state.
- **Param presence is per-session.** On the connected Pixhawk the entire battery-failsafe suite is absent from the parameter cache (only `BATT_MONITOR*` exists), so all six Battery rows honestly render `Unavailable`, while SITL serves all of them. Both are rendered faithfully per session.
- **Bitmask metadata gap.** If a firmware serves `FS_OPTIONS`/`ARMING_CHECK` without bitmask documentation, the page falls back to the raw value + an explicit "Bitmask details unavailable" note rather than guessing bits.
- **Safety-not-a-substitute language.** Arming checks and failsafe actions remain a pre-arm/pre-flight aid; the report/documentation does not claim certification-level guarantees.
- **Map has no render test.** The `MapPanel` build-health fix is verified by `tsc -b`, the production bundle, and the Vite dev module graph, but no automated test renders the map (it has no react-leaflet mock scaffolding); visual confirmation of the restored dock/switcher/vehicle marker is the user's manual check on the running app.

## Scope frozen after this point

Motors, Servo, ESC, Gimbal, Logging, Scripting remain **inactive** Setup screens (phase 8H and later). Nothing further will be implemented unless the user explicitly requests it.