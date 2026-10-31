# Sensors QGC-Style Report

## Scope

Only `SETUP -> Sensors` was changed. Existing ArduPilot calibration services,
MAVLink commands, parameter writes, and connection lifecycle were reused.

## UI Changes

- Replaced the vertically stacked sensor presentation with a compact sensor
  list and focused workspace layout.
- Added live status indicators for Compass, Gyroscope, Accelerometer, Level,
  Barometer, CompassMot, and Sensor Settings.
- Added selected sensor highlighting and workspace switching.
- Reduced the vehicle identity area to a compact status presentation.
- Existing calibration cards remain the focused workspace content, so their
  real controls and test IDs remain intact.
- Added responsive behavior for narrow screens.
- Expanded the Sensors root to the available content width, widened the sensor
  list, made the workspace flexible, and removed the redundant large Vehicle
  card from the visible layout.
- Changed the sensor workspace to a responsive two-column grid: the four
  compact sensor cards share rows, while compass/settings and active
  calibration workflows span the full workspace.

## Real ArduPilot Behavior Reused

| Workflow | Existing backend behavior |
|---|---|
| Accelerometer | `MAV_CMD_PREFLIGHT_CALIBRATION` and `MAV_CMD_ACCELCAL_VEHICLE_POS`; live position/result Socket.IO events |
| Gyroscope | `MAV_CMD_PREFLIGHT_CALIBRATION` gyro field and real ACK/result |
| Barometer | `MAV_CMD_PREFLIGHT_CALIBRATION` barometer field and real result |
| Level horizon | `MAV_CMD_PREFLIGHT_CALIBRATION` level field and real result |
| Compass | `MAV_CMD_DO_START_MAG_CAL`, `MAV_CMD_DO_ACCEPT_MAG_CAL`, `MAV_CMD_DO_CANCEL_MAG_CAL`, `MAG_CAL_PROGRESS`, and `MAG_CAL_REPORT` |
| CompassMot | Existing hardware capability, status, start/cancel behavior |
| Sensor settings | Existing metadata-backed ParameterContext staging and verified writes |
| Disconnect/reconnect | Existing calibration-session reset, state clearing, and fresh refetch |

No PX4 calibration protocol was introduced. No fake progress, sensor count,
calibration result, or completion state was added.

## Live Data Sources

- Sensor state: `/api/setup/sensors/status` through existing hooks.
- Calibration state: existing REST actions and Socket.IO calibration events.
- Orientation/settings: existing parameter cache and metadata-backed controls.
- Connection and identity: shared telemetry/connection state.

## References

- QGroundControl Sensors: https://docs.qgroundcontrol.com/master/en/qgc-user-guide/setup_view/sensors.html
- QGroundControl PX4 UX reference: https://docs.qgroundcontrol.com/Stable_V4.3/en/qgc-user-guide/setup_view/sensors_px4.html
- QGroundControl ArduPilot: https://docs.qgroundcontrol.com/master/en/qgc-user-guide/setup_view/sensors_ardupilot.html
- ArduPilot MAVLink calibration: https://shop.ardupilot.org/dev/docs/mavlink-calibration.html
- ArduPilot accelerometer: https://www.ardupilot.ardupilot.org/copter/docs/common-accelerometer-calibration.html
- ArduPilot compass: https://shop.ardupilot.org/copter/docs/common-compass-calibration-in-mission-planner.html

## Verification

- Sensors frontend tests: `29 passed`
- Sensors layout refinement tests: `29 passed`
- Backend full suite baseline: `643 passed`
- Full frontend suite: `538 passed`
- TypeScript and production build: passed
- ESLint: passed with existing warnings

Physical sensor calibration was not initiated during this UI phase. The
existing read-only Pixhawk sensor/state paths remain the safety boundary.
