"""MAVFTP service — MAVLink File Transfer Protocol operations."""
from __future__ import annotations

import struct
import threading
import time
from typing import Any, Dict, List

from mavlink.connection_manager import manager
from mavlink import packet_bus

# MAVLink FILE_TRANSFER_PROTOCOL message id
FILE_TRANSFER_PROTOCOL_MSGID = 110

# MAVLink FTP opcodes
OP_NONE = 0
OP_TERMINATE = 1
OP_RESET = 2
OP_LIST_DIR = 3
OP_OPEN_FILE_RO = 4
OP_READ_FILE = 5
OP_CREATE_FILE = 6
OP_WRITE_FILE = 7
OP_REMOVE_FILE = 8
OP_CREATE_DIR = 9
OP_REMOVE_DIR = 10
OP_OPEN_FILE_WO = 11
OP_RENAME = 13
OP_BURST_READ = 15

# Response opcodes
OP_ACK = 128
OP_NAK = 129

# NAK error codes
ERR_NONE = 0
ERR_FAIL = 1
ERR_FAIL_ERRNO = 2
ERR_INVALID_DATA_SIZE = 3
ERR_INVALID_SESSION = 4
ERR_NO_SESSIONS = 5
ERR_EOF = 6
ERR_UNKNOWN_CMD = 7
ERR_FILE_EXISTS = 8
ERR_FILE_PROTECTED = 9
ERR_FILE_NOT_FOUND = 10

NAK_ERRORS = {
    ERR_NONE: "None",
    ERR_FAIL: "Generic failure",
    ERR_FAIL_ERRNO: "System error",
    ERR_INVALID_DATA_SIZE: "Invalid data size",
    ERR_INVALID_SESSION: "Invalid session",
    ERR_NO_SESSIONS: "No sessions available",
    ERR_EOF: "End of file/directory",
    ERR_UNKNOWN_CMD: "Unknown command",
    ERR_FILE_EXISTS: "File already exists",
    ERR_FILE_PROTECTED: "File is write-protected",
    ERR_FILE_NOT_FOUND: "File not found",
}

MAX_PAYLOAD = 251
DEFAULT_TIMEOUT = 3.0
MAX_RETRIES = 3
CHUNK_SIZE = 200


class MavFtpError(Exception):
    def __init__(self, code: int, message: str = ""):
        self.code = code
        self.message = message or NAK_ERRORS.get(code, f"Unknown error {code}")
        super().__init__(self.message)


class MavFtpService:
    """MAVLink FTP client for ArduPilot autopilot file operations."""

    def __init__(self):
        self._session = 0
        self._seq = 0
        self._timeout = DEFAULT_TIMEOUT

    @staticmethod
    def _validate_path(path: str) -> None:
        """Reject paths containing traversal components or empty strings."""
        if not path or not isinstance(path, str):
            raise MavFtpError(ERR_FAIL, "Invalid path: empty.")
        if ".." in path.split("/"):
            raise MavFtpError(ERR_FAIL, "Invalid path: path traversal not allowed.")
        if not path.startswith("/"):
            raise MavFtpError(ERR_FAIL, "Invalid path: must be absolute.")

    def _get_conn(self):
        conn = manager.connection
        if conn is None:
            raise MavFtpError(ERR_FAIL, "No MAVLink connection.")
        return conn

    def _next_seq(self) -> int:
        self._seq = (self._seq + 1) & 0xFFFF
        return self._seq

    def _build_ftp_msg(self, opcode: int, data: bytes = b"",
                        session: int = 0, offset: int = 0,
                        req_opcode: int = 0, burst_complete: int = 0,
                        size: int = -1) -> Any:
        """Build a FILE_TRANSFER_PROTOCOL message."""
        from pymavlink.dialects.v20.ardupilotmega import (
            MAVLink_file_transfer_protocol_message,
        )
        seq = self._next_seq()
        if size < 0:
            size = len(data)
        # Payload: 12-byte header + data
        payload = bytearray(12 + len(data))
        struct.pack_into("<HBBB B B B I", payload, 0,
                         seq, session, opcode, size,
                         req_opcode, burst_complete, 0, offset)
        payload[12:12 + len(data)] = data
        # Pad to 251 bytes (pymavlink 2.4.49+ payload array size)
        while len(payload) < 251:
            payload.append(0)
        return MAVLink_file_transfer_protocol_message(
            target_network=0,
            target_system=0,
            target_component=0,
            payload=bytes(payload[:251]),
        )

    def _parse_ftp_msg(self, msg: Any) -> Dict[str, Any]:
        """Parse a FILE_TRANSFER_PROTOCOL message."""
        payload = bytes(msg.payload)
        if len(payload) < 12:
            raise MavFtpError(ERR_FAIL, "FTP payload too short.")
        seq, session, opcode, size, req_opcode, burst_complete, _, offset = \
            struct.unpack_from("<HBBB B B B I", payload, 0)
        data = payload[12:12 + size] if size > 0 else b""
        return {
            "seq": seq,
            "session": session,
            "opcode": opcode,
            "size": size,
            "req_opcode": req_opcode,
            "burst_complete": burst_complete,
            "offset": offset,
            "data": data,
        }

    def _send_and_wait(self, msg: Any) -> Dict[str, Any]:
        """Send an FTP message and wait for ACK/NAK response.

        The MAVLink reader thread owns the connection, so we register a
        one-shot packet-bus listener and enqueue the send for execution on
        that thread.  This avoids racing the telemetry reader on recv_match.
        """
        conn = self._get_conn()
        reply_box: Dict[str, Any] = {}
        done = threading.Event()

        def _on_reply(reply_msg: Any) -> None:
            try:
                reply_box.update(self._parse_ftp_msg(reply_msg))
            except MavFtpError as err:
                reply_box["_error"] = err
            done.set()

        try:
            unsub = packet_bus.on_packet(FILE_TRANSFER_PROTOCOL_MSGID, _on_reply)
        except Exception:  # noqa: BLE001
            # Fallback: send directly if the bus is unavailable.
            conn.mav.send(msg)
            deadline = time.time() + self._timeout
            while time.time() < deadline:
                reply = conn.recv_match(type="FILE_TRANSFER_PROTOCOL", blocking=True, timeout=0.5)
                if reply is None:
                    continue
                return self._parse_ftp_msg(reply)
            raise MavFtpError(ERR_FAIL, "FTP request timed out.")

        try:
            manager.enqueue(lambda: conn.mav.send(msg))
            if not done.wait(self._timeout):
                raise MavFtpError(ERR_FAIL, "FTP request timed out.")
        finally:
            unsub()

        if "_error" in reply_box:
            raise reply_box["_error"]  # type: ignore[misc]

        if reply_box.get("opcode") == OP_ACK:
            return reply_box
        if reply_box.get("opcode") == OP_NAK:
            err_code = reply_box.get("data", b"")
            if isinstance(err_code, (bytes, bytearray)) and err_code:
                err_code = err_code[0]
            else:
                err_code = ERR_FAIL
            raise MavFtpError(err_code)
        raise MavFtpError(ERR_FAIL, "Unexpected FTP response.")

    # ---- Public API ----

    def list_directory(self, path: str) -> List[Dict[str, Any]]:
        """List directory contents. Returns list of {name, type, size}."""
        self._validate_path(path)
        entries: List[Dict[str, Any]] = []
        offset = 0
        while True:
            try:
                msg = self._build_ftp_msg(OP_LIST_DIR,
                                           path.encode("utf-8"),
                                           offset=offset)
                resp = self._send_and_wait(msg)
                data = resp["data"]
                if not data:
                    break
                # Parse MAVLink FTP LIST: entries are "<Type><name>\t<size>\0"
                # where Type is 'F' (file), 'D' (directory) or 'S' (skip).
                raw = data.decode("utf-8", errors="replace")
                parts = raw.split("\0")
                added = 0
                for part in parts:
                    part = part.strip("\x00").strip()
                    if not part:
                        continue
                    ftype_char = part[0]
                    if ftype_char == "S":
                        continue
                    rest = part[1:]
                    size = 0
                    if "\t" in rest:
                        rest, size_str = rest.split("\t", 1)
                        try:
                            size = int(size_str)
                        except ValueError:
                            size = 0
                    is_dir = ftype_char == "D" or rest.endswith("/")
                    entries.append({
                        "name": rest.rstrip("/"),
                        "type": "directory" if is_dir else "file",
                        "size": size,
                    })
                    added += 1
                if added == 0:
                    break
                offset += added
                # If fewer entries than a full page, we're done
                if added < (len(data) // 2):
                    break
            except MavFtpError as e:
                if e.code == ERR_EOF:
                    break
                raise
        return entries

    def read_file(self, path: str) -> bytes:
        """Read an entire file. Returns raw bytes."""
        self._validate_path(path)
        # Open for reading. The OpenFileRO ACK returns the 4-byte LE file
        # size in the data field (not in the header size field).
        msg = self._build_ftp_msg(OP_OPEN_FILE_RO, path.encode("utf-8"))
        resp = self._send_and_wait(msg)
        session = resp["session"]
        ack_data = resp.get("data") or b""
        if len(ack_data) >= 4:
            file_size = struct.unpack("<I", ack_data[:4])[0]
        else:
            file_size = resp.get("size", 0)

        # Read in chunks
        data = bytearray()
        offset = 0
        while offset < file_size:
            chunk_size = min(CHUNK_SIZE, file_size - offset)
            msg = self._build_ftp_msg(OP_READ_FILE, session=session,
                                       offset=offset, size=chunk_size)
            resp = self._send_and_wait(msg)
            data.extend(resp["data"])
            offset += len(resp["data"])
            if len(resp["data"]) < chunk_size:
                break

        # Terminate session
        try:
            msg = self._build_ftp_msg(OP_TERMINATE, session=session)
            self._send_and_wait(msg)
        except MavFtpError:
            pass

        return bytes(data)

    def write_file(self, path: str, data: bytes) -> bool:
        """Write data to a file. Creates/truncates the file."""
        self._validate_path(path)
        msg = self._build_ftp_msg(OP_CREATE_FILE, path.encode("utf-8"))
        resp = self._send_and_wait(msg)
        session = resp["session"]

        # Write in chunks
        offset = 0
        while offset < len(data):
            chunk = data[offset:offset + CHUNK_SIZE]
            msg = self._build_ftp_msg(OP_WRITE_FILE, chunk,
                                       session=session, offset=offset,
                                       size=len(chunk))
            self._send_and_wait(msg)
            offset += len(chunk)

        # Terminate session
        try:
            msg = self._build_ftp_msg(OP_TERMINATE, session=session)
            self._send_and_wait(msg)
        except MavFtpError:
            pass

        return True

    def remove_file(self, path: str) -> bool:
        """Remove a file."""
        self._validate_path(path)
        msg = self._build_ftp_msg(OP_REMOVE_FILE, path.encode("utf-8"))
        self._send_and_wait(msg)
        return True

    def create_directory(self, path: str) -> bool:
        """Create a directory."""
        self._validate_path(path)
        msg = self._build_ftp_msg(OP_CREATE_DIR, path.encode("utf-8"))
        self._send_and_wait(msg)
        return True

    def remove_directory(self, path: str) -> bool:
        """Remove an empty directory."""
        self._validate_path(path)
        msg = self._build_ftp_msg(OP_REMOVE_DIR, path.encode("utf-8"))
        self._send_and_wait(msg)
        return True

    def rename(self, old_path: str, new_path: str) -> bool:
        """Rename/move a file or directory."""
        self._validate_path(old_path)
        self._validate_path(new_path)
        data = old_path.encode("utf-8") + b"\0" + new_path.encode("utf-8")
        msg = self._build_ftp_msg(OP_RENAME, data)
        self._send_and_wait(msg)
        return True


# Singleton
ftp_service = MavFtpService()
