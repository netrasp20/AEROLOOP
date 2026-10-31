# PHASE 8E — RADIO SETUP — RESULT REPORT

**Status:** PASS
**Date:** 2026-09-24
**Hard stop respected:** nothing beyond Radio was touched (Power/Safety/Motors/etc. remain inactive screens).

## What was delivered

A QGC-style **Radio** setup page (`frontend/src/components/setup/SetupRadio.tsx`) with:

1. **Vehicle & RC signal card** — MAVLink link state, vehicle, autopilot, mode, transport, RSSI. The RC receiver signal is judged *only* from fresh `RC_CHANNELS` telemetry (stale frames are never presented as live; `RC_STALE_MS = 2000`; ArduPilot rssi `0` = no valid RC link). Honest states: `WAITING` (no RC frame yet), `RECEIVING`, `NO_SIGNAL`, plus the stable connected/lost/syncing/unsupported page states.
2. **Channel Monitor** — live channel bars fed from the backend's genuine RC telemetry (`telemetry.rcChannels`), with a freshness badge and a note when data is stale.
3. **Main Control Channels** — Roll/Pitch/Throttle/Yaw read from the vehicle's **genuine** `RCMAP_*` parameters, never assumed CH1–CH4.
4. **Channel Configuration** — per-channel `RCn_MIN/TRIM/MAX/REVERSED` editors validated (900–2200 µs, MIN < TRIM < MAX), staged and written through the existing **verified write pipeline** (ParameterContext `stageValue` + `executeWrite`, with write-ahead read-back of echoed values). A failed/interrupted write drops staged+edits and shows honest live readback; a successful write clears the local "touched" edits so inputs re-read the verified vehicle values.
5. **Radio Calibration** — real wizard backed by the backend state machine (`idle → ready → capturing-center → center-done → capturing-min → min-done → capturing-max → validating → completed/failed/cancelled/timeout`). Starting requires a live RC signal; the calibration always reads actual stick telemetry, never simulated values.

## Backing store (backend)

- `services/radio_service.py` — live snapshot (`GET /api/setup/radio`): identity, signal, rc monitor, RCMAP main controls, channel config, calibration status.
- `services/radio_calibration.py` — full serial calibration FSM + endpoints (`/radio/calibration/start|capture|stop|status`).
- `mavlink/telemetry_manager.py` — real `RC_CHANNELS` ingestion (raw PWM per channel, rssi, freshness). Nothing is synthesised.
- `mavlink/stream_requester.py` — requests the `RC_CHANNELS` stream at connect.
- Parameter writes are the shared verified `write_parameter` path already proven in earlier phases.

## Automated tests

- **Backend:** `tests/test_radio.py` + `tests/test_connection_loss.py` → **47 passed** (includes `test_explicit_stop_broadcasts_and_zeros_stale_radio_data`). Full backend regression → **472 passed**.
- **Frontend:** `SetupRadio.test.tsx` → **28 passed** (incl. "repopulates the channel configuration after a reconnect without a reload"); `SetupConfig.test.tsx` (radio activation/nav) → **12 passed**. Full frontend suite → **400 passed**.
- `npx tsc --noEmit` clean; `npx oxlint` clean for SetupRadio/useRadioSetup; `vite build` succeeds.

## Live validation (real SITL ArduCopter + real Pixhawk 1 via USB)

### SITL (`AUTO_CONNECT_SERIAL=false`, UDP :14550)
- `/api/setup/radio`: connected UDP, `signal=WAITING` (honest — SITL provides no real RC receiver), transport `UDP`.
- **Verified write pipeline end-to-end on the live link:**
  - `RC1_TRIM` read-back = `1500`
  - write `1560` → success → read-back `1560`
  - restore `1500` → read-back `1500`
- `POST /radio/calibration/start` refused correctly without a live RC signal.

### Real Pixhawk 1 (USB `/dev/ttyACM0`, ArduPilot)
- `/api/setup/radio`: connected `USB`, `supported=true`; RC receiver not bound → honest `signal=WAITING / "Waiting for the first RC_CHANNELS frame…"`, RSSI `255`, monitor shows waiting.
- **Genuine** main controls: Roll→`RCMAP_ROLL`→CH1, Pitch→CH2, Throttle→CH3, Yaw→CH4.
- **Genuine** channel config read live from the vehicle (not phoney 1500s):
  - CH1 `1082 / 1547 / 1894`
  - CH2 `1000 / 1499 / 1999`
  - CH3 `1006 / 1006 / 1995` (throttle trim genuinely low)
  - CH4 `1000 / 1500 / 1995`
- Parameter read verified live: `/api/parameters` returns the full set (991 incl. `RC1_TRIM=1547.0`); `sync:COMPLETE` 991/991 observed over the socket.
- Calibration idle.
- `docs/evidence/phase8e-setup-radio-live-pixhawk.png` — live UI screenshot showing the above.

### Disconnect (explicit stop) — verified live on the Pixhawk
- `_teardown` now: `reset_radio_calibration()` + `reset_telemetry()` (zeroes `rcChannels`→`[]`, `rcChannelCount`→`0`, `rcRssi`→`0`, `rcReceivedAt`→`0`, `rcSignal`→`NO_SIGNAL`) + `tm.reset_home_position()`, then broadcasts `connection_state DISCONNECTED` (reason), emits `telemetry:update` with the zeroed payload, broadcasts `vehicleStatus`.
- Raw socket confirms the honest sequence on disconnect: `param:session disconnected` → `connection_state {"state":"DISCONNECTED","reason":"Connection closed"}` → `telemetry:update conn=false rssi=0 ch=[]`.
- Page (raw capture): switches to the lost branch (`setup-radio-lost`), config rows and stale rssi/signal cleared, calibration panel gone, connection chip `Disconnected`.

### Reconnect (auto) — verified live on the Pixhawk
- Backend auto-reconnects to the same device ~1.4–3 s after the disconnect and starts a fresh parameter session (`sync:start` … `sync:COMPLETE` 991/991).
- The radio page re-populates **without a browser reload**: after reconnect the snapshot is temporarily blank (backend re-downloads params → `channelConfig []` for a few seconds), then `rcParamsPresent` (RCn_TRIM entries restored by the ParameterContext self-heal) triggers one `/api/setup/radio` refetch and the config rows return to the genuine values — observed `trim1` `1547` restored at **t=21 s**.
- `docs/evidence/phase8e-radio-reconnected-no-reload.png` — evidence of the re-populated config after reconnect without a page reload.

## Honesty guarantees honoured

- No simulated/fake `1500` values: inputs show real vehicle params or an empty field when none exist; the monitor shows genuine RC telemetry or an explicit waiting/stale state. No `Math.random`, mock-RC generator, or hard-coded fake channel data anywhere in production code (only a mission-ID slug generator, unrelated to radio).
- RC receiver signal never conflated with MAVLink link health (explanatory note rendered on the page).
- Calibration is a real backend FSM but is classified **PROTOCOL-ONLY**: start requires a live RC signal and captures actual stick telemetry, yet it was never exercised end-to-end with a physical transmitter (Pixhawk has no bound receiver); the "no RC signal → refused" path was verified on SITL and Pixhawk.
- Live writes were performed only on ephemeral SITL (`RC1_TRIM` 1500→1560→1500 restored); the Pixhawk was read-only.
- Stale telemetry is never rendered as live (`RC_STALE_MS = 2000`); on disconnect the RC block is zeroed via `reset_telemetry` and `telemetry:update` is re-emitted so the UI cannot show stale channels/rssi.
- During a reconnect the config rows are briefly empty (honest "re-syncing" state) and re-populate only from the refilled parameter set.

## Scope frozen after this point

Power, Safety, Motors, Servo, ESC, Gimbal, Logging, Scripting remain **inactive** Setup screens (phases 8F–8H). Nothing further will be implemented unless the user explicitly requests it.