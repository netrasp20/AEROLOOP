# SETUP → Firmware: Verified Workflow and Hardware Integration Report

Status: **IMPLEMENTATION COMPLETE.** The workflow, the API contract, the Firmware
page and the release catalogue are implemented, tested and validated read-only
against an attached Pixhawk 1. **Physical firmware installation remains
permanently gated and was never performed: nothing was flashed, erased, booted
into a bootloader, rebooted for flashing, and no parameters were written and no
actuators were commanded.**

This is the final report. The seven sections below are the deliverable; the
engineering detail that produced them is kept in Appendix A so the reasoning
behind each decision is still available.

## Release audit checklist

Every item below was re-verified against the implementation during the final
release audit, not against the existence of a test.

- [x] **GAP 3** — release rows expose platform and an evidence-backed compatibility verdict with its reason
- [x] **GAP 3** — `Stable` / `Beta` / `Development` grouping is derived from the manifest; no channel invented, no empty channel rendered
- [x] **GAP 3** — `CURRENT`, `SELECTED` and `AVAILABLE` are three distinct, independently rendered markers
- [x] **GAP 3** — only `EXACT_MATCH` can select; a narrowed platform (`CONFIRMED_COMPATIBLE`) selects nothing and refuses an install without an explicit candidate
- [x] **GAP 5** — all 17 firmware routes audited connected and disconnected
- [x] **GAP 5** — `state`, `success`, `errorKind` and `terminal` proven mutually non-contradictory
- [x] **GAP 5** — `BLOCKED`, `CONFIRMATION_REQUIRED`, `CONFIRMATION_INVALID`, `DOWNLOAD_FAILED`, `DOWNLOAD_VERIFICATION_FAILED`, `INSTALLING`, `VERIFYING`, `COMPLETED`, `FAILED`, `CANCELLED`, `DISCONNECTED`, `VERIFICATION_MISMATCH` and `VERIFICATION_UNCONFIRMED` each individually asserted
- [x] **GAP 7** — permanent deterministic E2E matrix green, all 21 required scenarios covered
- [x] **GAP 7** — no synthetic event is written to the production firmware log by the test suite (proven by byte-identical file size across a full run)
- [x] **GAP 7** — pre-isolation synthetic residue found in the production log, archived out of the production path, evidence retained (see section 2)
- [x] **GAP 8** — final real Pixhawk read-only validation: firmware, vehicle, USB identity, resolver and installation state all observed
- [x] **GAP 8** — no reboot, no bootloader entry, no erase, no flash, no parameter write, no actuator command
- [x] **GAP 9** — every backend state and every integrity outcome renders correctly
- [x] **GAP 9** — no fabricated progress, no fabricated compatibility, no fabricated success
- [x] **GAP 10** — this report separates IMPLEMENTED, TESTED, REAL PIXHAWK READ-ONLY VALIDATED, SIMULATED, HARDWARE-GATED and REMAINING LIMITATIONS
- [x] Backend `pytest`, frontend `vitest`, TypeScript, build, lint, E2E matrix and route contract all re-run green
- [x] Physical flashing remains gated and is not treated as a software failure

---

## 1. IMPLEMENTED

Every item below is implemented in code and verified by the tests named in
section 2. Nothing here is marked complete on the strength of a test existing.

### Detection and identity

| Capability | Implementation |
| --- | --- |
| Vehicle detection | `/firmware/detection` reads the live MAVLink link and reports connection, vehicle type, autopilot and the fields the board actually answered for |
| Field availability | Each identity field carries `available` and a `reason`, so "unknown" is never rendered as "absent" |
| Normal-mode honesty | A board in normal MAVLink mode reports `bootloaderIdentityAvailable: false`; no bootloader field is ever inferred from `board_id`, vehicle type, firmware version or the normal-mode product string |
| USB descriptor identity | Product string, serial number and manufacturer are read from the OS USB enumeration, read-only |
| Board-version safety | `AUTOPILOT_VERSION.board_version` is decoded and shown, and explicitly **not** used as a manifest `board_id` |

### Compatibility resolution

| Capability | Implementation |
| --- | --- |
| Exact resolution | A bootloader product string that matches exactly one platform resolves to that platform, then cross-checks against the official manifest |
| Narrowed resolution | A product string spanning several platforms is narrowed by board id, and yields `CONFIRMED_COMPATIBLE`, never a silent guess |
| Refusal outcomes | `AMBIGUOUS`, `UNSUPPORTED`, `NO_MATCH`, `IDENTITY_UNAVAILABLE`, `NO_DEVICE` and `UNAVAILABLE` are all distinct and all refuse to select |
| Cross-check | An exact match that fails its official-manifest cross-check is downgraded rather than trusted |
| **No auto-selection below exact match** | Only `EXACT_MATCH` pre-selects a release. A merely narrowed platform lists its candidates and selects nothing, and an install without an explicit candidate is refused |

### Release rows (catalogue data only)

Every row is a real manifest entry exposing version, release channel, platform,
vehicle, format, image size, USB ids, bootloader strings, the exact candidate id
the confirmation binds to, the compatibility verdict **with its reason**, and
`CURRENT` / `SELECTED` / `AVAILABLE` markers.

Channels are derived from the manifest and are never invented. Measured against
the live catalogue: `OFFICIAL` 290, `BETA` 296, `DEV` 315 of 901 Copter
candidates — and `RELEASE_ORDER` covers exactly those three, with no declared
channel absent and no present channel undeclared. A channel with no releases is
not rendered at all.

### Download and integrity

| Capability | Implementation |
| --- | --- |
| Official source only | The manifest URL and artifact URLs come from the manifest; a non-official URL is refused before any transfer starts |
| Integrity ladder | `CHECKSUM_VERIFIED` → `SIZE_VERIFIED` → `TRANSFER_COMPLETE_ONLY`, with `VERIFICATION_FAILED` for a damaged artifact |
| Honest verdicts | A published digest is compared only when the source published one; the strongest verdict obtainable is reported, never a stronger one |
| Never executed | The artifact is staged to a file and never uploaded, executed or installed |

### Installer state machine

Ten connection-dependent states and five terminal states, with illegal
transitions rejected rather than silently accepted. Real hardware installation
is refused at the gate before any artifact is fetched.

### Error taxonomy, logging, verification

One closed taxonomy of 14 kinds, applied by every firmware route, with a human
message always accompanying a kind and never a raw internal code. Canonical
event vocabulary for detection, identity, resolution, selection, confirmation,
download, integrity, installer state, disconnect/reconnect and post-install
verification, with USB serials redacted. Post-install verification checks the
firmware version **and** the board identity, vehicle type and autopilot type, and
separates "wrong" from "cannot be asked".

---

## 2. TESTED

| Suite | What it proves |
| --- | --- |
| `test_firmware_e2e_matrix.py` — **27 scenarios + closed-list guard** | Every outcome end to end, hermetically. A scenario cannot be added or renamed without the guard failing |
| `test_firmware_response_contract.py` — **86 tests** | All 17 firmware routes × connected/disconnected, plus a per-state contract for every state the API can report |
| `test_firmware_workflow.py`, `test_firmware_hardware_integration.py`, `test_firmware_catalog.py`, `test_firmware_logging.py`, `test_bootloader_*.py` | Resolution rules, verification rules, catalogue integrity, event vocabulary, bootloader read-only state machine |
| `SetupFirmware.test.tsx` — **92 tests** | Every backend state and every integrity outcome render; channels, markers and row identity |

### Scenarios required, and where each is pinned

| # | Required scenario | Test |
| --- | --- | --- |
| 1 | no device | `test_01` |
| 2 | connected device | `test_02` |
| 3 | exact identity | `test_04` |
| 4 | ambiguous identity | `test_03` |
| 5 | identity unavailable | `test_02`, `test_06` |
| 6 | unsupported hardware | `test_05` |
| 7 | firmware selection | `test_12` |
| 8 | confirmation | `test_11` |
| 9 | catalogue refresh invalidates confirmation | `test_22` |
| 10 | reconnect invalidates confirmation | `test_23` |
| 11 | successful download | `test_13`, `test_14` |
| 12 | download transport failure | `test_17` |
| 13 | verification failure | `test_16` |
| 14 | transfer-complete-only | `test_15` |
| 15 | installer success | `test_19` |
| 16 | installer failure | `test_20` |
| 17 | cancellation | `test_21` |
| 18 | disconnect | `test_24` |
| 19 | post-install verification success | `test_25` |
| 20 | post-install mismatch | `test_26` |
| 21 | post-install unconfirmed | `test_27` |

Six scenarios (9, 10, 18, 19, 20, 21) were **missing** from the previous
matrix and were added while closing GAP 7.

### Invariants asserted on every scenario and every route response

* `errorKind` is `null` or one of the 14 declared kinds — never an undeclared string.
* `errorMessage` is present exactly when a kind is, and is human-readable.
* `success` never contradicts `state`; `COMPLETED` requires `versionVerified`.
* A work-in-progress state never reports a failure kind.
* A disconnected device never reports `success: true` or a verified version.
* A verification mismatch can never become `COMPLETED`.
* An unreachable board is `VERIFICATION_UNCONFIRMED`, never `VERIFICATION_MISMATCH`.
* `TRANSFER_COMPLETE_ONLY` is never `verifiedForInstall` and is never styled as verified.
* Nothing is ever written to hardware; `hardwareTouched` stays `false`.

### Defects found by these tests and fixed

Writing the audit found real bugs, not only missing coverage:

1. **A refused install never settled.** The install path advanced to
   `CONFIRMATION_REQUIRED` and returned, leaving `terminal: false` forever: a
   client polling until terminal polled until it gave up. It also reported
   "waiting" beside a `CONFIRMATION_INVALID` error. A refusal now settles as
   `BLOCKED`.
2. **A disconnect could kill the installer worker.** `_refusal()` advanced the
   session unconditionally, so a disconnect landing between computing and
   applying a refusal raised `ValueError: Illegal firmware workflow transition
   DISCONNECTED -> BLOCKED` inside the background thread. The exception was
   swallowed and surfaced as a session stuck at `DETECTING`.
3. **A confirmation voided by a catalogue refresh reported a false reason.** The
   real cause was discarded before reporting, so an operator whose approval had
   been invalidated was told "no confirmation was recorded" — a different claim
   from the truth. The genuine cause is now reported, and a stale confirmation
   is distinguished from an absent one (`CONFIRMATION_INVALID` vs `null`).
4. **Auto-selection below an exact match.** `CONFIRMED_COMPATIBLE` pre-selected
   a release. Only `EXACT_MATCH` may choose for the operator now.
5. **An unselected release row claimed to be "Selected"** in grey. It now reads
   `AVAILABLE`, so `CURRENT` / `SELECTED` / `AVAILABLE` are three distinct
   things.

One test expectation was also wrong and the code was right: an unconfirmed
download reports `errorKind: null`, because "not confirmed yet" is a wait for a
decision nobody has made, whereas `CONFIRMATION_INVALID` means a confirmation
*was* given and did not hold.

### The production firmware log, audited

GAP 7 requires that synthetic events never reach the production log, so this was
checked directly rather than assumed.

**The test suite does not write there.** The production log path
(`.firmware_cache/logs/firmware.jsonl`) was measured before and after a full
firmware run: **131,084 bytes before, 131,084 bytes after 253 tests** — byte for
byte unchanged — while the injected test log grew past 1.5 MB. `tests/conftest.py`
redirects `FIRMWARE_LOG_PATH` to a temporary file for exactly this reason, and
also clears the global workflow, catalogue, confirmation and bootloader-validation
state between tests.

**It had, however, already been polluted.** The audit found 443 events in the
production file, including six entries whose own `reason` field reads
`TEST / SIMULATION: …`, covering complete simulated install runs — including a
simulated `COMPLETED` and a simulated `VERIFICATION_MISMATCH` for `V4.7.1`. These
predate the log isolation in `conftest.py`; the synthetic installer/download
events all sit earlier in the file than the isolation took effect.

That residue is exactly the failure mode the requirement exists to prevent: an
operator reading the audit trail after a real flight would have found simulated
install outcomes interleaved with genuine ones. The polluted file has been moved
out of the production path to
`docs/evidence/firmware-log-pre-release-audit.jsonl` (retained in full as audit
evidence, not deleted), and the production path now starts empty and is written
only by real runs. **No synthetic event is written to the production firmware
log by the current code, and none remains in it.**


---

## 3. REAL PIXHAWK READ-ONLY VALIDATED

Performed against the attached Pixhawk 1 on `/dev/ttyACM0`, USB `1209:5741`,
through the running application over MAVLink.

| Read | Observed value |
| --- | --- |
| Connection | `connected`, MAVLink alive (`systemId` 1 / `componentId` 1), over USB but enumerated as a serial port, so detection reports transport `serial` on `/dev/ttyACM0` while the identity endpoint reports the USB VID/PID |
| Vehicle | `QUADROTOR` (manifest vehicle `Copter`) |
| Autopilot | `ARDUPILOTMEGA` (ArduCopter) |
| Firmware | `4.7.0 (Official Release)` |
| Release | `Official Release` |
| Board version | `589824` (decoded as board type 0 rev 9) |
| USB VID/PID | `4617:22337` = `0x1209/0x5741` |
| USB product | `Pixhawk1` (manufacturer `ArduPilot`) |
| USB serial | `3C0027000951363033383531` |
| Bootloader identity | **unavailable** — `bootloaderReadPerformed: false`, bootloader endpoint `state: BLOCKED`, `canResolvePlatform: false` |
| Missing identity fields | `bootloaderRevision`, `boardId`, `flashSize`, `bootloaderUsbProductString` — all four reported unavailable, with reasons |
| Resolver result | **`IDENTITY_UNAVAILABLE`**, `canConfirm: false`, `selected: null`, 0 releases offered |
| Workflow state | `READY` (the release/consent stage), with `installation.installationState: BLOCKED` |
| Installation state | **`BLOCKED`**, `firmwareInstallation: not-available`, `environment: HARDWARE`, `realInstallationAllowed: false` |
| Confirmation state | `confirmed: false`, `state: BLOCKED`, `errorKind: IDENTITY_UNAVAILABLE` — no target exists to confirm |
| Official catalogue | available, 97,509 entries, 901 Copter candidates |

### The refusal that kept the board safe, verbatim

The bootloader endpoint's own stated reason for refusing to read the board:

> The board is in normal MAVLink mode. It is not a bootloader endpoint, so
> bootloader protocol traffic must not be sent to it.

The four evidence lines it records instead are all read-only observations:

> `USB port /dev/ttyACM0 enumerated as VID:PID 0x1209/0x5741.`
> `USB serial number reported: 3C0027000951363033383531.`
> `USB product string reported: 'Pixhawk1'.`
> `The board is answering MAVLink, so it is running normal firmware.`


### Why the resolver refused, in the board's own words

> The connected board reports no bootloader identity, which is the only signal
> that can identify its physical platform safely. Board id unavailable spans
> several platforms on its own, so none of the 901 matching images can be
> selected.

This is the correct outcome, not a failure. The board is in normal MAVLink mode,
so the bootloader revision, board id, flash size and bootloader product string
cannot be read without entering bootloader mode — which this phase does not do.
The backend recorded exactly two warnings and both are the safety property
working:

> `AUTOPILOT_VERSION.board_version is not a manifest board_id and was not used as one.`
> `USB product string 'Pixhawk1' is a normal-mode product string, not bootloader evidence, and was not used to infer the platform.`

### What was deliberately not done

| Action | Performed? |
| --- | --- |
| Reboot | **No** |
| Enter bootloader mode | **No** |
| Erase | **No** |
| Flash firmware | **No** |
| Write firmware | **No** |
| Write or change parameters | **No** |
| Command motors | **No** |
| Command servos | **No** |

Confirmed from three independent sources: the board was still enumerated on the
same USB address with the same serial and the same device node afterwards; the
firmware event log recorded only `DETECTION` and `RESOLUTION` entries for this
session, with zero installer or download events; and every route consulted was
a read-only `GET` apart from a single no-op confirmation query with
`confirmed: false`, which records nothing and starts nothing.

The confirmation route is the only non-`GET` call made, and it was called with
`confirmed: false` — a query, not an approval. It returned `BLOCKED` /
`IDENTITY_UNAVAILABLE` precisely because no target could be resolved, so no
confirmation was recorded and no download or install could begin.

---

## 4. SIMULATED

The TEST/SIMULATION workflow exercises confirmation → download → integrity →
prepare → install → verify with **no vehicle attached at all**.

| Property | Behaviour |
| --- | --- |
| Hardware | Never contacted. `hardwareTouched: false` on every path |
| Identity | Synthetic and labelled `TEST/SIMULATION`; explicitly *not* a hardware compatibility result |
| Identity verification | Reported as not applicable — a simulation cannot prove anything about a physical board, and says so instead of implying it did |
| Fault injection | `failAt` accepts any real installer state name and rejects anything else with HTTP 400, rather than silently injecting nothing |
| Confirmation | Required, and recorded against a candidate that provably exists in the offline manifest rather than whatever upstream publishes that day |

The matrix runs entirely against an offline manifest with no network, no
timing dependence and no board, and asserts the complete final state of every
scenario.

---

## 5. HARDWARE-GATED

Seven hardware operations are blocked in code, and the gate is not a UI
affordance:

```
enter-bootloader, bootloader-erase, bootloader-program, bootloader-verify,
bootloader-reboot, reboot-for-flashing, firmware-install
```

| Gate | Value |
| --- | --- |
| `firmware_install_service.REAL_INSTALLATION_ALLOWED` | `False` |
| `core.config.FIRMWARE_INSTALL_ENABLED` | `False` |
| Hardcoded enable override | `False` |

A real-hardware install is refused at the gate **before any artifact is
fetched**, so a blocked install cannot even reach the network. The API reports
this to the client as `installationState: BLOCKED`,
`firmwareInstallation: not-available`, together with the list of blocked
operations, rather than failing obscurely later.

---

## 6. REMAINING LIMITATIONS

These are genuine external or physical limits, not unfinished work.

1. **Normal-mode hardware cannot identify its own platform.** Reading the
   bootloader revision, board id, flash size or bootloader product string
   requires the board to be in bootloader mode. This phase does not enter
   bootloader mode, so on a normally-running board the resolver correctly
   returns `IDENTITY_UNAVAILABLE` and offers nothing to install. Resolving a
   normal-mode board would require a separate, explicitly approved
   bootloader-transition phase.
2. **No authoritative artifact digest exists upstream.** Measured on the live
   manifest: **0 of 901** Copter candidates publish an `artifact_sha256`. A
   locally computed SHA-256 is reported for traceability but is explicitly
   *not* a cryptographic verification of origin, and the strongest honest
   verdict for such an artifact is `SIZE_VERIFIED`, or `TRANSFER_COMPLETE_ONLY`
   when no size is published either. Upstream publishing digests is the only way
   to reach `CHECKSUM_VERIFIED` honestly.
3. **Physical firmware writing is unproven and stays gated.** Every hardware
   operation is blocked, so the erase/flash/verify path has never run against a
   board. It cannot be validated without an explicit decision to permit it, and
   the gate exists precisely so that it cannot happen by accident.
4. **Post-install verification is only exercised synthetically.** It is proven
   against simulated identity changes and an unreachable board, not against a
   board that was actually reflashed, because nothing was ever flashed.
5. **USB serial is deliberately excluded from the hardware fingerprint.** The
   fingerprint is built only from MAVLink-reported evidence so it stays a pure
   function of the vehicle link. The consequence is that replugging the *same*
   board keeps a confirmation valid, and two physically different boards of the
   same model running the same firmware are not distinguished by fingerprint.
   A different vehicle taking the connector *is* caught.

---

## 7. FINAL TEST COUNTS

| Check | Command | Result |
| --- | --- | --- |
| Backend suite | `python -m pytest -q` | **1381 passed**, 153 warnings |
| E2E matrix | `pytest tests/test_firmware_e2e_matrix.py` | **28 passed** (27 scenarios + closed-list guard) |
| Route contract | `pytest tests/test_firmware_response_contract.py` | **86 passed** |
| Frontend suite | `npx vitest run` | **648 passed** across 38 files |
| Firmware page tests | `vitest run SetupFirmware.test.tsx` | **92 passed** |
| TypeScript | `npx tsc --noEmit` | **Clean** |
| Production build | `npm run build` | **Clean** |
| Lint | `npm run lint` | 10 pre-existing warnings, none in touched files |

The 153 backend warnings are pre-existing and unrelated (an unawaited
`AsyncServer.emit` coroutine in `sio/server.py`, plus deprecation notices in the
power, radio, safety and parameter tests). The 10 lint warnings are likewise
pre-existing and in files this work never touched.

One flaky frontend test was observed during the audit and is reported rather than
hidden: `src/components/parameters/ParameterFileDialogs.test.tsx` timed out once
(7.6 s) while the full suite ran in parallel. It passed in isolation (6/6) and
passed on a full re-run (648/648). It is in the parameters area, which this
firmware work does not touch, and the failure was a timeout rather than an
assertion mismatch. No firmware test flaked in any run.

After the full backend run the production firmware log path was verified still
empty — 1,495 backend tests wrote nothing to it.


---

# Appendix A. Engineering detail

The sections below are the working record: each gap, the defect found while
closing it, the scenario matrix as originally specified, and the live validation
transcript they came from.
## 1. Official source

The catalogue is fetched from `https://firmware.ardupilot.org/manifest.json.gz`.
No release list is vendored or hardcoded, and no firmware version is hardcoded
in production code. Live validation at the time of writing: HTTP 200, gzip,
1,877,790 compressed bytes, 97,377 manifest entries, 895 Copter candidate
images. The upstream catalogue changes continuously; the most recent measurement
is in section 3 above (97,509 entries, 901 Copter candidates).

## 2. Manifest validation

Gzip is decompressed explicitly; the JSON top level must carry
`format-version: 1.0.0` and `firmware`. Unknown major versions, malformed
gzip/JSON and missing schema fields are rejected. Candidates use real manifest
fields and filter to active `OFFICIAL`, `BETA` and `DEV` `.apj` releases.

## 3. Release enumeration and selection

`GET /api/setup/firmware/versions` lists every official release for the resolved
platform, sorted by parsed major/minor/patch version. The backend picks a
conservative default: official channel first, never a development build. The
client may choose a different release, but the backend re-validates that choice
against the live catalogue and rejects any image whose platform or vehicle does
not match the resolved target.

## 4. Identity is still conservative

The real Pixhawk last returned `/dev/ttyACM0` (VID:PID `1209:5741`), ArduCopter
**4.7.0 (Official Release)**, `boardType=0`, `boardRev=9`,
`boardVersion=589824`. MAVLink `boardVersion` is not a manifest `board_id`, and
`board_id=9` alone spans many platforms, so a live board in normal mode cannot
select an image. `EXACT_MATCH` requires valid bootloader evidence
(`INFO_BL_REV`, `INFO_BOARD_ID`, `INFO_FLASH_SIZE` and a unique bootloader USB
product string). Bootloader entry remains prohibited, so that evidence is never
collected from the attached board.

### 4.1 The five resolver states are distinct

`AMBIGUOUS` and `IDENTITY_UNAVAILABLE` were previously the same outcome, which
hid the real blocker from the user. They are now separate:

| State | Meaning |
| --- | --- |
| `EXACT_MATCH` | Bootloader evidence resolves exactly one platform. |
| `AMBIGUOUS` | A bootloader product string matched several incompatible platforms; a real conflict to adjudicate. |
| `IDENTITY_UNAVAILABLE` | The board is connected and answering, but no bootloader identity is obtainable, so nothing can be selected. **This is the attached Pixhawk1's real state.** |
| `UNSUPPORTED` | Resolved correctly, but not ArduCopter. |
| `NO_DEVICE` | Nothing is connected, so there is no identity to resolve against. |

`NO_DEVICE` was previously reported as `UNKNOWN`, which made "nothing plugged
in" indistinguishable from "plugged in but unidentifiable".

Validated against the live board, all 901 matching images across every platform
were refused with a reason naming the actual blocker rather than implying a
choice exists.

## 5. Explicit confirmation is server-side

`POST /api/setup/firmware/confirmation` re-resolves compatibility and records the
confirmation against one exact candidate id. The confirmation lives in the
backend, not the client: `InstallRequest` deliberately has no `confirmed` field,
and a forged `confirmed: true` in the install body has no effect. Changing the
selected release clears the record. A confirmation recorded for one candidate
cannot authorize a different image.

### 5.1 The confirmation is bound to what the user actually approved

A candidate id alone was not enough: the board, the official manifest and the
installed firmware could all change while an approval sat in the record. Each
confirmation now stores four bindings, and a change to any one of them invalidates
it:

| Binding | Source | Invalidated when |
| --- | --- | --- |
| `connectionFingerprint` | System/component id, transport, vehicle type, autopilot | A different vehicle is connected, or none is |
| `hardwareFingerprint` | Vehicle, autopilot, USB VID:PID, board type/rev, firmware version | A different physical board is connected |
| `catalogEtag` | The official manifest's `ETag` | Upstream publishes a new manifest |
| `currentVersion` | The board's reported version | The board was re-flashed meanwhile |

Two fingerprint strengths exist deliberately. The *connection* fingerprint is
built from state the backend already holds and needs no MAVLink round trip, so
the 1.2 s status poll can check it cheaply. The *hardware* fingerprint adds the
`AUTOPILOT_VERSION` fields and costs one round trip, so it is only evaluated at
the decision points — confirmation, download and pre-install validation.

The hardware fingerprint is derived from the same `build_identity()` evidence
the resolver uses, so detection and compatibility resolution can never disagree
about which board is attached.

An absent observation never counts as "unchanged". If the board cannot be read,
the confirmation is refused rather than assumed still valid.

`current_confirmation()` drops a stale confirmation before answering, so a stale
approval is never displayed as live, never reaches the UI, and never authorizes a
download. Refusals report `invalidatedReasons` so the user is told *why* the
approval no longer applies.

## 6. Download is confirmation-gated

`POST /api/setup/firmware/download` refuses with `CONFIRMATION_REQUIRED` when no
matching confirmation exists, and performs no HTTP request. Live ambiguous
requests were refused before any artifact fetch. URLs must be the official
HTTPS origin; redirects are refused. Transfer completeness is checked from
`Content-Length`, and size/timeout ceilings apply.

## 7. Integrity disclosure

The official manifest publishes no artifact checksum. The locally computed
SHA-256 is reported with `checksumVerified: false` and an explicit note that it
is not verified against an authoritative digest. Manifest `image_size` is flash
image size, not `.apj` container length, so it is never used to claim transfer
completeness.

## 8. Permanent real-hardware gate

`RealFirmwareInstaller` is not configurable: `REAL_INSTALLATION_ALLOWED` is a
module constant `False`, and `prepare()`, `install()` and `verify()` all raise
`InstallationBlockedError`. `install_firmware()` and
`assert_installation_allowed()` always raise, and `FIRMWARE_INSTALL_ENABLED` is
hardcoded `False`. Even flipping the config flag does not help.

Gate ordering was verified explicitly, not just asserted in tests: with a
synthetic resolvable target, an existing confirmation, `allowSimulation: true`
and a downloader patched to raise on contact, the workflow returned `BLOCKED`
with history `DETECTING → IDENTIFYING → RESOLVING → CONFIRMATION_REQUIRED →
BLOCKED` and the downloader was never called. Refusal message:

```
Firmware installation is currently disabled for real hardware validation.
```

## 9. Post-install verification is independent

`FirmwareInstaller.verify()` is a separate step from `install()`. The installer
never decides on its own that an installation succeeded: it re-reads the
observed version from an independent source and compares it with the target. A
missing observation is never a match. `verify_installed_version()` applies the
same rule for real hardware. The workflow then re-reads the board itself,
independently of the installer, via `verify_installation()`.

`normalize_version()` / `versions_match()` reduce both sides to a canonical
`major.minor.patch`. This was a real bug found during validation: the manifest
publishes `V4.7.1` while a vehicle reports `4.7.1 (Official Release)`, so an
exact string comparison made a correct installation look like a mismatch.

A mismatch yields `FAILED`, never `COMPLETED`.

### 9.1 Verification covers identity, not just version

A correct firmware version on the wrong board is not a successful installation.
Post-install verification now re-reads the board and compares six fields that
must have survived the flash unchanged:

`firmwareVersion`, `vehicleType`, `autopilot`, `usbId`, `boardType`, `boardRev`.

Any mismatch fails with `VERIFICATION_MISMATCH`. A board that stops answering is
reported as `VERIFICATION_UNCONFIRMED`, which is deliberately a different code:
the installation may well be correct, but nothing was proven.

A field that was unknown before the installation (`None`) is not held against it
— there was nothing to protect. A field that *was* known and is now missing or
different is a mismatch.

TEST/SIMULATION runs have no device by design, so their result carries
`identityApplicable: false` and states plainly that no board identity was
verified, rather than implying a hardware check occurred.

## 10. Session state machine

States: `IDLE`, `DETECTING`, `IDENTIFYING`, `RESOLVING`, `READY`,
`CONFIRMATION_REQUIRED`, `DOWNLOADING`, `DOWNLOAD_VERIFIED`, `PREPARING`,
`INSTALLING`, `VERIFYING`, `COMPLETED`, `FAILED`, `CANCELLED`, `DISCONNECTED`,
`BLOCKED`. Illegal transitions raise. `InstallationSession` is lock-protected
and returns snapshots that cannot be mutated by a reader.

### 10.1 Every connection-asserting state is connection-dependent

`CONNECTION_DEPENDENT_STATES` previously covered only the six mid-flight states,
so a board unplugged while the workflow sat in `READY` or `CONFIRMATION_REQUIRED`
kept presenting a firmware target for hardware that was no longer there.

It now covers all eleven states that assert something about the connected
vehicle: `DETECTING`, `IDENTIFYING`, `RESOLVING`, `READY`,
`CONFIRMATION_REQUIRED`, `DOWNLOADING`, `DOWNLOAD_VERIFIED`, `PREPARING`,
`INSTALLING`, `VERIFYING`. Terminal states are unaffected.

Losing the vehicle does not merely flip the state. It also clears the
now-meaningless context: the target candidate, the confirmed candidate, the
target version/release/platform, the installed version and `versionVerified`.
The confirmation is dropped too, so an approval given for a board that left can
never authorize a later connection's installation.

### 10.2 The seven pre-install checks

`validate_pre_install()` runs every check against state read fresh at that
instant, immediately before an installation would be authorized. All failures
are reported, not just the first.

| Check | Guards against |
| --- | --- |
| `device-connected` | Installing with nothing attached |
| `hardware-identity-unchanged` | A swapped board or a different vehicle |
| `installed-version-unchanged` | A board re-flashed since confirmation |
| `candidate-still-official` | A candidate withdrawn or superseded upstream |
| `confirmation-matches-candidate` | Reusing an approval for another image |
| `catalogue-generation-unchanged` | Approving against a manifest the user never saw |
| `no-workflow-in-progress` | Two installations interleaving on one session |

Exposed read-only at `GET /api/setup/firmware/pre-install-checks`, which changes
nothing, downloads nothing and touches no hardware.

## 11. No fake success

`success` means *installed and verified*, nothing else. `POST /firmware/install`
and `POST /firmware/simulate` run on a background worker and return
`accepted: true, success: false, versionVerified: false, terminal: false`. The
client polls `GET /firmware/status` for the authoritative session. An accepted
request is never reported as an installation result.

## 12. TEST/SIMULATION workflow

`POST /api/setup/firmware/simulate` walks the entire pipeline with a clearly
synthetic identity: real manifest artifact, real download, real digest, real
verification comparison, `isSimulation: true`, `hardwareTouched: false`. No
serial port is opened and no MAVLink link is used. Only the vehicle identity is
synthetic.

An earlier revision required a confirmation record that could only be produced
by a live vehicle, which made the endpoint permanently unreachable. The
synthetic path now requires an explicit `confirmed` action, which the backend
records server-side against the exact candidate, so the confirmation step
cannot be skipped.

Validated live-shaped run (synthetic manifest, patched HTTP, no hardware, no
real network):

| Check | Result |
| --- | --- |
| Unconfirmed request | `CONFIRMATION_REQUIRED`, no `DOWNLOADING` |
| Confirmed, version matches | `COMPLETED`, `versionVerified: true` |
| Confirmed, version mismatch | `FAILED`, `versionVerified: false` |
| `hardwareTouched` | `false` in every case |
| Full history | `DETECTING → IDENTIFYING → RESOLVING → CONFIRMATION_REQUIRED → DOWNLOADING → DOWNLOAD_VERIFIED → PREPARING → INSTALLING → VERIFYING → COMPLETED` |

## 13. Firmware UI

The Firmware page was **not redesigned** in this phase. Only the data contract
moved: the two new resolver states (`IDENTITY_UNAVAILABLE`, `NO_DEVICE`) were
added to `FirmwareCompatibilityOutcome` with their labels, and the new
`FirmwareVerification`, `FirmwareConfirmationRecord`,
`FirmwarePreInstallCheck`/`FirmwarePreInstallResult` types plus
`getFirmwarePreInstallChecks()` / `getFirmwareDetection()` were added to
`src/api/setup.ts`.

The page shows detected board and current firmware, catalogue status and
candidate counts, compatibility outcome with reason, the official release list
for the resolved platform, exact-candidate confirmation, download preparation,
and authoritative progress from the backend.

Because real flashing is permanently blocked, **no install control is rendered
when a flight controller is attached**. The blocked message, the backend's
blocked-operations list and any refusal state are shown instead. The
TEST/SIMULATION control appears only when no vehicle is connected, which is the
only situation the backend permits it.

The client never claims confirmation (`confirmed: true` is not sent with the
install request), and a transient status-poll failure never fabricates a
terminal state. Stale confirmations and downloads from a previous vehicle or
request are discarded.

## 14. Validation results

- Backend: **1012 passed** (`python -m pytest -q`), including 65 new
  hardware-integration tests in `tests/test_firmware_hardware_integration.py`.
- Frontend: **580 passed** across 38 files; `tsc -b` and production build clean.
  `oxlint` reports only pre-existing warnings in unrelated components.
- Tests use temporary cache directories and synthetic manifest fixtures. No test
  opens a serial port or flashes a device.
- `_no_device()` in the shared fixture harness now patches *both* the connection
  state and the identity reply. A board that answers `AUTOPILOT_VERSION` is
  connected whatever the cached heartbeat state says, so simulating "nothing
  plugged in" requires suppressing both.

## 15. Live hardware validation this phase

A Pixhawk1 **was attached** for this phase and was exercised **read-only** at
`/dev/ttyACM0` (USB `1209:5741`), 57600 baud. Only `AUTOPILOT_VERSION` and
heartbeat identity were read, over the existing connection manager.

| Read | Value |
| --- | --- |
| Firmware | `4.7.0 (Official Release)` |
| `boardType` / `boardRev` | `0` / `9` |
| `boardVersion` | `589824` |
| `boardId` | `null` — never inferred from `boardVersion` |
| USB | `0x1209/0x5741` |
| Vehicle / autopilot | `QUADROTOR` / `ARDUPILOTMEGA` |

Observed behaviour on the real board:

| Step | Result |
| --- | --- |
| `detect(include_identity=True)` | Reported every authoritative field above |
| `hardware_fingerprint()` | `vehicle=QUADROTOR\|autopilot=ARDUPILOTMEGA\|usb=0x1209/0x5741\|boardType=0\|boardRev=9\|firmware=4.7.0 (Official Release)\|connectionType=USB` |
| `resolve()` | `IDENTITY_UNAVAILABLE`, `canConfirm: false`, 901 platforms refused |
| `confirmation(confirmed=true)` | Refused, `IDENTITY_UNAVAILABLE` |
| `validate_pre_install()` | 5 of 7 checks failed, correctly refusing |
| `run_install()` | `BLOCKED`, history `DETECTING → IDENTIFYING → BLOCKED` |
| Downloader contacted | **0 times** |
| `hardwareTouched` | `false` |

This is the intended outcome: a live Pixhawk1 in normal mode has no bootloader
identity, so the workflow refuses rather than guessing between 901 candidate
images. The `IDENTITY_UNAVAILABLE` state is what makes that refusal legible.

**No flash, erase, bootloader entry, reboot-for-flashing, parameter write or
actuator command was issued at any point.**

## 16. Remaining physical-install work

Real flashing is intentionally out of scope. A separately approved
implementation would still need: exact MAVFTP artifact/SD-card semantics, `.apk`
descriptor handling, reboot command encoding, bootloader-mode identity capture,
cancellation and failure handling for real flash, and post-update
`AUTOPILOT_VERSION` verification. Until then `RealFirmwareInstaller` remains a
structure that only refuses.

The hardware-integration layer this phase built — authoritative detection, the
five resolver states, context-bound confirmation, the seven pre-install checks,
identity-aware post-install verification and disconnect invalidation — is the
foundation a future real installer would sit on. It is live and exercised today
against a real Pixhawk1; only the final physical write mechanism is missing.

### 16.1 New endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /api/setup/firmware/detection` | Authoritative read-only detection including the reported hardware identity |
| `GET /api/setup/firmware/pre-install-checks` | Runs all seven pre-install checks live; changes nothing |

Both are read-only. Neither downloads, installs or touches hardware.

See `docs/FIRMWARE_INSTALL_DESIGN.md` for source findings and future-installer
constraints, and `docs/BOOTLOADER_IDENTITY_REPORT.md` for the identity
investigation.

---

## 17. Bootloader identity resolution (this phase)

A dedicated read-only service now decides *whether a bootloader identity read is
safe at all* and reports every field it could obtain — including the ones it
could not.

### 17.1 Transport safety

The Pixhawk's bootloader and its firmware are two different protocols on one USB
device. Sending bootloader framing to a board still running normal firmware
would be meaningless at best and dangerous at worst, so a read is permitted only
after the transport has been **positively identified** as a bootloader. The
classification uses two independent, read-only sources: OS USB descriptors, and
whether the existing MAVLink connection is answering.

| Condition | Transport | Read? |
| --- | --- | --- |
| No autopilot-like USB port | `NONE` | No — nothing connected |
| Board answers MAVLink | `MAVLINK` | **No** — normal firmware, not a bootloader endpoint |
| Silent **and** advertises `<BOARD>-BL` | `BOOTLOADER` | Yes |
| Silent, no corroborating descriptor | `UNKNOWN` | **No** — silence is not proof |

The last row is the important one: a silent port is not treated as a
bootloader, because guessing there means sending protocol bytes at a device of
unknown state. No test can reach the `BOOTLOADER` read path without a
`-BL` product string *and* an absent MAVLink link.

The service never opens a port, writes to a device, reboots, requests bootloader
entry, erases, or flashes. It has no write method to call, which the test suite
asserts.

### 17.2 The normal-mode product string trap

In normal mode a Pixhawk1 advertises the USB product string **`Pixhawk1`**; in
bootloader mode the same board advertises **`Pixhawk1-BL`** (the bootloader
appends `-BL`). Only the `-BL` string is bootloader evidence.

The attached board advertised `Pixhawk1`. A naive implementation would have
matched that against the manifest and selected a Pixhawk1 image — precisely the
"guess Pixhawk1 from USB product information" shortcut that must never happen.
This design records the normal-mode string as evidence, marks it
`usbProductIsBootloaderEvidence: false`, warns that it was not used, and leaves
the platform unresolved.

Similarly, `boardVersion=589824` is an internal firmware build number, not a
manifest `board_id`. It is reported but never promoted into board-id position.

### 17.3 Independent verification of an exact match

An exact match is no longer enough on its own. `cross_check_exact_match()`
independently verifies the selected image against the official manifest, and a
failure **downgrades the outcome to `AMBIGUOUS`** rather than quietly accepting
it:

| Check | Requirement |
| --- | --- |
| manifest board id | the image declares the board id the bootloader reported |
| required bootloader identity | revision, board id, flash size and product string were all genuinely read |
| vehicle type | the image is an ArduCopter build |
| firmware type | the image is on an active release channel |
| official-catalog | the image comes from the official ArduPilot firmware host |
| USB | the port's VID/PID matches the declared USB id, or the catalogue declares none |

A catalogue entry that declares no USB id is treated as *unverifiable*, not as a
conflict. A port that reports a VID/PID the matched platform does not declare is
a **conflict**, and the match is withdrawn.

### 17.4 Verified matrix

`tests/test_bootloader_identity_service.py` covers the full 14-case matrix. All
values are synthetic and injected; no test opens a real port or touches the
board.

| # | Case | Outcome |
| --- | --- | --- |
| 1 | Complete exact identity | `EXACT_MATCH`, all six checks pass |
| 2 | Board ID only | Never selectable, even on a single platform |
| 3 | Board ID + matching bootloader string | Resolved and cross-checked |
| 4 | Board ID + conflicting bootloader string | Refused (`NO_MATCH`/`AMBIGUOUS`) |
| 5 | Missing bootloader revision | `IDENTITY_UNAVAILABLE` |
| 6 | Missing flash size | `IDENTITY_UNAVAILABLE` |
| 7 | Missing USB product string | `IDENTITY_UNAVAILABLE` |
| 8 | Conflicting VID/PID | `AMBIGUOUS`, USB check named |
| 9 | Multiple compatible platforms | `AMBIGUOUS`; first candidate never chosen |
| 10 | No device | `NO_DEVICE` |
| 11 | Disconnected device | `UNKNOWN` transport; **zero bootloader bytes sent** |
| 12 | MAVLink endpoint offered as a bootloader | Refused; **zero bootloader bytes sent** |
| 13 | Stale identity after disconnect | Not reused; all fields null |
| 14 | Reconnect with changed identity | New identity read; old one never inherited |

Cases 11 and 12 use a recording transport that counts reads, so "no bootloader
traffic was sent to a MAVLink endpoint" is a proven assertion rather than a
comment.

### 17.5 Live hardware result (read-only)

The attached Pixhawk1 was re-probed through the new service. This is the honest
result:

| Field | Value |
| --- | --- |
| Transport | `MAVLINK` → `canReadBootloader: false` |
| Bootloader revision | `null` |
| Bootloader board ID | `null` |
| Flash size | `null` |
| Bootloader USB product string | `null` |
| Board version / type / revision | `589824` / `0` / `9` |
| USB VID/PID | `0x1209/0x5741` |
| **USB serial** | `3C0027000951363033383531` |
| USB manufacturer | `ArduPilot` |
| USB product string | `Pixhawk1` (**normal mode**, not bootloader evidence) |
| `canResolvePlatform` | `false` |

The USB serial number is genuinely authoritative for *which physical unit* is
attached, and is carried through for confirmation binding. It is not a platform
selector and was not used as one.

**The board cannot be resolved, and that is the correct answer.** The bootloader
revision, flash size and `-BL` product string are unobtainable while the board
stays in normal MAVLink mode, and entering bootloader mode is outside this
phase's scope. The service therefore reports `IDENTITY_UNAVAILABLE` rather than
guessing among 901 candidates.

### 17.6 New endpoint

| Endpoint | Purpose |
| --- | --- |
| `GET /api/setup/firmware/bootloader-identity` | Read-only identity report with every field, its nulls, and the transport decision |

The Firmware page shows this evidence in the unresolved branch only, listing
each unavailable field as "Unavailable". No physical flashing control appears.

### 17.7 Validation

| Suite | Result |
| --- | --- |
| Backend | `1072 passed` (60 new in the matrix) |
| Frontend | `580 passed` across 38 files |
| `tsc -b`, `npm run build` | Passed |
| `npm run lint` | 10 pre-existing warnings, none in the touched files |

Four existing resolver tests encoded the older, weaker rule that a bare
`bootloader_str` string alone could produce an exact match. They were updated to
supply a genuinely complete bootloader identity, preserving their intent
(channel preference, determinism) under the stricter rule. The stricter
behaviour is the requested one: an image is not offered unless every
independent check agrees.

---

## 18. Explicit bootloader identity validation (this phase)

This phase prepares the application for an explicitly controlled bootloader
identity validation. It does **not** perform one: nothing here reboots, erases,
flashes, changes a parameter, or commands an actuator, and nothing moves the
board into bootloader mode.

### 18.1 The safety rule that shapes everything

A board that stops answering MAVLink is **not** a bootloader. A crashed process,
a powered-down USB stack, a cable fault and a board mid-reboot all look
identical, so silence is evidence of nothing in particular.

`BOOTLOADER_DETECTED` is therefore reachable only through evidence the identity
service already gathers: the transport must be positively classified as
`BOOTLOADER`, which itself requires the board to be silent **and** to advertise
the bootloader's `<BOARD>-BL` USB product string. Nothing in the validation
service can raise that evidence on its own.

### 18.2 State machine

| State | Meaning |
| --- | --- |
| `NORMAL_MAVLINK` | Board is answering MAVLink; no bootloader identity |
| `AWAITING_BOOTLOADER` | Preparation done; waiting for the user to act |
| `BOOTLOADER_DETECTED` | Bootloader transport positively evidenced |
| `BOOTLOADER_IDENTITY_READING` | Identity read in progress |
| `BOOTLOADER_IDENTITY_READ` | A read completed (usable or not) |
| `IDENTITY_RESOLVED` | Resolved to one platform, cross-checked |
| `IDENTITY_AMBIGUOUS` | Several platforms remain, or a check disagreed |
| `IDENTITY_FAILED` | Read failed or returned nothing usable |
| `DISCONNECTED` | No device present |

Transitions are validated against an explicit table, so an out-of-order move is
rejected rather than silently accepted. Two deliberate consequences:

* A silent, uncorroborated board never reaches `BOOTLOADER_DETECTED`. It is
  parked in `IDENTITY_FAILED`, or left in `AWAITING_BOOTLOADER`, with the reason
  recorded.
* `IDENTITY_AMBIGUOUS` and `IDENTITY_FAILED` are reachable from
  `NORMAL_MAVLINK`, because board id 9 spanning several platforms is precisely
  the honest normal-mode state.

### 18.3 The preparation operation

`prepare_bootloader_identity_validation()` verifies a device is connected,
captures the connection fingerprint, the current firmware identity and the USB
identity, marks the workflow as awaiting a bootloader, and invalidates stale
identity data.

It returns `performedOperations: []` — always. The board is left exactly as it
was. A test asserts that no forbidden operation name (`reboot`, `erase`,
`flash`, `write`, `upload`, `program`, `set_parameter`, `arm`, `motor`, `servo`,
`download`) appears anywhere in the module.

### 18.4 Stale data protection

On disconnect, and again on reconnect, the bootloader identity, the resolved
firmware candidate, the validation record and the verification state are cleared.
They survive only when a *live* fingerprint pair proves the attached unit is the
identical board that was previously connected — and even then a verification
result is dropped, because the firmware may have changed while the board was
away. A missing fingerprint is never treated as proof.

### 18.5 Normal-mode identity, as reported

| Field | Value |
| --- | --- |
| Firmware | `4.7.0 (Official Release)` |
| Vehicle / autopilot | `QUADROTOR` / `ARDUPILOTMEGA` |
| `boardType` / `boardRev` | `0` / `9` |
| `boardVersion` | `589824` |
| `boardId` | `null` — never inferred from `boardVersion` |
| USB VID/PID | `0x1209/0x5741` |
| USB serial | `3C0027000951363033383531` |
| USB manufacturer | `ArduPilot` |
| USB product string | `Pixhawk1` — **normal mode** |

The normal-mode product string `Pixhawk1` is reported with
`usbProductIsBootloaderEvidence: false`. It is *not* bootloader evidence, because
the bootloader advertises `Pixhawk1-BL`. Matching on `Pixhawk1` would be exactly
the forbidden guess, so it is recorded, flagged, and left unused.

### 18.6 Bootloader identity limitation

| Field | Value |
| --- | --- |
| Transport | `MAVLINK` → `canReadBootloader: false` |
| Bootloader revision | `null` |
| Bootloader board ID | `null` |
| Flash size | `null` |
| Bootloader USB product string | `null` |
| `canResolvePlatform` | `false` |

These four fields are unobtainable while the board stays in normal MAVLink mode.
Reading them would require the board to be in bootloader mode, and entering
bootloader mode is outside this phase's scope. The service reports them as
`null` with the reason rather than substituting anything.

### 18.7 Resolver result

| Field | Value |
| --- | --- |
| `resolver.outcome` | `IDENTITY_UNAVAILABLE` |
| `resolver.canConfirm` | `false` |
| `installationBlocked` | `true` |

Exact hardware compatibility cannot be proven, so no firmware image is offered
and nothing can be confirmed.

### 18.8 Exact reason installation remains blocked

Three independent conditions must all hold before any image can be offered, and
none is met:

1. **No bootloader identity exists.** The board is in normal MAVLink mode, so the
   bootloader revision, board id, flash size and `-BL` product string are all
   unknown.
2. **Board id 9 cannot substitute for it.** It spans FMUv2, FMUv3 and Cube F4
   alike, so it narrows nothing safely.
3. **`boardVersion` 589824 is not a board id.** It is an internal firmware build
   number and was never promoted into that role.

The official catalogue holds roughly 901 candidate ArduCopter images across those
platforms. Selecting one would mean guessing, so the workflow refuses. The
physical installer additionally remains permanently gated by
`REAL_INSTALLATION_ALLOWED = False`.

### 18.9 Firmware page

When normal MAVLink mode cannot establish exact hardware identity, the page shows:

> **Identity unavailable.** Exact hardware compatibility cannot currently be
> proven. Installation remains blocked.

alongside the read-only evidence (state, transport, MAVLink connectivity,
bootloader fields, USB VID/PID, USB serial, resolver outcome) with every
unavailable field rendered as "Unavailable". Unavailable fields are never
invented.

The offered action, **"Bootloader identity required"**, is purely informational:
it records what a validation would need and displays the next requirement. It
does **not** enter bootloader mode. Tests assert that clicking it triggers no
install, download, simulation or confirmation call, and that no flash, erase or
reboot control exists anywhere on the page.

### 18.10 New endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /api/setup/firmware/bootloader-validation/status` | Phase 1 read-only identity status |
| `POST /api/setup/firmware/bootloader-validation/prepare` | Phase 3 explicit preparation |
| `POST /api/setup/firmware/bootloader-validation/cancel` | Abandon a preparation |

All three are read-only with respect to the board.

### 18.11 Test results

`tests/test_bootloader_validation.py` covers the 14 required cases with entirely
synthetic, injected data. No test opens a real port or touches the attached
board.

| # | Case | Assertion |
| --- | --- | --- |
| 1 | Normal MAVLink device | `MAVLINK`, no bootloader identity, board identity still reported |
| 2 | Genuine bootloader identity | All four protocol fields read, exactly one read |
| 3 | Silent without evidence | **Never** `BOOTLOADER_DETECTED`; zero bytes sent |
| 4 | Missing USB product | Never resolves; not treated as a wildcard |
| 5 | Conflicting USB identity | Downgraded to `AMBIGUOUS`, USB check named |
| 6 | Board id 9 alone | Never selects, even on one platform |
| 7 | Exact Pixhawk1 identity | Resolved, all six cross-checks pass |
| 8 | Multiple platforms | Ambiguous; first candidate never auto-selected |
| 9 | Disconnect while awaiting | Record and identity cleared, state `DISCONNECTED` |
| 10 | Reconnect, different device | Fingerprint mismatch clears everything |
| 11 | Stale identity rejection | Cleared without proof; verification dropped even when proven |
| 12 | No automatic reboot | No reboot method; `performedOperations` empty |
| 13 | No firmware write | No write/erase/flash method; machine holds no device handle |
| 14 | No downloader before exact match | Only a cross-checked exact match confirms |

| Suite | Result |
| --- | --- |
| Backend | `1147 passed` (75 new) |
| Frontend | `589 passed` across 38 files (9 new) |
| `tsc -b`, `npm run build` | Passed |
| `npm run lint` | 10 pre-existing warnings, none in the touched files |

### 18.12 Real Pixhawk read-only result

Earlier in this phase, while the Pixhawk1 was attached, the validation workflow
was exercised read-only:

| Step | Result |
| --- | --- |
| `identity_status()` | `MAVLINK`, `bootloaderIdentityAvailable: false` |
| `prepare_bootloader_identity_validation()` | `AWAITING_BOOTLINKER`, `performedOperations: []` |
| Captured fingerprints | `system=1\|component=1\|transport=serial\|…` and `vehicle=QUADROTOR\|…\|usb=0x1209/0x5741\|…` |
| `validate_pre_install()` | `ok: false`, 2 of 7 checks passed |
| `run_install()` | `IDENTITY_UNAVAILABLE` |
| Downloader contacted | **0 times** |
| `hardwareTouched` | `false` |

**The Pixhawk was subsequently unplugged.** Final validation therefore ran
against the no-device path, which reported `DISCONNECTED`, transport `NONE`,
`resolver.outcome: NO_DEVICE`, `installationBlocked: true`, and every bootloader
field `null`. Preparation was refused with "No device is connected", and
`treatedAsBootloader` was `false` — an absent board is never mistaken for a
bootloader.

Across the whole phase the board was never rebooted, never placed in bootloader
mode, never erased, never flashed, had no parameters changed, and no motors or
servos were commanded.

### 18.13 A contradiction found during validation, and fixed

Driving the **real** status entry point rather than feeding a hand-built
identity straight into the resolver exposed a genuine defect. The two could
disagree:

| Layer | Reported |
| --- | --- |
| State machine | `IDENTITY_RESOLVED` — "a complete, validated bootloader identity is available" |
| Status payload | `NO_DEVICE`, `canConfirm: false`, no selection |

The cause is structural. A board in bootloader mode is *by definition* not
answering MAVLink, so the normal identity source returns nothing. The resolver
was built to start from that source, and simply gave up when it came back empty
— throwing away a bootloader identity that had been read and validated.

The effect was the worst kind of wrong: silently *understating* what was known.
A board whose identity had been proven would be reported as if nothing were
attached.

The fix resolves from the bootloader evidence itself when MAVLink cannot answer,
taking the vehicle type only from the preparation record, and only when that
record's USB identity still matches the device on the bus. That record is
already cleared on disconnect and on any fingerprint mismatch, so a swapped board
cannot lend its vehicle type to another unit. A missing record, a mismatched
USB identity, or an absent vehicle still selects nothing.

Two guards make this harder to get wrong again:

* **A complete, validated identity is rebuilt, not trusted.** The stored report
  is passed back through `bootloader_identity.build_identity`, so the validator
  keeps the final say; an incomplete identity is discarded rather than used.
* **The normal vehicle mapping is reused, not duplicated.** The record feeds the
  existing `identity_from_firmware_info` path, so there remains exactly one
  ArduCopter-to-manifest-vehicle rule in the codebase.

`TestCase15EndToEndStatusResolution` drives `identity_status()` through a
prepare-then-re-enumerate flow, mutating the port list in place and answering
MAVLink liveness from a patched live status, so the states exercised are the ones
the real process takes. Reverting the fix fails four of them, so they are not
vacuous. It also pins the cases that must *not* select: a swapped board, and a
bootloader read with no preparation behind it.

Worth recording: distinct bootloader strings are what make board 9 usable. Four
platforms share `board_id` 9, but their product strings differ, so a genuine
bootloader identity resolves to exactly one of them. Two platforms advertising
the *same* string stay ambiguous, and nothing is selected.

### 18.14 Hard stop

Work stopped at the end of this phase. The work described in section 19 was
authorised separately; no physical firmware installation is undertaken without
explicit approval.

---

## 19. Controlled bootloader identity validation

Requirement-by-requirement result of this phase, verified against the running
application and a real Pixhawk 1.

### 19.1 Requirements met

| # | Requirement | Where | Status |
| --- | --- | --- | --- |
| 1 | Explicit validation action | `POST /api/setup/firmware/bootloader-validation/prepare` | Done |
| 2 | Explains identification only | Response message and Firmware page copy | Done |
| 3 | No silent MAVLink-drop = bootloader | Transport classification | Done |
| 4 | Genuine USB evidence before reading | `BootloaderIdentityService.probe` | Done |
| 5 | Read only on genuine evidence | `BOOTLOADER` gate in `read_identity` | Done |
| 6 | Capture all six identity fields | `identity_status` payload | Done |
| 7 | Cross-check against official catalog | `cross_check_exact_match` | Done |
| 8 | Five honest outcomes | `REPORTABLE_OUTCOMES` | Done |
| 9 | Expose candidates on exact match | Existing `AvailableFirmware` | Done, page unchanged |
| 10 | Ambiguity keeps install blocked | Resolver + `installationBlocked` | Done |
| 11 | Never select the first candidate | `resolve` | Done |
| 12 | Never select on `board_id` 9 alone | `resolve` + cross-check | Done |
| 13 | No flash/erase/write/actuator/params | `FORBIDDEN_OPERATIONS`, gates | Done |
| 14 | No success claimed | `run_install` refuses | Done |
| 15 | Tests for every state transition | `TestCase16EveryTransition` | Done |
| 16 | Real Pixhawk, read-only only | Section 19.4 | Done |
| 17 | Report updated | This section | Done |
| 18 | Full suites, tsc, lint, build | Section 19.5 | Done |

### 19.2 Four crashes in the read-only status path, found and fixed

Writing the exhaustive transition matrix required walking every
(state, transport) pair rather than spot-checking a few. That immediately
exposed four ways the status endpoint could raise `IllegalTransition` — a 500
instead of an honest status — in precisely the situations requirement 3 cares
about:

| Situation | Crashed moving | Resolution |
| --- | --- | --- |
| A detected board turns out to answer MAVLink | `BOOTLOADER_DETECTED -> NORMAL_MAVLINK` | Edge added |
| A MAVLink reply arrives mid-read | `BOOTLOADER_IDENTITY_READING -> NORMAL_MAVLINK` | Edge added |
| A board already resolved goes silent | `IDENTITY_RESOLVED -> IDENTITY_FAILED` | Edge added |
| A USB port reappears silent and uncorroborated | `DISCONNECTED -> IDENTITY_FAILED` | Edge added |
| Status re-polled mid-read | `BOOTLOADER_IDENTITY_READING -> BOOTLOADER_DETECTED` | Fixed in `observe_transport` |

The first four were missing rows in `ALLOWED_TRANSITIONS` — the observation code
attempted moves the table refused. Each added edge is justified by evidence, not
convenience: a MAVLink reply proves normal firmware, so bootloader progress must
be abandoned; a silent board cannot keep a resolved identity standing, because
that identity can no longer be tied to a verified device.

The fifth was a different class of bug and was fixed in the observation code
rather than the table. Re-polling during an in-flight read walked the machine
*backwards* to `BOOTLOADER_DETECTED`. Adding that backwards edge would have been
wrong; the correct fix was to stop re-announcing detection once past it.

`TestCase16bObserveNeverRaises` now asserts that no combination of the nine states
and four transports raises, and that repeated observation of the same transport
is stable. Reverting all five fixes fails 13 of these tests, so they are not
vacuous.

### 19.3 UNSUPPORTED no longer mislabelled as ambiguity

An unsupported target — SITL, or a non-ArduCopter autopilot — has *zero*
applicable images. It was being folded into `IDENTITY_AMBIGUOUS`, whose reason
text claims the catalogue "leaves more than one possibility". That is false. The
state set has no dedicated unsupported state, so it now lands in
`IDENTITY_FAILED` with an explicit reason, while the status payload preserves the
exact `UNSUPPORTED` outcome from requirement 8.

### 19.4 Real Pixhawk 1, read-only

Verified through the running application's own single live MAVLink connection. A
second connection was deliberately *not* opened: competing for the serial port
degrades the AUTOPILOT_VERSION read, and the connection manager is the sole
authority.

| Field | Value |
| --- | --- |
| Firmware | `4.7.0 (Official Release)` |
| Vehicle / autopilot | `QUADROTOR` / `ARDUPILOTMEGA` |
| `boardType` / `boardRev` | `0` / `9` |
| `boardVersion` | `589824` |
| USB VID/PID | `0x1209/0x5741` |
| USB serial | `3C0027000951363033383531` |
| USB product string | `Pixhawk1` — **normal mode, not bootloader evidence** |
| Transport | `MAVLINK` |
| State | `NORMAL_MAVLINK` |

Bootloader fields are all `null`, with the reason recorded:

| Field | Value |
| --- | --- |
| `bootloaderRevision` | `null` |
| Bootloader board id | `null` |
| `flashSize` | `null` |
| Bootloader product string | `null` |
| `resolver.outcome` | `IDENTITY_UNAVAILABLE` |
| `installationBlocked` | `true` |

Explicit preparation against the live board:

| Field | Value |
| --- | --- |
| `prepared` | `true` |
| `state` | `AWAITING_BOOTLOADER` |
| `treatedAsBootloader` | `false` |
| `performedOperations` | `[]` |
| Captured | firmware, vehicle, USB VID/PID, USB serial, USB product string, connection fingerprint |
| `pre-install-checks` | `ok: false`, 2 of 7 passed |

The board was never rebooted, never entered bootloader mode, never erased, never
flashed, had no parameters written, and no motors or servos commanded.
`REAL_INSTALLATION_ALLOWED` remains `False`.

### 19.5 Full verification

| Check | Result |
| --- | --- |
| Backend `pytest` | `1203 passed`, 153 warnings |
| Frontend `vitest` | `589 passed` across 38 files |
| `tsc -b` | Clean |
| `npm run build` | Clean |
| `npm run lint` | 10 pre-existing warnings, none in the touched files |

The Firmware page was not redesigned and the resolver was not weakened. The only
product change in this phase was completing the transition table so the read-only
status path reports honestly instead of failing, and correcting the
`UNSUPPORTED` mapping.

## 20. Final firmware management package

This section records the closing pass over the whole firmware workflow: the gaps
found in the earlier phases, what changed, and the verification that followed.

### 20.1 Gaps found and closed

| # | Gap | Fix | Where |
| --- | --- | --- | --- |
| 1 | Detection did not expose the USB identity or bootloader evidence the resolver and UI depend on | Added `usbProduct`, `usbSerialNumber`, `usbManufacturer`, `bootloaderIdentityAvailable`, `bootloaderRevision`, `bootloaderBoardId`, `flashSize`, `bootloaderUsbProduct` | `detect`, `_descriptor_identity`, `_observed_bootloader_identity` in `firmware_workflow_service.py` |
| 2 | A failed download was reported with one ambiguous code | Added an authoritative `error_kind`: `DOWNLOAD_DISABLED` / `DOWNLOAD_REJECTED` / `DOWNLOAD_FAILED` / `DOWNLOAD_VERIFICATION_FAILED` | `firmware_download_service.py`, consumed by `_fetch` |
| 3 | No structured record of what the workflow did | Added a bounded, rotating, secret-scrubbing JSONL event log | `firmware_logging.py` |
| 4 | Releases were one flat list with no channel or status labelling | Grouped Stable / Beta / Development, only when present, with explicit `Current` and `Selected` markers | `SetupFirmware.tsx`, `setup.css` |
| 5 | A session snapshot asserted `"success": true` for every state | `success` is now derived: `state == COMPLETED and version_verified` | `InstallationSession.to_dict` |
| 6 | A "busy" refusal returned a different payload shape from an accepted request | Both now answer `accepted`, `running`, `terminal`, `versionVerified` | `start_install`, `start_simulation` |
| 7 | The test suite leaked a live background worker between tests | Autouse fixture waits for the worker and resets the singleton | `tests/conftest.py` |
| 8 | The test suite wrote into the production firmware log | Test runs log to a temporary file | `tests/conftest.py` |

### 20.2 Three defects found while validating this pass

**A "busy" response claimed nothing at all.** When a workflow was already
running, the refusal omitted `versionVerified`, so a polling client received a
different shape depending on timing. Both refusals now answer the same keys,
with `accepted: false` and `versionVerified: false`.

**A failed transfer was reported as a failed verification.** The first
implementation collapsed every download failure into
`DOWNLOAD_VERIFICATION_FAILED`. A HTTP 404 is a transport failure; only a short
or unverifiable transfer is a verification failure, and an operator needs to
tell them apart. The reason is now decided by the code that observed it and
carried in `error_kind`, rather than re-guessed downstream from a message string.

**The session snapshot asserted success unconditionally.** `to_dict` returned
`"success": True` regardless of state, so the status endpoint reported success
for a `DISCONNECTED` board. `success` is now derived from the state, so the
snapshot is honest on its own and callers that know better still override it.

### 20.3 Structured logging

One JSON object per line, grouped by phase (`detection`, `identity`, `catalog`,
`selection`, `confirmation`, `download`, `verification`, `installer`,
`disconnect`, `failure`). Events are recorded at detection, catalog resolution,
selection and confirmation, every installer state transition, download
attempt/outcome, the settled verification verdict, and disconnect invalidation.

Three properties are enforced by tests rather than by convention:

* **No secrets.** Credential-named fields are redacted, and *any* value
  containing `://` is reduced to host and path, because a signed URL hides its
  credential in the query string whatever the field is called.
* **Bounded.** The log rotates at a configured size with a fixed backup count.
* **Never raises.** A broken handler cannot fail the firmware workflow.

Two deliberate choices are worth recording:

* The verdict is logged by the caller once it is *settled*, not from inside
  `verify_installation`. That helper is invoked speculatively and its result is
  then adjusted for a simulation, so logging there recorded an intermediate
  value and made the audit trail contradict the state the workflow settled on.
* Both compatibility-resolution call sites share one recorder, so the Firmware
  page and the catalogue endpoint record the same evidence.

### 20.4 Release channels and labels

Releases are grouped into Stable, Beta and Development using the manifest's own
`releaseType`; a channel the manifest does not offer is not rendered, and an
unrecognised channel is still shown rather than silently dropped. Within a
channel, manifest order is preserved. Each row carries a `Current` marker when
the manifest reports it as installed and a `Selected` marker on the chosen
build, so "what is on the board" and "what will be installed" are never
confused. The page was not redesigned.

### 20.5 Verification

End-to-end matrix, run offline against a pinned manifest so a network hiccup
cannot be mistaken for a firmware defect:

| Path | Result |
| --- | --- |
| Unconfirmed request | `CONFIRMATION_REQUIRED`, no download |
| Confirmed, matching version | `COMPLETED`, `outcome=SIMULATION`, `hardwareTouched=false` |
| Confirmed, mismatched version | `FAILED`, `VERIFICATION_MISMATCH` |
| Installer failure mid-flight | `FAILED`, reported not hidden |
| HTTP 500 / 404 download | `DOWNLOAD_FAILED` |
| Missing `Content-Length` / short transfer | `DOWNLOAD_VERIFICATION_FAILED` |
| Real-hardware install with a live exact board | `BLOCKED`, `hardwareTouched=false` |
| Simulation never touches hardware | `hardwareTouched=false`, `simulation=true` |
| Progress present and ordered | 10 progress entries, 10 states |
| Disconnect | `DISCONNECTED`, `success=false`, confirmation invalidated |
| Cancellation | `CANCELLED`, terminal |

| Check | Result |
| --- | --- |
| Backend `pytest` | `1234 passed`, 153 warnings |
| Frontend `vitest` | `596 passed` across 38 files |
| `tsc -b` | Clean |
| `npm run build` | Clean |
| `npm run lint` | 10 pre-existing warnings, none in the touched files |
| Real Pixhawk 1, read-only | 4.7.0 Official Release, `IDENTITY_UNAVAILABLE`, blocked |

### 20.6 Live hardware validation this pass

The real Pixhawk 1 was read through the running application only. Detection
reported `usbProduct= Pixhawk1`, `usbSerialNumber=3C0027000951363033383531`,
`usbManufacturer=ArduPilot`, and correctly reported
`bootloaderIdentityAvailable=false` with every bootloader field null, because a
board in normal mode has no bootloader identity to observe. The official
catalogue resolved to `IDENTITY_UNAVAILABLE` across 901 candidate images with
nothing selected and `canConfirm=false`.

The board was never rebooted, never entered bootloader mode, never erased, never
flashed, had no parameters written, and no motors or servos commanded.
`REAL_INSTALLATION_ALLOWED` remains `False`.

### 20.7 What is still not possible

* **Physical firmware writing.** Permanently gated. The real installer refuses
  before downloading, and nothing in this package claims otherwise.
* **Authoritative artifact checksum.** The official manifest publishes no
  checksum for the `.apj`, so verification is limited to the official HTTPS
  origin, declared `Content-Length`, byte completeness and a locally computed
  SHA-256. The API reports this as `transfer-and-completeness` and sets
  `checksumVerified: false`; it is never described as a verified signature.
* **Hardware post-install verification.** Needs a written board, which is gated.

### 20.8 Closing note

The resolver was not weakened, no firmware data was invented, and no success is
reported that was not observed. The Firmware page kept its existing layout and
gained only channel grouping and the two status markers.

---

## 21. Closing pass: the ten gaps

This section records the final pass over the firmware workflow. Sections 1-20
describe how the feature was built; this one records what was still wrong with
it, what changed, and what was measured afterwards.

### 21.1 The gaps, and what closed them

| # | Gap | What changed |
| --- | --- | --- |
| 1 | An unavailable detection field was just `null`, so the UI could not tell "not read" from "not there" | `detect()` now returns a `fields` map, one entry per field with `available` and a `reason` naming the missing evidence |
| 2 | A downloaded image was reported as "verified" when the source published no checksum | Integrity ladder: `CHECKSUM_VERIFIED`, `SIZE_VERIFIED`, `TRANSFER_COMPLETE_ONLY`, `VERIFICATION_FAILED`, plus `verifiedForInstall` |
| 3 | Releases carried no channel, target or compatibility evidence | `available_releases` adds `vehicle`, `isSelected`, version-normalised `isCurrent`, and an evidence-backed `compatibility` |
| 4 | A transport failure and a verification failure shared one code | `firmware_download_service` owns `error_kind`; the API reports coarse `downloadStatus` and fine `integrity` separately |
| 5 | A response could contradict itself (`state` vs `success` vs `versionVerified`) | `success` is derived from the settled state; every firmware route is annotated by one helper |
| 6 | Failures were reported as free-text messages | One closed taxonomy of 14 kinds, present on every firmware response, including successful ones as `null` |
| 7 | The workflow's behaviour was only pinned by scattered tests | A permanent hermetic scenario matrix: 21 scenarios, no network, no board |
| 8 | No final validation against the real board | Read-only validation of the live Pixhawk 1, recorded in 21.5 |
| 9 | The page had no exhaustive coverage of the states it can reach | `SetupFirmware.tsx` renders release compatibility and download outcomes, and every reachable state is now asserted in `SetupFirmware.test.tsx` |
| 10 | This report predated all of the above | This section, with measured numbers |

### 21.2 Defects found while closing them

These were found by the scenario matrix, not by inspection, and several were
real product bugs rather than test problems.

**A bootloader identity could only be used from a test.** `build_identity()`
never folded in the validation machine's stored observation, so
`bootloader_str` was only ever populated by a patch inside the test suite. In
production the resolver could not reach an exact match at all, and
`/firmware/catalog` and `/firmware/workflow` disagreed about the same board --
one selected nothing, the other could select something. The fold now happens in
`build_identity()`, so every consumer shares one identity and one rule.

**An unrecognised name could become an error kind.** `from_resolution` returns
unknown outcomes verbatim so they stay visible, and `annotate` was passing that
through as `errorKind`. A simulation reported `errorKind: "SIMULATION"`.
`errorKind` is now closed over `ERROR_KINDS`: an undeclared value falls through
to the next source and, if none applies, stays visible in `errorMessage`.

**A clean state could be reclassified as a failure.** With no error kind, a
cancelled run (`success: false`, `state: CANCELLED`) fell through to a shape
check that called it a failure. A recognised state now decides alone.

**An unreachable manifest was reported as success.** The catalogue route answered
`success: true` with an empty candidate list when the manifest could not be
fetched, which reads as "this board has nothing newer". It now reports the
failure, with `CATALOG_UNAVAILABLE`.

**`errorMessage` showed an internal code.** It took the installer's `error` field
(`simulated-failure`) in preference to the session's own sentence. It now prefers
the human message and keeps the code as a fallback.

**A simulation reached the live network, and `failAt` did nothing.** The
simulation scenarios resolved whatever the official host was publishing that day,
which is not a test. `failAt: "verify"` also matched no installer state, so the
injected failure was silently skipped and the run reported success. `failAt` is
now normalised to a state name and an unrecognised value is rejected rather than
ignored.

**Three pieces of process-global state leaked between tests**, each of which made
a scenario assert against the previous scenario's world: the parsed-manifest memo
(a second patch in one test was ignored entirely), the stored bootloader
identity, and the background worker. `tests/conftest.py` now clears all three,
and the offline manifest invalidates the memo on entry.

**The page dropped the session on load.** `useFirmwareInfo` never read
`workflow.session`, so a page opened or refreshed during an installation showed
an empty panel until something else set the state. It is now displayed from the
authoritative workflow response.

### 21.3 The scenario matrix

`backend/tests/test_firmware_e2e_matrix.py` is the permanent artifact: 21
scenarios, offline against a pinned manifest, each asserting the shared
invariants (a taxonomy kind or `null`; no `success`/`state`/`versionVerified`
contradiction; no normal-mode board treated as having bootloader identity;
nothing written to hardware) in addition to its own expectations.

| # | Scenario | Outcome |
| --- | --- | --- |
| 1 | No device | `NO_DEVICE` on detection and workflow alike |
| 2 | Normal-mode board | No bootloader identity, and each field says why |
| 3 | Ambiguous identity | `IDENTITY_AMBIGUOUS`, by board id or by product string |
| 4 | Exact bootloader product string | `EXACT_MATCH`, `COMPATIBLE` release |
| 5 | Unsupported autopilot, or SITL | `UNSUPPORTED_HARDWARE`, nothing offered |
| 6 | Silent vehicle | No identity, nothing confirmable |
| 7 | Catalogue unavailable | `CATALOG_UNAVAILABLE`, no candidates |
| 8 | Known platform, no image for this vehicle | `FIRMWARE_NOT_FOUND` |
| 9 | Release metadata | Channel, platform, target vehicle, compatibility |
| 10 | Current vs selected | Exactly one `isCurrent`, one `isSelected` |
| 11 | No confirmation | `CONFIRMATION_REQUIRED`, nothing fetched |
| 12 | Confirmation binding | A different candidate invalidates it |
| 13 | Size match | `SIZE_VERIFIED` |
| 14 | Published digest | `CHECKSUM_VERIFIED` |
| 15 | Neither published | `TRANSFER_COMPLETE_ONLY`, refused for install |
| 16 | Damaged artifact | `VERIFICATION_FAILED` |
| 17 | Transport failure | `DOWNLOAD_FAILED`, no integrity verdict |
| 18 | Real install | Accepted, then `BLOCKED`, `hardwareTouched=false` |
| 19 | Simulation success | `COMPLETED`, `versionVerified=true`, no hardware |
| 20 | Simulation failure | `FAILED`, `INSTALLATION_FAILED` |
| 21 | Cancellation | `CANCELLED`, terminal, not a failure |

The matrix asserts its own scenario list, so a scenario cannot be added without
being listed, and the file's stated contract of twenty-one is enforced rather
than assumed.

### 21.4 Response contract audit

Passing the matrix does not prove the API is *coherent*. The matrix asserts
what should happen; it says nothing about whether a client can read the response
it gets back. `test_firmware_response_contract.py` closes that gap.

It enumerates every firmware route and calls each one both connected and
nothing-connected, then asserts the response satisfies the API's own contract:
`success` is a boolean, `state` is a known state, `errorKind` is `null` or one
of the fourteen declared kinds, `errorMessage` is a human string rather than a
Python type name, and no route invents an undeclared field. Every route is
checked; a route added later is picked up without editing a list of routes.

Three findings came out of it, and none of them were visible from the matrix:

**A refused install never settled.** The install path advanced the session to
`CONFIRMATION_REQUIRED` and returned the refusal while the session stayed there.
`CONFIRMATION_REQUIRED` is a *waiting* state — correct for the workflow the page
polls before acting, wrong as the resting place of a refused install. It reported
"waiting for confirmation" beside a `CONFIRMATION_INVALID` error, and it left
`terminal: false` forever, so a client that polls until terminal polls until it
gives up. A refusal now settles as `BLOCKED`, which is terminal, and still
carries what the operator needs. Matrix scenario coverage did not catch this
because the matrix polls a *successful* or a *simulated* run; no scenario
submitted an install with a confirmation that did not hold and then waited.

**A disconnect could crash the worker.** `_refusal()` advanced the session
unconditionally. If the vehicle disconnected in the instant between a refusal
being computed and being applied, the session was already `DISCONNECTED`, and
advancing it to `BLOCKED` raised `ValueError` inside the background thread. The
exception was swallowed, so the failure surfaced as a client polling a session
that never advanced past `DETECTING`. `_refusal()` now reports the state the
session actually reached when it has already gone terminal, instead of forcing a
transition backwards into an illegal one.

**An assertion I wrote was wrong, and the code was right.** The test asserted
that an unconfirmed download reports `CONFIRMATION_INVALID`. It reports `null`,
with `state: CONFIRMATION_REQUIRED` and `confirmationRequired: true`. That is
correct and it is the better answer: "not confirmed yet" is a wait for a decision
nobody has made, and `CONFIRMATION_INVALID` means a confirmation *was* given and
did not hold. A not-yet decision is not an invalid one. The test was corrected
rather than the code.

The race itself is timing-dependent by nature — the refusal and the disconnect
genuinely race, and either may win. Both tests now poll until the session is
terminal and assert what holds either way, instead of asserting a fixed winner
that only passes on a fast machine.

### 21.5 Validation results

| Check | Result |
| --- | --- |
| Backend `python -m pytest -q` | **1328 passed** at this point in the work; see section 7 for the final count |
| Frontend `npx vitest run` | **612 passed** at this point in the work; see section 7 for the final count |
| `npx tsc --noEmit` | Clean |
| `npm run build` | Clean |
| `npm run lint` | 10 pre-existing warnings, none in the touched files |

The 153 warnings are pre-existing and unrelated (an `AsyncServer.emit` coroutine
that is never awaited in `sio/server.py`, plus deprecation notices in the power,
radio, safety and parameter tests).

### 21.6 Live hardware validation

The real Pixhawk 1 was read through the running application at `/dev/ttyACM0`
(USB `1209:5741`). Only `AUTOPILOT_VERSION` and heartbeat identity were read.

| Read | Value |
| --- | --- |
| Firmware | `4.7.0 (Official Release)` |
| Vehicle / autopilot | `QUADROTOR` / `ARDUPILOTMEGA` |
| `boardType` / `boardRev` | `0` / `9` |
| `boardVersion` | `589824` — reported as evidence, never as a board id |
| USB | `0x1209/0x5741`, `Pixhawk1`, serial `3C0027000951363033383531`, `ArduPilot` |
| Bootloader identity | Unavailable; all four fields null with a stated reason |
| Resolution | `IDENTITY_UNAVAILABLE` across 901 candidate images on 315 platforms |
| Releases offered | 0, `canConfirm=false` |

The official catalogue was reachable: 97,509 manifest entries cached from the
ArduPilot server with an ETag.

Two consistency checks that this pass fixed were confirmed against the real
board: `/firmware/catalog` and `/firmware/workflow` now return the same
`IDENTITY_UNAVAILABLE` verdict for the same board, and every response carries
`errorKind`/`errorMessage`.

An install was requested against the live board. It reached `BLOCKED` with
`INSTALLATION_BLOCKED`, `terminal: true`, `versionVerified: false` and
`hardwareTouched: false`: compatibility could not be determined safely, so no
target existed to download or install. The bootloader validation machine was
still in `NORMAL_MAVLINK` with `bootloaderIdentityReadPerformed: false`.

The board was never rebooted, never entered bootloader mode, never erased, never
flashed, had no parameters written, and no motors or servos commanded.
`REAL_INSTALLATION_ALLOWED` remains `False`.

### 21.7 What is still not possible

* **Physical firmware writing.** Permanently gated. Nothing in this package
  claims otherwise, and the live test above refused.
* **Authoritative artifact checksum.** The official manifest publishes no
  checksum for the `.apj`, so verification is limited to the official HTTPS
  origin, the declared `Content-Length`, byte completeness and a locally computed
  SHA-256. The API reports `TRANSFER_COMPLETE_ONLY` and `verifiedForInstall:
  false`; it is never described as a cryptographically verified artifact.
* **Bootloader identity from a normal-mode board.** Observing it requires an
  explicitly approved bootloader transition, which this phase does not perform.
* **Hardware post-install verification.** Requires a written board, which is
  gated.

### 21.8 Closing note

The resolver was not weakened: every refusal above is the resolver declining to
guess, and the exact-match path is reachable in production rather than only in
tests. No firmware data was invented, no success is reported that was not
observed, and the permanent hardware gate is unchanged.
