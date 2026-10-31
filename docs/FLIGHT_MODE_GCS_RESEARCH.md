# Flight Mode Setup — Research, Audit & Implementation Record

**Component:** YantraYug GCS → Setup → Flight Modes
**Scope:** ArduCopter only. PX4/ArduPlane/Rover/ArduSub out of scope.
**Status:** Research complete → implementation complete → verified (read-only)

## 1. Executive summary
ArduCopter has exactly one flight-mode channel (FLTMODE_CH) and exactly six switch positions (FLTMODE1..FLTMODE6). RC channel number ≠ flight mode position.

## 2. Verified ArduCopter semantics
- FLTMODE_CH (ArduCopter/Parameters.cpp): values 0 (Disabled), 5..15. 1-4 reserved (roll/pitch/throttle/yaw), 16 rejected (NUM_RC_CHANNELS==16). Default 5.
- FLTMODE1..FLTMODE6 (ArduCopter/Parameters.cpp): 6 positions in GARRAY.
- PWM->position (RC_Channel::read_6pos_switch): ≤1230→1, 1231-1360→2, 1361-1490→3, 1491-1620→4, 1621-1749→5, ≥1750→6; out-of-range (≤800 or ≥2200) → no mode change. Debounced.
- Mode::Number matches FLTMODE @Values (0-28). Corrected backend COPTER map to authoritative values.

## 3. QGC (UX only)
QGC used for UX reference; noted stale claim "channel fixed to 5". No PX4 logic copied. Kept staged write flow, honest states.

## 4. Six-position model
FLTMODE1
FLTMODE2
FLTMODE3
FLTMODE4
FLTMODE5
FLTMODE6

Not 16 positions. Six positions must not be confused with availability of RC channels 1-16.

## 5. Chain
RC channel X (logical, RCMAP applied) → RC PWM → switch position 1-6 → FLTMODE1-6 → ArduCopter flight mode. Active mode from HEARTBEAT.custom_mode only.

## 6. Final conclusion
ArduCopter Flight Mode configuration uses one configured RC flight-mode channel with six flight-mode positions represented by FLTMODE1 through FLTMODE6. Six positions must not be confused with the availability of RC channels 1–16.

## 7. Test gates
- Backend: 1420 passed, 153 warnings
- Backend flight-related: 92 passed
- Flight Modes tests: 6/6 passed
- Frontend: 665 passed, 11 failed (OsdConfig.test.tsx — pre-existing, unrelated)
- TS/build/ESLint: clean

## 8. Validation
- SITL: no real RC telemetry available; honesty enforced (WAITING/NO_SIGNAL/STALE/OUT_OF_RANGE). No writes/mode changes.
- Real Pixhawk: BLOCKED — DEVICE NOT CONNECTED

EOF
echo "done" | head -1