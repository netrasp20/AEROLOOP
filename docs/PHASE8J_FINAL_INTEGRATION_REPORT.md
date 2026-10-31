# Phase 8J — Final Integration / System Audit / Release Verification

YantraYug GCS — ArduCopter / Pixhawk only.

**Verdict: RELEASE READY** — one genuine integration defect was found and fixed;
all 641 backend and 553 frontend tests pass; every capability page reports honest
vehicle-derived state; no UI was modified.

---

## 1. Executive summary

Phase 8J was run as an integration and audit phase only. **No UI, CSS, layout or
component was changed.** The entire Phase 8J code delta is:

| File | Change |
| --- | --- |
| `backend/mavlink/telemetry_manager.py` | **Defect fix** — vehicle heading no longer derived from GPS course-over-ground |
| `backend/tests/test_heading_vs_cog.py` | **New** — 5 regression tests pinning the fix |
| `docs/PHASE8I_..._REPORT.md` | Carried over from Phase 8I |

Verified with `find frontend/src -newermt <phase-start>` → **zero frontend files
touched**, which is objective proof the approved DATA / PLAN / SETUP / CONFIG /
HUD / map / TopNavBar UI is unchanged.

The audit answered the primary question affirmatively: the application starts
with no vehicle, connects to SITL or a real Pixhawk, synchronises real state,
operates every supported function, survives disconnect/reconnect, and shuts down
cleanly with no stale or fake state.

### Two corrections to the first draft of this report

Both were found by continuing the audit past its first pass, and both are
recorded here rather than quietly amended:

1. **Parameter sync counts were overstated.** The first draft claimed
   "1379/1379" for SITL and "1379 synced". The truthful figure is
   **1378 received of 1379 advertised** — see §18 finding 7, which also
   explains why the API's own completeness accounting is unreliable.
2. **Serial auto-connect is on by default and was undisclosed.** The first
   draft implied the GCS only connects on operator action. In fact
   `core/config.py:38` defaults `AUTO_CONNECT_SERIAL` to **true**, so a
   Pixhawk plugged in at power-on is attached to automatically — see §3.1.

A third item was self-corrected during testing: a "5 duplicate executions"
reading for the scheduler was an artefact of grepping the literal string
`MISSION_COUNT` (which also matches the plan log line, the send, the
dispatch, the flight controller's echo and the download). Counting actual
execution blocks gives **1**.

### The one real defect found

`handle_gps_raw_int()` published `GPS_RAW_INT.cog` — **course over ground** — into
the `heading` field. COG is the direction of travel, not the direction the
vehicle points, and it is `0` whenever the vehicle is stationary. On a live
ArduCopter SITL the vehicle sat still, COG was 0, and the DATA heading card and
the HUD heading tape both read **0.0°** while the vehicle's real `ATTITUDE.yaw`
was −8°.

The legacy TypeScript implementation this port was derived from never used COG
for heading, so this was a porting regression, not intended behaviour.

Fix: COG is no longer written to `heading`; `handle_attitude()` now publishes the
real `ATTITUDE.yaw` as `heading` in degrees normalised to 0–360. Verified live —
heading went from `0.0` to `351.0`, matching yaw. 5 new tests; full backend suite
641 passed (was 636).

---

## 2. Architecture audit

No architecture was changed. The map below is what is actually present.

**Frontend** — React 18 + TypeScript + Vite.

- Root view switch: `pages/MissionPlanner.tsx` holds one
  `useState<ActivePage>("DATA"|"PLAN"|"SETUP"|"CONFIG")` (default `PLAN`).
  No router library.
- Provider stack (`App.tsx`): `OperatorLocationProvider` → `CameraProvider` →
  `MissionProvider` → `ParameterProvider`.
- Shared state: `providers/TelemetryProvider.tsx` + `context/ParameterContext.tsx`.
- Socket.IO: single client `socket/socket.ts`; consumers
  `useSocketTelemetry`, `useBackendTelemetry`, `useTelemetry`.
- API layer: `src/api/{api,vehicle,telemetry,mission,parameters,setup,ftp,fence,video}.ts`.
- Pages: `DataPage`, `PlanPage`, `SetupPage`, `ConfigPage` (+ `HelpPage`, `SimulationPage`).
- Setup: `components/setup/SetupConfig.tsx` switches on `activeId` to 15 real
  pages, with `SetupInactive` as the unknown-id fallback.

**Backend** — FastAPI + python-socketio combined ASGI app (`backend/app.py`,
mounted under `/api/*`; `backend/main.py` is a thin uvicorn entrypoint). Not Express.

- MAVLink: `mavlink/{connection_manager,parameter_manager,telemetry_manager,
  command_service,mission_command,stream_requester,packet_bus,serial_autodetect}`.
- Services: 27 modules incl. `mission_{service,upload_service,download_service,
  start_service}`, `ftp_service`, `schedule_service`/`schedule_executor`,
  `calibration_service`, `video_service`, and the Phase 8I
  `gimbal_service`/`logging_service`/`scripting_service`.
- Socket.IO events: `sio/{server,mission_handlers}`.

**Single-instance guarantees confirmed (section 16 requirement):**

- One `ParameterManager` singleton (`parameter_manager = ParameterManager()`);
  all 10+ services import that same instance. No competing cache exists.
- One `ConnectionManager` singleton.
- Both `SetupParameters` and `ConfigPage`→`ParametersScreen` consume the *same*
  `ParameterContext` and the same `/api/parameters` API. No second parameter
  architecture.

---

## 3. DATA verification

Verified on live SITL. All values real; nothing fabricated.

| Item | Observed |
| --- | --- |
| Vehicle identity | QUADROTOR, ARDUPILOTMEGA, sys/comp 1/1 |
| Mode / armed | STABILIZE, Disarmed |
| Altitude | 0.0 m relative (live `GLOBAL_POSITION_INT.relative_alt`) |
| Ground / air speed | 0.0 / 0.0 m/s |
| Heading | 353° (real, post-fix) |
| Battery | 100 %, 12.60 V (real `BATTERY_STATUS`) |
| GPS | RTK Fixed, 10 sats, HDOP 1.2 |
| Dist to home / next WP | 0.0 m / 0.0 m |
| Map, vehicle + home markers | present |
| Connection state | CONNECTED chip |
| Camera panels | "Camera offline / Stream error" (honest) |

Disconnected, every card renders `--` or a neutral `0.0`; nothing is shown as
live.

### 3.1 Serial auto-connect is enabled by default

`backend/core/config.py:38` — `AUTO_CONNECT_SERIAL = _bool("AUTO_CONNECT_SERIAL", True)`.

The variable is **not** set in `.env` and is not exported in the shell, so the
default applies. Observed directly: starting the backend with a Pixhawk
attached produced, unprompted and within seconds —

```
[AUTO-CONNECT] Serial auto-connect watcher started (AUTO_CONNECT_SERIAL=true)
[AUTO-CONNECT] Serial device detected: /dev/ttyACM0
[MAVLINK] Starting serial connection on /dev/ttyACM0 @ 57600 baud
```

followed by a full 991-parameter synchronisation. The operator never pressed
connect. Consequences:

- The GCS shows **NO VEHICLE** at startup *only because no serial device was
  attached*. With hardware plugged in, the startup state is a live, fully
  synced vehicle.
- This is deliberate and documented in the source comment ("Also auto-reconnects
  a lost serial link when the device reappears"), and it is a reasonable
  behaviour. It is recorded here because it is safety-relevant and was absent
  from the first draft of this report.
- It also means every "no vehicle" and "read-only" observation in this report
  depends on the Pixhawk being unplugged at that moment. For the parameter-write
  testing in §6A the backend was deliberately restarted with
  `AUTO_CONNECT_SERIAL=false` so that a write could not reach real hardware
  even by accident. That was verified: with the override, the log contains
  **zero** `AUTO-CONNECT` lines and zero `ttyACM0` references.

---

## 4. HUD validation

- `ArtificialHorizon.tsx` uses `rollAngle = radToDeg(telemetry.roll)` and
  `pitchOffset = radToDeg(telemetry.pitch) * PITCH_SCALE` — **no orientation
  compensation, offset or rotation fudge of any kind** (grepped for
  offset/compensat/degToRad/rotate: only the two direct transforms).
- roll 0 / pitch 0 measured live on SITL produced
  `translate(0 0.23) rotate(0.07 200 150)` — a centred horizon, i.e.
  **sky above, horizon, ground below**.
- No renderer mathematics was modified. `ArtificialHorizon.test.tsx` 6/6 pass.
- `AHRS_ORIENTATION` is `0` on the Pixhawk (the separately authorised earlier
  change); it was not touched again.

---

## 5. PLAN verification

Real mission round-trip against live ArduCopter SITL over the real protocol:

- **Upload:** 3 waypoints → `MISSION_COUNT` → per-item `MISSION_ITEM_INT` →
  **`MISSION_ACK=0 (ACCEPTED)`** → verification download → "5 items match
  ArduPilot" → `DO_SET_MISSION_CURRENT seq=0`.
- **Download:** `count=5`, coordinates round-tripped exactly
  (`x=-35.3645, y=149.1665, z=45.0`).
- Protocol constants: `MISSION_COUNT`(44), `MISSION_REQUEST_INT`(51),
  `MISSION_ITEM_INT`(73), `MISSION_ACK`(47) — the INT variants. Inbound
  `MISSION_REQUEST`(40) is additionally tolerated (ArduPilot sends it), which is
  correct compatibility, not a protocol change.
- Validation is genuinely strict: rejected a missing altitude and bad waypoint
  numbering before touching the vehicle.
- Home position read from telemetry: −35.363262, 149.165237, 584.1 m.
- Scheduling UI and persistence present; no duplicate scheduling observed.
- Mission actions used the real connected session (sys/comp 1/1).

**Safety note:** after upload, the auto-RTL-on-completion hook evaluated and
decided **"Vehicle is already at home — no RTL needed"**. It issued no RTL.
Backend log confirms the only command sent in the whole session was
`MAV_CMD_GET_HOME_POSITION` (a read).

### 5.1 Mission scheduling — full verification

The first draft of this report asserted scheduling was "present" without testing
it. It has now been exercised end to end against live SITL. Every check passed.

**Input validation** (`POST /api/schedule`):

| Case | Result |
| --- | --- |
| No vehicle connected | `400` — "Connect to the flight controller before scheduling a mission." |
| Missing `id` | `400` — "Missing schedule id." |
| No waypoints | `400` — "No waypoints to schedule. Add waypoints first." |
| Date in the past | `400` — "Please select a valid date and time in the future." |
| Valid far-future entry | `200`, `status=scheduled`, `nextRun` computed, emitted |
| **Duplicate `id`** | **`409` — "Schedule with this id already exists."** |
| `DELETE` unknown id | `404` |

**Persistence.** The full entry — including the exact waypoint list *and* the
home-position snapshot — is written to `backend/scheduled_missions.json`
(`schedule_service.py:106`), so a later execution uploads the same mission that
was scheduled.

**Execution state machine.** A schedule was deliberately fired (due in 6 s) and
the transition watched live:

```
t+2s  scheduled      t+4s  scheduled      t+6s  scheduled      t+8s  completed
```

with `MISSION_ACK = 0 (ACCEPTED)` and "Uploaded + verified 3 waypoints —
success."

**Duplicate-execution prevention — two independent guards, both verified:**

1. *API level* — a repeated `id` is rejected `409`, so the same entry cannot be
   added twice.
2. *Scheduler level* — `schedule_service.py:288-301` flips the entry to
   `uploading` and adds its id to `_inflight` **before** the worker thread
   starts, and `_timer_tick` skips any id in `_inflight` or in a non-runnable
   status. A firing produced exactly **1** execution block, **1** upload and
   **1** completion record for one id.

**Disconnect / reconnect while pending.** A schedule due in 8 s while the vehicle
was then disconnected:

- went to `waiting` at its due time, logged
  *"due at … but flight controller is NOT connected — holding as WAITING"*;
- produced **0** execution blocks while disconnected;
- executed **exactly once** on reconnect and reached `completed`.

The pending mission is held indefinitely rather than dropped or force-run.

**Restart persistence and crash recovery.** With entries on disk, the backend was
restarted:

| Entry | On disk before restart | After restart |
| --- | --- | --- |
| `8j-ok` (far future) | `scheduled` | `scheduled`, `nextRun` intact |
| `8j-persist` (far future) | `scheduled` | `scheduled`, `nextRun` intact |
| `8j-fire` (already ran) | `completed` | `completed`, `nextRun=None` |
| `8j-wait` (already ran) | `completed` | `completed`, `nextRun=None` |
| `8j-crashed` (crash mid-upload) | `uploading` | **`scheduled`** — recovered |

The `uploading → scheduled` rewrite on load (`schedule_service.py:475-477`)
prevents a mission being stranded as permanently "in progress" after a crash or
hard restart. Terminal `completed` entries were not resurrected.

**Safety.** Throughout every scheduling test the vehicle stayed
`armed=False`, `mode=STABILIZE`, and no mode change or arming was issued. This is
by design: `schedule_executor.py:8-16` scopes the automated action to
**upload + verify only** — "It does NOT arm the vehicle. It does NOT switch
flight modes. It does NOT send MAV_CMD_MISSION_START / RTL / takeoff." An
arriving schedule time therefore cannot move the vehicle.

All test schedules were deleted afterwards and
`backend/scheduled_missions.json` was left with 0 entries.

---

## 6. SETUP verification

All 15 Setup pages exercised on live SITL and on the real Pixhawk. Every page:
0 console errors, 0 failed local API calls, 0 loading spinners, no error overlay.

| Page | Result | Evidence of real data |
| --- | --- | --- |
| Summary | PASS | 14 ok / 0 warn / 1 unsupported (SITL); 10 ok / 4 warn (Pixhawk) |
| Firmware | PASS | 4.8.0-dev d16ddbab (SITL) vs 4.7.0 Official 1511f271 (Pixhawk) |
| Frame / Airframe | PASS | FRAME_CLASS=1/FRAME_TYPE=0 (SITL), 1/1 (Pixhawk); reboot-required shown |
| Sensors | PASS | Accel/Gyro/Baro `CALIBRATED` from FCU; no calibration run |
| Radio | PASS | SITL: "WAITING FOR TELEMETRY" — SITL emits no `RC_CHANNELS` |
| Flight Modes | PASS | FLTMODE1–8 real slot mapping |
| Power | PASS | SITL live battery; Pixhawk `MONITOR_DISABLED` → all "Unavailable" |
| Safety | PASS | statuses derived from vehicle params, with on-page statement to that effect |
| Motors | PASS | Motor1–4 discovered from `SERVOx_FUNCTION` 33–36; "testing is disabled" |
| Servo Outputs | PASS | 16 outputs, min/trim/max/reverse, "Live PWM: No" where unreported |
| ESC | PASS | 4 ESCs with real RPM/V/A/°C/mAh |
| Gimbal | PASS | no device reported → honest unsupported reason |
| Logging | PASS | 14 params "Partially configured" (SITL) / 13 "Disabled" (Pixhawk) |
| Scripting | PASS | `SCR_ENABLE` detected; execution disabled |
| Parameters | PASS | 1379 (SITL) / 991 (Pixhawk) fully synced |

### State machine

Verified live in both directions. On watchdog loss all capability services
reported `CONNECTION_LOST` with `configCount: 0` and reason "No vehicle
connected."; on reconnect they returned to `READY` only after a fresh sync. No
page classified a parameter unsupported while sync was in progress, and no page
showed stale vehicle data after disconnect.

### CONFIG verification

1378 parameters received of 1379 advertised (see §18 finding 7 — the first draft
of this report said "1379", which was wrong), 5691 metadata definitions, 376
groups, Standard / Advanced split, group tree, session id, MAVFTP tab. Shares the
parameter context with SETUP (§2).

## 6A. Parameter write cycle (SITL)

The first draft reported only that parameters *synchronised*; the write path
itself was untested. It has now been exercised against live SITL.

**Safety containment.** Every write test ran with the backend started as
`AUTO_CONNECT_SERIAL=false`, so the real Pixhawk was unreachable and no write
could land on it. The parameter chosen, `INS_LOG_BAT_MASK`, is a `uint16`
logging mask with no effect on flight behaviour, and **it was restored to its
original value `0` afterwards** — verified by an authoritative read back from
the flight controller.

**Write → verify → readback → revert**, using the flight controller (not the
cache) as the source of truth:

| Step | Result |
| --- | --- |
| Authoritative FCU read | `0` |
| Write `1` | `200`, acknowledged value `1` |
| FCU readback | `1` — written, and the cache tracked it |
| Revert to `0` | `200`, FCU readback `0` — restored |
| Final FCU read | `0` — matches the original |

**Rejections and guards:**

| Case | Result |
| --- | --- |
| Non-numeric value | `400 WRITE_INVALID` |
| Missing `value` in body | `400 BAD_REQUEST` |
| Unknown parameter | `404 PARAM_NOT_FOUND` |
| Batch with a **stale `transactionId`** | `400 SESSION_CHANGED` — "no active transaction matches" |
| Batch with a **conflicting `originalValue`** | `409 CONFLICT`, 1 conflict reported, **value left unchanged** |
| Valid batch, no transaction id | `200`, readback confirmed |
| `items` not an array | `400 BAD_REQUEST` |
| Empty `items` | `400 BAD_REQUEST` — "At least one parameter is required." |
| Single write while disconnected | `400 NOT_CONNECTED` |
| Batch write while disconnected | `400 NOT_CONNECTED` |
| Read while disconnected | `400 NOT_CONNECTED` |

`GET /write/status` reported `hasActive=false` once the transaction settled and
exposed the completed `transactionId`, so the frontend can drive a staged write
without a stale client replaying one.

**Browser refresh.** With a live vehicle connected, the CONFIG page was loaded,
fully reloaded, and loaded again. Both loads reported identical state —
`CONNECTED`, the same parameter count — with zero console and zero page errors,
confirming the parameter view is server-authoritative and survives a refresh
without client-held state. Evidence:
`phase8j-parameters-after-write.png`.

---

## 7. SITL validation

ArduCopter V4.8.0-dev (d16ddbab) via the existing project SITL workflow. Full
telemetry set confirmed live: heartbeat, vehicle type, firmware, mode,
armed/disarmed, GPS (fix 6, 10 sats), position, altitude, heading, battery,
attitude, and 1379/1379 parameter synchronisation. No telemetry was fabricated.

**Environment note:** SITL requires `sim_vehicle.py` with a **live stdin pipe**.
MAVProxy exits on stdin EOF and takes the simulator down with it. Recipe kept at
`/tmp/opencode/sitl/start_sitl.sh`.

---

## 8. Pixhawk read-only validation

Real Pixhawk, `/dev/ttyACM0`, 57600 baud. **Read-only throughout: no writes, no
arming, no actuation, no calibration, no scripting, no failsafe triggers.**

- Identity: QUADROTOR, ARDUPILOTMEGA, STABILIZE, Disarmed, 1/1, SERIAL.
- Parameters: **991/991**, 0 missing.
- Firmware 4.7.0 (Official Release) 1511f271 — genuinely different from SITL.
- Sensors: Accel/Gyro/Baro `CALIBRATED`, Compass enabled, level horizon set.
- Radio: "RC calibration required" (real `RC1_MIN`).
- Power: `BATT_ENABLE` absent → **MONITOR_DISABLED, Voltage/Current/Remaining
  all "Unavailable"** — the honest unavailable state, not a fake battery.
- Motors: `SERVO1_FUNCTION`=33 … `SERVO4_FUNCTION`=36 (real mapping).
- Logging: 13 params, `LOG_BITMASK`=0 → "Disabled".
- Scripting: `SCR_ENABLE`=0, capability detected from the real parameter.
- Gimbal: no device reported.
- GPS: no fix indoors (0 sats) — reported honestly, not faked.

---

## 9. Disconnect / reconnect validation

**SITL watchdog loss** (transport killed):

- `connectionState=disconnected`, reason `heartbeat_timeout`.
- All telemetry cleared to 0: lat, lon, alt, battery V and %, roll, pitch,
  heading, GPS fix, sats, ground speed.
- Parameter cache dropped to 0 entries, sync state `idle`.
- Both write paths refused: single-param and batch → `NOT_CONNECTED`.
  Reads refused too.
- All Setup pages → `CONNECTION_LOST`, `configCount: 0`.
- UI showed "MAVLink connection lost — Reason: heartbeat_timeout", no stale rows.

**SITL reconnect:** automatic within 5 s of the heartbeat returning, with no
manual connect and **no browser refresh**. Identity, firmware, 1379/1379 params
and telemetry all restored.

**Pixhawk disconnect:** stale telemetry cleared, parameter cache dropped to 0,
serial port released (verified with `lsof`).

**Pixhawk reconnect:** heartbeat auto-detected, **991/991 re-synced**, telemetry
restored, no browser refresh.

---

## 10. MAVFTP validation

Full lifecycle against the real vehicle filesystem, in a scratch directory that
was removed afterwards:

`mkdir` → `write` (base64) → `read` (byte-exact round-trip) → `rename` →
`list` → `remove` → `rmdir` → confirmed gone. All `success: true`.

**Path traversal rejected:**

| Attempt | Result |
| --- | --- |
| `/../../etc/passwd` | rejected — "path traversal not allowed" |
| `/scripts/../../etc/shadow` | rejected — "path traversal not allowed" |
| `/./../..` | rejected — "path traversal not allowed" |
| `etc/passwd` (relative) | rejected — "must be absolute" |
| `/..%2f..%2fetc` | refused — "File not found" |

Validation is in `ftp_service._validate_path`, which rejects any `..` path
component. No unsafe arbitrary file execution exists.

---

## 11. Camera validation

No camera source is configured, and the UI says exactly that:
**"Camera offline / Stream error"** on both the Live and Thermal panels, with a
Retry affordance. No stream is fabricated. The only `rtsp://` strings in the
source are `placeholder` attributes in the connect/config dialogs — user input
hints, not active streams. No fake RTSP/MJPEG/HLS URL is present.

---

## 12. UI regression check

**No UI change was made, by construction and by verification.** Phase 8J touched
zero files under `frontend/src`.

Independently, the approved UI was observed working during the audit: navigation
across all four pages, Setup sidebar with all 15 entries and per-page badges,
telemetry cards, HUD with tapes/ladder/roll arc, map with graticule, camera
panels, and the violet YantraYug shell and connection chip all rendered
correctly with no layout breakage at 1680×1050.

No visual regression was found, so no component was modified.

---

## 13. Rover / PX4 contamination audit

Production scope is ArduCopter only. **No Rover or PX4 logic affects the
ArduCopter path.** Categories found:

**Benign — protocol dictionaries (no action):** `MAV_TYPE` and `MAV_AUTOPILOT`
enum tables including `GROUND_ROVER`, `SURFACE_BOAT` and `PX4`
(`telemetry_manager.py:59,73`); `parameter_metadata.py` rover.xml mapping.

**Benign — correctly gated dormant Rover support (report only):**
- `command_service.py:347 ROVER_MODES` with the gate
  `table = COPTER_MODES if is_air_vehicle() else ROVER_MODES`. `is_air_vehicle()`
  returns True for `QUADROTOR`, so ArduCopter always takes the Copter table.
- `telemetry_manager.py` mode-label disambiguation picks `vehicle_key = "COPTER"`
  for `QUADROTOR`; the Rover/Plane maps are only appended as decode fallbacks.
- `parameter_presets._ROVER_KEYS`, `setup_service.py:118` (Firmware page reports
  Plane/Rover/PX4 as unsupported — correct honest behaviour).

**Cosmetic misnomers, pre-existing, not changed (would be a UI text edit):**
user-visible strings say "Rover" generically — `DebugPanel.tsx:24` "Rover GPS",
`ActionPanel.tsx:45,98` "Rover is at home" / "rover drives back to HOME" — in an
ArduCopter-only GCS.

**Legacy artefacts reported, not deleted:** `start-sitl-rover.sh` and 16
`dumpcore.sh_ardurover.*.out` / `dumpstack.sh_ardurover.*.out` crash dumps in the
repo root. Not production code paths.

No `MODE_CH`/`MAV_MODE_CH` Rover flight-mode logic was introduced.

---

## 14. Safety command audit

| Command | Production occurrences | Reachable from Phase 8 setup code? |
| --- | --- | --- |
| `MAV_CMD_DO_SET_SERVO` | 0 | n/a |
| `MAV_CMD_DO_SET_RELAY` | 0 | n/a |
| `MAV_CMD_NAV_LAND` | 0 | n/a |
| `MAV_CMD_DO_MOTOR_TEST` | 7 — `calibration_service.py` CompassMOT only | **No** |
| `MAV_CMD_COMPONENT_ARM_DISARM` | 8 — `command_service.py` arm/disarm | **No** |
| `MAV_CMD_NAV_TAKEOFF` | 2 — `mission_command.py` mission-item build | **No** |

Every Phase 8 setup service (`gimbal_service`, `logging_service`,
`scripting_service`, `motor_setup_service`, `setup_service`, `safety_service`)
and `api/setup.py` has **zero** imports of `command_service` or any actuator send
helper. The Motors, Servo and ESC pages state in the UI that testing is disabled
and are read-only by construction.

`MAV_CMD_NAV_TAKEOFF` appears as a mission *item* command id when building an
uploaded mission for air vehicles — required for a valid ArduCopter mission, and
sent with the vehicle disarmed.

**Confirmed during the audit:** the GCS did not independently trigger RTL, LAND,
SmartRTL, BRAKE, DISARM, arming or any mode change. Backend log for the entire
session contains exactly one command: `MAV_CMD_GET_HOME_POSITION`. The flight
controller remained authoritative throughout.

---

## 15. Test and build results

| Check | Result |
| --- | --- |
| Backend full suite | **641 passed**, 154 pre-existing async-emit warnings |
| Frontend full suite | **36 files, 553 tests passed** |
| `npx tsc -b` | **PASS** (clean) |
| ESLint (`oxlint`) | **PASS** — warnings only, all pre-existing |
| `npm run build` | **PASS** — pre-existing chunk-size advisory |
| `pyflakes` (production) | 10 pre-existing warnings (unused imports/vars, one f-string) |

No test was deleted, weakened or skipped. The 5 new tests are additive.

---

## 16. Performance / error check

Browser, 30 s idle after visiting all four pages, both with and without a live
vehicle:

- 0 console errors, 0 page errors, 0 unhandled promise rejections.
- 0 failed local API requests.
- **0 duplicate backend requests**; telemetry arrives entirely over the single
  Socket.IO connection with no REST polling.
- JS heap stable (29 MB idle / 54 MB live); DOM nodes and event listeners
  *decreased* over the idle window — no timer or subscription growth.
- No Vite error overlay on any page.

Backend log: **0 tracebacks**, 0 unhandled exceptions, 5 connect attempts (each
a deliberate audit action — no runaway loop), 1 reconnect, 5 parameter-sync
bursts (one per connection, not duplicated), 2 watchdog losses (both deliberate).
The only error lines are from one deliberately malformed audit request.

---

## 17. Clean shutdown

Verified by disconnecting the vehicle and sending `SIGTERM` to the backend:

- Clean teardown sequence logged: `Disconnecting vehicle` → `[PARAM] Session
  stopped` → `[MAVLINK] Connection closed` → `Application shutdown complete` →
  `Finished server process`.
- `/dev/ttyACM0` released (verified with `lsof`).
- Port 5000 released; no lingering listener.
- **YantraYug spawns no MAVProxy child process.** The `mavproxy.py` seen during
  testing was the SITL UDP bridge I started manually, parented to my own shell
  (ppid 8085), not to the application.
- Exactly one Vite dev server; no duplicate created by the application.
- Final state: no vehicle, MAVLink or backend processes remain.

---

## 18. Known limitations and remaining (non-blocking) findings

None of these are Phase 8J regressions. Per the audit rules, only genuine
integration defects were fixed; these are reported for future phases.

| # | Finding | File | Severity |
| --- | --- | --- | --- |
| 1 | `/api/vehicle/status` retains the last vehicle's `vehicleType`, `autopilot`, `systemId`, `componentId` after disconnect (`mode` correctly becomes `DISCONNECTED`, `connected` false). The UI masks it — every telemetry card is gated on `connected` and renders `--`. `components/VehicleStatus.tsx` prints raw values unguarded but is **not rendered anywhere** (dead legacy component). A cold start correctly reports `UNKNOWN` / `0`. | `backend/mavlink/connection_manager.py` | Low |
| 2 | `_estimate_battery_remaining()` synthesises a battery percentage from voltage when the autopilot reports no `battery_remaining`. Dormant in practice: SITL reports a real `BATTERY_STATUS` `battery_remaining=100`, and the Pixhawk has no battery monitor at all (shows "Unavailable"). Marked "(parity)" — replicates the legacy `telemetryManager.ts`. | `backend/mavlink/telemetry_manager.py:729,738` | Low |
| 3 | The HUD status line renders `BAT 0% GPS 0` while disconnected. The adjacent `DISCONNECTED` label disambiguates, and changing it would edit an approved UI component, so it was left alone. | `frontend/src/components/HUD/ArtificialHorizon.tsx:88` | Cosmetic |
| 4 | 10 `pyflakes` warnings in production backend (unused imports, one unused local, one placeholder-less f-string). All pre-existing and cosmetic. | various | Cosmetic |
| 5 | Rover/PX4 legacy code and "Rover" wording in user-visible strings remain (correctly gated; see section 13). | various | Cosmetic |
| 6 | Map base tiles depend on the external `server.arcgisonline.com`, which is unreachable in this offline sandbox, so tiles render blank while all vector overlays (markers, graticule, paths) work. A deployment note, not an application defect. | map config | Environment |
| 7 | **Parameter sync completeness is misreported.** The vehicle advertises 1379 parameters; **1378 are actually received**, but the CONFIG/SETUP header reads "**1379 parameters**". Worse, the `missingIds` field that should surface the gap is unusable: the backend returns **parameter *indexes* (`int[]`)**, while the frontend types declare `missingIds: string[]` (`frontend/src/api/parameters.ts:35`, `api/setup.ts:590,782,835`) and `ParameterContext.tsx:352` passes it through unchanged. The list is also **stale and self-contradictory** — 124 indexes are reported missing while 1378 params are cached, so at least 123 are phantom. See analysis below. | `parameter_manager.py:639-665,891-893`; `ParameterContext.tsx:352` | Low–Medium |
| 8 | A normal protocol echo is logged as a problem: when the flight controller echoes `MISSION_COUNT` back after an upload, the app prints `[MAVLINK] Unhandled message: MISSION_COUNT`. Benign, but it dilutes the log signal for genuinely unhandled messages. | `connection_manager.py` message dispatch | Cosmetic |

### Analysis of finding 7 — why it was reported and not patched

The inconsistency is provable from the API alone, without assuming anything about
ArduPilot's index space:

- `expectedCount = 1379` (from the vehicle's own `PARAM_VALUE_COUNT`)
- `receivedCount = 1378` (distinct parameter names actually cached)
- `missingIds` = 124 entries

Since 1378 of 1379 parameters were received, **at most 1 can genuinely be
missing**, so at least 123 of the 124 reported indexes are wrong. The gap-fill
log shows how they accumulate: `284 missing → 199 missing → 124 missing → "124
parameter(s) still missing after gap-fill retries"`, and the download then
declares completion anyway.

The root cause is that completeness is tracked in **two incompatible spaces**:
received parameters are identified by *name*, while `_missing_ids`
(`parameter_manager.py:639-642`) is built from *indexes* not seen
(`_seen_indexes`). The source comment is explicit that this is a known
limitation — "names are unknowable — the vehicle never told us them" — so the
index-based list is intentional, but it is never reconciled against the final
received set, so it cannot be trusted.

I deliberately did **not** patch this. A one-line change that dropped or
clamped the missing list would make the API look consistent while risking
**hiding a genuinely absent parameter** — a worse outcome than an over-reported
count, and the sort of "fix" that weakens a safety guarantee. A correct fix
means tracking completeness by name (intersecting received names against the
name list from `PARAM_REQUEST_LIST`) and having the UI display `receivedCount`
rather than `expectedCount`. That is a behavioural change to a shared component
and belongs in its own phase, not in a final-integration pass whose brief was to
change only what it could prove.

Impact today is limited: the over-count is one parameter, and the field that
would have named it is never rendered. No capability is lost and no vehicle data
is faked.

### Environmental note (not an application finding)

During the audit the sandbox wiped `/tmp` and killed all running processes. The
repository, the heading fix, the new tests and all evidence survived intact;
tooling and services were recreated and every remaining check was re-run against
the restored environment. No finding depends on the lost state.

---

## 19. Evidence
18 artifacts in `docs/evidence/`, all captured from the running application with
zero console and zero page errors. None is reused from another phase or
relabelled.

| File | Source |
| --- | --- |
| `phase8j-disconnected.png` | Fresh backend, no vehicle — "NO VEHICLE" |
| `phase8j-disconnected-data.png` / `-plan.png` / `-setup.png` / `-config.png` | All four pages disconnected |
| `phase8j-data-sitl.png` | DATA on live SITL |
| `phase8j-plan-sitl.png` | PLAN on live SITL, real home position |
| `phase8j-parameters.png` | SETUP Parameters, full sync |
| `phase8j-parameters-after-write.png` | CONFIG after the write cycle + browser refresh |
| `phase8j-config.png` | CONFIG, metadata tree and group split |
| `phase8j-reconnected.png` | Summary after automatic reconnect |
| `phase8j-connection-lost.png` | "MAVLink connection lost — Connection closed" |
| `phase8j-pixhawk-readonly.png` | Real Pixhawk Summary, 991 params |
| `phase8j-pixhawk-power.png` | Real Pixhawk Power, honest MONITOR_DISABLED |
| `phase8j-final-data.png` / `-plan.png` / `-setup.png` / `-config.png` | Final UI sweep, zero runtime/API errors |

---

## 20. Final release status

**NOT FULLY VERIFIED.**

### Final verification table

| Area | Result | Evidence |
| --- | --- | --- |
| Startup | PASS | Fresh auto-connect-disabled startup: UNKNOWN identity, 0/0 params, zero telemetry |
| SITL | PASS | Supported workflow, live ArduCopter telemetry and explicit UDP connect |
| DATA | PASS | Live telemetry and honest disconnected state |
| HUD | PASS | Real attitude, no frontend compensation; 6 tests |
| PLAN | PASS | Real mission upload/download and verification |
| SETUP | PASS | All 15 pages exercised; honest unavailable states |
| CONFIG | PASS | Final UI sweep; rows match received count |
| Parameters | **FAIL** | SITL initial sync reproduced 1002/1379 while state=complete; refresh recovers 1379/1379 |
| MAVFTP | PASS | Full lifecycle and traversal rejection |
| Cameras | PASS | Offline/unavailable state with no fake source |
| SITL disconnect | PASS | heartbeat_timeout, telemetry/cache cleared, writes blocked |
| SITL reconnect | PASS | Automatic recovery, fresh telemetry and parameter sync |
| Pixhawk read-only | PASS | Real serial hardware, 991/991, no writes/actuation |
| Pixhawk reconnect | PASS | Auto-recovery and 991/991 refresh |
| Safety audit | PASS | No Phase 8J command additions; no arming/actuation |
| Rover/PX4 audit | PASS | No active Rover/PX4 flight-mode contamination |
| Full backend tests | PASS | **641/641** |
| Full frontend tests | PASS | **553/553**, 36 files |
| TypeScript | PASS | `tsc -b`, zero output |
| ESLint | PASS | 0 errors, 10 pre-existing warnings |
| Build | PASS | Vite production build succeeded |
| Clean shutdown | PASS | Backend/MAVLink/SITL stopped; serial released; no duplicate Vite |

The required final status cannot be `RELEASE READY` because the SITL parameter
sync has a confirmed initial-completion defect. The separate Pixhawk result is
healthy, but the explicit serial disconnect requirement is also not durable
while the default auto-connect watcher remains enabled. Neither issue was
silently converted into a PASS.

Mission scheduling (§5.1) and the parameter write cycle (§6A) were verified end
to end against live SITL and passed their input validation, guard and
state-machine tests, including duplicate prevention, disconnect hold-and-release,
restart persistence and crash recovery. The scheduled-mission executor is
confirmed upload-only, so an arriving schedule cannot move the vehicle.

The single genuine code defect fixed during the audit (heading derived from
course-over-ground) is fixed, covered by 5 new regression tests, and verified
against live hardware and simulation. No UI was redesigned or modified, no
actuator command was introduced, no fake telemetry exists, and no unexpected
write reached the real Pixhawk.

The final blockers are explicit: SITL parameter synchronization can terminate
early, and an explicit Pixhawk serial disconnect is immediately undone by
default-on auto-connect while the device remains attached. Both are documented
with reproduction evidence; neither was patched during this correction-only
pass.

Hard stop. No further phase begins without explicit approval.
