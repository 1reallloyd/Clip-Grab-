from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

import main

client = TestClient(main.app)


@pytest.fixture(autouse=True)
def reset_state(monkeypatch):
    main.rate_limiter.reset()
    monkeypatch.setenv("BLOCKED_DOMAINS", "blocked.example.com,restricted.org")
    monkeypatch.setattr(main, "RATE_LIMIT_PER_MIN", 10)
    monkeypatch.setattr(main, "MAX_DURATION_SEC", 3600)


def test_health():
    res = client.get("/api/health")
    assert res.status_code == 200
    assert res.json() == {"ok": True}
    assert res.headers.get("x-content-type-options") == "nosniff"
    assert "content-security-policy" in res.headers


def test_sites_cached():
    with patch("main.yt_dlp.extractor.gen_extractor_classes") as mock_gen:
        e1 = MagicMock()
        e1.IE_NAME = "Vimeo"
        e2 = MagicMock()
        e2.IE_NAME = "Soundcloud"
        e3 = MagicMock()
        e3.IE_NAME = "generic"
        e4 = MagicMock()
        e4.IE_NAME = "youtube"
        mock_gen.return_value = [e1, e2, e3, e4]
        main.get_cached_sites.cache_clear()

        res = client.get("/api/sites")
        assert res.status_code == 200
        data = res.json()
        assert {"name": "Vimeo"} in data
        assert {"name": "Soundcloud"} in data
        assert {"name": "generic"} not in data
        assert {"name": "youtube"} not in data


@pytest.mark.parametrize(
    "bad_url",
    [
        "",
        "not-a-url",
        "file:///etc/passwd",
        "ftp://example.com/video.mp4",
        "javascript:alert(1)",
        "https://user:pass@example.com/video.mp4",
        "http://localhost/video.mp4",
        "http://127.0.0.1/video.mp4",
        "http://169.254.169.254/latest/meta-data/",
        "http://10.0.0.5/internal.mp4",
        "http://192.168.1.10/cam.mp4",
        "http://[::1]/video.mp4",
    ],
)
def test_url_validation_and_ssrf_literals(bad_url):
    res = client.post("/api/info", json={"url": bad_url})
    assert res.status_code in (400, 422)


def test_ssrf_dns_resolution_blocks_private_ip():
    with patch("main.socket.getaddrinfo") as mock_dns:
        mock_dns.return_value = [(2, 1, 6, "", ("10.20.30.40", 443))]
        res = client.post("/api/info", json={"url": "https://evil-rebind.example.net/v"})
        assert res.status_code == 400


def test_blocked_domain_returns_403():
    for url in (
        "https://blocked.example.com/watch?v=1",
        "https://sub.restricted.org/video/42",
        "https://youtube.com/excluded",
        "https://youtu.be/excluded",
    ):
        res = client.post("/api/info", json={"url": url})
        assert res.status_code == 403


def test_rate_limit_returns_429(monkeypatch):
    monkeypatch.setattr(main, "RATE_LIMIT_PER_MIN", 3)
    with patch("main.socket.getaddrinfo") as mock_dns, patch("main.extract_media_info") as mock_info:
        mock_dns.return_value = [(2, 1, 6, "", ("93.184.216.34", 443))]
        mock_info.return_value = {
            "title": "Sample",
            "thumbnail": None,
            "duration": 60,
            "uploader": "Creator",
            "site": "Example",
            "options": ["720p", "mp3"],
        }
        for _ in range(3):
            r = client.post("/api/info", json={"url": "https://example.com/video"})
            assert r.status_code == 200
        r4 = client.post("/api/info", json={"url": "https://example.com/video"})
        assert r4.status_code == 429


def test_duration_over_limit_returns_413():
    mock_ydl_instance = MagicMock()
    mock_ydl_instance.extract_info.return_value = {
        "title": "Long Stream",
        "duration": 4000,
        "formats": [{"vcodec": "avc1", "acodec": "mp4a", "height": 720}],
    }
    mock_ydl_cm = MagicMock()
    mock_ydl_cm.__enter__.return_value = mock_ydl_instance

    with patch("main.socket.getaddrinfo") as mock_dns, patch("main.yt_dlp.YoutubeDL", return_value=mock_ydl_cm):
        mock_dns.return_value = [(2, 1, 6, "", ("93.184.216.34", 443))]
        res = client.post("/api/info", json={"url": "https://example.com/long"})
        assert res.status_code == 413


def test_preset_selection_filters_by_source_formats():
    # Source only supports 720p max video + audio -> should NOT offer 1080p
    info_720 = {
        "formats": [
            {"vcodec": "avc1", "acodec": "none", "height": 720},
            {"vcodec": "avc1", "acodec": "none", "height": 480},
            {"vcodec": "none", "acodec": "mp4a"},
        ]
    }
    assert main.compute_supported_options(info_720) == ["720p", "480p", "mp3"]

    # Audio-only source -> only mp3
    info_audio = {
        "formats": [
            {"vcodec": "none", "acodec": "opus"},
        ]
    }
    assert main.compute_supported_options(info_audio) == ["mp3"]


def test_download_streams_and_cleans_up_temp_dir(tmp_path):
    temp_dir = tmp_path / "req_tmp"
    temp_dir.mkdir()
    media_file = temp_dir / "media.mp4"
    media_file.write_bytes(b"FAKE_MP4_BYTES")

    with (
        patch("main.socket.getaddrinfo") as mock_dns,
        patch("main.run_download_to_temp", return_value=(str(temp_dir), str(media_file), "Sample_Video.mp4", "video/mp4")),
    ):
        mock_dns.return_value = [(2, 1, 6, "", ("93.184.216.34", 443))]
        res = client.get("/api/download", params={"url": "https://example.com/v", "quality": "720p"})
        assert res.status_code == 200
        assert res.content == b"FAKE_MP4_BYTES"
        assert "attachment;" in res.headers.get("content-disposition", "")
        assert "Sample_Video.mp4" in res.headers.get("content-disposition", "")
        # Background task must delete temp_dir
        assert not Path(temp_dir).exists()
