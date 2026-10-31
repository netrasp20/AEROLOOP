"""Tests for the structured firmware event log.

The log is the operator's record of what the firmware workflow did. Two things
matter as much as the events themselves: it must never become a place where a
credential is stored, and it must not grow without bound.
"""

import importlib
import json

import pytest


@pytest.fixture()
def log(tmp_path, monkeypatch):
    """Point the logger at a throwaway file, emptied before and after each test."""
    target = tmp_path / "firmware.jsonl"
    monkeypatch.setenv("FIRMWARE_LOG_PATH", str(target))
    from services import firmware_logging as flog

    flog.reset()
    yield flog, target
    flog.reset()


class TestEventRecording:
    def test_event_is_written_as_one_json_object_per_line(self, log):
        flog, target = log
        flog.log_event("download.verified", flog.DOWNLOAD, outcome="DOWNLOAD_COMPLETE")
        flog.log_event("installer.state", flog.INSTALLER, outcome="INSTALLING")

        lines = target.read_text().strip().splitlines()
        assert len(lines) == 2
        first = json.loads(lines[0])
        assert first["event"] == "download.verified"
        assert first["phase"] == "download"
        assert first["outcome"] == "DOWNLOAD_COMPLETE"

    def test_every_phase_constant_is_a_distinct_label(self, log):
        flog, _ = log
        phases = [
            flog.DETECTION, flog.IDENTITY, flog.CATALOG, flog.SELECTION,
            flog.CONFIRMATION, flog.DOWNLOAD, flog.VERIFICATION,
            flog.INSTALLER, flog.DISCONNECT, flog.FAILURE,
        ]
        assert len(set(phases)) == len(phases)
        assert all(isinstance(phase, str) and phase for phase in phases)

    def test_read_events_returns_what_was_logged(self, log):
        flog, _ = log
        flog.log_event("a", flog.DETECTION, outcome="X")
        flog.log_event("b", flog.INSTALLER, outcome="Y")
        assert [e["event"] for e in flog.read_events()] == ["a", "b"]

    def test_read_events_honours_a_limit(self, log):
        flog, _ = log
        for i in range(5):
            flog.log_event(f"e{i}", flog.DOWNLOAD, outcome=str(i))
        assert [e["event"] for e in flog.read_events(limit=2)] == ["e3", "e4"]

    def test_read_events_on_a_missing_file_is_empty_not_an_error(self, log):
        flog, target = log
        assert flog.read_events() == []
        target.unlink(missing_ok=True)
        assert flog.read_events() == []

    def test_none_valued_fields_are_omitted_rather_than_null(self, log):
        """An absent observation is not the same as an observed null."""
        flog, target = log
        flog.log_event("detection.completed", flog.DETECTION, usbSerialNumber=None)
        assert "usbSerialNumber" not in json.loads(target.read_text())

    def test_logging_never_raises(self, log):
        """A broken log must never take the firmware workflow down with it."""
        flog, _ = log
        assert flog._logger().propagate is False
        flog.log_event("download.attempted", flog.DOWNLOAD, outcome="OK", weird=object())


class TestRedaction:
    """A firmware log is a file on disk; it must not become a secret store."""

    def test_credential_named_fields_are_redacted(self, log):
        flog, target = log
        flog.log_event(
            "download.attempted",
            flog.DOWNLOAD,
            password="hunter2",
            apiKey="leak-me",
            token="abc123",
            secret="s3cr3t",
        )
        text = target.read_text()
        for leaked in ("hunter2", "leak-me", "abc123", "s3cr3t"):
            assert leaked not in text

    def test_query_strings_are_stripped_from_any_url(self, log):
        """Signed URLs carry their credential in the query, whatever the key."""
        flog, target = log
        flog.log_event(
            "download.attempted",
            flog.DOWNLOAD,
            url="https://firmware.ardupilot.org/x.apj?X-Amz-Signature=deadbeef",
            downloadUrl="https://firmware.ardupilot.org/y.apj?token=sekrit",
        )
        text = target.read_text()
        assert "deadbeef" not in text
        assert "sekrit" not in text
        # Origin and path survive, so the record is still useful.
        assert "firmware.ardupilot.org/x.apj" in text

    def test_safe_url_keeps_origin_and_path_only(self, log):
        flog, _ = log
        assert (
            flog.safe_url("https://host.example/a/b.apj?sig=1#frag")
            == "https://host.example/a/b.apj"
        )
        assert flog.safe_url(None) is None
        assert flog.safe_url("not a url") is None

    def test_non_url_strings_are_left_alone(self, log):
        flog, target = log
        flog.log_event("detection.completed", flog.DETECTION, usbId="0x1209/0x5741")
        assert "0x1209/0x5741" in target.read_text()

    def test_nested_structures_are_scrubbed_too(self, log):
        flog, target = log
        flog.log_event(
            "installer.state",
            flog.INSTALLER,
            context={"password": "hunter2", "url": "https://h/a.apj?sig=abc"},
            steps=[{"apiKey": "leak-me"}],
        )
        text = target.read_text()
        assert "hunter2" not in text
        assert "leak-me" not in text
        assert "sig=abc" not in text


class TestBoundedGrowth:
    def test_log_is_rotated_rather_than_growing_forever(self, log, monkeypatch):
        flog, target = log
        from core import config

        monkeypatch.setattr(config, "FIRMWARE_LOG_MAX_BYTES", 512, raising=False)
        monkeypatch.setattr(config, "FIRMWARE_LOG_BACKUP_COUNT", 1, raising=False)
        flog.reset()

        for i in range(200):
            flog.log_event("installer.state", flog.INSTALLER, outcome=f"STATE_{i}")

        assert target.with_name(target.name + ".1").exists(), "log never rotated"
        # Bounded: a long-running ground station cannot fill the disk.
        assert target.stat().st_size <= 512

    def test_configured_size_is_read_from_settings(self, log, monkeypatch):
        flog, _ = log
        from core import config

        monkeypatch.setattr(config, "FIRMWARE_LOG_MAX_BYTES", 4096, raising=False)
        assert flog._max_bytes() == 4096

    def test_a_truncated_line_does_not_break_reading(self, log):
        flog, target = log
        flog.log_event("a", flog.DETECTION, outcome="X")
        with target.open("a") as handle:
            handle.write('{"partial": tru')
        assert [e["event"] for e in flog.read_events()] == ["a"]


class _Selected:
    platform = "Pixhawk1"


class _CrossCheck:
    passed = True


class _Resolution:
    outcome = "EXACT_MATCH"
    reason = "bootloader product string matched"
    selected = _Selected()
    signals_used = ("bootloader-product-string",)
    cross_check = _CrossCheck()
    can_confirm = True


class TestResolutionRecorder:
    """One shared definition of "what a resolution records"."""

    def test_resolution_event_records_the_decision_evidence(self, log):
        flog, target = log
        flog.log_resolution(_Resolution(), stage="workflow", candidateCount=901)
        event = json.loads(target.read_text())
        assert event["event"] == "RESOLUTION"
        assert event["phase"] == "catalog"
        assert event["outcome"] == "EXACT_MATCH"
        assert event["selected"] == "Pixhawk1"
        assert event["signalsUsed"] == ["bootloader-product-string"]
        assert event["crossCheckPassed"] is True
        assert event["candidateCount"] == 901

    def test_resolution_event_survives_an_empty_resolution(self, log):
        """No cross-check or selection must not break the audit trail."""

        class Bare:
            outcome = "IDENTITY_UNAVAILABLE"
            reason = "no identity"
            selected = None
            signals_used = []
            cross_check = None
            can_confirm = False

        flog, target = log
        flog.log_resolution(Bare(), stage="catalogue")
        event = json.loads(target.read_text())
        assert event["outcome"] == "IDENTITY_UNAVAILABLE"
        assert "crossCheckPassed" not in event
        assert "selected" not in event


class TestModuleShape:
    def test_logger_is_a_singleton_not_duplicated_per_import(self, log):
        flog, _ = log
        reimported = importlib.import_module("services.firmware_logging")
        assert reimported._logger() is flog._logger()

    def test_reset_does_not_accumulate_handlers(self, log):
        flog, _ = log
        for _ in range(5):
            flog.reset()
            flog.log_event("x", flog.DETECTION)
        assert len(flog._logger().handlers) == 1

    def test_log_lives_under_the_configured_cache_directory(self, tmp_path, monkeypatch):
        from core import config
        from services import firmware_logging as flog

        monkeypatch.delenv("FIRMWARE_LOG_PATH", raising=False)
        monkeypatch.setattr(config, "FIRMWARE_MANIFEST_CACHE_DIR", str(tmp_path / "cache"))
        flog.reset()
        assert flog.log_path() == tmp_path / "cache" / "logs" / "firmware.jsonl"
        flog.reset()