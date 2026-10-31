"""Test-only bootloader transport and fixture data.

This module exists solely to exercise the bootloader identity architecture
without ever touching real hardware. Nothing in here opens ``/dev/ttyACM0`` and
no fixture claims to come from the actual Pixhawk that is currently connected.

The fixtures
------------
Fixtures are named A–F to match the design document's required cases. Each one
returns raw, unvalidated values; :mod:`services.bootloader_identity` performs
strict validation and must reject missing/malformed values, never coerce them.

All fixtures are explicitly marked ``SOURCE_FIXTURE`` and carry
``evidence`` explaining they are synthetic. The transport name is
``"bootloader-transport:fixture"``, so a result produced from fixtures can be
distinguished from a real hardware result in logs and tests.

Safety
------
No default port or device is present. The transport does not attempt to access
serial ports. No reboot, erase, program or write operation exists.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from services.bootloader_identity import SOURCE_FIXTURE
from services.bootloader_transport import (
    BootloaderTransport,
    BootloaderTransportError,
    RawBootloaderInfo,
)


@dataclass(frozen=True)
class BootloaderFixture:
    """Synthetic bootloader identity data used for validation only."""

    name: str
    description: str
    bootloader_revision: Any = None
    board_id: Any = None
    flash_size: Any = None
    usb_product_string: Any = None
    should_be_valid: bool = False
    note: str = ""

    def raw(self) -> RawBootloaderInfo:
        return RawBootloaderInfo(
            bootloader_revision=self.bootloader_revision,
            board_id=self.board_id,
            flash_size=self.flash_size,
            usb_product_string=self.usb_product_string,
        )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "bootloaderRevision": self.bootloader_revision,
            "boardId": self.board_id,
            "flashSize": self.flash_size,
            "usbProductString": self.usb_product_string,
            "shouldBeValid": self.should_be_valid,
            "note": self.note,
        }


# ---------------------------------------------------------------------------
# Fixtures A–F (as specified)
# ---------------------------------------------------------------------------

# Fixture A: complete identity
FIXTURE_A = BootloaderFixture(
    name="A",
    description="Complete identity",
    bootloader_revision=4,
    board_id=9,
    flash_size=2 * 1024 * 1024,
    usb_product_string="Pixhawk1-BL",
    should_be_valid=True,
    note="TEST FIXTURE A — complete, not from real Pixhawk",
)

# Fixture B: same boardId, different USB product string
FIXTURE_B = BootloaderFixture(
    name="B",
    description="Same boardId, different USB product string",
    bootloader_revision=4,
    board_id=9,
    flash_size=2 * 1024 * 1024,
    usb_product_string="Pixhawk1-1M-BL",
    should_be_valid=True,
    note="TEST FIXTURE B — different USB product string",
)

# Fixture C: same boardId, different flash size
FIXTURE_C = BootloaderFixture(
    name="C",
    description="Same boardId, different flash size",
    bootloader_revision=5,
    board_id=9,
    flash_size=1_032_192,
    usb_product_string="Pixhawk1-BL",
    should_be_valid=True,
    note="TEST FIXTURE C — different flash size",
)

# Fixture D: missing USB product string
FIXTURE_D = BootloaderFixture(
    name="D",
    description="Missing USB product string",
    bootloader_revision=4,
    board_id=9,
    flash_size=2 * 1024 * 1024,
    usb_product_string=None,
    should_be_valid=False,
    note="TEST FIXTURE D — INCOMPLETE",
)

# Fixture E: missing bootloader revision
FIXTURE_E = BootloaderFixture(
    name="E",
    description="Missing bootloader revision",
    bootloader_revision=None,
    board_id=9,
    flash_size=2 * 1024 * 1024,
    usb_product_string="Pixhawk1-BL",
    should_be_valid=False,
    note="TEST FIXTURE E — INCOMPLETE",
)

# Fixture F: invalid data
FIXTURE_F = BootloaderFixture(
    name="F",
    description="Invalid data",
    bootloader_revision=-1,
    board_id=0,
    flash_size=0,
    usb_product_string="",
    should_be_valid=False,
    note="TEST FIXTURE F — INVALID",
)

# Additional explicit cases for the requested tests
FIXTURE_MISSING_BOARD_ID = BootloaderFixture(
    name="MISSING_BOARD_ID",
    description="Missing board ID",
    bootloader_revision=4,
    board_id=None,
    flash_size=2 * 1024 * 1024,
    usb_product_string="Pixhawk1-BL",
    should_be_valid=False,
    note="TEST FIXTURE — INCOMPLETE (missing board_id)",
)

FIXTURE_MISSING_FLASH_SIZE = BootloaderFixture(
    name="MISSING_FLASH_SIZE",
    description="Missing flash size",
    bootloader_revision=4,
    board_id=9,
    flash_size=None,
    usb_product_string="Pixhawk1-BL",
    should_be_valid=False,
    note="TEST FIXTURE — INCOMPLETE (missing flash_size)",
)

FIXTURE_MISSING_USB_PRODUCT = BootloaderFixture(
    name="MISSING_USB_PRODUCT",
    description="Missing USB product string (alias)",
    bootloader_revision=4,
    board_id=9,
    flash_size=2 * 1024 * 1024,
    usb_product_string=None,
    should_be_valid=False,
    note="TEST FIXTURE — INCOMPLETE",
)

FIXTURE_BOARD_ID_9_MATCH = BootloaderFixture(
    name="BOARD_ID_9_MATCH",
    description="Board ID 9 with corroborating match",
    bootloader_revision=4,
    board_id=9,
    flash_size=2 * 1024 * 1024,
    usb_product_string="Pixhawk1-BL",
    should_be_valid=True,
    note="TEST FIXTURE — ID 9 + corroboration",
)

FIXTURE_BOARD_ID_9_CONFLICT = BootloaderFixture(
    name="BOARD_ID_9_CONFLICT",
    description="Board ID 9 with conflicting corroboration",
    bootloader_revision=4,
    board_id=9,
    flash_size=2 * 1024 * 1024,
    usb_product_string="CubeBlack-BL",
    should_be_valid=True,
    note="TEST FIXTURE — ID 9 + conflicting USB string (for resolver tests)",
)

FIXTURE_BOARD_ID_9_INSUFFICIENT = BootloaderFixture(
    name="BOARD_ID_9_INSUFFICIENT",
    description="Board ID 9 with insufficient evidence",
    bootloader_revision=None,
    board_id=9,
    flash_size=None,
    usb_product_string=None,
    should_be_valid=False,
    note="TEST FIXTURE — ID 9 but INCOMPLETE",
)

FIXTURE_BOARD_ID_255_INVALID = BootloaderFixture(
    name="BOARD_ID_255_INVALID",
    description="Board ID 255 is QGC synthetic marker (invalid)",
    bootloader_revision=4,
    board_id=255,
    flash_size=2 * 1024 * 1024,
    usb_product_string="Pixhawk1-BL",
    should_be_valid=False,
    note="TEST FIXTURE — INVALID (board_id 255)",
)

FIXTURE_INVALID_REV_OUT_OF_RANGE = BootloaderFixture(
    name="REV_OUT_OF_RANGE",
    description="Bootloader revision outside supported range",
    bootloader_revision=6,
    board_id=9,
    flash_size=2 * 1024 * 1024,
    usb_product_string="Pixhawk1-BL",
    should_be_valid=False,
    note="TEST FIXTURE — INVALID (rev out of range)",
)

FIXTURE_INVALID_FLASH_TOO_LARGE = BootloaderFixture(
    name="FLASH_TOO_LARGE",
    description="Flash size exceeds sanity limit",
    bootloader_revision=4,
    board_id=9,
    flash_size=32 * 1024 * 1024,
    usb_product_string="Pixhawk1-BL",
    should_be_valid=False,
    note="TEST FIXTURE — INVALID",
)

FIXTURE_INVALID_USB_EMPTY = BootloaderFixture(
    name="USB_EMPTY",
    description="USB product string empty",
    bootloader_revision=4,
    board_id=9,
    flash_size=2 * 1024 * 1024,
    usb_product_string="",
    should_be_valid=False,
    note="TEST FIXTURE — INVALID",
)

FIXTURE_VALID_SMALL_FLASH = BootloaderFixture(
    name="SMALL_FLASH",
    description="Board ID 9 with small flash (1,032,192 bytes)",
    bootloader_revision=4,
    board_id=9,
    flash_size=1_032_192,
    usb_product_string="Pixhawk1-BL",
    should_be_valid=True,
    note="TEST FIXTURE — ID 9 small flash",
)

ALL_FIXTURES = [
    FIXTURE_A,
    FIXTURE_B,
    FIXTURE_C,
    FIXTURE_D,
    FIXTURE_E,
    FIXTURE_F,
    FIXTURE_MISSING_BOARD_ID,
    FIXTURE_MISSING_FLASH_SIZE,
    FIXTURE_MISSING_USB_PRODUCT,
    FIXTURE_BOARD_ID_9_MATCH,
    FIXTURE_BOARD_ID_9_CONFLICT,
    FIXTURE_BOARD_ID_9_INSUFFICIENT,
    FIXTURE_BOARD_ID_255_INVALID,
    FIXTURE_INVALID_REV_OUT_OF_RANGE,
    FIXTURE_INVALID_FLASH_TOO_LARGE,
    FIXTURE_INVALID_USB_EMPTY,
    FIXTURE_VALID_SMALL_FLASH,
]


class FixtureBootloaderTransport(BootloaderTransport):
    """Read-only transport that returns a fixed :class:`BootloaderFixture`.

    No real serial access. Every call is purely in-memory. The transport is
    explicitly marked as fixture-sourced.
    """

    name = "bootloader-transport:fixture"

    def __init__(self, fixture: BootloaderFixture, connect_should_fail: bool = False) -> None:
        if fixture is None:
            raise ValueError("fixture is required")
        self._fixture = fixture
        self._connect_should_fail = connect_should_fail
        self._connected = False
        self._evidence: List[str] = [
            "TEST FIXTURE: This identity was read from a synthetic fixture only.",
            "TEST FIXTURE: It was NOT read from the real Pixhawk.",
            f"TEST FIXTURE: fixture={fixture.name} ({fixture.description})",
        ]
        if fixture.note:
            self._evidence.append(f"TEST FIXTURE: {fixture.note}")

    @property
    def fixture(self) -> BootloaderFixture:
        return self._fixture

    @property
    def evidence(self) -> List[str]:
        return list(self._evidence)

    def connect(self) -> None:
        if self._connect_should_fail:
            raise BootloaderTransportError("Fixture transport connect failure (synthetic).")
        self._connected = True

    def read_info(self) -> RawBootloaderInfo:
        if not self._connected:
            raise BootloaderTransportError("Transport is not connected.")
        return self._fixture.raw()

    def disconnect(self) -> None:
        self._connected = False

    def read_identity(self):  # type: ignore[override]
        from services.bootloader_identity import SOURCE_FIXTURE, build_identity

        try:
            self.connect()
        except Exception as exc:
            from services.bootloader_identity import unavailable_identity

            return unavailable_identity(
                f"Could not attach to the bootloader transport: {exc}", SOURCE_FIXTURE
            )

        try:
            raw = self.read_info()
        except Exception as exc:
            from services.bootloader_identity import unavailable_identity

            return unavailable_identity(
                f"Could not read the bootloader identity: {exc}", SOURCE_FIXTURE
            )
        finally:
            self.disconnect()

        res = build_identity(
            bootloader_revision=raw.bootloader_revision,
            board_id=raw.board_id,
            flash_size=raw.flash_size,
            usb_product_string=raw.usb_product_string,
            source=SOURCE_FIXTURE,
        )
        return type(res)(identity=res.identity, evidence=list(self._evidence) + list(res.evidence))


def get_fixture(name: str) -> Optional[BootloaderFixture]:
    name_upper = name.upper()
    for f in ALL_FIXTURES:
        if f.name.upper() == name_upper:
            return f
    return None
