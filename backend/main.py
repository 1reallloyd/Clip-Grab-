"""
ClipGrab FastAPI Backend (Phase 2)
--------------------------------
Production-ready media inspection and ephemeral download service using:
- FastAPI + Uvicorn
- yt-dlp (single-video extractor, noplaylist)
- FFmpeg (MP4 muxing and 192 kbps MP3 extraction)
- Strict SSRF, domain blocklist, per-IP rate limiting, and security headers
"""

from __future__ import annotations

import ipaddress
import json
import logging
import os
import re
import shutil
import socket
import tempfile
import threading
import time
import uuid
from collections import defaultdict, deque
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlparse

import yt_dlp
from fastapi import BackgroundTasks, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# Configuration (via environment variables)
# ---------------------------------------------------------------------------
RATE_LIMIT_PER_MIN = max(1, int(os.getenv("RATE_LIMIT_PER_MIN", "10")))
MAX_DURATION_SEC = max(1, int(os.getenv("MAX_DURATION_SEC", "3600")))
MAX_FILE_SIZE_MB = max(1, int(os.getenv("MAX_FILE_SIZE_MB", "500")))
MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024
SOCKET_TIMEOUT_SEC = 15
ALLOWED_ORIGIN = os.getenv("ALLOWED_ORIGIN", "").strip()
STATIC_DIR = Path(os.getenv("STATIC_DIR", str(Path(__file__).resolve().parent.parent / "dist")))
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()

QualityPreset = Literal["1080p", "720p", "480p", "mp3"]
VALID_QUALITIES: tuple[QualityPreset, ...] = ("1080p", "720p", "480p", "mp3")


def get_blocked_domains() -> set[str]:
    raw = os.getenv("BLOCKED_DOMAINS", "")
    return {
        item.strip().lower().lstrip(".")
        for item in raw.split(",")
        if item.strip()
    }


# ---------------------------------------------------------------------------
# Structured Safe Logging (never logs full URLs with tokens/query strings)
# ---------------------------------------------------------------------------
class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": int(time.time()),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        if hasattr(record, "extra_fields"):
            payload.update(getattr(record, "extra_fields"))
        return json.dumps(payload, ensure_ascii=False)


logger = logging.getLogger("clipgrab")
logger.setLevel(getattr(logging, LOG_LEVEL, logging.INFO))
if not logger.handlers:
    _handler = logging.StreamHandler()
    _handler.setFormatter(JsonFormatter())
    logger.addHandler(_handler)


def redact_url(raw_url: str) -> str:
    """Strip query params, tokens, and fragments before logging."""
    try:
        parsed = urlparse(raw_url)
        return f"{parsed.scheme}://{parsed.hostname or ''}{parsed.path}"
    except Exception:
        return "[invalid-url]"


# ---------------------------------------------------------------------------
# Metrics (Prometheus text exposition compatible)
# ---------------------------------------------------------------------------
_metrics_lock = threading.Lock()
_metrics: dict[str, int] = defaultdict(int)


def inc_metric(name: str) -> None:
    with _metrics_lock:
        _metrics[name] += 1


# ---------------------------------------------------------------------------
# SSRF & URL Validation
# ---------------------------------------------------------------------------
def is_disallowed_ip(ip_str: str) -> bool:
    """Reject private, loopback, link-local, multicast, reserved, or unspecified IPs."""
    clean_ip = ip_str.split("%")[0].strip()
    try:
        addr = ipaddress.ip_address(clean_ip)
    except ValueError:
        return True

    # Handle IPv4-mapped IPv6 addresses (e.g. ::ffff:127.0.0.1)
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped:
        addr = addr.ipv4_mapped

    return bool(
        addr.is_private
        or addr.is_loopback
        or addr.is_link_local
        or addr.is_multicast
        or addr.is_reserved
        or addr.is_unspecified
        or not addr.is_global
    )


EXCLUDED_DOMAINS = ("youtube.com", "youtu.be", "youtube-nocookie.com", "youtubekids.com")


def is_excluded_domain(hostname: str) -> bool:
    host = hostname.lower().rstrip(".")
    return any(host == d or host.endswith(f".{d}") for d in EXCLUDED_DOMAINS)


def is_domain_blocked(hostname: str) -> bool:
    host = hostname.lower().rstrip(".")
    for blocked in get_blocked_domains():
        if host == blocked or host.endswith(f".{blocked}"):
            return True
    return False


def validate_and_resolve_url(raw_url: str) -> str:
    """Validate URL scheme, blocklist, and DNS resolution against SSRF."""
    if not raw_url or not isinstance(raw_url, str) or len(raw_url) > 2048:
        raise HTTPException(status_code=400, detail="A valid http:// or https:// URL is required.")

    candidate = raw_url.strip()
    parsed = urlparse(candidate)
    if parsed.scheme not in ("http", "https"):
        raise HTTPException(status_code=400, detail="Only http:// and https:// URLs are accepted.")

    if not parsed.hostname:
        raise HTTPException(status_code=400, detail="URL is missing a valid hostname.")

    if parsed.username or parsed.password:
        raise HTTPException(status_code=400, detail="Embedded URL credentials are not permitted.")

    hostname = parsed.hostname.lower().rstrip(".")
    if hostname == "localhost" or hostname.endswith(".localhost") or hostname.endswith(".local"):
        raise HTTPException(status_code=400, detail="Localhost and internal hostnames are blocked.")

    if is_excluded_domain(hostname):
        raise HTTPException(status_code=403, detail="This domain is not supported by this service.")

    if is_domain_blocked(hostname):
        raise HTTPException(status_code=403, detail="This domain is blocked by policy or takedown.")

    # Direct IP literal check
    try:
        ipaddress.ip_address(hostname)
        if is_disallowed_ip(hostname):
            raise HTTPException(status_code=400, detail="Private or reserved IP addresses are not permitted.")
        return candidate
    except ValueError:
        pass

    # DNS resolution check (IPv4 + IPv6)
    try:
        addr_infos = socket.getaddrinfo(hostname, parsed.port or (443 if parsed.scheme == "https" else 80))
    except socket.gaierror as exc:
        raise HTTPException(status_code=422, detail="Unable to resolve host for the provided URL.") from exc

    resolved_ips = {info[4][0] for info in addr_infos if info and len(info) >= 5 and info[4]}
    if not resolved_ips or any(is_disallowed_ip(ip) for ip in resolved_ips):
        raise HTTPException(
            status_code=400,
            detail="Target hostname resolves to a disallowed private, loopback, or reserved IP.",
        )

    return candidate


# ---------------------------------------------------------------------------
# Per-IP Rate Limiter (sliding 60-second window)
# Note: For multi-worker production deployments, replace with Redis INCR/EXPIRE
# or an edge/reverse-proxy limiter (NGINX/Cloudflare).
# ---------------------------------------------------------------------------
class InMemoryRateLimiter:
    def __init__(self) -> None:
        self._buckets: dict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def check(self, client_ip: str, limit_per_min: int) -> None:
        now = time.monotonic()
        cutoff = now - 60.0
        with self._lock:
            q = self._buckets[client_ip]
            while q and q[0] <= cutoff:
                q.popleft()
            if len(q) >= limit_per_min:
                raise HTTPException(
                    status_code=429,
                    detail=f"Rate limit exceeded ({limit_per_min} requests per minute).",
                )
            q.append(now)

    def reset(self) -> None:
        with self._lock:
            self._buckets.clear()


rate_limiter = InMemoryRateLimiter()


def get_client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


# ---------------------------------------------------------------------------
# Preset Selection & yt-dlp Helpers
# ---------------------------------------------------------------------------
VIDEO_EXTS = {"mp4", "webm", "mov", "mkv", "m4v", "avi", "flv"}
AUDIO_EXTS = {"mp3", "m4a", "aac", "opus", "ogg", "wav", "flac"}
YTDLP_COOKIES_FILE = os.getenv("YTDLP_COOKIES_FILE", "").strip()
YTDLP_COOKIES_CONTENT = os.getenv("YTDLP_COOKIES_CONTENT", "").strip()
_INLINE_COOKIES_PATH: str | None = None


def resolve_cookies_file() -> str | None:
    global _INLINE_COOKIES_PATH
    if YTDLP_COOKIES_FILE and Path(YTDLP_COOKIES_FILE).is_file():
        return YTDLP_COOKIES_FILE
    if YTDLP_COOKIES_CONTENT:
        if _INLINE_COOKIES_PATH and Path(_INLINE_COOKIES_PATH).is_file():
            return _INLINE_COOKIES_PATH
        try:
            fd, tmp_path = tempfile.mkstemp(prefix="clipgrab_cookies_", suffix=".txt")
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(YTDLP_COOKIES_CONTENT)
            os.chmod(tmp_path, 0o600)
            _INLINE_COOKIES_PATH = tmp_path
            return tmp_path
        except Exception:
            return None
    return None


def get_vimeo_fallback(url: str) -> tuple[str, dict[str, str]] | None:
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if host in ("vimeo.com", "www.vimeo.com"):
        m = re.search(r"/(\d+)(?:/|$)", parsed.path)
        if m:
            return (
                f"https://player.vimeo.com/video/{m.group(1)}",
                {"Referer": "https://vimeo.com/"},
            )
    return None


def compute_supported_options(info: dict[str, Any]) -> list[QualityPreset]:
    """
    Only offer quality presets that the source actually supports:
    - 1080p / 720p / 480p for video heights >= threshold (or closest available <= target)
    - mp3 if any audio or video+audio stream is available
    """
    formats = info.get("formats") or []
    video_heights: list[int] = []
    has_audio = False
    has_video = False

    for fmt in formats:
        vcodec = fmt.get("vcodec")
        acodec = fmt.get("acodec")
        height = fmt.get("height")
        ext = str(fmt.get("ext") or "").lower()
        video_ext = str(fmt.get("video_ext") or "").lower()
        audio_ext = str(fmt.get("audio_ext") or "").lower()

        is_vid = (
            (vcodec and vcodec != "none")
            or (video_ext and video_ext != "none")
            or ext in VIDEO_EXTS
        )
        is_aud = (
            (acodec and acodec != "none")
            or (audio_ext and audio_ext != "none")
            or ext in AUDIO_EXTS
        )

        if is_vid:
            has_video = True
            if isinstance(height, (int, float)) and height > 0:
                video_heights.append(int(height))
        if is_aud:
            has_audio = True

    # Handle single-format entries where formats[] may be omitted
    if not formats:
        ext = str(info.get("ext") or "").lower()
        if info.get("vcodec") not in (None, "none") or ext in VIDEO_EXTS:
            has_video = True
            if isinstance(info.get("height"), (int, float)):
                video_heights.append(int(info["height"]))
        if info.get("acodec") not in (None, "none") or ext in AUDIO_EXTS:
            has_audio = True

    options: list[QualityPreset] = []
    if has_video:
        max_h = max(video_heights) if video_heights else 0
        if max_h >= 1080:
            options.append("1080p")
        if max_h >= 720:
            options.append("720p")
        if max_h >= 480 or (max_h > 0 and not options):
            options.append("480p")
        if not video_heights:
            options.extend(["720p", "480p"])

    if has_audio or has_video:
        options.append("mp3")

    return options


def _sanitize_ytdlp_msg(raw: str) -> str | None:
    lines = [ln.strip() for ln in raw.splitlines() if ln.strip()]
    err_line = next((ln for ln in lines if ln.lower().startswith("error:")), lines[0] if lines else "")
    if not err_line:
        return None
    cleaned = re.sub(r"^ERROR:\s*(\[[^\]]+\]\s*([^:]+:\s*)?)?", "", err_line, flags=re.I)
    cleaned = re.sub(r"https?://[^\s)]+", lambda m: redact_url(m.group(0)), cleaned)
    cleaned = re.sub(r"Use --cookies-from-browser[\s\S]*$", "", cleaned, flags=re.I)
    cleaned = re.sub(r"please report this issue[\s\S]*$", "", cleaned, flags=re.I)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    if len(cleaned) < 6:
        return None
    return f"{cleaned[:217]}..." if len(cleaned) > 220 else cleaned


def map_ytdlp_error(exc: Exception) -> HTTPException:
    raw = str(exc)
    msg = raw.lower()
    if "sign in to confirm" in msg or "not a bot" in msg:
        return HTTPException(
            status_code=422,
            detail="Platform requested bot/sign-in verification from this IP. Configure YTDLP_COOKIES_FILE or YTDLP_COOKIES_CONTENT if needed.",
        )
    if "impersonate" in msg:
        return HTTPException(
            status_code=422,
            detail="This platform requires browser TLS impersonation not supported in automated extraction.",
        )
    if "drm" in msg or "widevine" in msg or "fairplay" in msg or "encrypted" in msg:
        return HTTPException(status_code=422, detail="DRM-protected or encrypted media cannot be downloaded.")
    if "age-restricted" in msg or "confirm your age" in msg:
        return HTTPException(
            status_code=422,
            detail="Age-restricted media requires authenticated cookies (YTDLP_COOKIES_FILE).",
        )
    if (
        "private" in msg
        or "sign in" in msg
        or "logged-in" in msg
        or "logged in" in msg
        or "login" in msg
        or "members-only" in msg
        or "authentication" in msg
    ):
        return HTTPException(status_code=422, detail="Media is private or requires platform sign-in / cookies.")
    if "not available in your country" in msg or "geo" in msg or "blocked it in your country" in msg:
        return HTTPException(status_code=422, detail="Media is geo-restricted or unavailable in this region.")
    if "filesize" in msg or "file is larger than max-filesize" in msg:
        return HTTPException(status_code=413, detail=f"File exceeds {MAX_FILE_SIZE_MB} MB limit.")
    if "http error 429" in msg or "too many requests" in msg:
        return HTTPException(status_code=429, detail="Upstream platform temporarily rate-limited requests.")
    if "http error 403" in msg or "403 forbidden" in msg:
        return HTTPException(status_code=422, detail="Upstream media host returned HTTP 403 Forbidden.")
    if "http error 404" in msg or "video unavailable" in msg:
        return HTTPException(status_code=422, detail="Video was removed, made private, or returned HTTP 404.")
    if "unsupported url" in msg or "no suitable" in msg:
        return HTTPException(status_code=422, detail="Unsupported URL or unavailable media format.")
    if "no video formats found" in msg or "no formats found" in msg:
        return HTTPException(
            status_code=422,
            detail="No downloadable video or audio streams were found at this link. Make sure the URL points directly to a public video or audio post.",
        )
    sanitized = _sanitize_ytdlp_msg(raw)
    if sanitized:
        return HTTPException(status_code=422, detail=sanitized)
    return HTTPException(status_code=422, detail="Unable to read or extract media from this link.")


def sanitize_filename(title: str, ext: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9._-]+", "_", title).strip("._-")
    cleaned = cleaned[:80] or "clipgrab_media"
    return f"{cleaned}.{ext}"


def extract_media_info(url: str) -> dict[str, Any]:
    ydl_opts: dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "socket_timeout": SOCKET_TIMEOUT_SEC,
        "skip_download": True,
    }
    cookies_file = resolve_cookies_file()
    if cookies_file:
        ydl_opts["cookiefile"] = cookies_file
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
    except HTTPException:
        raise
    except Exception as exc:
        fallback = get_vimeo_fallback(url)
        err_lower = str(exc).lower()
        if fallback and ("logged-in" in err_lower or "login" in err_lower or "cookies" in err_lower):
            fb_url, fb_headers = fallback
            fb_opts = {**ydl_opts, "http_headers": fb_headers}
            try:
                with yt_dlp.YoutubeDL(fb_opts) as ydl:
                    info = ydl.extract_info(fb_url, download=False)
            except Exception as fb_exc:
                raise map_ytdlp_error(fb_exc) from fb_exc
        else:
            raise map_ytdlp_error(exc) from exc

    if not info:
        raise HTTPException(status_code=422, detail="No media metadata returned for this URL.")

    # Reject playlists if an extractor returned a playlist object despite noplaylist
    if info.get("_type") == "playlist" and info.get("entries"):
        entries = list(info["entries"])
        if not entries:
            raise HTTPException(status_code=422, detail="Empty or unreadable playlist.")
        info = entries[0]

    duration_raw = info.get("duration")
    duration = int(round(duration_raw)) if isinstance(duration_raw, (int, float)) else None
    if duration is not None and duration > MAX_DURATION_SEC:
        raise HTTPException(
            status_code=413,
            detail=f"Media duration ({duration}s) exceeds maximum allowed ({MAX_DURATION_SEC}s).",
        )

    options = compute_supported_options(info)
    if not options:
        raise HTTPException(status_code=422, detail="No compatible video or audio streams found.")

    return {
        "title": str(info.get("title") or "Untitled media"),
        "thumbnail": info.get("thumbnail") or None,
        "duration": duration,
        "uploader": info.get("uploader") or info.get("channel") or None,
        "site": str(info.get("extractor_key") or info.get("extractor") or urlparse(url).hostname),
        "options": options,
    }


def build_download_opts(quality: QualityPreset, temp_dir: str, progress_hook: Any = None) -> dict[str, Any]:
    outtmpl = os.path.join(temp_dir, "media.%(ext)s")
    opts: dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "socket_timeout": SOCKET_TIMEOUT_SEC,
        "max_filesize": MAX_FILE_SIZE_BYTES,
        "concurrent_fragment_downloads": 8,
        "outtmpl": outtmpl,
        "restrictfilenames": True,
    }
    if progress_hook is not None:
        opts["progress_hooks"] = [progress_hook]

    if quality == "mp3":
        opts["format"] = "ba/b"
        opts["postprocessors"] = [
            {
                "key": "FFmpegExtractAudio",
                "preferredcodec": "mp3",
                "preferredquality": "192",
            }
        ]
    else:
        height = quality.rstrip("p")
        opts["format"] = (
            f"bv*[height<={height}][ext=mp4]+ba[ext=m4a]"
            f"/b[height<={height}][ext=mp4]"
            f"/bv*[height<={height}]+ba/b[height<={height}]/b"
        )
        opts["merge_output_format"] = "mp4"

    cookies_file = resolve_cookies_file()
    if cookies_file:
        opts["cookiefile"] = cookies_file

    return opts


def run_download_to_temp(url: str, quality: QualityPreset, progress_hook: Any = None) -> tuple[str, str, str, str]:
    """
    Downloads and muxes/transcodes into an isolated per-request temporary directory.
    Returns (temp_dir, file_path, clean_filename, media_type).
    Guarantees temp_dir cleanup if an exception is raised.
    """
    temp_dir = tempfile.mkdtemp(prefix="clipgrab_")
    try:
        opts = build_download_opts(quality, temp_dir, progress_hook=progress_hook)
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(url, download=True)
        except Exception as exc:
            fallback = get_vimeo_fallback(url)
            err_lower = str(exc).lower()
            if fallback and ("logged-in" in err_lower or "login" in err_lower or "cookies" in err_lower):
                fb_url, fb_headers = fallback
                with yt_dlp.YoutubeDL({**opts, "http_headers": fb_headers}) as ydl:
                    info = ydl.extract_info(fb_url, download=True)
            else:
                raise

        if not info:
            raise HTTPException(status_code=422, detail="Failed to download media.")

        duration_raw = info.get("duration")
        if isinstance(duration_raw, (int, float)) and duration_raw > MAX_DURATION_SEC:
            raise HTTPException(
                status_code=413,
                detail=f"Media duration exceeds maximum allowed ({MAX_DURATION_SEC}s).",
            )

        ext = "mp3" if quality == "mp3" else "mp4"
        candidates = sorted(
            Path(temp_dir).glob("*"),
            key=lambda p: p.stat().st_size if p.is_file() else 0,
            reverse=True,
        )
        file_path = next(
            (p for p in candidates if p.is_file() and not p.name.endswith(".part")),
            None,
        )
        if not file_path:
            raise HTTPException(status_code=422, detail="Extraction produced no output file.")

        if file_path.stat().st_size > MAX_FILE_SIZE_BYTES:
            raise HTTPException(status_code=413, detail=f"File exceeds {MAX_FILE_SIZE_MB} MB limit.")

        clean_name = sanitize_filename(str(info.get("title") or "clipgrab_media"), ext)
        media_type = "audio/mpeg" if quality == "mp3" else "video/mp4"
        return temp_dir, str(file_path), clean_name, media_type
    except HTTPException:
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise
    except Exception as exc:
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise map_ytdlp_error(exc) from exc


def cleanup_directory(path_str: str) -> None:
    shutil.rmtree(path_str, ignore_errors=True)


# ---------------------------------------------------------------------------
# Supported Sites Cache (built from yt-dlp's extractor registry)
# ---------------------------------------------------------------------------
@lru_cache(maxsize=1)
def get_cached_sites() -> list[dict[str, str]]:
    sites: list[dict[str, str]] = []
    seen: set[str] = set()
    for cls in yt_dlp.extractor.gen_extractor_classes():
        ie_name = getattr(cls, "IE_NAME", None)
        if not ie_name or ie_name == "generic" or ":" in ie_name:
            continue
        display_name = ie_name.strip()
        lower = display_name.lower()
        if lower == "youtube" or lower.startswith("youtube") or lower == "youtu.be":
            continue
        if lower not in seen:
            seen.add(lower)
            sites.append({"name": display_name})
    sites.sort(key=lambda item: item["name"].lower())
    return sites


# ---------------------------------------------------------------------------
# Optional Async Job Queue (Production Upgrade: POST /api/jobs -> GET /api/jobs/{id})
# Designed for easy replacement with Celery / RQ + Redis.
# ---------------------------------------------------------------------------
class JobRecord(BaseModel):
    id: str
    status: Literal["queued", "running", "completed", "failed"]
    progress: int = 0
    quality: QualityPreset
    filename: str | None = None
    error: str | None = None
    error_code: int | None = None


_jobs: dict[str, dict[str, Any]] = {}
_jobs_lock = threading.Lock()


def _run_job_worker(job_id: str, url: str, quality: QualityPreset) -> None:
    with _jobs_lock:
        if job_id in _jobs:
            _jobs[job_id]["status"] = "running"

    def on_progress(d: dict[str, Any]) -> None:
        if d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            downloaded = d.get("downloaded_bytes") or 0
            pct = int(min(95, (downloaded / total) * 100)) if total else 50
            with _jobs_lock:
                if job_id in _jobs:
                    _jobs[job_id]["progress"] = pct

    try:
        temp_dir, file_path, clean_name, media_type = run_download_to_temp(
            url, quality, progress_hook=on_progress
        )
        with _jobs_lock:
            _jobs[job_id].update(
                {
                    "status": "completed",
                    "progress": 100,
                    "temp_dir": temp_dir,
                    "file_path": file_path,
                    "filename": clean_name,
                    "media_type": media_type,
                }
            )
    except HTTPException as exc:
        with _jobs_lock:
            _jobs[job_id].update(
                {
                    "status": "failed",
                    "error": exc.detail,
                    "error_code": exc.status_code,
                }
            )
    except Exception:
        with _jobs_lock:
            _jobs[job_id].update(
                {
                    "status": "failed",
                    "error": "Unexpected extraction error.",
                    "error_code": 422,
                }
            )


# ---------------------------------------------------------------------------
# FastAPI App & Middleware
# ---------------------------------------------------------------------------
app = FastAPI(
    title="ClipGrab API",
    version="2.0.0",
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
)

if ALLOWED_ORIGIN:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[ALLOWED_ORIGIN],
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Content-Type"],
    )


@app.middleware("http")
async def add_security_headers(request: Request, call_next: Any):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "script-src 'self' 'unsafe-inline'; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
        "font-src 'self' https://fonts.gstatic.com; "
        "img-src 'self' https: data:; "
        "connect-src 'self';"
    )
    return response


# ---------------------------------------------------------------------------
# Request / Response Models
# ---------------------------------------------------------------------------
class InfoRequest(BaseModel):
    url: str = Field(..., min_length=1, max_length=2048)


class InfoResponse(BaseModel):
    title: str
    thumbnail: str | None
    duration: int | None
    uploader: str | None
    site: str
    options: list[QualityPreset]


class JobRequest(BaseModel):
    url: str = Field(..., min_length=1, max_length=2048)
    quality: QualityPreset = "720p"


class TakedownRequest(BaseModel):
    name: str
    organization: str
    email: str
    originalUrl: str | None = None
    targetUrls: str


# ---------------------------------------------------------------------------
# API Endpoints (Phase 2 Contract)
# ---------------------------------------------------------------------------
@app.get("/api/health")
def health_check() -> dict[str, bool]:
    return {"ok": True}


@app.get("/api/sites")
def list_supported_sites() -> list[dict[str, str]]:
    return get_cached_sites()


@app.post("/api/info", response_model=InfoResponse)
def get_media_info(payload: InfoRequest, request: Request) -> dict[str, Any]:
    inc_metric("clipgrab_info_requests_total")
    rate_limiter.check(get_client_ip(request), RATE_LIMIT_PER_MIN)
    safe_url = validate_and_resolve_url(payload.url)
    info = extract_media_info(safe_url)
    logger.info("info_ok", extra={"extra_fields": {"target": redact_url(safe_url)}})
    return info


@app.get("/api/download")
def download_media(
    request: Request,
    background_tasks: BackgroundTasks,
    url: str = Query(..., min_length=1, max_length=2048),
    quality: QualityPreset = Query("720p"),
):
    inc_metric("clipgrab_download_requests_total")
    rate_limiter.check(get_client_ip(request), RATE_LIMIT_PER_MIN)
    safe_url = validate_and_resolve_url(url)

    temp_dir, file_path, clean_name, media_type = run_download_to_temp(safe_url, quality)
    background_tasks.add_task(cleanup_directory, temp_dir)

    logger.info(
        "download_ok",
        extra={"extra_fields": {"quality": quality, "target": redact_url(safe_url)}},
    )
    return FileResponse(
        path=file_path,
        media_type=media_type,
        filename=clean_name,
        background=background_tasks,
    )


@app.post("/api/jobs", response_model=JobRecord)
def create_download_job(payload: JobRequest, request: Request) -> JobRecord:
    rate_limiter.check(get_client_ip(request), RATE_LIMIT_PER_MIN)
    safe_url = validate_and_resolve_url(payload.url)
    job_id = uuid.uuid4().hex
    record = {
        "id": job_id,
        "status": "queued",
        "progress": 0,
        "quality": payload.quality,
        "filename": None,
        "error": None,
        "error_code": None,
    }
    with _jobs_lock:
        _jobs[job_id] = record

    thread = threading.Thread(
        target=_run_job_worker,
        args=(job_id, safe_url, payload.quality),
        daemon=True,
    )
    thread.start()
    return JobRecord(**record)


@app.get("/api/jobs/{job_id}", response_model=JobRecord)
def get_download_job(job_id: str) -> JobRecord:
    with _jobs_lock:
        job = _jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")
    return JobRecord(**{k: v for k, v in job.items() if k in JobRecord.model_fields})


@app.get("/api/jobs/{job_id}/file")
def download_job_file(job_id: str, background_tasks: BackgroundTasks):
    with _jobs_lock:
        job = _jobs.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Job not found.")
        if job["status"] != "completed" or not job.get("file_path"):
            raise HTTPException(status_code=409, detail="Job is not completed yet.")
        temp_dir = job["temp_dir"]
        file_path = job["file_path"]
        filename = job["filename"] or "clipgrab_media.mp4"
        media_type = job["media_type"] or "video/mp4"
        _jobs.pop(job_id, None)

    background_tasks.add_task(cleanup_directory, temp_dir)
    return FileResponse(
        path=file_path,
        media_type=media_type,
        filename=filename,
        background=background_tasks,
    )


@app.post("/api/takedown")
def submit_takedown(payload: TakedownRequest) -> dict[str, Any]:
    logger.info("dmca_notice_received", extra={"extra_fields": {"org": payload.organization[:64]}})
    return {
        "ok": True,
        "message": (
            "Takedown notice logged. Verified domains are enforced via BLOCKED_DOMAINS "
            "(HTTP 403). Takedown contact: dmca@clipgrab.local."
        ),
    }


@app.get("/metrics", response_class=PlainTextResponse)
def prometheus_metrics() -> str:
    with _metrics_lock:
        lines = [f"{k} {v}" for k, v in sorted(_metrics.items())]
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# Static Frontend Serving (Phase 1 SPA served from /)
# ---------------------------------------------------------------------------
if STATIC_DIR.exists() and STATIC_DIR.is_dir():
    assets_dir = STATIC_DIR / "assets"
    if assets_dir.exists():
        app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="assets")

    @app.get("/{full_path:path}")
    def serve_spa(full_path: str):
        if full_path.startswith("api/"):
            return JSONResponse(status_code=404, content={"detail": "Not found"})
        candidate = (STATIC_DIR / full_path).resolve()
        if full_path and candidate.is_file() and str(candidate).startswith(str(STATIC_DIR.resolve())):
            return FileResponse(str(candidate))
        index_file = STATIC_DIR / "index.html"
        if index_file.exists():
            return FileResponse(str(index_file))
        return JSONResponse(status_code=404, content={"detail": "Frontend build not found"})
