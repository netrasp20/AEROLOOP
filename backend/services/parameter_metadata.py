"""Parameter metadata provider (Phase 2).

Loads the OFFICIAL ArduPilot machine-readable parameter definitions generated
by ArduPilot's own toolchain (Tools/autotest/param_metadata/param_parse.py,
which emits ``apm.pdef.xml``). See backend/metadata/README.md.

Responsibilities:
  * locate + load the pdef XML for a vehicle type
  * parse + validate + normalize once, cache in memory
  * expose O(1) lookup by ``param_id`` and the Mission Planner-style group
  * expose a metadata status (AVAILABLE / UNAVAILABLE / LOADING / ERROR)

Hard boundary: this module has NO MAVLink knowledge. The flight controller's
live PARAM_VALUE stream stays the authority on which parameters actually exist
and their values. A definition here is descriptive only.
"""

import os
import re
import threading
import time
import xml.etree.ElementTree as ET
from typing import Any, Dict, List, Optional

# ---------------------------------------------------------------------------
# Status values (exposed to consumers as `metadataStatus`)
# ---------------------------------------------------------------------------
STATUS_AVAILABLE = "AVAILABLE"
STATUS_UNAVAILABLE = "UNAVAILABLE"
STATUS_LOADING = "LOADING"
STATUS_ERROR = "ERROR"

# Official definition files staged from the ArduPilot toolchain.
_VEHICLE_FILES: Dict[str, str] = {
    "copter": "copter.xml",
    "rover": "rover.xml",
}

# ArduPilot vehicle_type strings (core/state.vehicle_type) -> provider key.
_VEHICLE_TYPE_ALIASES: Dict[str, List[str]] = {
    "copter": ["QUAD", "HEXA", "OCTO", "TRI", "HELI", "COAX" , "VTOL"],
    "rover": ["GROUND", "SURFACE_BOAT", "ROVER"],
    "plane": ["FIXED_WING", "FLAPPING"],
    "sub": ["SUBMARINE"],
}


def vehicle_metadata_key(vehicle_type: Optional[str]) -> Optional[str]:
    """Map a live vehicle_type string to a metadata provider key (or None)."""
    vt = (vehicle_type or "").upper()
    for key, prefixes in _VEHICLE_TYPE_ALIASES.items():
        if any(vt.startswith(p) for p in prefixes):
            return key
    return None  # CUSTOM / GCS / whatever the autopilot reports is not useful


def key_is_supported(key: str) -> bool:
    return key in _VEHICLE_FILES


def _strip_vehicle_prefix(name: str) -> str:
    """ArduPilot prefixes some legacy params with the vehicle name
    (``ArduCopter:FORMAT_VERSION``); the live PARAM_VALUE id has no prefix."""
    if ":" in name:
        return name.split(":", 1)[1]
    return name


def _parse_float(value: Optional[str]) -> Optional[float]:
    if not value:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _parse_values(elem: ET.Element) -> Optional[Dict[str, str]]:
    values = {v.get("code", ""): (v.text or "").strip()
              for v in elem.findall("values/value") if v.get("code") is not None}
    return values or None


def _parse_bitmask(elem: ET.Element) -> Optional[Dict[str, str]]:
    """Bitmask definitions appear in two forms in pdef files:
    ``<bitmask><bit code="0">Label</bit>...</bitmask>`` and the legacy
    ``<field name="Bitmask">0:Label,1:Label</field>``. Merge both."""
    bits: Dict[str, str] = {}
    for b in elem.findall("bitmask/bit"):
        if b.get("code") is not None:
            bits[b.get("code")] = (b.text or "").strip()
    for field in elem.findall("field"):
        if (field.get("name") == "Bitmask") and field.text:
            for part in field.text.split(","):
                if ":" in part:
                    code, _, label = part.partition(":")
                    bits[code.strip()] = label.strip()
    return bits or None


def _parse_range(raw: Optional[str]) -> Dict[str, Any]:
    if not raw:
        return {"min": None, "max": None}
    parts = raw.split()
    if len(parts) >= 2:
        return {"min": _parse_float(parts[0]), "max": _parse_float(parts[1])}
    single = _parse_float(parts[0])
    return {"min": single, "max": single}


class MetadataProvider:
    """In-memory provider for official ArduPilot parameter definitions.

    One instance is enough for a local GCS. Loads each vehicle file once and
    hands back normalized dicts. Thread-safe.
    """

    def __init__(self, metadata_dir: Optional[str] = None) -> None:
        here = os.path.dirname(os.path.abspath(__file__))
        self._metadata_dir = metadata_dir or os.path.join(
            os.path.dirname(here), "metadata"
        )
        self._lock = threading.RLock()
        self._loaded: Dict[str, Dict[str, Any]] = {}   # key -> param catalog
        self._groups: Dict[str, List[str]] = {}        # key -> sorted groups
        self._sources: Dict[str, Dict[str, Any]] = {}  # key -> source info
        self._statuses: Dict[str, str] = {}

    # ------------------------------------------------------------------
    # Loading / caching
    # ------------------------------------------------------------------
    def load_for(self, vehicle_type: Optional[str]) -> Dict[str, Any]:
        """Resolve a live vehicle_type to metadata and load it (cached).

        Returns a consumer-facing status dict. Never raises for missing
        metadata — the caller must keep working with live data only.
        """
        key = vehicle_metadata_key(vehicle_type)
        if key is None or key not in _VEHICLE_FILES:
            return self._status_dict(
                key or "unknown", STATUS_UNAVAILABLE, "No metadata definitions for this vehicle type.",
            )
        return self._ensure_loaded(key)

    def _ensure_loaded(self, key: str) -> Dict[str, Any]:
        with self._lock:
            if self._statuses.get(key) in (STATUS_AVAILABLE, STATUS_LOADING):
                return self._status_dict(key, self._statuses[key])
            self._statuses[key] = STATUS_LOADING
        try:
            catalog, groups, source = self._parse_file(key)
        except FileNotFoundError:
            self._statuses[key] = STATUS_UNAVAILABLE
            return self._status_dict(
                key, STATUS_UNAVAILABLE, "Metadata definition file not found."
            )
        except ET.ParseError as err:  # pragma: no cover - defensive
            self._statuses[key] = STATUS_ERROR
            return self._status_dict(key, STATUS_ERROR, f"Malformed metadata: {err}")
        except Exception as err:  # noqa: BLE001
            self._statuses[key] = STATUS_ERROR
            return self._status_dict(key, STATUS_ERROR, str(err))

        with self._lock:
            self._loaded[key] = catalog
            self._groups[key] = groups
            self._sources[key] = source
            self._statuses[key] = STATUS_AVAILABLE
        print(
            f"[PARAM_META] Loaded {len(catalog)} definitions for '{key}' "
            f"(from {source.get('sourceFile')})"
        )
        return self._status_dict(key, STATUS_AVAILABLE)

    def _parse_file(self, key: str):
        path = os.path.join(self._metadata_dir, _VEHICLE_FILES[key])
        if not os.path.exists(path):
            raise FileNotFoundError(path)
        mod_time = os.path.getmtime(path)
        root = ET.parse(path).getroot()

        catalog: Dict[str, Dict[str, Any]] = {}
        groups: List[str] = []

        def walk(elem: ET.Element, group: Optional[str] = None) -> None:
            for child in elem:
                if child.tag == "param":
                    entry = self._normalize(child, key, group)
                    catalog[entry["id"]] = entry
                    if group and group not in groups:
                        groups.append(group)
                else:
                    walk(child, child.get("name") or group)

        walk(root)
        source = {
            "source": "ardupilot-param_parse.py",
            "sourceFile": _VEHICLE_FILES[key],
            "generatedAt": round(mod_time, 3),
            "loadedAt": time.time(),
            "paramCount": len(catalog),
            "groupCount": len(set(groups)) if groups else 0,
        }
        return catalog, sorted(set(groups)) if groups else [], source

    def _normalize(self, param: ET.Element, key: str, group: Optional[str]) -> Dict[str, Any]:
        fields = {
            (f.get("name") or ""): (f.text or "").strip()
            for f in param.findall("field")
        }
        raw_id = param.get("name") or ""
        param_id = _strip_vehicle_prefix(raw_id) or raw_id
        user = (param.get("user") or "Standard").strip()
        rng = _parse_range(fields.get("Range"))
        values = _parse_values(param)
        bitmask = _parse_bitmask(param)

        return {
            "id": param_id,
            "name": (param.get("humanName") or "").strip() or None,
            "description": (param.get("documentation") or "").strip() or None,
            "units": fields.get("Units") or None,
            "unitText": fields.get("UnitText") or None,
            "min": rng["min"],
            "max": rng["max"],
            "increment": _parse_float(fields.get("Increment")),
            "values": values,
            "bitmask": bitmask,
            "readOnly": fields.get("ReadOnly", "").lower() == "true",
            "rebootRequired": fields.get("RebootRequired", "").lower() == "true",
            "user": user,
            "advanced": user.lower() == "advanced",
            "group": group or None,
            "source": _VEHICLE_FILES[key],
        }

    # ------------------------------------------------------------------
    # Lookup
    # ------------------------------------------------------------------
    def lookup(self, param_id: str, vehicle_key: str) -> Optional[Dict[str, Any]]:
        """O(1) metadata lookup by param_id for an already-resolved vehicle."""
        with self._lock:
            catalog = self._loaded.get(vehicle_key)
        if catalog is None:
            return None
        return catalog.get(param_id)

    def _resolve_key(self, vehicle_type: Optional[str]) -> Optional[str]:
        return vehicle_metadata_key(vehicle_type)

    def availability(self, vehicle_type: Optional[str]) -> bool:
        key = self._resolve_key(vehicle_type)
        return self._statuses.get(key) == STATUS_AVAILABLE

    def status(self, vehicle_type: Optional[str]) -> Dict[str, Any]:
        key = self._resolve_key(vehicle_type)
        if key is None:
            return self._status_dict("unknown", STATUS_UNAVAILABLE,
                                     "No metadata definitions for this vehicle type.")
        if self._statuses.get(key) == STATUS_AVAILABLE:
            return self._status_dict(key, STATUS_AVAILABLE)
        return self._ensure_loaded(key)

    def groups(self, vehicle_type: Optional[str]) -> List[str]:
        key = self._resolve_key(vehicle_type)
        with self._lock:
            return list(self._groups.get(key, []))

    def status_dict_for(self, vehicle_type: Optional[str]) -> Dict[str, Any]:
        return self.status(vehicle_type)

    def _status_dict(self, key: str, status: str, message: Optional[str] = None,
                     **extra: Any) -> Dict[str, Any]:
        with self._lock:
            source = self._sources.get(key)
        payload: Dict[str, Any] = {
            "vehicle": key,
            "status": status,
            "source": source.get("source") if source else None,
            "sourceFile": source.get("sourceFile") if source else None,
            "loadedAt": source.get("loadedAt") if source else None,
            "generatedAt": source.get("generatedAt") if source else None,
            "paramCount": source.get("paramCount", 0) if source else 0,
            "groupCount": source.get("groupCount", 0) if source else 0,
            "message": message,
        }
        payload.update(extra)
        return payload


metadata_provider = MetadataProvider()