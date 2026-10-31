"""Telemetry stream requests, ported from backend/src/mavlink/streamRequester.ts.

Sends MAV_CMD_SET_MESSAGE_INTERVAL (modern), REQUEST_DATA_STREAM (legacy) and
MAV_CMD_GET_HOME_POSITION once after the first heartbeat, so the vehicle starts
streaming the telemetry messages the GCS consumes.
"""

from typing import Any

_requested = False

# (msgid, interval_us) — ATTITUDE at 50 Hz (Mission-Planner-class HUD);
# everything else stays at mission/telemetry-appropriate rates.
DESIRED_MESSAGES = [
    (30, 20000),  # ATTITUDE          50 Hz — HUD roll/pitch/yaw
    (33, 100000),  # GLOBAL_POSITION_INT
    (24, 100000),  # GPS_RAW_INT
    (1, 100000),   # SYS_STATUS
    (147, 500000),  # BATTERY_STATUS
    (74, 100000),  # VFR_HUD          10 Hz — heading/alt/airspeed tape
    (32, 100000),  # LOCAL_POSITION_NED
    (42, 500000),  # MISSION_CURRENT
    (46, 500000),  # MISSION_ITEM_REACHED
    (253, 500000),  # STATUSTEXT
    (162, 500000),  # FENCE_STATUS
    (65, 50000),   # RC_CHANNELS     20 Hz — raw RC PWM for the Radio page
    (36, 200000),  # SERVO_OUTPUT_RAW 5 Hz — read-only output monitor
    (11030, 500000),  # ESC_TELEMETRY_1_TO_4 (ArduPilot dialect)
    (11031, 500000),  # ESC_TELEMETRY_5_TO_8
    (11032, 500000),  # ESC_TELEMETRY_9_TO_12
]

# (stream_id, rate_hz) — legacy REQUEST_DATA_STREAM: EXTRA1 (which carries
# ATTITUDE) raised to 50 Hz so a real Pixhawk streams attitude at HUD rate
# even if only the legacy SR mechanism is honoured.
DATA_STREAMS = [
    (2, 10),   # EXTENDED_STATUS
    (10, 50),  # EXTRA1  (ATTITUDE)
    (11, 10),  # EXTRA2  (VFR_HUD)
    (12, 4),   # EXTRA3
    (6, 10),   # POSITION
]

MAV_CMD_SET_MESSAGE_INTERVAL = 511
MAV_CMD_GET_HOME_POSITION = 410


def reset_requested() -> None:
    global _requested
    _requested = False


def request_telemetry_streams(conn: Any, target_system: int, target_component: int) -> None:
    """Send stream-rate requests (no-op if already requested once).

    NOTE: Called from the reader thread via _on_heartbeat, so conn.mav
    sends are safe here — all pymavlink ops happen on the same thread.
    """
    global _requested
    if _requested:
        return
    _requested = True

    sys_id = target_system or 1
    comp_id = target_component or 1

    print("📡 Requesting telemetry streams from vehicle...")

    # ---- MAV_CMD_SET_MESSAGE_INTERVAL (modern) ----
    for msgid, interval_us in DESIRED_MESSAGES:
        try:
            conn.mav.command_long_send(
                sys_id, comp_id, MAV_CMD_SET_MESSAGE_INTERVAL, 0,
                msgid, interval_us, 0, 0, 0, 0, 0,
            )
            print(f"  ✅ msgid={msgid} ({interval_us}µs)")
        except Exception as err:  # noqa: BLE001
            print(f"  ❌ msgid={msgid}: {err}")

    # ---- REQUEST_DATA_STREAM (legacy fallback) ----
    for stream_id, rate_hz in DATA_STREAMS:
        try:
            conn.mav.request_data_stream_send(
                sys_id, comp_id, stream_id, rate_hz, 1
            )
            print(f"  ✅ stream id={stream_id} ({rate_hz}Hz)")
        except Exception as err:  # noqa: BLE001
            print(f"  ❌ stream id={stream_id}: {err}")

    # ---- HOME_POSITION (msgid 242) ----
    try:
        conn.mav.command_long_send(
            sys_id, comp_id, MAV_CMD_GET_HOME_POSITION, 0,
            0, 0, 0, 0, 0, 0, 0,
        )
        print("  ✅ HOME_POSITION requested (MAV_CMD_GET_HOME_POSITION)")
    except Exception as err:  # noqa: BLE001
        print(f"  ❌ HOME_POSITION request: {err}")

    print("📡 Telemetry stream requests sent.")
