# Sensor Live Functionality Report

## Scope

This phase audits the Sensors page for ArduCopter/Pixhawk live-state behavior.
The UI is not being redesigned.

## State Sources

- Vehicle identity comes from the connection manager and live vehicle state.
- Sensor capability and device identity come from synchronized `PARAM_VALUE`
  data in `parameter_manager`.
- Compass calibration progress/results come from `MAG_CAL_PROGRESS` and
  `MAG_CAL_REPORT` through `calibration_service` and Socket.IO.
- Accelerometer calibration positions/results come from the vehicle's
  `MAV_CMD_ACCELCAL_VEHICLE_POS` messages.
- Gyro, barometer, level, and compass commands use the existing
  `MAV_CMD_PREFLIGHT_CALIBRATION` and magnetometer command paths.
- Parameter writes use the existing verified parameter transaction pipeline.

## Hardcoded-Data Audit

Device presence is no longer reported as accelerometer/gyro calibration.
Level trim values are no longer treated as proof of level calibration.
Those states are `UNKNOWN` unless ArduPilot exposes an authoritative result.
Compass device enumeration remains dynamic from `COMPASS_DEV_ID*` values.

## Verification

- Sensor frontend tests: 29 passed.
- Dedicated backend sensor/calibration tests: pending full rerun after the
  authoritative-state expectation updates.
- Physical Pixhawk calibration: NOT VERIFIED; no calibration commands were
  issued to hardware.
- SITL validation: NOT VERIFIED in this environment.

## Known Limitations

ArduPilot does not expose a universal persisted calibration flag for every
sensor family through the parameters currently available to this project.
The implementation therefore reports `UNKNOWN` rather than inferring success.
