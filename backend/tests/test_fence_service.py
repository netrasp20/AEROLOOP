"""Tests for fence service (upload/download/clear)."""

import pytest
from unittest.mock import MagicMock, patch, AsyncMock


class TestFenceService:
    """Test fence upload, download, and clear operations."""

    def test_fence_point_creation(self):
        """FencePoint should serialize correctly."""
        from services.fence_service import FencePoint

        pt = FencePoint(lat=13.0125, lng=77.7043, command=5001, param1=0, param2=0)
        d = pt.to_dict()
        assert d["lat"] == 13.0125
        assert d["lng"] == 77.7043
        assert d["command"] == 5001
        assert d["param1"] == 0
        assert d["param2"] == 0

    def test_fence_point_circle(self):
        """FencePoint for circle should have param1=radius."""
        from services.fence_service import FencePoint

        pt = FencePoint(lat=13.0125, lng=77.7043, command=5003, param1=100)
        d = pt.to_dict()
        assert d["param1"] == 100

    def test_fence_command_constants(self):
        """Fence MAVLink command constants should be correct."""
        from mavlink.mission_command import (
            MAV_CMD_NAV_FENCE_RETURN_POINT,
            MAV_CMD_NAV_FENCE_POLYGON_VERTEX_INCLUSION,
            MAV_CMD_NAV_FENCE_POLYGON_VERTEX_EXCLUSION,
            MAV_CMD_NAV_FENCE_CIRCLE_INCLUSION,
            MAV_CMD_NAV_FENCE_CIRCLE_EXCLUSION,
            MAV_MISSION_TYPE_FENCE,
        )

        assert MAV_CMD_NAV_FENCE_RETURN_POINT == 5000
        assert MAV_CMD_NAV_FENCE_POLYGON_VERTEX_INCLUSION == 5001
        assert MAV_CMD_NAV_FENCE_POLYGON_VERTEX_EXCLUSION == 5002
        assert MAV_CMD_NAV_FENCE_CIRCLE_INCLUSION == 5003
        assert MAV_CMD_NAV_FENCE_CIRCLE_EXCLUSION == 5004
        assert MAV_MISSION_TYPE_FENCE == 1

    def test_to_upload_items_sets_vertex_count_for_polygons(self):
        """Polygon vertices must carry param1 = vertex count of their polygon.

        Mirrors AC_PolyFence_loader::validate_fence: consecutive vertices of the
        same polygon command form one polygon, and each carries the count.
        """
        from services.fence_service import to_upload_items

        points = [
            {"lat": 13.012, "lng": 77.703, "command": 5001, "param1": 0, "param2": 0},
            {"lat": 13.014, "lng": 77.7035, "command": 5001, "param1": 0, "param2": 0},
            {"lat": 13.013, "lng": 77.706, "command": 5001, "param1": 0, "param2": 0},
        ]
        items = to_upload_items(points)
        assert len(items) == 3
        assert all(it["command"] == 5001 for it in items)
        assert [it["param1"] for it in items] == [3.0, 3.0, 3.0]
        assert all(it["mission_type"] == 1 for it in items)

    def test_to_upload_items_respects_existing_polygon_vertex_count(self):
        """A 4-vertex polygon keeps its count (param1 from frontend, verified)."""
        from services.fence_service import to_upload_items

        points = [
            {"lat": 13.012, "lng": 77.703, "command": 5001, "param1": 4, "param2": 0},
            {"lat": 13.014, "lng": 77.7035, "command": 5001, "param1": 4, "param2": 0},
            {"lat": 13.013, "lng": 77.706, "command": 5001, "param1": 4, "param2": 0},
            {"lat": 13.012, "lng": 77.705, "command": 5001, "param1": 4, "param2": 0},
        ]
        items = to_upload_items(points)
        assert [it["param1"] for it in items] == [4.0, 4.0, 4.0, 4.0]

    def test_to_upload_items_handles_two_polygon_runs(self):
        """Inclusion and exclusion polygons get separate vertex counts."""
        from services.fence_service import to_upload_items

        points = [
            {"lat": 13.012, "lng": 77.703, "command": 5001, "param1": 0, "param2": 0},
            {"lat": 13.014, "lng": 77.7035, "command": 5001, "param1": 0, "param2": 0},
            {"lat": 13.013, "lng": 77.706, "command": 5001, "param1": 0, "param2": 0},
            {"lat": 13.013, "lng": 77.705, "command": 5002, "param1": 0, "param2": 0},
            {"lat": 13.0135, "lng": 77.7052, "command": 5002, "param1": 0, "param2": 0},
            {"lat": 13.0128, "lng": 77.7058, "command": 5002, "param1": 0, "param2": 0},
        ]
        items = to_upload_items(points)
        assert [it["param1"] for it in items] == [3.0, 3.0, 3.0, 3.0, 3.0, 3.0]
        assert [it["command"] for it in items] == [5001, 5001, 5001, 5002, 5002, 5002]

    def test_to_upload_items_keeps_circle_radius(self):
        """Circle radius (param1) is preserved from the frontend point."""
        from services.fence_service import to_upload_items

        points = [
            {"lat": 13.0121, "lng": 77.704, "command": 5003, "param1": 60, "param2": 0},
        ]
        items = to_upload_items(points)
        assert items[0]["param1"] == 60.0
        assert items[0]["command"] == 5003

    def test_to_frontend_points_round_trip(self):
        """Upload items round-trip back to frontend points."""
        from services.fence_service import to_upload_items, to_frontend_points

        points = [
            {"lat": 13.012, "lng": 77.703, "command": 5000, "param1": 0, "param2": 0},
            {"lat": 13.012, "lng": 77.703, "command": 5001, "param1": 0, "param2": 0},
            {"lat": 13.014, "lng": 77.7035, "command": 5001, "param1": 0, "param2": 0},
            {"lat": 13.013, "lng": 77.706, "command": 5001, "param1": 0, "param2": 0},
            {"lat": 13.0121, "lng": 77.704, "command": 5003, "param1": 60, "param2": 0},
        ]
        items = to_upload_items(points)
        back = to_frontend_points(items)
        assert len(back) == 5
        assert back[0]["command"] == 5000
        assert back[1]["command"] == 5001
        assert back[1]["param1"] == 3.0
        assert back[4]["command"] == 5003
        assert back[4]["param1"] == 60.0

    def test_upload_settles_for_async_activation(self):
        """upload_fence waits until download reports the new count (real-board async)."""
        from services import fence_service
        from services.fence_service import FENCE_ACTIVATION_SETTLE_S

        points = [
            {"lat": 13.0115, "lng": 77.7025, "command": 5000, "param1": 0, "param2": 0},
            {"lat": 13.0120, "lng": 77.7030, "command": 5001, "param1": 0, "param2": 0},
            {"lat": 13.0140, "lng": 77.7035, "command": 5001, "param1": 0, "param2": 0},
            {"lat": 13.0130, "lng": 77.7060, "command": 5001, "param1": 0, "param2": 0},
        ]
        calls = {"n": 0}

        def fake_upload(points, on_progress=None):
            return {"items": points, "ackCode": 0, "count": len(points)}

        # First download probe reports 0 (stale), second reports full count
        def fake_download():
            calls["n"] += 1
            if calls["n"] == 1:
                return {"success": True, "points": [], "count": 0}
            return {
                "success": True,
                "count": 4,
                "points": [
                    {"lat": p["lat"], "lng": p["lng"], "command": p["command"],
                     "param1": 3.0, "param2": 0, "seq": i}
                    for i, p in enumerate(points)
                ],
            }

        with patch.object(fence_service, "_upload_fence_impl", fake_upload), \
             patch.object(fence_service, "download_fence", fake_download):
            result = fence_service.upload_fence(points)

        assert calls["n"] >= 2, "upload_fence must poll download until the fence is active"
        assert result["count"] == 4
        assert FENCE_ACTIVATION_SETTLE_S >= 1.5

    def test_upload_settle_gives_up_politely(self):
        """upload_fence returns even if the fence never activates (no hang)."""
        from services import fence_service

        points = [{"lat": 13.012, "lng": 77.703, "command": 5001, "param1": 0, "param2": 0}]

        def fake_upload(points, on_progress=None):
            return {"items": points, "ackCode": 0, "count": len(points)}

        def fake_download():
            return {"success": True, "points": [], "count": 0}

        with patch.object(fence_service, "_upload_fence_impl", fake_upload), \
             patch.object(fence_service, "download_fence", fake_download), \
             patch.object(fence_service, "FENCE_ACTIVATION_SETTLE_S", 0.2):
            result = fence_service.upload_fence(points)

        assert result["count"] == 1

    def test_verify_fence_passes_on_matching_download(self):
        """verify_fence succeeds when the download matches what was uploaded."""
        from services import fence_service

        points = [
            {"lat": 13.0115, "lng": 77.7025, "command": 5000, "param1": 0, "param2": 0},
            {"lat": 13.0120, "lng": 77.7030, "command": 5001, "param1": 0, "param2": 0},
            {"lat": 13.0140, "lng": 77.7035, "command": 5001, "param1": 0, "param2": 0},
            {"lat": 13.0130, "lng": 77.7060, "command": 5001, "param1": 0, "param2": 0},
        ]
        downloaded = {
            "success": True,
            "count": 4,
            "points": [
                {"lat": 13.0115, "lng": 77.7025, "command": 5000, "param1": 0.0, "seq": 0},
                {"lat": 13.0120, "lng": 77.7030, "command": 5001, "param1": 3.0, "seq": 1},
                {"lat": 13.0140, "lng": 77.7035, "command": 5001, "param1": 3.0, "seq": 2},
                {"lat": 13.0130, "lng": 77.7060, "command": 5001, "param1": 3.0, "seq": 3},
            ],
        }
        with patch.object(fence_service, "upload_fence", return_value={}):
            with patch.object(fence_service, "download_fence", return_value=downloaded):
                result = fence_service.verify_fence(points)
        assert result["success"] is True
        assert result["count"] == 4

    def test_verify_fence_detects_mismatch(self):
        """verify_fence raises when ArduPilot returns different data."""
        from services import fence_service

        points = [
            {"lat": 13.0120, "lng": 77.7030, "command": 5001, "param1": 0, "param2": 0},
            {"lat": 13.0140, "lng": 77.7035, "command": 5001, "param1": 0, "param2": 0},
            {"lat": 13.0130, "lng": 77.7060, "command": 5001, "param1": 0, "param2": 0},
        ]
        downloaded = {
            "success": True,
            "count": 3,
            "points": [
                {"lat": 13.0120, "lng": 77.7030, "command": 5001, "param1": 99.0, "seq": 0},
                {"lat": 13.0140, "lng": 77.7035, "command": 5001, "param1": 3.0, "seq": 1},
                {"lat": 13.0130, "lng": 77.7060, "command": 5001, "param1": 3.0, "seq": 2},
            ],
        }
        with patch.object(fence_service, "upload_fence", return_value={}):
            with patch.object(fence_service, "download_fence", return_value=downloaded):
                with pytest.raises(RuntimeError, match="param1"):
                    fence_service.verify_fence(points)

    def test_verify_fence_count_mismatch(self):
        """verify_fence raises on point count mismatch."""
        from services import fence_service

        points = [
            {"lat": 13.0120, "lng": 77.7030, "command": 5001, "param1": 0, "param2": 0},
            {"lat": 13.0140, "lng": 77.7035, "command": 5001, "param1": 0, "param2": 0},
            {"lat": 13.0130, "lng": 77.7060, "command": 5001, "param1": 0, "param2": 0},
        ]
        downloaded = {"success": True, "count": 2, "points": []}
        with patch.object(fence_service, "upload_fence", return_value={}):
            with patch.object(fence_service, "download_fence", return_value=downloaded):
                with pytest.raises(RuntimeError, match="count mismatch"):
                    fence_service.verify_fence(points)
