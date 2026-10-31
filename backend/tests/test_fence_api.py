"""Tests for fence API endpoints."""

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client():
    """Create a test client."""
    from app import app
    return TestClient(app)


class TestFenceAPI:
    """Test fence upload, download, and clear endpoints."""

    def test_upload_endpoint_exists(self, client):
        """POST /api/fence/upload should exist."""
        # Will fail with 400 (not connected) but endpoint exists
        response = client.post(
            "/api/fence/upload",
            json={"points": []},
        )
        # Should get 400 (not connected) or 500 (error), not 404
        assert response.status_code != 404

    def test_download_endpoint_exists(self, client):
        """POST /api/fence/download should exist."""
        response = client.post("/api/fence/download")
        assert response.status_code != 404

    def test_clear_endpoint_exists(self, client):
        """POST /api/fence/clear should exist."""
        response = client.post("/api/fence/clear")
        assert response.status_code != 404

    def test_upload_empty_fence(self, client):
        """Upload with empty points should fail gracefully."""
        response = client.post(
            "/api/fence/upload",
            json={"points": []},
        )
        # Should not be 404 (endpoint exists)
        assert response.status_code != 404

    def test_upload_invalid_body(self, client):
        """Upload with invalid body should return 422."""
        response = client.post(
            "/api/fence/upload",
            json={"invalid": "data"},
        )
        assert response.status_code == 422

    def test_verify_endpoint_exists(self, client):
        """POST /api/fence/verify should exist."""
        response = client.post(
            "/api/fence/verify",
            json={"points": []},
        )
        assert response.status_code != 404

    def test_verify_invalid_body(self, client):
        """Verify with invalid body should return 422."""
        response = client.post(
            "/api/fence/verify",
            json={"nope": 1},
        )
        assert response.status_code == 422
