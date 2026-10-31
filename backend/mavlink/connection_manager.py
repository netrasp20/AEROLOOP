"""MAVLink transport manager, ported from backend/src/mavlink/mavlink.service.ts
(+ serial.service.ts) using pymavlink.

Owns a single active link (UDP receiver, TCP client, or serial device), runs a
reader thread, performs heartbeat detection with a connect timeout, and dispatches
parsed messages to telemetry_manager handlers.
"""

import queue
import threading
import time
from typing import Any, Callable, Optional

from core import config
from core.state import (
    reset_telemetry,
    set_tcp_connected,
    telemetry,
    vehicle_state,
)
from mavlink import packet_bus
from mavlink import telemetry_manager as tm
from mavlink.parameter_manager import (
    STATE_COMPLETE,
    STATE_RECEIVING,
    STATE_REQUESTING,
    parameter_manager,
)
from mavlink.stream_requester import request_telemetry_streams
from services.serial_service import resolve_serial_device
from sio import server as sio_server

# Message name -> handler dispatch table (parity with mavlink.service.ts initReader)
HANDLERS = {
    "HEARTBEAT": tm.handle_heartbeat,
    "SYS_STATUS": tm.handle_sys_status,
    "GLOBAL_POSITION_INT": tm.handle_global_position_int,
    "HOME_POSITION": tm.handle_home_position,
    "GPS_RAW_INT": tm.handle_gps_raw_int,
    "ATTITUDE": tm.handle_attitude,
    "VFR_HUD": tm.handle_vfr_hud,
    "BATTERY_STATUS": tm.handle_battery_status,
    "MISSION_CURRENT": tm.handle_mission_current,
    "MISSION_ITEM_REACHED": tm.handle_mission_item_reached,
    "STATUSTEXT": tm.handle_status_text,
    "LOCAL_POSITION_NED": tm.handle_local_position_ned,
    "RC_CHANNELS": tm.handle_rc_channels,
    "RAW_IMU": tm.handle_raw_imu,
    "PARAM_VALUE": parameter_manager.handle_param_value,
    "FENCE_STATUS": tm.handle_fence_status,
    "SERVO_OUTPUT_RAW": tm.handle_servo_output_raw,
    "ESC_TELEMETRY_1_TO_4": tm.handle_esc_telemetry_1_to_4,
    "ESC_TELEMETRY_5_TO_8": tm.handle_esc_telemetry_5_to_8,
    "ESC_TELEMETRY_9_TO_12": tm.handle_esc_telemetry_9_to_12,
    "GIMBAL_DEVICE_INFORMATION": tm.handle_gimbal_device_information,
    "GIMBAL_DEVICE_ATTITUDE_STATUS": tm.handle_gimbal_device_attitude_status,
    "LOG_ENTRY": tm.handle_log_entry,
}

LOG_FIRST_ONCE = set()


class ConnectionManager:
    def __init__(self) -> None:
        self._conn: Any = None
        self._thread: Optional[threading.Thread] = None
        self._running = False
        self._lock = threading.Lock()
        self._start_lock = threading.Lock()
        self._heartbeat_event = threading.Event()
        self._first_heartbeat = False
        self._last_tick = 0.0
        self.connection_type: Optional[str] = None
        self._send_queue: queue.Queue[Callable[[], None]] = queue.Queue()
        self._watchdog_stop = threading.Event()
        self._watchdog: Optional[threading.Thread] = None
        # Set when the heartbeat watchdog declares the link lost without
        # closing the transport; a resumed HEARTBEAT consumes it to re-sync the
        # parameter session and emit the authoritative CONNECTED event.
        self._was_lost = False
        self._manual_disconnect_requested = False

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    def start(
        self,
        connection_type: str,
        host: str = "127.0.0.1",
        port: int = 0,
        device: str = "",
        baud: int = 57600,
        clear_manual_disconnect: bool = True,
    ) -> tuple[bool, str]:
        """Start a transport and wait for a genuine vehicle HEARTBEAT.

        Serialized with a lock so two concurrent /connect requests can never
        race to open the same device or spawn a second reader thread.
        """
        with self._start_lock:
            if clear_manual_disconnect:
                self._manual_disconnect_requested = False
            return self._start(
                connection_type, host=host, port=port, device=device, baud=baud
            )

    def _start(
        self,
        connection_type: str,
        host: str = "127.0.0.1",
        port: int = 0,
        device: str = "",
        baud: int = 57600,
    ) -> tuple[bool, str]:
        if self._running:
            print("[MAVLINK] Service already running — awaiting HEARTBEAT for reconnect")
            self._first_heartbeat = False
            self._heartbeat_event.clear()
            vehicle_state["connectionState"] = "connecting"
            sio_server.broadcast_connection_state("CONNECTING")
            sio_server.broadcast_vehicle_status()
            tm.reset_stream_requested()
            got = self._heartbeat_event.wait(timeout=10)
            if got:
                # The transport was rebuilt while running — re-pull the
                # parameter set so the live cache matches the reconnected
                # vehicle (safe no-op when the session is already synced).
                self._start_auto_param_download()
                return True, "Reconnected. HEARTBEAT received."
            return False, "Reconnect timeout — no HEARTBEAT received."

        from pymavlink import mavutil  # pymavlink

        try:
            if connection_type == "udp":
                h = host or config.DEFAULT_UDP_HOST
                p = port or config.DEFAULT_UDP_PORT
                conn = mavutil.mavlink_connection(f"udpin:{h}:{p}")
                timeout_s = 5
                print(f"========================= UDP CONNECT =========================\n"
                      f"Listening on UDP : {h}:{p}\n"
                      f"====================================================================")
                vehicle_state["udpConnected"] = True
            elif connection_type == "tcp":
                h = host or config.DEFAULT_TCP_HOST
                p = port or config.DEFAULT_TCP_PORT
                conn = mavutil.mavlink_connection(f"tcp:{h}:{p}", input=True)
                timeout_s = 10
                print(f"[MAVLINK] Connecting TCP to {h}:{p}...")
                set_tcp_connected(True)
            elif connection_type == "serial":
                device = resolve_serial_device(device)
                try:
                    baud = int(baud)
                except (TypeError, ValueError):
                    return False, f"Invalid baud rate: {baud!r}"
                conn = mavutil.mavlink_connection(device, baud=baud, autoreconnect=False)
                timeout_s = 10
                print(f"[MAVLINK] Starting serial connection on {device} @ {baud} baud")
                vehicle_state["serialPortOpen"] = True
            else:
                return False, f"Unknown connection type: {connection_type}"
        except Exception as err:  # noqa: BLE001
            print(f"[MAVLINK] Transport init error: {err}")
            return False, self._transport_error_message(connection_type, device, baud, err)

        self._conn = conn
        self.connection_type = connection_type
        self._running = True
        self._first_heartbeat = False
        self._was_lost = False
        self._heartbeat_event.clear()
        LOG_FIRST_ONCE.clear()
        tm.reset_home_position()

        self._thread = threading.Thread(target=self._reader_loop, daemon=True, name="mavlink-reader")
        self._thread.start()

        self._watchdog_stop.clear()
        self._watchdog = threading.Thread(target=self._watchdog_loop, daemon=True, name="mavlink-watchdog")
        self._watchdog.start()

        vehicle_state["connectionState"] = "connecting"
        sio_server.broadcast_connection_state("CONNECTING")
        sio_server.broadcast_vehicle_status()

        got_heartbeat = self._heartbeat_event.wait(timeout=timeout_s)

        if got_heartbeat:
            # Bind the parameter manager to this fresh transport session so a
            # different vehicle can never leak into the previous session's cache.
            parameter_manager.start_session()
            # Populate the live parameter set automatically (QGC behaviour): the
            # Setup Summary and the Parameters store drive every capability
            # decision off the downloaded PARAM_VALUE cache, so it must exist
            # without an explicit user refresh. Runs in a daemon thread because
            # the download loop blocks until the vehicle finishes streaming.
            self._start_auto_param_download()
            via = {"udp": "via UDP", "tcp": "via TCP"}.get(connection_type, "")
            if via:
                return True, f"Connected {via}. HEARTBEAT received."
            return True, "Connected. HEARTBEAT received."
        self.stop()
        vehicle_state["disconnectReason"] = "connection timeout — no HEARTBEAT received"
        if connection_type == "serial":
            return False, (
                f"Connection timeout — no HEARTBEAT received on {device} @ {baud} baud. "
                "Check the USB cable and make sure no other GCS (MAVProxy / Mission "
                "Planner) has the serial port open."
            )
        prefix = {"udp": "UDP ", "tcp": "TCP "}.get(connection_type, "")
        return False, f"{prefix}connection timeout — no HEARTBEAT received."

    @staticmethod
    def _transport_error_message(connection_type: str, device: str, baud: int, err: Exception) -> str:
        """Turn low-level transport errors into actionable Mission Planner-style messages."""
        if isinstance(err, RuntimeError):
            # Already a friendly message (e.g. resolve_serial_device's
            # "Pixhawk not detected" / "Serial port COM3 not detected").
            return str(err)

        text = str(err)
        low = text.lower()
        if connection_type == "serial":
            if "permission" in low or "access denied" in low:
                return (
                    f"Cannot open serial port — permission denied. Add your user to the "
                    "dialout group: sudo usermod -aG dialout $USER (then log out and back in)."
                )
            if "busy" in low or "errno 16" in low or "address already in use" in low:
                return (
                    f"Serial port is busy — another program (MAVProxy, Mission Planner, "
                    "or a previous connection) already has it open. Close the other GCS "
                    "and try again."
                )
            if "could not open port" in low and ("errno 2" in low or "no such file" in low):
                return (
                    f"Serial device not found — Pixhawk not detected. Check the USB cable "
                    "and re-plug the Pixhawk."
                )
            return f"Failed to open serial port {device} @ {baud} baud: {text}"
        return text

    def stop(self, manual: bool = False) -> None:
        if manual:
            self._manual_disconnect_requested = True
        with self._lock:
            if not self._running:
                return
            self._running = False
        self._teardown("Connection closed")

    @property
    def manual_disconnect_requested(self) -> bool:
        return self._manual_disconnect_requested

    def _teardown(self, reason: str) -> None:
        conn = self._conn
        self._conn = None
        # Detach the parameter session: cancel pending ops and drop the cache.
        # Tied to the transport lifecycle (not the heartbeat watchdog) so a
        # momentary heartbeat blip can never wipe the live parameter set.
        parameter_manager.stop_session(reason)
        try:
            if conn is not None:
                conn.close()
        except Exception:  # noqa: BLE001
            pass
        self._thread = None
        packet_bus.clear()
        from services.calibration_service import reset_session

        reset_session()
        from services.motor_test_service import notify_connection_lost

        notify_connection_lost("Connection closed")

        self._watchdog_stop.set()
        if self._watchdog is not None:
            self._watchdog.join(timeout=2.0)
            self._watchdog = None

        vehicle_state["udpConnected"] = False
        vehicle_state["serialPortOpen"] = False
        set_tcp_connected(False)
        vehicle_state["connected"] = False
        vehicle_state["connectionState"] = "disconnected"
        vehicle_state["disconnectReason"] = reason
        vehicle_state["mode"] = "DISCONNECTED"
        vehicle_state["armed"] = False
        vehicle_state["gpsFix"] = 0
        vehicle_state["satellites"] = 0
        vehicle_state["lastHeartbeat"] = 0
        self._was_lost = False
        # Zero every live consumer and reset the calibration wizards so no
        # Radio/telemetry data is ever presented as current after the link
        # ends (explicit disconnect OR instant transport loss after a
        # heartbeat) — parity with _mark_connection_lost's honest teardown.
        from services.radio_calibration import reset_radio_calibration

        reset_radio_calibration()
        reset_telemetry()
        tm.reset_actuator_telemetry()
        tm.reset_home_position()
        print(f"[MAVLINK] {reason}")
        sio_server.broadcast_connection_state("DISCONNECTED", reason)
        sio_server.emit("telemetry:update", dict(telemetry))
        sio_server.broadcast_vehicle_status()

    def _on_transport_lost(self) -> None:
        """Reader thread ended without an explicit stop: the link died (device
        unplugged / reset). Tear down so the next connect starts clean and the
        stale 'open' flags never block a reconnect."""
        with self._lock:
            if not self._running:
                return
            self._running = False
        self._teardown("Transport lost — device unplugged or link reset")

    @property
    def running(self) -> bool:
        return self._running

    @property
    def connection(self) -> Any:
        return self._conn

    def send(self, *args, **kwargs) -> None:
        """Convenience: forward sends to the active pymavlink connection."""
        if self._conn is not None:
            self._conn.mav.__getattr__("send")(*args, **kwargs)

    def enqueue(self, fn: Callable[[], None]) -> None:
        """Queue a pymavlink send to be executed on the reader thread.

        pymavlink is not thread-safe: concurrent recv_match() and
        mav.*_send() calls silently drop outgoing messages.  By routing
        all sends through the reader thread, every pymavlink operation
        happens on a single thread.
        """
        self._send_queue.put(fn)

    # ------------------------------------------------------------------
    # Automatic parameter download (QGC behaviour)
    # ------------------------------------------------------------------
    def _start_auto_param_download(self) -> None:
        """Kick off a full parameter download on a fresh link.

        The Setup Summary and Parameters store derive every capability decision
        from the downloaded PARAM_VALUE cache, so the set must exist without an
        explicit user refresh. Guards make this a safe no-op when a download is
        already running or the session is already synced. Re-triggers on every
        reconnect because the parameter session is reset per transport.
        """
        sync = parameter_manager.get_synchronization_state()
        if not sync["connected"]:
            return
        state = sync["state"]
        if state in (STATE_REQUESTING, STATE_RECEIVING):
            return
        if state == STATE_COMPLETE and sync["cachedEntries"] > 0:
            return
        threading.Thread(
            target=self._auto_param_download_worker,
            daemon=True,
            name="param-auto-download",
        ).start()

    def _auto_param_download_worker(self) -> None:
        """Blocking download loop; must run off the reader thread."""
        try:
            parameter_manager.request_all_parameters()
        except Exception as err:  # noqa: BLE001
            print(f"[PARAM] auto-download worker error: {err}")

    # ------------------------------------------------------------------
    # Reader loop
    # ------------------------------------------------------------------
    def _reader_loop(self) -> None:
        conn = self._conn
        while self._running:
            # Drain the send queue — all pymavlink writes happen here on
            # the reader thread, avoiding thread-safety issues.
            while not self._send_queue.empty():
                try:
                    fn = self._send_queue.get_nowait()
                    fn()
                except queue.Empty:
                    break
                except Exception as err:  # noqa: BLE001
                    print(f"[MAVLINK] send-queue error: {err}")

            try:
                msg = conn.recv_match(blocking=True, timeout=1.0)
            except Exception as err:  # noqa: BLE001
                if self._running:
                    print(f"[MAVLINK] recv error: {err}")
                break
            if msg is None:
                self._tick_once_per_second()
                continue

            msg_type = msg.get_type()
            if msg_type in ("BAD_DATA", "BAD_DATA_NUM_BYTES"):
                continue

            sysid = msg.get_srcSystem()
            compid = msg.get_srcComponent()
            if sysid:
                vehicle_state["systemId"] = sysid
                vehicle_state["componentId"] = compid

            handler = HANDLERS.get(msg_type)
            if handler:
                try:
                    result = handler(msg)
                    if msg_type == "HEARTBEAT" and result:
                        self._on_heartbeat()
                except Exception as err:  # noqa: BLE001
                    print(f"[MAVLINK] handler error for {msg_type}: {err}")
            elif msg_type == "COMMAND_ACK":
                print(f"[MAVLINK] CommandAck received: result={getattr(msg, 'result', '?')}")
            else:
                if msg_type not in LOG_FIRST_ONCE:
                    LOG_FIRST_ONCE.add(msg_type)
                    print(f"[MAVLINK] Unhandled message: {msg_type}")

            # One-shot listeners (command/mission ack waits) — parity with
            # mavlink.service.ts: after the telemetry switch, all registered
            # packetListeners for this msgid are invoked.
            if msg_type in ("MISSION_REQUEST", "MISSION_REQUEST_INT", "MISSION_COUNT",
                            "MISSION_ACK", "COMMAND_ACK"):
                print(f"[MAVLINK] >>> DISPATCH {msg_type} (msgid={getattr(msg, 'get_msgId', lambda: '??')()})")
            packet_bus.dispatch(msg)

        # Loop exited. If this was not an intentional stop(), the transport died
        # (serial device unplugged / link reset). Tear everything down so the
        # next connect attempt starts clean instead of waiting on a stale link.
        if self._running:
            self._on_transport_lost()

    def _on_heartbeat(self) -> None:
        vehicle_state["lastHeartbeat"] = int(time.time() * 1000)
        vehicle_state["connectionState"] = "connected"
        vehicle_state["disconnectReason"] = None
        if not self._first_heartbeat:
            self._first_heartbeat = True
            self._heartbeat_event.set()
            print("[MAVLINK] HEARTBEAT received — resolving connect promise")
            # Fresh link (possibly a different vehicle): reset the one-shot
            # stream-request flag so this vehicle's stream rates are requested.
            # Parity with telemetryManager.resetTelemetry() -> resetStreamRequested().
            tm.reset_stream_requested()
            from services.motor_test_service import reset_for_fresh_link

            reset_for_fresh_link()
            sio_server.broadcast_connection_state("CONNECTED")
        elif self._was_lost:
            # The watchdog declared the link lost (heartbeat timeout) but kept
            # the transport open. A resumed heartbeat re-syncs the parameter
            # session (writes were being rejected while disconnected) and pulls
            # the live parameter set again before surfacing CONNECTED.
            self._was_lost = False
            print("[MAVLINK] HEARTBEAT resumed — reconnecting")
            if not parameter_manager.is_connected():
                parameter_manager.start_session()
                self._start_auto_param_download()
            from services.motor_test_service import reset_for_fresh_link

            reset_for_fresh_link()
            sio_server.broadcast_connection_state("CONNECTED", reason="reconnected")
        sio_server.broadcast_vehicle_status()
        self._request_streams_once()
        tm.print_telemetry()

    def _request_streams_once(self) -> None:
        if self._conn is None:
            print("[MAVLINK] No transport available to request telemetry streams")
            return
        request_telemetry_streams(
            self._conn,
            vehicle_state["systemId"] or 1,
            vehicle_state["componentId"] or 1,
        )

    def _tick_once_per_second(self) -> None:
        now = time.time()
        if now - self._last_tick >= 1.0:
            self._last_tick = now
            tm.completion_tick()

    def _mark_connection_lost(self, reason: str) -> None:
        """Heartbeat timeout (watchdog): transition to a fully DISCONNECTED state
        without closing the transport, so a resumed HEARTBEAT auto-reconnects.

        Mirrors _teardown()'s side-effects that keep every consumer honest:
        - parameter session detached (REST/socket writes get rejected and the
          Parameters/Frame/Modes pages flip to DISCONNECTED),
        - calibration wizards reset (never left spinning inside a lost link),
        - stale telemetry zeroed so the last battery/GPS/mode readout is never
          presented as current.
        """
        self._was_lost = True
        if not vehicle_state["connected"]:
            return
        vehicle_state["connected"] = False
        vehicle_state["connectionState"] = "disconnected"
        vehicle_state["disconnectReason"] = reason
        vehicle_state["mode"] = "DISCONNECTED"
        vehicle_state["armed"] = False
        vehicle_state["gpsFix"] = 0
        vehicle_state["satellites"] = 0
        telemetry["connected"] = False
        telemetry["mode"] = "DISCONNECTED"
        telemetry["armed"] = False
        parameter_manager.stop_session(reason)
        from services.calibration_service import reset_session
        from services.motor_test_service import notify_connection_lost
        from services.radio_calibration import reset_radio_calibration

        reset_session()
        notify_connection_lost(reason)
        reset_radio_calibration()
        reset_telemetry()
        tm.reset_actuator_telemetry()
        tm.reset_home_position()
        print(f"[MAVLINK] {reason}")
        sio_server.broadcast_connection_state("DISCONNECTED", reason)
        sio_server.emit("telemetry:update", dict(telemetry))
        sio_server.broadcast_vehicle_status()

    def _check_watchdog(self) -> bool:
        """One watchdog poll. Returns True when it just marked the link lost.

        Extracted from the loop so the heartbeat-timeout detection is
        unit-testable without waiting on the 2s cadence.
        """
        if not self._running:
            return False
        if not vehicle_state["connected"] or vehicle_state["lastHeartbeat"] <= 0:
            return False
        if int(time.time() * 1000) - vehicle_state["lastHeartbeat"] <= config.CONNECTION_TIMEOUT_MS:
            return False
        self._mark_connection_lost("heartbeat_timeout")
        return True

    def _watchdog_loop(self) -> None:
        """Mark the vehicle disconnected when HEARTBEAT stops (parity with the
        Node connectionWatcher's 10s timeout). A resumed heartbeat flips the
        state back to connected, which gives UDP/TCP links auto-reconnect."""
        while not self._watchdog_stop.wait(2.0):
            if not self._running:
                return
            self._check_watchdog()


manager = ConnectionManager()
