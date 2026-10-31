"""Mission download + verification, ported from
backend/src/services/missionDownload.service.ts.

Downloads the mission back from ArduPilot (MISSION_REQUEST_LIST ->
MISSION_COUNT -> MISSION_ITEM_INT per seq), compares it to what was uploaded,
and exposes a fast mission-count query used by the start flows.
"""

import threading
import time
from typing import Any, Dict, List, Optional

from core.state import is_tcp_connected, vehicle_state
from mavlink import packet_bus
from mavlink.mission_command import (
    MSGID_MISSION_COUNT,
    MSGID_MISSION_ITEM,
    MSGID_MISSION_ITEM_INT,
    create_mission_request_int,
    create_mission_request_list,
    parse_mission_count,
    parse_mission_item,
)

REQUEST_TIMEOUT_MS = 10000
LAT_TOLERANCE = 0.000001
LON_TOLERANCE = 0.000001
ALT_TOLERANCE = 0.5


class DownloadResult:
    def __init__(
        self,
        success: bool,
        items: List[Dict[str, Any]],
        count: int,
        error: Optional[str] = None,
    ) -> None:
        self.success = success
        self.items = items
        self.count = count
        self.error = error


def wait_for_mission_count(timeout_ms: int) -> int:
    done = threading.Event()
    box: Dict[str, Any] = {}

    def on_count(msg: Any) -> None:
        if done.is_set():
            return
        parsed = parse_mission_count(msg)
        if parsed is None:
            return
        print(f"[DOWNLOAD] <<< MISSION_COUNT received: count={parsed['count']}")
        box["count"] = parsed["count"]
        done.set()

    unsub = packet_bus.on_packet(MSGID_MISSION_COUNT, on_count)
    try:
        got = done.wait(timeout_ms / 1000.0)
    finally:
        unsub()
    if not got:
        raise RuntimeError("Timeout waiting for MISSION_COUNT")
    return box["count"]


def wait_for_mission_item_int(seq: int, timeout_ms: int) -> Dict[str, Any]:
    done = threading.Event()
    box: Dict[str, Any] = {}

    def on_item(msg: Any) -> None:
        if done.is_set():
            return
        item = parse_mission_item(msg)
        if item is None or item["seq"] != seq:
            return
        print(
            f"[DOWNLOAD] <<< MISSION_ITEM_INT seq={seq} received: cmd={item['command']} "
            f"lat={item['x']} lon={item['y']} alt={item['z']}"
        )
        box["item"] = item
        done.set()

    unsub = packet_bus.on_packet(MSGID_MISSION_ITEM_INT, on_item)
    try:
        got = done.wait(timeout_ms / 1000.0)
    finally:
        unsub()
    if not got:
        raise RuntimeError(f"Timeout waiting for MISSION_ITEM_INT seq={seq}")
    return box["item"]


def download_mission_from_ardupilot() -> DownloadResult:
    if not (
        vehicle_state["serialPortOpen"]
        or vehicle_state["udpConnected"]
        or is_tcp_connected()
    ):
        return DownloadResult(False, [], 0, "No transport available")

    sys_id = vehicle_state["systemId"] or 1
    comp_id = vehicle_state["componentId"] or 1

    print("[DOWNLOAD] Requesting mission list from ArduPilot...")
    print(f"[DOWNLOAD] >>> Sending MISSION_REQUEST_LIST (sys={sys_id} comp={comp_id})")
    create_mission_request_list(sys_id, comp_id)

    try:
        count = wait_for_mission_count(REQUEST_TIMEOUT_MS)
        print(f"[DOWNLOAD] ArduPilot reports {count} mission items")
    except Exception as err:
        print(f"[DOWNLOAD] Failed to get MISSION_COUNT: {err}")
        return DownloadResult(False, [], 0, str(err))

    if count == 0:
        print("[DOWNLOAD] No mission stored on ArduPilot (count=0)")
        return DownloadResult(True, [], 0)

    items: List[Dict[str, Any]] = []
    for seq in range(count):
        print(f"[DOWNLOAD] >>> Requesting MISSION_ITEM_INT seq={seq}...")
        create_mission_request_int(sys_id, comp_id, seq)
        try:
            item = wait_for_mission_item_int(seq, REQUEST_TIMEOUT_MS)
            items.append(item)
            print(
                f"[DOWNLOAD]   Item {seq}/{count - 1}: cmd={item['command']} "
                f"lat={item['x']:.6f} lon={item['y']:.6f} alt={item['z']}"
            )
        except Exception as err:
            msg = f"Failed to download mission item seq={seq}: {err}"
            print(f"[DOWNLOAD] {msg}")
            return DownloadResult(False, items, count, msg)

    print(f"[DOWNLOAD] Downloaded {len(items)}/{count} items from ArduPilot")
    return DownloadResult(True, items, count)


def verify_mission(
    uploaded_items: List[Dict[str, Any]],
    downloaded_items: List[Dict[str, Any]],
) -> Dict[str, Any]:
    differences: List[str] = []

    print("========== MISSION VERIFICATION ==========")
    print(f"[VERIFY] Uploaded count:   {len(uploaded_items)}")
    print(f"[VERIFY] Downloaded count: {len(downloaded_items)}")

    for i, item in enumerate(uploaded_items):
        print(
            f"[VERIFY] Uploaded [{i}]: cmd={item['command']} frame={item['frame']} "
            f"lat={item['x']} lon={item['y']} alt={item['z']} seq={item['seq']} "
            f"current={item['current']} autocon={item['autocontinue']} p1={item['param1']}"
        )
    for i, item in enumerate(downloaded_items):
        print(
            f"[VERIFY] Downloaded [{i}]: cmd={item['command']} frame={item['frame']} "
            f"lat={item['x']} lon={item['y']} alt={item['z']} seq={item['seq']} "
            f"current={item['current']} autocon={item['autocontinue']} p1={item['param1']}"
        )

    dl_offset = 0
    skip_first_uploaded = False

    if len(downloaded_items) == len(uploaded_items) + 1:
        print("[VERIFY] Downloaded has 1 extra item — item 0 is the ArduPilot HOME position, skipping it")
        print(
            f"[VERIFY] HOME item: cmd={downloaded_items[0]['command']} "
            f"frame={downloaded_items[0]['frame']} lat={downloaded_items[0]['x']} "
            f"lon={downloaded_items[0]['y']} alt={downloaded_items[0]['z']}"
        )
        dl_offset = 1
    elif len(downloaded_items) == len(uploaded_items) - 1:
        print("[VERIFY] Downloaded has 1 fewer item — ArduPilot did not store our HOME placeholder, skipping first uploaded item")
        skip_first_uploaded = True
    elif len(downloaded_items) != len(uploaded_items):
        msg = (
            f"Item count mismatch: uploaded={len(uploaded_items)} "
            f"downloaded={len(downloaded_items)}"
        )
        differences.append(msg)
        print(f"[VERIFY] FAILED — {differences[0]}")
        print("==========================================")
        return {
            "match": False,
            "uploadedCount": len(uploaded_items),
            "downloadedCount": len(downloaded_items),
            "differences": differences,
            "uploadedItems": uploaded_items,
            "downloadedItems": downloaded_items,
        }

    start_idx = 1 if skip_first_uploaded else 0
    for i in range(start_idx, len(uploaded_items)):
        u = uploaded_items[i]
        d = downloaded_items[i - (1 if skip_first_uploaded else 0) + dl_offset]
        is_home = i == 0

        ulabel = (
            f"(skipped uploaded[0]=HOME) uploaded[{i}]"
            if skip_first_uploaded
            else f"uploaded[{i}]"
        )
        print(
            f"[VERIFY] Comparing item {i} ({ulabel} ↔ "
            f"downloaded[{i - (1 if skip_first_uploaded else 0) + dl_offset}])"
            f"{' — HOME item' if is_home else ''}:"
        )
        print(
            f"[VERIFY]   Uploaded   seq={u['seq']} cmd={u['command']} frame={u['frame']} "
            f"lat={u['x']} lon={u['y']} alt={u['z']} cur={u['current']} p1={u['param1']} "
            f"autocon={u['autocontinue']}"
        )
        print(
            f"[VERIFY]   Downloaded seq={d['seq']} cmd={d['command']} frame={d['frame']} "
            f"lat={d['x']} lon={d['y']} alt={d['z']} cur={d['current']} p1={d['param1']} "
            f"autocon={d['autocontinue']}"
        )

        if is_home:
            if abs(u["x"] - d["x"]) > 0.001:
                differences.append(f"Item {i} (HOME) lat mismatch: uploaded={u['x']} downloaded={d['x']}")
            if abs(u["y"] - d["y"]) > 0.001:
                differences.append(f"Item {i} (HOME) lon mismatch: uploaded={u['y']} downloaded={d['y']}")
        else:
            if abs(u["x"] - d["x"]) > LAT_TOLERANCE:
                differences.append(f"Item {i} lat mismatch: uploaded={u['x']} downloaded={d['x']}")
            if abs(u["y"] - d["y"]) > LON_TOLERANCE:
                differences.append(f"Item {i} lon mismatch: uploaded={u['y']} downloaded={d['y']}")
            if abs(u["z"] - d["z"]) > ALT_TOLERANCE:
                differences.append(f"Item {i} alt mismatch: uploaded={u['z']} downloaded={d['z']}")
            if abs(u["param1"] - d["param1"]) > 0.01:
                differences.append(f"Item {i} param1 (hover time) mismatch: uploaded={u['param1']} downloaded={d['param1']}")
        if u["command"] != d["command"]:
            differences.append(f"Item {i} command mismatch: uploaded={u['command']} downloaded={d['command']}")
        if u["frame"] != d["frame"]:
            print(
                f"[VERIFY] WARNING — Item {i} frame mismatch "
                f"(uploaded={u['frame']} downloaded={d['frame']}) — continuing"
            )

    print(
        f"[VERIFY] {'PASSED — Mission matches ArduPilot' if len(differences) == 0 else f'FAILED — {len(differences)} difference(s)'}"
    )
    if differences:
        for d in differences:
            print(f"[VERIFY]   {d}")
    else:
        print(f"[VERIFY] All {len(uploaded_items)} items match perfectly")
    print("==========================================")

    return {
        "match": len(differences) == 0,
        "uploadedCount": len(uploaded_items),
        "downloadedCount": len(downloaded_items),
        "differences": differences,
        "uploadedItems": uploaded_items,
        "downloadedItems": downloaded_items,
    }


def get_mission_count_from_ardupilot() -> int:
    if not (
        vehicle_state["serialPortOpen"]
        or vehicle_state["udpConnected"]
        or is_tcp_connected()
    ):
        return -1

    sys_id = vehicle_state["systemId"] or 1
    comp_id = vehicle_state["componentId"] or 1

    create_mission_request_list(sys_id, comp_id)

    try:
        count = wait_for_mission_count(5000)
        print(f"[MISSION COUNT] ArduPilot reports {count} mission items")
        return count
    except Exception:
        print("[MISSION COUNT] Failed to get mission count from ArduPilot")
        return -1
