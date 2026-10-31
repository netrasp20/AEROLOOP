# Summary Live Data Integration Report

## Scope

The approved Summary UI was preserved. No Summary CSS, layout, spacing,
typography, colors, navigation, or backend connection behavior was changed.

## Current Architecture

The Summary combines the existing `/api/setup/summary` configuration response,
the shared frontend telemetry state fed by `telemetry:update`, and the existing
firmware endpoint. `useSetupSummary` clears its response when disconnected and
refreshes on parameter synchronization and configuration events.

## Live Data Mapping

| Summary Field | Backend Source | MAVLink/Parameter | Live Tested |
|---|---|---|---|
| System/component ID | shared telemetry state | HEARTBEAT identity | Existing telemetry tests |
| Vehicle/autopilot | shared telemetry state | HEARTBEAT identity | Existing telemetry tests |
| Mode/armed state | shared telemetry state | HEARTBEAT | Existing telemetry tests |
| Airframe | setup summary service | `FRAME_CLASS`, `FRAME_TYPE` | Backend summary tests |
| Firmware | existing firmware hook/API | `AUTOPILOT_VERSION` | Existing firmware tests |
| Radio status/RC calibration | setup summary service | `RC1_MIN`, `RC1_MAX`, `RC1_TRIM` | Backend summary tests |
| Radio signal/channels | shared telemetry state | `RC_CHANNELS` | Existing radio tests |
| Sensors | calibration service via summary service | sensor calibration/readback parameters | Backend summary tests |
| Flight mode switch | setup summary service | `FLTMODE_CH` | Backend summary tests |
| Flight Mode 1-6 | setup summary service | `FLTMODE1` through `FLTMODE6`, ArduCopter mode map | Backend summary tests |
| Battery/GPS | shared telemetry state and summary status | battery/GPS telemetry | Existing telemetry tests |
| Power status | setup summary service | `BATT_MONITOR` | Backend summary tests |
| Safety | setup summary service | failsafe and fence parameters | Backend summary tests |
| Camera capability | setup summary service | `CAM1_TYPE`, `CAM2_TYPE` | Parameter-derived |
| Scripting capability | setup summary service | `SCR_ENABLE` | Parameter-derived |
| Gimbal/ESC/logging | setup summary service | existing capability parameters | Backend summary tests |
| Parameter sync | setup summary service | live parameter manager state | Backend summary tests |

## Changes

- Added live ArduCopter Flight Mode 1-6 values to the existing Summary response.
- Reused the existing backend ArduCopter mode map.
- Added parameter-derived Camera and Scripting capability values.
- Replaced the frontend Flight Mode placeholder text with the response values.
- Removed the frontend Camera literal and missing-item Scripting fallback.
- Added corresponding response types in the existing frontend API contract.

## Disconnect and Reconnect

The existing connection path remains authoritative. When telemetry disconnects,
the Summary renders its existing disconnected state and `useSetupSummary`
clears configuration data. On reconnect, the existing hook fetches a fresh
Summary response and firmware is re-queried through the existing connection
state dependency.

## Verification

- Backend Summary tests: `33 passed`
- Focused frontend Summary tests: `8 passed`
- Frontend production build and TypeScript: passed

Full backend/frontend regression and physical Pixhawk/SITL validation remain
dependent on the available runtime and vehicle sessions. No write, arming,
calibration, actuator, or flight command was issued by this integration work.

## Limitations

The Summary still intentionally uses the existing shared telemetry state for
high-rate live telemetry rather than duplicating it in the Summary endpoint.
The existing detailed Setup pages remain the authoritative source for richer
Radio, Power, Safety, Sensor, ESC, Gimbal, and Logging detail.
