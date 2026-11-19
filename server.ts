import { type ChildProcess, execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import dotenv from 'dotenv';
import express, { type NextFunction, type Request, type Response } from 'express';

dotenv.config();

const execFileAsync = promisify(execFile);

const PORT = Number(process.env.PORT || 3000);
const RATE_LIMIT_PER_MIN = Math.max(1, Number(process.env.RATE_LIMIT_PER_MIN || 10));
const MAX_DURATION_SEC = Math.max(1, Number(process.env.MAX_DURATION_SEC || 3600));
const MAX_FILE_SIZE_BYTES = Math.max(1, Number(process.env.MAX_FILE_SIZE_MB || 500)) * 1024 * 1024;
const ALLOWED_ORIGIN = (process.env.ALLOWED_ORIGIN || '').trim();
const YTDLP_COOKIES_FILE = (process.env.YTDLP_COOKIES_FILE || '').trim();
const YTDLP_COOKIES_CONTENT = (process.env.YTDLP_COOKIES_CONTENT || '').trim();
const SOCKET_TIMEOUT_MS = 15_000;
const HTTP_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'mkv', 'm4v', 'avi', 'flv']);
const AUDIO_EXTS = new Set(['mp3', 'm4a', 'aac', 'opus', 'ogg', 'wav', 'flac']);

const EXCLUDED_DOMAINS = ['youtube.com', 'youtu.be', 'youtube-nocookie.com', 'youtubekids.com'];

function isExcludedDomain(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.+$/, '');
  return EXCLUDED_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function getBlockedDomains(): string[] {
  return (process.env.BLOCKED_DOMAINS || '')
    .split(',')
    .map((d) => d.trim().toLowerCase().replace(/^\.+/, ''))
    .filter(Boolean);
}

function isDomainBlocked(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.+$/, '');
  for (const blocked of getBlockedDomains()) {
    if (host === blocked || host.endsWith(`.${blocked}`)) {
      return true;
    }
  }
  return false;
}

// Redact query strings / tokens from URLs before logging
function redactUrlForLog(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.protocol}//${parsed.hostname}${parsed.pathname}`;
  } catch {
    return '[invalid-url]';
  }
}

function isDisallowedIp(ipRaw: string): boolean {
  const ip = ipRaw.split('%')[0].toLowerCase();
  const family = net.isIP(ip);
  if (family === 4) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
    const [a, b, c] = parts;
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8 private
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local & cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
    if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 IETF protocol
    if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmark
    if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
    if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
    if (a >= 224) return true; // multicast & reserved
    return false;
  }

  if (family === 6) {
    if (ip === '::' || ip === '::1') return true;
    if (ip.startsWith('::ffff:')) {
      return isDisallowedIp(ip.slice(7));
    }
    if (ip.startsWith('fc') || ip.startsWith('fd')) return true; // unique local
    if (/^fe[89ab]/.test(ip)) return true; // link-local fe80::/10
    if (ip.startsWith('ff')) return true; // multicast
    if (ip.startsWith('2001:db8:')) return true; // documentation
    return false;
  }

  return true;
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function validateAndAssertSafeUrl(rawUrl: string): Promise<URL> {
  if (!rawUrl || typeof rawUrl !== 'string' || rawUrl.length > 2048) {
    throw new HttpError(400, 'A valid http:// or https:// URL is required.');
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new HttpError(400, 'Malformed URL.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new HttpError(400, 'Only http:// and https:// links are accepted.');
  }

  if (!parsed.hostname) {
    throw new HttpError(400, 'URL is missing a hostname.');
  }

  if (parsed.username || parsed.password) {
    throw new HttpError(400, 'Embedded credentials in URLs are not permitted.');
  }

  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new HttpError(400, 'Local or internal hostnames are not permitted.');
  }

  if (isExcludedDomain(host)) {
    throw new HttpError(403, 'This domain is not supported by this service.');
  }

  if (isDomainBlocked(host)) {
    throw new HttpError(403, 'This domain is blocked under policy or takedown rules.');
  }

  if (net.isIP(host)) {
    if (isDisallowedIp(host)) {
      throw new HttpError(400, 'Private, loopback, link-local, or reserved IP addresses are not permitted.');
    }
    return parsed;
  }

  let records: { address: string; family: number }[];
  try {
    records = await dns.lookup(host, { all: true });
  } catch {
    throw new HttpError(422, 'Could not resolve hostname for the supplied link.');
  }

  if (!records.length || records.some((r) => isDisallowedIp(r.address))) {
    throw new HttpError(400, 'Target resolves to a disallowed private or reserved IP address.');
  }

  return parsed;
}

// Per-IP sliding window rate limiter
const rateBuckets = new Map<string, number[]>();

function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function enforceRateLimit(req: Request): void {
  const ip = getClientIp(req);
  const now = Date.now();
  const windowStart = now - 60_000;
  const timestamps = (rateBuckets.get(ip) || []).filter((ts) => ts > windowStart);
  if (timestamps.length >= RATE_LIMIT_PER_MIN) {
    rateBuckets.set(ip, timestamps);
    throw new HttpError(429, `Rate limit exceeded (${RATE_LIMIT_PER_MIN} requests/minute).`);
  }
  timestamps.push(now);
  rateBuckets.set(ip, timestamps);
}

// Resolve yt-dlp binary (supports bundled backend/bin/yt-dlp or system PATH)
let resolvedYtDlpBin: string | null | undefined = undefined;
async function getYtDlpBin(): Promise<string | null> {
  if (resolvedYtDlpBin !== undefined) return resolvedYtDlpBin;

  const candidates = [
    process.env.YTDLP_BIN?.trim(),
    path.resolve(process.cwd(), 'backend/bin/yt-dlp'),
    'yt-dlp',
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    try {
      if (candidate.includes('/') && !fs.existsSync(candidate)) continue;
      await execFileAsync(candidate, ['--version'], { timeout: 5000 });
      resolvedYtDlpBin = candidate;
      return resolvedYtDlpBin;
    } catch {
      // Try next candidate
    }
  }

  resolvedYtDlpBin = null;
  return null;
}

let cachedInlineCookiesPath: string | null = null;
function getCookiesFilePath(): string | null {
  if (YTDLP_COOKIES_FILE && fs.existsSync(YTDLP_COOKIES_FILE)) {
    return YTDLP_COOKIES_FILE;
  }
  if (YTDLP_COOKIES_CONTENT) {
    if (cachedInlineCookiesPath && fs.existsSync(cachedInlineCookiesPath)) {
      return cachedInlineCookiesPath;
    }
    try {
      const tmpCookies = path.join(os.tmpdir(), 'clipgrab-ytdlp-cookies.txt');
      fs.writeFileSync(tmpCookies, YTDLP_COOKIES_CONTENT, { mode: 0o600 });
      cachedInlineCookiesPath = tmpCookies;
      return tmpCookies;
    } catch {
      return null;
    }
  }
  return null;
}

function baseYtDlpArgs(): string[] {
  const args = [
    '--no-playlist',
    '--socket-timeout',
    '15',
    '--no-warnings',
    '--concurrent-fragments',
    '8',
    '--js-runtimes',
    'node',
  ];
  const cookiesPath = getCookiesFilePath();
  if (cookiesPath) {
    args.push('--cookies', cookiesPath);
  }
  return args;
}

type QualityPreset = '1080p' | '720p' | '480p' | 'mp3';

interface ProgressiveFormatMeta {
  formatId: string;
  url: string;
  ext: string;
  height: number | null;
  vcodec: string;
  acodec: string;
  protocol: string;
  filesize: number | null;
  httpHeaders?: Record<string, string>;
}

interface DirectProbeMeta {
  formatName: string;
  videoCodec: string | null;
  audioCodec: string | null;
  width: number | null;
  height: number | null;
}

interface StreamVariant {
  height: number;
  url: string;
}

interface CachedResolvedSource {
  createdAt: number;
  kind: 'direct-probe' | 'html-direct' | 'embed' | 'yt-dlp';
  publicInfo: {
    title: string;
    thumbnail: string | null;
    duration: number | null;
    uploader: string | null;
    site: string;
    options: QualityPreset[];
  };
  resolvedTargetUrl: string;
  extraArgs: string[];
  ffmpegHeaders?: string;
  directProbe?: DirectProbeMeta;
  streamVariants?: StreamVariant[];
  progressiveFormats?: ProgressiveFormatMeta[];
}

const INFO_CACHE_TTL_MS = 5 * 60_000;
const infoCache = new Map<string, CachedResolvedSource>();

function getCachedSource(urlStr: string): CachedResolvedSource | null {
  const hit = infoCache.get(urlStr);
  if (!hit) return null;
  if (Date.now() - hit.createdAt > INFO_CACHE_TTL_MS) {
    infoCache.delete(urlStr);
    return null;
  }
  return hit;
}

function setCachedSource(urlStr: string, entry: CachedResolvedSource): void {
  if (infoCache.size >= 100) {
    const oldestKey = infoCache.keys().next().value;
    if (oldestKey) infoCache.delete(oldestKey);
  }
  infoCache.set(urlStr, entry);
}

function buildFfmpegHeadersString(headers?: Record<string, string>): string | undefined {
  if (!headers) return undefined;
  const lines: string[] = [];
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (lk === 'user-agent' || lk === 'host' || lk === 'content-length') continue;
    if (v) lines.push(`${k}: ${v}`);
  }
  return lines.length ? `${lines.join('\r\n')}\r\n` : undefined;
}

function parseRawHeadersToMap(ffmpegHeaders?: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!ffmpegHeaders) return out;
  for (const line of ffmpegHeaders.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx > 0) {
      out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  return out;
}

function computeAvailablePresets(
  heights: number[],
  hasAudio: boolean,
  hasVideo: boolean
): QualityPreset[] {
  const options: QualityPreset[] = [];
  if (hasVideo) {
    const maxHeight = heights.length > 0 ? Math.max(...heights) : 0;
    if (maxHeight >= 1080) options.push('1080p');
    if (maxHeight >= 720) options.push('720p');
    if (maxHeight >= 480 || (maxHeight > 0 && options.length === 0)) options.push('480p');
    if (maxHeight === 0) {
      // Video exists without explicit height metadata (e.g. generic direct link)
      options.push('720p', '480p');
    }
  }
  if (hasAudio || hasVideo) {
    options.push('mp3');
  }
  return options;
}

function sanitizeFilename(title: string, ext: string): string {
  const withoutExt = title.replace(/\.(mp4|webm|mov|m4v|mkv|mp3|m4a|ogg|wav|opus|flac)$/i, '');
  const clean = withoutExt
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return `${clean || 'clipgrab_media'}.${ext}`;
}

function sanitizeYtDlpMessage(raw: string): string | null {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const errLine = lines.find((l) => /^ERROR:/i.test(l)) || lines[0] || '';
  if (!errLine) return null;

  const cleaned = errLine
    .replace(/^ERROR:\s*(\[[^\]]+\]\s*([^:]+:\s*)?)?/i, '')
    .replace(/https?:\/\/[^\s)]+/gi, (match) => redactUrlForLog(match))
    .replace(/Use --cookies-from-browser[\s\S]*$/i, '')
    .replace(/please report this issue[\s\S]*$/i, '')
    .replace(/Confirm you are on the latest version[\s\S]*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned || cleaned.length < 6) return null;
  return cleaned.length > 220 ? `${cleaned.slice(0, 217)}...` : cleaned;
}

function mapYtDlpError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  const anyErr = err as any;
  if (anyErr?.killed || anyErr?.code === 'ETIMEDOUT') {
    return new HttpError(422, 'Extraction timed out while waiting for the remote media host.');
  }

  const raw = String(anyErr?.stderr || anyErr?.message || '');
  const lower = raw.toLowerCase();

  if (lower.includes('sign in to confirm') || lower.includes('not a bot')) {
    return new HttpError(
      422,
      'This platform requested bot/sign-in verification from the server IP. Configure YTDLP_COOKIES_FILE (or YTDLP_COOKIES_CONTENT) or try another video link.'
    );
  }
  if (lower.includes('impersonate')) {
    return new HttpError(
      422,
      'This platform requires browser TLS impersonation that is not supported for automated extraction.'
    );
  }
  if (
    lower.includes('drm') ||
    lower.includes('widevine') ||
    lower.includes('fairplay') ||
    lower.includes('encrypted')
  ) {
    return new HttpError(422, 'DRM-protected or encrypted media cannot be downloaded.');
  }
  if (lower.includes('age-restricted') || lower.includes('confirm your age')) {
    return new HttpError(
      422,
      'Age-restricted media requires authenticated cookies (YTDLP_COOKIES_FILE).'
    );
  }
  if (
    lower.includes('private') ||
    lower.includes('members-only') ||
    lower.includes('logged-in') ||
    lower.includes('logged in') ||
    lower.includes('login') ||
    lower.includes('authentication')
  ) {
    return new HttpError(422, 'Media is private or requires platform sign-in / cookies.');
  }
  if (
    lower.includes('not available in your country') ||
    lower.includes('geo') ||
    lower.includes('blocked it in your country')
  ) {
    return new HttpError(422, 'Media is geo-restricted or unavailable in the server region.');
  }
  if (lower.includes('file is larger than max-filesize') || lower.includes('filesize')) {
    return new HttpError(413, 'Media exceeds the 500 MB maximum file size limit.');
  }
  if (lower.includes('http error 429') || lower.includes('too many requests')) {
    return new HttpError(429, 'Upstream platform temporarily rate-limited requests from this server.');
  }
  if (lower.includes('http error 403') || lower.includes('403 forbidden')) {
    return new HttpError(422, 'Upstream media host returned HTTP 403 Forbidden.');
  }
  if (lower.includes('http error 404') || lower.includes('video unavailable')) {
    return new HttpError(422, 'Video was removed, made private, or returned HTTP 404.');
  }
  if (lower.includes('unsupported url')) {
    return new HttpError(422, 'Unsupported URL or no extractable media stream found on this page.');
  }
  if (lower.includes('no video formats found') || lower.includes('no formats found')) {
    return new HttpError(
      422,
      'No downloadable video or audio streams were found at this link. Make sure the URL points directly to a public video or audio post.'
    );
  }

  const sanitized = sanitizeYtDlpMessage(raw);
  if (sanitized) {
    return new HttpError(422, sanitized);
  }
  return new HttpError(422, 'Media is unavailable, restricted, or unsupported.');
}

const BUILTIN_SITES = [
  { name: 'Vimeo' },
  { name: 'SoundCloud' },
  { name: 'TikTok' },
  { name: 'Twitch' },
  { name: 'TED' },
  { name: 'Dailymotion' },
  { name: 'Bandcamp' },
  { name: 'Instagram' },
  { name: 'Twitter' },
  { name: 'Reddit' },
  { name: 'Streamable' },
  { name: 'PeerTube' },
  { name: 'Archive.org' },
  { name: 'Wikimedia Commons' },
];

let cachedSites: { name: string }[] | null = null;

async function getSupportedSites(): Promise<{ name: string }[]> {
  if (cachedSites) return cachedSites;
  const ytDlpBin = await getYtDlpBin();
  if (ytDlpBin) {
    try {
      const { stdout } = await execFileAsync(ytDlpBin, ['--list-extractors'], {
        timeout: 12_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      const seen = new Set<string>();
      const list: { name: string }[] = [];
      for (const line of stdout.split(/\r?\n/)) {
        const name = line.trim();
        if (!name || name === 'generic' || name.includes(':')) continue;
        const key = name.toLowerCase();
        if (key === 'youtube' || key.startsWith('youtube') || key === 'youtu.be') continue;
        if (!seen.has(key)) {
          seen.add(key);
          list.push({ name });
        }
      }
      if (list.length > 0) {
        list.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
        cachedSites = list;
        return cachedSites;
      }
    } catch {
      // Fall through to built-in list
    }
  }
  cachedSites = BUILTIN_SITES;
  return cachedSites;
}

async function probeDirectMedia(
  targetUrl: string,
  ffmpegHeaders?: string,
  metadataOverrides?: {
    title?: string;
    thumbnail?: string | null;
    duration?: number | null;
    uploader?: string | null;
    site?: string;
  }
) {
  let stdout = '';
  const probeArgs = ['-v', 'error', '-user_agent', HTTP_USER_AGENT];
  if (ffmpegHeaders) {
    probeArgs.push('-headers', ffmpegHeaders);
  }
  probeArgs.push('-print_format', 'json', '-show_format', '-show_streams', targetUrl);

  try {
    const result = await execFileAsync('ffprobe', probeArgs, { timeout: SOCKET_TIMEOUT_MS });
    stdout = result.stdout;
  } catch (err: any) {
    const stderr = String(err?.stderr || err?.message || '');
    if (stderr.includes('403')) {
      throw new HttpError(422, 'Remote media host returned HTTP 403 Forbidden.');
    }
    if (stderr.includes('404')) {
      throw new HttpError(422, 'Remote media file not found (HTTP 404).');
    }
    if (err?.killed || err?.code === 'ETIMEDOUT') {
      throw new HttpError(422, 'Timed out probing direct media stream.');
    }
    throw new HttpError(422, 'Unable to read direct media stream at this URL.');
  }

  let parsed: any = {};
  try {
    parsed = JSON.parse(stdout || '{}');
  } catch {
    throw new HttpError(422, 'Invalid media metadata returned for direct URL.');
  }
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const videoStreams = streams.filter((s: any) => s.codec_type === 'video');
  const audioStreams = streams.filter((s: any) => s.codec_type === 'audio');
  if (videoStreams.length === 0 && audioStreams.length === 0) {
    throw new HttpError(422, 'No playable audio or video streams found at this URL.');
  }

  const durationRaw = parsed.format?.duration ? Number(parsed.format.duration) : null;
  const duration =
    metadataOverrides?.duration ??
    (durationRaw && Number.isFinite(durationRaw) ? Math.round(durationRaw) : null);
  if (duration !== null && duration > MAX_DURATION_SEC) {
    throw new HttpError(413, `Media exceeds maximum duration (${MAX_DURATION_SEC}s).`);
  }

  const heights = videoStreams
    .map((s: any) => Number(s.height))
    .filter((h: number) => Number.isFinite(h) && h > 0);

  const urlObj = new URL(targetUrl);
  const baseName = path.basename(urlObj.pathname) || urlObj.hostname;
  const firstVideo = videoStreams[0];
  const firstAudio = audioStreams[0];

  return {
    title: metadataOverrides?.title || parsed.format?.tags?.title || baseName,
    thumbnail: metadataOverrides?.thumbnail ?? null,
    duration,
    uploader: metadataOverrides?.uploader ?? parsed.format?.tags?.artist ?? urlObj.hostname,
    site: metadataOverrides?.site || 'Direct Media',
    options: computeAvailablePresets(heights, audioStreams.length > 0, videoStreams.length > 0),
    probeMeta: {
      formatName: String(parsed.format?.format_name || '').toLowerCase(),
      videoCodec: firstVideo?.codec_name ? String(firstVideo.codec_name).toLowerCase() : null,
      audioCodec: firstAudio?.codec_name ? String(firstAudio.codec_name).toLowerCase() : null,
      width: firstVideo?.width ? Number(firstVideo.width) : null,
      height: firstVideo?.height ? Number(firstVideo.height) : null,
    } as DirectProbeMeta,
  };
}

function getVimeoFallbackTarget(targetUrl: string): { url: string; extraArgs: string[] } | null {
  try {
    const parsed = new URL(targetUrl);
    const host = parsed.hostname.toLowerCase();
    if (host === 'vimeo.com' || host === 'www.vimeo.com') {
      const match = parsed.pathname.match(/\/(\d+)(?:\/|$)/);
      if (match?.[1]) {
        return {
          url: `https://player.vimeo.com/video/${match[1]}`,
          extraArgs: ['--referer', 'https://vimeo.com/'],
        };
      }
    }
  } catch {
    // Ignore parse errors
  }
  return null;
}

async function runYtDlpJson(ytDlpBin: string, targetUrl: string, extraArgs: string[] = []) {
  const { stdout } = await execFileAsync(
    ytDlpBin,
    ['--dump-single-json', ...baseYtDlpArgs(), ...extraArgs, targetUrl],
    { timeout: 45_000, maxBuffer: 10 * 1024 * 1024 }
  );
  return JSON.parse(stdout);
}

async function inspectViaYtDlp(
  ytDlpBin: string,
  targetUrl: string
): Promise<{
  title: string;
  thumbnail: string | null;
  duration: number | null;
  uploader: string | null;
  site: string;
  options: QualityPreset[];
  resolvedTargetUrl: string;
  extraArgs: string[];
  progressiveFormats: ProgressiveFormatMeta[];
}> {
  let activeUrl = targetUrl;
  let activeExtraArgs: string[] = [];
  let info: any;

  try {
    info = await runYtDlpJson(ytDlpBin, activeUrl, activeExtraArgs);
  } catch (err: any) {
    const stderr = String(err?.stderr || err?.message || '').toLowerCase();
    const vimeoFallback = getVimeoFallbackTarget(targetUrl);
    if (vimeoFallback && (stderr.includes('logged-in') || stderr.includes('login') || stderr.includes('cookies'))) {
      activeUrl = vimeoFallback.url;
      activeExtraArgs = vimeoFallback.extraArgs;
      info = await runYtDlpJson(ytDlpBin, activeUrl, activeExtraArgs);
    } else {
      throw err;
    }
  }

  const durationRaw = typeof info.duration === 'number' ? info.duration : null;
  const duration = durationRaw !== null ? Math.round(durationRaw) : null;
  if (duration !== null && duration > MAX_DURATION_SEC) {
    throw new HttpError(413, `Video exceeds maximum duration (${MAX_DURATION_SEC}s).`);
  }

  const formats = Array.isArray(info.formats) ? info.formats : [];
  const heights: number[] = [];
  const progressiveFormats: ProgressiveFormatMeta[] = [];
  let hasVideo = false;
  let hasAudio = false;

  for (const f of formats) {
    const ext = String(f.ext || '').toLowerCase();
    const videoExt = String(f.video_ext || '').toLowerCase();
    const audioExt = String(f.audio_ext || '').toLowerCase();
    const vcodec = String(f.vcodec || 'none').toLowerCase();
    const acodec = String(f.acodec || 'none').toLowerCase();
    const protocol = String(f.protocol || '').toLowerCase();
    const fmtUrl = typeof f.url === 'string' ? f.url : '';
    const isVid =
      (vcodec && vcodec !== 'none') ||
      (videoExt && videoExt !== 'none') ||
      VIDEO_EXTS.has(ext);
    const isAud =
      (acodec && acodec !== 'none') ||
      (audioExt && audioExt !== 'none') ||
      AUDIO_EXTS.has(ext);

    if (isVid) {
      hasVideo = true;
      if (typeof f.height === 'number' && f.height > 0) heights.push(f.height);
    }
    if (isAud) {
      hasAudio = true;
    }

    if (
      fmtUrl &&
      (protocol === 'http' || protocol === 'https') &&
      ext === 'mp4' &&
      !fmtUrl.toLowerCase().includes('.m3u8') &&
      !fmtUrl.toLowerCase().includes('.mpd')
    ) {
      const fSize =
        typeof f.filesize === 'number'
          ? f.filesize
          : typeof f.filesize_approx === 'number'
          ? f.filesize_approx
          : null;
      progressiveFormats.push({
        formatId: String(f.format_id || ''),
        url: fmtUrl,
        ext,
        height: typeof f.height === 'number' && f.height > 0 ? f.height : null,
        vcodec,
        acodec,
        protocol,
        filesize: fSize,
        httpHeaders: f.http_headers && typeof f.http_headers === 'object' ? f.http_headers : undefined,
      });
    }
  }

  if (formats.length === 0) {
    const ext = String(info.ext || '').toLowerCase();
    if ((info.vcodec && info.vcodec !== 'none') || VIDEO_EXTS.has(ext)) hasVideo = true;
    if ((info.acodec && info.acodec !== 'none') || AUDIO_EXTS.has(ext)) hasAudio = true;
    if (
      typeof info.url === 'string' &&
      ext === 'mp4' &&
      !info.url.toLowerCase().includes('.m3u8')
    ) {
      progressiveFormats.push({
        formatId: String(info.format_id || 'direct'),
        url: info.url,
        ext,
        height: typeof info.height === 'number' && info.height > 0 ? info.height : null,
        vcodec: String(info.vcodec || 'none').toLowerCase(),
        acodec: String(info.acodec || 'none').toLowerCase(),
        protocol: 'https',
        filesize: typeof info.filesize === 'number' ? info.filesize : null,
        httpHeaders: info.http_headers && typeof info.http_headers === 'object' ? info.http_headers : undefined,
      });
    }
  }

  // If generic extractor didn't read video height/duration, probe direct stream with ffprobe
  if (info.direct && (duration === null || heights.length === 0)) {
    try {
      const probed = await probeDirectMedia(activeUrl);
      const { probeMeta: _pm, ...publicProbed } = probed;
      return {
        ...publicProbed,
        title: String(info.title || publicProbed.title),
        thumbnail: info.thumbnail ? String(info.thumbnail) : publicProbed.thumbnail,
        resolvedTargetUrl: activeUrl,
        extraArgs: activeExtraArgs,
        progressiveFormats,
      };
    } catch {
      // Keep yt-dlp info
    }
  }

  const options = computeAvailablePresets(heights, hasAudio, hasVideo);
  if (options.length === 0) {
    throw new HttpError(422, 'No compatible video or audio streams found.');
  }

  return {
    title: String(info.title || 'Untitled media'),
    thumbnail: info.thumbnail ? String(info.thumbnail) : null,
    duration,
    uploader: info.uploader ? String(info.uploader) : info.channel ? String(info.channel) : null,
    site: String(info.extractor_key || info.extractor || new URL(targetUrl).hostname),
    options,
    resolvedTargetUrl: activeUrl,
    extraArgs: activeExtraArgs,
    progressiveFormats,
  };
}

function isDirectMediaUrl(targetUrl: string): boolean {
  try {
    const pathname = new URL(targetUrl).pathname.toLowerCase();
    return /\.(mp4|webm|mov|m4v|mkv|mp3|m4a|ogg|wav|opus|flac)$/i.test(pathname);
  } catch {
    return false;
  }
}

async function fetchHtmlWithSsrfGuard(
  initialUrl: string
): Promise<{ finalUrl: string; html: string; cookieHeader: string }> {
  let currentUrl = initialUrl;
  const cookies: string[] = [];

  for (let hop = 0; hop < 5; hop++) {
    await validateAndAssertSafeUrl(currentUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SOCKET_TIMEOUT_MS);

    let res: globalThis.Response;
    try {
      res = await fetch(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': HTTP_USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
    } finally {
      clearTimeout(timer);
    }

    const setCookies =
      typeof (res.headers as any).getSetCookie === 'function'
        ? ((res.headers as any).getSetCookie() as string[])
        : [];
    for (const c of setCookies) {
      const pair = c.split(';')[0]?.trim();
      if (pair) cookies.push(pair);
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) break;
      currentUrl = new URL(loc, currentUrl).toString();
      continue;
    }

    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    if (!res.ok) {
      throw new HttpError(422, `Upstream webpage returned HTTP ${res.status}.`);
    }
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      return { finalUrl: currentUrl, html: '', cookieHeader: cookies.join('; ') };
    }

    const html = await res.text();
    return { finalUrl: currentUrl, html: html.slice(0, 2_000_000), cookieHeader: cookies.join('; ') };
  }

  throw new HttpError(422, 'Too many redirects while resolving webpage.');
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\\u002F/gi, '/')
    .replace(/\\u0026/gi, '&');
}

function extractMetaContent(html: string, keys: string[]): string | null {
  for (const key of keys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const r1 = new RegExp(
      `<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["']`,
      'i'
    );
    const r2 = new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["']`,
      'i'
    );
    const m = r1.exec(html) || r2.exec(html);
    if (m?.[1]) return decodeHtmlEntities(m[1].trim());
  }
  return null;
}

interface HtmlFallbackResult {
  kind: 'direct' | 'embed';
  streamUrl: string;
  ffmpegHeaders?: string;
  ytDlpExtraArgs?: string[];
  directProbe?: DirectProbeMeta;
  streamVariants?: StreamVariant[];
  info: {
    title: string;
    thumbnail: string | null;
    duration: number | null;
    uploader: string | null;
    site: string;
    options: QualityPreset[];
  };
}

function extractTikTokData(
  html: string,
  _pageUrl: string,
  cookieHeader: string
): (Omit<HtmlFallbackResult, 'kind'> & { kind: 'direct' }) | null {
  try {
    const rehydration = html.match(
      /<script[^>]+id=["']__UNIVERSAL_DATA_FOR_REHYDRATION__["'][^>]*>([\s\S]*?)<\/script>/i
    );
    let item: any = null;
    if (rehydration?.[1]) {
      const parsed = JSON.parse(rehydration[1]);
      item = parsed?.__DEFAULT_SCOPE__?.['webapp.video-detail']?.itemInfo?.itemStruct;
    }
    if (!item) {
      const sigi = html.match(/<script[^>]+id=["']SIGI_STATE["'][^>]*>([\s\S]*?)<\/script>/i);
      if (sigi?.[1]) {
        const parsed = JSON.parse(sigi[1]);
        const itemModule = parsed?.ItemModule;
        if (itemModule && typeof itemModule === 'object') {
          item = Object.values(itemModule)[0];
        }
      }
    }
    if (!item?.video) return null;

    const streamVariants: StreamVariant[] = [];
    const heights: number[] = [];

    if (Array.isArray(item.video.bitrateInfo)) {
      for (const b of item.video.bitrateInfo) {
        const w = typeof b?.PlayAddr?.Width === 'number' ? b.PlayAddr.Width : 0;
        const h = typeof b?.PlayAddr?.Height === 'number' ? b.PlayAddr.Height : 0;
        const shortEdge = w > 0 && h > 0 ? Math.min(w, h) : h || w;
        const urls: string[] = Array.isArray(b?.PlayAddr?.UrlList) ? b.PlayAddr.UrlList : [];
        const validUrl = urls.find((u) => typeof u === 'string' && u.startsWith('http'));
        if (shortEdge > 0) heights.push(shortEdge);
        if (validUrl && shortEdge > 0) {
          streamVariants.push({ height: shortEdge, url: validUrl });
        }
      }
    }

    if (typeof item.video.height === 'number' && item.video.height > 0) {
      const w = typeof item.video.width === 'number' ? item.video.width : 0;
      const shortEdge = w > 0 ? Math.min(w, item.video.height) : item.video.height;
      heights.push(shortEdge);
    }

    const streamUrl: string | undefined =
      item.video.playAddr ||
      item.video.downloadAddr ||
      streamVariants[0]?.url;
    if (!streamUrl || typeof streamUrl !== 'string') return null;

    const duration =
      typeof item.video.duration === 'number' && Number.isFinite(item.video.duration)
        ? Math.round(item.video.duration)
        : null;
    if (duration !== null && duration > MAX_DURATION_SEC) {
      throw new HttpError(413, `Video exceeds maximum duration (${MAX_DURATION_SEC}s).`);
    }

    const options = computeAvailablePresets(heights, true, true);
    const hdrLines = [`Referer: https://www.tiktok.com/`];
    if (cookieHeader) hdrLines.push(`Cookie: ${cookieHeader}`);
    const ffmpegHeaders = `${hdrLines.join('\r\n')}\r\n`;

    return {
      kind: 'direct',
      streamUrl,
      ffmpegHeaders,
      streamVariants,
      directProbe: {
        formatName: 'mp4',
        videoCodec: 'h264',
        audioCodec: 'aac',
        width: typeof item.video.width === 'number' ? item.video.width : null,
        height: typeof item.video.height === 'number' ? item.video.height : null,
      },
      info: {
        title: String(item.desc || `TikTok video by ${item.author?.uniqueId || 'creator'}`).slice(0, 140),
        thumbnail: item.video.cover || item.video.originCover || null,
        duration,
        uploader: item.author?.nickname || item.author?.uniqueId || null,
        site: 'TikTok',
        options: options.length ? options : ['720p', '480p', 'mp3'],
      },
    };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    return null;
  }
}

async function resolveHtmlFallback(
  rawUrl: string,
  ytDlpBin: string | null
): Promise<HtmlFallbackResult | null> {
  let fetched: { finalUrl: string; html: string; cookieHeader: string };
  try {
    fetched = await fetchHtmlWithSsrfGuard(rawUrl);
  } catch (err) {
    if (err instanceof HttpError && err.status === 403) throw err;
    return null;
  }

  const { finalUrl, html, cookieHeader } = fetched;
  const host = new URL(finalUrl).hostname.toLowerCase();

  // If the URL wasn't HTML (e.g. redirect to direct video/audio file), probe it directly
  if (!html) {
    const probed = await probeDirectMedia(finalUrl);
    const { probeMeta, ...publicInfo } = probed;
    return { kind: 'direct', streamUrl: finalUrl, directProbe: probeMeta, info: publicInfo };
  }

  // 1. TikTok rehydration extraction
  if (host.includes('tiktok.com')) {
    const tt = extractTikTokData(html, finalUrl, cookieHeader);
    if (tt) {
      await validateAndAssertSafeUrl(tt.streamUrl);
      return tt;
    }
  }

  // 2. OpenGraph / Twitter Card / HTML5 video & audio / JSON-LD / direct media links in HTML
  const ogTitle =
    extractMetaContent(html, ['og:title', 'twitter:title']) ||
    html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() ||
    new URL(finalUrl).hostname;
  const ogThumb = extractMetaContent(html, ['og:image', 'twitter:image']);
  const candidateUrls: string[] = [];

  const metaVideo = extractMetaContent(html, [
    'og:video:secure_url',
    'og:video:url',
    'og:video',
    'twitter:player:stream',
  ]);
  if (metaVideo) candidateUrls.push(metaVideo);

  const tagRegex = /<(?:video|source|audio)\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = tagRegex.exec(html)) !== null) {
    candidateUrls.push(decodeHtmlEntities(tagMatch[1]));
  }

  const ldRegex = /"contentUrl"\s*:\s*"([^"]+)"/gi;
  let ldMatch: RegExpExecArray | null;
  while ((ldMatch = ldRegex.exec(html)) !== null) {
    candidateUrls.push(decodeHtmlEntities(ldMatch[1]));
  }

  const directRegex = /https?:\/\/[^\s"'<>\\]+\.(?:mp4|webm|m3u8|mp3|m4a)(?:\?[^\s"'<>\\]*)?/gi;
  let directMatch: RegExpExecArray | null;
  while ((directMatch = directRegex.exec(html)) !== null) {
    candidateUrls.push(decodeHtmlEntities(directMatch[0]));
    if (candidateUrls.length >= 12) break;
  }

  const refererHeader = `Referer: ${finalUrl}\r\n${cookieHeader ? `Cookie: ${cookieHeader}\r\n` : ''}`;
  const tried = new Set<string>();
  for (const rawCandidate of candidateUrls) {
    let absUrl: string;
    try {
      absUrl = new URL(rawCandidate, finalUrl).toString();
    } catch {
      continue;
    }
    if (tried.has(absUrl)) continue;
    tried.add(absUrl);

    try {
      await validateAndAssertSafeUrl(absUrl);
      const probed = await probeDirectMedia(absUrl, refererHeader, {
        title: ogTitle,
        thumbnail: ogThumb,
        site: new URL(finalUrl).hostname.replace(/^www\./, ''),
      });
      const { probeMeta, ...publicInfo } = probed;
      return {
        kind: 'direct',
        streamUrl: absUrl,
        ffmpegHeaders: refererHeader,
        directProbe: probeMeta,
        info: publicInfo,
      };
    } catch {
      // Try next candidate
    }
  }

  // 3. Embedded player iframe (e.g. player.vimeo.com, dailymotion.com/embed, streamable.com/e)
  if (ytDlpBin) {
    const iframeRegex = /<iframe\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
    let ifMatch: RegExpExecArray | null;
    while ((ifMatch = iframeRegex.exec(html)) !== null) {
      let absIframe: string;
      try {
        absIframe = new URL(decodeHtmlEntities(ifMatch[1]), finalUrl).toString();
      } catch {
        continue;
      }
      const lowerIframe = absIframe.toLowerCase();
      if (
        !lowerIframe.includes('player.vimeo.com') &&
        !lowerIframe.includes('dailymotion.com/embed') &&
        !lowerIframe.includes('streamable.com') &&
        !lowerIframe.includes('twitch.tv')
      ) {
        continue;
      }
      try {
        await validateAndAssertSafeUrl(absIframe);
        const extraArgs = ['--referer', finalUrl];
        const info = await runYtDlpJson(ytDlpBin, absIframe, extraArgs);
        const durationRaw = typeof info.duration === 'number' ? info.duration : null;
        const duration = durationRaw !== null ? Math.round(durationRaw) : null;
        if (duration !== null && duration > MAX_DURATION_SEC) {
          throw new HttpError(413, `Video exceeds maximum duration (${MAX_DURATION_SEC}s).`);
        }
        const formats = Array.isArray(info.formats) ? info.formats : [];
        const heights = formats
          .map((f: any) => (typeof f.height === 'number' ? f.height : 0))
          .filter((h: number) => h > 0);
        const options = computeAvailablePresets(heights, true, true);
        if (options.length > 0) {
          return {
            kind: 'embed',
            streamUrl: absIframe,
            ytDlpExtraArgs: extraArgs,
            info: {
              title: String(info.title || ogTitle),
              thumbnail: info.thumbnail ? String(info.thumbnail) : ogThumb,
              duration,
              uploader: info.uploader ? String(info.uploader) : null,
              site: String(info.extractor_key || new URL(finalUrl).hostname),
              options,
            },
          };
        }
      } catch (err) {
        if (err instanceof HttpError && err.status === 413) throw err;
      }
    }
  }

  return null;
}

async function resolveSourceCached(rawUrl: string): Promise<CachedResolvedSource> {
  const parsedUrl = await validateAndAssertSafeUrl(rawUrl);
  const urlStr = parsedUrl.toString();
  const cached = getCachedSource(urlStr);
  if (cached) return cached;

  const host = parsedUrl.hostname.toLowerCase();

  // Direct media links: try ffprobe first, but fall through if URL is an HTML page (e.g. /File:Video.webm)
  if (isDirectMediaUrl(urlStr)) {
    try {
      const probed = await probeDirectMedia(urlStr);
      const { probeMeta, ...publicInfo } = probed;
      const entry: CachedResolvedSource = {
        createdAt: Date.now(),
        kind: 'direct-probe',
        publicInfo,
        resolvedTargetUrl: urlStr,
        extraArgs: [],
        directProbe: probeMeta,
      };
      setCachedSource(urlStr, entry);
      return entry;
    } catch (err) {
      if (err instanceof HttpError && err.status === 413) throw err;
    }
  }

  const ytDlpBin = await getYtDlpBin();

  // Fast-path TikTok via SSRF-safe HTML rehydration extraction before slower yt-dlp timeout
  if (host.includes('tiktok.com')) {
    const ttFallback = await resolveHtmlFallback(urlStr, ytDlpBin).catch(() => null);
    if (ttFallback) {
      const entry: CachedResolvedSource = {
        createdAt: Date.now(),
        kind: ttFallback.kind === 'embed' ? 'embed' : 'html-direct',
        publicInfo: ttFallback.info,
        resolvedTargetUrl: ttFallback.streamUrl,
        extraArgs: ttFallback.ytDlpExtraArgs || [],
        ffmpegHeaders: ttFallback.ffmpegHeaders,
        directProbe: ttFallback.directProbe,
        streamVariants: ttFallback.streamVariants,
      };
      setCachedSource(urlStr, entry);
      return entry;
    }
  }

  if (ytDlpBin) {
    try {
      const inspected = await inspectViaYtDlp(ytDlpBin, urlStr);
      const { resolvedTargetUrl, extraArgs, progressiveFormats, ...publicInfo } = inspected;
      const entry: CachedResolvedSource = {
        createdAt: Date.now(),
        kind: 'yt-dlp',
        publicInfo,
        resolvedTargetUrl,
        extraArgs,
        progressiveFormats,
      };
      setCachedSource(urlStr, entry);
      return entry;
    } catch (err) {
      if (err instanceof HttpError) throw err;
      // Fallback 1: HTML metadata / TikTok / OpenGraph / HTML5 video / embedded player extraction
      try {
        const htmlFallback = await resolveHtmlFallback(urlStr, ytDlpBin);
        if (htmlFallback) {
          const entry: CachedResolvedSource = {
            createdAt: Date.now(),
            kind: htmlFallback.kind === 'embed' ? 'embed' : 'html-direct',
            publicInfo: htmlFallback.info,
            resolvedTargetUrl: htmlFallback.streamUrl,
            extraArgs: htmlFallback.ytDlpExtraArgs || [],
            ffmpegHeaders: htmlFallback.ffmpegHeaders,
            directProbe: htmlFallback.directProbe,
            streamVariants: htmlFallback.streamVariants,
          };
          setCachedSource(urlStr, entry);
          return entry;
        }
      } catch (fbErr) {
        if (fbErr instanceof HttpError) throw fbErr;
      }
      // Fallback 2: direct media without file extension
      try {
        const probed = await probeDirectMedia(urlStr);
        const { probeMeta, ...publicInfo } = probed;
        const entry: CachedResolvedSource = {
          createdAt: Date.now(),
          kind: 'direct-probe',
          publicInfo,
          resolvedTargetUrl: urlStr,
          extraArgs: [],
          directProbe: probeMeta,
        };
        setCachedSource(urlStr, entry);
        return entry;
      } catch {
        throw mapYtDlpError(err);
      }
    }
  }

  const htmlFallback = await resolveHtmlFallback(urlStr, null);
  if (htmlFallback) {
    const entry: CachedResolvedSource = {
      createdAt: Date.now(),
      kind: htmlFallback.kind === 'embed' ? 'embed' : 'html-direct',
      publicInfo: htmlFallback.info,
      resolvedTargetUrl: htmlFallback.streamUrl,
      extraArgs: htmlFallback.ytDlpExtraArgs || [],
      ffmpegHeaders: htmlFallback.ffmpegHeaders,
      directProbe: htmlFallback.directProbe,
      streamVariants: htmlFallback.streamVariants,
    };
    setCachedSource(urlStr, entry);
    return entry;
  }

  const probed = await probeDirectMedia(urlStr);
  const { probeMeta, ...publicInfo } = probed;
  const entry: CachedResolvedSource = {
    createdAt: Date.now(),
    kind: 'direct-probe',
    publicInfo,
    resolvedTargetUrl: urlStr,
    extraArgs: [],
    directProbe: probeMeta,
  };
  setCachedSource(urlStr, entry);
  return entry;
}

async function resolveInfo(rawUrl: string) {
  const source = await resolveSourceCached(rawUrl);
  return source.publicInfo;
}

async function cleanupTempDir(dirPath: string): Promise<void> {
  try {
    await fsp.rm(dirPath, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

async function streamFileWithCleanup(
  res: Response,
  filePath: string,
  filename: string,
  mimeType: string,
  tempDir: string
) {
  const stat = await fsp.stat(filePath);
  if (stat.size > MAX_FILE_SIZE_BYTES) {
    await cleanupTempDir(tempDir);
    throw new HttpError(413, 'Processed file exceeds the 500 MB limit.');
  }

  res.setHeader('Content-Type', mimeType);
  res.setHeader('Content-Length', String(stat.size));
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const readStream = fs.createReadStream(filePath);
  const doCleanup = () => {
    void cleanupTempDir(tempDir);
  };
  res.on('close', doCleanup);
  res.on('finish', doCleanup);
  readStream.on('error', doCleanup);
  readStream.pipe(res);
}

async function downloadStreamToTempFile(
  mediaUrl: string,
  tempDir: string,
  ffmpegHeaders?: string
): Promise<string | null> {
  if (/\.m3u8(\?|$)|\.mpd(\?|$)/i.test(mediaUrl)) {
    return null;
  }
  const reqHeaders: Record<string, string> = {
    'User-Agent': HTTP_USER_AGENT,
    Accept: '*/*',
  };
  if (ffmpegHeaders) {
    for (const line of ffmpegHeaders.split(/\r?\n/)) {
      const idx = line.indexOf(':');
      if (idx > 0) {
        reqHeaders[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    const res = await fetch(mediaUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: reqHeaders,
    });
    if (!res.ok || !res.body) return null;

    const lenHeader = res.headers.get('content-length');
    if (lenHeader && Number(lenHeader) > MAX_FILE_SIZE_BYTES) {
      throw new HttpError(413, 'Media exceeds the 500 MB maximum file size limit.');
    }

    const inputPath = path.join(tempDir, 'source_input.bin');
    const fileStream = fs.createWriteStream(inputPath);
    const reader = res.body.getReader();
    let total = 0;
    let streamError: Error | null = null;
    const trackStreamError = (err: Error) => {
      streamError = err;
    };
    fileStream.on('error', trackStreamError);

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (streamError) throw streamError;
        if (value) {
          total += value.byteLength;
          if (total > MAX_FILE_SIZE_BYTES) {
            throw new HttpError(413, 'Media exceeds the 500 MB maximum file size limit.');
          }
          if (!fileStream.write(value)) {
            if (streamError) throw streamError;
            await new Promise<void>((resolve, reject) => {
              const cleanup = () => {
                fileStream.off('drain', onDrain);
                fileStream.off('error', onError);
                fileStream.off('close', onClose);
              };
              const onDrain = () => {
                cleanup();
                resolve();
              };
              const onError = (err: Error) => {
                cleanup();
                reject(err);
              };
              const onClose = () => {
                cleanup();
                reject(streamError || new Error('WriteStream closed unexpectedly.'));
              };
              fileStream.once('drain', onDrain);
              fileStream.once('error', onError);
              fileStream.once('close', onClose);
            });
          }
        }
      }
      if (streamError) throw streamError;
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          fileStream.off('finish', onFinish);
          fileStream.off('error', onError);
        };
        const onFinish = () => {
          cleanup();
          resolve();
        };
        const onError = (err: Error) => {
          cleanup();
          reject(err);
        };
        fileStream.once('finish', onFinish);
        fileStream.once('error', onError);
        fileStream.end();
      });
    } catch (err) {
      await reader.cancel().catch(() => {});
      fileStream.destroy();
      throw err;
    } finally {
      fileStream.off('error', trackStreamError);
    }

    return total > 0 ? inputPath : null;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    return null;
  } finally {
    clearTimeout(timer);
  }
}

interface FastStreamCandidate {
  streamUrl: string;
  ffmpegHeaders?: string;
}

function selectFastStreamCandidate(
  source: CachedResolvedSource,
  quality: QualityPreset
): FastStreamCandidate | null {
  if (quality === 'mp3') return null;
  const targetH = Number(quality.replace('p', ''));
  const isM3u8OrMpd = (u: string) => /\.m3u8(\?|$)|\.mpd(\?|$)/i.test(u);

  if (source.kind === 'html-direct') {
    if (source.streamVariants && source.streamVariants.length > 0) {
      const eligible = source.streamVariants.filter((v) => v.height <= targetH + 80 && !isM3u8OrMpd(v.url));
      const picked =
        eligible.sort((a, b) => b.height - a.height)[0] ||
        [...source.streamVariants].sort((a, b) => a.height - b.height)[0];
      if (picked && !isM3u8OrMpd(picked.url)) {
        return { streamUrl: picked.url, ffmpegHeaders: source.ffmpegHeaders };
      }
    }
    if (!isM3u8OrMpd(source.resolvedTargetUrl)) {
      const probe = source.directProbe;
      const isCompatibleMp4 =
        !probe ||
        (probe.formatName.includes('mp4') &&
          (!probe.videoCodec || probe.videoCodec === 'h264') &&
          (!probe.height || probe.height <= targetH + 80));
      if (isCompatibleMp4) {
        return { streamUrl: source.resolvedTargetUrl, ffmpegHeaders: source.ffmpegHeaders };
      }
    }
  }

  if (source.kind === 'direct-probe' && !isM3u8OrMpd(source.resolvedTargetUrl)) {
    const probe = source.directProbe;
    if (
      probe &&
      probe.formatName.includes('mp4') &&
      probe.videoCodec === 'h264' &&
      (!probe.audioCodec || probe.audioCodec === 'aac') &&
      (!probe.height || probe.height <= targetH + 80)
    ) {
      return { streamUrl: source.resolvedTargetUrl, ffmpegHeaders: source.ffmpegHeaders };
    }
  }

  if (source.kind === 'yt-dlp' && source.progressiveFormats && source.progressiveFormats.length > 0) {
    // Only consider verified progressive single-file MP4 formats with video+audio (or combined archive/http MP4s with known height <= targetH)
    const combined = source.progressiveFormats.filter((f) => {
      if (f.ext !== 'mp4' || isM3u8OrMpd(f.url)) return false;
      if (f.filesize && f.filesize > MAX_FILE_SIZE_BYTES) return false;
      const hasBothCodecs = f.vcodec !== 'none' && f.acodec !== 'none';
      const combinedUnknown = f.vcodec === 'none' && f.acodec === 'none' && f.height !== null;
      if (!hasBothCodecs && !combinedUnknown) return false;
      return f.height !== null && f.height <= targetH + 40;
    });
    if (combined.length > 0) {
      combined.sort((a, b) => (b.height || 0) - (a.height || 0));
      const best = combined[0];
      return {
        streamUrl: best.url,
        ffmpegHeaders: buildFfmpegHeadersString(best.httpHeaders),
      };
    }
  }

  return null;
}

async function fetchWithSsrfRedirects(
  initialUrl: string,
  extraHeaders: Record<string, string>,
  signal: AbortSignal
): Promise<globalThis.Response> {
  let currentUrl = initialUrl;
  for (let hop = 0; hop < 6; hop++) {
    await validateAndAssertSafeUrl(currentUrl);
    const res = await fetch(currentUrl, {
      method: 'GET',
      redirect: 'manual',
      signal,
      headers: extraHeaders,
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      await res.body?.cancel().catch(() => {});
      if (!loc) throw new HttpError(422, 'Redirect location missing on media host.');
      currentUrl = new URL(loc, currentUrl).toString();
      continue;
    }
    return res;
  }
  throw new HttpError(422, 'Too many redirects on upstream media stream.');
}

async function verifyStreamTargetReachable(streamUrl: string, ffmpegHeaders?: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const reqHeaders: Record<string, string> = {
      'User-Agent': HTTP_USER_AGENT,
      Accept: '*/*',
      Range: 'bytes=0-1',
      ...parseRawHeadersToMap(ffmpegHeaders),
    };
    const res = await fetchWithSsrfRedirects(streamUrl, reqHeaders, controller.signal);
    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    const contentRange = res.headers.get('content-range');
    const contentLength = res.headers.get('content-length');
    await res.body?.cancel().catch(() => {});
    if (!res.ok || contentType.includes('text/html')) {
      return false;
    }
    if (contentRange) {
      const totalMatch = /\/(\d+)$/.exec(contentRange);
      if (totalMatch && Number(totalMatch[1]) > MAX_FILE_SIZE_BYTES) {
        throw new HttpError(413, 'Media exceeds the 500 MB maximum file size limit.');
      }
    } else if (contentLength && Number(contentLength) > MAX_FILE_SIZE_BYTES) {
      throw new HttpError(413, 'Media exceeds the 500 MB maximum file size limit.');
    }
    return true;
  } catch (err) {
    if (err instanceof HttpError && err.status === 413) throw err;
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function proxyUpstreamMediaStream(
  res: Response,
  streamUrl: string,
  filename: string,
  mimeType: string,
  ffmpegHeaders?: string
): Promise<void> {
  const controller = new AbortController();
  const reqHeaders: Record<string, string> = {
    'User-Agent': HTTP_USER_AGENT,
    Accept: '*/*',
    ...parseRawHeadersToMap(ffmpegHeaders),
  };

  let upstreamRes: globalThis.Response;
  try {
    upstreamRes = await fetchWithSsrfRedirects(streamUrl, reqHeaders, controller.signal);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(422, 'Unable to reach upstream media stream.');
  }

  if (!upstreamRes.ok || !upstreamRes.body) {
    await upstreamRes.body?.cancel().catch(() => {});
    throw new HttpError(422, `Upstream media host returned HTTP ${upstreamRes.status}.`);
  }

  const lenHeader = upstreamRes.headers.get('content-length');
  if (lenHeader && Number(lenHeader) > MAX_FILE_SIZE_BYTES) {
    await upstreamRes.body.cancel().catch(() => {});
    throw new HttpError(413, 'Media exceeds the 500 MB maximum file size limit.');
  }

  res.setHeader('Content-Type', mimeType);
  if (lenHeader && /^\d+$/.test(lenHeader)) {
    res.setHeader('Content-Length', lenHeader);
  }
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');

  const nodeReadable = Readable.fromWeb(upstreamRes.body as unknown as import('stream/web').ReadableStream);
  let total = 0;
  let closed = false;

  const abortAll = () => {
    if (closed) return;
    closed = true;
    controller.abort();
    nodeReadable.destroy();
  };

  res.on('close', abortAll);

  await new Promise<void>((resolve, reject) => {
    nodeReadable.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_FILE_SIZE_BYTES) {
        abortAll();
        reject(new HttpError(413, 'Media exceeded the 500 MB limit during transfer.'));
        return;
      }
      if (!res.write(chunk)) {
        nodeReadable.pause();
        res.once('drain', () => nodeReadable.resume());
      }
    });
    nodeReadable.on('end', () => {
      if (!res.writableEnded) res.end();
      resolve();
    });
    nodeReadable.on('error', (err) => {
      if (!closed) {
        if (!res.headersSent) reject(err);
        else {
          res.destroy();
          resolve();
        }
      } else {
        resolve();
      }
    });
  });
}

async function downloadViaFfmpegDirect(
  mediaUrl: string,
  quality: QualityPreset,
  tempDir: string,
  ffmpegHeaders?: string,
  titleOverride?: string,
  probeMetaOverride?: DirectProbeMeta,
  durationOverride?: number | null,
  onProgress?: (percent: number, stage: string, detail?: string) => void,
  onSpawn?: (proc: ChildProcess) => void
): Promise<{ filePath: string; title: string }> {
  const probed =
    titleOverride && probeMetaOverride
      ? { title: titleOverride, duration: durationOverride ?? null, probeMeta: probeMetaOverride }
      : await probeDirectMedia(mediaUrl, ffmpegHeaders);
  onProgress?.(10, 'Downloading source media…');
  const localInput = await downloadStreamToTempFile(mediaUrl, tempDir, ffmpegHeaders);
  const ext = quality === 'mp3' ? 'mp3' : 'mp4';
  const outPath = path.join(tempDir, `output.${ext}`);
  const inputHeaderArgs = localInput
    ? []
    : ffmpegHeaders
    ? ['-user_agent', HTTP_USER_AGENT, '-headers', ffmpegHeaders]
    : ['-user_agent', HTTP_USER_AGENT];
  const ffmpegInput = localInput || mediaUrl;

  let ffmpegArgs: string[];
  if (quality === 'mp3') {
    onProgress?.(45, 'Converting audio to MP3…');
    ffmpegArgs = [
      '-y',
      ...inputHeaderArgs,
      '-i',
      ffmpegInput,
      '-vn',
      '-acodec',
      'libmp3lame',
      '-b:a',
      '192k',
      '-progress',
      'pipe:1',
      '-nostats',
      outPath,
    ];
  } else {
    const targetH = Number(quality.replace('p', ''));
    const pm = probed.probeMeta;
    const canCopyVideo = pm && pm.videoCodec === 'h264' && (!pm.height || pm.height <= targetH + 80);
    if (canCopyVideo) {
      onProgress?.(60, `Remuxing ${quality.toUpperCase()} MP4…`);
      ffmpegArgs = [
        '-y',
        ...inputHeaderArgs,
        '-i',
        ffmpegInput,
        '-c:v',
        'copy',
        ...(pm.audioCodec === 'aac' ? ['-c:a', 'copy'] : ['-c:a', 'aac']),
        '-movflags',
        '+faststart',
        '-progress',
        'pipe:1',
        '-nostats',
        outPath,
      ];
    } else {
      onProgress?.(25, `Transcoding ${quality.toUpperCase()} MP4…`);
      ffmpegArgs = [
        '-y',
        ...inputHeaderArgs,
        '-i',
        ffmpegInput,
        '-vf',
        `scale=-2:'min(${targetH},ih)'`,
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-crf',
        '23',
        '-threads',
        '0',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-movflags',
        '+faststart',
        '-progress',
        'pipe:1',
        '-nostats',
        outPath,
      ];
    }
  }

  await new Promise<void>((resolve, reject) => {
    const proc = spawn('ffmpeg', ffmpegArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    onSpawn?.(proc);
    const totalSec = probed.duration || durationOverride || 0;
    let buf = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() || '';
      for (const line of lines) {
        const m = /^out_time_us=(\d+)/.exec(line.trim());
        if (m && totalSec > 0) {
          const outSec = Number(m[1]) / 1_000_000;
          const pct = Math.max(15, Math.min(98, Math.round((outSec / totalSec) * 100)));
          onProgress?.(
            pct,
            quality === 'mp3' ? `Converting to MP3 (${pct}%)…` : `Processing ${quality.toUpperCase()} (${pct}%)…`
          );
        }
      }
    });
    const timeout = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new HttpError(422, 'Media transcoding timed out.'));
    }, 120_000);
    proc.on('exit', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new HttpError(422, 'FFmpeg failed to process the media stream.'));
    });
    proc.on('error', () => {
      clearTimeout(timeout);
      reject(new HttpError(422, 'FFmpeg binary is unavailable.'));
    });
  });

  return { filePath: outPath, title: probed.title };
}

async function startServer() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  // Security headers & restricted CORS
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' https: data:; connect-src 'self';"
    );

    const origin = req.headers.origin;
    const expectedOrigin = ALLOWED_ORIGIN || `${req.protocol}://${req.get('host')}`;
    if (origin && origin === expectedOrigin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/sites', async (_req, res) => {
    const list = await getSupportedSites();
    res.json(list);
  });

  app.post('/api/info', async (req, res) => {
    try {
      enforceRateLimit(req);
      const rawUrl = req.body?.url;
      const info = await resolveInfo(rawUrl);
      console.info(`[info] ok host=${redactUrlForLog(rawUrl)}`);
      res.json(info);
    } catch (err) {
      if (err instanceof HttpError) {
        res.status(err.status).json({ detail: err.message });
        return;
      }
      res.status(422).json({ detail: 'Unable to inspect the requested link.' });
    }
  });

  interface DownloadJob {
    id: string;
    createdAt: number;
    url: string;
    quality: QualityPreset;
    status: 'processing' | 'ready' | 'error' | 'cancelled';
    mode: 'stream' | 'file';
    stage: string;
    percent: number | null;
    detail: string | null;
    filename: string;
    mimeType: string;
    fileSize: number | null;
    tempDir: string;
    filePath: string;
    streamTarget?: FastStreamCandidate;
    activeProc?: ChildProcess | null;
    error?: string;
    errorStatus?: number;
  }

  const jobs = new Map<string, DownloadJob>();

  const cleanupJobFiles = async (job: DownloadJob) => {
    if (job.activeProc && !job.activeProc.killed) {
      try {
        job.activeProc.kill('SIGKILL');
      } catch {
        // Ignore kill errors
      }
      job.activeProc = null;
    }
    if (job.tempDir) {
      await cleanupTempDir(job.tempDir);
      job.tempDir = '';
    }
  };

  setInterval(() => {
    const now = Date.now();
    for (const [id, job] of jobs.entries()) {
      if (now - job.createdAt > 5 * 60_000) {
        void cleanupJobFiles(job);
        jobs.delete(id);
      }
    }
  }, 60_000).unref();

  function buildYtDlpDownloadArgs(
    source: CachedResolvedSource,
    quality: QualityPreset,
    outTemplate: string
  ): string[] {
    const args = [
      ...baseYtDlpArgs(),
      ...source.extraArgs,
      '--newline',
      '--progress',
      '--max-filesize',
      '500M',
      '--output',
      outTemplate,
    ];
    if (quality === 'mp3') {
      args.push('-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '192K');
    } else {
      const height = quality.replace('p', '');
      args.push(
        '-f',
        `bv*[height<=${height}][ext=mp4]+ba[ext=m4a]/b[height<=${height}][ext=mp4]/bv*[height<=${height}]+ba/b[height<=${height}]/b`,
        '--merge-output-format',
        'mp4'
      );
    }
    args.push(source.resolvedTargetUrl);
    return args;
  }

  async function runYtDlpDownloadWithProgress(
    ytDlpBin: string,
    args: string[],
    onProgress?: (percent: number, stage: string, detail?: string) => void,
    onSpawn?: (proc: ChildProcess) => void
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(ytDlpBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      onSpawn?.(proc);
      let stderrText = '';
      let outBuf = '';

      const parseLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        const pctMatch = /\[download\]\s+(\d+(?:\.\d+)?)%(?:\s+of\s+~?([^\s]+))?(?:\s+at\s+([^\s]+))?/i.exec(
          trimmed
        );
        if (pctMatch) {
          const pct = Math.max(0, Math.min(99, Math.round(Number(pctMatch[1]))));
          const sizePart = pctMatch[2] ? `${pctMatch[2]}` : '';
          const speedPart = pctMatch[3] ? ` @ ${pctMatch[3]}` : '';
          onProgress?.(
            pct,
            `Downloading stream (${pct}%)…`,
            sizePart || speedPart ? `${sizePart}${speedPart}`.trim() : undefined
          );
          return;
        }
        if (/\[(?:Merger|ExtractAudio|VideoConvertor|FixupM3u8)\]/i.test(trimmed)) {
          onProgress?.(98, 'Finalizing MP4/MP3 file…');
        }
      };

      proc.stdout?.on('data', (chunk: Buffer) => {
        outBuf += chunk.toString();
        const lines = outBuf.split(/[\r\n]+/);
        outBuf = lines.pop() || '';
        lines.forEach(parseLine);
      });
      proc.stderr?.on('data', (chunk: Buffer) => {
        stderrText += chunk.toString();
      });

      const timeout = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new HttpError(422, 'Extraction timed out while waiting for the remote media host.'));
      }, 180_000);

      proc.on('exit', (code) => {
        clearTimeout(timeout);
        if (code === 0) resolve();
        else reject(mapYtDlpError({ stderr: stderrText }));
      });
      proc.on('error', (err) => {
        clearTimeout(timeout);
        reject(mapYtDlpError(err));
      });
    });
  }

  const isCancelled = (job: DownloadJob): boolean => job.status === 'cancelled';

  async function processDownloadJob(job: DownloadJob) {
    try {
      const source = await resolveSourceCached(job.url);
      if (isCancelled(job)) return;

      const ext = job.quality === 'mp3' ? 'mp3' : 'mp4';
      const mimeType = job.quality === 'mp3' ? 'audio/mpeg' : 'video/mp4';
      job.filename = sanitizeFilename(source.publicInfo.title, ext);
      job.mimeType = mimeType;

      // Fast path: stream progressive MP4 directly from upstream without temp disk buffering or CPU transcoding
      const fastCandidate = selectFastStreamCandidate(source, job.quality);
      if (fastCandidate) {
        job.stage = 'Connecting to MP4 stream…';
        const reachable = await verifyStreamTargetReachable(
          fastCandidate.streamUrl,
          fastCandidate.ffmpegHeaders
        );
        if (isCancelled(job)) return;
        if (reachable) {
          job.mode = 'stream';
          job.streamTarget = fastCandidate;
          job.percent = 100;
          job.stage = 'Stream ready — starting download';
          job.detail = 'Direct MP4 pass-through';
          job.status = 'ready';
          return;
        }
      }

      job.tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'clipgrab-'));
      if (isCancelled(job)) {
        await cleanupJobFiles(job);
        return;
      }

      const ytDlpBin = await getYtDlpBin();
      if (source.kind === 'html-direct' || source.kind === 'direct-probe' || !ytDlpBin) {
        const result = await downloadViaFfmpegDirect(
          source.resolvedTargetUrl,
          job.quality,
          job.tempDir,
          source.ffmpegHeaders,
          source.publicInfo.title,
          source.directProbe,
          source.publicInfo.duration,
          (pct, stage, detail) => {
            if (job.status === 'processing') {
              job.percent = pct;
              job.stage = stage;
              if (detail) job.detail = detail;
            }
          },
          (proc) => {
            job.activeProc = proc;
          }
        );
        job.activeProc = null;
        if (isCancelled(job)) {
          await cleanupJobFiles(job);
          return;
        }
        const stat = await fsp.stat(result.filePath);
        if (stat.size > MAX_FILE_SIZE_BYTES) {
          throw new HttpError(413, 'Processed file exceeds the 500 MB limit.');
        }
        job.mode = 'file';
        job.filePath = result.filePath;
        job.fileSize = stat.size;
        job.percent = 100;
        job.stage = 'Ready — starting download';
        job.status = 'ready';
        return;
      }

      job.stage = `Fetching ${job.quality.toUpperCase()} stream…`;
      const outTemplate = path.join(job.tempDir, 'output.%(ext)s');
      const args = buildYtDlpDownloadArgs(source, job.quality, outTemplate);
      await runYtDlpDownloadWithProgress(
        ytDlpBin,
        args,
        (pct, stage, detail) => {
          if (job.status === 'processing') {
            job.percent = pct;
            job.stage = stage;
            if (detail !== undefined) job.detail = detail;
          }
        },
        (proc) => {
          job.activeProc = proc;
        }
      );
      job.activeProc = null;
      if (isCancelled(job)) {
        await cleanupJobFiles(job);
        return;
      }

      const files = await fsp.readdir(job.tempDir);
      const targetFile = files.find((f) => !f.endsWith('.part') && !f.endsWith('.ytdl'));
      if (!targetFile) {
        throw new HttpError(422, 'Extraction produced no output file.');
      }

      const fullOutPath = path.join(job.tempDir, targetFile);
      const stat = await fsp.stat(fullOutPath);
      if (stat.size > MAX_FILE_SIZE_BYTES) {
        throw new HttpError(413, 'Processed file exceeds the 500 MB limit.');
      }

      job.mode = 'file';
      job.filePath = fullOutPath;
      job.fileSize = stat.size;
      job.percent = 100;
      job.stage = 'Ready — starting download';
      job.status = 'ready';
    } catch (err) {
      await cleanupJobFiles(job);
      if (job.status === 'cancelled') return;
      if (err instanceof HttpError) {
        job.status = 'error';
        job.error = err.message;
        job.errorStatus = err.status;
      } else {
        job.status = 'error';
        job.error = 'Unable to download media from the provided link.';
        job.errorStatus = 422;
      }
    }
  }

  app.post('/api/jobs', async (req, res) => {
    try {
      enforceRateLimit(req);
      const rawUrl = String(req.body?.url || '');
      const quality = String(req.body?.quality || '720p') as QualityPreset;
      const allowedQualities: QualityPreset[] = ['1080p', '720p', '480p', 'mp3'];
      if (!allowedQualities.includes(quality)) {
        res.status(400).json({ detail: 'Invalid quality preset. Use 1080p, 720p, 480p, or mp3.' });
        return;
      }
      const parsedUrl = await validateAndAssertSafeUrl(rawUrl);
      const job: DownloadJob = {
        id: crypto.randomUUID(),
        createdAt: Date.now(),
        url: parsedUrl.toString(),
        quality,
        status: 'processing',
        mode: 'file',
        stage: 'Resolving stream…',
        percent: null,
        detail: null,
        filename: `clipgrab_${quality}.${quality === 'mp3' ? 'mp3' : 'mp4'}`,
        mimeType: quality === 'mp3' ? 'audio/mpeg' : 'video/mp4',
        fileSize: null,
        tempDir: '',
        filePath: '',
      };
      jobs.set(job.id, job);
      void processDownloadJob(job);

      res.status(202).json({
        id: job.id,
        status: job.status,
        mode: job.mode,
        stage: job.stage,
        percent: job.percent,
        detail: job.detail,
        filename: job.filename,
        fileSize: job.fileSize,
      });
    } catch (err) {
      if (err instanceof HttpError) {
        res.status(err.status).json({ detail: err.message });
        return;
      }
      res.status(422).json({ detail: 'Unable to start download job.' });
    }
  });

  app.get('/api/jobs/:id', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) {
      res.status(404).json({ detail: 'Download job not found or expired.' });
      return;
    }
    res.json({
      id: job.id,
      status: job.status,
      mode: job.mode,
      stage: job.stage,
      percent: job.percent,
      detail: job.detail,
      filename: job.filename,
      fileSize: job.fileSize,
      error: job.error || null,
      errorStatus: job.errorStatus || null,
    });
  });

  app.get('/api/jobs/:id/file', async (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job || job.status !== 'ready') {
      res.status(404).json({ detail: 'Download file not ready or expired.' });
      return;
    }
    try {
      if (job.mode === 'stream' && job.streamTarget) {
        await proxyUpstreamMediaStream(
          res,
          job.streamTarget.streamUrl,
          job.filename,
          job.mimeType,
          job.streamTarget.ffmpegHeaders
        );
        return;
      }
      if (!job.filePath || !fs.existsSync(job.filePath)) {
        res.status(404).json({ detail: 'Prepared file is no longer available.' });
        return;
      }
      const dirToClean = job.tempDir;
      job.tempDir = '';
      jobs.delete(job.id);
      await streamFileWithCleanup(res, job.filePath, job.filename, job.mimeType, dirToClean);
    } catch (err) {
      if (!res.headersSent) {
        if (err instanceof HttpError) {
          res.status(err.status).json({ detail: err.message });
          return;
        }
        res.status(422).json({ detail: 'Failed to stream prepared media.' });
      }
    }
  });

  app.delete('/api/jobs/:id', async (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) {
      res.status(204).end();
      return;
    }
    job.status = 'cancelled';
    await cleanupJobFiles(job);
    jobs.delete(req.params.id);
    res.status(204).end();
  });

  app.get('/api/download', async (req, res) => {
    const rawUrl = String(req.query.url || '');
    const quality = String(req.query.quality || '720p') as QualityPreset;
    const allowedQualities: QualityPreset[] = ['1080p', '720p', '480p', 'mp3'];

    if (!allowedQualities.includes(quality)) {
      res.status(400).json({ detail: 'Invalid quality preset. Use 1080p, 720p, 480p, or mp3.' });
      return;
    }

    let tempDir = '';
    try {
      enforceRateLimit(req);
      const source = await resolveSourceCached(rawUrl);
      const ext = quality === 'mp3' ? 'mp3' : 'mp4';
      const cleanName = sanitizeFilename(source.publicInfo.title, ext);
      const mimeType = quality === 'mp3' ? 'audio/mpeg' : 'video/mp4';

      // Fast path: stream progressive MP4 directly without waiting for full disk download/re-encode
      const fastCandidate = selectFastStreamCandidate(source, quality);
      if (fastCandidate) {
        const reachable = await verifyStreamTargetReachable(
          fastCandidate.streamUrl,
          fastCandidate.ffmpegHeaders
        );
        if (reachable) {
          console.info(`[download] ok stream quality=${quality} target=${redactUrlForLog(rawUrl)}`);
          await proxyUpstreamMediaStream(
            res,
            fastCandidate.streamUrl,
            cleanName,
            mimeType,
            fastCandidate.ffmpegHeaders
          );
          return;
        }
      }

      tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'clipgrab-'));
      const ytDlpBin = await getYtDlpBin();

      if (source.kind === 'html-direct' || source.kind === 'direct-probe' || !ytDlpBin) {
        const { filePath, title } = await downloadViaFfmpegDirect(
          source.resolvedTargetUrl,
          quality,
          tempDir,
          source.ffmpegHeaders,
          source.publicInfo.title,
          source.directProbe,
          source.publicInfo.duration
        );
        console.info(`[download] ok direct quality=${quality} target=${redactUrlForLog(rawUrl)}`);
        await streamFileWithCleanup(res, filePath, sanitizeFilename(title, ext), mimeType, tempDir);
        return;
      }

      const outTemplate = path.join(tempDir, 'output.%(ext)s');
      const args = buildYtDlpDownloadArgs(source, quality, outTemplate);
      await runYtDlpDownloadWithProgress(ytDlpBin, args);

      const files = await fsp.readdir(tempDir);
      const targetFile = files.find((f) => !f.endsWith('.part') && !f.endsWith('.ytdl'));
      if (!targetFile) {
        throw new HttpError(422, 'Extraction produced no output file.');
      }

      console.info(`[download] ok quality=${quality} target=${redactUrlForLog(rawUrl)}`);
      await streamFileWithCleanup(res, path.join(tempDir, targetFile), cleanName, mimeType, tempDir);
    } catch (err) {
      if (tempDir) await cleanupTempDir(tempDir);
      if (!res.headersSent) {
        if (err instanceof HttpError) {
          res.status(err.status).json({ detail: err.message });
          return;
        }
        res.status(422).json({ detail: 'Unable to download media from the provided link.' });
      }
    }
  });

  app.post('/api/takedown', (req, res) => {
    const { name, organization, email, targetUrls } = req.body || {};
    if (!name || !organization || !email || !targetUrls) {
      res.status(400).json({ detail: 'All required takedown fields must be provided.' });
      return;
    }
    console.info(`[dmca] takedown request received from org=${String(organization).slice(0, 64)}`);
    res.json({
      ok: true,
      message:
        'Takedown notice logged. Verified domains are added to the BLOCKED_DOMAINS blocklist (HTTP 403). Contact: dmca@clipgrab.local.',
    });
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`ClipGrab server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
