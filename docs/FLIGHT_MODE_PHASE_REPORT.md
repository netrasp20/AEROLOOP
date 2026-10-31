# Flight Mode Setup — Phase Report

## 1. Research
- Verified authoritative ArduCopter semantics:
  - FLTMODE_CH: 0 (Disabled), 5..15 (channels); 1-4 reserved, 16 rejected by firmware.
  - FLTMODE1..FLTMODE6: exactly 6 switch positions, PWM bands from read_6pos_switch() (≤1230 / 1231-1360 / 1361-1490 / 1491-1620 / 1621-1749 / ≥1750).
  - Mode list matches Mode::Number 0-28; corrected backend MODE_MAPS["COPTER"] to remove legacy heli entries (26 AUTOROTATE, 27 AUTO_RTL, 28 TURTLE).

QGC research conclusion: used as UX reference only (not authoritative). Noted QGC's Copter channel-fixed description is stale vs ArduPilot 4.x where FLTMODE_CH is user-selectable (0/5..15).

ArduPilot conclusion: single configured flight-mode RC channel + exactly six flight-mode positions (FLTMODE1-6). Channel ≠ position ≠ mode.

## 2. Code changes
- backend/mavlink/telemetry_manager.py: fixed COPTER mode map; added modeCode to telemetry/state/reset.
- frontend/src/parameters/flightModesLogic.ts: firmware-aligned logic (no fabricated defaults; honest states; PWM bounds).
- frontend/src/components/parameters/FlightModes.tsx: channel/position/mode separate; live switch position (WAITING/NO_SIGNAL/STALE/OUT_OF_RANGE).
- frontend/src/styles/flightModes.css + providers/TelemetryProvider.tsx: fact panel + modeCode.

## 3. Gates
- Backend: 1420 passed, 153 warnings (existing)
- Backend (flight-related tests): 92 passed (test_setup_summary_service.py + test_write_transaction.py)
- Frontend: 665 passed, 11 failed (OsdConfig.test.tsx — pre-existing, unrelated)
- Flight Modes tests: 6/6 passed
- TypeScript: clean
- Build: production build succeeds
- ESLint: clean (no new errors/warnings)

## 4. SITL validation (read-only)
- SITL cannot provide real RC receiver telemetry in this environment (no physical transmitter bound). Observed: telemetry contains no rcChannels or rssi>0 in absence of injected RC. States: WAITING/NO_SIGNAL/STALE/OUT_OF_RANGE are implemented and will behave honestly when live RC arrives. No parameters written, no mode changes, no arm/actuator actions.

REAL PIXHAWK VALIDATION:
BLOCKED — DEVICE NOT CONNECTED

## 5. Key distinctions
- RC CHANNEL NUMBER (1-16 logical, mode channel valid 0/5-15) vs FLIGHT MODE POSITION (1-6). 
- Six positions must not be confused with 16 RC channels. ArduCopter does not implement 16 flight-mode positions per channel.
- Active mode from telemetry only; switch position from live PWM.

## 6. Files changed
- backend/mavlink/telemetry_manager.py
- frontend/src/parameters/flightModesLogic.ts (rewritten)
- frontend/src/components/parameters/FlightModes.tsx (rewritten)
- frontend/src/styles/flightModes.css (updated)
- frontend/src/providers/TelemetryProvider.tsx (updated)
- frontend/src/components/parameters/FlightModes.test.tsx (updated)
- docs/FLIGHT_MODE_GCS_RESEARCH.md (new)
- docs/FLIGHT_MODE_PHASE_REPORT.md (new)

## 7. Final readiness
ArduCopter Flight Mode configuration uses one configured RC flight-mode channel with six flight-mode positions represented by FLTMODE1 through FLTMODE6. Six positions must not be confused with the availability of RC channels 1–16. Implementation is data-driven, honest, and read-only validated. HARD STOP per instructions.

EOF
echo "done" | head -1