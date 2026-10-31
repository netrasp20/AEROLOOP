# Phase 8A — Setup Shell + Summary Report

**Date:** 2026-09-16  
**Status:** ✅ COMPLETE

## Objective

Build the YantraYug **Vehicle Setup** shell (QGC-style) and **Summary** page under the SETUP navigation tab, providing real-time vehicle health at a glance with ArduCopter parameter-aware status detection and live firmware identification via the AUTOPILOT_VERSION MAVLink message.

## Sub-phase Scope (8A)

| Component | What was built |
|-----------|---------------|
| **Setup shell** | `SetupConfig.tsx` — full-screen left nav + content switch + connection/mode/vehicle status top bar |
| **SetupNav** | 15-item left sidebar: Summary, Firmware, Frame, Sensors, Radio, Modes, Power, Safety, Motors, Servos, ESC, Gimbal, Logging, Scripting, Parameters. Badge on Summary when warnings detected. |
| **SetupSummary** | Vehicle identity tiles (status, vehicleType, autopilot, mode, armed, sysid/compid, battery, GPS sats), firmware card (fetched live via AUTOPILOT_VERSION), Config Status matrix with 13 health rows |
| **SetupFirmware** | Dedicated firmware details page (version, custom tag, board, vendor/product, UUID), with Re-query button, loading/error/disconnected states. Firmware install/update explicitly unsupported. |
| **SetupParameters** | Reuses existing `ParameterTable` + `ParameterGroupTree` + `WriteParamsDialog` + `parametersLogic` — no parameter logic duplicated. All/Standard/Modified toggles, search, Discard/Save buttons via existing store. |
| **SetupInactive** | Explicit "Available in Phase X" placeholder for 8B–8H pages — **never fakes** vehicle functionality |
| **setupLogic.ts** | 13 pure capability-detection functions + `configStatus()` + `summarizeStatus()`. Each function: returns `gray` when param absent (unknown firmware), `warn` when present but unhealthy, `good` when confirmed healthy. |
| **Backend** | `GET /api/setup/firmware` endpoint: sends COMMAND_LONG(MAV_CMD_REQUEST_MESSAGE=512, param1=148), receives AUTOPILOT_VERSION via packet_bus, decodes FIRMWARE_TYPE_LABELS + flight_sw_version bit-fields |
| **Backend tests** | 6 new tests in `test_setup_api.py` (endpoint existence, disconnection handling, version decoding edge cases) |

## Configuration Status Detection Rules

| Check | Good | Warn | Gray (unknown) |
|-------|------|------|----------------|
| Frame | FRAME_CLASS != 0 | FRAME_CLASS == 0 | FRAME_CLASS absent |
| Accelerometer | INS_ACC_ID != 0 | INS_ACC_ID == 0 | INS_ACC_ID absent |
| Gyroscope | INS_GYR_ID != 0 | INS_GYR_ID == 0 | INS_GYR_ID absent |
| Compass | COMPASS_USE=1 + offset exists | COMPASS_USE=0, or enabled without offset | COMPASS_USE absent |
| Barometer | BAROx_GND_PRESS != 0 | BAROx_GND_PRESS == 0 | No baro params |
| Level | AHRS_TRIM_X ≈ 0 AND AHRS_TRIM_Y ≈ 0 | Trims not zero | AHRS_TRIM_* absent |
| Radio | RC1_MIN ≤ 1100 AND RC1_MAX ≥ 1900 | Endpoints untouched | No RC params |
| Flight Modes | FLTMODE_CH != 0 | FLTMODE_CH == 0 | FLTMODE_CH absent |
| Battery | BATT_MONITOR != 0 | BATT_MONITOR == 0 | BATT_MONITOR absent |
| Safety | Any of FS_THR_ENABLE/FS_GCS_ENABLE/FENCE_ENABLE enabled | None enabled | No safety params |
| Motors | Any of MOT_PWM_TYPE/MOT_SPIN_ARMED/DSHOT present | — | All absent |
| Logging | LOG_BITMASK != 0 | LOG_BITMASK == 0 | LOG_BITMASK absent |
| GPS | GPS1_TYPE != 0 AND sats ≥ 1 | GPS1_TYPE != 0 but no fix, or sats=0 | GPS1_TYPE absent |

**Key design rule:** If a parameter does not exist on the vehicle's firmware, the check returns `gray` ("Unsupported on this firmware") — it **never** fabricates a pass or fail state.

## SITL Validation (Live ArduCopter 4.8.0-dev)

All validation performed against a real ArduCopter SITL instance (UDP connection, 1379 params loaded, READY state):

### Firmware endpoint

```
GET /api/setup/firmware
→ {
    "success": true,
    "version": "4.8.0 (Development)",
    "custom": "d16ddbab",
    "flightSwVersion": 67633152,
    "middlewareSwVersion": 0,
    "osSwVersion": 0,
    "boardVersion": 0,
    "vendorId": 0,
    "productId": 0
  }
```

### Live parameter values (SITL defaults)

| Param | Value | configStatus result |
|-------|-------|-------------------|
| FRAME_CLASS | 1.0 | good (Configured: X) |
| FRAME_TYPE | 0.0 | good |
| INS_ACC_ID | 2753028.0 | good (Calibrated) |
| INS_GYR_ID | 2752772.0 | good (Calibrated) |
| COMPASS_USE | 1.0 | good (Enabled, offset measured) |
| COMPASS_OFS_X | 5.0 | — |
| BARO1_GND_PRESS | 101325.109375 | good (Ground pressure recorded) |
| AHRS_TRIM_X | 0.0 | good (Level) |
| AHRS_TRIM_Y | 0.0 | good |
| RC1_MIN | 1000.0 | good (Endpoints calibrated) |
| RC1_MAX | 2000.0 | good |
| FLTMODE_CH | 5.0 | good (Channel assigned) |
| BATT_MONITOR | 4.0 | good (Monitoring enabled) |
| FS_THR_ENABLE | 1.0 | good (Throttle + Fence protections) |
| FENCE_ENABLE | 1.0 | good |
| FS_GCS_ENABLE | 0.0 | — |
| LOG_BITMASK | 180222.0 | good (Logging enabled) |
| GPS1_TYPE | 1.0 | good (Fix acquired) |
| Sats | 10 | good |
| MOT_PWM_TYPE | 0.0 | good (Outputs supported) |

**All 13 status checks resolve to `good` with these SITL defaults — zero warnings, zero unsupported.**

## Regression Results

| Suite | Before 8A | After 8A |
|-------|-----------|----------|
| Backend pytest | 230 | **236** (+6 setup tests) |
| Frontend vitest | 245 | **291** (+46: 31 setupLogic + 10 SetupConfig + 5 SetupSummary) |
| TypeScript (tsc --noEmit) | clean | clean |
| vite build | ✅ (chunk warning pre-existing) | ✅ (same) |
| oxlint errors | 0 | **0** |
| oxlint warnings | pre-existing only | +1 pre-existing pattern (SetupNav SETUP_NAV constant — same as existing codebase exports) |

## Files Added/Modified

### New files
- `backend/services/setup_service.py` — firmware request + version decode
- `backend/api/setup.py` — GET /api/setup/firmware router
- `backend/tests/test_setup_api.py` — 6 backend tests
- `frontend/src/api/setup.ts` — FirmwareInfo type + getFirmwareInfo()
- `frontend/src/hooks/useFirmwareInfo.ts` — enabled-gated fetch hook
- `frontend/src/components/setup/setupLogic.ts` — 13 pure detection functions + configStatus + summarizeStatus
- `frontend/src/components/setup/setupLogic.test.ts` — 31 unit tests
- `frontend/src/components/setup/SetupConfig.tsx` — shell layout (nav + content switch)
- `frontend/src/components/setup/SetupConfig.test.tsx` — 10 component tests
- `frontend/src/components/setup/SetupNav.tsx` — 15-item left navigation
- `frontend/src/components/setup/SetupSummary.tsx` — vehicle identity + firmware card + config status matrix
- `frontend/src/components/setup/SetupSummary.test.tsx` — 5 component tests
- `frontend/src/components/setup/SetupFirmware.tsx` — dedicated firmware details page
- `frontend/src/components/setup/SetupInactive.tsx` — placeholder for 8B–8H pages
- `frontend/src/components/setup/SetupParameters.tsx` — reuses existing parameter table/store
- `frontend/src/styles/setup.css` — full dark-theme QGC-inspired stylesheet

### Modified files
- `backend/app.py` — registered `setup_api.router` on `/api/setup`
- `frontend/src/pages/SetupPage.tsx` — renders `<SetupConfig />` instead of placeholder

### Not modified (existing reuse, zero duplication)
- `FlightModes.tsx` — rendered under Setup "Flight Modes" nav item
- `ParameterTable.tsx`, `ParameterGroupTree.tsx`, `WriteParamsDialog.tsx`, `parametersLogic.ts` — all reused as-is by SetupParameters
- `ParameterContext.tsx` — store, staged, executeWrite, discardAll — all reused

## Scope Guard (Phase 8 rules observed)

- **No fabricated states:** Gray = unsupported when param absent; never fakes good/bad
- **No Flight Modes duplication:** Reuses existing `FlightModes` component directly
- **No parameter logic duplication:** SetupParameters reuses existing table + store + write pipeline
- **No raw MAVLink in React:** All MAVLink operations in backend services
- **Firmware install/update explicitly unsupported** (UI states this)
- **Sub-phase placeholders** for 8B–8H show "Available in Phase X" — no placeholder functionality
- **ArduCopter only** — no Rover/Plane/PX4 assumptions in any detection logic

---

# Phase 8B — Frame / Airframe Report

**Date:** 2026-09-16  
**Status:** ✅ COMPLETE

## Objective

Build the **Frame / Airframe** configuration page under SETUP for ArduCopter: read the live `FRAME_CLASS` / `FRAME_TYPE` values, expose only the options the **connected firmware's** parameter metadata defines, stage changes through the existing parameter store, apply as a **sequential verified** write, and surface reboot guidance — without introducing any new MAVLink connection or duplicating staging/write logic.

## Design decisions

- **Firmware metadata is authoritative.** `FRAME_CLASS`/`FRAME_TYPE` option lists are decoded from `copter.xml` enum metadata returned by the backend (`GET /api/parameters/{id}/metadata`, `values` + `rebootRequired`). Static fallback lists are used only when metadata is missing entirely. This corrects the Phase 8A warning path, which hardcoded labels that disagreed with the real firmware (e.g. code 4 = `OctaQuad`, 5 = `Y6`, 7 = `Tri`).
- **Stage, don't write.** Changing a selector stages via `store.stageValue` (validated as an enum by `validation.validateStagedValue`); nothing is sent to the vehicle until **Apply Changes**. Revert just discards staged values.
- **Sequential verified writes.** `store.executeWrite()` → `writeBatch` (`POST /api/parameters/write`): FRAME_CLASS first, then FRAME_TYPE; each confirmed by the `PARAM_VALUE` echo; a failure stops the batch (later items `not_attempted`). Partial failures keep the staged value so the user can retry.
- **Reboot = warning only.** If any *written* frame param requires a reboot (metadata), the page shows "Saved. Reboot required." — it never triggers a reboot.
- **Live values are truth.** On connected+ready the Current value always comes from the vehicle (`entries[param].live`), never a local default. Disconnected state shows no stale SITL values, offers a local Revert, and reloads live values on reconnect.

## Implementation

| Component | What was built |
|-----------|---------------|
| **`frameLogic.ts`** | Pure, unit-testable: `frameConfig(entries, staged)` → class/type fields (options from metadata when present, current/pending labels, modified/staged counts, reboot pending), `frameClassLabel`/`frameTypeLabel` decoders, `frameWriteResult(transaction)` reduced to the two frame params |
| **`SetupFrame.tsx`** | Error/lint/type-checked page: disconnected, syncing, and unsupported-firmware states; per-field select rows (Current vs Pending); Apply card with staged count + reboot warning; Revert; remote-change conflict banner with **Acknowledge and apply**; running indicator; post-write result ("Saved. Reboot required." / partial-failure message); result cleared when the user re-stages |
| **`SetupConfig.tsx`** | `frame` nav item now renders `<SetupFrame />` (removed from the 8B placeholder) |
| **`setupLogic.ts`** | `frameStatus` decodes QGC colors from live values; text labels come from the metadata-aware decoders (no hardcoded text choices) |
| **Backend** | No new endpoints — 8B reuses the Phase 2/4/5 `GET /api/parameters/{id}`, `GET /api/parameters/{id}/metadata`, and `POST /api/parameters/write` verified-write pipeline unchanged |

## Safety properties (tested)

- **No write before Apply** — verified in component tests.
- **Invalid enum rejected pre-flight** — server rejects with `INVALID_ENUM` *before* any `PARAM_SET` reaches the vehicle (verified live: value 99 → 400, zero `param_set` calls).
- **First failure stops the batch** — second frame param `not_attempted`, live value kept.
- **Absent params** — firmware without the param still returns its official definition (`live: null` → "not exposed"); truly unknown → `PARAM_NOT_FOUND`.
- **Disconnect** — write API returns `NOT_CONNECTED`; reconnect re-downloads and re-shows live values.

## Tests

### Backend — `tests/test_setup_frame.py` (12 tests)
Read live FRAME_CLASS/FRAME_TYPE + verified `POST /read`; metadata enum decode + rebootRequired; `PARAM_NOT_FOUND` vs definition-without-live handling; pre-flight `INVALID_ENUM` with zero `param_set`; sequential two-param verified write (order FRAME_CLASS → FRAME_TYPE, echo-verified, live cache updated); first-failure stops batch; reconnect reloads changed value; unsupported firmware.

### Frontend — `frameLogic.test.ts` + `SetupFrame.test.tsx` (26 tests)
Metadata option lists, live-as-current, pending staging, reboot detection, fallback behavior, write-result scoping; UI: selectors with live values, no write before Apply, apply+verify both, **revert without writing**, reboot warning, partial-failure message with stop-on-failure, invalid-enum rejection harness, unsupported firmware, disconnected (no stale values + local revert), reconnect reload.

## Live SITL validation (ArduCopter 4.8.0, d16ddbab, QUADROTOR over UDP 14550)

| Step | Result |
|------|--------|
| Current values | FRAME_CLASS=1 (Quad), FRAME_TYPE=0 (Plus) — match vehicle truth |
| Metadata from firmware | FRAME_CLASS 18 options incl. OctaQuad/CoaxCopter; FRAME_TYPE 14 options; both `rebootRequired=True` |
| Stage → Apply 2/1 (Hexa/X) | `status=success`, `succeeded=2`, both `verifiedValue` echo matched; live 2/1 |
| Invalid enum 99 | 400 `INVALID_ENUM`, vehicle unchanged |
| Restore 1/0 | `success`, live back to 1/0 |
| Disconnect | write → `NOT_CONNECTED` |
| Reconnect | full 1379-param re-download, FRAME_CLASS/FRAME_TYPE reload as 1/0 |
| Params after each sync | `receivedCount=1379` (0 missing, 0 retries) |

## Regression

- Backend pytest: **248 passed** (236 → +12)
- Frontend vitest: **317 passed** (291 → +26)
- `tsc --noEmit` (frontend): clean
- `npm run build` (tsc -b + vite): clean (chunk-size warning only, pre-existing)
- oxlint: 0 errors (only the pre-existing `only-export-components` warning matching existing convention)

## Files

### New
- `frontend/src/components/setup/frameLogic.ts` + `frameLogic.test.ts`
- `frontend/src/components/setup/SetupFrame.tsx` + `SetupFrame.test.tsx`
- `backend/tests/test_setup_frame.py`

### Modified
- `frontend/src/components/setup/SetupConfig.tsx` — frame branch → `<SetupFrame />`; nav test updated (Sensors still placeholder)
- `frontend/src/components/setup/setupLogic.ts` — metadata-truthful frame labels
- `frontend/src/styles/setup.css` — frame page styles (match existing QGC theme)
- `docs/PHASE8_SETUP_REPORT.md` — this section

### Not modified (existing reuse)
- `ParameterContext.tsx`, `stagedLogic.ts`, `validation.ts`, `parametersLogic.ts`, `WriteParamsDialog.tsx` — staging/validation/write pipeline reused untouched
- `backend/api/parameters.py`, write transaction manager, parameter metadata provider — all reused, no new MAVLink connection

---

# Phase 8C — Sensors Report

**Date:** 2026-09-23  
**Status:** ✅ COMPLETE

## Objective

Complete the **Sensors** setup page: real sensor-state chips (CALIBRATED / NOT CALIBRATED / NOT SUPPORTED / STATUS UNAVAILABLE) derived *only* on the backend from live ArduPilot parameters, Compass Settings + Flight Controller Orientation written through the shared staged verified-write pipeline, a CompassMot session (capability, motor-test command, live status stream), and timeout/disconnect polish. Then HARD STOP (no 8D–8I).

## Sub-phase Scope (8C)

| Component | What was built |
|-----------|---------------|
| **Derived sensor status** | `get_sensor_status()` now computes a per-sensor `status` (`calibrated` / `not-calibrated` / `unsupported` / `unknown`) for accel, gyro, baro, compass and level from live params: accel/gyro calibrated when a device id is active (gyro also requires `INS_GYR_CAL=1.0`); baro requires `BARO1_DEVID!=0` AND `BARO1_GND_PRESS>0`; compass calibrated when `COMPASS_CAL_FIT>=50` OR offsets are non-zero, unsupported when all `COMPASS_*` params are absent; level calibrated when \|AHRS_TRIM_X\|,\|AHRS_TRIM_Y\| < 0.001. Compass also exposes detected devices, `calFit`, `orientName`; level exposes `trim`; and the response adds a `compassMot` capability field. |
| **Compass Configuration API** | `GET /api/setup/compass/configuration` — connected/enabled/detected/primaryFit/device list (use + orient params) / supported orientations / current AHRS orientation. |
| **CompassMot session** | `GET /api/setup/compassmot/capability` (COMPASS_PMOT_EN supported, COMPASS_MOTCT enabled, active), `POST /api/setup/compassmot/start` (disarmed gate, `MAV_CMD_DO_MOTOR_TEST=209` via ack-bounded command, 8s timeout), `POST /api/setup/compassmot/cancel` (local stop → `compassmot:result`), `GET /api/setup/compassmot/status` (throttle/interference from `MSGID_COMPASSMOT_STATUS=177` via `compassmot:status`). Returns `hardwareRequired: true` — honestly reports that no physical curve is measured. |
| **Timeout phrase mapping** | Gyro/baro/level/compass/CompassMot `TIMEOUT` results now map to the exact `Calibration timed out. No response received from vehicle.` phrase (new `CAL_TIMEOUT_MESSAGE` + `_cal_failure` helper). |
| **Disconnect reset** | Disconnection while calibrating resets accel (status/message reset via ref-tracked effect), and sensor-side state (compassReport/compassConfig/compassMot + gyro/baro/level/compass) with `Pixhawk connection lost.` |
| **Sensors UI** | Sensor status chips (`setup-accel|gyro|baro|level|compass|compassmot-chip`) via `sensorStateLabel`, live compass fitness readout from the `compass_cal:report` stream, compass settings card (COMPASS_ENABLE toggle + per-device Use/Orientation, staged, Apply/Revert, reboot-required note), flight-controller orientation card (AHRS_ORIENTATION metadata select), and a CompassMot card (start/stop, live throttle/interference, unsupported note). All writes go through the shared `ParameterContext` staging/write pipeline — never direct PARAM_SET from React. |
| **CSS** | `.sensor-status-chip` (+ per-state colors), `.compass-fit`, `.compass-status-text`, `.compass-settings-row/toggle/device` — matching the dark QGC theme. |

## Live SITL Validation

- Stack: arducopter (quad) → mavproxy → backend (:5000), connected over `udp:127.0.0.1:14550`, 1379 params synced.
- `compassmot/capability` → `supported: true, enabled: 0.0, active: false` (honest, COMPASS_PMOT_EN present / COMPASS_MOTCT=0).
- `sensors/status` → accel/gyro/baro/level/compass all `calibrated`; level trim `{x:0, y:0}`; compass `detected: 6`, `calFit: 16.0`, `orientName: null`, devices carry `COMPASS_USE`/`COMPASS_ORIENT` param ids (slots 4–6 report `useParam/orientParam: null` — no `COMPASS_USE4…6` params in firmware).
- `compass/configuration` → connected, enabled 1, detected 6, primaryFit 16, orientation supported.
- `compassmot/start` `{motor:0, throttle:30}` → `active: true, hardwareRequired: true, motorInstance: 0`. During the session `compassmot/status` reports `active: true, throttle: 0, interference: 0` (STIL emits no `COMPASSMOT_STATUS`, so values honestly stay zero until cancelled).
- `compassmot/cancel` → `success`, status returns to `active: false`.
- Arming gate could not be exercised live (backend arm requires an uploaded mission in this build) — the disarmed gate is covered by backend unit tests.

## Regression

- Backend pytest: **399 passed** (364 → +35)
- Frontend vitest: **337 passed** (328 → +19; includes wrapping SetupSensors tests in `ParameterProvider` + new parameter API mocks)
- `tsc --noEmit` (frontend): clean
- `npm run build` (tsc -b + vite): clean (chunk-size warning only, pre-existing)
- oxlint: 0 errors (only pre-existing warnings)

## Files

### New
- `backend/tests/test_compassmot_service.py` (27 tests — capability, start via MAV_CMD_DO_MOTOR_TEST with kwargs `param1/2/3`, timeout mapping, cancel, reset)
- `backend/tests/test_compassmot_api.py` (8 tests — endpoint wiring; bodyless POSTs need `json={}`)

### Modified
- `backend/services/calibration_service.py` — `MAV_CMD_DO_MOTOR_TEST`, `MSGID_COMPASSMOT_STATUS`, `CAL_TIMEOUT_MESSAGE`, `_cal_failure`, derived sensor statuses, `get_compass_configuration()`, CompassMot session + `reset_cmot_session()` (wired into `reset_session()`)
- `backend/api/setup.py` — `/compass/configuration`, `/compassmot/capability|start|cancel|status`
- `frontend/src/api/setup.ts` — `SensorCalState`, `SensorState`, `CompassMotState`, `CompassConfiguration`, `DetectedDevice`, `getCompassConfiguration`, `getCompassMotCapability`, `startCompassMot`, `cancelCompassMot`, `getCompassMotStatus`
- `frontend/src/hooks/useSensorCalibration.ts` — compassReport/compassConfig/compassMot state, `compass_cal:report`/`compassmot:status`/`compassmot:result` subscriptions, disconnect resets
- `frontend/src/hooks/useAccelCalibration.ts` — disconnect reset (`Calibration stopped: vehicle connection lost.`)
- `frontend/src/components/setup/SetupSensors.tsx` — chips, compass fitness, CompassMot card, Compass Settings + Flight Controller Orientation cards
- `frontend/src/components/setup/setupSensorFormat.ts` — `sensorStateLabel()`
- `frontend/src/components/setup/SetupSensors.test.tsx` / `SetupConfig.test.tsx` — parameter-provider wrapping + new feature tests
- `frontend/src/styles/setup.css` — chip + settings/orientation/compassmot styles

### Not modified (existing reuse)
- `ParameterContext.tsx`, `stagedLogic.ts`, `validation.ts`, `WriteParamsDialog.tsx` — compass settings/orientation reuse the existing staged verified-write pipeline untouched

---

# Phase 8C-CONNECTION-LOSS-FIX — Heartbeat-Loss Disconnect Report

**Date:** 2026-09-23  
**Status:** ✅ COMPLETE (live-validated)

## Objective

Real MAVLink heartbeat-based disconnect detection. On a heartbeat timeout the
vehicle now flips to a fully-consistent DISCONNECTED state everywhere: the
parameter session detaches (REST/socket writes rejected, Parameters page goes
DISCONNECTED), calibration wizards stop safely, stale telemetry (battery /
GPS / latitude) is zeroed so it is never presented as current, and a new
authoritative `connection_state` Socket.IO event drives the whole UI. When
heartbeats resume the link auto-reconnects **without a browser refresh** —
the parameter session re-binds, the parameter set auto-downloads again, and
`connection_state {CONNECTED, reason: reconnected}` is emitted.

## Root cause

The existing watchdog (`_watchdog_loop`) already flipped `vehicle_state["connected"]`
to `False` on a heartbeat timeout, but it did **not** stop the parameter session
(writes stayed enabled and the Parameters page stayed "online"), did **not** reset
calibration wizards (a CompassMot/gyro/level session could sit spinning inside a
dead link), and did **not** clear stale telemetry (battery/GPS numbers stayed on
screen as if live — the bug the user reported).

## Design

- **Soft disconnect without closing transport.** `_mark_connection_lost(reason)`
  flips `vehicle_state` (connected/connectionState/disconnectReason/mode/armed +
  gpsFix/satellites), calls `parameter_manager.stop_session(reason)` (pages +
  REST reject writes), `calibration_service.reset_session()` (accel/mag/compassmot
  safe-stop), `reset_telemetry()` + `tm.reset_home_position()` (full numeric
  zeroing), then emits `connection_state {DISCONNECTED, reason}` +
  `telemetry:update` (zeroed) + `vehicleStatus`. The transport stays open so a
  resumed heartbeat auto-reconnects (UDP/TCP). Serial replug still needs a
  reconnect click (the device layer cannot self-reopen).
- **Reconnect.** `_on_heartbeat()` detects the resume via a new `_was_lost`
  flag, re-binds the parameter session and re-runs the auto-download, then emits
  `connection_state {CONNECTED, reason: reconnected}`.
- **Reasons everywhere.** `disconnectReason` is added to `vehicle_state`,
  `GET /api/vehicle/status`, and the `vehicleStatus` socket payload. Reasons:
  `heartbeat_timeout` (watchdog), `Transport lost — device unplugged or link
  reset` (reader thread exit), `Connection closed` (explicit), and
  `connection timeout — no HEARTBEAT received` (connect failure). USB removal is
  never claimed unless the transport actually reports it.
- **Frontend defense-in-depth.** `TelemetryProvider` subscribes to the new
  `connection_state` event and ALSO drops all stale numeric gauges when a
  `vehicleStatus` arrives with `connected:false` (in case an event is missed).
  A `disconnectReason` field rides along on the telemetry data.
- **Status-bar indicator.** `TopNavbar` shows a pulsing red **"MAVLink
  connection lost"** label while disconnected; the heartbeat indicator tooltip
  carries the reason. All existing pages (Summary / Firmware / Sensors / Frame /
  Modes / Parameters) already gate on `telemetry.connected`, so the single source
  of truth — `connection_state` → `telemetry.connected=false` → zeroed gauges —
  makes every page consistent with no per-page rewiring.

## Live validation (SITL arducopter → mavproxy → backend, `udp:127.0.0.1:14550`)

| Step | Observed |
|------|----------|
| Connect | `connection_state CONNECTING` → `CONNECTED`; status `connected:true`, gps 6, sats 10, mode STABILIZE |
| Kill MAVProxy (heartbeats silent) | after ~10 s watchdog → `connection_state {DISCONNECTED, reason: heartbeat_timeout}`; `telemetry:update` **zeroed** (bat 0 / gps 0 / sats 0 / lat 0); `vehicleStatus connected:false reason:heartbeat_timeout`; `/api/vehicle/status` → `connected:false, mode DISCONNECTED, gpsFix:0, satellites:0` |
| Param write while disconnected | `POST /api/parameters/…/write` → `400 NOT_CONNECTED`; `GET /api/parameters/status` → `connection: DISCONNECTED` |
| Restart MAVProxy (heartbeats resume, no reconnect click) | `connection_state {CONNECTED, reason: reconnected}`; status `connected:true, mode STABILIZE, gps 6, sats 10`; param set re-downloaded (READY, 1379 params) |
| Param write after reconnect | `CIRCLE_RADIUS_M` 10.0 → 11.0 → 10.0 — all `200 success` |

## Regression

- Backend pytest: **410 passed** (399 → +11 new in `tests/test_connection_loss.py`)
- Frontend vitest: **346 passed** (337 → +9 new: 7 `TelemetryProvider.test.tsx` +
  2 `TopNavbar.test.tsx`)
- `tsc --noEmit`: clean · `npm run build`: clean (pre-existing chunk warning) ·
  oxlint: 0 errors (pre-existing warnings only)

## Files

### Modified
- `backend/mavlink/connection_manager.py` — `_mark_connection_lost`, `_check_watchdog`
  (testable extraction of `_watchdog_loop`), `_was_lost` reconnect path in
  `_on_heartbeat`, `connection_state` emits, `disconnectReason` in `_teardown`,
  CONNECTING emits in `_start`/`vehicle_service`, gps/sats zeroing on loss.
- `backend/core/state.py` — `vehicle_state["disconnectReason"]` default;
  `get_vehicle_status()` exposes it.
- `backend/sio/server.py` — `vehicleStatus` carries `disconnectReason`;
  new `broadcast_connection_state()` helper emitting `connection_state`.
- `backend/services/vehicle_service.py` — CONNECTING/DISCONNECTED
  `connection_state` emits; `disconnectReason` on connect failure.
- `frontend/src/providers/TelemetryProvider.tsx` — `connection_state`
  subscription; `disconnectedSnapshot()` zeroes stale gauges on
  DISCONNECTED/`connected:false`; `connectionState`/`disconnectReason` fields.
- `frontend/src/layout/TopNavbar.tsx` + `styles/navbar.css` — red pulsing
  "MAVLink connection lost" label + reason-bearing heartbeat tooltip.

### New
- `backend/tests/test_connection_loss.py` (11 tests) — watchdog timeout →
  fully-disconnected, zeroed telemetry, session detach, calibration reset,
  fresh/noop + not-running guards, auto-reconnect session re-bind, first-heartbeat
  CONNECTED, full watchdog→reconnect round-trip, teardown reason(s), REST write
  rejection after loss.
- `frontend/src/providers/TelemetryProvider.test.tsx` (7) +
  `frontend/src/layout/TopNavbar.test.tsx` (2).

## Scope guard

No transport rewrite, no new connection layer, no per-page rewiring of the setup
pages (they already gate on `telemetry.connected`), no USB-removal guesses. The
watchdog deliberately keeps the transport open for UDP/TCP auto-reconnect.
