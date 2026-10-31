"""Parameter file service (Phase 6).

Mission Planner-style Save / Load / Compare for ``.param`` files, built on the
existing Phase 1-5 layers (ParameterManager stays the sole MAVLink authority;
all writes still go through the Phase 5 write transaction).

Two stable, testable operations:

  * ``analyze(content, ...)``   parse + validate + compare a parameter file
    against the authoritative live vehicle set (or a preset's values). The
    vehicle live value is ALWAYS the comparison baseline — never metadata.
  * ``export_params(...)``      serialize the authoritative live set into a
    Mission Planner-compatible ``.param`` file.

Semantics that tests and the frontend rely on:

  * param_id (never index) is the identity; entries are matched by name.
  * Files are untrusted data: parsing never executes and never produces a
    value for something the vehicle does not already expose.
  * ``same`` / ``changed`` are decided with the same type-aware float
    comparison the write path uses (values_match).
  * ``read_only`` / ``invalid`` / ``unknown`` items are never stageable.
  * No write ever happens here — Apply-selected produces the review the
    frontend turns into Phase 4 staged edits (then Phase 5 writes them).
"""

import re
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from mavlink import parameter_manager as pm

# ---------------------------------------------------------------------------
# File format constants (Mission Planner / MAVProxy compatible)
# ---------------------------------------------------------------------------

_ID_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

_COMMENT_PREFIXES = ("#", "//", ";")

MAX_FILE_CHARS = 2_000_000    # 2 MB guard — never let a huge file swamp a link
MAX_FILE_LINES = 200_000

# Category short-names returned to the frontend.
CAT_CHANGED = "changed"
CAT_SAME = "same"
CAT_UNKNOWN = "unknown"
CAT_READ_ONLY = "read_only"
CAT_INVALID = "invalid"

STAGEABLE = {CAT_CHANGED}


class ParameterFileError(Exception):
    """Bad-request style error carrying a stable code."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _is_comment(line: str) -> bool:
    return line.startswith(_COMMENT_PREFIXES)


def _split_entry(line: str) -> Optional[tuple]:
    """Split ``NAME,VALUE`` / ``NAME\\tVALUE`` / ``NAME VALUE`` -> (id, raw)."""
    text = line.strip()
    if not text or _is_comment(text):
        return None
    if "," in text:
        parts = text.split(",", 1)
    elif "\t" in text:
        parts = text.split("\t", 1)
    else:
        parts = text.split(None, 1)
    if len(parts) != 2:
        return None
    name, raw = parts[0].strip(), parts[1].strip()
    if not name or not raw or not _ID_RE.match(name):
        return None
    return name, raw


def _parse_value(raw: str) -> Optional[float]:
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    if value != value:  # NaN from float("nan")
        return None
    return value


class ParameterFileService:
    """Parse / validate / compare / serialize parameter files."""

    def __init__(self, manager: pm.ParameterManager) -> None:
        self._manager = manager

    # ------------------------------------------------------------------
    # Parsing (pure; never touches the vehicle)
    # ------------------------------------------------------------------
    def parse(self, content: str, filename: str = "") -> Dict[str, Any]:
        """Parse a ``.param`` file into entries + a quality report.

        Never raises for bad content. Returns:
          total / valid / malformed / duplicate / skipped counts,
          ``entries`` sorted by param_id, and per-key issue notes.
        """
        if content is None:
            raise ParameterFileError("BAD_REQUEST", "File content is required.")
        if not isinstance(content, str):
            raise ParameterFileError("BAD_REQUEST", "File content must be text.")
        if len(content) > MAX_FILE_CHARS:
            raise ParameterFileError(
                "FILE_TOO_LARGE",
                f"Parameter file exceeds the {MAX_FILE_CHARS} character limit.",
            )

        lines = content.splitlines()
        if len(lines) > MAX_FILE_LINES:
            raise ParameterFileError(
                "FILE_TOO_LARGE",
                f"Parameter file exceeds {MAX_FILE_LINES} lines.",
            )

        entries: Dict[str, float] = {}
        malformed: List[str] = []
        duplicates: List[str] = []
        skipped = 0

        for line in lines:
            split = _split_entry(line)
            if split is None:
                if line.strip() and not _is_comment(line.strip()):
                    malformed.append(line.strip())
                elif not line.strip():
                    skipped += 1
                continue
            param_id, raw = split
            value = _parse_value(raw)
            if value is None:
                malformed.append(f"{param_id},{raw}")
                continue
            if param_id in entries:
                duplicates.append(param_id)
            entries[param_id] = value

        ordered = sorted(entries.items())
        return {
            "success": True,
            "filename": filename or "",
            "parse": {
                "total": len(lines),
                "valid": len(entries),
                "malformed": len(malformed),
                "duplicate": len(duplicates),
                "skipped": skipped,
                "commentLines": sum(
                    1 for line in lines if line.strip() and _is_comment(line.strip())
                ),
                "malformedLines": malformed[:50],
                "duplicateParams": sorted(set(duplicates))[:50],
                "entries": [
                    {"paramId": pid, "value": value} for pid, value in ordered
                ],
            },
        }

    # ------------------------------------------------------------------
    # Analyze: parse + validate + compare against the live vehicle
    # ------------------------------------------------------------------
    def analyze(self, content: str, filename: str = "",
                staged: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Parse a file and compare every entry against the authoritative live
        vehicle set. ``staged`` is the client's current staged map
        ({paramId: value}) so row-level file-vs-staging conflicts can be shown
        before any Apply happens."""
        parsed = self.parse(content, filename)
        if not parsed.get("success"):
            return parsed

        if not self._manager.is_connected():
            return {
                "success": False,
                "error": {
                    "code": "NOT_CONNECTED",
                    "message": "Not connected to the flight controller. "
                               "Connect before loading or comparing parameter files.",
                },
            }

        live = {e["id"]: e for e in self._manager.get_all_parameters()}
        staged = staged or {}
        vehicle_key = self._vehicle_key()

        rows: List[Dict[str, Any]] = []
        counts = {CAT_CHANGED: 0, CAT_SAME: 0, CAT_UNKNOWN: 0,
                  CAT_READ_ONLY: 0, CAT_INVALID: 0}
        file_ids = []

        for entry in parsed["parse"]["entries"]:
            param_id = entry["paramId"]
            file_val = entry["value"]
            file_ids.append(param_id)
            live_entry = live.get(param_id)

            meta = None
            if live_entry is not None and vehicle_key:
                meta = self._lookup_meta(param_id, vehicle_key)

            if live_entry is None:
                row = self._row(param_id, CAT_UNKNOWN, None, file_val, meta,
                                staged, "Not present on the connected vehicle.")
            elif meta and meta.get("readOnly"):
                row = self._row(param_id, CAT_READ_ONLY, live_entry["value"],
                                file_val, meta, staged,
                                "Parameter is read-only on the vehicle.")
            else:
                try:
                    pm.normalize_value(file_val, live_entry["type"])
                    valid = True
                except pm.ParameterError as err:
                    valid = False
                    reason = err.message or "Value cannot be represented for this type."
                if not valid:
                    row = self._row(param_id, CAT_INVALID, live_entry["value"],
                                    file_val, meta, staged, reason)
                elif self._same(live_entry["value"], file_val, live_entry["type"]):
                    row = self._row(param_id, CAT_SAME, live_entry["value"],
                                    file_val, meta, staged)
                else:
                    row = self._row(param_id, CAT_CHANGED, live_entry["value"],
                                    file_val, meta, staged)

            rows.append(row)
            counts[row["category"]] += 1

        rows.sort(key=lambda r: r["paramId"])
        return {
            "success": True,
            "filename": parsed["filename"],
            "parse": parsed["parse"],
            "compare": {
                "counts": counts,
                "diffCount": counts[CAT_CHANGED],
                "rows": rows,
                "fileIds": file_ids,
            },
        }

    # ------------------------------------------------------------------
    # Export (Save Current Vehicle Params)
    # ------------------------------------------------------------------
    def export_params(self, source: str = "vehicle") -> Dict[str, Any]:
        """Serialize the authoritative live set into a ``.param`` file.

        Only ``vehicle`` is authoritative from the backend (staged edits live
        in the browser); the frontend builds a staged export locally from the
        same live baseline so the two can never mix silently.
        """
        if source not in ("vehicle",):
            raise ParameterFileError(
                "BAD_REQUEST",
                'Only "vehicle" is an authoritative export source.',
            )
        if not self._manager.is_connected():
            return {
                "success": False,
                "error": {
                    "code": "NOT_CONNECTED",
                    "message": "Not connected to the flight controller.",
                },
            }

        entries = self._manager.get_all_parameters()
        vehicle_type = self._vehicle_type() or "vehicle"
        filename = (f"{vehicle_type.lower()}_params_"
                    f"{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}.param")
        content = self.serialize(entries, vehicle_type=vehicle_type)
        return {
            "success": True,
            "filename": filename,
            "content": content,
            "count": len(entries),
            "source": source,
        }

    @staticmethod
    def serialize(entries: List[Dict[str, Any]],
                  vehicle_type: Optional[str] = None) -> str:
        """Build ``.param`` text from parameter snapshots {id, value, ...}.

        Sorted by param_id. Header is comments only, so the body stays
        perfectly round-trippable through Mission Planner / MAVProxy.
        """
        lines: List[str] = []
        if vehicle_type:
            lines.append(f"# YantraYug parameter export — vehicle: {vehicle_type}")
        lines.append(f"# exportedAt: {datetime.now(timezone.utc).isoformat()}")
        lines.append(f"# paramCount: {len(entries)}")
        lines.append("#")
        for entry in sorted(entries, key=lambda e: (e.get("id") or "")):
            value = entry.get("value")
            lines.append(f"{entry['id']},{_fmt(value)}")
        return "\n".join(lines) + ("\n" if lines else "")

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------
    def _row(self, param_id: str, category: str, vehicle_value: Optional[float],
             file_value: float, meta: Optional[Dict[str, Any]],
             staged: Dict[str, Any], message: Optional[str] = None) -> Dict[str, Any]:
        staged_value = staged.get(param_id)
        staged_conflict = False
        if staged_value is not None and vehicle_value is not None:
            staged_conflict = not self._same(float(staged_value), file_value,
                                             self._live_type(param_id) or 9)
        return {
            "paramId": param_id,
            "category": category,
            "vehicleValue": vehicle_value,
            "fileValue": file_value,
            "stageable": category in STAGEABLE,
            "stagedValue": staged_value,
            "stagedConflict": staged_conflict,
            "message": message,
            "readOnly": bool(meta and meta.get("readOnly")),
            "group": (meta or {}).get("group"),
            "rebootRequired": bool(meta and meta.get("rebootRequired")),
        }

    def _same(self, actual: float, wanted: float, param_type: int) -> bool:
        cfg = self._manager._config
        return pm.values_match(actual, wanted, param_type,
                               cfg["float_rel_tol"], cfg["float_abs_tol"])

    def _live_type(self, param_id: str) -> Optional[int]:
        entry = self._manager.get_parameter(param_id)
        return entry["type"] if entry else None

    def _vehicle_key(self) -> Optional[str]:
        from services.parameter_metadata import metadata_provider

        return metadata_provider._resolve_key(self._vehicle_type())

    def _lookup_meta(self, param_id: str, vehicle_key: str) -> Optional[Dict[str, Any]]:
        from services.parameter_metadata import metadata_provider

        return metadata_provider.lookup(param_id, vehicle_key)

    @staticmethod
    def _vehicle_type() -> Optional[str]:
        from core.state import get_vehicle_status

        try:
            return (get_vehicle_status() or {}).get("vehicleType")
        except Exception:  # pragma: no cover - defensive
            return None


def _fmt(value: Any) -> str:
    """Compact float formatting that round-trips integers cleanly."""
    if isinstance(value, bool):
        return "1" if value else "0"
    number = float(value)
    if number == int(number) and abs(number) < 1e18:
        return str(int(number))
    return repr(number)


def _make_file_service() -> ParameterFileService:
    from mavlink.parameter_manager import parameter_manager

    return ParameterFileService(parameter_manager)


parameter_file_service = _make_file_service()