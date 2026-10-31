# Radio QGC Parity Report

## Implemented

- Compact `Radio Setup` header and live connection/signal strip.
- QGC-inspired Attitude Controls rows for Roll, Pitch, Yaw, and Throttle.
- Live `RCMAP_*` channel mapping and live `RC_CHANNELS` bars.
- Right-side transmitter visualization driven by mapped live channels.
- Mode 1/Mode 2 visualization toggle that does not write vehicle parameters.
- Dynamic Channel Monitor using the channels reported by the vehicle.
- Existing backend-authoritative radio calibration workflow retained.
- Existing verified RC parameter write pipeline retained.
- Additional Radio Setup section explicitly marks unsupported Spectrum Bind and
  Copy Trims operations instead of exposing inactive controls.
- Tightened the main rows and right-side utility panels for QGC-like vertical
  density, and moved detailed RC endpoint editing under a collapsed
  `Advanced RC Channel Configuration` disclosure.
- Added a compact visible Additional Radio Setup block with dynamic-looking
  capability controls disabled as `Unsupported` until real backend support is
  available; no inactive actions are presented as functional.
- Rebuilt the Radio presentation hierarchy into flat main/side workspace
  sections instead of dashboard cards. Main order is Attitude, Calibration,
  Additional Setup, and Advanced Configuration; the side workspace contains
  Transmitter followed by Channel Monitor.

## Live Data Sources

- `RC_CHANNELS` telemetry for current channel values and signal freshness.
- `RCMAP_ROLL`, `RCMAP_PITCH`, `RCMAP_THROTTLE`, and `RCMAP_YAW` for mapping.
- `RCx_MIN`, `RCx_TRIM`, `RCx_MAX`, and `RCx_REVERSED` for channel ranges.
- Existing Socket.IO radio calibration progress events.

## Verification

- Backend Radio tests: 35 passed.
- Frontend Radio tests: 28 passed.
- Full frontend suite: 538 passed.
- SITL validation: NOT VERIFIED in this environment.
- Physical Pixhawk read-only validation: NOT VERIFIED.

## Limitations

No Spectrum Bind or Copy Trims backend operation is currently exposed, so both
are reported unsupported. Missing RC range parameters produce an honest range
unavailable state rather than universal PWM defaults.
