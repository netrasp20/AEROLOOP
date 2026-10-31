# Phase 8C — Hardware Sensor Calibration Report

**Date:** 2026-09-22
**Status:** ✅ COMPLETE (live-validated on Pixhawk)

## Objective

Deliver **real MAVLink sensor calibration** for a connected ArduCopter in the
YantraYug GCS, matching the beat of the vehicle (no fake progress, no placebo
toggles): a **6-position accelerometer wizard** (Phase 8C) plus one-shot
**gyroscope, barometer, level-horizon, and compass calibrations**, all driven by
real `MAV_CMD_PREFLIGHT_CALIBRATION` / `MAV_CMD_DO_*_MAG_CAL` commands with
`COMMAND_ACK` handling, live `MAG_CAL_PROGRESS`/`MAG_CAL_REPORT` decoding, real
parameter readback after calibration, hardened disconnect/armed/unsupported
handling, and a QGC-style sensor page. ArduCopter only; SITL and hardware both
supported.

## Calibrations

| Sensor | MAVLink command | Flow |
|--------|-----------------|------|
| **Accelerometer** | `MAV_CMD_PREFLIGHT_CALIBRATION` (241) param5 = `ACCELEROMETER_FULL` (1) | Interactive 6-position wizard. ArduPilot streams `MAV_CMD_ACCELCAL_VEHICLE_POS` (42429) requests (1=LEVEL … 6=BACK); GCS confirms each sampled orientation; terminal `16777215`=success / `16777216`=failed. |
| **Gyroscope** | 241 param1 = 1 | One-shot. Waits through intermediate `IN_PROGRESS` (code 5) acks for the terminal result. |
| **Barometer** | 241 param3 = 1 | One-shot ground-pressure calibration, same ack handling. |
| **Level Horizon** | 241 param5 = `BOARD_LEVEL` (2) | One-shot board-level calibration. ArduPilot returns `TEMPORARY_REJECTED` when the vehicle is not level enough — surfaced with actionable guidance. |
| **Compass** | `MAV_CMD_DO_START_MAG_CAL` (42424) / `DO_ACCEPT_MAG_CAL` (42425) / `DO_CANCEL_MAG_CAL` (42426), `mask` param (0 = all) | Real-time `MAG_CAL_PROGRESS` (191) → `compass_cal:progress` socket events; `MAG_CAL_REPORT` (192) terminal states (success/failed/bad-orientation/bad-radius) → `compass_cal:report` + `compass_cal:result`; accept saves. |

## Design decisions

- **Real commands only.** Every calibration sends an actual MAVLink command and
  resolves on the vehicle's `COMMAND_ACK`; the UI never fabricates completion.
- **`_wait_ack_terminal()`** tolerates `IN_PROGRESS` (code 5) acks that ArduPilot
  emits for long-running calibrations and waits for the terminal ack, returning
  `ackCode`/`ackLabel` plus `interimAcks` on timeout.
- **`PARAM_VALUE` readback is truth.** `GET /api/setup/sensors/status` reads the
  cached live entries for `INS_ACC_ID`, `INS_GYR_ID`, `BARO_PRIMARY`,
  `COMPASS_DEV_ID`, `COMPASS_USE`, `COMPASS_ORIENT`, `COMPASS_OFS_*`, and — for
  current ArduPilot firmware — `INS_ACCOFFS_*` (the ArduCopter 4.7 real accel
  offset params; classic `INS_ACC_OFFSET_*` also recognized for other firmware).
  Missing params are reported `supported: false` — never fabricated.
- **Shared guards.** `_require_ready()` rejects with "Vehicle is not connected."
  when the link is down and "Calibration requires the vehicle to be disarmed."
  when armed. The service **never auto-disarms**.
- **Connection lifecycle.** `reset_session()` clears both the accel wizard and
  the compass session on transport teardown; the frontend watches `connected`
  and, on a drop during calibration, sets a `connectionLost` state requiring an
  explicit restart — no stale wizard can leak across links.
- **Mode tagging.** Log lines carry `[HARDWARE]` for serial links, `[SITL]`
  otherwise.

## API (all under `/api/setup`)

- `POST /accel-cal/start` · `POST /accel-cal/confirm` · `POST /accel-cal/cancel` · `GET /accel-cal/status`
- `POST /gyro-cal` · `POST /baro-cal` · `POST /level-cal`
- `POST /compass-cal/start` · `POST /compass-cal/accept` · `POST /compass-cal/cancel`
- `GET /compass-cal/status` · `GET /sensors/status`

## Frontend

- `api/setup.ts` — generic `postJson`/`getJson`, sensor-calibration client and
  types (`SensorStatus`, `CompassCalStatus`, …).
- `hooks/useSensorCalibration.ts` — gyro/baro/level/compass state machine,
  socket subscription to `compass_cal:progress`/`compass_cal:result`,
  connection-loss detection, busy-key serialization.
- `components/setup/SetupSensors.tsx` — QGC-style cards: vehicle identity tile
  + one card per sensor (Accel wizard with Confirm Orientation; Gyro/Baro/Level
  one-shot; Compass with live progress bar + Accept/Cancel). Dispatches through
  `formatCompassStatus` for human-readable compass state.
- `components/setup/setupSensorFormat.ts` + unit tests; CSS in
  `src/styles/setup.css` (`.sensor-card`, `.compass-progress*`, `.accel-readout*`).

## Tests

- Backend: `tests/test_sensor_calibration_service.py` (24) +
  `tests/test_sensor_calibration_api.py` (13). Full backend suite **326 passed**.
- Frontend: `SetupSensors.test.tsx` (26), `setupSensorFormat.test.ts` (3), plus
  updated `SetupConfig.test.tsx`. Full frontend suite **351 passed** (26 files).
- `tsc -b` clean; oxlint 0 errors (pre-existing warnings only).

## Live validation (Pixhawk1 `/dev/ttyACM0`, ArduCopter 4.7.0, 991 params)

| Step | Result |
|------|--------|
| Reconnect after backend restart | `POST /api/vehicle/connect` → HEARTBEAT received; QUADROTOR / ARDUPILOTMEGA confirmed |
| Param download | 991/991 received, 0 missing, 0 retries |
| `GET /api/setup/sensors/status` | Real values: `INS_ACC_ID=1246218`, `INS_GYR_ID=2163722`, `COMPASS_OFS_X=-37.72/-…Y=104.93/-…Z=-35.78`, `INS_ACCOFFS_X=0.1457/-Y=-0.0544/-Z=-0.1621`; `COMPASS_USE=1`; `BARO_PRIMARY=0`; `INS_ACC_OFFSET_*` correctly reported unsupported (absent on this firmware) |
| `POST /api/setup/gyro-cal` | `{"success":true,"message":"Gyro calibration completed."}` — `ACK result=0` in logs with `[HARDWARE]` tag |
| `POST /api/setup/baro-cal` | `{"success":true,"message":"Barometer calibration completed."}` — `ACK result=0` |
| `POST /api/setup/level-cal` | Correctly rejected: `TEMPORARY_REJECTED` (vehicle not level) → HTTP 400 with "Place the vehicle exactly level and retry." — expected ArduPilot behavior surfaced clearly |
| `POST /api/setup/compass-cal/start` | `{"success":true,"message":"Compass calibration started. Rotate the vehicle slowly.","mask":0}` |
| Real progress stream | Live `MAG_CAL_PROGRESS` decoded → `compass_cal:progress` events (`status=running-step-one`, 0% while static) |
| `POST /api/setup/compass-cal/cancel` | `{"success":true,"message":"Compass calibration cancelled."}` + `compass_cal:result {result:"cancelled"}`; status back to idle |
| Arming/connection guards | Covered by unit tests (disarmed requirement, not-connected rejection, reset-on-teardown) |

> Full compass accept requires physically rotating the vehicle to reach the
> required fitness, then `POST /api/setup/compass-cal/accept`; the decode path
> for `MAG_CAL_REPORT` success/failure is unit tested.

## Success criteria acceptance checklist

- [x] Real fleet-wide calibration commands reach the vehicle (verified live).
- [x] Gyro/baro one-shot complete on real ACK (result=0), no fake success.
- [x] Level horizon uses board-level command with sensible level rejection text.
- [x] Compass start/progress/cancel round-trip verified live; report decode tested.
- [x] 6-position accel wizard intact and tested (start/confirm/cancel/status).
- [x] Sensor status reads real `PARAM_VALUE`s; absent params → supported:false.
- [x] Disarmed enforcement and not-connected rejection at API level.
- [x] Disconnect resets calibration sessions; frontend requires explicit restart.
- [x] Backend 326 tests pass; frontend 351 tests pass; tsc/oxlint clean.
- [x] No fabricated progress, no placebo buttons, no auto-disarm anywhere.

## Files

- `backend/services/calibration_service.py` — gyro/baro/level/compass + status; accel wizard intact.
- `backend/api/setup.py` — new endpoints.
- `backend/tests/test_sensor_calibration_service.py`, `test_sensor_calibration_api.py`.
- `frontend/src/api/setup.ts` — generic postJson/getJson + sensor-cal client.
- `frontend/src/hooks/useSensorCalibration.ts` — new hook.
- `frontend/src/components/setup/SetupSensors.tsx`, `setupSensorFormat.ts`(+test).
- `frontend/src/components/setup/SetupSensors.test.tsx`, `SetupConfig.test.tsx`.
- `frontend/src/styles/setup.css` — sensor card / compass progress styles.

## Scope guard

ArduCopter-only; no Rover/Plane/PX4 assumptions. No new MAVLink connection
layer (reuses `packet_bus`, `command_service`, `parameter_manager`). No raw
MAVLink in React. `INS_ACCOFFS_*` support is a data-layering fix for real
ArduCopter 4.7 params, not scope creep.