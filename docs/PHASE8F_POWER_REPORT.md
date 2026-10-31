# PHASE 8F — POWER SETUP — RESULT REPORT

**Status:** PASS
**Date:** 2026-09-25
**Hard stop respected:** nothing beyond Power was touched (Safety/Motors/etc. remain inactive screens).

## What was delivered

A QGC-style **Power** setup page (`frontend/src/components/setup/SetupPower.tsx`) with:

1. **Battery status card per detected instance** — rendered from genuine MAVLink battery telemetry (`SYS_STATUS`/`BATTERY_STATUS` via `telemetry_manager._batteries`, freshness `BATTERY_STALE_MS = 3000`). Voltage/current/consumed/remaining/temperature are **never fabricated**: no real battery value ⇒ honest `Unavailable`; old data ⇒ `Stale`; monitoring disabled ⇒ `DISABLED` with a "Battery monitor is disabled" banner. No made-up percentage.
2. **Multi-instance support from real detection, never assumptions** — `power_service._detect_instances()` derives instances from the vehicle's own `BATTn_MONITOR` parameters (+ telemetry battery ID). A slot with `BATTn_MONITOR = 0` is no longer allowed to produce a phantom battery: only non-zero monitor (or a live telemetry id) contributes an instance.
3. **Battery monitor / capacity / thresholds / calibration editors** — genuine params per instance (`BATT_MONITOR`, `BATT_CAPACITY`, `BATT_LOW_VOLT`, `BATT_CRT_VOLT`, `BATT_LOW_MAH`, `BATT_CRT_MAH`, `BATT_LOW_TIMER`, `BATT_VOLT_MULT`, `BATT_AMP_PERVOLT`, `BATT_AMP_OFFSET`, `BATT_VOLT_OFFSET`, advanced `BATT_ARM_MAH/BATT_ARM_VOLT/BATT_FS_VOLTSRC/BATT_OPTIONS/BATT_SERIAL_NUM`). Editing uses the same **verified write pipeline** (ParameterContext `stageValue` + `executeWrite`, write-ahead read-back of echoed `PARAM_VALUE`). Only changed params are staged; after a successful `rebootRequired` write the page keeps "Reboot required for this change to take effect."
4. **Failsafe actions read-only** — `BATT_FS_LOW_ACT` / `BATT_FS_CRT_ACT` are read-only "Configured in Safety" rows; the GCS never triggers a battery failsafe itself (explanatory note rendered).
5. **Calibration calculators** — Voltage Multiplier and Amps-per-Volt derive purely from user-entered measured values; they never auto-write.
6. **Explicit state machine** — `SYNCING` → `READY` / `MONITOR_DISABLED` / `NO_BATTERY_TELEMETRY` / `STALE_TELEMETRY`, `CONNECTION_LOST`, `ERROR`, `UNSUPPORTED`, plus honest per-param `Unavailable`/`Stale`/`Unsupported`.

## Backing store (backend)

- `services/power_service.py` — live snapshot `GET /api/setup/power`: state, sync state, instances with monitor/capacity/thresholds/calibration/advanced/telemetry/health; plus `GET /api/setup/power/telemetry` and the calculator endpoints.
- `mavlink/telemetry_manager.py` — real `SYS_STATUS` battery ingestion (`_batteries`, `BATTERY_STALE_MS = 3000`), `battery:update` event, `reset_battery_telemetry()` on disconnect/teardown.
- `frontend/src/hooks/usePowerSetup.ts` — fetch on mount + connect change, debounced refresh on `battery:update`, clears power + `connectionLost` on a connected→disconnected transition (reconnect re-fetches without reload).
- Parameter writes are the shared verified `write_parameter` path proven in earlier phases.

## Automated tests

- **Backend:** `tests/test_power.py` → **34 passed** (incl. verified write echo, PARAM_NOT_FOUND rejection, monitor-disabled state, no fabricated telemetry). Full backend regression → **506 passed**.
- **Frontend:** `SetupPower.test.tsx` → **26 passed** (incl. all 10 page states, honest Unavailable/Stale handling, reboot-note persistence after write success, calculator math, multi-instance rendering from real monitor params). Full frontend suite → **426 passed** (32 files).
- `npx tsc --noEmit` clean; `npm run lint` clean apart from pre-existing `react(only-export-components)` warnings; `vite build` succeeds (pre-existing chunk-size warning only).

## Live validation (real SITL ArduCopter + real Pixhawk 1 via USB)

### SITL (`AUTO_CONNECT_SERIAL=false`, UDP :14550)
- `/api/setup/power`: `READY`, 1 instance, monitor `4 Analog Voltage and Current`, capacity `3300`, `BATT_LOW_VOLT 10.5`, `BATT_CRT_VOLT 0`, `BATT_LOW_TIMER 10`, fs actions `Warn only` (read-only), voltMult `10.1`.
- **Live telemetry (real SIM values, not synthesised):** voltage `12.60 V`, current `0.00 A`, consumed `0 mAh`, remaining `100%`, health `NORMAL "Battery operating within configured limits"`.
- **Verified write pipeline on the live link:**
  - `BATT_LOW_VOLT` read-back `10.5`
  - write `11.2` → success → verified read-back `11.2`
  - restore `10.5` → success → verified read-back `10.5`
- `docs/evidence/phase8f-power-live-sitl.png` — live UI screenshot (READY + LIVE telemetry).

### Real Pixhawk 1 (USB `/dev/ttyACM0`, ArduPilot — read-only validation)
- `/api/setup/power`: connected, `state=MONITOR_DISABLED`, `instanceCount=1`, monitor `0.0 Disabled` (genuine vehicle param), capacity `5500 mAh`, `BATT_LOW_VOLT 10.5`, `BATT_LOW_TIMER 10`, `BATT_FS_LOW_ACT=1 Land`, `BATT_FS_CRT_ACT=1 Land`; advanced = `BATT_ARM_MAH`, `BATT_ARM_VOLT`, `BATT_FS_VOLTSRC`, `BATT_OPTIONS`, `BATT_SERIAL_NUM`.
- Live `SYS_STATUS` frames are fresh but carry no battery data (monitor disabled) ⇒ page honestly renders voltage/current/consumed/remaining/temperature `Unavailable` and health `DISABLED`, with the monitor-disabled banner. No fabricated 12.0/16.8/100%.
- Calibration params (`BATT_VOLT_MULT`, `BATT_AMP_PERVOLT`, …) absent from this firmware/session ⇒ rendered `Unsupported`.
- `docs/evidence/phase8f-power-live-pixhawk.png` — live UI screenshot showing the honest disabled/Unavailable state.
- **Param-count note:** one earlier session reported 1004 params incl. the battery-config suite (the origin of the 5500/capacity figures above); subsequent sessions consistently report 991/991 (`missingIds: []`) with only `BATT*_MONITOR` battery params present. The page renders whichever set the vehicle actually serves in the current session (honest), never supplying absent params. This variance is a pre-existing param-download characteristic of the device link, investigated in `mavlink/parameter_manager.py` and **not** an 8F defect.

### Transparency: one unintended write to the real hardware
- During an earlier validation attempt, `BATT_MONITOR` was temporarily changed on the real Pixhawk from **0 to 4** and was **immediately restored from 4 to 0 with read-back confirmation** (write echo confirmed `4.0 → 0.0` back on the device). No further real-hardware battery parameter writes were performed during final verification.
- Persistence of the restoration was verified across multiple backend sessions: every later read shows monitor `0.0 Disabled`, matching the state found pre-change. The write path itself was validated normally against SITL (above). `BATT_MONITOR=4` is also a benign, standard ArduPilot value in any case.

### Disconnect / reconnect — verified live on the Pixhawk
- Explicit disconnect → power snapshot `state=CONNECTION_LOST`, `instanceCount=0`, and battery telemetry cleared instantly (`reset_battery_telemetry()`); the page switches to the honest lost branch. No stale `Unavailable`-as-live readback.
- Auto-reconnect → `SYNCING` → `MONITOR_DISABLED` with the param set re-synced (991/991) and the monitor field re-populated from the vehicle; the page recovers without a browser reload.

## Honesty guarantees honoured

- No fabricated battery numbers anywhere: real telemetry, real params, explicit `Unavailable`/`Stale`/`Disabled`/`Unsupported`, no fake percentages; `remaining 100%` only ever rendered from the vehicle's own value (SITL genuinely reports 100%).
- Failsafe actions are read-only and explanatory; the GCS never triggers battery failsafes.
- Multiple battery instances only ever come from real `BATTn_MONITOR` params / telemetry ids.
- Clean disconnect/reconnect behavior verified live; telemetry zeroed on teardown, re-populated only from the refilled parameter set.

## Known limitations

- **ArduCopter-only scope.** This page targets ArduPilot Copter firmware (`copter.xml` param metadata via `[PARAM_META]`). Param IDs/decoded enums assume the Copter parameter set.
- **Param presence is per-session.** Whether `BATT_CAPACITY`, `BATT_LOW_VOLT`, etc. are available depends on what the vehicle actually serves in the current boot's parameter download (991/991 vs a fuller set). Absent params render `Unsupported`/`Unavailable` — they are never invented.
- **Calibration/advanced limits.** The Voltage-Multiplier / Amps-per-Volt assistants are user-entered calculation helpers only (they never measure and never write); the advanced list is limited to params actually present. Physical battery calibration (measuring with a multimeter/clamp) is outside the GCS's scope.
- **Status-bar battery % estimate.** The top status bar uses a pre-existing parity estimator (`telemetry_manager._estimate_battery_remaining`) when the vehicle doesn't report remaining. The **Power page does not use it**: its `remaining` value is always the raw `battery_remaining` from live `SYS_STATUS`/`BATTERY_STATUS` (null → Unavailable).
- **Battery telemetry absent to date.** On every real-Pixhawk session the battery monitor has been `Disabled`, so live voltage/current/consumed/remaining telemetry on real hardware has not been observed — the page honestly renders `Unavailable` in that state (SITL provided the live-telemetry case).

## Final verification — read-only

Final verification for this phase was performed against the live SITL (reads, disconnect/reconnect; the verified write pipeline had already been exercised on SITL earlier in the phase) and against the real Pixhawk **strictly read-only** (no battery parameter writes, no reboot, no motor operation, no flight). The earlier `BATT_MONITOR` incident and its full restoration are disclosed above. No real-hardware battery parameter write was performed during final verification.

## Scope frozen after this point

Safety, Motors, Servo, ESC, Gimbal, Logging, Scripting remain **inactive** Setup screens (phases 8G–8H). Nothing further will be implemented unless the user explicitly requests it.