# ClipGrab

A clean, single-file React frontend paired with a Python 3.12 + FastAPI + `yt-dlp` + `ffmpeg` backend (plus an Express/Vite dev server for local preview).

---

## Architecture & API Endpoints

### `GET /api/health`
- **Backend:** Returns `{"ok": true}` for container/load-balancer health checks.
- **Frontend:** Available for readiness checks.

### `GET /api/sites`
- **Backend:** Dynamically builds and caches `[{"name": "Vimeo"}, ...]` from `yt-dlp`'s extractor registry (`@lru_cache`).
- **Frontend:** Called once when opening the **Supported sites** page (`fetch('/api/sites')`) to populate and filter the live extractor directory.

### `POST /api/info`
- **Request:** `{ "url": "https://..." }`
- **Response (`200`):**
  ```json
  {
    "title": "string",
    "thumbnail": "url|null",
    "duration": 123,
    "uploader": "string|null",
    "site": "string",
    "options": ["1080p", "720p", "480p", "mp3"]
  }
  ```
- **Errors:**
  - `400` invalid link or SSRF-blocked private/loopback/link-local IP
  - `403` domain on `BLOCKED_DOMAINS`
  - `413` exceeds `MAX_DURATION_SEC` (default `3600`s) or 500 MB
  - `422` unreadable, private, DRM-protected, or unsupported source
  - `429` per-IP rate limit exceeded (`RATE_LIMIT_PER_MIN`)
- **Frontend:** Called when submitting the URL form (`fetch('/api/info', { method: 'POST', ... })`), rendering only the presets returned in `options`.

### `GET /api/download?url=...&quality=1080p|720p|480p|mp3`
- **Backend:** Downloads single videos (`noplaylist`) into an isolated per-request temporary directory using `yt-dlp` + `ffmpeg`, streams the file with `Content-Disposition: attachment; filename="..."`, and deletes the temp directory in a `BackgroundTask`.
- **Quality Presets:**
  - `1080p`: `bv*[height<=1080]+ba/b[height<=1080]/b` merged to `.mp4`
  - `720p`: `bv*[height<=720]+ba/b[height<=720]/b` merged to `.mp4`
  - `480p`: `bv*[height<=480]+ba/b[height<=480]/b` merged to `.mp4`
  - `mp3`: `ba/b` + `FFmpegExtractAudio` (`mp3`, `192 kbps`)
- **Frontend:** Streams the response via `fetch` + `ReadableStream` with `AbortController` cancellation support and triggers browser file download.

### Production Upgrades Included
- **Async Job Polling:** `POST /api/jobs` -> `GET /api/jobs/{id}` -> `GET /api/jobs/{id}/file` (structured for drop-in Celery/RQ + Redis backing).
- **Metrics & Safe Structured Logging:** `GET /metrics` (Prometheus exposition format); query parameters/tokens are stripped from all URL logs.

---

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `BLOCKED_DOMAINS` | `""` | Comma-separated blocked hostnames/domains (takedowns) |
| `RATE_LIMIT_PER_MIN` | `10` | Per-IP sliding window limit per minute |
| `MAX_DURATION_SEC` | `3600` | Maximum allowed media duration in seconds |
| `MAX_FILE_SIZE_MB` | `500` | Maximum allowed download size in MB |
| `ALLOWED_ORIGIN` | `""` | Allowed CORS origin (same-origin when empty) |
| `LOG_LEVEL` | `INFO` | Structured JSON log level |

---

## Running Locally & Deploying

### 1. Build Frontend + Run Python FastAPI Backend
```bash
npm install
npm run build

cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8000
```
Open `http://localhost:8000`.

### 2. Run Tests
```bash
cd backend
pytest -v tests/test_api.py
```

### 3. Docker Deployment (with FFmpeg + Static Frontend)
```bash
docker build -f backend/Dockerfile -t clipgrab:latest .
docker run --rm -p 8000:8000 \
  -e RATE_LIMIT_PER_MIN=10 \
  -e MAX_DURATION_SEC=3600 \
  -e BLOCKED_DOMAINS="" \
  clipgrab:latest
```

---

## Legal & Compliance Notes
- Includes **Terms**, **Privacy**, and **Copyright / DMCA** pages with a takedown contact (`dmca@clipgrab.local`).
- Footer and inline notices clarify that ClipGrab is for **personal use only**, users are responsible for having the right to download content, and third-party platform terms may prohibit downloading.
- Honor takedown requests immediately by adding domains to `BLOCKED_DOMAINS`.
- Have a qualified lawyer review terms, privacy, and DMCA agent registration before public launch.
