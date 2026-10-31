"""Serial port enumeration with Mission Planner-style COM naming + resolution.

Mission Planner parity:
- The UI always shows Windows-style COM ports (COM3, COM4, ...) and the user
  never sees Linux device paths.
- The frontend sends the COM label (e.g. "COM3"); the backend translates it to
  the actual autopilot device (e.g. /dev/ttyACM0, /dev/ttyUSB0) on Linux/macOS
  and uses it verbatim on Windows.
- The mapping is deterministic: get_available_serial_ports() and
  resolve_serial_device() share the same enumeration ordering, so a COM label
  always resolves to exactly the device shown in the dropdown.
- Only autopilot-like devices (ttyACM*, ttyUSB*, cu.*) are enumerated, so a COM
  label never maps to an unrelated port (mouse/webcam/dock).
- The stable udev symlink (/dev/serial/by-id/...) is preferred for opening, so
  re-plugging the Pixhawk does not silently change which device is used.
- Native device paths are still accepted verbatim (advanced use / testing), so
  existing callers passing /dev/ttyACM0 or /tmp/ttyV0 keep working.
"""

import glob
import os
import re
import sys
from typing import Any, Dict, List, Optional, Tuple

try:
    import serial.tools.list_ports as list_ports
except Exception:  # pragma: no cover - only when pyserial is missing
    list_ports = None

_IS_WINDOWS = sys.platform.startswith("win")
_COM_RE = re.compile(r"^COM(\d+)$", re.IGNORECASE)
_COM_START = 3  # Mission Planner labels the first port COM3, then COM4, ...

_AUTOPILOT_DEVICE_RE = re.compile(r"(ttyACM|ttyUSB|cu\.)")
_DEV_NODE_RE = re.compile(r"^/dev/(ttyACM\d+|ttyUSB\d+|cu\.\S+)$")

_BY_ID_DIR = "/dev/serial/by-id"


def _com_number(device: str) -> Optional[int]:
    """Return the COM number if device is a Windows-style COMx name."""
    d = device
    if d.lower().startswith("\\\\.\\"):
        d = d[4:]
    m = _COM_RE.match(d)
    return int(m.group(1)) if m else None


def com_label(index: int) -> str:
    """Mission Planner-style label for an enumerated port: COM3, COM4, ..."""
    return f"COM{_COM_START + index}"


def _by_id_path(device: str) -> str:
    """Return the stable /dev/serial/by-id symlink for a device node, if any."""
    if not device or _IS_WINDOWS:
        return device
    try:
        names = os.listdir(_BY_ID_DIR)
    except OSError:
        return device
    basename = os.path.basename(device)
    for name in names:
        try:
            if os.readlink(os.path.join(_BY_ID_DIR, name)) == basename:
                return os.path.join(_BY_ID_DIR, name)
        except OSError:
            continue
    return device


def _enumerate_ports() -> List[Any]:
    """Deterministically ordered autopilot serial devices (ttyACM*/ttyUSB*/cu.*).

    Shared by both the /serial-ports listing and the COMx->device translation
    so a label resolves to exactly the device shown in the UI. Only autopilot-
    like devices are returned, and the stable udev /dev/serial/by-id path is
    used in place of the raw /dev/ttyACM node when the symlink exists.

    The full USB descriptor identity is carried alongside the label; see
    :func:`enumerate_usb_ports`.
    """
    return enumerate_usb_ports()


class _PortInfo:
    """Minimal port descriptor (pyserial's ListPortInfo is not always available)."""

    def __init__(
        self,
        device: str,
        manufacturer: str,
        vid: Optional[int] = None,
        pid: Optional[int] = None,
        serial_number: Optional[str] = None,
        product: Optional[str] = None,
        description: Optional[str] = None,
    ) -> None:
        self.device = device
        self.manufacturer = manufacturer
        self.vid = vid
        self.pid = pid
        self.serial_number = serial_number
        self.product = product
        self.description = description

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return (
            f"_PortInfo(device={self.device!r}, manufacturer={self.manufacturer!r}, "
            f"vid={self.vid!r}, pid={self.pid!r}, serial_number={self.serial_number!r}, "
            f"product={self.product!r})"
        )


def enumerate_usb_ports() -> List[Any]:
    """Every autopilot-like port with its full USB descriptor identity.

    Read-only: this only asks the OS what USB devices exist. It never opens a
    port, never writes to a device, and never changes a device's state.

    The descriptor fields matter for bootloader identity work because they are
    the only identity available while a board is *not* in bootloader mode:
    ``vendor_id``/``product_id`` identify the USB device, ``serial_number`` is
    per-board and therefore authoritative for *which physical unit* is attached,
    and ``product`` is the string the firmware is currently advertising.

    Critically, ``product`` in normal mode is the plain board name
    (e.g. ``Pixhawk1``), **not** the bootloader's ``<BOARD>-BL`` string. It is
    reported here as evidence only and must never be used to infer the platform.
    """
    enumerated: List[Tuple[str, str, Optional[int], Optional[int], Optional[str], Optional[str], Optional[str]]] = []

    if list_ports is not None:
        try:
            ports = list(list_ports.comports())
        except Exception:  # pragma: no cover - comports() must never crash the API
            ports = []
        for p in ports:
            if _AUTOPILOT_DEVICE_RE.search(p.device):
                enumerated.append(
                    (
                        p.device,
                        p.manufacturer or "",
                        p.vid,
                        p.pid,
                        p.serial_number,
                        p.product,
                        p.description,
                    )
                )

    # Fallback: scan /dev directly if pyserial enumeration came up empty
    # (e.g. udev list is not yet populated right after a hot-plug). Descriptor
    # fields are simply unknown in that case, never guessed.
    if not enumerated:
        for node in sorted(glob.glob("/dev/ttyACM*") + glob.glob("/dev/ttyUSB*")):
            if _DEV_NODE_RE.match(node):
                enumerated.append((node, "", None, None, None, None, None))

    seen: set = set()
    result: List[Any] = []
    for device, manufacturer, vid, pid, serial_number, product, description in enumerated:
        resolved = _by_id_path(device)
        if resolved in seen:
            continue
        seen.add(resolved)
        result.append(
            _PortInfo(
                resolved,
                manufacturer,
                vid=vid,
                pid=pid,
                serial_number=serial_number,
                product=product,
                description=description,
            )
        )
    return sorted(result, key=lambda p: p.device)


def get_available_serial_ports() -> List[Dict[str, str]]:
    """Mission Planner-style port list.

    Returns COM labels only — never Linux device paths, which are backend
    implementation details the frontend must not expose. `path` is included as
    a debugging aid (the resolved real Linux device the backend will open).
    """
    return [
        {"label": com_label(i), "manufacturer": p.manufacturer or "", "path": p.device}
        for i, p in enumerate(_enumerate_ports())
    ]


def _detected_labels() -> str:
    labels = [com_label(i) for i in range(len(_enumerate_ports()))]
    return ", ".join(labels) or "none"


def _port_not_found_message(port: str) -> str:
    labels = [com_label(i) for i in range(len(_enumerate_ports()))]
    if not labels:
        return (
            "Pixhawk not detected. Plug the Pixhawk into a USB port and click "
            "the refresh button next to the port dropdown."
        )
    return (
        f"Serial port {port} not detected. "
        f"Detected COM ports: {labels}. "
        f"Select a port from the dropdown."
    )


def normalize_serial_device(device: Optional[str]) -> str:
    """Normalize a user-supplied device name into a form pyserial can open.

    The device string is passed through untouched whenever it already looks
    like a native name/URL; only obvious shorthand is rewritten.
    """
    if not device:
        return ""
    device = device.strip().strip('"').strip("'")
    if not device:
        return ""

    # pymavlink URLs / native paths are used verbatim.
    if device.startswith(("serial://", "tcp:", "udp:", "udpin:", "tcpin:")):
        return device
    if device.startswith("/"):
        return device

    num = _com_number(device)
    if num is not None:
        if _IS_WINDOWS:
            # COM10+ requires the device-namespace prefix on Windows.
            if num >= 10 and not device.lower().startswith("\\\\.\\"):
                return rf"\\.\COM{num}"
            return f"COM{num}"
        # Windows-style name on a Linux/macOS host: keep it so resolution can
        # map COMx -> the enumerated autopilot device.
        return f"COM{num}"

    if not _IS_WINDOWS:
        if re.match(r"^tty", device):
            return f"/dev/{device}"
        if re.match(r"^cu\.", device):
            return f"/dev/{device}"

    return device


def resolve_serial_device(device: Optional[str]) -> str:
    """Resolve a user-supplied device into a native, openable serial path.

    Accepts:
    - Windows-style COMx labels ("COM3") — the Mission Planner workflow.
    - Native paths ("COM3" on Windows, "/dev/ttyACM0", "\\\\\\\\.\\\\COM10").
    - Bare shorthand ("ttyACM0", "cu.usbmodem01") -> "/dev/<name>".

    On Linux/macOS a COM label is translated to the enumerated autopilot device
    using the same ordering as get_available_serial_ports(); on Windows the COM
    label is used verbatim. Raises RuntimeError with a Mission Planner-style
    message (COM labels only — never Linux device names) when the port cannot
    be resolved.
    """
    normalized = normalize_serial_device(device)
    if not normalized:
        raise RuntimeError(
            "No serial port specified. Pick a COM port from the dropdown "
            "(e.g. COM3) or provide a device path."
        )

    num = _com_number(normalized)
    if num is not None:
        if _IS_WINDOWS:
            # os.path.exists("COM3") is unreliable on Windows — let pyserial
            # open and raise with the OS message if the port is really missing.
            return normalized
        ports = _enumerate_ports()
        index = num - _COM_START
        if 0 <= index < len(ports):
            return ports[index].device
        raise RuntimeError(_port_not_found_message(normalized))

    if _IS_WINDOWS:
        return normalized

    # OS-path sanity check (Linux/macOS).
    if os.path.exists(normalized):
        return _by_id_path(normalized)

    raise RuntimeError(
        f"Serial port '{normalized}' not found. {_port_not_found_message(normalized)}"
    )


def validate_serial_device(device: Optional[str]) -> str:
    """Backward-compatible alias for resolve_serial_device()."""
    return resolve_serial_device(device)
