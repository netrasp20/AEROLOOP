# Phase 8H — Motors / Servo Outputs / ESC

## Scope

Phase 8H activates only Setup → Motors, Servo Outputs and ESC for ArduPilot ArduCopter. The pages are read-only: there are no motor-test, servo-movement, ESC-calibration, output-write, arm or actuator-command controls. Gimbal, Logging and Scripting remain inactive for Phase 8I or later.

## Architecture

- `services/motor_setup_service.py` builds all three capability-driven snapshots from the existing live parameter cache and official Copter metadata.
- `GET /api/setup/motors`, `/api/setup/servo-outputs` and `/api/setup/esc` are the only new Setup routes; all are GET-only.
- Outputs are discovered only from live `SERVO1_` through `SERVO32_` parameters. Metadata never creates an output that the firmware did not expose.
- `SERVOx_FUNCTION` labels come from metadata and always retain the raw numeric ID. Unknown IDs remain unnamed.
- Min, trim, max and reversed values come only from live `SERVOx_MIN`, `SERVOx_TRIM`, `SERVOx_MAX` and `SERVOx_REVERSED` parameters.
- Existing parameter-write infrastructure is not used by Phase 8H.

## Live Telemetry

- Added read-only handlers for `SERVO_OUTPUT_RAW` and ArduPilot `ESC_TELEMETRY_1_TO_4`, `5_TO_8`, and `9_TO_12`.
- Dedicated `servo-output:update` and `esc-telemetry:update` events use locally observed receipt times and a 3-second stale threshold.
- MAVLink sentinel/unavailable values become `null`; they are never replaced by defaults.
- Disconnect resets both stores and emits empty snapshots so old PWM/RPM/current/voltage/temperature cannot remain live.
- Status is `Unavailable` because the telemetry packets used here provide no authoritative health/status field.

## UI

- Motors lists the actual motor-assigned outputs, decoded function, raw ID, source parameter and armed/disarmed information.
- Servo Outputs lists every actual output, function ID, actual limits/reversal, and live PWM freshness where available.
- ESC lists only actual reported telemetry and present ESC-related configuration parameters (`MOT_PWM_TYPE`, `MOT_PWM_FREQ`, `RC_SPEED` where live).
- Every page implements WAITING, CONNECTING, SYNCING, READY, UNSUPPORTED, CONNECTION_LOST and ERROR.
- Explicit warnings state that motor testing, physical servo testing, ESC calibration and actuator commands are disabled.

## Validation

### Automated

- Backend Phase 8H: **43 passed**.
- Backend full regression: **583 passed** (101 pre-existing async emit warnings).
- Frontend Phase 8H: **36 passed**.
- Frontend full regression: **499 passed** across 34 files.
- TypeScript and production build: `npm run build` **PASS** (`tsc -b && vite build`).
- Lint: **PASS**, 0 errors and 10 pre-existing warnings.

### ArduCopter SITL

- UDP connection, disarmed, 1379/1379 parameters synchronized.
- Four motor functions read from `SERVO1_FUNCTION` through `SERVO4_FUNCTION` (IDs 33–36).
- Sixteen actual output configurations rendered; live PWM received on outputs 1–4.
- Four real `ESC_TELEMETRY_1_TO_4` records received. RPM was genuinely `0`; voltage/current/temperature/consumption were shown as reported; status remained unavailable.
- Disconnect cleared all three snapshots. Reconnect restored parameter synchronization, 4 motors, 16 output rows and 4 ESC records without a browser refresh.
- No parameter write or actuator command was sent.

### Real Pixhawk (read-only)

- Serial connection, ArduPilot QUADROTOR, STABILIZE, disarmed, 991/991 parameters synchronized.
- Four motor assignments read: IDs 33–36 on outputs 1–4.
- Sixteen output configurations read; outputs 1–4 reported live PWM 1000. No movement or test was requested.
- `MOT_PWM_TYPE=0` decoded as Normal; `RC_SPEED=490 Hz` read from the vehicle.
- No ESC telemetry frames were available; the UI reports ESC telemetry unavailable rather than fabricating values.
- No parameter write, arm, motor test, servo command, relay command, calibration sequence or physical actuator operation occurred.

## Command Audit

Phase 8H introduces no `MAV_CMD_DO_MOTOR_TEST`, `MAV_CMD_DO_SET_SERVO`, `MAV_CMD_DO_SET_RELAY`, parameter write or actuator-control call. The repository still contains the pre-existing CompassMot `MAV_CMD_DO_MOTOR_TEST` implementation from the Sensors phase; it is unchanged and is not referenced or exposed by any Phase 8H page/route.

## Evidence

- `docs/evidence/phase8h-outputs-sitl.json`
- `docs/evidence/phase8h-outputs-pixhawk-readonly.json`
- `docs/evidence/phase8h-motors-sitl.png` — verified YantraYug Motors page, connected ArduCopter SITL, Motor1–Motor4 / IDs 33–36, testing disabled.
- `docs/evidence/phase8h-servo-outputs-sitl.png` — verified YantraYug Servo Outputs page, 16 real configurations, live PWM only where reported, testing disabled.
- `docs/evidence/phase8h-motors-pixhawk-readonly.png` — verified YantraYug Motors page for the read-only Pixhawk validation.
- `docs/evidence/phase8h-servo-outputs-pixhawk-readonly.png` — verified YantraYug Servo Outputs page for the read-only Pixhawk validation.
- `docs/evidence/phase8h-esc-pixhawk-readonly.png` — verified YantraYug ESC page: zero telemetry reported honestly, actual configuration shown, calibration/commands disabled.
- **Missing:** `docs/evidence/phase8h-esc-sitl.png`. No valid SITL ESC browser screenshot was present; no substitute was fabricated.

## Known Limitations

- ArduCopter only.
- ESC telemetry is capability-driven and may be absent on physical hardware.
- `SERVO_OUTPUT_RAW` supports up to the fields genuinely present in each received frame; unavailable outputs remain unavailable.
- Physical actuator testing and ESC calibration are intentionally absent.
- Five of six required screenshots are captured and visually verified. The SITL ESC screenshot remains outstanding.

## Safety Disclosure

**Real Pixhawk validation was read-only. No motors, servos, or ESCs were physically commanded by YantraYug during Phase 8H validation.**
