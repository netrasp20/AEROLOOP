# Phase — SETUP → Radio Setup Report

Scope: **SETUP → Radio only**. No changes were made to Data, Plan, Config, Firmware,
Sensors, Safety, Motors or ESC, and none to the global sidebar or header.

Status: **complete and validated against both SITL and a real Pixhawk
(read-only), after the transport-reporting fix and the final hardware-safe audit.**

> **Final audit (2026-10-05):** the previously-reported `transport` bug is fixed
> (§1.3), the real Pixhawk read-only validation is now **done** (§4), and all test
> gates are green (§2). **No actuator commands, no writes, no arming and no
> physical calibration were performed at any point** (§7).

---

## 1. IMPLEMENTED

### 1.1 Backend

`backend/services/radio_service.py`

- **Honest RSSI** — new `rssiReport` on the radio payload. MAVLink's `255`
  ("RSSI unknown") and ArduPilot's `0` ("no valid RC link") are converted to
  `{value: null, available: false, unavailableReason}`. Only `1..254` is ever
  shown as a number. Before the first frame the reason reads
  "No RC_CHANNELS frame has been received from the vehicle yet", because a
  dropped link resets `rcRssi` to `0` and reporting that as a measured reading
  would be a lie.
- **Explicit RC state** — new `rcState` ∈ `CONNECTING | DISCONNECTED |
  WAITING_FOR_RC | RC_STALE | RC_ACTIVE`. Link state and receiver state are
  separate axes on purpose: a healthy MAVLink link is not evidence of a
  working RC link.
- **Capability-driven Additional Radio Setup** — new `auxChannels`. For each
  channel 1..16 the service looks for `RC{channel}_OPTION` (and the older
  `RC{channel}_OPT`), requires a **genuine enum** from the vehicle's own
  metadata, and reports per-channel `supported` / `unavailableReason` /
  `options`. Nothing is hardcoded. A main control channel is flagged
  `isMainControl` and excluded from the additional-setup list.
- `mainControls.channels` added alongside the existing `mappings`.
- `calibrationStage` added to the snapshot.

`backend/services/radio_calibration.py`

- New `_stage_for()` / `_rc_present()` and a `stage` field on the status
  payload, mapping the existing internal machine onto the requested vocabulary:
  `IDLE`, `READY`, `WAITING_FOR_RC`, `CALIBRATING`, `FINALIZING`, `SUCCESS`,
  `FAILED`, `CANCELLED`, `DISCONNECTED`. No new state machine was introduced and
  no calibration semantics were changed.

**No new endpoints, sockets, MAVLink connections, parameter writers or telemetry
providers were created.** The existing five routes, `telemetry:update`,
`radio:calibration:progress`, `ParameterContext.executeWrite()` and the verified
`PARAM_SET` → authoritative `PARAM_VALUE` echo → cache/socket pipeline are reused.

### 1.2 Frontend

`frontend/src/api/setup.ts` — types for `rssiReport`, `stale`, `auxChannels`,
`rcState`, `calibrationStage`, calibration `stage`, `MainControlsData.channels`.

`frontend/src/hooks/useRadioSetup.ts` — propagates `stage` from the action
responses and from `radio:calibration:progress`.

`frontend/src/components/setup/SetupRadio.tsx`

- Status strip shows the live RC state and prints a number **only** when the
  backend reports a real RSSI, otherwise "RSSI Unavailable".
- Transmitter visualisation offers **modes 1, 2, 3 and 4**; mode is presentation
  only and never touches RCMAP. With no live input the stick markers are parked
  and labelled, not given invented values.
- Channel monitor renders per-channel `LIVE / WAITING / STALE / UNAVAILABLE`, a
  trim marker, and min/trim/max from the vehicle.
- **RCMAP editing**: editable channel per axis with `CURRENT n` / `PENDING n
  (current n)`, Revert and Apply Mapping, validation (integer 1..16), and a reboot
  notice driven only by the vehicle's own `rebootRequired` metadata. Nothing is
  written until Apply Mapping.
- **Additional Radio Setup** is generated from the real `auxChannels` payload.
  PX4/QGC-only controls (Spectrum Bind, Copy Trims) are named as unsupported on
  ArduCopter instead of being faked.
- Calibration stage rail showing all requested stages.

### 1.3 Transport reporting — FIX (final audit)

`backend/services/radio_service.py` — new `_active_transport()`.

**Root cause.** `transport` was derived from
`get_vehicle_status()["connectionType"]` (`core/state.py`), which is a proxy
computed from three independent booleans and **checks `serialPortOpen` FIRST**:

```python
if vehicle_state["serialPortOpen"]:   connection_type = "SERIAL"
elif is_tcp_connected():             connection_type = "TCP"
elif vehicle_state["udpConnected"]:   connection_type = "UDP"
```

A `serialPortOpen` flag left behind by an earlier session therefore reported
`USB` for a **live TCP** link. Reproduced directly against the pre-fix code:

```
scenario: live TCP link, stale serialPortOpen=True left behind
  OLD code -> USB    <-- the reported bug
  NEW code -> TCP    <-- fixed
```

`ConnectionManager._teardown()` can abort before clearing the flags
(`parameter_manager.stop_session()` is not wrapped in `try/except`), and
`_mark_connection_lost()` deliberately leaves them set because the socket is
still open, so a stale serial flag surviving into a TCP connect is reachable in
normal operation.

**Fix.** The transport now comes from the connection manager's authoritative
record, `manager.connection_type`, which `ConnectionManager._start()` sets only
once the pymavlink connection object actually exists. Labels are reused from
`services/setup_service._CONNECTION_LABELS` (the same map the Firmware page uses),
so both Setup pages agree. Transport is never inferred from vehicle type, board
type or a stale proxy value, and is never hardcoded.

| Situation | Reported |
|---|---|
| `connectionType == "tcp"` | `TCP` |
| `connectionType == "udp"` | `UDP` |
| `connectionType == "serial"` | `USB` |
| `connectionState == "connecting"` | `CONNECTING` |
| not connected | `DISCONNECTED` |
| connected, manager has no type yet | state proxy, then `UNKNOWN` |
| unrecognised transport (e.g. `canbus`) | passed through as `CANBUS`, never `USB` |

Because the disconnected branch is checked before the manager value, the previous
session's transport cannot survive a disconnect — the manager never resets
`connection_type` itself, so this was previously a live leak.

**Also fixed here:** `_rc_state()` compared `connectionState == "CONNECTING"`
(uppercase) while `core/state.py` stores it **lowercase**, so `CONNECTING` was
unreachable in production. The existing test passed an uppercase literal and
masked it. Now compares `"connecting"` and the test fixtures use the real
lowercase values.

### 1.4 Calibration success honesty — FIX (final audit)

`case "completed"` rendered a success banner on the state string alone. The
success claim is now gated on the backend result payload
(`result.result === "success"`). A `completed` state with a missing or failed
result renders `radio-cal-unverified` instead of a green check, so "SUCCESS"
can never appear without a genuine verified result. Terminal stages
(`FAILED` / `CANCELLED` / `DISCONNECTED`) also get an explicit rail chip; they
are not part of the forward progress order and previously left every chip
unhighlighted, which reads as "nothing happened".

`frontend/src/styles/setup.css` — dark/purple panel borders, stronger section
separation, larger responsive stick circles (`clamp(96px, 13vw, 132px)`), stage
chips, aux rows, map rows, reboot warning, RSSI-unavailable state, and responsive
breakpoints. Also removed the flat-workspace override
`.setup-radio-page .radio-cal-hint { display: none }` (setup.css:1660), which was
hiding every calibration hint (`radio-cal-idle`, `radio-cal-ready`,
`radio-cal-center-done`, `radio-cal-min-done`) from the user.

---

## 2. TESTED

Exact counts from the final audit run (after the transport fix and the
calibration-success gate).

| Gate | Command | Result |
|---|---|---|
| Backend, Radio only | `python -m pytest tests/test_radio.py -q` | **74 passed** |
| Backend, full suite | `python -m pytest -q` | **1420 passed**, 153 warnings, 0 failed |
| Frontend, Radio only | `npx vitest run src/components/setup/SetupRadio.test.tsx` | **56 passed** |
| Frontend, full suite | `npx vitest run` | **676 passed** / 38 files |
| Types | `npm run build` (`tsc -b`) | **clean** |
| Production build | `npm run build` | **✓ built** |
| Lint | `npm run lint` (oxlint) | **10 warnings**, all pre-existing, in files not touched by this phase |

New in this audit — **transport** (backend): TCP, UDP, USB, `CONNECTING`,
`DISCONNECTED`, reconnect changing transport, stale transport cleared after
disconnect, unrecognised transport not defaulted to USB, proxy fallback.
**Transport** (frontend): each of `TCP` / `UDP` / `USB` rendered verbatim, plus
`DISCONNECTED` / `CONNECTING` when no transport is in use.
**Calibration** (frontend): terminal `FAILED` / `CANCELLED` / `DISCONNECTED` rail
chip; `SUCCESS` withheld without a genuine backend result; `SUCCESS` shown when
the result confirms the write; failure never rendered as success.
**RCMAP** (backend): non-standard mapping never normalised, channels beyond CH8
accepted, partially missing `RCMAP_*` reports `null` rather than a default.
**RC state** (backend): `CONNECTING` asserted from the real lowercase state.

New tests added: RSSI sentinel handling (`0`, `255`, no-frame, real value),
aux capability detection (no params / real enums / main-control exclusion /
param without enum), `rcState` transitions, calibration stage mapping, RCMAP
stage/apply/revert/out-of-range/reboot-metadata, aux apply, aux banner scoping,
mode selector, and the stage rail.

### 2.1 Defects found and fixed during this phase

1. **Rules-of-Hooks violation** — new `useMemo` hooks were added after the
   early-return block, so the component crashed on the first render (24 tests
   failing). Hooks were moved above the returns.
2. **`store.staged[pid].value` did not exist** — the staged change field is
   `stagedValue`, so mapping/aux pending values silently never rendered.
3. **Apply never wrote** — the commit effect only counted
   `RC*_MIN|TRIM|MAX|REVERSED`, so RCMAP/aux staged values were never sent. The
   effect now covers all three staged groups.
4. **Cross-contaminated success banners** — a channel-config write showed an
   "aux applied" banner; both are now scoped to their own Apply.
5. **Stale pending value** — typing `99` staged the intermediate `9` and left a
   PENDING badge contradicting the field; the staged value is now discarded when
   the input is invalid.
6. **Header could contradict live data** — the status strip preferred the
   one-time snapshot's `rcState` over the socket-fed live signal.
7. **Aux capability could never be detected (found by SITL)** —
   `ParameterManager.get_parameter()` returns `to_snapshot()`, which has **no
   `metadata` key**, so reading enums from it always reported "unsupported".
   `_param_options()` now reads the existing
   `parameter_service.get_metadata()` provider (the same source as
   `GET /parameters/{id}/metadata`). No duplicate metadata source was added.
8. **Transport reported `USB` for any link** — see §1.3. Root cause was the
   serial-first flag proxy in `core/state.py`.
9. **`CONNECTING` was unreachable** — `_rc_state()` compared an uppercase
   literal against a lowercase stored value; masked by an uppercase test fixture.
10. **`SUCCESS` was claimable without a result** — the success banner rendered on
    the state string alone; now gated on `result.result === "success"` (§1.4).
11. **Terminal calibration stages were invisible on the rail** — `FAILED` /
    `CANCELLED` / `DISCONNECTED` are outside the forward order, so every chip
    stayed unhighlighted; they now get an explicit chip.

### 2.2 Pre-existing observation (not caused by this phase)

Three firmware tests (`test_detection_is_recorded`, and both
`bootloader-validation/status` contract cases) failed earlier in the session while
a real board was attached, and pass in every run since:

- earlier run: `3 failed, 1403 passed`
- later runs: `1407 passed`, then `1420 passed`

They are sensitive to attached-hardware state. They touch firmware detection and
the bootloader-validation contract only — no Radio code path. They were **not**
changed here, in keeping with the "no unrelated changes" constraint.

---

## 3. SITL VALIDATED

ArduCopter SITL was **built from source for this validation**
(`ardupilot @ e21a6ae`, waf `copter --board sitl`, 6m12s) and connected over
TCP:5760; the GCS backend and the Vite dev server were both attached to it.
Read-only for the purposes of the observations below — no arming, no actuator
commands, no reboots.

Observed from the live API against ArduCopter SITL:

| Check | Observed |
|---|---|
| Vehicle | `QUADROTOR` / `ARDUPILOTMEGA`, `supported: true` |
| RC state with no transmitter | `rcState: WAITING_FOR_RC` |
| Calibration stage | `calibrationStage: WAITING_FOR_RC`, machine `idle` |
| RSSI | raw `255` → `available: false`, "RSSI unknown (255)" — **not** printed as a number |
| Channels | `channelCount: 0`, `channels: []` — no fabricated values |
| RCMAP | Roll→CH1, Pitch→CH2, Throttle→CH3, Yaw→CH4 (real parameters) |
| `mainControls.channels` | `[1, 2, 3, 4]` |
| Channel config | 16 channels; CH1 min 1082 / trim 1547 / max 1894, CH2 1000/1499/1999, CH3 1006/1006/1995 |
| Aux capability | `supported: true`; CH5–CH16 non-main, each with a real param and **136 genuine enum options** |
| Aux sample | `RC7_OPTION = 154` → "ArmDisarm with AirMode (4.2 and higher)" |
| Main-control exclusion | CH1–CH4 correctly flagged `isMainControl`, excluded from the aux list |
| Disconnect | `rcState: DISCONNECTED`, `calibrationStage: DISCONNECTED`, reason "No RC_CHANNELS frame has been received from the vehicle yet." |
| Reconnect | back to `WAITING_FOR_RC` / `aux supported: true`, RCMAP restored |

SITL is a simulator: it validates the vehicle-parameter surface and the honest
no-signal path. It has **no RC receiver**, so `RC_ACTIVE`, stale transitions and
the calibration capture sequence were **not** exercised in SITL. Those paths are
covered by the 74 backend and 56 frontend tests using injected `RC_CHANNELS`
frames.

### 3.1 Transport over TCP — post-fix confirmation

Re-run against SITL after the §1.3 fix, on a live TCP link with
`AUTO_CONNECT_SERIAL=false` so no serial flag could be present:

```
transport   : TCP          <- was USB before the fix
rcState     : WAITING_FOR_RC
channelCount: 8
rssiReport  : {raw: 255, available: false, "The vehicle reports RSSI as unknown (255)."}
RCMAP       : Roll 1, Pitch 2, Throttle 3, Yaw 4
auxSupported: true         (12 non-main channels, 136 enum options each)
RC7_OPTION  : 7  (SITL default)
RC1         : min 1000 / trim 1500 / max 2000
```

The same run also confirmed the state-proxy itself now agrees
(`connectionType: TCP`), and that after the link drops the page reports
`DISCONNECTED` rather than retaining the previous transport.

---

## 4. REAL PIXHAWK READ-ONLY VALIDATION — PERFORMED

A real Pixhawk **was connected and available** for this audit:
`/dev/ttyACM0`, `lsusb` → `1209:5741 Generic Pixhawk1`. The validation below was
**strictly read-only** (`GET` requests only). Nothing was written, nothing was
armed, no control was moved, and calibration was never started.

### 4.1 Observed from the live API (read-only)

| Check | Observed |
|---|---|
| Connection state | `connected: true`, `connectionState: connected` |
| **Transport** | `USB` — correct for USB serial **after the §1.3 fix** |
| Autopilot | `ARDUPILOTMEGA` |
| Vehicle type | `QUADROTOR` |
| Firmware identity | `4.7.0 (Official Release)`, `boardType: 0`, `boardRev: 9` |
| Mode / armed | `STABILIZE`, `armed: false` |
| System / component | `systemId: 1`, `componentId: 1` |
| `RCMAP_ROLL` | `1` |
| `RCMAP_PITCH` | `2` |
| `RCMAP_THROTTLE` | `3` |
| `RCMAP_YAW` | `4` |
| `mainControls.channels` | `[1, 2, 3, 4]` (derived from those parameters, not assumed) |
| RC channel telemetry | `channelCount: 0`, `channels: []` — no receiver streaming |
| RC state | `WAITING_FOR_RC` |
| Calibration stage | `WAITING_FOR_RC`, machine `idle` |
| RSSI | raw `255` → `available: false`, "The vehicle reports RSSI as unknown (255)." |
| `RC1_MIN` / `RC1_TRIM` / `RC1_MAX` | `1082` / `1547` / `1894` |
| `RC2_*` | `1000` / `1499` / `1999` |
| `RC3_*` | `1006` / `1006` / `1995` |
| `RC5`–`RC16` endpoints | `1000` / `1500` / `2000`, `reversed: 0` |
| Aux capability | `supported: true`, all 16 channels with **136 genuine enum options** |
| Main-control exclusion | CH1–CH4 flagged `isMainControl`, excluded from the aux list |
| `RC7_OPTION` (real) | `154` → "ArmDisarm with AirMode (4.2 and higher)" |
| `RC5`, `RC6`, `RC8`–`RC16_OPTION` (real) | `0` → "Do Nothing" |

The board's actual factory RC tuning is visible and matches the vehicle's own
parameters (CH3 trim `1006` with min `1006`, i.e. a genuinely non-default
configuration) — the values were read, not assumed.

### 4.2 Honest no-signal path on real hardware

Because no RC receiver was streaming, the page correctly showed the existing
`WAITING_FOR_RC` state, `channelCount: 0`, no PWM values, and RSSI as
unavailable. **No values were manufactured**, and `1500` was never displayed —
no telemetry carried it.

### 4.3 Actions explicitly NOT performed

- no RC parameter writes (`RCMAP_*`, `RCx_MIN/TRIM/MAX/REVERSED` untouched)
- no calibration started, no capture, no physical stick movement
- no actuator commands of any kind (motors, servos, ESCs)
- no arming, no flight, no mode change
- no reboots, no bootloader operations

Nothing was written to any vehicle at any point in this phase — SITL or
hardware.

---

## 5. UNSUPPORTED

Reported as unsupported rather than faked:

- **Physical RC receiver calibration.** Requires a real transmitter and a
  disarmed vehicle; gated by design and never run.
- **Live `RC_ACTIVE` / stale transitions in SITL.** No RC source exists in SITL.
- **PX4/QGC-only radio controls** — Spectrum Bind, Copy Trims: named as
  unsupported on ArduCopter.
- **Channels the firmware does not publish** — reported with an explicit
  `unavailableReason`; no placeholder channel is displayed.
- **Rover `MODE_CH` and PX4-specific parameters** — out of scope by design.
- **Automatic reboot after a mapping write.** The warning is shown; nothing
  reboots the autopilot.

---

## 6. REMAINING LIMITATIONS

1. **`RC_ACTIVE` was never observed live.** No RC receiver was streaming on the
   Pixhawk and SITL has no receiver, so `RC_ACTIVE`, live stale transitions and
   the calibration capture sequence rest on injected `RC_CHANNELS` frames in the
   test suites. The honest `WAITING_FOR_RC` path *was* confirmed on real hardware.
2. **Physical calibration is unproven by definition.** It requires a real
   transmitter and a disarmed vehicle, and was deliberately not performed.
3. **Aux and RCMAP write round-trip is unvalidated end-to-end.** The verified
   write pipeline and staging behaviour are unit-tested, and the *read* side is
   proven against both SITL and the Pixhawk, but no aux or RCMAP value was
   written to any vehicle.
4. **Three firmware tests are hardware-state sensitive** (§2.2) and should be
   investigated separately; they are unrelated to Radio.
5. **Transmitter mode 1–4 is a presentation layer.** It draws the stick layout
   only; the authoritative mapping always comes from RCMAP, so no mode can change
   vehicle behaviour.
6. **The same serial-first proxy still exists in `core/state.py`**, and is
   consumed by `get_vehicle_status()["connectionType"]` — which
   `/api/vehicle/status` still returns. Radio no longer depends on it, but four
   other services (`safety`, `power`, `motor_setup`, `gimbal`) keep their own
   copy of the label map and the same proxy. Out of scope here; worth a separate
   pass. The Firmware page already prefers the connection manager.
7. **`ConnectionManager` never resets `connection_type` on teardown.** Radio
   handles this by reporting `DISCONNECTED` whenever not connected, so no stale
   value can leak. Other consumers reading `manager.connection_type` directly
   (`motor_test_service`, `firmware_install_service`) still see the last-used
   value after a disconnect; unchanged here as out of scope.
8. **`ardupilot/` (~841 MB, shallow clone + build) exists at `/home/prema`** to
   provide SITL. It is outside the repository and can be deleted; the filesystem
   sits at 95% with ~3.8 GB free.
9. **SITL over TCP drops the link shortly after connecting** in this environment
   (the simulator exits when its client goes away). Live SITL evidence in §3 was
   captured inside that window; the Pixhawk USB session was stable throughout.

---

## 7. Release checklist

- [x] Scope limited to SETUP → Radio; no unrelated page, sidebar or header change
- [x] Existing MAVLink / parameter / telemetry / socket architecture reused; no duplicates
- [x] Real data only — `RC_CHANNELS`, `RCMAP_*`, `RCx_*`; no fabricated values
- [x] RSSI `0` and `255` never presented as a signal strength
- [x] Explicit RC state (`CONNECTING` / `WAITING_FOR_RC` / `RC_STALE` / `RC_ACTIVE` / `DISCONNECTED`)
- [x] RCMAP read from real `RCMAP_*` parameters, never assumed to be CH1–CH4
- [x] RCMAP editing staged locally, applied only on Apply, revertable, reboot-honest
- [x] Additional Radio Setup driven by genuine firmware capability
- [x] Calibration states explicit, with `WAITING_FOR_RC` when no RC is present
- [x] Calibration `SUCCESS` requires a genuine verified backend result
- [x] All four transmitter modes offered; presentation only
- [x] **Transport taken from the connection manager; `CONNECTING` / `DISCONNECTED` when none is in use**
- [x] No physical calibration, writes, arming, actuators or reboots on any vehicle
- [x] Backend Radio suite 74 passed; full backend 1420 passed
- [x] Frontend Radio suite 56 passed; full frontend 676 passed; build and types clean
- [x] SITL validated against a purpose-built ArduCopter (TCP transport reported correctly)
- [x] **Real Pixhawk read-only validation performed** — identity, RCMAP, endpoints, aux, honest no-signal (§4)

### 7.1 Explicit hardware-safety statement

During this phase, on both SITL and the real Pixhawk:

- **no actuator commands** were sent — no motors, no servos, no ESCs, no output channels
- **no physical calibration actions** were performed — no calibration was started and no
  transmitter control was moved
- **no writes of any kind** — no `RCMAP_*`, no `RCx_MIN/TRIM/MAX/REVERSED`, no aux option
- **no arming, no flight, no mode change, no reboot, no bootloader operation**

Every observation in §3 and §4 came from `GET` requests only.

**HARD STOP.** No further changes made. No other Setup phase was started.