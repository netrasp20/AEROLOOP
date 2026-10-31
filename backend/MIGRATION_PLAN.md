# Yantrayug GCS — Backend Migration Plan (Node.js → Python)

> **Phase 1 — Analysis only (this document).** No Python code is written yet.
> The React + Vite + TypeScript **frontend is not touched at all**. It must remain
> byte-for-byte identical and be fully functional after every migration step.

---

## 1. Objective & target stack

Replace the **backend** Node.js + Express + TypeScript + socket.io + node-mavlink
+ serialport stack with a Python stack, keeping every public contract identical:

| Layer | Current (Node) | Target (Python) |
|-------|----------------|-----------------|
| HTTP/REST | Express + CORS | FastAPI + CORSMiddleware |
| Realtime | socket.io | python-socketio (async) |
| Startup | ts-node/tsx | Uvicorn |
| MAVLink parsing | node-mavlink (custom) | pymavlink |
| Serial I/O | serialport | pyserial |
| Config | dotenv | python-dotenv |
| Mission storage | in-memory + JSON | in-memory + JSON (same semantics) |

**Hard rules**
- All REST endpoint paths, methods, payloads and response status codes identical.
- All Socket.IO event names, direction, and payload shapes identical.
- Frontend is the single verified consumer — if it still works unchanged, the migration is correct.
- Migrate module-by-module and verify the real frontend ↔ SITL flow after each module.
- Do **not** delete the Node backend until the Python backend reaches full parity.

---

## 2. REST API inventory (source of truth to reproduce)

Base URL for the frontend: `http://localhost:5000`.

### 2.1 Vehicle — `vehicle.routes.ts` → `/api/vehicle`

| Method | Path            | Request body                             | Success response                          | Error behavior        |
|--------|-----------------|------------------------------------------|-------------------------------------------|-----------------------|
| GET    | `/api/vehicle/serial-ports` | –                          | `{ success:true, ports: string[] }`       | 5xx `{success:false,error}` |
| POST   | `/api/vehicle/connect`     | `{ connectionType, host?, port?, device?, baudRate? }` | `{...ConnectResult}` (success flags) | 503/4xx/5xx |
| POST   | `/api/vehicle/disconnect`  | –                          | `{...DisconnectResult}`                   | 5xx |
| GET    | `/api/vehicle/status`      | –                          | `getVehicleStatus()` — full vehicle state | 5xx |
| POST   | `/api/vehicle/arm`         | –                          | `{success:true, message}`                 | 400 `{message, ackCode?, ackLabel?, statusText?}` |
| POST   | `/api/vehicle/disarm`      | –                          | `{success:true, message}`                 | 400 `{message, ackCode?, ackLabel?}` |
| POST   | `/api/vehicle/mode`        | `{ mode: string }`          | `{success:true, message, mode}`           | 400 `{message, ackCode?, ackLabel?}` |
| POST   | `/api/vehicle/home`        | `{ lat?, lon?, alt? }`     | `{success:true, message:"Home location set."}` | 400 |

Notes on guardrails preserved identically (in `vehicle.controller.ts`):
- `arm/disarm/mode/home` reject with **400** `{success:false, message:"Vehicle is not connected."}` when not connected. `connected` = `serialPortOpen` && heartbeat within 10 s.
- `arm` additionally rejects with 400 `{success:false, message:"Mission not uploaded. Please upload a mission first."}` if no mission is uploaded.
- ackCode/ackLabel/statusText come from the FAILURE command ack and are echoed verbatim.

### 2.2 Remote mission (`mission.routes.ts`) → `/api/mission`
| Method | Path | Notes |
|--------|------|-------|
| GET  | `/api/mission`        | current mission |
| POST | `/api/mission`        | save current mission |
| DELETE | `/api/mission`      | clear current mission |
| POST | `/api/mission/start`  | start mission (REST path) |

### 2.3 Mission storage (`missionStorage.routes.ts`) → `/api/missions`
| Method | Path | Notes |
|--------|------|-------|
| GET    | `/api/missions`          | list saved missions |
| POST   | `/api/missions/save`     | save named mission |
| GET    | `/api/missions/:id`      | load by id |
| DELETE | `/api/missions/:id`      | delete by id |
| PUT    | `/api/missions/:id/rename` | rename |
| POST   | `/api/missions/:id/duplicate` | duplicate |

### 2.4 SITL (`sitl.routes.ts`) → `/api/sitl`
| Method | Path | Notes |
|--------|------|-------|
| POST | `/api/sitl/start`  | spawn SITL |
| POST | `/api/sitl/stop`   | stop SITL |
| GET  | `/api/sitl/status` | SITL status |

### 2.5 Telemetry (`telemetry.routes.ts`) → `/api/telemetry`
| Method | Path | Notes |
|--------|------|-------|
| GET  | `/` | current telemetry snapshot |

### 2.6 Video / RTSP / WebRTC (`video.routes.ts`) → `/api/video`
| Method | Path |
|--------|------|
| POST  | `/video/start` |
| POST  | `/video/stop` |
| GET   | `/video/stream/:id` |
| POST  | `/video/record/start` |
| POST  | `/video/record/stop` |
| GET   | `/video/record/status` |
| POST  | `/video/webrtc/start` |
| POST  | `/video/webrtc/stop` |
| GET   | `/video/webrtc/status` |

> Video/RTSP/WebRTC are the **lowest priority** for migration — they depend on external
> streams and are only wired by the front-end at the "camera" panel. They can be re-implemented
> last (Phase 6) or initially stubbed with the same contract.

---

## 3. Socket.IO contract inventory

Underlying: Socket.IO (not raw WebSocket). `const socket = io("http://localhost:5000")` in `frontend/src/lib/socket.ts`.

### 3.1 Frontend → Backend (server listeners)
| Event | Payload | Handler file |
|-------|---------|--------------|
| `mission:start`      | `{}`            | `socket/mission.socket.ts` |
| `mission:start:auto` | `{}`            | `socket/mission.socket.ts` |
| `mission:rtl`        | `{}`            | `socket/mission.socket.ts` |
| `mission:upload`     | `{ home, waypoints }` | `socket/mission.socket.ts` |
| `mission:verify`     | `{ waypoints }` | `socket/mission.socket.ts` |
| `mission:set-current` | `{}`           | `socket/mission.socket.ts` |
| `data` / `close` / `disconnect` / `error` | – | `socket/socket.ts` |

### 3.2 Backend → Frontend (socket instances)
| Event | Payload (shape) | Emitter |
|-------|-----------------|---------|
| `mission:progress`     | `{ phase, current?, total?, ... }` | mission.service / upload |
| `mission:success`      | `{ message?, count }`             | mission.service |
| `mission:error`        | `{ message }`                     | mission.service |
| `mission:start:progress` | progress batch | missionStart |
| `mission:start:success`  | `{ message }`              | missionStart |
| `mission:start:error`    | `{ message, statusText? }` | missionStart |
| `mission:auto:progress`  | `{ message, phase?, ... }` | missionStart auto branch |
| `mission:auto:success`   | `{ message }`            | missionStart auto branch |
| `mission:auto:error`     | `{ message, statusText? }`| missionStart auto branch |
| `mission:rtl:progress`   | `{ message }`        | rtl.service |
| `mission:rtl:success`    | `{ message }`        | rtl.service |
| `mission:rtl:error`      | `{ message }`        | rtl.service |
| `mission:completed`      | `{ message }` (optional) | mission.service (landing gate) |
| `mission:verify:result`  | `VerificationResult`  | missionVerifier |
| `mission:status`         | mission status snapshot | mission.service |
| `telemetry:update`       | partial `TelemetryData` (delta-merged) | `mavlink/telemetryManager.ts` |
| `vehicleStatus`          | `{ connected, mode, armed, ... }` | `socket/socket.ts` broadcast |

### 3.3 Critical: telemetry semantics
`telemetry:update` is a **delta broadcast**: `emitIfChanged()` serializes the whole
`TelemetryData` snapshot and only emits when it has changed; each event carries the **full**
snapshot but the frontend merges it with `{...prev, ...data}`. Fields observed:
`mode, armed, altitude, relativeAltitude, groundSpeed, heading, batteryVoltage,
batteryCurrent, batteryRemaining, gpsFix, hdop, satellites, homeLatitude, homeLongitude,
distanceToHome, atHome, missionUploaded, missionCurrent, missionReached, missionRunning,
missionCompleted, missionTotalDistance, statusText, timestamp, systemId, componentId,
vehicleType, autopilot, latitude, longitude, pitch, roll, yaw, connected`.

The UI hooks (`useSocketTelemetry.ts` → `TelemetryProvider`) listen to **`telemetry`** for a
small subset (mode/armed/alt/gs/heading/battery/satellites/distance/pitch/roll/yaw), while the
dashboard listens to `telemetry:update`. Both event names must be preserved in Python.

---

## 4. Backend services / files inventory (current, Node)

Total ~6 149 lines across `src/**/*.ts`.

- **controllers/** — `vehicle.controller`, `mission.controller`, `missionStart.controller`,
  `missionStorage.controller`, `sitl.controller`, `telemetry.controller`.
- **routes/** — `vehicle.routes`, `mission.routes`, `missionStorage.routes`, `sitl.routes`,
  `telemetry.routes`, `video.routes`.
- **services/** — `vehicle.service`, `mission.service`, `missionStart.service`,
  `missionUpload.service`, `missionStorage.service`, `missionDownload.service`, `rtl.service`,
  `telemetry.service`, `sitl.service`, `serialPort.service`, `rtspProxy.service`.
- **mavlink/**
  - commands: `ArmCommand`, `ModeCommand`, `MissionCommand`, `MissionVerifier`
  - `command.service` (mode tables, arm, home)
  - connection: `ConnectionManager`, `TcpTransport`, `UdpReceiver`, `HeartbeatManager`
  - `HeartbeatManager` / `heartbeat.ts`
  - `connectionWatcher.ts`, `index.ts`, `mavlinkSender.ts`, `mavlink.service.ts`
  - `serial.service.ts`, `vehicleState.ts`, `telemetryManager.ts`
  - `streamRequester.ts` (stream rate requests)
  - state: `VehicleState.ts`
  - telemetry: `TelemetryParser.ts`
  - transport: `MavlinkEncoder.ts`, `TcpConnection.ts`, `UdpSender.ts`, `UdpTransport.ts`
- **models/** — `mission.model.ts` (types: `Home`, `Waypoint`, `Mission`, `MavlinkMissionItem`,
  `VerificationMismatch`, `VerificationResult`, `UploadProgress`).
- **socket/** — `socket.ts` (CORS *, connect handling), `mission.socket.ts`, `telemetry.socket.ts`.
- **app.ts** — Express + `cors()` (any origin) + JSON body; mounts routers.
- **server.ts** — create server, attach socket.io, bind `:5000`.

---

## 5. MAVLink interaction inventory

Layer | Node | Python (pymavlink) equivalent
------|------|------------------------------
Encode/decode frames | custom `MavlinkEncoder` | `pymavlink` `mavutil.mavlink`
Transport select | `TcpTransport`/`UdpTransport` per `connectionType` | `mavlink_connection(url)` (tcp:…/udp:…/serial:…)
Heartbeat detect | `HeartbeatManager`, 10 s timeout | monitor `HEARTBEAT` msgs; SRC (systemId/componentId)
Stream requests | `streamRequester` (set MESSAGE_INTERVAL / request data streams) | MAV_CMD_SET_MESSAGE_INTERVAL equivalent via `mavutil`
Mode set | `CommandService.setMode` with `COPTER_MODES` vs `ROVER_MODES` selections via `isAirVehicle()` | `mavutil.set_mode` + custom mapping tables
Arm/disarm | `ArmCommand` | `mavutil.mav.command_long_send(MAV_CMD_COMPONENT_ARM_DISARM)`
Home | `setHome` | `mavutil.mav.command_long_send(MAV_CMD_DO_SET_HOME)`
Mission upload | `MissionCommand` + verifier | iterate `MISSION_COUNT`+`MISSION_ITEM_INT`+ack, then `MissionVerifier`
Mission current | `setMissionCurrent` | MAV_CMD_DO_SET_MISSION_CURRENT (only real on copter)
Takeoff | `maavutil.mav.command_long_send(MAV_CMD_NAV_TAKEOFF)` | same
RTL | mode switch / `MAV_CMD_NAV_RETURN_TO_LAUNCH` | same
SITL spawn | `sitl.service` (child process) | `subprocess` + `subprocess.Popen`

**Mode tables** (must port exactly, from `command.service.ts`):
- `COPTER_MODES` (air): AUTO=3, GUIDED=4, RTL=6, STABILIZE=0, ALT_HOLD=2, LOITER=5, LAND=9…
- `ROVER_MODES` (ground): AUTO=10, RTL=11, GUIDED=15, etc.
- `getSafeArmMode()` → STABILIZE (air) / HOLD (ground)
- `isModeArmable()` rejects RTL, LAND, SMART_RTL, THROW, BRAKE, AUTOROTATE, AUTO_RTL,
  GUIDED_NOGPS, INITIALISING.
- Auto-start pre-arm flow in `missionStart` (auto branch): ensure mission current = 1,
  switch to safe mode if current mode not armable, arm → NAVID_TAKEOFF → AUTO → run WP loop.

**Landing gate** (`telemetryManager.ts`): `waitForLanding()` completes when `relative_alt <= 1.0 m`
or vehicle disarmed; poll every 500 ms; 60 s timeout. Completing flight only after both RTL
horizontal success AND this landing gate → resposition dispatches `mission:completed`.
Constants: `LANDING_ALT_THRESHOLD_M = 1.0`, `LANDING_TIMEOUT_MS = 60000ms`, `LANDING_POLL_MS = 500`.

---

## 6. One-to-one file mapping (Node → Python)

```
backend/
  app.py                 (FastAPI instance, CORS, mount routers — ~ app.ts + server.ts)
  main.py                (uvicorn entry: creates app, attaches socketio, binds :5000)
  requirements.txt
  config.py              (dotenv: PORT=5000, SITL_* etc.)
  core/
    __init__.py
    config.py
    models.py            (Home, Waypoint, Mission, MavlinkMissionItem, Verification*,
                          TelemetryData, UploadProgress — ~ mission.model.ts)
  api/                    (== routes + controllers)
    __init__.py
    routes.py             (register all routers)
    vehicle.py            (/api/vehicle/*)
    mission_remote.py     (/api/mission/*)
    mission_storage.py    (/api/missions/*)
    sitl.py               (/api/sitl/*)
    telemetry.py          (/api/telemetry/*)
    video.py              (/api/video/*)
  services/               (business logic — mirrors src/services/*)
    vehicle_service.py
    mission_service.py
    mission_start_service.py
    mission_upload_service.py
    mission_storage_service.py
    mission_download_service.py
    rtl_service.py
    telemetry_service.py
    sitl_service.py
    serial_service.py
    rtsp_proxy.py
  mavlink/                (mirrors src/mavlink/*)
    connection_manager.py
    udp_transport.py      (TcpTransport/UdpTransport)
    serial_transport.py
    heartbeat_manager.py
    vehicle_state.py
    telemetry_parser.py
    telemetry_manager.py  (delta emit + landing gate + MISSION_COMPLETED)
    command_service.py    (COPTER_MODES/ROVER_MODES, safe mode, arm/disarm/home)
    arm_command.py
    mode_command.py
    mission_command.py
    mission_verifier.py
    mavlink_sender.py
    stream_requester.py
    mavlink_service.py
    index.py
  socketio/               (== src/socket/*)
    server.py              (attach socketio, connect/disconnect, get_io helpers)
    mission_handlers.py    (mission:*, list *:rtl, *:upload, *:verify, *:set-current)
    telemetry_handlers.py  (telemetry:*, vehicleStatus broadcast)
  persistent/              (mission storage backend, JSON-in-memory like Node)
    __init__.py
    json_store.py
```

> pymavlink abstracts the encoder/transport/parser into a single `mavutil` call — so the map
> above is intentionally a **domain-in-flank** mapping (one Python nav_*,  1:1 where it matters).

---

## 7. Migration strategy (phased, module-by-module, verified)

Principle: **every phase ends with the frontend working unchanged.** Run SITL + the frontend and
verify each row separately. Node backend stays until Phase 6 parity.

- **Phase A — Skeleton + REST parity.** FastAPI app with CORS enabling all origins, `app.py` +
  uvicorn on `:5000`; mount `/api/vehicle/status` + `/api/telemetry` first. Verify: hit endpoint
  via curl / browser; response shape byte-identical.
- **Phase B — MAVLink + SIP?** pymavlink UDP connection to SIT (5760), heartbeat detection,
  10 s timeout, `vehicleState` mirror, stream rate requests. Verify: `/api/vehicle/status` shows
  connected=true; heartbeat console logs match Node.
- **Phase C — Telemetry stream.** Implement import telemetry parser + delta emit; wire
  `telemetry:update` + `telemetry` events over python-socketio. Verify: frontend map/altitude/
  armed/mode widgets update live, **no frontend change**.
- **Phase D — Mission + arm.** Command service (mode tables, safe-mode, arm/disarm/home),
  upload/verify, mission start/RTL + the auto-start flow. Verify: full takeoff→WP→RTL→landing
  cycle on SIT with button wiring identical.
- **Phase E — Storage & SITL service.** `/api/missions/*` JSON store, `/api/sitl/*` spawn/stop.
  Verify: save/load via frontend still works.
- **Phase F — Video/RTSP (optional, last).** Re-implement `/api/video/*`.
- **Phase G — Parity gate & teardown.** Run the Node and Python backends side-by-side, diff all
  events with a probe; when the Python backend handles the full feature set, remove the Node
  backend.

**At each phase:** verify first (developer confirms), then proceed to build the next step.
No Flake — ask the developer before proceeding to the surprise/#verification step.

---

## 8. Open items before implementation
1. Confirm `connectionType` values supported: `"tcp"` / `"udp"` (and serial `device+baudRate`).
2. SITL default target port is 5760 (`tcp:127.0.0.1:5760`, bridge → udp:14550) — confirm this
   should be preserved as the default.
3. Whether python-socketio must operate on the **same** port as FastAPI (design respects) or a
   separate port. Simultaneously: python-socketio AsyncHTTP vs ASGI integration with Uvicorn.
4. Confirmed Python version & dependency availability in this environment (pip install
   `fastapi uvicorn python-socketio pymavlink python-dotenv pyserial` — architecture (Linux).

---

## 9. Approval gate
This is an analysis-only deliverable. No Python code is written.
On approval, implementation starts at **Phase A** and proceeds only with developer confirmation
after each phase.