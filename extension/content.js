/* global chrome */
(() => {
  if (window.__idmliteContentLoaded) return;
  if (!(document.documentElement instanceof HTMLElement)) return;
  window.__idmliteContentLoaded = true;

  const HOST_CSS =
    'all: initial !important; position: fixed !important; top: 0 !important; left: 0 !important; width: 0 !important; height: 0 !important; z-index: 2147483000 !important; display: block !important; visibility: visible !important; opacity: 1 !important; pointer-events: none !important;';

  let sniffedMedia = [];
  let activeVideo = null;
  let leaveHideTimer = null;
  let idleHideTimer = null;
  let isMenuOpen = false;
  let isPointerInsideBar = false;
  let lastMouseMoveTime = 0;
  let toastTimer = null;
  const dismissedVideos = new WeakSet();

  const PLATFORM_HOSTS = [
    'youtube.com',
    'youtu.be',
    'tiktok.com',
    'facebook.com',
    'fb.watch',
    'instagram.com',
    'twitter.com',
    'x.com',
    'vimeo.com',
    'bilibili.com',
    'dailymotion.com',
    'twitch.tv',
    'reddit.com',
    'soundcloud.com',
    'threads.net',
    'douyin.com'
  ];

  function isMajorVideoPlatform(urlStr) {
    try {
      const host = new URL(urlStr).hostname.toLowerCase();
      return PLATFORM_HOSTS.some((d) => host === d || host.endsWith('.' + d));
    } catch {
      return false;
    }
  }

  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let val = bytes;
    while (val >= 1024 && i < units.length - 1) {
      val /= 1024;
      i++;
    }
    return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function sanitizeTitle(raw) {
    if (!raw) return `video_${Date.now()}`;
    return raw
      .replace(/\s*[-|•·]\s*(YouTube|TikTok|Facebook|Instagram|X|Twitter|Vimeo|Bilibili|Twitch|Dailymotion).*$/i, '')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || `video_${Date.now()}`;
  }

  function extractVideoTitle(video) {
    const host = window.location.hostname.toLowerCase();
    if (host.includes('youtube.com')) {
      const ytTitle =
        document.querySelector('h1.ytd-watch-metadata yt-formatted-string, h1.ytd-video-primary-info-renderer, #title h1')?.textContent ||
        video?.closest('ytd-rich-item-renderer, ytd-video-renderer, ytd-reel-video-renderer')?.querySelector('#video-title, h2')?.textContent;
      if (ytTitle && ytTitle.trim()) return sanitizeTitle(ytTitle.trim());
    }

    if (video) {
      const container = video.closest('article, [role="article"], [data-e2e="feed-video"], .video-item, .player');
      const aria = video.getAttribute('aria-label') || video.getAttribute('title');
      if (aria && aria.trim().length > 2 && !/^video$/i.test(aria.trim())) {
        return sanitizeTitle(aria.trim());
      }
      if (container) {
        const heading = container.querySelector('h1, h2, h3, [data-e2e="browse-video-desc"], [data-e2e="video-desc"]');
        if (heading && heading.textContent && heading.textContent.trim().length > 2) {
          return sanitizeTitle(heading.textContent.trim());
        }
      }
    }

    return sanitizeTitle(document.title || `video_${Date.now()}`);
  }

  function findClosestVideoPermalink(video) {
    const pageUrl = window.location.href;
    if (!video) return pageUrl;

    try {
      const host = window.location.hostname.toLowerCase();

      if (
        (host.includes('youtube.com') && (location.pathname === '/watch' || location.pathname.startsWith('/shorts/'))) ||
        (host.includes('tiktok.com') && location.pathname.includes('/video/')) ||
        (host.includes('facebook.com') && /\/(reel|videos|watch)\b/i.test(location.pathname + location.search)) ||
        (host.includes('instagram.com') && /\/(reel|reels|p)\//i.test(location.pathname)) ||
        ((host.includes('x.com') || host.includes('twitter.com')) && location.pathname.includes('/status/'))
      ) {
        return pageUrl;
      }

      const container = video.closest(
        'article, [role="article"], ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer, [data-e2e="recommend-list-item-container"], [data-pagelet*="FeedUnit"], .feed-item'
      );

      if (container) {
        const linkSelectors = [
          'a[href*="/watch?v="]',
          'a[href*="/shorts/"]',
          'a[href*="/video/"]',
          'a[href*="/reel/"]',
          'a[href*="/reels/"]',
          'a[href*="/videos/"]',
          'a[href*="/status/"]',
          'a[href*="/p/"]'
        ];
        for (const sel of linkSelectors) {
          const a = container.querySelector(sel);
          if (a && a.href && a.href.startsWith('http')) {
            return a.href;
          }
        }
      }
    } catch {
      // Fallback to current URL
    }

    return pageUrl;
  }

  function getDirectVideoUrls(video) {
    const urls = [];
    if (!video) return urls;
    const candidates = [video.currentSrc, video.src];
    video.querySelectorAll('source').forEach((s) => {
      if (s.src) candidates.push(s.src);
    });
    for (const c of candidates) {
      if (typeof c === 'string' && /^https?:\/\//i.test(c) && !urls.includes(c)) {
        urls.push(c);
      }
    }
    return urls;
  }

  const AD_HOST_KEYWORDS = [
    'doubleclick.net',
    'googlesyndication.com',
    'googleadservices.com',
    'imasdk.googleapis.com',
    'exoclick.com',
    'exosrv.com',
    'realsrv.com',
    'magsrv.com',
    'tsyndicate.com',
    'trafficjunky.net',
    'traffichaus.com',
    'juicyads.com',
    'adsterra',
    'hilltopads',
    'clickadu',
    'popads',
    'spotxchange',
    'springserve',
    'jwpltx',
    'stripchat',
    'chaturbate',
    'bongacams',
    'livejasmin',
    'cam4',
    'myfreecams',
    'jerkmate',
    'xlovecam',
    'adnxs.com',
    'rubiconproject',
    'pubmatic',
    'openx.net',
    'criteo',
    'taboola',
    'outbrain'
  ];

  function isAdNetworkUrl(urlStr) {
    if (!urlStr || typeof urlStr !== 'string') return false;
    try {
      const parsed = new URL(urlStr);
      const host = parsed.hostname.toLowerCase();
      if (AD_HOST_KEYWORDS.some((kw) => host.includes(kw))) {
        return true;
      }
      const pathAndQuery = `${parsed.pathname}${parsed.search}`.toLowerCase();
      return /(^|[/_.-])(ads?|adserver|advert|preroll|midroll|postroll|vast|vpaid|promo|banner|sponsor|commercial)([/_.-]|$)/i.test(pathAndQuery);
    } catch {
      return false;
    }
  }

  function isPreviewClipUrl(urlStr) {
    if (!urlStr || typeof urlStr !== 'string') return false;
    try {
      const parsed = new URL(urlStr);
      const pathAndQuery = `${parsed.pathname}${parsed.search}`.toLowerCase();
      return /(^|[/_.-])(preview|trailer|teaser|sample)([/_.-]|$)/i.test(pathAndQuery);
    } catch {
      return false;
    }
  }

  function formatDuration(sec) {
    if (!sec || !Number.isFinite(sec) || sec <= 0) return '';
    const total = Math.round(sec);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    if (m > 0) return `${m}:${String(s).padStart(2, '0')}`;
    return `${s}s`;
  }

  function isNoiseMediaUrl(urlStr) {
    if (!urlStr || !urlStr.startsWith('http')) return true;
    const lower = urlStr.toLowerCase();
    return (
      isAdNetworkUrl(urlStr) ||
      lower.includes('googlevideo.com/videoplayback') ||
      lower.includes('bytestart=') ||
      /[?&]range=\d+-\d+/i.test(lower) ||
      /[?&]sq=\d+/i.test(lower) ||
      /\/(seg|segment|chunk|frag|fragment)[_-]?\d+/i.test(lower)
    );
  }

  function inferStreamEntry(rawUrl, priorityBoost = 0, meta = {}) {
    if (!rawUrl || isNoiseMediaUrl(rawUrl)) return null;
    const lower = rawUrl.toLowerCase();
    const isHls = /\.m3u8(\?|$|#)/i.test(lower);
    const isDash = /\.mpd(\?|$|#)/i.test(lower);
    const directMatch = lower.match(/\.(mp4|webm|mkv|mov|flv|m4v)(\?|$|#)/i);
    if (!isHls && !isDash && !directMatch) return null;

    const type = isHls ? 'hls' : (isDash ? 'dash' : 'direct');
    const ext = isHls || isDash ? 'mp4' : directMatch[1].toLowerCase();
    const isMaster = isHls && /(master|playlist|index)/i.test(lower);
    const heightMatch = meta.resolution ? String(meta.resolution).match(/x(\d+)/i) : null;
    const resQuality = heightMatch ? `${heightMatch[1]}p` : '';
    const quality = resQuality || (isHls
      ? (isMaster ? 'HLS Master' : 'HLS Stream')
      : (isDash ? 'DASH Stream' : ext.toUpperCase()));

    let fileName = `video.${ext}`;
    try {
      const parts = new URL(rawUrl).pathname.split('/').filter(Boolean);
      const last = parts[parts.length - 1];
      if (last) {
        fileName = decodeURIComponent(last).replace(/[<>:"/\\|?*]/g, '_').replace(/\.(m3u8|mpd)$/i, `.${ext}`);
      }
    } catch {
      // Ignore
    }

    const duration = Number(meta.duration) || 0;
    const estimatedSize = Number(meta.estimatedSize) || 0;
    let priority;
    if (isPreviewClipUrl(rawUrl)) {
      priority = 15;
    } else if (duration > 0 && duration <= 45) {
      priority = 20;
    } else if (isHls) {
      if (duration >= 300) {
        priority = 160 + (isMaster ? 15 : 0) + priorityBoost;
      } else {
        priority = (isMaster ? 115 : 105) + priorityBoost;
      }
    } else if (isDash) {
      priority = (duration >= 300 ? 155 : 100) + priorityBoost;
    } else {
      priority = 55 + priorityBoost;
    }

    return {
      url: rawUrl,
      type,
      ext,
      size: estimatedSize,
      isEstimatedSize: Boolean(meta.isEstimatedSize && estimatedSize > 0),
      duration,
      bandwidth: Number(meta.bandwidth) || 0,
      resolution: meta.resolution || '',
      quality,
      fileName,
      priority,
      detectedAt: Date.now()
    };
  }

  function decodeBaseN(token, radix) {
    const digits = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let value = 0;
    for (let i = 0; i < token.length; i++) {
      const idx = digits.indexOf(token[i]);
      if (idx === -1 || idx >= radix) return NaN;
      value = value * radix + idx;
    }
    return value;
  }

  const scannedScripts = new WeakSet();
  const requestedPageProbes = new Set();
  let lastPerfEntryCount = 0;

  function readJsStringLiteral(sourceText, quoteIdx) {
    const quote = sourceText[quoteIdx];
    if (quote !== '\'' && quote !== '"') return null;
    let out = '';
    for (let i = quoteIdx + 1; i < sourceText.length; i++) {
      const ch = sourceText[i];
      if (ch === '\\') {
        if (i + 1 >= sourceText.length) return null;
        const next = sourceText[++i];
        if (next === 'n') out += '\n';
        else if (next === 'r') out += '\r';
        else if (next === 't') out += '\t';
        else if (next === 'x' && i + 2 < sourceText.length) {
          const code = parseInt(sourceText.slice(i + 1, i + 3), 16);
          if (!Number.isNaN(code)) {
            out += String.fromCharCode(code);
            i += 2;
          } else {
            out += 'x';
          }
        } else if (next === 'u' && i + 4 < sourceText.length) {
          const code = parseInt(sourceText.slice(i + 1, i + 5), 16);
          if (!Number.isNaN(code)) {
            out += String.fromCharCode(code);
            i += 4;
          } else {
            out += 'u';
          }
        } else {
          out += next;
        }
      } else if (ch === quote) {
        return { value: out, endIndex: i };
      } else {
        out += ch;
      }
    }
    return null;
  }

  function skipWhitespace(str, idx) {
    let pos = idx;
    while (pos < str.length && /\s/.test(str[pos])) pos++;
    return pos;
  }

  function unpackDeanEdwardsBlocks(sourceText) {
    if (!sourceText || typeof sourceText !== 'string' || !sourceText.includes('eval')) {
      return [];
    }
    const results = [];
    const headerRegex = /eval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e\s*,\s*[a-zA-Z_$][a-zA-Z0-9_$]*\s*\)/g;
    let headerMatch;
    while ((headerMatch = headerRegex.exec(sourceText)) !== null) {
      try {
        const searchStart = headerMatch.index + headerMatch[0].length;
        const searchWindow = sourceText.slice(searchStart, searchStart + 1200);
        const splitOffset = searchWindow.indexOf('}(');
        const altOffset = splitOffset !== -1 ? splitOffset : searchWindow.search(/\}\s*\(/);
        if (altOffset === -1) continue;

        let pos = searchStart + altOffset + 1;
        pos = skipWhitespace(sourceText, pos);
        if (sourceText[pos] !== '(') continue;
        pos = skipWhitespace(sourceText, pos + 1);

        const payloadLit = readJsStringLiteral(sourceText, pos);
        if (!payloadLit) continue;

        pos = skipWhitespace(sourceText, payloadLit.endIndex + 1);
        if (sourceText[pos] !== ',') continue;
        pos = skipWhitespace(sourceText, pos + 1);

        const radixMatch = sourceText.slice(pos, pos + 16).match(/^(\d+)\s*,\s*(\d+)\s*,/);
        if (!radixMatch) continue;
        const radix = parseInt(radixMatch[1], 10);
        const count = parseInt(radixMatch[2], 10);
        if (!radix || radix < 2 || radix > 62 || !count) continue;

        pos = skipWhitespace(sourceText, pos + radixMatch[0].length);
        const dictLit = readJsStringLiteral(sourceText, pos);
        if (!dictLit) continue;

        const afterDict = sourceText.slice(dictLit.endIndex + 1, dictLit.endIndex + 32);
        if (!/^\s*\.split\s*\(\s*(['"])\|\1\s*\)/.test(afterDict)) continue;

        const dict = dictLit.value.split('|');
        const unpacked = payloadLit.value.replace(/\b[0-9a-zA-Z]+\b/g, (tok) => {
          const idx = decodeBaseN(tok, radix);
          if (!Number.isNaN(idx) && idx >= 0 && idx < dict.length && dict[idx]) {
            return dict[idx];
          }
          return tok;
        });
        results.push(unpacked);
        headerRegex.lastIndex = dictLit.endIndex + 1;
      } catch {
        // Ignore malformed packed script block
      }
    }
    return results;
  }

  function mergeDiscoveredMedia(items) {
    if (!Array.isArray(items) || items.length === 0) return;
    const changedItems = [];
    for (const item of items) {
      if (!item || !item.url || isAdNetworkUrl(item.url)) continue;
      const idx = sniffedMedia.findIndex((m) => m.url === item.url);
      if (idx === -1) {
        sniffedMedia.unshift(item);
        changedItems.push(item);
      } else {
        const prev = sniffedMedia[idx];
        const next = { ...prev };
        let updated = false;
        if ((item.duration || 0) > (prev.duration || 0)) {
          next.duration = item.duration;
          updated = true;
        }
        if ((item.size || 0) > (prev.size || 0)) {
          next.size = item.size;
          next.isEstimatedSize = Boolean(item.isEstimatedSize);
          updated = true;
        }
        if ((item.bandwidth || 0) > (prev.bandwidth || 0)) {
          next.bandwidth = item.bandwidth;
          updated = true;
        }
        if (item.resolution && !prev.resolution) {
          next.resolution = item.resolution;
          updated = true;
        }
        if (item.quality && (/^HLS (Master|Stream)$/i.test(prev.quality || '') || !prev.quality) && !/^HLS (Master|Stream)$/i.test(item.quality)) {
          next.quality = item.quality;
          updated = true;
        }
        if (updated && item.priority !== undefined && item.priority !== prev.priority) {
          next.priority = item.priority;
        } else if ((item.priority || 0) > (prev.priority || 0)) {
          next.priority = item.priority;
          updated = true;
        }
        if (updated) {
          sniffedMedia[idx] = next;
          changedItems.push(next);
        }
      }
    }
    if (changedItems.length > 0) {
      sniffedMedia.sort((a, b) => {
        if ((b.priority || 0) !== (a.priority || 0)) return (b.priority || 0) - (a.priority || 0);
        if ((b.size || 0) !== (a.size || 0)) return (b.size || 0) - (a.size || 0);
        if ((b.duration || 0) !== (a.duration || 0)) return (b.duration || 0) - (a.duration || 0);
        return (b.detectedAt || 0) - (a.detectedAt || 0);
      });
      if (isContextValid()) {
        try {
          chrome.runtime.sendMessage({ type: 'IDMLITE_REPORT_MEDIA', mediaList: changedItems }, () => {
            if (chrome.runtime.lastError) {
              // Ignore
            }
          });
        } catch {
          // Ignore
        }
      }
      if (activeVideo && typeof wrapEl !== 'undefined' && wrapEl.classList.contains('visible')) {
        updatePrimaryBadge();
        if (isMenuOpen) renderDropdownMenu();
      }
    }
  }

  function requestPageHlsProbe(hlsUrl) {
    if (!hlsUrl || requestedPageProbes.has(hlsUrl)) return;
    if (requestedPageProbes.size >= 100) {
      const oldest = requestedPageProbes.values().next().value;
      if (oldest) requestedPageProbes.delete(oldest);
    }
    requestedPageProbes.add(hlsUrl);
    try {
      window.postMessage({ __idmliteProbeHls: true, url: hlsUrl }, '*');
    } catch {
      // Ignore postMessage failure
    }
  }

  function discoverLocalPageStreams() {
    if (isMajorVideoPlatform(window.location.href)) return [];
    const found = [];
    const seen = new Set();

    const addCandidate = (rawUrl, boost = 0) => {
      if (!rawUrl || seen.has(rawUrl)) return;
      const entry = inferStreamEntry(rawUrl, boost);
      if (entry) {
        seen.add(rawUrl);
        found.push(entry);
        if (entry.type === 'hls') {
          requestPageHlsProbe(entry.url);
        }
      }
    };

    // 1. New Performance resource entries only (incremental, skip timed-out/failed probes)
    try {
      const entries = performance.getEntriesByType('resource');
      if (entries.length < lastPerfEntryCount) {
        lastPerfEntryCount = 0;
      }
      for (let i = entries.length - 1; i >= lastPerfEntryCount; i--) {
        const entry = entries[i];
        if (!entry || entry.responseEnd <= 0) continue;
        if (typeof entry.responseStatus === 'number' && entry.responseStatus >= 400) continue;
        addCandidate(entry.name, 5);
      }
      lastPerfEntryCount = entries.length;
    } catch {
      // Ignore
    }

    // 2. Active episode / player DOM attributes (e.g., data-link on movie watch pages)
    try {
      const body = document.body;
      if (body) {
        const sv = body.getAttribute('data-sv-ep') || body.getAttribute('data-server');
        const ep = body.getAttribute('data-episode');
        if (sv && ep) {
          const activeEpEl = document.querySelector(`#episode_${sv}-${ep}[data-link], #episode_${sv}-${ep} [data-link]`);
          if (activeEpEl) addCandidate(activeEpEl.getAttribute('data-link'), 20);
        }
      }
      const activeNodes = document.querySelectorAll('.btn-episode.active[data-link], a.active[data-link], [data-link*=".m3u8"].active, [data-src*=".m3u8"].active');
      activeNodes.forEach((el) => {
        addCandidate(el.getAttribute('data-link') || el.getAttribute('data-src'), 15);
      });

      if (found.length === 0) {
        const genericNodes = document.querySelectorAll('[data-link*=".m3u8"], [data-src*=".m3u8"], [data-url*=".m3u8"]');
        for (let i = 0; i < Math.min(genericNodes.length, 5); i++) {
          const el = genericNodes[i];
          addCandidate(el.getAttribute('data-link') || el.getAttribute('data-src') || el.getAttribute('data-url'), 0);
        }
      }
    } catch {
      // Ignore
    }

    // 3. New inline <script> elements only + linear-time Dean Edwards unpacker
    try {
      const streamUrlRegex = /(?:https?:)?\/\/[^\s"'<>\\`]+\.(?:m3u8|mpd)(?:\?[^\s"'<>\\`]*)?/gi;
      const scripts = document.querySelectorAll('script:not([src])');
      for (const script of scripts) {
        if (scannedScripts.has(script)) continue;
        scannedScripts.add(script);
        const rawText = script.textContent || '';
        if (!rawText || rawText.length > 300000) continue;
        const unpackedBlocks = unpackDeanEdwardsBlocks(rawText);
        const textsToScan = [...unpackedBlocks, rawText.replace(/\\\//g, '/')];
        for (const text of textsToScan) {
          const matches = text.match(streamUrlRegex);
          if (!matches) continue;
          for (const rawUrl of matches) {
            let cleanUrl = rawUrl.replace(/&amp;/g, '&');
            if (cleanUrl.startsWith('//')) cleanUrl = `${window.location.protocol}${cleanUrl}`;
            const isMaster = /(master|playlist|index)\.m3u8/i.test(cleanUrl);
            addCandidate(cleanUrl, isMaster ? 25 : 15);
          }
        }
      }
    } catch {
      // Ignore inline script scan errors
    }

    mergeDiscoveredMedia(found);
    return found;
  }

  // Receive dynamically hooked stream URLs (fetch / XHR / player globals) from MAIN-world page_hook.js
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.__idmliteStream !== true || !event.data.url) return;
    const entry = inferStreamEntry(event.data.url, 22, event.data);
    if (entry) {
      mergeDiscoveredMedia([entry]);
    }
  });

  // Track real <video> duration once loaded so short 22s preroll/midroll ads are immediately demoted
  document.addEventListener(
    'loadedmetadata',
    (e) => {
      const video = e.target;
      if (!(video instanceof HTMLVideoElement)) return;
      const src = video.currentSrc || video.src || '';
      if (!src.startsWith('http')) return;
      if (!Number.isFinite(video.duration) || video.duration <= 0) return;
      const entry = inferStreamEntry(src, 0, { duration: Math.round(video.duration) });
      if (entry) {
        mergeDiscoveredMedia([entry]);
      }
    },
    true
  );

  // Create neutral custom-tag Shadow DOM host immune to adblock/WebShield overlay heuristics
  const INSTANCE_ID = `idm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  let isDisposed = false;
  let hostObserver = null;
  let parentObserver = null;
  let watchdogInterval = null;

  try {
    document.querySelectorAll('idm-ext-ui').forEach((el) => {
      try {
        el.remove();
      } catch {
        // Ignore stale host removal errors
      }
    });
    if (document.documentElement) {
      document.documentElement.dataset.idmActiveInstance = INSTANCE_ID;
    }
  } catch {
    // Ignore DOM cleanup errors
  }

  const host = document.createElement('idm-ext-ui');
  host.dataset.idmInstance = INSTANCE_ID;
  host.setAttribute('style', HOST_CSS);
  const shadow = host.attachShadow({ mode: 'closed' });

  shadow.innerHTML = `
    <style>
      :host { all: initial !important; }
      * { box-sizing: border-box; font-family: 'Segoe UI', Inter, system-ui, -apple-system, sans-serif; }
      .idm-wrap {
        position: fixed;
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 6px;
        pointer-events: none;
        z-index: 2147483000;
        opacity: 0;
        visibility: hidden;
        transform: translateY(-4px);
        transition: opacity 0.18s ease, transform 0.18s ease, visibility 0.18s ease;
      }
      .idm-wrap.visible {
        opacity: 1;
        visibility: visible;
        transform: translateY(0);
      }
      .idm-bar {
        pointer-events: none;
        display: inline-flex;
        align-items: center;
        background: rgba(20, 22, 31, 0.94);
        backdrop-filter: blur(8px);
        border: 1px solid rgba(0, 230, 118, 0.55);
        border-radius: 8px;
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.55), 0 0 12px rgba(0, 230, 118, 0.22);
        overflow: hidden;
        color: #f3f4f6;
        user-select: none;
        transition: transform 0.15s ease, box-shadow 0.15s ease;
      }
      .idm-wrap.visible .idm-bar {
        pointer-events: auto;
      }
      .idm-bar:hover {
        border-color: #00e676;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.65), 0 0 16px rgba(0, 230, 118, 0.35);
      }
      .idm-main-btn {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        background: transparent;
        border: none;
        color: #ffffff;
        padding: 6px 10px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        white-space: nowrap;
        line-height: 1.2;
      }
      .idm-main-btn:hover {
        background: rgba(0, 230, 118, 0.14);
      }
      .idm-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 18px;
        height: 18px;
        border-radius: 4px;
        background: linear-gradient(135deg, #00b050, #00e676);
        color: #000000;
        font-weight: 900;
        font-size: 12px;
        flex-shrink: 0;
      }
      .idm-badge {
        font-size: 10px;
        font-weight: 700;
        color: #00e676;
        background: rgba(0, 230, 118, 0.12);
        border: 1px solid rgba(0, 230, 118, 0.28);
        border-radius: 4px;
        padding: 1px 5px;
      }
      .idm-sep {
        width: 1px;
        height: 20px;
        background: rgba(255, 255, 255, 0.12);
      }
      .idm-drop-btn, .idm-close-btn {
        background: transparent;
        border: none;
        color: #9ca3af;
        padding: 6px 7px;
        cursor: pointer;
        font-size: 11px;
        line-height: 1;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      .idm-drop-btn:hover {
        background: rgba(255, 255, 255, 0.08);
        color: #ffffff;
      }
      .idm-close-btn:hover {
        background: rgba(255, 82, 82, 0.18);
        color: #ff5252;
      }
      .idm-menu {
        pointer-events: none;
        display: none;
        flex-direction: column;
        min-width: 260px;
        max-width: 340px;
        max-height: 300px;
        overflow-y: auto;
        background: rgba(20, 22, 31, 0.98);
        backdrop-filter: blur(10px);
        border: 1px solid #2e344e;
        border-radius: 8px;
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.72);
        padding: 5px;
        gap: 2px;
      }
      .idm-wrap.visible .idm-menu.open {
        display: flex;
        pointer-events: auto;
      }
      .idm-menu-header {
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.6px;
        color: #6b7280;
        padding: 5px 8px 3px;
      }
      .idm-menu-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        width: 100%;
        text-align: left;
        background: transparent;
        border: none;
        border-radius: 6px;
        color: #e5e7eb;
        padding: 7px 9px;
        font-size: 12px;
        cursor: pointer;
      }
      .idm-menu-item:hover {
        background: rgba(0, 230, 118, 0.14);
        color: #ffffff;
      }
      .idm-item-left {
        display: flex;
        align-items: center;
        gap: 7px;
        min-width: 0;
        flex: 1;
      }
      .idm-item-label {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .idm-item-tag {
        font-size: 10px;
        font-weight: 700;
        padding: 2px 5px;
        border-radius: 4px;
        background: rgba(255, 255, 255, 0.08);
        color: #00e676;
        flex-shrink: 0;
      }
      .idm-toast {
        pointer-events: none;
        display: none;
        background: rgba(20, 22, 31, 0.96);
        border: 1px solid #00e676;
        color: #ffffff;
        font-size: 11px;
        font-weight: 600;
        padding: 5px 10px;
        border-radius: 6px;
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5);
      }
      .idm-toast.show {
        display: block;
      }
      .idm-toast.error {
        border-color: #ff5252;
        color: #ff8a80;
      }
    </style>
    <div class="idm-wrap" id="idm-wrap">
      <div class="idm-bar" id="idm-bar">
        <button type="button" class="idm-main-btn" id="idm-main-btn" title="Tải video này bằng IDM Lite">
          <span class="idm-icon">↓</span>
          <span>Tải video này</span>
          <span class="idm-badge" id="idm-badge">HD</span>
        </button>
        <span class="idm-sep"></span>
        <button type="button" class="idm-drop-btn" id="idm-drop-btn" title="Chọn chất lượng / luồng video">▾</button>
        <span class="idm-sep"></span>
        <button type="button" class="idm-close-btn" id="idm-close-btn" title="Ẩn nút trên video này">×</button>
      </div>
      <div class="idm-menu" id="idm-menu"></div>
      <div class="idm-toast" id="idm-toast"></div>
    </div>
  `;

  function isInstanceActive() {
    if (isDisposed) return false;
    try {
      if (document.documentElement && document.documentElement.dataset.idmActiveInstance !== INSTANCE_ID) {
        return false;
      }
    } catch {
      return false;
    }
    return isContextValid();
  }

  function disposeInstance() {
    if (isDisposed) return;
    isDisposed = true;
    if (watchdogInterval) {
      clearInterval(watchdogInterval);
      watchdogInterval = null;
    }
    clearHideTimers();
    try {
      if (hostObserver) hostObserver.disconnect();
    } catch {
      // Ignore
    }
    try {
      if (parentObserver) parentObserver.disconnect();
    } catch {
      // Ignore
    }
    try {
      document.removeEventListener('fullscreenchange', ensureHostIntegrity);
    } catch {
      // Ignore
    }
    try {
      host.remove();
    } catch {
      // Ignore
    }
    try {
      window.__idmliteContentLoaded = false;
    } catch {
      // Ignore
    }
  }

  function ensureHostIntegrity() {
    if (!isInstanceActive()) {
      disposeInstance();
      return;
    }
    try {
      document.querySelectorAll('idm-ext-ui').forEach((el) => {
        if (el !== host && el.dataset?.idmInstance !== INSTANCE_ID) {
          try {
            el.remove();
          } catch {
            // Ignore foreign host removal errors
          }
        }
      });
    } catch {
      // Ignore DOM scan errors
    }
    const targetParent = document.fullscreenElement || document.documentElement;
    if (targetParent && host.parentElement !== targetParent) {
      targetParent.appendChild(host);
    }
    if (host.hasAttribute('hidden')) {
      host.removeAttribute('hidden');
    }
    if (host.getAttribute('style') !== HOST_CSS) {
      host.setAttribute('style', HOST_CSS);
    }
  }

  ensureHostIntegrity();
  document.addEventListener('fullscreenchange', ensureHostIntegrity);

  // Self-heal if WebShield / adblocker / page scripts hide or detach our host element
  try {
    hostObserver = new MutationObserver(() => {
      ensureHostIntegrity();
    });
    hostObserver.observe(host, {
      attributes: true,
      attributeFilter: ['style', 'hidden', 'class']
    });

    parentObserver = new MutationObserver(() => {
      if (!isInstanceActive()) {
        disposeInstance();
        return;
      }
      if (!host.isConnected) {
        ensureHostIntegrity();
      }
    });
    if (document.documentElement) {
      parentObserver.observe(document.documentElement, { childList: true });
    }
  } catch {
    // Fallback handled by 500ms watchdog below
  }

  const wrapEl = shadow.getElementById('idm-wrap');
  const barEl = shadow.getElementById('idm-bar');
  const mainBtn = shadow.getElementById('idm-main-btn');
  const badgeEl = shadow.getElementById('idm-badge');
  const dropBtn = shadow.getElementById('idm-drop-btn');
  const closeBtn = shadow.getElementById('idm-close-btn');
  const menuEl = shadow.getElementById('idm-menu');
  const toastEl = shadow.getElementById('idm-toast');

  function showToast(text, isError = false) {
    toastEl.textContent = text;
    toastEl.className = `idm-toast show${isError ? ' error' : ''}`;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.className = 'idm-toast';
    }, 3000);
  }

  function buildCandidateOptions(video) {
    const permalink = findClosestVideoPermalink(video);
    const title = extractVideoTitle(video);
    const directUrls = getDirectVideoUrls(video);
    const isPlatform = isMajorVideoPlatform(permalink);
    const isYouTube = /(^|\.)youtube\.com$|(^|\.)youtu\.be$/i.test(window.location.hostname);
    const options = [];
    const streamCandidates = [];
    const videoDur = video && Number.isFinite(video.duration) && video.duration > 0 ? Math.round(video.duration) : 0;

    if (!isPlatform) {
      directUrls.forEach((u, idx) => {
        if (isAdNetworkUrl(u)) return;
        const isHls = /\.m3u8(\?|$|#)/i.test(u);
        const ext = isHls ? 'mp4' : (u.match(/\.(mp4|webm|mkv|mov|flv)(\?|$)/i)?.[1]?.toLowerCase() || 'mp4');
        const isShort = isPreviewClipUrl(u) || (videoDur > 0 && videoDur <= 45);
        const priority = isPreviewClipUrl(u) ? 15 : (isShort ? 20 : (isHls ? 105 : 65));
        streamCandidates.push({
          label: idx === 0 ? `Video trên trang (${ext.toUpperCase()})` : `Nguồn video #${idx + 1} (${ext.toUpperCase()})`,
          tag: isShort && videoDur > 0 ? `Clip ${formatDuration(videoDur)}` : (isHls ? 'HLS' : ext.toUpperCase()),
          url: u,
          pageUrl: permalink,
          videoType: isHls ? 'hls' : 'direct',
          quality: 'best',
          fileName: `${title}.${ext}`,
          priority,
          size: 0,
          isEstimatedSize: false,
          duration: videoDur
        });
      });
    }

    if (!isYouTube) {
      for (const m of sniffedMedia) {
        if (!m || !m.url || isAdNetworkUrl(m.url)) continue;
        const cand = {
          label: m.fileName || 'Stream',
          tag: (m.duration > 0 && m.duration <= 45) ? `Clip ${formatDuration(m.duration)}` : (m.quality || m.type.toUpperCase()),
          url: m.url,
          pageUrl: permalink,
          videoType: m.type,
          quality: 'best',
          fileName: `${title}.${m.ext || 'mp4'}`,
          priority: Number(m.priority) || 50,
          size: Number(m.size) || 0,
          isEstimatedSize: Boolean(m.isEstimatedSize),
          duration: Number(m.duration) || 0
        };
        const existingIdx = streamCandidates.findIndex((c) => c.url === m.url);
        if (existingIdx !== -1) {
          if (
            cand.priority >= streamCandidates[existingIdx].priority ||
            cand.size > streamCandidates[existingIdx].size ||
            cand.duration > streamCandidates[existingIdx].duration
          ) {
            streamCandidates[existingIdx] = cand;
          }
        } else {
          streamCandidates.push(cand);
        }
      }
    }

    streamCandidates.sort((a, b) => {
      if ((b.priority || 0) !== (a.priority || 0)) return (b.priority || 0) - (a.priority || 0);
      if ((b.size || 0) !== (a.size || 0)) return (b.size || 0) - (a.size || 0);
      return (b.duration || 0) - (a.duration || 0);
    });

    for (const c of streamCandidates) {
      const durText = formatDuration(c.duration);
      const sizeText = c.size > 0 ? `${c.isEstimatedSize ? '~' : ''}${formatBytes(c.size)}` : '';
      const shortNote = c.duration > 0 && c.duration <= 45 ? 'Clip ngắn / QC' : '';
      const details = [durText, sizeText, shortNote].filter(Boolean).join(' • ');
      options.push({
        group: 'stream',
        label: details ? `${c.label} (${details})` : c.label,
        tag: c.tag,
        url: c.url,
        pageUrl: c.pageUrl,
        videoType: c.videoType,
        quality: c.quality,
        fileName: c.fileName
      });
    }

    const primaryStream = !isPlatform && options.length > 0 ? options[0] : null;
    const presetTargetUrl = primaryStream ? primaryStream.url : permalink;
    const presetVideoType = primaryStream ? primaryStream.videoType : 'ytdlp';

    const ytdlpPresets = [
      { label: '🎬 Chất lượng cao nhất (Best / 1080p+)', tag: 'BEST', quality: 'best', ext: 'mp4' },
      { label: '📺 Bản 720p HD (MP4)', tag: '720p', quality: '720p', ext: 'mp4' },
      { label: '📱 Bản 480p (Tiết kiệm)', tag: '480p', quality: '480p', ext: 'mp4' },
      { label: '🎵 Chỉ tải âm thanh (M4A / MP3)', tag: 'AUDIO', quality: 'audio', ext: 'm4a' }
    ];

    for (const preset of ytdlpPresets) {
      options.push({
        group: 'ytdlp',
        label: preset.label,
        tag: preset.tag,
        url: presetTargetUrl,
        pageUrl: permalink,
        videoType: presetVideoType,
        quality: preset.quality,
        fileName: `${title}.${preset.ext}`
      });
    }

    return options;
  }

  function isContextValid() {
    try {
      return Boolean(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  function extractPageCdnHeaders() {
    const headers = {};
    try {
      const cdnCfg = document.getElementById('cdn-config');
      if (cdnCfg && cdnCfg.dataset) {
        const m3u8Enabled = cdnCfg.dataset.video_m3u8_cdn_enabled === '1';
        const otherEnabled = cdnCfg.dataset.video_other_cdn_enabled === '1';
        const authKey = (cdnCfg.dataset.video_cdn_auth_key || '').trim();
        const authVal = (cdnCfg.dataset.video_cdn_auth_value || '').trim();
        const cdnApp = (cdnCfg.dataset.cdn_app || '').trim();
        if ((m3u8Enabled || otherEnabled) && authKey && authVal) {
          headers[authKey] = authVal;
          if (cdnApp) {
            headers['x-cdn-app'] = cdnApp;
          }
        }
      }
    } catch {
      // Ignore DOM access errors
    }
    return headers;
  }

  function sendDownloadDirectlyToApp(payload) {
    return fetch('http://127.0.0.1:9091/add-download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: payload.url,
        pageUrl: payload.pageUrl,
        fileName: payload.fileName,
        title: payload.title,
        referrer: payload.referrer,
        userAgent: navigator.userAgent || '',
        isVideo: true,
        videoType: payload.videoType || 'auto',
        quality: payload.quality || 'best',
        customHeaders: payload.customHeaders || {}
      })
    }).then((res) => res.json().catch(() => ({})));
  }

  function triggerDownload(option) {
    showToast('⏳ Đang gửi tới IDM Lite...');
    const payload = {
      type: 'IDMLITE_DOWNLOAD_VIDEO',
      url: option.url,
      pageUrl: option.pageUrl,
      title: extractVideoTitle(activeVideo),
      fileName: option.fileName,
      videoType: option.videoType,
      quality: option.quality,
      referrer: window.location.href,
      customHeaders: extractPageCdnHeaders()
    };

    if (!isContextValid()) {
      sendDownloadDirectlyToApp(payload)
        .then((data) => {
          if (data && data.success) {
            showToast('✓ Đã mở hộp thoại tải IDM Lite!');
          } else {
            showToast('⚠ Extension vừa cập nhật — hãy tải lại trang (F5) nếu thiếu cookie/header', true);
          }
        })
        .catch(() => {
          showToast('⚠ Extension vừa cập nhật — hãy F5 trang hoặc bật IDM Lite', true);
        });
      return;
    }

    try {
      chrome.runtime.sendMessage(payload, (res) => {
        try {
          if (chrome.runtime.lastError) {
            sendDownloadDirectlyToApp(payload)
              .then((data) => {
                if (data && data.success) {
                  showToast('✓ Đã mở hộp thoại tải IDM Lite!');
                } else {
                  showToast('⚠ Lỗi giao tiếp extension', true);
                }
              })
              .catch(() => showToast('⚠ Lỗi giao tiếp extension', true));
            return;
          }
          if (res && res.success) {
            showToast('✓ Đã mở hộp thoại tải IDM Lite!');
          } else {
            showToast(`⚠ ${res?.error || 'Hãy bật ứng dụng IDM Lite'}`, true);
          }
        } catch {
          showToast('⚠ Lỗi giao tiếp extension — thử F5 lại trang', true);
        }
      });
    } catch {
      sendDownloadDirectlyToApp(payload)
        .then((data) => {
          if (data && data.success) {
            showToast('✓ Đã mở hộp thoại tải IDM Lite!');
          } else {
            showToast('⚠ Extension vừa cập nhật — hãy tải lại trang (F5)', true);
          }
        })
        .catch(() => {
          showToast('⚠ Extension vừa cập nhật — hãy F5 lại trang', true);
        });
    }
  }

  function renderDropdownMenu() {
    const options = buildCandidateOptions(activeVideo);
    menuEl.innerHTML = '';

    const streams = options.filter((o) => o.group === 'stream');
    const presets = options.filter((o) => o.group === 'ytdlp');

    if (streams.length > 0) {
      const h = document.createElement('div');
      h.className = 'idm-menu-header';
      h.textContent = 'Luồng video bắt được trực tiếp';
      menuEl.appendChild(h);

      streams.slice(0, 8).forEach((opt) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'idm-menu-item';
        btn.innerHTML = `
          <span class="idm-item-left"><span class="idm-item-label"></span></span>
          <span class="idm-item-tag"></span>
        `;
        btn.querySelector('.idm-item-label').textContent = opt.label;
        btn.querySelector('.idm-item-tag').textContent = opt.tag;
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          isMenuOpen = false;
          menuEl.classList.remove('open');
          triggerDownload(opt);
        });
        menuEl.appendChild(btn);
      });
    }

    const h2 = document.createElement('div');
    h2.className = 'idm-menu-header';
    h2.textContent = 'Tải theo chất lượng (Mọi nền tảng)';
    menuEl.appendChild(h2);

    presets.forEach((opt) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'idm-menu-item';
      btn.innerHTML = `
        <span class="idm-item-left"><span class="idm-item-label"></span></span>
        <span class="idm-item-tag"></span>
      `;
      btn.querySelector('.idm-item-label').textContent = opt.label;
      btn.querySelector('.idm-item-tag').textContent = opt.tag;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        isMenuOpen = false;
        menuEl.classList.remove('open');
        triggerDownload(opt);
      });
      menuEl.appendChild(btn);
    });
  }

  function updatePrimaryBadge() {
    const options = buildCandidateOptions(activeVideo);
    const best = options[0];
    if (best) {
      badgeEl.textContent = best.tag === 'BEST' ? 'HD+' : best.tag;
    } else {
      badgeEl.textContent = 'HD';
    }
  }

  function getPlayerTargetRect(video) {
    if (!(video instanceof HTMLVideoElement) || !video.isConnected) return null;
    const rect = video.getBoundingClientRect();
    const style = window.getComputedStyle(video);
    if (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      style.opacity !== '0' &&
      rect.width >= 160 &&
      rect.height >= 90
    ) {
      return rect;
    }

    const container = video.closest('.plyr, .video-js, .dplayer, .artplayer-app, .jwplayer, [class*="player"]');
    if (container && container instanceof HTMLElement) {
      const cStyle = window.getComputedStyle(container);
      const cRect = container.getBoundingClientRect();
      if (
        cStyle.display !== 'none' &&
        cStyle.visibility !== 'hidden' &&
        cStyle.opacity !== '0' &&
        cRect.width >= 160 &&
        cRect.height >= 90
      ) {
        return cRect;
      }
    }
    return null;
  }

  function isEligibleVideo(video) {
    if (!(video instanceof HTMLVideoElement) || !video.isConnected) return false;
    if (dismissedVideos.has(video)) return false;
    const rect = getPlayerTargetRect(video);
    if (!rect) return false;
    if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= window.innerHeight || rect.left >= window.innerWidth) {
      return false;
    }
    return true;
  }

  function clearHideTimers() {
    if (leaveHideTimer) {
      clearTimeout(leaveHideTimer);
      leaveHideTimer = null;
    }
    if (idleHideTimer) {
      clearTimeout(idleHideTimer);
      idleHideTimer = null;
    }
  }

  function findVideoAtPoint(x, y) {
    const videos = document.querySelectorAll('video');
    let bestVideo = null;
    let bestArea = 0;
    for (const v of videos) {
      if (dismissedVideos.has(v)) continue;
      const r = getPlayerTargetRect(v);
      if (!r || r.bottom <= 0 || r.right <= 0 || r.top >= window.innerHeight || r.left >= window.innerWidth) continue;
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        const area = r.width * r.height;
        if (area >= bestArea) {
          bestArea = area;
          bestVideo = v;
        }
      }
    }
    return bestVideo;
  }

  function isPointOverFloatingUI(x, y) {
    if (!wrapEl.classList.contains('visible')) return false;
    const pad = 14;
    const barRect = barEl.getBoundingClientRect();
    if (
      barRect.width > 0 &&
      x >= barRect.left - pad &&
      x <= barRect.right + pad &&
      y >= barRect.top - pad &&
      y <= barRect.bottom + pad
    ) {
      return true;
    }
    if (isMenuOpen) {
      const menuRect = menuEl.getBoundingClientRect();
      if (
        menuRect.width > 0 &&
        x >= menuRect.left - pad &&
        x <= menuRect.right + pad &&
        y >= menuRect.top - pad &&
        y <= menuRect.bottom + pad
      ) {
        return true;
      }
    }
    return false;
  }

  function hideFloatingBar() {
    if (isMenuOpen || isPointerInsideBar) return;
    clearHideTimers();
    wrapEl.classList.remove('visible');
    menuEl.classList.remove('open');
    activeVideo = null;
  }

  function scheduleLeaveHide(delay = 450) {
    if (leaveHideTimer) clearTimeout(leaveHideTimer);
    leaveHideTimer = setTimeout(() => {
      leaveHideTimer = null;
      if (!isPointerInsideBar && !isMenuOpen) {
        hideFloatingBar();
      }
    }, delay);
  }

  function resetIdleHide(delay = 3000) {
    if (idleHideTimer) clearTimeout(idleHideTimer);
    idleHideTimer = setTimeout(() => {
      idleHideTimer = null;
      if (!isPointerInsideBar && !isMenuOpen) {
        hideFloatingBar();
      }
    }, delay);
  }

  function positionWrapForVideo(video) {
    const rect = getPlayerTargetRect(video);
    if (!rect || dismissedVideos.has(video) || rect.bottom <= 0 || rect.right <= 0 || rect.top >= window.innerHeight || rect.left >= window.innerWidth) {
      activeVideo = null;
      isPointerInsideBar = false;
      isMenuOpen = false;
      clearHideTimers();
      wrapEl.classList.remove('visible');
      menuEl.classList.remove('open');
      return;
    }

    const barHeight = barEl.offsetHeight || 34;
    const gap = 6;
    let top;
    if (rect.top - barHeight - gap >= 6) {
      top = rect.top - barHeight - gap;
    } else if (rect.bottom + gap + barHeight <= window.innerHeight - 6) {
      top = rect.bottom + gap;
    } else {
      top = Math.max(8, rect.top + 8);
    }

    const right = Math.max(8, Math.min(window.innerWidth - 190, window.innerWidth - rect.right));
    wrapEl.style.flexDirection = (top + barHeight + 220 > window.innerHeight && top > 240) ? 'column-reverse' : 'column';
    wrapEl.style.top = `${Math.round(top)}px`;
    wrapEl.style.right = `${Math.round(right)}px`;
  }

  function showFloatingBar(video) {
    if (!isInstanceActive()) {
      disposeInstance();
      return;
    }
    if (!isEligibleVideo(video)) return;
    const isNewVideo = activeVideo !== video || !wrapEl.classList.contains('visible');
    activeVideo = video;
    ensureHostIntegrity();
    if (isDisposed) return;
    if (isNewVideo) {
      updatePrimaryBadge();
    }
    positionWrapForVideo(video);
    wrapEl.classList.add('visible');
    if (leaveHideTimer) {
      clearTimeout(leaveHideTimer);
      leaveHideTimer = null;
    }
    resetIdleHide(3000);
  }

  // Interactive button handlers inside Closed Shadow DOM
  barEl.addEventListener('mouseenter', () => {
    isPointerInsideBar = true;
    clearHideTimers();
  });
  barEl.addEventListener('mouseleave', () => {
    isPointerInsideBar = false;
    if (!isMenuOpen) {
      scheduleLeaveHide(350);
    }
  });
  menuEl.addEventListener('mouseenter', () => {
    isPointerInsideBar = true;
    clearHideTimers();
  });
  menuEl.addEventListener('mouseleave', () => {
    isPointerInsideBar = false;
    if (!isMenuOpen) {
      scheduleLeaveHide(350);
    }
  });

  mainBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const options = buildCandidateOptions(activeVideo);
    if (options.length > 0) {
      triggerDownload(options[0]);
    }
  });

  dropBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    isMenuOpen = !isMenuOpen;
    if (isMenuOpen) {
      clearHideTimers();
      renderDropdownMenu();
      menuEl.classList.add('open');
    } else {
      menuEl.classList.remove('open');
      if (!isPointerInsideBar) {
        resetIdleHide(3000);
      }
    }
  });

  closeBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (activeVideo) {
      dismissedVideos.add(activeVideo);
    }
    activeVideo = null;
    isMenuOpen = false;
    isPointerInsideBar = false;
    clearHideTimers();
    menuEl.classList.remove('open');
    wrapEl.classList.remove('visible');
  });

  document.addEventListener('click', (e) => {
    if (isMenuOpen && e.target !== host) {
      isMenuOpen = false;
      menuEl.classList.remove('open');
      if (!isPointerInsideBar) {
        scheduleLeaveHide(350);
      }
    }
  }, true);

  // Show only when hovering a video (Cốc Cốc style), hide cleanly when leaving or idle
  document.addEventListener(
    'mousemove',
    (e) => {
      if (!isInstanceActive()) {
        disposeInstance();
        return;
      }
      const now = Date.now();
      if (now - lastMouseMoveTime < 80) return;
      lastMouseMoveTime = now;

      if (e.target === host || isPointerInsideBar || isPointOverFloatingUI(e.clientX, e.clientY) || isMenuOpen) {
        clearHideTimers();
        return;
      }

      const hoveredVideo = findVideoAtPoint(e.clientX, e.clientY);
      if (hoveredVideo) {
        showFloatingBar(hoveredVideo);
      } else if (wrapEl.classList.contains('visible')) {
        scheduleLeaveHide(450);
      }
    },
    { capture: true, passive: true }
  );

  document.documentElement.addEventListener('mouseleave', () => {
    if (!isMenuOpen && !isPointerInsideBar && wrapEl.classList.contains('visible')) {
      scheduleLeaveHide(250);
    }
  });

  window.addEventListener('blur', () => {
    if (!isMenuOpen && wrapEl.classList.contains('visible')) {
      isPointerInsideBar = false;
      hideFloatingBar();
    }
  });

  window.addEventListener(
    'scroll',
    () => {
      if (wrapEl.classList.contains('visible') && activeVideo) {
        positionWrapForVideo(activeVideo);
      }
    },
    { passive: true }
  );
  window.addEventListener(
    'resize',
    () => {
      if (wrapEl.classList.contains('visible') && activeVideo) {
        positionWrapForVideo(activeVideo);
      }
    },
    { passive: true }
  );

  // 500ms watchdog: keep host intact against WebShield/adblockers and track visible bar position
  let watchdogTick = 0;
  watchdogInterval = setInterval(() => {
    if (!isInstanceActive()) {
      disposeInstance();
      return;
    }
    ensureHostIntegrity();
    if (isDisposed) return;
    watchdogTick++;
    if (watchdogTick % 3 === 0) {
      const prevCount = sniffedMedia.length;
      discoverLocalPageStreams();
      if (sniffedMedia.length !== prevCount && activeVideo && wrapEl.classList.contains('visible')) {
        updatePrimaryBadge();
        if (isMenuOpen) renderDropdownMenu();
      }
    }
    if (wrapEl.classList.contains('visible')) {
      if (activeVideo && isEligibleVideo(activeVideo)) {
        positionWrapForVideo(activeVideo);
      } else if (!isMenuOpen && !isPointerInsideBar) {
        hideFloatingBar();
      }
    }
  }, 500);

  // Background stream discovery without showing the floating bar until hover
  discoverLocalPageStreams();

  // Sync sniffed streams from background service worker
  if (isContextValid()) {
    try {
      chrome.runtime.sendMessage({ type: 'IDMLITE_GET_TAB_MEDIA' }, (res) => {
        try {
          if (chrome.runtime.lastError) return;
          if (res && Array.isArray(res.mediaList)) {
            sniffedMedia = res.mediaList;
            if (activeVideo && wrapEl.classList.contains('visible')) {
              updatePrimaryBadge();
            }
          }
        } catch {
          // Ignore extension context invalidation
        }
      });

      chrome.runtime.onMessage.addListener((msg) => {
        if (msg && msg.type === 'IDMLITE_MEDIA_UPDATED' && Array.isArray(msg.mediaList)) {
          sniffedMedia = msg.mediaList;
          if (activeVideo && wrapEl.classList.contains('visible')) {
            updatePrimaryBadge();
            if (isMenuOpen) renderDropdownMenu();
          }
        }
      });
    } catch {
      // Ignore extension context invalidation
    }
  }
})();
