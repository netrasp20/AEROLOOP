# Phase 8I — Gimbal, Logging, Scripting & Parameters

Capability-driven Setup pages for ArduCopter. Every value shown is read from a real
vehicle; nothing is simulated, inferred, or faked.

---

## 1. Scope and safety boundary

Phase 8I adds three read-only capability pages (Gimbal, Logging, Scripting) and
completes the Parameters surface that was already wired in the Setup shell.

What this phase does **not** do, by design:

| Not implemented | Why |
| --- | --- |
| Gimbal movement, angle command, mode change, autotune | Vehicle-motion control is out of scope |
| Arming, mode change, motor test, takeoff, reboot, calibration | Destructive/actuating; existing pre-8I endpoints untouched |
| Script upload, run, stop, delete | Executes arbitrary code on the flight controller |
| New write endpoints | Writes reuse the existing generic staged/verified parameter pipeline |
| New FTP page | MAVFTP browsing already exists; duplicating it would fragment the UI |
| Logging start/stop, format, download | File transfers belong to the existing MAVFTP flow |

The three new routes are **GET-only**, verified against the mounted ASGI app:

```
['GET'] /api/setup/gimbal
['GET'] /api/setup/logging
['GET'] /api/setup/scripting
```

Configuration on these pages is edited through the shared staged/verified
parameter writer, so every write still requires the user to stage a value, review
it, and explicitly apply it — exactly as with every other Setup page.

---

## 2. Architecture

Reused as-is, not duplicated: the Setup shell and nav, parameter metadata
(`ParameterContext`), the staged/verified write pipeline, the connection state
machine, Socket.IO telemetry events, and the MAVFTP implementation.

```
MAVLink wire  →  telemetry_manager  →  service layer  →  GET endpoint  →  hook  →  page
                 (snapshots)         (capability)      (read-only)     (live)   (staging)
```

### 2.1 Telemetry layer

`backend/mavlink/telemetry_manager.py`

- Decodes `GIMBAL_DEVICE_INFORMATION` and `GIMBAL_DEVICE_ATTITUDE_STATUS`
  (received on the existing gimbal/mount stream — no extra requests are sent).
- Decodes `LOG_ENTRY`, keeping `id`, `num_logs`, `last_log_num` and `time_utc`,
  with an arrival timestamp for freshness.
- Keeps small ring buffers (gimbals by device id, log entries by log id) so a
  late-joining client sees current state immediately.
- Emits `gimbal_update` and `log_entry_update` socket events, rate-limited by the
  same freshness rules as the rest of the pipeline.
- `reset_telemetry()` clears gimbal/log state, so a disconnect can never leave
  stale data on screen.

### 2.2 Service layer

| Service | Capability rule | Honesty guarantee |
| --- | --- | --- |
| `gimbal_service` | supported when a gimbal device is reported **or** gimbal/mount config params exist | "No gimbal device has been reported and no gimbal configuration parameters are present." |
| `logging_service` | supported when `LOG_*` params exist | `LOG_ENTRY` absence is stated, never faked |
| `scripting_service` | supported when `SCR_*` params exist | reports only the tokens that exist |

Every payload carries `state`, `supported`, `unsupportedReason` and the live
`sync` block, so the UI can never present a half-synced vehicle as ready.

`gimbal_service` additionally decodes the 20-bit `GIMBAL_FAILURE_FLAGS` bitmask
and the mount output mode flags, and exposes editable `GIMBAL_*` config fields
through the shared parameter writer. Gimbal *control* stays unavailable.

### 2.3 Frontend

- `frontend/src/api/setup.ts` — typed contracts and fetchers for the three pages.
- `hooks/useGimbalSetup.ts`, `useLoggingSetup.ts`, `useScriptingSetup.ts` — live
  state via initial fetch plus socket updates, with connection transitions driving
  waiting → connecting → syncing → ready / lost / reconnecting.
- `components/setup/SetupParamField.tsx` — shared staged editor built on
  `ParameterContext` + `ParamValueEditor`, so gimbal and logging config behave
  identically to every other Setup field (stage, diff, verify, cancel).
- `SetupGimbal.tsx`, `SetupLogging.tsx`, `SetupScripting.tsx` — the pages.
- `SetupConfig.tsx` — the three inactive stubs are now live; the pre-existing
  Parameters and MAVFTP pages are untouched.

Supported but empty states are stated explicitly, e.g.:

> The vehicle has not broadcast any `LOG_ENTRY` frames, so no on-board log list
> is available. This is not simulated.

---

## 3. Verification

| Suite | Result |
| --- | --- |
| Backend full (`pytest`) | **636 passed**, 154 pre-existing async-emit warnings |
| Backend Phase 8I (`test_phase8i_payload.py`) | **53 passed** |
| Frontend full (`vitest run`) | **36 files, 553 tests passed** |
| Frontend Phase 8I (`SetupPayload.test.tsx`) | **45 passed** |
| `npx tsc -b` | clean |
| `npm run lint` | clean (pre-existing warnings only) |
| `npm run build` | success (pre-existing chunk-size advisory) |
| `pyflakes` (new backend modules) | clean |
| Safety scan (no `MAV_CMD`/arm/mode/motor-test/gimbal-move/script-exec in any 8I module) | clean |

Tests cover payload shape, capability gating, bitmask decoding, per-page
unsupported reasons, sync gating, snapshot clearing on disconnect, socket events,
GET-only routing, and the full frontend render/stage/copy matrix.

---

## 4. Real vehicle evidence

No fake data anywhere. Both vehicles are genuine ArduCopter with real parameter
synchronisation; the two runs differ where the hardware differs, which is itself
proof the values are read and not hard-coded.

### 4.1 SITL — ArduCopter V4.8.0-dev (d16ddbab), 1379 params synced

| Page | Observed |
| --- | --- |
| Vehicle | QUADROTOR, ARDUPILOTMEGA, STABILIZE, **Disarmed**, UDP |
| Gimbal | `READY`, supported, 0 devices, 0 outputs, 0 config — no gimbal present |
| Logging | `READY`, **14** `LOG_*` params, status **"Partially configured"**, 0 log entries |
| Scripting | `READY`, `SCR_ENABLE` detected, execution disabled, no `SCR_USER1-5` |
| Parameters | all 1379 real parameters listed |

SITL's `LOG_BITMASK` has bits genuinely set (Medium Attitude, GPS, System
Performance, Control Tuning, Navigation Tuning, RC input, IMU, Mission Commands,
Battery Monitor, RC output, Optical Flow, PID, Compass, Camera, Motors), which is
why the derived status is "Partially configured" — a different, honest result
from the Pixhawk below rather than a hard-coded one.

### 4.2 Pixhawk (read-only) — `/dev/ttyACM0`, 991 params synced

| Page | Observed |
| --- | --- |
| Vehicle | QUADROTOR, ARDUPILOTMEGA, STABILIZE, **Disarmed**, serial 57600 |
| Gimbal | `READY`, supported, no device/config/output, control disabled |
| Logging | `READY`, **13** `LOG_*` params, status **"Disabled"** (bitmask = 0), no `LOG_ENTRY` |
| Scripting | `READY`, genuine `SCR_ENABLE` detected, execution disabled |
| Parameters | all 991 real parameters listed |

Read-only throughout: GET requests only, no writes, and the vehicle was
disconnected cleanly afterward.

### 4.3 Connection lifecycle (live, on SITL)

| Event | Observed result |
| --- | --- |
| Link killed mid-session | all three pages → `CONNECTION_LOST`, `configCount: 0`, UI shows "MAVLink connection lost — Reason: heartbeat_timeout", snapshots cleared, no stale rows |
| SITL restarted, backend reconnected | `"Reconnected. HEARTBEAT received."`, all three pages → `READY` with a freshly re-synchronised snapshot (1379/1379) |

### 4.4 Artifacts

All in `docs/evidence/`. Every screenshot was captured from the running app with
zero console errors and zero page errors.

| File | Source |
| --- | --- |
| `phase8i-gimbal-sitl.png` / `.json` | SITL |
| `phase8i-logging-sitl.png` / `.json` | SITL |
| `phase8i-scripting-sitl.png` / `.json` | SITL |
| `phase8i-parameters-sitl.png` | SITL |
| `phase8i-logging-connection-lost-sitl.png` | SITL, link killed |
| `phase8i-logging-reconnected-sitl.png` | SITL, after reconnect |
| `phase8i-vehicle-status-sitl.json` | SITL |
| `phase8i-gimbal-pixhawk-readonly.png` / `.json` | Pixhawk |
| `phase8i-logging-pixhawk-readonly.png` / `.json` | Pixhawk |
| `phase8i-scripting-pixhawk-readonly.png` / `.json` | Pixhawk |
| `phase8i-parameters-pixhawk-readonly.png` | Pixhawk |
| `phase8i-vehicle-status-pixhawk.json` | Pixhawk |

---

## 5. Honest limitations

- No gimbal hardware was available on either vehicle, so gimbal telemetry is
  proven by unit tests and MAVLink decoding only, not by live device output.
- Neither vehicle broadcast `LOG_ENTRY`, so the on-board log list is verified as
  correctly-absent rather than populated. Live entries are covered by unit tests.
- Neither vehicle exposed `SCR_USER1`–`SCR_USER5`, so the scripting page shows
  only `SCR_ENABLE`. Script execution is intentionally unavailable.
- SITL required `sim_vehicle.py` with a live stdin; MAVProxy exits on stdin EOF
  and takes the simulator down with it. The working recipe is scripted in
  `/tmp/opencode/sitl/start_sitl.sh`.
- `AHRS_ORIENTATION` was changed from `15 (Yaw315Roll180)` to `0 (None)` in an
  earlier, separately authorised phase and has not been rebooted. It was not
  touched again here.

---

## 6. Status

Phase 8I is complete: capability-driven Gimbal, Logging and Scripting pages plus
Parameters integration, validated against both a SITL ArduCopter and a real
Pixhawk, with read-only guarantees intact and no fabricated data.

Hard stop here. Phase 8J does not begin without explicit approval.
