# Phase 8H — Motors Functionality Report

**Status:** Complete and verified end to end — backend, frontend and SITL.
**Real Pixhawk:** verified strictly read-only; no actuator command or motor parameter write was ever issued on hardware.
**Motors UI:** the approved composition is preserved. Only functional state was added (live status text, slot availability, real control behaviour).

---

## 1. What this phase is

The QGroundControl **Motors** page was previously UI-only. This phase makes the backend
behave according to the QGC Motors *workflow*, adapted to ArduCopter and to this project's
existing infrastructure.

The QGC reference supplied for review was the **ArduSub** page. Its *workflow* was adopted;
its ArduSub-specific implementation was deliberately **not** copied:

| Adopted (workflow / information architecture) | Not adopted (ArduSub-specific) |
| --- | --- |
| Discover which physical output each motor is on | ROV/thruster terminology |
| Show the frame/motor arrangement | Blue Robotics frame mappings |
| Test one motor at a time | ArduSub "Auto-Detect Directions" |
| Verify direction via per-output reverse config | ArduSub-specific parameters |
| Bound and self-terminate every test | ArduSub frame type constants |

### Auto direction detection — deliberately omitted

ArduSub 4.0 exposes an automatic direction-detection routine. No equivalent capability was
established for the connected **ArduCopter** firmware, so per the design rules **no
"Auto-Detect" button was created**. No fake button, no simulated success. If a genuine
ArduCopter capability is identified later it can be added behind the same capability gate.

---

## 2. Infrastructure reused (nothing duplicated)

| Concern | Reused |
| --- | --- |
| MAVLink transport | existing single `connection_manager` connection |
| Command send + ACK | `mavlink/command_service.wait_for_command_ack()` / `send_command_long()` |
| Parameter write | `parameter_manager.set_parameter()` (PARAM_SET + PARAM_VALUE echo verification) |
| Parameter cache | `parameter_manager.get_all_parameters()` / `get_parameter()` |
| Motor discovery | `motor_setup_service` (`SERVOx_FUNCTION` + ArduPilot metadata decoding) |
| Connection lifecycle | `connection_manager` teardown / heartbeat-watchdog hooks |
| Frontend transport | existing Socket.IO server |

No second MAVLink connection, parameter cache, Socket.IO pipeline or watchdog was created.

---

## 3. Motor discovery (live, not hardcoded)

`SERVOx_FUNCTION` is scanned from the live parameter cache for channels 1–32 and decoded
through the project's existing ArduPilot metadata. An output is classified as a motor only
when the decoded label matches the motor function pattern.

Mapping is therefore **output → function id → decoded function → motor number**, taken from
the vehicle. No `Motor 1 = SERVO1` assumption exists: a motor living on output 6 is reported
as motor 2 on output 6 (covered by `test_start_test_uses_discovered_channel_not_index_guess`).

The Motor Outputs table (`OUTPUT / MOTOR / FUNCTION / FUNCTION ID / CONFIGURED / SOURCE`) is
already driven by this live data.

---

## 4. Motor test (ArduCopter `MAV_CMD_DO_MOTOR_TEST` = 209)

Parameter semantics were taken from the MAVLink `common.xml` definition shipped with
pymavlink (not guessed):

| param | meaning | value used |
| --- | --- | --- |
| 1 | Instance — motor number (1-based) | the **discovered** motor number |
| 2 | Throttle type | `0` = `MOTOR_TEST_THROTTLE_PERCENT` |
| 3 | Throttle (percent) | bounded **0–20 %** (default 5 %) |
| 4 | Timeout (s) | bounded **1–10 s** (default 3 s) |
| 5 | Motor count | `1` |
| 6 | Test order | `0` |

Values are clamped in the backend, so no arbitrary/unlimited output is possible regardless of
what a client sends.

Flow: **frontend request → backend capability gate → validation (disarmed, motor exists) →
bounded command → COMMAND_ACK → authoritative state → Socket.IO `motor:test` event.**
The frontend never assumes "slider moved = motor started".

### Automatic stop and cancellation

ArduPilot's motor test is **self-terminating**: the firmware stops the output after `timeout`
and MAVLink provides no abort. Accordingly:

* a backend timer mirrors the firmware timeout and returns the session to `STOPPED`;
* `stop` is a GCS-side session clear; the bounded firmware timeout ends the actual output.

This is documented honestly rather than presented as a true abort.

### State machine

`IDLE · READY · TESTING · STOPPING · STOPPED · ERROR · DISCONNECTED · UNAVAILABLE`

---

## 5. Connection loss / reconnect

The existing connection manager calls `notify_connection_lost()` from both teardown paths
(explicit disconnect / transport loss) and the heartbeat watchdog. On loss the active test is
cancelled and the state becomes `DISCONNECTED`. On a fresh/recovered link the session resets
to `IDLE` and motor outputs are **rediscovered** — the previous test is never auto-restarted.

---

## 6. Reverse motor direction

Checkbox → staged state → existing parameter manager → `PARAM_SET` → `PARAM_VALUE` echo →
confirmed state. The write targets the **discovered output** for that motor
(`SERVO{channel}_REVERSED`).

Crucially, `SERVOx_REVERSED` is a **configuration** value. The API returns
`configured` **and** `physicallyVerified: false`; the system never claims a motor's physical
direction has been verified, because that requires physically observing the motor.

---

## 7. Safety model (enforced in the backend, not only the UI)

Motor testing and reverse writes are enabled **only** when the link is positively identified
as a simulation environment:

* transport is `udp`/`tcp` (not `serial`), **and**
* the live parameter cache contains ArduPilot `SIM_*` parameters.

A physical autopilot is never treated as testable merely because it is connected — including a
hardware link tunnelled over UDP/TCP telemetry. `connected == true` is deliberately *not* the
safety condition.

---

## 8. Telemetry

`SERVO_OUTPUT_RAW` is already parsed by the existing telemetry manager. The `motors` view now
reuses that same snapshot and reports, per output, the real `pwm`, `receivedAt`, `ageMs` and a
`freshness` of `AVAILABLE` / `STALE` / `UNAVAILABLE`. Nothing is invented: on the real Pixhawk
(disarmed, not streaming outputs) the honest `UNAVAILABLE` result is returned rather than a
placeholder. The identical values are already shown on SETUP → Servo, from the same source.

The approved Motor Outputs table has six fixed columns and no telemetry column, so the PWM is
exposed in the API and is *not* rendered in that table — adding a column would change the
approved composition. See "Known limitations".

---

## 8a. Frame-aware motor mapping

`FRAME_CLASS` / `FRAME_TYPE` are read from the vehicle's own parameter cache and decoded with
the **connected firmware's** parameter metadata (the same `_field()` decoder used for
`SERVOx_FUNCTION`). The motors view therefore reports:

| Field | Meaning |
| --- | --- |
| `class` / `classLabel`, `type` / `typeLabel` | live values + firmware-decoded names |
| `label` | e.g. `Quad (Plus)` |
| `configured` | `FRAME_CLASS` is set to a non-zero class |
| `armCount`, `armCountSource` | derived from the **decoded frame-class label only** |
| `source` | `firmware-metadata` or `unavailable` |
| `geometryAvailable` | always `false` |
| `geometryReason` | why per-motor positions are not available |

**Arm count is derived from the firmware's own enum label**, never from the vehicle type or from
the number of discovered motors. Only unambiguous arm layouts are mapped
(`Quad→4, Tri→3, BiCopter→2, Y6→6, Hexa→6, Deca→10, DodecaHexa→12, Octa→8, OctaQuad→8`).
Classes that are not arm layouts — helicopters, coax, single-rotor, scripting matrices — have
no arm count, and the mapping stays explicitly unknown.

**Physical motor geometry is not derivable and is not fabricated.** ArduCopter's
`FRAME_CLASS` / `FRAME_TYPE` do not encode motor positions or arm geometry, so
`geometryAvailable` is `false` and the per-output `frameMapped` is `null` rather than a guess.
The approved diagram is a six-position illustrative layout and is not presented as the real
airframe; the truthful motor↔output mapping is the Motor Outputs table, which is live.

Live proof of the "unknown" path, from the **real Pixhawk**:

```
FRAME_CLASS = 17 "Dynamic Scripting Matrix"   FRAME_TYPE = 1 "X"
armCount = None   geometryAvailable = False
out=1..4  frameMapped = None   pwm = None   freshness = UNAVAILABLE
```

That class implies no arm layout, so the backend reports every motor as unmapped rather than
inventing four positions.

---

## 9. Verification

### UI VERIFIED
* `tsc -b` clean · `npm run lint` 0 errors · `npm test` **571 passed / 38 files** · `npm run build` clean
* Browser checklist on the approved composition: **15/15 PASS** — no horizontal overflow, sliders
  aligned, checkboxes aligned under sliders (0 px offset), diagram positioned right (340 px),
  Motor Outputs table 6 columns aligned (0 px), no excessive empty space (10–12 px gaps),
  no oversized warning, lock compact (77 px), **0 console/React errors**, Setup navigation
  unaffected across summary→safety→servos→esc→parameters→motors.
* Responsive with no element overflow at 1600 / 1280 / 1024 / 900 px.
* Evidence: `docs/evidence/phase8h_motors_functional_sitl.png` and
  `..._narrow.png` (live SITL, mid-test). Original approved captures retained as
  `phase8h_motors_phase1.png` / `..._narrow.png`.

### END-TO-END UI VERIFIED IN A REAL BROWSER AGAINST SITL
Driven through Chrome DevTools Protocol on the running page:

| Step | Result |
| --- | --- |
| Capability | `SITL`, supported |
| Page state | `Motor testing ready` |
| Slot availability | live = `[1, 2, 3, 4]` (quad discovery, not a hardcoded 1–4) |
| Slider bound | `aria-valuemax=20` (backend bound) |
| Slider commit | `Testing Motor 1 at 1% for 3s`; backend `TESTING`; slider reflects commanded level |
| Firmware timeout | `Motor test completed (firmware timeout).`; backend `STOPPED` |
| Reverse checkbox | `SERVO1_REVERSED` 0 → 1 confirmed on the vehicle, checkbox reflects confirmed value |
| Undiscovered slots | keyboard input on slots 5/6 produced no test |
| SITL restored | all `SERVOx_REVERSED` back to 0 |
| Console | 0 errors |

### FUNCTIONALITY VERIFIED IN SITL (ArduCopter)
| Step | Result |
| --- | --- |
| Connect (TCP:5760) | connected, ArduCopter, `STABILIZE`, disarmed |
| Motor discovery | 4 motors: outputs 1–4, function ids 33–36 from live params |
| Capability gate | `supported: true`, `environment: SITL` |
| Test Motor 1 (5 %, 2 s) | `COMMAND_ACK` 209 `ACCEPTED` → `TESTING` |
| Automatic stop | `TESTING` → `STOPPED` ("Motor test completed (firmware timeout)") |
| Test Motor 2 (8 s) + cancel | `TESTING` → `STOPPED` |
| Reverse write Motor 4 | `SERVO4_REVERSED = 1` confirmed by PARAM_VALUE echo |
| Reverse read-back | motor 4 reported `configured: true` |
| SITL restored | `SERVO4_REVERSED` written back to 0; all four outputs report `false` |
| Disconnect during test | state `DISCONNECTED`, active motor cleared |
| Reconnect | state `IDLE`, motors rediscovered (4) |

### REAL PIXHAWK READ-ONLY VERIFIED
* Connection: `SERIAL` (`/dev/ttyACM0`, ArduPilot), ArduCopter, `STABILIZE`, disarmed,
  parameter sync complete `991/991`.
* Discovery: 4 motors read from live `SERVO1..4_FUNCTION` (function ids 33–36, decoded
  `Motor1`..`Motor4`) on the physical Pixhawk.
* Frame read: `FRAME_CLASS=17 "Dynamic Scripting Matrix"`, `FRAME_TYPE=1 "X"`, decoded from
  firmware metadata; `armCount` correctly `None` and every `frameMapped` `None`.
* Reverse **read**: all four `SERVOx_REVERSED` read successfully (`configured: false`).
* Telemetry read: `pwm = None`, `freshness = UNAVAILABLE` — the honest result for a disarmed
  vehicle that is not streaming outputs.
* Capability endpoint: `environment: HARDWARE`, `readOnly: true`, reason
  *"Motor testing is enabled in the SITL/test environment only; the connected physical
  vehicle is read-only."*
* **Command-path proof:** a snapshot of the backend log was taken, the full read-only sweep
  (`/motors`, `/motors/reverse`, `/motors/test`, `/servo-outputs`, `/esc`) was run against the
  real Pixhawk, and the log was re-counted. Delta: `command=209 → 0`, `PARAM] Write → 0`.
  The motor-test command path was **never invoked on hardware**, even though a hostile or
  buggy client could request it. Enforcement is additionally proven by unit tests
  (`test_hardware_start_test_sends_no_command`,
  `test_hardware_reverse_write_sends_no_parameter`, `test_tcp_without_sim_params_is_treated_as_hardware`).

### FRAME + TELEMETRY VERIFIED IN SITL
| Field | Live value |
| --- | --- |
| `FRAME_CLASS` / label | `1` / `Quad` |
| `FRAME_TYPE` / label | `0` / `Plus` |
| `label` | `Quad (Plus)` |
| `armCount` / source | `4` / `frame-class-label` |
| `geometryAvailable` | `false` |
| Outputs | `out=1..4`, `motor=1..4`, `fn=33..36`, `'Motor1'..'Motor4'` |
| `frameMapped` | `true` for all four (all within the 4-arm count) |
| Telemetry | `pwm=1000`, `freshness=AVAILABLE` on all four |

### BACKEND SUITE
`pytest` → **686 passed**.

---

## 10. Frontend wiring

The approved composition is unchanged: same six vertical controls in one row, same diagram on
the right, same reverse row under the sliders, same Motor Outputs table, same Refresh Data
placement, same spacing/typography/branding. No new button, panel or control was added.

What became functional:

| Element | Behaviour |
| --- | --- |
| Motor slider | Commit on release (pointer or keyboard) runs **one** bounded test for the level the user asked for. `aria-valuemax` follows the backend bound, so the control cannot request more than the backend will accept. |
| Undiscovered slots | `aria-disabled` + inert. On a quad only motors 1–4 are live; 5–6 stay unavailable. |
| Reverse checkbox | Writes through the parameter manager and shows the **confirmed** value. Disabled when the vehicle is read-only, armed, or the motor is not discovered. |
| Lock section | Reuses the existing compact styles to show the authoritative state (`Motor testing ready` / `Testing Motor N at X% for Ys` / result message / `Motor testing unavailable` + reason). It is still a permanently disabled button. |
| Motor Outputs note | Corrected: reverse now writes `SERVOx_REVERSED`, so the old "Nothing on this page writes it" claim was removed and replaced with the accurate configuration-only statement. |

Safety properties preserved and now test-enforced:

* the lock knob is still a disabled `<button>` — this page can never arm the vehicle;
* there is still no arm, stop, apply or save control;
* the "cannot arm the vehicle or enable any actuator output" statement is an **invariant** of
  the page, asserted in every state rather than written per branch;
* no test is reachable for a motor the vehicle did not report;
* nothing claims a motor's physical direction was verified.

A real bug was found and fixed while validating: a fast tap could commit the *previous* level,
because the release handler read a stale render value. The pending level is now tracked
explicitly, with a regression test that fires keydown+keyup before React re-renders.

## 11. Deliberately not done

* **No Auto-Detect Directions** (no verified ArduCopter capability — see §1).
* **No ArduSub/ROV logic**, no ArduSub frame mappings.
* **No second MAVLink/parameter/Socket.IO infrastructure.**
* No fabricated motor numbering, function ids, PWM, RPM, voltage or current values.
* **No UI stop button.** The approved composition allows no new controls, so stopping relies on
  the bounded (max 10 s) firmware self-termination. A cancel button is the natural next request
  if manual stopping is wanted.

## 12. Known limitations

1. **Physical motor geometry is unavailable and intentionally not inferred.**
   `FRAME_CLASS` / `FRAME_TYPE` do not encode motor positions, so the diagram remains an
   illustrative six-position layout and per-motor `frameMapped` is `null` whenever the frame
   class implies no arm count. The truthful mapping is the Motor Outputs table.
2. **The frozen Motor Outputs table has no telemetry column.** Real PWM and freshness are
   computed and exposed in `GET /api/setup/motors`, and shown on SETUP → Servo, but rendering
   them in the Motors table would add a seventh column to an approved six-column table.
3. **No frame identity in the UI.** `frame` is returned by the API but the approved page has no
   frame field, so the page does not display `Quad (Plus)`.
4. **`stop` is not a true abort.** MAVLink has no motor-test abort, so cancellation clears the
   GCS session while the bounded firmware timeout ends the output.
5. **No automatic direction detection.** No verified ArduCopter equivalent was found.
6. **SITL parameter drift — investigated; external writer inferred but not proven.** During
   validation two outputs (`SERVO3_REVERSED`, `SERVO4_REVERSED`) were found set to 1 in SITL with
   no corresponding write in the backend log. A dedicated investigation afterwards excluded
   this codebase, the E2E/browser scripts, SITL itself, and boot or persisted parameter state as
   causes. The only mechanism consistent with the surviving evidence is a transient external
   MAVLink client that wrote those parameters directly to the simulator. That inference is
   **not proven**: no MAVLink capture was running during the window, and the log carries no
   timestamps. See **§14** for the full exclusion matrix and the evidence-integrity gap. The
   effect is confined to the simulator's volatile parameters; the real Pixhawk was never
   affected.

---

## 13. New API surface

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/setup/motors/test` | capability + authoritative test state + bounds |
| POST | `/api/setup/motors/test` | start one bounded motor test `{motor, throttlePct?, timeoutS?}` |
| POST | `/api/setup/motors/test/stop` | cancel the tracked test session |
| GET | `/api/setup/motors/reverse` | live `SERVOx_REVERSED` per motor |
| POST | `/api/setup/motors/reverse` | stage/apply reverse config `{motor, reversed}` |

Existing read-only routes (`GET /motors`, `/servo-outputs`, `/esc`) are unchanged.

### Frontend

* `frontend/src/api/setup.ts` — `MotorTestStatus`, `MotorReverseState`, `getMotorTestStatus()`,
  `startMotorTest()`, `stopMotorTest()`, `getMotorReverseStates()`, `setMotorReverse()`.
* `frontend/src/hooks/useMotorTest.ts` — backend-authoritative test state, `motor:test`
  subscription, disconnect reset, confirmed reverse-config writes.
* `frontend/src/hooks/useMotorsSetup.ts` — unchanged read-only discovery hook.

---

## 14. Appendix — SITL `SERVOx_REVERSED` drift investigation

During Phase 8H validation, `SERVO3_REVERSED` and `SERVO4_REVERSED` were found set to `1` in the
ArduCopter SITL instance with no matching write in the backend log. This section records the
dedicated investigation, the hypotheses that were **excluded with evidence**, and what remains
unproven. No product code, UI, or configuration was changed as a result.

### 14.1 Exclusion matrix

| # | Hypothesis | Method | Result |
| --- | --- | --- | --- |
| 1 | This backend wrote the value | Code audit: `_send_param_set()` has a single call site (`mavlink/parameter_manager.py:795`), and `[PARAM] Write` is emitted at `:792` immediately before the send | **Excluded.** The application cannot emit an unlogged `PARAM_SET`. |
| 2 | Some log recorded the write | Filesystem-wide search of `/home/prema`, `/tmp`, `/var/tmp` for a `SERVO3/4_REVERSED = 1` write record | **Excluded.** No hit other than this report, the session transcript, and unrelated ArduPilot autotest parameter files. |
| 3 | SITL/ArduCopter self-modified the value | Source audit of `ArduCopter/`, `libraries/`, `SITL/` for any runtime writer of `*_REVERSED` | **Excluded.** No runtime writer exists; the only hits are `RC2_REVERSED` in unused SITL sim backends and a legacy `_REV` → `_REVERSED` conversion flag. |
| 4 | Boot-time or persisted parameter state | Uptime check plus inspection of every `mav.parm` on disk | **Excluded.** The SITL process (PID 5711) started at 10:52:26 and never restarted; every candidate parameter file has `SERVO3/4_REVERSED = 0`. |
| 5 | A second MAVLink client on the live SITL | Process and socket inspection of TCP 5760 | **Excluded for the live instance.** Only this backend was connected. The MAVProxy TCP→UDP forwarder belongs to an earlier, already-terminated SITL instance. |
| 6 | Browser E2E or UI automation | 7-step replay with per-step readback **and** parameter-write counting: full SETUP navigation incl. the Parameters page, responsive sweep, E2E, bounded motor test, vehicle disconnect/reconnect resync, repeat E2E | **Excluded.** No drift at any step. Each E2E run produced exactly four write records (`SERVO1` only) and left all four outputs at `0`. |
| 7 | Stale cache or stale read in the read path | Code audit: `get_parameter()` (`mavlink/parameter_manager.py:877`) is a pure cache read, but the cache is refreshed by every inbound `PARAM_VALUE` via `_upsert()` (`:484`) | **Excluded as a defect.** The read path faithfully reflects the vehicle. |
| 8 | The observation was a misread | The recovery writes of `SERVO3=0` / `SERVO4=0` were **confirmed by the vehicle's `PARAM_VALUE` echo** | **Excluded.** SITL genuinely held `1`; the drift was real. |

### 14.2 Remaining hypothesis (inference, not proof)

With every in-repo cause excluded, the only mechanism consistent with all of the above is a
**transient external MAVLink client** that sent `PARAM_SET` directly to the simulator's TCP 5760
during the observation window. Such a write would:

* leave no entry in this application's log (it is not the sender);
* not be persisted (ArduPilot saves parameters only on an explicit save or reboot);
* be observed here solely as a `PARAM_VALUE` broadcast, which the parameter cache correctly stored.

This remains an inference. It could not be confirmed because the evidence needed to prove it was
not retained — see below.

### 14.3 Evidence-integrity gap

Two process weaknesses materially limited the investigation:

* `backend.log` **carries no timestamps**, so the write history cannot be correlated to the
  observation window.
* The log is **overwritten rather than rotated** on every backend restart, which destroyed the
  drift-era records before they could be correlated.

Both are operational defects rather than product defects, and no code change was made, per the
"no code change without a proven bug" constraint for this phase.

### 14.4 Recommendation for future phases

To make an out-of-band parameter change attributable the moment it happens, a MAVLink-level
provenance record is needed: log any inbound `PARAM_VALUE` that changes a value the application
did not itself write, including the connecting client. This would have reduced the original
ambiguity to a single log line. It is deliberately **not** included in this phase, because the
investigation found no defect in this codebase to justify it.

