# Bootloader Identity Implementation

Phase: **software / architecture / tests only.** No physical bootloader validation was performed.

**The real Pixhawk was never touched.** It was not rebooted, not placed into bootloader mode, not queried with bootloader commands, and nothing was erased or flashed. No serial port was opened. All identity values in this phase come from synthetic fixtures.

---

## 1. Purpose

The investigation (`docs/BOOTLOADER_IDENTITY_REPORT.md`) established **Outcome C**: bootloader identity is necessary but not sufficient for board ID 9. This phase builds the software seam that will eventually consume a real bootloader, and proves it with tests.

```
BootloaderTransport          ← seam; no real client exists yet
        ↓
BootloaderIdentityReader     ← validates; knows nothing about firmware
        ↓
BootloaderIdentity           ← typed, validity-tagged
        ↓
CompatibilityResolver        ← existing firmware_compat_service
        ↓
FirmwareCandidate
```

The compatibility resolver does not import the transport layer. Serial/USB details can therefore never leak into firmware-selection policy; this is enforced by a test.

---

## 2. Identity model — `backend/services/bootloader_identity.py`

`BootloaderIdentity` is a frozen dataclass with four optional fields, matching the four proven signals:

| Field | Manifest/protocol source |
|---|---|
| `bootloader_revision` | `INFO_BL_REV` (`PROTO_GET_DEVICE = 0x22`, arg 0) |
| `board_id` | `INFO_BOARD_ID` (arg 2) |
| `flash_size` | `INFO_FLASH_SIZE` (arg 4) |
| `usb_product_string` | USB descriptors while in bootloader mode |

Plus `source`, `validity`, and `errors`.

Every field is `Optional`. `None` always means "not reported" — never "assume a default".

### Validity states

| State | Meaning | Usable for resolution? |
|---|---|---|
| `VALID` | all four present and in range | Yes |
| `INCOMPLETE` | at least one field missing | **No** |
| `INVALID` | a present value is malformed | **No** |
| `UNAVAILABLE` | no bootloader was reached | **No** |

Only `VALID` *and* complete is consumable (`is_usable_for_resolution`). This is deliberate: a half-read identity must never narrow the manifest, because with ID 9 spanning FMUv2/FMUv3/Cube F4 a partial identity can point at the wrong physical platform.

### Validation is strict and never coerces

- revision must be an `int` in 2..5 (QGC `BL_REV_MIN`/`BL_REV_MAX`)
- board ID must be a positive `int`, **not 0**, and **not 255** (255 is QGC's synthetic FMUv3 marker and must never come from a device)
- flash size must be a positive `int` within a 16 MiB sanity ceiling
- USB product string must be a non-empty `str` within 256 chars

`bool` is rejected everywhere (Python subclass trap: `isinstance(True, int)` is `True`).

Rejected values become `None` **and** produce an error message. There is no clamping, no defaulting, and no silent conversion — `test_invalid_identity_never_becomes_valid_via_missing_values` pins this.

### Board interpretation — `interpret_board_id()`

Mirrors QGC `Bootloader.cc`:

- board ID 9 + flash > `FLASH_SIZE_SMALL` (1032192) + revision >= 5 → large-flash hardware
- board ID 9 + smaller flash → small-flash hardware
- board ID 9 + no flash size → **cannot determine hardware**
- any other board ID → used directly

Every ID 9 result returns `is_ambiguous_id=True` and a note naming FMUv2, FMUv3 and Cube F4.

---

## 3. Transport abstraction — `backend/services/bootloader_transport.py`

`BootloaderTransport` is an abstract base class with three methods:

```python
connect()      # attach to a port ALREADY in bootloader mode
read_info()    # read INFO_BL_REV / INFO_BOARD_ID / INFO_FLASH_SIZE + USB product string
disconnect()   # detach without changing device state
```

### Read-only contract is structural

The interface has **no** `erase`, `program`, `write`, `reboot`, `reboot_to_bootloader` or `flash` method. `test_transport_interface_has_no_mutating_methods` asserts this against `dir(BootloaderTransport)`.

"May read identity" and "may modify a board" can therefore never be confused, and a future flashing capability has to live in a separate, separately-gated module.

`RawBootloaderInfo` is the honest, unvalidated transport output; validation belongs to `build_identity()`, so no transport can smuggle an unchecked value into resolution.

`read_identity()` is a shared convenience that connect→read→disconnect→validate, and **always disconnects**, so a failed read never leaves a port open.

`BootloaderIdentityReader` wraps any transport and re-stamps the source, so a fixture result can never be mistaken for a hardware reading.

### No device is referenced

The modules contain no `/dev/tty*` path, no `import serial`, no `serial.Serial`, and no `open()` in executable code. A test asserts this by parsing the AST with docstrings stripped.

---

## 4. Test adapter — `backend/services/bootloader_fixtures.py`

`FixtureBootloaderTransport` is purely in-memory. It has no default port and performs no enumeration.

| Fixture | board ID | flash | revision | USB product | Expected |
|---|---|---|---|---|---|
| **A** | 9 | 2 MiB | 4 | `Pixhawk1-BL` | VALID |
| **B** | 9 | 2 MiB | 4 | `Pixhawk1-1M-BL` | VALID (different USB string) |
| **C** | 9 | 1,032,192 | 5 | `Pixhawk1-BL` | VALID (different flash) |
| **D** | 9 | 2 MiB | 4 | *missing* | INCOMPLETE |
| **E** | 9 | 2 MiB | *missing* | `Pixhawk1-BL` | INCOMPLETE |
| **F** | 0 / 0 / −1 / empty | | | | INVALID |

Plus explicit cases for missing board ID, missing flash size, ID 255, out-of-range revision, oversized flash, empty USB string, and ID-9 insufficient evidence.

Every fixture's `note` begins with `TEST FIXTURE`, the transport is named `bootloader-transport:fixture`, its evidence states *"NOT read from the real Pixhawk"*, and `source` is `TEST_FIXTURE`. Three tests assert these markers so a fixture can never be presented as real.

---

## 5. Resolver integration — `backend/services/firmware_compat_service.py`

`IdentityEvidence` gained an optional `bootloader_identity` field. The `to_dict()` payload gained `bootloaderIdentity`, and `hasBootloaderIdentity` now reflects *validated* identity rather than mere presence of a string. The field is additive, so the API response is backward compatible.

`apply_bootloader_identity(identity, bootloader_result)` folds a result in:

- `INVALID` / `UNAVAILABLE` / `None` → recorded as evidence, **ignored**
- `VALID` but incomplete → recorded, **ignored**
- `VALID` and complete → `usb_product_string` becomes `bootloader_str`, and `board_id` becomes the interpreted manifest ID

Only then does the existing resolution path run, so **normal-mode behaviour is unchanged when no bootloader identity exists**.

### Large-flash exclusion

QGC excludes `fmuv2`-platform rows when a large-flash v2 board reports usable geometry. That exclusion is reproduced (`_is_fmuv2_platform`, a `platform.contains("fmuv2")` heuristic exactly as in `FirmwareUpgradeController.cc`) and applied to the no-match path, so a filtered row cannot masquerade as an unknown platform.

---

## 6. Board ID 9 handling

The forbidden pattern — `if board_id == 9: select Pixhawk firmware` — **does not exist**. Instead:

| Evidence | Outcome | Selected |
|---|---|---|
| Board ID 9 only, no bootloader | `AMBIGUOUS` | none |
| Valid identity but **no** USB product string (incomplete) | `AMBIGUOUS` | none |
| Board ID 9 + `Pixhawk1-BL` | `EXACT_MATCH` | `Pixhawk1` |
| Board ID 9 + `Pixhawk1-1M-BL` | `EXACT_MATCH` | `Pixhawk1-1M` |
| Board ID 9 + `PX4 BL FMU v2.x` (shared) | `AMBIGUOUS` | none, 4 platforms listed |
| Board ID 9 + conflicting string (`CubeBlack-BL`) | `EXACT_MATCH` | `CubeBlack` — never `Pixhawk1` |
| Board ID 9, insufficient evidence | `AMBIGUOUS` | none |

The shared generic string case is the important one: `PX4 BL FMU v2.x` appears on four platforms in the test fixture, and the resolver reports all four rather than picking the first.

### One deliberate divergence from QGC

QGC matches manifest `bootloader_str` with `contains(boardDescription)` and lets the **first** row become "best match". That is directional and order-dependent, so a board whose description matches many rows gets whichever happens to come first. This resolver requires an **exact** match and, when several platforms still survive, returns `AMBIGUOUS`. Being stricter than QGC is intentional; it fails safe rather than guessing.

---

## 7. Tests — `backend/tests/test_bootloader_identity.py`

72 tests covering all 13 required cases:

| # | Required case | Covered by |
|---|---|---|
| 1 | complete identity | `TestCompleteIdentity` (5) |
| 2 | missing board ID | `test_missing_board_id_is_incomplete_and_never_coerced` |
| 3 | missing flash size | `test_missing_flash_size_is_incomplete` |
| 4 | missing bootloader revision | `test_missing_bootloader_revision_is_incomplete` |
| 5 | missing USB product string | `test_missing_usb_product_string_is_incomplete` |
| 6 | malformed identity | `TestMalformedIdentity` (17 parametrized cases) |
| 7 | ID 9 + matching corroboration | `test_board_id_9_with_matching_corroboration_selects_unique_platform` |
| 8 | ID 9 + conflicting corroboration | `test_board_id_9_with_conflicting_corroboration_does_not_select_pixhawk` |
| 9 | ID 9 + insufficient evidence | `test_board_id_9_with_insufficient_evidence` |
| 10 | multiple candidates | `test_multiple_candidates_same_platform_picks_best_channel` |
| 11 | exact candidate | `test_exact_candidate_present` |
| 12 | unsupported candidate | `test_unsupported_candidate_reported` |
| 13 | ambiguous candidate | `test_ambiguous_candidate_reported_with_platform_list` |

Plus `TestBoardId9Handling` (9 tests, including *"resolver never selects on board ID 9 alone"*), `TestTransportAbstraction` (6), `TestResolverWithBootloaderIdentity` (14), and `TestNoHardwareAccess` (6).

All manifest documents in the test file are synthetic, built in-test. No real catalogue is vendored.

---

## 8. Test results

| Check | Result |
|---|---|
| `pytest tests/test_bootloader_identity.py` | **72 passed** |
| `pytest tests/test_firmware_catalog.py` | **86 passed** (no regressions) |
| Full backend suite | **844 passed**, 153 pre-existing warnings |
| `npm test` | **578 passed**, 38 files |
| `npx tsc -b` | **passed** (exit 0) |
| `npm run lint` | **passed** (exit 0); 10 pre-existing warnings, none in changed files |
| `npm run build` | **passed** (exit 0); pre-existing chunk-size notice |

Backend grew 772 → 844 (72 new). No existing test changed.

---

## 9. No UI changes

`frontend/src/components/setup/SetupFirmware.tsx` and `frontend/src/styles/setup.css` were **not modified**. Compatibility badge, current firmware card, detected Pixhawk card, warning, Re-query, Install Firmware button, layout and typography are all untouched. Frontend tests, TypeScript, lint and build confirm this.

---

## 10. Why the real hardware was not touched

Reaching a bootloader identity requires rebooting the board into bootloader mode. That is a state change with real consequences on a vehicle that is currently connected and configured, and it is explicitly out of scope for this phase. Therefore:

- No reboot to bootloader
- No bootloader commands (no `sync`, no `PROTO_GET_DEVICE`)
- No erase, program, write or flash
- No MAVLink `reboot-to-bootloader`
- No serial port opened; no USB re-enumeration induced

Every value exercised here is synthetic. The architecture is proven without ever putting the vehicle at risk, which is the entire point of doing this phase first.

---

## 11. Next step for real hardware validation

This phase deliberately stops at software. Physical validation requires **separate, explicit approval**, and should proceed in this order:

1. **Write a real serial bootloader transport** implementing `BootloaderTransport` — 115200 8N1, no flow control, `PROTO_GET_DEVICE` only. It must contain no erase/program/reboot methods.
2. **Prove identity-only behaviour first.** Connect to a board *already* in bootloader mode and read identity. Do not flash anything. Verify the four fields read cleanly and that validation accepts them.
3. **Verify reenumeration handling.** The device path and USB PID change on bootloader entry; QGC follows the board by USB serial number across this. Reproduce that before trusting any result.
4. **Check the handshake-only risk.** A `sync` sent to a port that is actually running MAVLink can be misread as MAVLink garbage. Refuse to proceed if sync fails and the port still looks like a normal link.
5. **Cross-check against the manifest** and confirm the current Pixhawk resolves to a unique platform *or* honestly reports `AMBIGUOUS`.
6. **Only then** consider a separate, gated write path. Identity reading and flashing stay in different modules.

Given the confirmed limitation that Pixhawk1 and Pixhawk1-1M share one bootloader binary and report the same 2 MiB flash size, the expected real-hardware result for this board may well be `AMBIGUOUS`. That is a truthful outcome, not a defect.
