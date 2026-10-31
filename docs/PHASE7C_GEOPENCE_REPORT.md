# Phase 7C — GeoFence (Upload / Download / Verify / Clear)

**Date:** 2026-09-22
**Status:** ✅ COMPLETE

## Objective

Implement full GeoFence management for **ArduCopter (drone)** in YantraYug GCS: read/write the
fence parameters (`FENCE_ENABLE`, `FENCE_TYPE`, `FENCE_ACTION`, `FENCE_ALT_MAX`, `FENCE_ALT_MIN`,
`FENCE_RADIUS`, `FENCE_MARGIN`), upload/download/verify/clear fence *geometry* (polygon vertices +
circles + return point) over MAVLink mission protocol, stream live `FENCE_STATUS`, and surface it
all in the Planner GeoFence editor — with save/load of fence files.

## Verified ArduPilot fence protocol (reverse-engineered from AC_PolyFence_loader.cpp)

- Fence geometry is uploaded/downloaded with the **MAVLink mission protocol** using
  `MAV_MISSION_TYPE_FENCE = 1` (`mission_count`/`mission_item_int`), where command/param encode
  the fence element. The frontier to QGC: each vertex is its own item; vertex **count** is carried
  in `param1` of each vertex.
- **Commands:**
  - `5000` return point (at most one, no self-intersection constraints)
  - `5001` inclusion polygon vertex, `5002` exclusion polygon vertex
  - `5003` inclusion circle, `5004` exclusion circle — `param1` = radius in meters
- **Key protocol rule (the Phase 7C fix):** for polygon *vertices*, `param1` must equal the number
  of vertices in that polygon (e.g. a 3-vertex triangle sends three items each with `param1=3`).
  The backend auto-computes this per contiguous run of `5001`/`5002` items, so the frontend can
  leave `param1=0` and it is filled in before upload. Circles preserve their `param1` radius.
- After upload, ArduPilot reply `FENCE_TOTAL` counts all vertices + circles (return point not counted
  consistently — a 1-return + 3-vertex + 1-circle upload reported `FENCE_TOTAL = 5`).

## Implementation

| Component | Description |
|-----------|-------------|
| `backend/services/fence_service.py` | `upload_fence`, `download_fence`, `clear_fence`, `verify_fence`, `to_upload_items` (auto vertex-count), `to_frontend_points` |
| `backend/api/fence.py` | `POST /api/fence/upload`, `POST /api/fence/download`, `POST /api/fence/clear`, `POST /api/fence/verify` |
| `backend/mavlink/mission_command.py` | Fence commands 5000–5004, `MAV_MISSION_TYPE_FENCE=1`, fence support in `send_mission_count`/`send_mission_item_int`/`create_*` |
| `backend/mavlink/telemetry_manager.py` | `handle_fence_status` (msgid 162) → breach status/count/type |
| `backend/mavlink/stream_requester.py` | Requests `FENCE_STATUS` at 5 Hz (stream 500000) |
| `backend/mavlink/connection_manager.py` | Routes `FENCE_STATUS` → `handle_fence_status` |
| `frontend/src/api/fence.ts` | `uploadFence`, `downloadFence`, `clearFence`, `verifyFence` clients |
| `frontend/src/utils/fenceFile.ts` | `FenceFile` schema, `downloadFenceFile`, `parseFenceFile`, `loadFenceFile` |
| `frontend/src/hooks/useSocketTelemetry.ts` | Optional `fenceBreachStatus/Count/Type` stream fields |
| `frontend/src/components/FenceEditor.tsx` | Map + point list + Upload/Verify/Save/Load/Clear buttons + breach banner + footer breach status |

## Live SITL validation (ArduCopter 4.8.0-dev over UDP 14550)

### Parameters

Initial SITL state: `FENCE_ENABLE=0`, `FENCE_TYPE=7`, `FENCE_ACTION=1`, `FENCE_ALT_MAX=100`,
`FENCE_ALT_MIN=-10`, `FENCE_RADIUS=150`, `FENCE_MARGIN=2`, `FENCE_TOTAL=0`.

| Step | Result |
|------|--------|
| Write `FENCE_ENABLE=1`, `FENCE_ACTION=2`, `FENCE_ALT_MAX=50`, `FENCE_ALT_MIN=5` | All PARAM_VALUE echoes verified |
| Refresh | Live values match written values |
| Restore `FENCE_ENABLE=0` | SITL restored |

### Geometry round-trip (current session re-verified)

```
POST /api/fence/verify  (return + 3-vertex polygon + 60m circle = 5 items)
→ {"success": true, "count": 5}
  download returns 5000×1, 5001×3 (each param1=3.0), 5003×1 (param1=60.0)
Post-verify FENCE_TOTAL: 6.0 (ArduPilot count)
POST /api/fence/clear → {"success": true}  FENCE_TOTAL back to 0
```

### Frontend (vitest) — FenceEditor behavior

327 → **328** tests passing. Breach banner test scope-fixed (text now asserted inside
`data-testid="fence-breach"` banner); file-save test now awaits the async download before clicking.

## Real-hardware validation (Pixhawk1, ArduCopter 4.7.0 Official, serial `/dev/ttyACM0` @ 115200)

Connected via the **Serial** link the UI already exposes. Full stack verified live:

| Check | Result |
|-------|--------|
| Connect | HEARTBEAT received over USB serial |
| Firmware | ArduCopter 4.7.0 (Official), `flightSwVersion=67567871` |
| Parameter sync | 991/991 params, 0 missing, 0 retries |
| Fence upload | Accepted (MISSION_ACK code 0), `FENCE_TOTAL=6` |
| Fence download | All 5 points returned with polygon `param1=3.0` + circle `param1=60.0` |
| Verify round-trip | **3/3 passed** (return + 3-vertex polygon + 60m circle) |
| Clear | `FENCE_TOTAL` back to 0 |

**Real-hardware discovery (not reproducible on SITL 4.8):**
1. **Fence download is gated on `FENCE_ENABLE=1`.** On the Pixhawk, `MISSION_COUNT`
   reports 0 while `FENCE_ENABLE=0` even though `FENCE_TOTAL` had the geometry.
   Enabling the fence makes download return the full count.
2. **Fence uploads activate asynchronously.** After `MISSION_ACK`, the new geometry
   is not immediately visible — an immediate `MISSION_REQUEST_LIST` returned the old
   count (0) for up to ~1s. Fixed with a settle-poll in
   `upload_fence` → `_wait_for_fence_activation()` (poll download until the count
   matches, 3s window, then give up politely). SITL 4.8 activates synchronously, so
   this path is a no-op there.

## Regression (final state of Phase 7C)

| Suite | Result |
|-------|--------|
| Backend pytest | **260 passed** (248 → +12; fence service + api + verify + async settle) |
| Frontend vitest | **328 passed** (317 → +11; 6 fenceFile + 4 FenceEditor + 1 verify) |
| TypeScript `tsc -b` (frontend) | clean |
| oxlint | 0 errors |

## Files

### New
- `backend/services/fence_service.py` (upload/download/clear/verify + vertex-count logic)
- `backend/api/fence.py`
- `backend/tests/test_fence_service.py`, `backend/tests/test_fence_api.py`
- `frontend/src/utils/fenceFile.ts` + `frontend/src/utils/fenceFile.test.ts`
- `frontend/src/components/FenceEditor.test.tsx`
- `docs/PHASE7C_GEOPENCE_REPORT.md`

### Modified
- `backend/mavlink/mission_command.py` — fence mission type + 5000–5004 commands
- `backend/mavlink/telemetry_manager.py` — `handle_fence_status`
- `backend/mavlink/stream_requester.py` — FENCE_STATUS 5 Hz
- `backend/mavlink/connection_manager.py` — FENCE_STATUS handler routing
- `backend/app.py` — fence router registration
- `backend/services/fence_service.py` — async-activation settle (`_wait_for_fence_activation`)
- `frontend/src/api/fence.ts` — verify client
- `frontend/src/components/FenceEditor.tsx` — Verify button, breach banner, save/load file buttons
- `frontend/src/hooks/useSocketTelemetry.ts` — fence breach fields
- `frontend/src/components/FenceEditor.test.tsx`

## Design rules observed

- **No raw MAVLink in React** — all protocol in backend services; frontend talks to `/api/fence/*`.
- **ArduCopter only** — no Rover/Plane assumptions anywhere.
- **Backend auto-computes vertex counts** so the UI never has to reason about `FENCE_TOTAL`/vertex
  membership; the round-trip diff is authoritative (verify compares command/lat/lng/param1 per item).
- **Clear = upload empty list**, matching ArduPilot's accepted semantics.