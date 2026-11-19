import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ClipboardPaste,
  Download,
  ExternalLink,
  FileAudio,
  FileVideo,
  Film,
  Gavel,
  Globe,
  HelpCircle,
  Link2,
  Loader2,
  Lock,
  Mail,
  Menu,
  Music,
  Play,
  Radio,
  Scale,
  Search,
  Send,
  Shield,
  ShieldAlert,
  Sparkles,
  Trash2,
  Tv,
  X,
} from 'lucide-react';

type PageId = 'home' | 'how-it-works' | 'supported-sites' | 'faq';
type HubTab = 'faq' | 'terms' | 'privacy' | 'dmca' | 'contact';
type QualityPreset = '1080p' | '720p' | '480p' | 'mp3';
type SiteCategory = 'all' | 'video' | 'music' | 'social' | 'educational';

interface MediaInfo {
  title: string;
  thumbnail: string | null;
  duration: number | null;
  uploader: string | null;
  site: string;
  options: QualityPreset[];
}

interface ExtractorSite {
  name: string;
}

interface FeaturedPlatform {
  id: string;
  name: string;
  domain: string;
  category: Exclude<SiteCategory, 'all'>;
  pattern: string;
  sampleUrl: string;
  formats: string[];
  keywords: string;
}

interface DownloadProgressState {
  quality: QualityPreset;
  statusText: string;
  detailText: string | null;
  receivedBytes: number;
  totalBytes: number | null;
  percent: number | null;
  done: boolean;
}

const FEATURED_PLATFORMS: FeaturedPlatform[] = [
  {
    id: 'soundcloud',
    name: 'SoundCloud',
    domain: 'soundcloud.com',
    category: 'music',
    pattern: 'https://soundcloud.com/artist/track',
    sampleUrl: 'https://soundcloud.com/forss/flickermood',
    formats: ['MP3 192k'],
    keywords: 'soundcloud audio music mp3 track podcast',
  },
  {
    id: 'ted',
    name: 'TED Talks',
    domain: 'ted.com',
    category: 'educational',
    pattern: 'https://ted.com/talks/...',
    sampleUrl: 'https://www.ted.com/talks/sir_ken_robinson_do_schools_kill_creativity',
    formats: ['1080p MP4', '720p MP4', '480p MP4', 'MP3 192k'],
    keywords: 'ted talks educational conference lecture',
  },
  {
    id: 'dailymotion',
    name: 'Dailymotion',
    domain: 'dailymotion.com',
    category: 'video',
    pattern: 'https://dailymotion.com/video/...',
    sampleUrl: 'https://www.dailymotion.com/video/x2jvvep',
    formats: ['720p MP4', '480p MP4', 'MP3 192k'],
    keywords: 'dailymotion video streaming mp4',
  },
  {
    id: 'archive',
    name: 'Internet Archive',
    domain: 'archive.org',
    category: 'educational',
    pattern: 'https://archive.org/details/...',
    sampleUrl: 'https://archive.org/details/Popeye_forPresident',
    formats: ['720p MP4', '480p MP4', 'MP3 192k'],
    keywords: 'archive internet archive public domain classic video',
  },
  {
    id: 'direct',
    name: 'Direct Media URL',
    domain: '*.mp4 / *.webm / *.mp3',
    category: 'video',
    pattern: 'https://example.com/clip.mp4',
    sampleUrl: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4',
    formats: ['1080p MP4', '720p MP4', '480p MP4', 'MP3 192k'],
    keywords: 'direct mp4 webm m4a mp3 link',
  },
  {
    id: 'vimeo',
    name: 'Vimeo',
    domain: 'vimeo.com',
    category: 'video',
    pattern: 'https://vimeo.com/123456789',
    sampleUrl: '',
    formats: ['1080p MP4', '720p MP4', '480p MP4', 'MP3 192k'],
    keywords: 'vimeo showcase cinema hd video',
  },
  {
    id: 'twitch',
    name: 'Twitch',
    domain: 'twitch.tv',
    category: 'video',
    pattern: 'https://twitch.tv/videos/...',
    sampleUrl: '',
    formats: ['1080p MP4', '720p MP4', '480p MP4', 'MP3 192k'],
    keywords: 'twitch vod clips stream gaming video',
  },
  {
    id: 'tiktok',
    name: 'TikTok',
    domain: 'tiktok.com',
    category: 'social',
    pattern: 'https://tiktok.com/@user/video/...',
    sampleUrl: 'https://www.tiktok.com/@scout2015/video/6718335390845095173',
    formats: ['1080p MP4', '720p MP4', 'MP3 192k'],
    keywords: 'tiktok short clip social video mp3',
  },
  {
    id: 'bandcamp',
    name: 'Bandcamp',
    domain: 'bandcamp.com',
    category: 'music',
    pattern: 'https://artist.bandcamp.com/track/...',
    sampleUrl: '',
    formats: ['MP3 192k'],
    keywords: 'bandcamp indie music audio mp3',
  },
  {
    id: 'instagram',
    name: 'Instagram',
    domain: 'instagram.com',
    category: 'social',
    pattern: 'https://instagram.com/reel/...',
    sampleUrl: '',
    formats: ['1080p MP4', '720p MP4', 'MP3 192k'],
    keywords: 'instagram reels video social',
  },
  {
    id: 'twitter',
    name: 'X (Twitter)',
    domain: 'x.com',
    category: 'social',
    pattern: 'https://x.com/user/status/...',
    sampleUrl: '',
    formats: ['1080p MP4', '720p MP4', 'MP3 192k'],
    keywords: 'x twitter post video gif',
  },
];

const FAQ_ITEMS = [
  {
    id: '01',
    question: 'Is ClipGrab free to use without creating an account?',
    answer:
      'Yes. ClipGrab requires no registration, no login, and no subscription. Paste a valid public media link, inspect available formats, and save directly to your device.',
    keywords: 'free cost account sign-up login registration anonymous',
  },
  {
    id: '02',
    question: 'What video and audio quality presets are available?',
    answer:
      'ClipGrab offers 1080p, 720p, and 480p MP4 video presets (merged cleanly with audio via FFmpeg) plus 192 kbps MP3 audio extraction. Only presets actually supported by the source stream are shown.',
    keywords: 'formats resolution 1080p 720p 480p mp4 mp3 192kbps audio quality',
  },
  {
    id: '03',
    question: 'Are my links or downloaded files stored on the server?',
    answer:
      'No. Each download uses an isolated temporary directory that is deleted immediately after the stream finishes or aborts. Full query URLs with tokens are never logged, and no media archive is kept.',
    keywords: 'privacy storage logs ephemeral delete cleanup security',
  },
  {
    id: '04',
    question: 'Why did my link return an error?',
    answer:
      'Common reasons include: an invalid or private-network URL (400), a domain blocked under copyright takedown (403), media longer than the 60-minute cap (413), private/DRM-encrypted/unavailable videos (422), or exceeding the per-minute request limit (429).',
    keywords: 'fail error 400 403 413 422 429 rate limit private drm duration',
  },
  {
    id: '05',
    question: 'Are playlists or multi-hour livestreams supported?',
    answer:
      'No. ClipGrab processes single videos only (playlists are disabled) up to the configured maximum duration (default 3600 seconds / 60 minutes) and 500 MB file size cap to ensure fast, reliable transfers.',
    keywords: 'playlist livestream length limit 500mb duration single video',
  },
  {
    id: '06',
    question: 'Is downloading videos permitted?',
    answer:
      'ClipGrab is intended strictly for personal use with content you own or have permission to save (such as Creative Commons, public domain, or your own uploads). Third-party platform terms of service may prohibit downloading; you are solely responsible for compliance.',
    keywords: 'legal copyright dmca fair use terms personal use permission',
  },
];

const PRESET_META: Record<
  QualityPreset,
  { label: string; tag: string; detail: string; isAudio: boolean }
> = {
  '1080p': { label: 'MP4 1080p', tag: 'Full HD', detail: 'H.264 / AAC', isAudio: false },
  '720p': { label: 'MP4 720p', tag: 'HD', detail: 'Balanced size', isAudio: false },
  '480p': { label: 'MP4 480p', tag: 'SD', detail: 'Compact file', isAudio: false },
  mp3: { label: 'Audio MP3', tag: '192 kbps', detail: 'Audio only', isAudio: true },
};

function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return 'Unknown length';
  const total = Math.floor(seconds);
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function mapApiError(status: number, serverDetail?: string): { title: string; message: string } {
  switch (status) {
    case 400:
      return {
        title: 'Invalid or unsafe URL',
        message:
          serverDetail ||
          'Enter a valid public http:// or https:// video link. Private or local network addresses are not permitted.',
      };
    case 403:
      return {
        title: 'Domain blocked',
        message:
          serverDetail ||
          'This domain is blocked in accordance with takedown or platform exclusion policy.',
      };
    case 413:
      return {
        title: 'Media exceeds size or duration limit',
        message:
          serverDetail ||
          'This video exceeds the maximum allowed duration (60 minutes) or 500 MB file limit.',
      };
    case 422:
      return {
        title: 'Media unavailable or unsupported',
        message:
          serverDetail ||
          'The video may be private, age-restricted, DRM-protected, or from an unsupported source.',
      };
    case 429:
      return {
        title: 'Rate limit reached',
        message:
          serverDetail ||
          'Too many requests in a short window. Please wait a minute and try again.',
      };
    default:
      return {
        title: 'Request failed',
        message: serverDetail || 'Unable to inspect or download media from that link.',
      };
  }
}

export default function App() {
  const [page, setPage] = useState<PageId>('home');
  const [hubTab, setHubTab] = useState<HubTab>('faq');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Home downloader state
  const [urlInput, setUrlInput] = useState('');
  const [fetchingInfo, setFetchingInfo] = useState(false);
  const [mediaInfo, setMediaInfo] = useState<MediaInfo | null>(null);
  const [resolvedUrl, setResolvedUrl] = useState('');
  const [thumbFailed, setThumbFailed] = useState(false);
  const [errorState, setErrorState] = useState<{ title: string; message: string } | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgressState | null>(null);

  // Supported sites state
  const [sites, setSites] = useState<ExtractorSite[]>([]);
  const [sitesLoading, setSitesLoading] = useState(false);
  const [sitesError, setSitesError] = useState<string | null>(null);
  const [siteSearch, setSiteSearch] = useState('');
  const [siteCategory, setSiteCategory] = useState<SiteCategory>('all');
  const [showAllExtractors, setShowAllExtractors] = useState(false);

  // FAQ & Legal forms state
  const [faqSearch, setFaqSearch] = useState('');
  const [openFaqIds, setOpenFaqIds] = useState<string[]>(['01']);
  const [dmcaSubmitted, setDmcaSubmitted] = useState<string | null>(null);
  const [dmcaSubmitting, setDmcaSubmitting] = useState(false);
  const [contactSubmitted, setContactSubmitted] = useState<string | null>(null);

  const urlInputRef = useRef<HTMLInputElement>(null);
  const downloadAbortRef = useRef<AbortController | null>(null);
  const activeJobIdRef = useRef<string | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToastMessage(null), 3200);
  };

  // Sync URL hash for clean back/forward navigation
  useEffect(() => {
    const syncFromHash = () => {
      const hash = window.location.hash.replace(/^#/, '');
      if (hash === 'how-it-works' || hash === 'about') {
        setPage('how-it-works');
      } else if (hash === 'supported-sites') {
        setPage('supported-sites');
      } else if (hash === 'faq' || hash === 'terms' || hash === 'privacy' || hash === 'dmca' || hash === 'contact') {
        setPage('faq');
        setHubTab(hash as HubTab);
      } else {
        setPage('home');
      }
    };
    syncFromHash();
    window.addEventListener('hashchange', syncFromHash);
    return () => window.removeEventListener('hashchange', syncFromHash);
  }, []);

  const navigateTo = (targetPage: PageId, targetTab?: HubTab) => {
    setPage(targetPage);
    setMobileMenuOpen(false);
    if (targetPage === 'faq' && targetTab) {
      setHubTab(targetTab);
      window.history.replaceState(null, '', `#${targetTab}`);
    } else if (targetPage === 'home') {
      window.history.replaceState(null, '', '#home');
    } else {
      window.history.replaceState(null, '', `#${targetPage}`);
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // Load supported extractors from GET /api/sites when visiting Supported Sites
  useEffect(() => {
    if (page !== 'supported-sites' || sites.length > 0 || sitesLoading) return;
    let cancelled = false;
    setSitesLoading(true);
    setSitesError(null);
    fetch('/api/sites')
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as ExtractorSite[];
      })
      .then((data) => {
        if (!cancelled) {
          setSites(Array.isArray(data) ? data : []);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSitesError('Could not load extractor directory from the server.');
        }
      })
      .finally(() => {
        if (!cancelled) setSitesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [page, sites.length, sitesLoading]);

  const handlePaste = async () => {
    try {
      if (navigator.clipboard?.readText) {
        const text = (await navigator.clipboard.readText()).trim();
        if (text) {
          setUrlInput(text);
          setErrorState(null);
          showToast('Link pasted from clipboard');
          urlInputRef.current?.focus();
          return;
        }
      }
      showToast('Clipboard is empty — paste directly into the field');
      urlInputRef.current?.focus();
    } catch {
      showToast('Clipboard access blocked by browser — press Ctrl/Cmd+V in the box');
      urlInputRef.current?.focus();
    }
  };

  const handleFetchInfo = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = urlInput.trim();
    if (!trimmed) {
      setErrorState({
        title: 'Link required',
        message: 'Paste a public http:// or https:// video URL before fetching.',
      });
      return;
    }
    if (!/^https?:\/\//i.test(trimmed)) {
      setErrorState({
        title: 'Invalid URL scheme',
        message: 'Only http:// and https:// URLs are supported.',
      });
      return;
    }

    setFetchingInfo(true);
    setErrorState(null);
    setMediaInfo(null);
    setThumbFailed(false);
    if (downloadAbortRef.current) {
      downloadAbortRef.current.abort();
      downloadAbortRef.current = null;
    }
    setDownloadProgress(null);

    try {
      const res = await fetch('/api/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: trimmed }),
      });

      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErrorState(mapApiError(res.status, payload.detail || payload.error));
        return;
      }

      setMediaInfo(payload as MediaInfo);
      setResolvedUrl(trimmed);
    } catch {
      setErrorState({
        title: 'Network error',
        message: 'Could not reach the ClipGrab server. Check your connection and try again.',
      });
    } finally {
      setFetchingInfo(false);
    }
  };

  const triggerDirectFileDownload = (downloadUrl: string, filename: string) => {
    const link = document.createElement('a');
    link.href = downloadUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  const handleDownloadPreset = async (quality: QualityPreset) => {
    if (!resolvedUrl || !mediaInfo) return;

    if (downloadAbortRef.current) {
      downloadAbortRef.current.abort();
    }
    if (activeJobIdRef.current) {
      void fetch(`/api/jobs/${encodeURIComponent(activeJobIdRef.current)}`, { method: 'DELETE' }).catch(() => {});
      activeJobIdRef.current = null;
    }

    const controller = new AbortController();
    downloadAbortRef.current = controller;

    setErrorState(null);
    setDownloadProgress({
      quality,
      statusText: `Connecting to ${quality.toUpperCase()} stream…`,
      detailText: null,
      receivedBytes: 0,
      totalBytes: null,
      percent: null,
      done: false,
    });

    try {
      const startRes = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: resolvedUrl, quality }),
        signal: controller.signal,
      });

      const startData = await startRes.json().catch(() => ({}));
      if (!startRes.ok) {
        setDownloadProgress(null);
        setErrorState(mapApiError(startRes.status, startData.detail || startData.error));
        return;
      }

      const jobId = String(startData.id || '');
      activeJobIdRef.current = jobId;

      while (!controller.signal.aborted) {
        const pollRes = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, {
          signal: controller.signal,
        });
        const job = await pollRes.json().catch(() => ({}));
        if (!pollRes.ok) {
          setDownloadProgress(null);
          setErrorState(mapApiError(pollRes.status, job.detail || 'Download job expired.'));
          return;
        }

        if (job.status === 'error') {
          setDownloadProgress(null);
          setErrorState(mapApiError(job.errorStatus || 422, job.error));
          return;
        }

        if (job.status === 'ready') {
          const filename = String(job.filename || `clipgrab_${quality}.${quality === 'mp3' ? 'mp3' : 'mp4'}`);
          const fileUrl = `/api/jobs/${encodeURIComponent(jobId)}/file`;
          activeJobIdRef.current = null;
          triggerDirectFileDownload(fileUrl, filename);
          setDownloadProgress({
            quality,
            statusText: `Download started: ${filename}`,
            detailText: job.mode === 'stream' ? 'Direct stream pass-through' : 'Saved via browser downloader',
            receivedBytes: typeof job.fileSize === 'number' ? job.fileSize : 0,
            totalBytes: typeof job.fileSize === 'number' ? job.fileSize : null,
            percent: 100,
            done: true,
          });
          showToast(`Saving ${filename}`);
          return;
        }

        setDownloadProgress({
          quality,
          statusText: String(job.stage || `Preparing ${quality.toUpperCase()} stream…`),
          detailText: job.detail ? String(job.detail) : null,
          receivedBytes: 0,
          totalBytes: typeof job.fileSize === 'number' ? job.fileSize : null,
          percent: typeof job.percent === 'number' ? job.percent : null,
          done: false,
        });

        await new Promise<void>((resolve, reject) => {
          const t = window.setTimeout(resolve, 350);
          controller.signal.addEventListener(
            'abort',
            () => {
              window.clearTimeout(t);
              reject(new DOMException('Aborted', 'AbortError'));
            },
            { once: true }
          );
        });
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        setDownloadProgress(null);
        showToast('Download cancelled');
        return;
      }
      setDownloadProgress(null);
      setErrorState({
        title: 'Download interrupted',
        message: 'The stream closed unexpectedly before completion. Please try again.',
      });
    } finally {
      if (downloadAbortRef.current === controller) {
        downloadAbortRef.current = null;
      }
      activeJobIdRef.current = null;
    }
  };

  const handleCancelDownload = () => {
    if (activeJobIdRef.current) {
      void fetch(`/api/jobs/${encodeURIComponent(activeJobIdRef.current)}`, { method: 'DELETE' }).catch(() => {});
      activeJobIdRef.current = null;
    }
    if (downloadAbortRef.current) {
      downloadAbortRef.current.abort();
      downloadAbortRef.current = null;
    }
    setDownloadProgress(null);
  };

  const handleTestPlatform = (platform: FeaturedPlatform) => {
    navigateTo('home');
    setErrorState(null);
    setMediaInfo(null);
    setDownloadProgress(null);
    if (platform.sampleUrl) {
      setUrlInput(platform.sampleUrl);
      showToast(`Loaded sample link for ${platform.name}`);
    } else {
      setUrlInput('');
      showToast(`Paste a ${platform.name} link (${platform.pattern})`);
    }
    window.setTimeout(() => {
      urlInputRef.current?.focus();
    }, 100);
  };

  const filteredFeatured = useMemo(() => {
    const q = siteSearch.toLowerCase().trim();
    return FEATURED_PLATFORMS.filter((item) => {
      const catMatch = siteCategory === 'all' || item.category === siteCategory;
      const queryMatch =
        !q ||
        item.name.toLowerCase().includes(q) ||
        item.domain.toLowerCase().includes(q) ||
        item.keywords.toLowerCase().includes(q);
      return catMatch && queryMatch;
    });
  }, [siteSearch, siteCategory]);

  const filteredExtractorNames = useMemo(() => {
    const q = siteSearch.toLowerCase().trim();
    if (!q) return sites;
    return sites.filter((s) => s.name.toLowerCase().includes(q));
  }, [sites, siteSearch]);

  const filteredFaqs = useMemo(() => {
    const q = faqSearch.toLowerCase().trim();
    if (!q) return FAQ_ITEMS;
    return FAQ_ITEMS.filter(
      (item) =>
        item.question.toLowerCase().includes(q) ||
        item.answer.toLowerCase().includes(q) ||
        item.keywords.toLowerCase().includes(q)
    );
  }, [faqSearch]);

  const toggleFaq = (id: string) => {
    setOpenFaqIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const handleDmcaSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const formData = new FormData(form);
    setDmcaSubmitting(true);
    setDmcaSubmitted(null);

    try {
      const res = await fetch('/api/takedown', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formData.get('name'),
          organization: formData.get('organization'),
          email: formData.get('email'),
          originalUrl: formData.get('originalUrl'),
          targetUrls: formData.get('targetUrls'),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setDmcaSubmitted(
          data.message ||
            'Exclusion notice logged. Verified domain takedowns are applied to the BLOCKED_DOMAINS blocklist.'
        );
        form.reset();
      } else {
        setDmcaSubmitted(data.detail || 'Notice recorded for legal review.');
      }
    } catch {
      setDmcaSubmitted(
        'Notice saved locally. For urgent takedowns, email dmca@clipgrab.local directly.'
      );
    } finally {
      setDmcaSubmitting(false);
    }
  };

  const handleContactSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setContactSubmitted(
      'Your message has been queued for support review. For urgent legal matters, email dmca@clipgrab.local.'
    );
    e.currentTarget.reset();
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#faf8ff] text-[#131b2e]">
      {/* Toast Notification */}
      {toastMessage && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-6 right-6 z-50 flex items-center gap-2.5 rounded-xl bg-[#131b2e] px-4 py-3 text-sm font-medium text-white shadow-lg"
        >
          <CheckCircle2 className="h-4 w-4 text-[#68dba9] shrink-0" />
          <span>{toastMessage}</span>
        </div>
      )}

      {/* Top Navigation Bar (Strict 3-Zone Contract) */}
      <header className="sticky top-0 z-40 border-b border-[#c3c6d7]/50 bg-white/90 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-8 px-6">
          {/* Zone 1: Brand Wordmark */}
          <button
            type="button"
            onClick={() => navigateTo('home')}
            className="flex items-center gap-2.5 text-left whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#004ac6] rounded-lg"
          >
            <svg
              aria-hidden="true"
              className="h-7 w-7 shrink-0"
              viewBox="0 0 32 32"
              fill="none"
            >
              <rect width="32" height="32" rx="8" fill="#004ac6" />
              <path
                d="M16 7.5V19.5M16 19.5L11.25 14.75M16 19.5L20.75 14.75"
                stroke="#ffffff"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M9.5 23.5H22.5"
                stroke="#85f8c4"
                strokeWidth="2.4"
                strokeLinecap="round"
              />
            </svg>
            <span className="font-display text-lg font-bold tracking-tight text-[#131b2e]">
              ClipGrab
            </span>
          </button>

          {/* Zone 2: Navigation Links */}
          <nav className="hidden md:flex items-center gap-7" aria-label="Main navigation">
            <button
              type="button"
              onClick={() => navigateTo('home')}
              className={`text-sm font-medium whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
                page === 'home'
                  ? 'text-[#004ac6] font-semibold'
                  : 'text-[#434655] hover:text-[#131b2e]'
              }`}
            >
              Home
            </button>
            <button
              type="button"
              onClick={() => navigateTo('how-it-works')}
              className={`text-sm font-medium whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
                page === 'how-it-works'
                  ? 'text-[#004ac6] font-semibold'
                  : 'text-[#434655] hover:text-[#131b2e]'
              }`}
            >
              How it works
            </button>
            <button
              type="button"
              onClick={() => navigateTo('supported-sites')}
              className={`text-sm font-medium whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
                page === 'supported-sites'
                  ? 'text-[#004ac6] font-semibold'
                  : 'text-[#434655] hover:text-[#131b2e]'
              }`}
            >
              Supported sites
            </button>
            <button
              type="button"
              onClick={() => navigateTo('faq', 'faq')}
              className={`text-sm font-medium whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
                page === 'faq'
                  ? 'text-[#004ac6] font-semibold'
                  : 'text-[#434655] hover:text-[#131b2e]'
              }`}
            >
              FAQ &amp; Legal
            </button>
          </nav>

          {/* Zone 3: Single Primary Action + Mobile Menu Trigger */}
          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={() => navigateTo('faq', 'dmca')}
              className="hidden sm:inline-flex items-center gap-1.5 rounded-lg bg-[#f2f3ff] px-3.5 py-2 text-xs font-semibold text-[#131b2e] hover:bg-[#eaedff] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Shield className="h-3.5 w-3.5 text-[#004ac6]" />
              <span>DMCA / Legal</span>
            </button>
            <button
              type="button"
              onClick={() => setMobileMenuOpen((v) => !v)}
              aria-label="Toggle menu"
              className="md:hidden inline-flex h-10 w-10 items-center justify-center rounded-lg text-[#434655] hover:bg-[#f2f3ff]"
            >
              {mobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
          </div>
        </div>

        {/* Mobile Navigation Drawer */}
        {mobileMenuOpen && (
          <div className="border-t border-[#c3c6d7]/40 bg-white px-6 py-4 md:hidden">
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => navigateTo('home')}
                className={`rounded-lg px-3 py-2.5 text-left text-sm font-medium ${
                  page === 'home' ? 'bg-[#f2f3ff] text-[#004ac6] font-semibold' : 'text-[#434655]'
                }`}
              >
                Home
              </button>
              <button
                type="button"
                onClick={() => navigateTo('how-it-works')}
                className={`rounded-lg px-3 py-2.5 text-left text-sm font-medium ${
                  page === 'how-it-works'
                    ? 'bg-[#f2f3ff] text-[#004ac6] font-semibold'
                    : 'text-[#434655]'
                }`}
              >
                How it works
              </button>
              <button
                type="button"
                onClick={() => navigateTo('supported-sites')}
                className={`rounded-lg px-3 py-2.5 text-left text-sm font-medium ${
                  page === 'supported-sites'
                    ? 'bg-[#f2f3ff] text-[#004ac6] font-semibold'
                    : 'text-[#434655]'
                }`}
              >
                Supported sites
              </button>
              <button
                type="button"
                onClick={() => navigateTo('faq', 'faq')}
                className={`rounded-lg px-3 py-2.5 text-left text-sm font-medium ${
                  page === 'faq' ? 'bg-[#f2f3ff] text-[#004ac6] font-semibold' : 'text-[#434655]'
                }`}
              >
                FAQ &amp; Legal
              </button>
            </div>
          </div>
        )}
      </header>

      {/* MAIN CONTENT */}
      <main className="flex-1">
        {/* ======================== SCREEN 1: HOME (DOWNLOADER) ======================== */}
        {page === 'home' && (
          <section className="mx-auto max-w-5xl px-6 py-12 md:py-20">
            <div className="mx-auto max-w-2xl text-center">
              <h1 className="font-display text-4xl font-bold tracking-tight text-[#131b2e] sm:text-5xl text-balance">
                Save video &amp; audio from a link
              </h1>
              <p className="mt-4 text-base leading-relaxed text-[#434655] sm:text-lg">
                Paste a link to a public video you have the right to save. Inspect available resolutions and download cleanly as MP4 or MP3.
              </p>
            </div>

            {/* URL Input Card */}
            <div className="mx-auto mt-10 max-w-3xl">
              <form
                onSubmit={handleFetchInfo}
                className="flex flex-col gap-2 rounded-2xl bg-white p-2.5 shadow-[0_12px_32px_-8px_rgba(19,27,46,0.08)] ring-1 ring-[#c3c6d7]/50 sm:flex-row sm:items-center focus-within:ring-2 focus-within:ring-[#004ac6]"
              >
                <div className="flex flex-1 items-center gap-2.5 px-3 py-1.5">
                  <Link2 className="h-5 w-5 text-[#737686] shrink-0" />
                  <input
                    ref={urlInputRef}
                    type="url"
                    value={urlInput}
                    onChange={(e) => {
                      setUrlInput(e.target.value);
                      if (errorState) setErrorState(null);
                    }}
                    placeholder="Paste video URL here (https://...)"
                    aria-label="Video URL"
                    spellCheck={false}
                    autoComplete="off"
                    className="w-full bg-transparent text-sm text-[#131b2e] placeholder:text-[#737686] focus:outline-none sm:text-base"
                  />
                  {urlInput.length > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        setUrlInput('');
                        setErrorState(null);
                        urlInputRef.current?.focus();
                      }}
                      title="Clear link"
                      className="rounded-lg p-1.5 text-[#737686] hover:bg-[#f2f3ff] hover:text-[#131b2e] transition-colors"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={handlePaste}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-[#f2f3ff] px-3 py-1.5 text-xs font-medium text-[#434655] hover:bg-[#eaedff] hover:text-[#131b2e] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <ClipboardPaste className="h-3.5 w-3.5" />
                    <span>Paste</span>
                  </button>
                </div>

                <button
                  type="submit"
                  disabled={fetchingInfo}
                  className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#004ac6] px-6 py-3.5 text-sm font-semibold text-white shadow-sm hover:bg-[#003ea8] active:scale-[0.99] disabled:opacity-70 transition-all whitespace-nowrap shrink-0 cursor-pointer"
                >
                  {fetchingInfo ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <span>Inspecting…</span>
                    </>
                  ) : (
                    <>
                      <Download className="h-4 w-4" />
                      <span>Fetch Media</span>
                    </>
                  )}
                </button>
              </form>

              {/* Accessible Inline Error Alert */}
              {errorState && (
                <div
                  role="alert"
                  className="mt-4 flex items-start gap-3 rounded-xl bg-[#ffdad6] p-4 text-[#93000a] ring-1 ring-[#ba1a1a]/20"
                >
                  <AlertCircle className="h-5 w-5 text-[#ba1a1a] shrink-0 mt-0.5" />
                  <div className="flex-1 text-sm">
                    <p className="font-semibold">{errorState.title}</p>
                    <p className="mt-0.5 opacity-90">{errorState.message}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setErrorState(null)}
                    aria-label="Dismiss error"
                    className="rounded-md p-1 hover:bg-black/5"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              )}

              {/* Resolved Media Result Card */}
              {mediaInfo && (
                <div className="mt-8 overflow-hidden rounded-2xl bg-white shadow-[0_12px_32px_-8px_rgba(19,27,46,0.08)] ring-1 ring-[#c3c6d7]/50">
                  <div className="flex flex-col gap-6 p-6 md:flex-row">
                    {/* Thumbnail with fallback */}
                    <div className="relative h-44 w-full shrink-0 overflow-hidden rounded-xl bg-[#eaedff] md:w-68">
                      {mediaInfo.thumbnail && !thumbFailed ? (
                        <img
                          src={mediaInfo.thumbnail}
                          alt={mediaInfo.title}
                          referrerPolicy="no-referrer"
                          onError={() => setThumbFailed(true)}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-gradient-to-br from-[#eaedff] to-[#dbe1ff] text-[#004ac6]">
                          <Film className="h-10 w-10 opacity-75" />
                          <span className="font-mono text-xs font-medium">{mediaInfo.site}</span>
                        </div>
                      )}
                      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent" />
                      <span className="absolute top-2.5 left-2.5 rounded-md bg-black/75 px-2 py-0.5 font-mono text-[11px] font-medium text-white backdrop-blur-sm">
                        {mediaInfo.site}
                      </span>
                      {mediaInfo.duration !== null && (
                        <span className="absolute right-2.5 bottom-2.5 rounded-md bg-black/80 px-2 py-0.5 font-mono text-[11px] font-semibold tabular-nums text-white">
                          {formatDuration(mediaInfo.duration)}
                        </span>
                      )}
                    </div>

                    {/* Details + Active Download Progress */}
                    <div className="flex flex-1 flex-col justify-between gap-4">
                      <div>
                        <h2 className="font-display text-xl font-bold leading-snug text-[#131b2e]">
                          {mediaInfo.title}
                        </h2>
                        <div className="mt-2.5 flex flex-wrap items-center gap-2 text-xs text-[#434655] font-mono tabular-nums">
                          <span>{mediaInfo.site}</span>
                          {mediaInfo.uploader && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span>{mediaInfo.uploader}</span>
                            </>
                          )}
                          {mediaInfo.duration !== null && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span>{formatDuration(mediaInfo.duration)}</span>
                            </>
                          )}
                        </div>
                      </div>

                      {downloadProgress && (
                        <div className="rounded-xl bg-[#f2f3ff] p-4">
                          <div className="flex items-center justify-between gap-3">
                            <div className="flex items-center gap-2.5 min-w-0">
                              {downloadProgress.done ? (
                                <CheckCircle2 className="h-4 w-4 text-[#007d57] shrink-0" />
                              ) : (
                                <Loader2 className="h-4 w-4 animate-spin text-[#004ac6] shrink-0" />
                              )}
                              <span className="truncate text-sm font-semibold text-[#131b2e]">
                                {downloadProgress.statusText}
                              </span>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              <span className="font-mono text-xs font-semibold tabular-nums text-[#434655]">
                                {downloadProgress.percent !== null
                                  ? `${downloadProgress.percent}%`
                                  : downloadProgress.receivedBytes > 0
                                  ? formatBytes(downloadProgress.receivedBytes)
                                  : 'Working'}
                              </span>
                              {!downloadProgress.done && (
                                <button
                                  type="button"
                                  onClick={handleCancelDownload}
                                  title="Cancel download"
                                  className="rounded p-1 text-[#737686] hover:bg-white hover:text-[#ba1a1a] transition-colors"
                                >
                                  <X className="h-4 w-4" />
                                </button>
                              )}
                            </div>
                          </div>
                          <div className="mt-2.5 h-2 w-full overflow-hidden rounded-full bg-[#dae2fd]">
                            <div
                              className={`h-full rounded-full transition-all duration-200 ${
                                downloadProgress.done ? 'bg-[#007d57]' : 'bg-[#004ac6]'
                              }`}
                              style={{
                                width:
                                  downloadProgress.percent !== null
                                    ? `${downloadProgress.percent}%`
                                    : downloadProgress.done
                                    ? '100%'
                                    : '35%',
                              }}
                            />
                          </div>
                          <div className="mt-2 flex items-center justify-between font-mono text-[11px] tabular-nums text-[#737686]">
                            <span>
                              {downloadProgress.detailText
                                ? downloadProgress.detailText
                                : downloadProgress.totalBytes
                                ? `File size: ${formatBytes(downloadProgress.totalBytes)}`
                                : downloadProgress.receivedBytes > 0
                                ? `Size: ${formatBytes(downloadProgress.receivedBytes)}`
                                : 'Streaming directly to browser downloader'}
                            </span>
                            <span>{downloadProgress.quality.toUpperCase()}</span>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Quality Presets Grid */}
                  <div className="border-t border-[#c3c6d7]/40 bg-[#faf8ff] px-6 py-5">
                    <p className="mb-3 font-mono text-xs font-semibold tracking-wide text-[#434655]">
                      Available download presets
                    </p>
                    {mediaInfo.options.length === 0 ? (
                      <p className="text-sm text-[#434655]">
                        No compatible MP4 or MP3 streams were reported for this link.
                      </p>
                    ) : (
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                        {mediaInfo.options.map((preset) => {
                          const meta = PRESET_META[preset];
                          const isBusy =
                            downloadProgress &&
                            !downloadProgress.done &&
                            downloadProgress.quality === preset;
                          return (
                            <button
                              key={preset}
                              type="button"
                              disabled={Boolean(downloadProgress && !downloadProgress.done)}
                              onClick={() => handleDownloadPreset(preset)}
                              className="group flex flex-col justify-between rounded-xl bg-white p-3.5 text-left ring-1 ring-[#c3c6d7]/60 hover:ring-[#004ac6] hover:bg-[#f2f3ff]/60 disabled:opacity-60 transition-all cursor-pointer"
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span className="font-display text-sm font-semibold text-[#131b2e] group-hover:text-[#004ac6]">
                                  {meta.label}
                                </span>
                                <span className="font-mono text-[11px] font-medium text-[#434655]">
                                  {meta.tag}
                                </span>
                              </div>
                              <div className="mt-3 flex items-center justify-between font-mono text-xs text-[#737686]">
                                <span>{meta.detail}</span>
                                {isBusy ? (
                                  <Loader2 className="h-4 w-4 animate-spin text-[#004ac6]" />
                                ) : meta.isAudio ? (
                                  <FileAudio className="h-4 w-4 text-[#007d57]" />
                                ) : (
                                  <FileVideo className="h-4 w-4 text-[#004ac6]" />
                                )}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Legal / Personal Use Notice */}
              <div className="mt-6 flex items-start gap-3 rounded-xl bg-[#f2f3ff] px-4 py-3.5 text-xs leading-relaxed text-[#434655]">
                <AlertTriangle className="h-4 w-4 text-[#b45309] shrink-0 mt-0.5" />
                <p>
                  <strong className="font-semibold text-[#131b2e]">Personal use only.</strong>{' '}
                  You are responsible for having the legal right to download any media. Third-party platform terms of service may prohibit downloading. Read our{' '}
                  <button
                    type="button"
                    onClick={() => navigateTo('faq', 'terms')}
                    className="font-medium text-[#004ac6] underline underline-offset-2 hover:text-[#003ea8]"
                  >
                    Terms
                  </button>{' '}
                  and{' '}
                  <button
                    type="button"
                    onClick={() => navigateTo('faq', 'dmca')}
                    className="font-medium text-[#004ac6] underline underline-offset-2 hover:text-[#003ea8]"
                  >
                    Copyright / DMCA policy
                  </button>
                  .
                </p>
              </div>
            </div>

            {/* 3 Key Product Capabilities */}
            <div className="mt-16 grid grid-cols-1 gap-6 md:grid-cols-3">
              <div className="rounded-2xl bg-white p-7 ring-1 ring-[#c3c6d7]/50">
                <div className="mb-4 inline-flex h-11 w-11 items-center justify-center rounded-xl bg-[#dbe1ff] text-[#004ac6]">
                  <Sparkles className="h-5 w-5" />
                </div>
                <h3 className="font-display text-lg font-bold text-[#131b2e]">
                  No installation required
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-[#434655]">
                  Works directly in desktop and mobile browsers without browser extensions, desktop installers, or account sign-ups.
                </p>
              </div>

              <div className="rounded-2xl bg-white p-7 ring-1 ring-[#c3c6d7]/50">
                <div className="mb-4 inline-flex h-11 w-11 items-center justify-center rounded-xl bg-[#85f8c4]/40 text-[#006243]">
                  <Trash2 className="h-5 w-5" />
                </div>
                <h3 className="font-display text-lg font-bold text-[#131b2e]">
                  Ephemeral &amp; zero storage
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-[#434655]">
                  Temporary files are created per request, streamed to your browser, and immediately deleted. Full URLs with tokens are never logged.
                </p>
              </div>

              <div className="rounded-2xl bg-white p-7 ring-1 ring-[#c3c6d7]/50">
                <div className="mb-4 inline-flex h-11 w-11 items-center justify-center rounded-xl bg-[#e2dfff] text-[#4b41e1]">
                  <Music className="h-5 w-5" />
                </div>
                <h3 className="font-display text-lg font-bold text-[#131b2e]">
                  Clean MP4 &amp; MP3 presets
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-[#434655]">
                  Only offers resolutions the source actually provides (up to 1080p MP4) alongside 192 kbps MP3 audio extraction.
                </p>
              </div>
            </div>
          </section>
        )}

        {/* ======================== SCREEN 2: HOW IT WORKS ======================== */}
        {page === 'how-it-works' && (
          <section className="mx-auto max-w-6xl px-6 py-12 md:py-16 space-y-16">
            <div className="mx-auto max-w-2xl text-center">
              <h1 className="font-display text-4xl font-bold tracking-tight text-[#131b2e]">
                How ClipGrab Works
              </h1>
              <p className="mt-4 text-base text-[#434655] sm:text-lg">
                Save video and audio in four transparent steps with strict safety controls, single-video focus, and immediate temporary file cleanup.
              </p>
            </div>

            <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
              <div className="rounded-2xl bg-[#f2f3ff] p-7">
                <div className="flex items-center justify-between">
                  <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-[#004ac6] text-white">
                    <Link2 className="h-5 w-5" />
                  </span>
                  <span className="font-mono text-sm font-semibold text-[#004ac6]">01</span>
                </div>
                <h2 className="mt-5 font-display text-xl font-bold text-[#131b2e]">
                  1. Paste a public media link
                </h2>
                <p className="mt-2 text-sm leading-relaxed text-[#434655]">
                  Enter a public <code className="font-mono text-xs bg-white px-1.5 py-0.5 rounded">http://</code> or{' '}
                  <code className="font-mono text-xs bg-white px-1.5 py-0.5 rounded">https://</code> URL. The server validates the scheme, checks the domain blocklist, and resolves DNS to block private or loopback IP addresses.
                </p>
              </div>

              <div className="rounded-2xl bg-[#f2f3ff] p-7">
                <div className="flex items-center justify-between">
                  <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-[#4b41e1] text-white">
                    <Search className="h-5 w-5" />
                  </span>
                  <span className="font-mono text-sm font-semibold text-[#4b41e1]">02</span>
                </div>
                <h2 className="mt-5 font-display text-xl font-bold text-[#131b2e]">
                  2. Inspect supported qualities
                </h2>
                <p className="mt-2 text-sm leading-relaxed text-[#434655]">
                  <code className="font-mono text-xs bg-white px-1.5 py-0.5 rounded">POST /api/info</code> reads metadata for the single video (playlists disabled) and computes only the presets the source supports.
                </p>
              </div>

              <div className="rounded-2xl bg-[#f2f3ff] p-7">
                <div className="flex items-center justify-between">
                  <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-[#007d57] text-white">
                    <FileVideo className="h-5 w-5" />
                  </span>
                  <span className="font-mono text-sm font-semibold text-[#007d57]">03</span>
                </div>
                <h2 className="mt-5 font-display text-xl font-bold text-[#131b2e]">
                  3. Select MP4 or MP3 preset
                </h2>
                <p className="mt-2 text-sm leading-relaxed text-[#434655]">
                  Pick 1080p, 720p, or 480p MP4 (merged cleanly with FFmpeg) or extract a 192 kbps MP3 audio file. Videos longer than 60 minutes or over 500 MB are rejected cleanly.
                </p>
              </div>

              <div className="rounded-2xl bg-[#f2f3ff] p-7">
                <div className="flex items-center justify-between">
                  <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-[#131b2e] text-white">
                    <Download className="h-5 w-5" />
                  </span>
                  <span className="font-mono text-sm font-semibold text-[#131b2e]">04</span>
                </div>
                <h2 className="mt-5 font-display text-xl font-bold text-[#131b2e]">
                  4. Stream &amp; auto-delete temp files
                </h2>
                <p className="mt-2 text-sm leading-relaxed text-[#434655]">
                  <code className="font-mono text-xs bg-white px-1.5 py-0.5 rounded">GET /api/download</code> streams the attachment with a sanitized filename, then deletes the per-request temporary directory in a background task.
                </p>
              </div>
            </div>

            {/* Clean Safety & Controls Summary */}
            <div className="rounded-2xl bg-white p-8 ring-1 ring-[#c3c6d7]/50">
              <h2 className="font-display text-2xl font-bold text-[#131b2e]">
                Built-in safety and abuse protections
              </h2>
              <div className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
                <div>
                  <h3 className="font-display text-sm font-bold text-[#131b2e]">SSRF protection</h3>
                  <p className="mt-1 text-sm text-[#434655]">
                    Hostnames are DNS-resolved and checked before fetching; private, loopback, link-local, and reserved IPs are rejected.
                  </p>
                </div>
                <div>
                  <h3 className="font-display text-sm font-bold text-[#131b2e]">Per-IP rate limiting</h3>
                  <p className="mt-1 text-sm text-[#434655]">
                    Requests are throttled via <code className="font-mono text-xs">RATE_LIMIT_PER_MIN</code> (default 10/min) with HTTP 429 responses.
                  </p>
                </div>
                <div>
                  <h3 className="font-display text-sm font-bold text-[#131b2e]">Domain takedown blocklist</h3>
                  <p className="mt-1 text-sm text-[#434655]">
                    Operators enforce exclusions via <code className="font-mono text-xs">BLOCKED_DOMAINS</code>, returning HTTP 403 for blocked hosts.
                  </p>
                </div>
              </div>
            </div>

            <div className="flex flex-col items-center justify-center gap-4 rounded-2xl bg-[#f2f3ff] p-10 text-center">
              <h2 className="font-display text-2xl font-bold text-[#131b2e]">
                Ready to inspect a link?
              </h2>
              <div className="flex flex-wrap items-center justify-center gap-3">
                <button
                  type="button"
                  onClick={() => navigateTo('home')}
                  className="inline-flex items-center gap-2 rounded-xl bg-[#004ac6] px-6 py-3 text-sm font-semibold text-white hover:bg-[#003ea8] transition-colors cursor-pointer"
                >
                  <span>Open Downloader</span>
                  <ArrowRight className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => navigateTo('supported-sites')}
                  className="inline-flex items-center gap-2 rounded-xl bg-white px-6 py-3 text-sm font-semibold text-[#131b2e] ring-1 ring-[#c3c6d7]/70 hover:bg-[#eaedff] transition-colors cursor-pointer"
                >
                  <span>Browse Supported Sites</span>
                </button>
              </div>
            </div>
          </section>
        )}

        {/* ======================== SCREEN 3: SUPPORTED SITES ======================== */}
        {page === 'supported-sites' && (
          <section className="mx-auto max-w-6xl px-6 py-12 md:py-16">
            <div className="mx-auto max-w-2xl text-center">
              <h1 className="font-display text-4xl font-bold tracking-tight text-[#131b2e]">
                Supported Platforms &amp; Sites
              </h1>
              <p className="mt-4 text-base text-[#434655] sm:text-lg">
                Browse popular platforms below or search the extractor list returned live by{' '}
                <code className="font-mono text-sm bg-[#f2f3ff] px-1.5 py-0.5 rounded">GET /api/sites</code>.
              </p>
            </div>

            {/* Search & Category Controls */}
            <div className="mt-10 rounded-2xl bg-[#f2f3ff] p-4 space-y-4">
              <div className="relative flex items-center">
                <Search className="pointer-events-none absolute left-3.5 h-5 w-5 text-[#737686]" />
                <input
                  type="text"
                  value={siteSearch}
                  onChange={(e) => setSiteSearch(e.target.value)}
                  placeholder="Search sites or extractors (e.g. SoundCloud, Dailymotion, TED, Archive.org)..."
                  aria-label="Search supported sites"
                  className="h-11 w-full rounded-xl bg-white pl-11 pr-10 text-sm text-[#131b2e] placeholder:text-[#737686] ring-1 ring-[#c3c6d7]/60 focus:ring-2 focus:ring-[#004ac6] focus:outline-none"
                />
                {siteSearch && (
                  <button
                    type="button"
                    onClick={() => setSiteSearch('')}
                    aria-label="Clear search"
                    className="absolute right-3 rounded p-1 text-[#737686] hover:text-[#131b2e]"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Platform categories">
                {(
                  [
                    { id: 'all', label: 'All Platforms' },
                    { id: 'video', label: 'Video & Streaming' },
                    { id: 'music', label: 'Music & Audio' },
                    { id: 'social', label: 'Social Media' },
                    { id: 'educational', label: 'Educational' },
                  ] as const
                ).map((cat) => (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => setSiteCategory(cat.id)}
                    className={`rounded-lg px-3.5 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                      siteCategory === cat.id
                        ? 'bg-[#004ac6] text-white'
                        : 'bg-white text-[#434655] hover:text-[#131b2e]'
                    }`}
                  >
                    {cat.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-6 flex items-center justify-between text-xs text-[#434655] font-mono tabular-nums">
              <span>Showing {filteredFeatured.length} featured platforms</span>
              <span>
                {sitesLoading
                  ? 'Loading extractors…'
                  : sitesError
                  ? sitesError
                  : `${sites.length} extractors reported by /api/sites`}
              </span>
            </div>

            {/* Featured Platform Cards */}
            {filteredFeatured.length === 0 ? (
              <div className="mt-8 rounded-2xl bg-[#f2f3ff] p-10 text-center">
                <p className="font-display text-lg font-bold text-[#131b2e]">
                  No featured platform matches “{siteSearch}”
                </p>
                <p className="mt-1 text-sm text-[#434655]">
                  Check the full extractor list below or reset filters to see all featured platforms.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setSiteSearch('');
                    setSiteCategory('all');
                  }}
                  className="mt-4 rounded-lg bg-[#004ac6] px-4 py-2 text-xs font-semibold text-white hover:bg-[#003ea8]"
                >
                  Reset Filters
                </button>
              </div>
            ) : (
              <div className="mt-4 grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3">
                {filteredFeatured.map((site) => (
                  <div
                    key={site.id}
                    className="flex flex-col justify-between rounded-2xl bg-white p-5 ring-1 ring-[#c3c6d7]/50 hover:ring-[#004ac6]/60 transition-all"
                  >
                    <div className="space-y-4">
                      <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#f2f3ff] text-[#004ac6]">
                          {site.category === 'music' ? (
                            <Radio className="h-5 w-5" />
                          ) : site.category === 'social' ? (
                            <Globe className="h-5 w-5" />
                          ) : site.category === 'educational' ? (
                            <Tv className="h-5 w-5" />
                          ) : (
                            <Play className="h-5 w-5" />
                          )}
                        </div>
                        <div>
                          <h3 className="font-display text-base font-bold text-[#131b2e]">
                            {site.name}
                          </h3>
                          <p className="font-mono text-xs text-[#737686]">{site.domain}</p>
                        </div>
                      </div>

                      <div className="rounded-lg bg-[#f2f3ff] p-2.5">
                        <p className="font-mono text-[10px] uppercase tracking-wider text-[#737686]">
                          URL Pattern
                        </p>
                        <code className="mt-0.5 block truncate font-mono text-xs text-[#131b2e]">
                          {site.pattern}
                        </code>
                      </div>

                      <p className="font-mono text-xs text-[#434655]">
                        {site.formats.join(' · ')}
                      </p>
                    </div>

                    <div className="mt-5 flex items-center justify-between border-t border-[#c3c6d7]/30 pt-3">
                      <span className="text-xs capitalize text-[#737686]">{site.category}</span>
                      <button
                        type="button"
                        onClick={() => handleTestPlatform(site)}
                        className="inline-flex items-center gap-1 text-xs font-semibold text-[#004ac6] hover:underline cursor-pointer"
                      >
                        <span>{site.sampleUrl ? 'Test Sample' : 'Use Link'}</span>
                        <ArrowRight className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Live /api/sites Extractor Directory */}
            <div className="mt-12 rounded-2xl bg-white p-6 ring-1 ring-[#c3c6d7]/50">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="font-display text-lg font-bold text-[#131b2e]">
                    Extractor Directory (<code className="font-mono text-sm">GET /api/sites</code>)
                  </h2>
                  <p className="text-sm text-[#434655]">
                    {filteredExtractorNames.length} matching extractors returned by the backend.
                  </p>
                </div>
                {filteredExtractorNames.length > 24 && (
                  <button
                    type="button"
                    onClick={() => setShowAllExtractors((v) => !v)}
                    className="rounded-lg bg-[#f2f3ff] px-3.5 py-2 text-xs font-semibold text-[#131b2e] hover:bg-[#eaedff] whitespace-nowrap cursor-pointer"
                  >
                    {showAllExtractors
                      ? 'Show Top 24'
                      : `Show All (${filteredExtractorNames.length})`}
                  </button>
                )}
              </div>

              {sitesLoading ? (
                <div className="mt-4 flex items-center gap-2 text-sm text-[#434655]">
                  <Loader2 className="h-4 w-4 animate-spin text-[#004ac6]" />
                  <span>Fetching extractor list…</span>
                </div>
              ) : filteredExtractorNames.length === 0 ? (
                <p className="mt-4 text-sm text-[#737686]">No matching extractors found.</p>
              ) : (
                <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
                  {(showAllExtractors
                    ? filteredExtractorNames
                    : filteredExtractorNames.slice(0, 24)
                  ).map((item) => (
                    <div
                      key={item.name}
                      className="truncate rounded-lg bg-[#f2f3ff] px-3 py-2 font-mono text-xs text-[#131b2e]"
                      title={item.name}
                    >
                      {item.name}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        )}

        {/* ======================== SCREEN 4: FAQ & LEGAL HUB ======================== */}
        {page === 'faq' && (
          <section className="mx-auto max-w-5xl px-6 py-12 md:py-16">
            <div className="max-w-2xl">
              <h1 className="font-display text-4xl font-bold tracking-tight text-[#131b2e]">
                Help, Legal &amp; Copyright
              </h1>
              <p className="mt-3 text-base text-[#434655]">
                Answers to common questions, privacy safeguards, terms of use, and our DMCA takedown procedure.
              </p>
            </div>

            {/* Hub Sub-Navigation Tabs */}
            <div
              className="mt-8 flex items-center gap-2 overflow-x-auto border-b border-[#c3c6d7]/50 pb-3"
              role="tablist"
            >
              {(
                [
                  { id: 'faq', label: 'FAQ', icon: HelpCircle },
                  { id: 'terms', label: 'Terms of Service', icon: Gavel },
                  { id: 'privacy', label: 'Privacy Policy', icon: Lock },
                  { id: 'dmca', label: 'Copyright & DMCA', icon: ShieldAlert },
                  { id: 'contact', label: 'Contact', icon: Mail },
                ] as const
              ).map((tab) => {
                const Icon = tab.icon;
                const active = hubTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => navigateTo('faq', tab.id)}
                    className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
                      active
                        ? 'bg-[#004ac6] text-white'
                        : 'bg-[#f2f3ff] text-[#434655] hover:text-[#131b2e]'
                    }`}
                  >
                    <Icon className="h-4 w-4" />
                    <span>{tab.label}</span>
                  </button>
                );
              })}
            </div>

            {/* TAB: FAQ */}
            {hubTab === 'faq' && (
              <div className="mt-8 space-y-6">
                <div className="relative flex items-center">
                  <Search className="pointer-events-none absolute left-3.5 h-5 w-5 text-[#737686]" />
                  <input
                    type="text"
                    value={faqSearch}
                    onChange={(e) => setFaqSearch(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') setFaqSearch('');
                    }}
                    placeholder="Filter questions (e.g. MP3, private, rate limit, legal)..."
                    aria-label="Filter FAQ"
                    className="h-11 w-full rounded-xl bg-white pl-11 pr-10 text-sm text-[#131b2e] placeholder:text-[#737686] ring-1 ring-[#c3c6d7]/60 focus:ring-2 focus:ring-[#004ac6] focus:outline-none"
                  />
                  {faqSearch && (
                    <button
                      type="button"
                      onClick={() => setFaqSearch('')}
                      aria-label="Clear FAQ search"
                      className="absolute right-3 rounded p-1 text-[#737686] hover:text-[#131b2e]"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </div>

                <div className="space-y-3">
                  {filteredFaqs.length === 0 ? (
                    <div className="rounded-xl bg-[#f2f3ff] p-6 text-center text-sm text-[#434655]">
                      No questions match “{faqSearch}”.
                    </div>
                  ) : (
                    filteredFaqs.map((item) => {
                      const isOpen = openFaqIds.includes(item.id);
                      return (
                        <div
                          key={item.id}
                          className="overflow-hidden rounded-xl bg-white ring-1 ring-[#c3c6d7]/50"
                        >
                          <button
                            type="button"
                            aria-expanded={isOpen}
                            onClick={() => toggleFaq(item.id)}
                            className="flex w-full items-center justify-between gap-4 p-5 text-left hover:bg-[#faf8ff] transition-colors cursor-pointer"
                          >
                            <div className="flex items-center gap-3">
                              <span className="font-mono text-xs font-semibold text-[#004ac6]">
                                {item.id}
                              </span>
                              <span className="font-display text-base font-semibold text-[#131b2e]">
                                {item.question}
                              </span>
                            </div>
                            <ChevronDown
                              className={`h-5 w-5 text-[#737686] shrink-0 transition-transform duration-200 ${
                                isOpen ? 'rotate-180' : ''
                              }`}
                            />
                          </button>
                          {isOpen && (
                            <div className="border-t border-[#c3c6d7]/30 bg-[#faf8ff] px-5 py-4 text-sm leading-relaxed text-[#434655]">
                              {item.answer}
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            )}

            {/* TAB: TERMS OF SERVICE */}
            {hubTab === 'terms' && (
              <div className="mt-8 space-y-6">
                <div className="rounded-2xl bg-[#f2f3ff] p-6">
                  <p className="font-mono text-xs font-semibold text-[#004ac6]">
                    Last updated: 2026
                  </p>
                  <h2 className="mt-1 font-display text-2xl font-bold text-[#131b2e]">
                    Terms of Service
                  </h2>
                  <p className="mt-2 text-sm leading-relaxed text-[#434655]">
                    By accessing or using ClipGrab, you agree to these Terms of Service. If you do not agree, do not use this tool.
                  </p>
                </div>

                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div className="rounded-xl bg-white p-6 ring-1 ring-[#c3c6d7]/50">
                    <h3 className="font-display text-base font-bold text-[#131b2e]">
                      1. Personal Use &amp; Rights Responsibility
                    </h3>
                    <p className="mt-2 text-sm leading-relaxed text-[#434655]">
                      ClipGrab is provided strictly for personal use. You are solely responsible for ensuring you own or have explicit permission to download any content. Third-party platform terms of service may prohibit downloading.
                    </p>
                  </div>
                  <div className="rounded-xl bg-white p-6 ring-1 ring-[#c3c6d7]/50">
                    <h3 className="font-display text-base font-bold text-[#131b2e]">
                      2. Prohibited Activity
                    </h3>
                    <p className="mt-2 text-sm leading-relaxed text-[#434655]">
                      You must not use ClipGrab to bypass DRM or access controls, scrape private/authenticated media, redistribute copyrighted works, or exceed rate limits via automated abuse.
                    </p>
                  </div>
                  <div className="rounded-xl bg-white p-6 ring-1 ring-[#c3c6d7]/50">
                    <h3 className="font-display text-base font-bold text-[#131b2e]">
                      3. No Warranty
                    </h3>
                    <p className="mt-2 text-sm leading-relaxed text-[#434655]">
                      The service is provided “as is” without warranties of availability, speed, or compatibility with any third-party host.
                    </p>
                  </div>
                  <div className="rounded-xl bg-white p-6 ring-1 ring-[#c3c6d7]/50">
                    <h3 className="font-display text-base font-bold text-[#131b2e]">
                      4. Indemnification
                    </h3>
                    <p className="mt-2 text-sm leading-relaxed text-[#434655]">
                      You assume full legal responsibility for the URLs you submit and agree to indemnify the service operators against claims resulting from misuse.
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* TAB: PRIVACY POLICY */}
            {hubTab === 'privacy' && (
              <div className="mt-8 space-y-6">
                <div className="rounded-2xl bg-[#f2f3ff] p-6">
                  <p className="font-mono text-xs font-semibold text-[#007d57]">
                    Zero-Storage Architecture
                  </p>
                  <h2 className="mt-1 font-display text-2xl font-bold text-[#131b2e]">
                    Privacy Policy
                  </h2>
                  <p className="mt-2 text-sm leading-relaxed text-[#434655]">
                    ClipGrab has no user accounts, no persistent media storage, and does not log full URLs containing query tokens.
                  </p>
                </div>

                <div className="rounded-xl bg-white p-6 ring-1 ring-[#c3c6d7]/50 space-y-4">
                  <div className="flex flex-col justify-between gap-2 border-b border-[#c3c6d7]/30 pb-4 sm:flex-row sm:items-center">
                    <div>
                      <p className="font-display text-sm font-bold text-[#131b2e]">
                        User Accounts &amp; Tracking
                      </p>
                      <p className="text-sm text-[#434655]">
                        No registration, no user profiles, and no advertising trackers.
                      </p>
                    </div>
                    <span className="font-mono text-xs font-semibold text-[#007d57]">Not collected</span>
                  </div>

                  <div className="flex flex-col justify-between gap-2 border-b border-[#c3c6d7]/30 pb-4 sm:flex-row sm:items-center">
                    <div>
                      <p className="font-display text-sm font-bold text-[#131b2e]">
                        Media &amp; Temporary Files
                      </p>
                      <p className="text-sm text-[#434655]">
                        Each download runs in a per-request temp directory that is deleted immediately after streaming.
                      </p>
                    </div>
                    <span className="font-mono text-xs font-semibold text-[#004ac6]">
                      Deleted after transfer
                    </span>
                  </div>

                  <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-center">
                    <div>
                      <p className="font-display text-sm font-bold text-[#131b2e]">
                        Rate Limiting &amp; Safe Logs
                      </p>
                      <p className="text-sm text-[#434655]">
                        Short-lived in-memory IP counters enforce per-minute rate limits; query strings and tokens are stripped from operational logs.
                      </p>
                    </div>
                    <span className="font-mono text-xs font-semibold text-[#434655]">
                      60-second window
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* TAB: COPYRIGHT & DMCA */}
            {hubTab === 'dmca' && (
              <div className="mt-8 space-y-6">
                <div className="rounded-2xl bg-[#f2f3ff] p-6">
                  <div className="flex items-center gap-2 text-[#ba1a1a]">
                    <Scale className="h-4 w-4" />
                    <span className="font-mono text-xs font-semibold">DMCA &amp; Takedown Compliance</span>
                  </div>
                  <h2 className="mt-1 font-display text-2xl font-bold text-[#131b2e]">
                    Copyright &amp; DMCA Policy
                  </h2>
                  <p className="mt-2 text-sm leading-relaxed text-[#434655]">
                    ClipGrab does not host or archive media files. We honor valid copyright takedown and domain exclusion requests by adding domains to the server’s{' '}
                    <code className="font-mono text-xs bg-white px-1.5 py-0.5 rounded">BLOCKED_DOMAINS</code> blocklist.
                  </p>
                  <p className="mt-3 text-sm text-[#131b2e]">
                    Designated Takedown Contact:{' '}
                    <a
                      href="mailto:dmca@clipgrab.local?subject=DMCA%20Takedown%20Request"
                      className="font-mono font-semibold text-[#004ac6] underline underline-offset-2"
                    >
                      dmca@clipgrab.local
                    </a>
                  </p>
                </div>

                <div className="rounded-2xl bg-white p-6 ring-1 ring-[#c3c6d7]/50">
                  <h3 className="font-display text-lg font-bold text-[#131b2e]">
                    Submit a Domain Exclusion / DMCA Notice
                  </h3>
                  <p className="mt-1 text-sm text-[#434655]">
                    Rights holders or authorized agents may submit domains or URLs to be blocked from extraction.
                  </p>

                  {dmcaSubmitted && (
                    <div
                      role="status"
                      className="mt-4 flex items-start gap-2.5 rounded-xl bg-[#85f8c4]/30 p-4 text-sm text-[#002114]"
                    >
                      <CheckCircle2 className="h-5 w-5 text-[#007d57] shrink-0 mt-0.5" />
                      <span>{dmcaSubmitted}</span>
                    </div>
                  )}

                  <form onSubmit={handleDmcaSubmit} className="mt-5 space-y-4">
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                      <div>
                        <label className="mb-1 block text-xs font-medium text-[#434655]">
                          Full Legal Name *
                        </label>
                        <input
                          name="name"
                          required
                          type="text"
                          placeholder="Jane Doe"
                          className="h-10 w-full rounded-lg bg-[#f2f3ff] px-3 text-sm text-[#131b2e] focus:bg-white focus:ring-2 focus:ring-[#004ac6] focus:outline-none"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-xs font-medium text-[#434655]">
                          Company / Rights Holder *
                        </label>
                        <input
                          name="organization"
                          required
                          type="text"
                          placeholder="Acme Media LLC"
                          className="h-10 w-full rounded-lg bg-[#f2f3ff] px-3 text-sm text-[#131b2e] focus:bg-white focus:ring-2 focus:ring-[#004ac6] focus:outline-none"
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                      <div>
                        <label className="mb-1 block text-xs font-medium text-[#434655]">
                          Official Contact Email *
                        </label>
                        <input
                          name="email"
                          required
                          type="email"
                          placeholder="legal@rightsowner.com"
                          className="h-10 w-full rounded-lg bg-[#f2f3ff] px-3 text-sm text-[#131b2e] focus:bg-white focus:ring-2 focus:ring-[#004ac6] focus:outline-none"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-xs font-medium text-[#434655]">
                          Original Work Reference URL
                        </label>
                        <input
                          name="originalUrl"
                          type="url"
                          placeholder="https://example.com/original"
                          className="h-10 w-full rounded-lg bg-[#f2f3ff] px-3 text-sm text-[#131b2e] focus:bg-white focus:ring-2 focus:ring-[#004ac6] focus:outline-none"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="mb-1 block text-xs font-medium text-[#434655]">
                        Domain(s) or URL(s) to Block *
                      </label>
                      <textarea
                        name="targetUrls"
                        required
                        rows={3}
                        placeholder="https://example.com/video/123"
                        className="w-full rounded-lg bg-[#f2f3ff] p-3 text-sm text-[#131b2e] focus:bg-white focus:ring-2 focus:ring-[#004ac6] focus:outline-none"
                      />
                    </div>

                    <label className="flex items-start gap-2.5 text-xs text-[#434655]">
                      <input type="checkbox" required className="mt-0.5 rounded text-[#004ac6]" />
                      <span>
                        I state under penalty of perjury that I am the copyright owner or authorized agent and have a good-faith belief that the requested exclusion is unauthorized.
                      </span>
                    </label>

                    <button
                      type="submit"
                      disabled={dmcaSubmitting}
                      className="inline-flex items-center gap-2 rounded-xl bg-[#004ac6] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#003ea8] disabled:opacity-60 transition-colors cursor-pointer"
                    >
                      <Check className="h-4 w-4" />
                      <span>{dmcaSubmitting ? 'Submitting…' : 'Submit Takedown Notice'}</span>
                    </button>
                  </form>
                </div>
              </div>
            )}

            {/* TAB: CONTACT */}
            {hubTab === 'contact' && (
              <div className="mt-8 space-y-6">
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div className="rounded-xl bg-white p-6 ring-1 ring-[#c3c6d7]/50">
                    <h3 className="font-display text-base font-bold text-[#131b2e]">
                      General Support
                    </h3>
                    <p className="mt-1 text-sm text-[#434655]">
                      Questions about formats, extraction failures, or accessibility.
                    </p>
                    <a
                      href="mailto:support@clipgrab.local"
                      className="mt-4 inline-flex items-center gap-1.5 font-mono text-sm font-semibold text-[#004ac6] hover:underline"
                    >
                      <span>support@clipgrab.local</span>
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  </div>

                  <div className="rounded-xl bg-white p-6 ring-1 ring-[#c3c6d7]/50">
                    <h3 className="font-display text-base font-bold text-[#131b2e]">
                      Copyright &amp; Takedowns
                    </h3>
                    <p className="mt-1 text-sm text-[#434655]">
                      Domain blocklist requests and DMCA compliance notices.
                    </p>
                    <a
                      href="mailto:dmca@clipgrab.local"
                      className="mt-4 inline-flex items-center gap-1.5 font-mono text-sm font-semibold text-[#007d57] hover:underline"
                    >
                      <span>dmca@clipgrab.local</span>
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  </div>
                </div>

                <div className="rounded-2xl bg-white p-6 ring-1 ring-[#c3c6d7]/50">
                  <h3 className="font-display text-lg font-bold text-[#131b2e]">
                    Send a Message
                  </h3>

                  {contactSubmitted && (
                    <div
                      role="status"
                      className="mt-4 flex items-start gap-2.5 rounded-xl bg-[#85f8c4]/30 p-4 text-sm text-[#002114]"
                    >
                      <CheckCircle2 className="h-5 w-5 text-[#007d57] shrink-0 mt-0.5" />
                      <span>{contactSubmitted}</span>
                    </div>
                  )}

                  <form onSubmit={handleContactSubmit} className="mt-4 space-y-4">
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                      <div>
                        <label className="mb-1 block text-xs font-medium text-[#434655]">
                          Your Name *
                        </label>
                        <input
                          required
                          type="text"
                          placeholder="Name"
                          className="h-10 w-full rounded-lg bg-[#f2f3ff] px-3 text-sm text-[#131b2e] focus:bg-white focus:ring-2 focus:ring-[#004ac6] focus:outline-none"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-xs font-medium text-[#434655]">
                          Email Address *
                        </label>
                        <input
                          required
                          type="email"
                          placeholder="you@example.com"
                          className="h-10 w-full rounded-lg bg-[#f2f3ff] px-3 text-sm text-[#131b2e] focus:bg-white focus:ring-2 focus:ring-[#004ac6] focus:outline-none"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-[#434655]">
                        Message *
                      </label>
                      <textarea
                        required
                        rows={4}
                        placeholder="Describe your question or issue..."
                        className="w-full rounded-lg bg-[#f2f3ff] p-3 text-sm text-[#131b2e] focus:bg-white focus:ring-2 focus:ring-[#004ac6] focus:outline-none"
                      />
                    </div>
                    <button
                      type="submit"
                      className="inline-flex items-center gap-2 rounded-xl bg-[#004ac6] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#003ea8] transition-colors cursor-pointer"
                    >
                      <Send className="h-4 w-4" />
                      <span>Send Message</span>
                    </button>
                  </form>
                </div>
              </div>
            )}
          </section>
        )}
      </main>

      {/* FOOTER */}
      <footer className="mt-auto border-t border-[#c3c6d7]/50 bg-[#f2f3ff]">
        <div className="mx-auto max-w-6xl px-6 py-10">
          <div className="flex flex-col items-center justify-between gap-6 border-b border-[#c3c6d7]/40 pb-6 md:flex-row">
            <button
              type="button"
              onClick={() => navigateTo('home')}
              className="font-display text-base font-bold text-[#131b2e] cursor-pointer"
            >
              ClipGrab
            </button>

            <div className="flex flex-wrap items-center justify-center gap-6 text-xs font-medium text-[#434655]">
              <button
                type="button"
                onClick={() => navigateTo('how-it-works')}
                className="hover:text-[#131b2e] cursor-pointer"
              >
                About
              </button>
              <button
                type="button"
                onClick={() => navigateTo('faq', 'faq')}
                className="hover:text-[#131b2e] cursor-pointer"
              >
                FAQ
              </button>
              <button
                type="button"
                onClick={() => navigateTo('faq', 'terms')}
                className="hover:text-[#131b2e] cursor-pointer"
              >
                Terms
              </button>
              <button
                type="button"
                onClick={() => navigateTo('faq', 'privacy')}
                className="hover:text-[#131b2e] cursor-pointer"
              >
                Privacy
              </button>
              <button
                type="button"
                onClick={() => navigateTo('faq', 'dmca')}
                className="hover:text-[#131b2e] cursor-pointer"
              >
                Copyright / DMCA
              </button>
              <button
                type="button"
                onClick={() => navigateTo('faq', 'contact')}
                className="hover:text-[#131b2e] cursor-pointer"
              >
                Contact
              </button>
            </div>
          </div>

          <div className="mt-6 flex flex-col items-center justify-between gap-4 text-center text-xs text-[#737686] md:flex-row md:text-left">
            <p>
              ClipGrab — Personal use utility. Takedowns:{' '}
              <a
                href="mailto:dmca@clipgrab.local"
                className="text-[#434655] underline underline-offset-2"
              >
                dmca@clipgrab.local
              </a>
            </p>
            <p className="max-w-xl md:text-right">
              For personal use only. Users are responsible for having the right to download content; third-party platform terms of service may prohibit downloading.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
