# Firmware Installation — Verified Architecture and Design

Status: **read-only catalog, compatibility, confirmation and download preparation
are implemented. Physical installation remains blocked.**

This document records source findings and constraints for any future physical
installer. Current implementation and validation are in
`docs/PHASE_FIRMWARE_INSTALLATION_REPORT.md`.

## 1. Verified: the official ArduPilot firmware source

| Fact | Value | How verified |
|---|---|---|
| Server | `https://firmware.ardupilot.org/` | live HTTP |
| Manifest URL | `https://firmware.ardupilot.org/manifest.json.gz` | `HTTP 200`, `Content-Length: 1877790`, `Content-Type: application/x-gzip` |
| Manifest shape | `{"format-version": "1.0.0", "firmware": [...]}` | decompressed and parsed locally |
| Manifest size | 97,377 entries / 78,454,340 bytes decompressed | parsed locally |
| Image URL pattern | `https://firmware.ardupilot.org/<vehicle>/<channel>/<platform>/<vehicle>.apj` | `.../Copter/stable/CubeBlack/arducopter.apj` → `HTTP 200` |
| Release channels | `stable`, `beta`, `latest`, plus pinned archives `stable-X.Y.Z` | manifest directory kinds |
| Version types | `OFFICIAL`, `BETA`, `DEV`, `STABLE-X.Y.Z` | manifest field `mav-firmware-version-type` |

Note: the manifest is served as a *gzip file*, not as `Content-Encoding: gzip`.
Clients must gunzip the body themselves; `Accept-Encoding: gzip` is not enough.

A verbatim `Copter`/`OFFICIAL`/`apj` entry:

```json
{
  "mav-autopilot": "ARDUPILOTMEGA",
  "vehicletype": "Copter",
  "platform": "BeastH7",
  "git-sha": "dbe792162d06cab66c3475fd5556bf7a120f119e",
  "url": "https://firmware.ardupilot.org/Copter/stable/BeastH7/arducopter.apj",
  "mav-type": "Copter",
  "mav-firmware-version-type": "OFFICIAL",
  "mav-firmware-version-str": "V4.7.1",
  "latest": 0,
  "format": "apj",
  "mav-firmware-version": "4.7.1",
  "mav-firmware-version-major": "4",
  "mav-firmware-version-minor": "7",
  "mav-firmware-version-patch": "1",
  "board_id": 1025,
  "bootloader_str": ["BeastH7-BL"],
  "USBID": ["0x1209/0x5741"],
  "brand_name": "Beast H7 55A AIO",
  "manufacturer": "iFlight",
  "image_size": 1214992
}
```

Catalog scale for the `Copter` vehicle alone, restricted to `.apj` and the three
active channels (`OFFICIAL`/`BETA`/`DEV`): **895 entries across 254 distinct
`board_id` values.**

## 2. Verified: there are two real install mechanisms

**A. MAVFTP remote install** — a possible ArduPilot path requiring further
verification before implementation:

1. Upload a board-verified artifact to the documented SD-card path; the exact
   format and path remain unverified.
2. Trigger a documented bootloader action only after verifying the exact
   MAVLink command and board identity. Neither action exists in this workflow.

An existing MAVFTP client could support an approved future design:
`backend/services/ftp_service.py` implements `LIST_DIR`, `OPEN_FILE_RO`,
`READ_FILE`, `CREATE_FILE`, `WRITE_FILE`, `REMOVE_FILE`, `CREATE_DIR`,
`REMOVE_DIR` and `RENAME` over the same `manager.connection` / `packet_bus`
used by every other subsystem (`ftp_service.py:75`, `CHUNK_SIZE = 200`,
ACK/NAK retry handling). It is exposed by `backend/api/ftp.py`.

**B. PX4-style bootloader serial flash** — what QGroundControl uses
(`FirmwareUpgradeController` / `PX4FirmwareUpgradeThread` / `Bootloader`):
a raw serial bootloader protocol (`PROTO_GET_DEVICE`, `PROTO_CHIP_ERASE`,
`PROTO_PROG`, `PROTO_VERIFY`, `PROTO_BOOT`) spoken while the board is in
bootloader mode, which requires the user to physically unplug and replug the
Pixhawk. **This does not exist in YantraYug in any form.**

## 3. The blocking constraint: board identity is not yet resolvable

`board_id` alone does **not** identify a board. Verified from the live
manifest, `Copter` + `board_id=9` ("PX4 BL FMU v2.x") covers **14 mutually
incompatible platforms**:

`CubePurple`, `Pixhawk1`, `Pixhawk1-1M`, `Pixhawk1-bdshot`,
`Pixhawk1-1M-bdshot`, `CubeBlack`, `CubeSolo`, `CubeGreen-solo`, `fmuv2`,
`fmuv3`, `skyviper-journey`, `skyviper-v2450`, `mRoX21`, `CUAV-Pixhack-v3`.

The disambiguating field is `bootloader_str` (e.g. `CubeBlack-BL` vs
`Pixhawk1-1M-BL`), which is the bootloader's USB product string, observable
**only in bootloader mode**. The authoritative board-id → name table is
`Tools/AP_Bootloader/board_types.txt` in ArduPilot, cited as authoritative in
the locally vendored pymavlink (`common.d.ts:173-174`).

Consequence: YantraYug today reads identity from `AUTOPILOT_VERSION` and
vehicle type. That data is **insufficient to select one safe firmware image**
for a Pixhawk. Presenting a "compatible firmware" list derived from `board_id`
alone would offer 14 mutually exclusive images, and picking the wrong one is
exactly the outcome this phase must not produce. The `.apk` descriptor and
ArduPilot bootloader do reject a mismatched image (reducing brick risk), but
that does not make an ambiguous 14-image picker a truthful UI.

This is why the implemented catalog reports `AMBIGUOUS` rather than choosing
an image on the connected Pixhawk. Work stops before physical installation.

## 4. Read-only pipeline and constraints for a future physical installer

**Catalog source.** `firmware.ardupilot.org/manifest.json.gz` is fetched,
gunzipped and parsed; the validated compressed copy is cached for 15 minutes
and revalidated with the server's `ETag`. Cache reads verify stored SHA-256;
network failures use only a validated copy marked stale. Unknown manifest
format-version majors are refused. Redirects and nonstandard origins are refused
for both catalog and artifact requests.
Filter to the active channels only (`OFFICIAL`, `BETA`, `DEV`); the 78,523
pinned `STABLE-X.Y.Z` archive entries are unreachable in QGC by the same
omission and are not needed here.

**Metadata.** Per candidate: `mav-firmware-version`, `-str`, `major/minor/patch`,
`mav-firmware-version-type`, `format`, `board_id`, `bootloader_str[]`,
`USBID[]`, `brand_name`, `manufacturer`, `image_size`, `git-sha`, `url`,
`vehicletype`.

**Compatibility.** Three-tier resolution, in strict order:
1. exact `bootloader_str` match against the bootloader USB product string;
2. if unavailable, the board is **ambiguous** — present no installable image
   and state that the board must enter bootloader mode to be identified;
3. only if the resolved `bootloader_str` is unique may `board_id` be used as a
   corroborating check. Never resolve by `board_id` alone.

**Download.** The implemented preparation downloads an `.apj` from its official
HTTPS URL to staging, checks HTTP status and `Content-Length` completeness when
available, and reports a computed SHA-256. The manifest has no artifact
checksum; the digest is not claimed to be verified. `image_size` is *not* the
`.apj` container length and must not be used as a transfer-size check. No
upload or install-on-download occurs.

**Installation.** No physical installer or install HTTP endpoint exists.
`firmware_install_service.install_firmware()` always raises. An in-process
`TEST / SIMULATION` adapter reports state transitions without touching a
vehicle. A future MAVFTP or serial installer requires separate verification.

**Progress.** The UI reports no physical-install progress. A future installer
must use real transfer and ACK evidence, never an invented percentage. The
in-process simulation adapter defines states including
`NO_DEVICE`, `DETECTING`, `IDENTIFYING`, `READY`, `FIRMWARE_AVAILABLE`,
`CONFIRMATION_REQUIRED`, `PREPARING`, `DOWNLOADING`, `INSTALLING`,
`VERIFYING`, `COMPLETED`, `ERROR`, `DISCONNECTED`, `UNAVAILABLE`.

**Confirmation.** The backend re-resolves the target on confirmation; an
ambiguous board cannot be confirmed. The UI shows the current version, target
version, release, and board/platform only for a unique resolution. Confirmation
never initiates a flash, and installation remains disabled.

**Errors.** Distinguish network/DNS failure, manifest schema drift, checksum
or size mismatch, MAVFTP `NAK` codes (already mapped in
`ftp_service.NAK_ERRORS`), bootloader rejection, and user abort.

**Verification.** Post-install verification is a *re-read of
`AUTOPILOT_VERSION`* after the board reconnects, compared to the intended
version. It must never be reported as success without an actual new message.
(For reference, the bootloader read-back of mechanism B is a different check
and is not used here.)

**Reconnect.** Use the existing `connection_manager` / `serial_autodetect`
watcher. `serial_autodetect` currently only considers `ttyACM*`/`ttyUSB*`/`cu.*`
via `serial_service._enumerate_ports()` and deliberately never steals a busy
port, so bootloader re-enumeration would need an explicit, separately gated
change — not a silent reuse.

**Safety gate.** Physical hardware stays read-only. No erase/program/boot
command may be sent to real hardware in this phase; the only executable path is
the test adapter, and any real-hardware install must require an explicit
opt-in plus a bootloader-mode-confirmed board identity.

**SITL / test adapter.** Positive SITL identification requires a non-serial
connection and live `SIM_*` parameters. Otherwise treat it conservatively as
hardware. The current in-process adapter simulates state transitions only; it
does not simulate MAVFTP NAKs or physical transfer failures.

## 5. Current implementation boundary

`firmware_catalog_service.py` retrieves and caches the official manifest;
`firmware_compat_service.py` resolves conservatively;
`firmware_download_service.py` stages and transfer-checks a uniquely resolved
artifact; `setup_service.py` and `api/setup.py` expose catalog, confirmation,
and download-preparation operations. The frontend displays the resulting
states while keeping Install Firmware hard-disabled. There is no install
endpoint, bootloader protocol, vehicle upload, erase or reboot-for-flashing.

## 6. Outstanding items blocking implementation

1. **Verified SD-card path and reboot-to-bootloader invocation** for the
   MAVFTP `.apk` install (the exact `/APM/...` filename the bootloader consumes
   and the precise MAVLink command/flag encoding).
2. **`.apk` descriptor parsing** to extract embedded board id for a
   pre-flight compatibility assertion before writing to the card.
3. **Bootloader-mode board identity** — the only trustworthy source of
   `bootloader_str`, and therefore the only way to resolve the 14-way
   `board_id=9` ambiguity.
4. A decision on whether to implement mechanism B at all, given mechanism A
   appears sufficient for ArduPilot.

Items 1–3 are the substance of the gap. Resolving them is required before any
install code is written; until then the correct state of this page is
"identification works, installation is unavailable", which is what ships.

## Sources

- `https://firmware.ardupilot.org/manifest.json.gz` (fetched and parsed)
- `https://firmware.ardupilot.org/Copter/stable/CubeBlack/arducopter.apj` (HTTP 200)
- ArduPilot `Tools/AP_Bootloader/board_types.txt` (board id table, cited by vendored pymavlink)
- QGroundControl `src/Vehicle/VehicleSetup/FirmwareUpgradeController`,
  `PX4FirmwareUpgradeThread`, `Bootloader` (mechanism B reference)
- Local: `backend/services/ftp_service.py`, `backend/api/ftp.py`,
  `backend/mavlink/serial_autodetect.py`, `backend/services/setup_service.py`
