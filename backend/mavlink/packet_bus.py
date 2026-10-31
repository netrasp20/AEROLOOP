"""Packet-listener bus mirroring mavlink.service.ts onPacket/offPacket.

The MAVLink reader thread dispatches every parsed message here (by numeric
msgid) after the telemetry handlers run, so command/mission services can wait
for one-shot acknowledgements (COMMAND_ACK, MISSION_ACK, MISSION_COUNT, ...)
exactly like the Node `onPacket` API.
"""

import threading
from typing import Any, Callable, Dict, List

_lock = threading.Lock()
_listeners: Dict[int, List[Callable[[Any], None]]] = {}


def on_packet(msgid: int, callback: Callable[[Any], None]) -> Callable[[], None]:
    """Register a callback for a numeric msgid; returns an unsubscribe fn."""
    with _lock:
        _listeners.setdefault(msgid, []).append(callback)
    return lambda: off_packet(msgid, callback)


def off_packet(msgid: int, callback: Callable[[Any], None]) -> None:
    with _lock:
        lst = _listeners.get(msgid)
        if lst is None:
            return
        try:
            lst.remove(callback)
        except ValueError:
            pass


def dispatch(msg: Any) -> None:
    """Called from the reader thread for every parsed MAVLink message."""
    msgid = getattr(msg, "get_msgId", lambda: None)()
    if msgid is None:
        return
    with _lock:
        lst = list(_listeners.get(msgid, ()))
    for cb in lst:
        try:
            cb(msg)
        except Exception as err:  # noqa: BLE001
            print(f"[PACKET_BUS] listener error for msgid {msgid}: {err}")


def clear() -> None:
    with _lock:
        _listeners.clear()
