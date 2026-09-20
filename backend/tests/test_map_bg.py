"""Tests for map background upload, retrieval, deletion, and map settings."""
import io
import os

import pytest


# Disable slowapi rate-limiting during tests by resetting limiter storage
@pytest.fixture(autouse=True)
def _reset_rate_limiter():
    import routers.map_bg as _mbg
    from main import app
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
    import struct
    import zlib
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


# ---------------------------------------------------------------------------
# SVG sanitizer hardening and delivery headers
# ---------------------------------------------------------------------------

class TestSvgSanitizerHardening:
    """Parser-based SVG sanitization (allowlist)."""

    def _upload_svg(self, client, jwt_headers, tmp_path, monkeypatch, svg: bytes):
        monkeypatch.setattr("shared.file_settings.MAP_BG_DIR", str(tmp_path))
        monkeypatch.setattr("routers.map_bg.MAP_BG_DIR", str(tmp_path))
        return client.post(
            "/api/map-background",
            headers=jwt_headers,
            files={"file": ("bg.svg", io.BytesIO(svg), "image/svg+xml")},
        )

    def test_strips_foreignobject_set_animate_and_style(self, client, jwt_headers, tmp_path, monkeypatch):
        svg = (
            b'<svg xmlns="http://www.w3.org/2000/svg">'
            b'<foreignObject><body xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script></body></foreignObject>'
            b'<set attributeName="x" to="0" begin="click"/>'
            b'<animate attributeName="x" from="0" to="1"/>'
            b'<style>@import url(http://evil.example/x.css);</style>'
            b'<rect width="10" height="10"/>'
            b'</svg>'
        )
        resp = self._upload_svg(client, jwt_headers, tmp_path, monkeypatch, svg)
        assert resp.status_code == 200
        content = open(os.path.join(str(tmp_path), "map-background.svg"), "r").read().lower()
        assert "foreignobject" not in content
        assert "<set" not in content
        assert "<animate" not in content
        assert "<style" not in content
        assert "<rect" in content

    def test_strips_event_handlers_and_script_src(self, client, jwt_headers, tmp_path, monkeypatch):
        svg = (
            b'<svg xmlns="http://www.w3.org/2000/svg" onload="evil()">'
            b'<script src="http://evil.example/x.js"></script>'
            b'<script>alert(1)</script>'
            b'<circle r="10" onclick="evil()"/>'
            b'</svg>'
        )
        resp = self._upload_svg(client, jwt_headers, tmp_path, monkeypatch, svg)
        assert resp.status_code == 200
        content = open(os.path.join(str(tmp_path), "map-background.svg"), "r").read().lower()
        assert "onload" not in content
        assert "onclick" not in content
        assert "<script" not in content
        assert "evil.example" not in content
        assert "<circle" in content

    def test_strips_javascript_uris_and_external_hrefs(self, client, jwt_headers, tmp_path, monkeypatch):
        svg = (
            b'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">'
            b'<use xlink:href="http://evil.example/sprite.svg#icon"/>'
            b'<image href="javascript:alert(1)"/>'
            b'<image href="https://evil.example/track.png"/>'
            b'<use href="#local-symbol"/>'
            b'</svg>'
        )
        resp = self._upload_svg(client, jwt_headers, tmp_path, monkeypatch, svg)
        assert resp.status_code == 200
        content = open(os.path.join(str(tmp_path), "map-background.svg"), "r").read().lower()
        assert "javascript:" not in content
        assert "evil.example" not in content
        assert "#local-symbol" in content

    def test_keeps_data_uri_images(self, client, jwt_headers, tmp_path, monkeypatch):
        svg = (
            b'<svg xmlns="http://www.w3.org/2000/svg">'
            b'<image href="data:image/png;base64,iVBORw0KGgo=" width="1" height="1"/>'
            b'</svg>'
        )
        resp = self._upload_svg(client, jwt_headers, tmp_path, monkeypatch, svg)
        assert resp.status_code == 200
        content = open(os.path.join(str(tmp_path), "map-background.svg"), "r").read()
        assert "data:image/png;base64" in content

    def test_strips_external_css_url_references(self, client, jwt_headers, tmp_path, monkeypatch):
        svg = (
            b'<svg xmlns="http://www.w3.org/2000/svg">'
            b'<rect fill="url(http://evil.example/x.svg#p)" width="10" height="10"/>'
            b'<circle fill="url(#localGradient)" r="5"/>'
            b'</svg>'
        )
        resp = self._upload_svg(client, jwt_headers, tmp_path, monkeypatch, svg)
        assert resp.status_code == 200
        content = open(os.path.join(str(tmp_path), "map-background.svg"), "r").read().lower()
        assert "evil.example" not in content
        assert "url(#localgradient)" in content

    def test_malformed_svg_rejected(self, client, jwt_headers, tmp_path, monkeypatch):
        svg = b'<svg xmlns="http://www.w3.org/2000/svg"><circle r=10/></svg>'  # unquoted attr -> invalid XML
        resp = self._upload_svg(client, jwt_headers, tmp_path, monkeypatch, svg)
        assert resp.status_code == 400
        assert "INVALID_SVG" in resp.text

    def test_non_svg_root_rejected(self, client, jwt_headers, tmp_path, monkeypatch):
        svg = b'<html xmlns="http://www.w3.org/1999/xhtml"><body>x</body></html>'
        resp = self._upload_svg(client, jwt_headers, tmp_path, monkeypatch, svg)
        assert resp.status_code == 400
        assert "INVALID_SVG" in resp.text


class TestMapBackgroundDeliveryHeaders:
    """GET /api/map-background sets hardening headers."""

    def test_get_sets_csp_and_inline_disposition(self, client, jwt_headers, tmp_path, monkeypatch):
        monkeypatch.setattr("shared.file_settings.MAP_BG_DIR", str(tmp_path))
        monkeypatch.setattr("routers.map_bg.MAP_BG_DIR", str(tmp_path))
        resp = client.post(
            "/api/map-background",
            headers=jwt_headers,
            files={"file": ("bg.png", io.BytesIO(_png_bytes()), "image/png")},
        )
        assert resp.status_code == 200

        r = client.get("/api/map-background", headers=jwt_headers)
        assert r.status_code == 200
        assert r.headers.get("content-security-policy") == "script-src 'none'"
        assert r.headers.get("content-disposition", "").startswith("inline")
