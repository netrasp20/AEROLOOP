# Phase 8D — QGC-style FIRMWARE Page (ArduCopter-only, honest capability)

**Date:** 2026-09-24
**Status:** ✅ COMPLETE — live-validated on **real Pixhawk1** and **ArduCopter SITL**

> Setup → Firmware is now a QGC-style firmware workflow page with the full
> page-state model (Waiting for vehicle / Connecting / Reconnecting / Vehicle
> detected-identifying / Firmware info loading / Ready / Connection lost /
> Error / Unsupported vehicle). It identifies the connected autopilot and
> firmware in real time via the `AUTOPILOT_VERSION` MAVLink request, is honest
> that **firmware installation and a release catalog do not exist** in
> YantraYug, and restricts firmware services to **ArduCopter only**. Every value
> shown is read live from the vehicle — nothing is fabricated, no flashing
> controls fake progress, and there is no selectable channel without a real
> catalog.

---

## Scope (QGC firmware-parity model implemented)

| QGC behaviour | YantraYug equivalent |
|---|---|
| Page states wait for the vehicle before any firmware UI | NO VEHICLE / CONNECTING / RECONNECTING / VEHICLE DETECTED–IDENTIFYING / FIRMWARE INFO LOADING / READY / CONNECTION LOST / ERROR / UNSUPPORTED VEHICLE, all derived from the same authoritative connection state as the rest of the app (never a frontend timer) |
| Firmware identity from the vehicle itself | `MAV_CMD_REQUEST_MESSAGE` → `AUTOPILOT_VERSION` (msgid 148), 5 s timeout, decoded version/release/build/board/vendor/product/UID |
| Board type/rev | Decoded from `board_version` (`boardType . boardRev`, e.g. live Pixhawk1 → `0.9`) |
| ArduCopter-only restriction | Backend `supported: false` + reason for Plane / Rover / PX4 / unknown; frontend "Unsupported vehicle — YantraYug Firmware Setup currently supports ArduCopter only" |
| Firmware catalog | Honest `releaseCatalog: unavailable` + catalogMessage; no fake release list, no hardcoded "available" versions |
| Firmware channel selection | Explicitly *not* rendered — the availability card states "No channel selection available" |
| Firmware installation | Honest `firmwareInstallation: not-available`; a real but **disabled** "Install firmware — unavailable" control; no fake progress/erase/reboot/success |
| Re-query | Re-issues a real `AUTOPILOT_VERSION` request with a loading state; no browser reload; timeout/error handled; READY restored on success |
| Reconnect | On link loss the page shows CONNECTION LOST; when the link is restored the same page (no reload) re-queries and returns to READY |
| Summary ↔ Firmware sync | Both pages read the **same** backend `/api/setup/firmware` source of truth; the Summary firmware card now links to the Firmware page and re-queries on mount |
| Compatibility only when provable | Compatibility row shows "Supported" only for an identified ArduPilot Copter; optional identity fields fall back to "—" rather than guesses |

## Page-state machine (single authoritative source)

The page never keeps its own connection state — it derives everything from the
Phase-8C authoritative telemetry (`telemetry.connected` +
`connectionState` + `disconnectReason`, which come from backend
`connection_state` events):

```
DISCONNECTED + no reason           -> Waiting for vehicle
connectionState == CONNECTING      -> Connecting to vehicle
connectionState == CONNECTING + reason (re-link after loss) -> Reconnecting
CONNECTED  + info == null          -> Vehicle detected / Identifying
CONNECTED  + info success && loading -> Firmware info loading (re-query)
CONNECTED  + info success          -> READY (Vehicle / Current Firmware /
                                       Firmware Availability / Firmware
                                       Installation / Status cards)
CONNECTED  + info failed           -> ERROR with reason + Retry
CONNECTED  + info.success &&
            info.supported == false-> UNSUPPORTED VEHICLE (identity shown,
                                       ArduCopter-only notice, no firmware
                                       controls)
DISCONNECTED + disconnectReason    -> CONNECTION LOST (reason shown)
```

## What was implemented

### Backend (`services/setup_service.py`)
- **Supported-target detection** — `_supported_vehicle()`:
  ArduPilot + Copter MAV type → `supported: true`; anything else (Plane/Rover/
  PX4/unknown) → `supported: false` **with** a human `unsupportedReason`
  ("YantraYug Firmware Setup currently supports ArduCopter only. …").
  Returned alongside the existing identity fields so the frontend never has to
  guess. Non-copter/unknown identities are still reported verbatim, never
  co-opted into "ArduCopter".
- `GET /api/setup/firmware` unchanged shape otherwise (identification →
  `AUTOPILOT_VERSION` via `MAV_CMD_REQUEST_MESSAGE`, 5 s timeout → clean error).
- `GET /api/setup/firmware/capability` already honest: `firmwareIdentification:
  available`, `firmwareInstallation: not-available`, `releaseCatalog:
  unavailable`, `supportedTargets: [ArduPilot Copter]`.

### Frontend
- **`api/setup.ts`** — `FirmwareInfo` extended (release/boardType/boardRev/
  vehicle/autopilotLabel/system/component/connectionType/connected/**supported**/
  **unsupportedReason**); new `FirmwareCapability` + `getFirmwareCapability()`.
- **`hooks/useFirmwareInfo.ts`** — fetches firmware info + capability together;
  on capability failure the page falls back to the **honest unavailable**
  report; clears state on disconnect; re-runs when the connection flips.
- **`components/setup/SetupFirmware.tsx`** — full rebuild: 8-page-state model,
  VEHICLE card (live identity), CURRENT FIRMWARE card with Re-query, FIRMWARE
  AVAILABILITY (catalog + channel honestly unavailable), FIRMWARE INSTALLATION
  (not available + disabled control), STATUS card (last real query time), and
  the UNSUPPORTED VEHICLE state.
- **`components/setup/SetupSummary.tsx`** — firmware card now has a **Firmware
  page** link (`onNavigate("firmware")`) and remains on the same backend source
  of truth.
- **`styles/setup.css`** — styling for the new availability/installation/status
  groups and error/ok colors (dark, violet YantraYug palette).

## Testing

### Backend — `tests/test_firmware.py` (23 tests, +6 new in this phase)
New scenarios: ArduCopter `supported: true`; non-copter (FIXED_WING)
verbatim + `supported: false` + reason; PX4 `supported: false` with identity;
unknown vehicle type unsupported with reason; **timeout** → clean "timed out"
error; **re-query returns a fresh payload** (4.7.0 Official → 4.10.0 Beta +
new custom/UID); **invalid all-zero payload** decodes to `0.0.0 (Development)`.
Existing coverage retained (full identity decode, board decode, release
labels, capability honesty, disconnected, no-install-route 404/405, connection
state lifecycle).

`pytest`: **436 passed** (was 430).

### Frontend — `SetupFirmware.test.tsx` (17 tests) + Summary link test
Scenarios: NO VEHICLE (no stale firmware), CONNECTING, RECONNECTING, CONNECTION
LOST (reason shown), IDENTIFYING/LOADING, READY details, READY vehicle card,
missing-optional placeholders, RE-QUERY fresh payload, ERROR + Retry recovery,
connected-only failure, UNSUPPORTED vehicle (controls hidden), catalog + channel
honestly unavailable, installation not-available + disabled control, genuinely-
available surface, reconnect-without-reload re-query, last-queried status.
`SetupSummary.test.tsx` +1: firmware-card link calls `onNavigate("firmware")`.

`vitest`: **371 passed** (was 353). `tsc --noEmit` clean, `oxlint` clean
(no new findings), `vite build` clean.

## Live validation

### Real Pixhawk1 (the authoritative target)
`/dev/ttyACM0` · ArduPilot Pixhawk1 · ArduCopter · QUADROTOR · STABILIZE.

```
GET /api/setup/firmware
  version           4.7.0 (Official Release)   custom 1511f271
  boardVersion      589824   boardType 0   boardRev 9
  vendor 4617 / product 22337   uid 0x0 (this unit reports 0)
  vehicle ArduCopter  autopilotLabel ArduPilot  connectionType USB
  supported true

GET /api/setup/firmware/capability
  firmwareIdentification available
  firmwareInstallation   not-available
  releaseCatalog         unavailable
  supportedTargets       [ {ArduPilot, Copter} ]
```
Firmware page renders READY: VEHICLE (ArduCopter/ArduPilot/USB/QUADROTOR),
CURRENT FIRMWARE (4.7.0 Official, 1511f271, 0.9, 4617/22337, UID 0x0),
AVAILABILITY (catalog + channel unavailable), INSTALLATION (not available +
disabled control), STATUS (live sync, last-queried time).

### ArduCopter SITL (separate live instance proves real, non-fabricated reads)
`arducopter --model quad` (TCP :5760) → mavproxy → backend UDP :14550
(`AUTO_CONNECT_SERIAL=false` for the isolated check):

```
version 4.8.0 (Development)   custom d16ddbab
boardVersion 0  boardType 0  boardRev 0    connectionType UDP
vehicle ArduCopter  autopilotLabel ArduPilot   supported true
```

The SITL identity (4.8.0 Development / board 0 / UDP) is **differently real**
from the Pixhawk (4.7.0 Official / board 0.9 / USB) — proving the page displays
the live vehicle and never fabricates firmware values.

### Auto-reconnect (Phase-8C behaviour re-verified during Phase 8D)
After the SITL runs, restarting the backend with `AUTO_CONNECT_SERIAL=true`
automatically re-established the **real Pixhawk1 serial session** and the
firmware page returned to READY with the Pixhawk's own data — no browser
reload required.

## Honesty checklist

- [x] No fabricated firmware/board/version/UUID/vendor/product/OS values — missing → "—" / "Unknown"
- [x] No fake firmware catalog — `releaseCatalog: unavailable` + note
- [x] No fake selectable channels — "No channel selection available"
- [x] No fake install/advanced controls — real but **disabled** "Install firmware — unavailable"; no progress/erase/success
- [x] Unsupported vehicles (Plane/Rover/PX4/unknown) are named explicitly; ArduCopter-specific controls hidden
- [x] Compatibility shown only when provable (ArduPilot + Copter)
- [x] Re-query = real request with loading + timeout/error handling; reconnect re-queries without a browser reload
- [x] Firmware page and Summary firmware card share the same backend source of truth
- [x] Execution is **read-only** — no parameters are written, no flashing performed

---

## HARD STOP — Phase 8D COMPLETE

Do **NOT** start Phase 8E (Radio / Power / Safety / Flashing). No firmware
flashing was implemented in this phase (by design). Next release work: none
from this phase.