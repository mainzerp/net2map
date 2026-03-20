"""Tests for map background upload, retrieval, deletion, and map settings."""
import io
import os
from unittest.mock import patch

import pytest
from database import AuditLog


# Disable slowapi rate-limiting during tests by resetting limiter storage
@pytest.fixture(autouse=True)
def _reset_rate_limiter():
    from main import app
    import routers.map_bg as _mbg
    app.state.limiter.reset()
    _mbg.limiter.reset()
    yield
    app.state.limiter.reset()
    _mbg.limiter.reset()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _png_bytes():
    """Minimal valid PNG (1x1 transparent pixel)."""
    import struct, zlib
    sig = b"\x89PNG\r\n\x1a\n"
    ihdr_data = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
    ihdr_crc = zlib.crc32(b"IHDR" + ihdr_data) & 0xffffffff
    ihdr = struct.pack(">I", 13) + b"IHDR" + ihdr_data + struct.pack(">I", ihdr_crc)
    raw = b"\x00\x00\x00"  # 1 pixel RGB
    deflated = zlib.compress(raw)
    idat_crc = zlib.crc32(b"IDAT" + deflated) & 0xffffffff
    idat = struct.pack(">I", len(deflated)) + b"IDAT" + deflated + struct.pack(">I", idat_crc)
    iend_crc = zlib.crc32(b"IEND") & 0xffffffff
    iend = struct.pack(">I", 0) + b"IEND" + struct.pack(">I", iend_crc)
    return sig + ihdr + idat + iend


# ---------------------------------------------------------------------------
# T3a: Map Background Upload Tests (8 tests)
# ---------------------------------------------------------------------------

class TestMapBackgroundUpload:
    """POST /api/map-background"""

    def test_upload_png_success(self, client, jwt_headers, tmp_path, monkeypatch):
        monkeypatch.setattr("shared.file_settings.MAP_BG_DIR", str(tmp_path))
        monkeypatch.setattr("routers.map_bg.MAP_BG_DIR", str(tmp_path))
        data = _png_bytes()
        resp = client.post(
            "/api/map-background",
            headers=jwt_headers,
            files={"file": ("bg.png", io.BytesIO(data), "image/png")},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["ok"] is True
        assert body["filename"] == "bg.png"
        assert body["size"] == len(data)
        assert os.path.isfile(os.path.join(str(tmp_path), "map-background.png"))

    def test_upload_unsupported_extension_rejected(self, client, jwt_headers):
        resp = client.post(
            "/api/map-background",
            headers=jwt_headers,
            files={"file": ("bg.bmp", io.BytesIO(b"\x00" * 100), "image/bmp")},
        )
        assert resp.status_code == 400
        assert "UNSUPPORTED_FILE_TYPE" in resp.text

    def test_upload_file_too_large(self, client, jwt_headers, monkeypatch):
        monkeypatch.setattr("routers.map_bg.MAX_FILE_SIZE", 10)
        resp = client.post(
            "/api/map-background",
            headers=jwt_headers,
            files={"file": ("bg.png", io.BytesIO(b"\x89PNG" + b"\x00" * 20), "image/png")},
        )
        assert resp.status_code == 400
        assert "FILE_TOO_LARGE" in resp.text

    def test_upload_invalid_image_magic_bytes(self, client, jwt_headers, tmp_path, monkeypatch):
        monkeypatch.setattr("shared.file_settings.MAP_BG_DIR", str(tmp_path))
        monkeypatch.setattr("routers.map_bg.MAP_BG_DIR", str(tmp_path))
        resp = client.post(
            "/api/map-background",
            headers=jwt_headers,
            files={"file": ("bg.png", io.BytesIO(b"not-an-image"), "image/png")},
        )
        assert resp.status_code == 400
        assert "UNSUPPORTED_IMAGE_TYPE" in resp.text

    def test_upload_svg_sanitized(self, client, jwt_headers, tmp_path, monkeypatch):
        monkeypatch.setattr("shared.file_settings.MAP_BG_DIR", str(tmp_path))
        monkeypatch.setattr("routers.map_bg.MAP_BG_DIR", str(tmp_path))
        svg = b'<svg xmlns="http://www.w3.org/2000/svg"><circle r="10"/></svg>'
        resp = client.post(
            "/api/map-background",
            headers=jwt_headers,
            files={"file": ("bg.svg", io.BytesIO(svg), "image/svg+xml")},
        )
        assert resp.status_code == 200
        assert resp.json()["ok"] is True
        saved = os.path.join(str(tmp_path), "map-background.svg")
        assert os.path.isfile(saved)

    def test_upload_svg_script_tags_stripped(self, client, jwt_headers, tmp_path, monkeypatch):
        monkeypatch.setattr("shared.file_settings.MAP_BG_DIR", str(tmp_path))
        monkeypatch.setattr("routers.map_bg.MAP_BG_DIR", str(tmp_path))
        svg = (
            b'<svg xmlns="http://www.w3.org/2000/svg">'
            b'<script>alert("xss")</script>'
            b'<circle r="10" onclick="evil()"/>'
            b'</svg>'
        )
        resp = client.post(
            "/api/map-background",
            headers=jwt_headers,
            files={"file": ("bg.svg", io.BytesIO(svg), "image/svg+xml")},
        )
        assert resp.status_code == 200
        saved = os.path.join(str(tmp_path), "map-background.svg")
        content = open(saved, "r").read()
        assert "<script" not in content.lower()
        assert "onclick" not in content.lower()


class TestMapBackgroundGet:
    """GET /api/map-background"""

    def test_get_returns_404_when_no_image(self, client, jwt_headers, tmp_path, monkeypatch):
        monkeypatch.setattr("shared.file_settings.MAP_BG_DIR", str(tmp_path))
        resp = client.get("/api/map-background", headers=jwt_headers)
        assert resp.status_code == 404
        assert "NO_BACKGROUND_IMAGE" in resp.text


class TestMapBackgroundDelete:
    """DELETE /api/map-background"""

    def test_delete_removes_background(self, client, jwt_headers, tmp_path, monkeypatch):
        monkeypatch.setattr("shared.file_settings.MAP_BG_DIR", str(tmp_path))
        monkeypatch.setattr("routers.map_bg.MAP_BG_DIR", str(tmp_path))
        # create a dummy file
        dummy = os.path.join(str(tmp_path), "map-background.png")
        with open(dummy, "wb") as f:
            f.write(b"\x00")
        resp = client.delete("/api/map-background", headers=jwt_headers)
        assert resp.status_code == 200
        assert resp.json()["ok"] is True
        assert not os.path.isfile(dummy)


# ---------------------------------------------------------------------------
# Map Settings
# ---------------------------------------------------------------------------

class TestMapSettings:
    """GET/PUT /api/map-settings"""

    def test_get_map_settings_defaults(self, client, jwt_headers):
        resp = client.get("/api/map-settings", headers=jwt_headers)
        assert resp.status_code == 200
        data = resp.json()
        assert "opacity" in data
        assert "scale" in data
        assert "bg_color" in data

    def test_update_map_settings(self, client, jwt_headers):
        resp = client.put(
            "/api/map-settings",
            headers=jwt_headers,
            json={"opacity": 0.5, "scale": 2.0, "bg_color": "#ffffff"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["opacity"] == 0.5
        assert data["scale"] == 2.0
        assert data["bg_color"] == "#ffffff"

    def test_viewer_cannot_update_map_settings(self, client, viewer_jwt_headers):
        resp = client.put(
            "/api/map-settings",
            headers=viewer_jwt_headers,
            json={"opacity": 0.5},
        )
        assert resp.status_code == 403
