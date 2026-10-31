# Power — Live Functional Verification Report

Date: 2026-09-28
Target: `SETUP → Power`
Firmware under test: ArduCopter 4.7.0 (`ARDUPILOTMEGA`), QUADROTOR, USB/SERIAL, system/component 1/1, disarmed, `STABILIZE`

## Safety Constraints Applied

- Real Pixhawk used **read-only**. No parameter writes, arming, motor, servo, or ESC commands were sent.
- No `MAV_CMD_DO_MOTOR_TEST` and no `MAV_CMD_DO_SET_SERVO` anywhere in `backend/api/setup.py` or `backend/services/power_service.py` (verified by grep).
- The ESC button in `SetupPower.tsx` is rendered `disabled` with **no click handler at all**, so no actuator path exists.
- The only calibration routes in `backend/api/setup.py` are Sensors (gyro / baro / level). No ESC calibration route exists.
- No QGC example value (`3`, `4.05`, `3.40`, `12.2 V`) is used as a real value anywhere.

## Live Connection and Parameter Sync

| Item | Observed |
| --- | --- |
| `connected` | `true` |
| `connectionState` | `connected` |
| `transport` | `USB` |
| `sync.state` | `complete` |
| `expectedCount` / `receivedCount` | `991` / `991` |
| `missingIds` | `[]` |
| `cachedEntries` | `991` |
| `state` | `MONITOR_DISABLED` |
| `instanceCount` | `1` |
| `disconnectReason` | `null` |

Initial poll returned `state=SYNCING`; after parameter download completed the state settled to `MONITOR_DISABLED`. This is the correct transition.

## Per-Parameter Evidence (live, read-only)

Queried individually via `GET /api/parameters/{id}`.

**Present in the live parameter set (value received):**

| Parameter | Value | Reboot required |
| --- | --- | --- |
| `BATT_MONITOR` | `0` (decoded `Disabled`) | yes |
| `BATT2_MONITOR` … `BATT9_MONITOR` | `0` | yes |
| `MOT_PWM_TYPE` | `0` | yes |
| `MOT_PWM_MIN` | `1000` | no |
| `MOT_PWM_MAX` | `2000` | no |
| `MOT_SPIN_ARM` | `0.07` | no |
| `MOT_SPIN_MIN` | `0.15` | no |
| `MOT_SPIN_MAX` | `0.95` | no |
| `SERVO_DSHOT_ESC` | `0` | no |
| `SERVO_DSHOT_RATE` | `0` | no |
| `ESC_CALIBRATION` | `0` | no |

**Metadata present but NOT received from the vehicle (`live = null` → correctly reported `supported: false`):**

`BATT_CAPACITY`, `BATT_VOLT_MULT`, `BATT_AMP_PERVLT`, `BATT_AMP_OFFSET`, `BATT_VLT_OFFSET`,
`BATT_LOW_VOLT`, `BATT_CRT_VOLT`, `BATT_LOW_MAH`, `BATT_CRT_MAH`, `BATT_LOW_TIMER`,
`BATT_FS_LOW_ACT`, `BATT_FS_CRT_ACT`

This is the decisive finding for the requested fields: the connected vehicle genuinely does not publish battery capacity, scaling, or threshold parameters. Their metadata exists locally in `copter.xml`, but the autopilot did not return values, so the UI must and does show them as unavailable rather than inventing them.

## Instance Detection — Verified Correct

`BATT2_MONITOR`–`BATT9_MONITOR` all exist and are all `0`. The service reports `instanceCount: 1`, not 10.

This is intended behaviour, not a bug: `_detect_instances()` in `backend/services/power_service.py:219` treats a present-but-disabled monitor slot as "not a real battery" and only surfaces a secondary instance when its monitor is non-zero or a `BATTERY_STATUS` frame exists for that id. Showing 10 empty batteries would be wrong.

## Telemetry

```
GET /api/setup/power/telemetry
```

```json
{"instance": 0, "id": 1, "voltage": null, "current": null, "consumedMah": null,
 "remaining": null, "temperature": null, "cellVoltages": [],
 "chargeState": "UNDEFINED", "source": "SYS_STATUS", "ageMs": 40, "stale": false}
```

Telemetry freshness works (age ~40 ms, `stale: false`), but every measurement is `null` because `BATT_MONITOR=0` disables battery monitoring. Values are correctly reported as absent, not zero-filled or estimated.

## Calculation Endpoints — Live

`POST /api/setup/power/calculate-voltage-multiplier` with `sensorVoltage=18.0, measuredVoltage=16.2, currentMultiplier=1.0`:

```json
{"success": true, "calculatedMultiplier": 0.9, "message": "Calculated new multiplier: 0.900000"}
```

`POST /api/setup/power/calculate-amps-per-volt` with `sensorCurrent=2.0, measuredCurrent=2.5, currentAmpsPerVolt=1.0`:

```json
{"success": true, "calculatedAmpsPerVolt": 1.25, "message": "Calculated new amps per volt: 1.250000"}
```

Both match the documented math exactly (16.2/18.0 = 0.9; 2.5/2.0 = 1.25). Input validation also verified live:

- `measuredVoltage = 0` → `{"detail": "Measured voltage must be greater than 0."}`
- `currentAmpsPerVolt = 0` → `{"detail": "Current amps per volt must be greater than 0."}`

## Browser Verification (real Chrome, live Pixhawk)

Driven through the Chrome DevTools Protocol against the running dev server and the connected Pixhawk. Because this session cannot interpret images, evidence was collected as rendered DOM text, control inventory, and values rather than a visual screenshot.

Rendered page content confirmed: `Power Setup` title and description, the `Battery` section, `Number of Cells (in Series)` / `Full Voltage (per cell)` / `Empty Voltage (per cell)`, `Battery monitoring` populated with the **33 real enum options from the vehicle's own `BATT_MONITOR` metadata**, `Voltage divider` + `Calculate`, `Amps per volt` + `Calculate`, `Battery Max: unavailable`, `Battery Min: unavailable`, the ESC warning, `Revert`, `Apply Power Configuration`, `Show UAVCAN Settings`, `Show Advanced Settings`.

Live control inventory:

| Control | Value | Disabled | Correct? |
| --- | --- | --- | --- |
| `power-monitor-select-1` | `0` | no | yes — real value, real options |
| Cell count / full cell / empty cell inputs | — | yes | yes — firmware exposes no such parameters |
| `power-calc-volt-run` | — | yes | yes — `BATT_VOLT_MULT` unsupported |
| `power-calc-amp-run` | — | yes | yes — `BATT_AMP_PERVLT` unsupported |
| `power-esc-calibrate` (`Calibrate unavailable`) | — | yes | yes — no actuator path exists |
| `power-config-revert` | — | no | yes |
| `power-config-apply` | — | no | yes |
| UAVCAN / Advanced checkboxes | `on` | no | yes |

Every disabled control corresponds to a parameter the vehicle genuinely does not expose. No control is disabled without cause, and no available control is wrongly disabled.

## Defect Found and Fixed

The browser render exposed one genuine functional defect that the test suite had not covered.

**Symptom:** the two adjacent inline notes rendered as run-together text — `Battery monitoring disabled.Unsupported on this firmware.`

**Cause:** `SetupPower.tsx` rendered two adjacent `<span className="power-inline-note">` elements with no separator between them, so their text ran together.

**Fix:** prefixed the second note with the codebase's established `" · "` continuation separator (`frontend/src/components/setup/SetupPower.tsx:816`).

**Re-render after fix:** `Battery monitoring disabled. · Unsupported on this firmware.` — confirmed live in the browser.

**Regression test added** (`SetupPower.test.tsx`): *"separates the monitor-disabled and unsupported notes so they never run together"*, asserting the unsupported note matches `/^\s*·\s*Unsupported/`. Focused Power suite went from 26 to **27 tests, all passing**.

## Disconnect / Reconnect

Covered by dedicated automated tests rather than a forced unplug of the live USB link:

- Backend: `tests/test_power.py::test_21_disconnect`, plus state/instance/telemetry selection — `7 passed`.
- Frontend: `shows WAITING when disconnected with no reason`, `shows CONNECTION_LOST with the disconnect reason and cleared telemetry note`, `clears live battery telemetry on disconnect and resumes on reconnect`, `refreshes live values from battery:update socket events without a reload` — `4 passed`.

Stale data is cleared on disconnect (`usePowerSetup.ts` clears the snapshot when the link drops) and values resume on reconnect. Live observation of a physical USB drop was **not** performed, by choice.

## Quality Gates

| Gate | Result |
| --- | --- |
| `pytest -q` (full backend) | **642 passed** |
| `npx vitest run` (full frontend) | **522 passed** |
| `npx tsc -b` | **pass** |
| `npm run lint` (oxlint) | **pass** — 10 pre-existing warnings, none in changed code |
| `npm run build` | **pass** — 171.87 kB CSS, 851.82 kB JS |
| Focused Power frontend | **27 passed** |
| Focused Power backend (disconnect/state/instance/telemetry) | **7 passed** |

Backend emits 153 pre-existing `AsyncServer.emit was never awaited` `RuntimeWarning`s from `backend/sio/server.py:99`; these are unrelated to Power.

Build emits the pre-existing >500 kB chunk-size advisory; also unrelated.

### Pre-existing test flake (not a regression)

One full-frontend run reported `1 failed | 521 passed` in
`src/components/parameters/ParameterFileDialogs.test.tsx > "action buttons wire to the file / write / reset dialogs"`.

Investigated and confirmed **pre-existing and unrelated to Power**:
- it is a different module from the only files changed (`SetupPower.tsx`, `SetupPower.test.tsx`);
- it passes **3/3** in isolation (`6 passed`);
- it fails only intermittently under full parallel load, consistent with a timing/user-event sensitivity;
- repeat full runs then pass cleanly (`36 passed (36)`, `522 passed (522)`).

No Power test is flaky: the focused Power file passed every invocation.

## Result Summary

| Requirement | Result |
| --- | --- |
| Real Pixhawk connection and identity | PASS |
| Parameter sync 991/991, no missing ids | PASS |
| `BATT_MONITOR` read and metadata-decoded | PASS |
| Correct `MONITOR_DISABLED` state | PASS |
| Unsupported parameters shown unavailable, never fabricated | PASS |
| Secondary battery instances not falsely shown | PASS |
| Telemetry freshness and honest null values | PASS |
| Voltage-divider calculation (live endpoint) | PASS |
| Amps-per-volt calculation (live endpoint) | PASS |
| Calculation input validation | PASS |
| Disconnect clears / reconnect resumes (automated) | PASS |
| Apply / Revert (automated) | PASS |
| Real live parameter write | NOT RUN — hardware restricted to read-only |
| Physical USB disconnect/reconnect | NOT RUN — by choice |
| ESC calibration | NOT RUN and NOT IMPLEMENTED, by design |
| In-app note rendering | PASS after fix |

## Honest Limitations

1. The connected Pixhawk has battery monitoring disabled and does not publish capacity, scaling, or threshold parameters. Consequently the live UI cannot demonstrate populated battery values, and cell-count / per-cell / calibration controls are legitimately unavailable. This is the vehicle's real state, not a gap in the implementation.
2. Apply / Revert against real hardware was never exercised, so end-to-end write confirmation is evidenced by tests only.
3. Visual layout could not be judged in this session because image interpretation is unavailable; DOM text and control state were verified instead.
4. No SITL instance was available, so reversible write/read-back testing on a simulator was not performed.

## Files Changed During Verification

- `frontend/src/components/setup/SetupPower.tsx` — one-character-class fix adding the ` · ` separator between the two inline notes (line 816).
- `frontend/src/components/setup/SetupPower.test.tsx` — added one regression test (26 → 27 tests).

No other production file was modified. Layout, structure, and all other Setup pages were left untouched.
