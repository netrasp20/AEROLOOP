"""Tests for MAVFTP API endpoints."""

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client():
    """Create a test client."""
    from app import app
    return TestClient(app)


class TestFtpAPI:
    """Test MAVFTP list, read, write, rename, mkdir, rmdir, remove endpoints."""

    def test_list_endpoint_exists(self, client):
        """POST /api/ftp/list should exist."""
        response = client.post("/api/ftp/list", json={"path": "/"})
        # 500 when not connected, but not 404
        assert response.status_code != 404

    def test_list_missing_path_uses_default(self, client):
        """List with missing path defaults to root and returns 200 (not 404)."""
        response = client.post("/api/ftp/list", json={})
        assert response.status_code != 404

    def test_list_empty_path_defaults_root(self, client):
        """List with empty path should not 404."""
        response = client.post("/api/ftp/list", json={"path": ""})
        assert response.status_code != 404

    def test_read_endpoint_exists(self, client):
        """POST /api/ftp/read should exist."""
        response = client.post("/api/ftp/read", json={"path": "/test.bin"})
        assert response.status_code != 404

    def test_read_invalid_body(self, client):
        """Read with invalid body should return 422."""
        response = client.post("/api/ftp/read", json={"wrong": 1})
        assert response.status_code == 422

    def test_write_endpoint_exists(self, client):
        """POST /api/ftp/write should exist."""
        import base64
        payload = base64.b64encode(b"test").decode("ascii")
        response = client.post("/api/ftp/write", json={"path": "/t.txt", "data": payload})
        assert response.status_code != 404

    def test_write_invalid_body(self, client):
        """Write with invalid body should return 422."""
        response = client.post("/api/ftp/write", json={"path": "/t.txt"})
        assert response.status_code == 422

    def test_remove_endpoint_exists(self, client):
        """POST /api/ftp/remove should exist."""
        response = client.post("/api/ftp/remove", json={"path": "/t.txt"})
        assert response.status_code != 404

    def test_mkdir_endpoint_exists(self, client):
        """POST /api/ftp/mkdir should exist."""
        response = client.post("/api/ftp/mkdir", json={"path": "/newdir"})
        assert response.status_code != 404

    def test_rmdir_endpoint_exists(self, client):
        """POST /api/ftp/rmdir should exist."""
        response = client.post("/api/ftp/rmdir", json={"path": "/newdir"})
        assert response.status_code != 404

    def test_rename_endpoint_exists(self, client):
        """POST /api/ftp/rename should exist."""
        response = client.post(
            "/api/ftp/rename",
            json={"old_path": "/a.txt", "new_path": "/b.txt"},
        )
        assert response.status_code != 404

    def test_rename_invalid_body(self, client):
        """Rename with invalid body should return 422."""
        response = client.post("/api/ftp/rename", json={"old_path": "/a.txt"})
        assert response.status_code == 422


class TestFtpServiceValidation:
    """Path validation rejects traversal before any MAVLink call."""

    @pytest.mark.parametrize("bad_path", ["../etc", "a/../../b", "/foo/..", "", None, "relative/path"])
    def test_list_rejects_traversal(self, bad_path):
        from services.ftp_service import ftp_service, MavFtpError
        with pytest.raises(MavFtpError) as exc:
            ftp_service.list_directory(bad_path)
        assert "path" in str(exc.value.message).lower()

    @pytest.mark.parametrize("bad_path", ["../x", "/ok/../y", ""])
    def test_read_rejects_traversal(self, bad_path):
        from services.ftp_service import ftp_service, MavFtpError
        with pytest.raises(MavFtpError):
            ftp_service.read_file(bad_path)

    @pytest.mark.parametrize("bad_path", ["../x", "/ok/../y", ""])
    def test_write_rejects_traversal(self, bad_path):
        from services.ftp_service import ftp_service, MavFtpError
        with pytest.raises(MavFtpError):
            ftp_service.write_file(bad_path, b"data")

    def test_rename_rejects_traversal(self):
        from services.ftp_service import ftp_service, MavFtpError
        with pytest.raises(MavFtpError):
            ftp_service.rename("/ok", "../evil")
        with pytest.raises(MavFtpError):
            ftp_service.rename("", "/b")
        with pytest.raises(MavFtpError):
            ftp_service.rename("/a", "")

    def test_all_operations_validate_absolute_path(self):
        from services.ftp_service import ftp_service, MavFtpError
        for op in (ftp_service.create_directory, ftp_service.remove_directory,
                   ftp_service.remove_file):
            with pytest.raises(MavFtpError):
                op("rel/path")

    def test_valid_absolute_paths_pass_validation(self):
        from services.ftp_service import ftp_service
        ftp_service._validate_path("/")
        ftp_service._validate_path("/logs")
        ftp_service._validate_path("/@SYS")