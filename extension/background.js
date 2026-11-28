/* global chrome */
const IDM_SERVER_URL = 'http://127.0.0.1:9091';
const MIN_DIRECT_VIDEO_BYTES = 150 * 1024; // 150 KB threshold to skip tiny ad/tracker clips
const MAX_MEDIA_PER_TAB = 25;

// In-memory store of detected media streams per tab: tabId -> MediaItem[]
const tabMedia = new Map();
// Track active main-frame URL per tab to clear stale streams on navigation
const tabMainUrls = new Map();
// Track captured custom request headers (e.g. x-cdn-auth, x-cdn-app) per tab
const tabCustomHeaders = new Map();
let lastAppPingTime = 0;

function pingAppVersion(force = false) {
  const now = Date.now();
  if (!force && now - lastAppPingTime < 15000) {
    return Promise.resolve(null);
  }
  lastAppPingTime = now;
  const extVersion = chrome.runtime.getManifest().version;
  return fetch(`${IDM_SERVER_URL}/get-extensions?extVersion=${extVersion}`)
    .then((res) => res.json())
    .catch(() => null);
}

function reinjectContentScriptsIntoOpenTabs() {
  if (!chrome.scripting || !chrome.tabs) return;
  try {
    chrome.tabs.query({}, (tabs) => {
      if (chrome.runtime.lastError || !Array.isArray(tabs)) return;
      for (const tab of tabs) {
        if (!tab || typeof tab.id !== 'number' || !tab.url) continue;
        if (!/^https?:\/\//i.test(tab.url)) continue;
        chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          files: ['page_hook.js'],
          world: 'MAIN'
        }).catch(() => { });
        chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          files: ['content.js']
        }).catch(() => { });
      }
    });
  } catch {
    // Ignore scripting reinjection errors
  }
}

// Immediately register extension version with IDM Lite Desktop on worker load / install / tab switch
pingAppVersion(true);
chrome.runtime.onInstalled.addListener(() => {
  pingAppVersion(true);
  reinjectContentScriptsIntoOpenTabs();
});
chrome.runtime.onStartup.addListener(() => {
  pingAppVersion(true);
});
chrome.tabs.onActivated.addListener(() => {
  pingAppVersion(false);
});

function normalizeUrlKey(rawUrl) {
  try {
    const u = new URL(rawUrl);
    u.hash = '';
    return u.href;
  } catch {
    return rawUrl;
  }
}

function getHeaderValue(headers, targetName) {
  if (!Array.isArray(headers)) return '';
  const lower = targetName.toLowerCase();
  for (const h of headers) {
    if (h.name && h.name.toLowerCase() === lower) {
      return h.value || '';
    }
  }
  return '';
}

function parseContentRangeTotal(contentRange) {
  if (!contentRange) return 0;
  const match = contentRange.match(/\/(\d+)$/);
  return match ? parseInt(match[1], 10) : 0;
}

function inferQualityLabel(url, type, ext) {
  const lower = url.toLowerCase();
  if (/(2160p|4k|uhd)/i.test(lower)) return '4K / 2160p';
  if (/(1440p|2k)/i.test(lower)) return '2K / 1440p';
  if (/(1080p|fhd|fullhd)/i.test(lower)) return '1080p';
  if (/(720p|\bhd\b|_hd\.|\/hd\/)/i.test(lower)) return '720p HD';
  if (/(480p|\bsd\b|_sd\.)/i.test(lower)) return '480p';
  if (/360p/i.test(lower)) return '360p';
  if (/240p/i.test(lower)) return '240p';

  if (type === 'hls') {
    if (/(master|playlist|index)/i.test(lower)) return 'HLS Master';
    return 'HLS Stream';
  }
  if (type === 'dash') return 'DASH Stream';
  if (type === 'audio') return ext ? ext.toUpperCase() : 'AUDIO';
  return ext ? ext.toUpperCase() : 'VIDEO';
}

function inferMediaTitleFromUrl(url, ext) {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter(Boolean);
    let last = parts[parts.length - 1] || 'video';
    last = decodeURIComponent(last).replace(/[<>:"/\\|?*]/g, '_');
    if (last.length > 64) last = last.slice(0, 64);
    if (!last.includes('.') && ext) {
      return `${last}.${ext}`;
    }
    return last;
  } catch {
    return `video_${Date.now()}.${ext || 'mp4'}`;
  }
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
    if (/(^|[/_.-])(ads?|adserver|advert|preroll|midroll|postroll|vast|vpaid|promo|banner|sponsor|commercial)([/_.-]|$)/i.test(pathAndQuery)) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
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

function parseHlsMetadata(text) {
  if (!text || typeof text !== 'string' || !text.includes('#EXTM3U')) return null;
  const lines = text.split(/\r?\n/);
  let totalDuration = 0;
  let segmentCount = 0;
  let bestBandwidth = 0;
  let bestResolution = '';
  let bestHeight = 0;
  let bestVariantUrl = '';
  const isMaster = text.includes('#EXT-X-STREAM-INF');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF:')) {
      const durMatch = line.match(/^#EXTINF:\s*([0-9]+(?:\.[0-9]+)?)/i);
      if (durMatch) {
        const sec = parseFloat(durMatch[1]);
        if (Number.isFinite(sec) && sec > 0) {
          totalDuration += sec;
          segmentCount++;
        }
      }
    } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const bwMatch = line.match(/BANDWIDTH=(\d+)/i);
      const resMatch = line.match(/RESOLUTION=(\d+x\d+)/i);
      const bw = bwMatch ? parseInt(bwMatch[1], 10) : 0;
      const resStr = resMatch ? resMatch[1] : '';
      const h = resStr ? parseInt(resStr.split('x')[1], 10) : 0;
      let nextIdx = i + 1;
      while (nextIdx < lines.length && (!lines[nextIdx].trim() || lines[nextIdx].trim().startsWith('#'))) {
        nextIdx++;
      }
      const vLine = nextIdx < lines.length ? lines[nextIdx].trim() : '';
      if (h > bestHeight || (h === bestHeight && bw > bestBandwidth)) {
        bestHeight = h;
        bestBandwidth = bw;
        bestResolution = resStr;
        bestVariantUrl = vLine;
      }
    }
  }

  const duration = Math.round(totalDuration);
  const effectiveBw = bestBandwidth > 0 ? bestBandwidth : (duration > 0 ? 1500000 : 0);
  const estimatedSize = duration > 0 && effectiveBw > 0 ? Math.round((effectiveBw / 8) * duration) : 0;

  return {
    isMaster,
    duration,
    segmentCount,
    bandwidth: bestBandwidth,
    resolution: bestResolution,
    height: bestHeight,
    bestVariantUrl,
    estimatedSize,
    isEstimatedSize: estimatedSize > 0
  };
}

function computeStreamPriority(item) {
  const url = item.url || '';
  const lower = url.toLowerCase();
  if (isPreviewClipUrl(url)) return 15;

  const duration = Number(item.duration) || 0;
  if (duration > 0 && duration <= 45) return 20;

  if (item.type === 'hls') {
    const isMaster = /(master|playlist|index)/i.test(lower);
    const qual = `${item.quality || ''} ${item.resolution || ''}`;
    const qBoost = /(1080|2160|4k)/i.test(qual) ? 10 : (/720/i.test(qual) ? 6 : 0);
    if (duration >= 300) {
      return 160 + (isMaster ? 15 : 0) + qBoost;
    }
    if (duration > 45) {
      return 125 + (isMaster ? 8 : 0) + qBoost;
    }
    return isMaster ? 115 : 105;
  }

  if (item.type === 'dash') {
    return duration >= 300 ? 155 : 100;
  }

  if (item.type === 'audio') return 40;

  const size = Number(item.size) || 0;
  let base = 55;
  if (size >= 100 * 1024 * 1024) base = 125;
  else if (size >= 25 * 1024 * 1024) base = 85;
  const qualBoost = /(1080|2160|4k)/i.test(item.quality || '') ? 8 : (/720/i.test(item.quality || '') ? 4 : 0);
  return base + qualBoost;
}

const probedHlsCache = new Map();
const probingHlsInFlight = new Set();

function extractParentDir(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const parts = u.pathname.split('/');
    parts.pop();
    return `${u.origin}${parts.join('/')}`;
  } catch {
    return '';
  }
}

function classifySniffedRequest(details) {
  const url = details.url;
  if (!url || !url.startsWith('http')) return null;
  if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) return null;
  if (isAdNetworkUrl(url)) return null;

  const statusCode = details.statusCode || 200;
  if (statusCode < 200 || statusCode >= 300) return null;

  const lowerUrl = url.toLowerCase();
  let pathname;
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    pathname = lowerUrl.split(/[?#]/)[0];
  }

  const contentType = getHeaderValue(details.responseHeaders, 'content-type').toLowerCase();
  const contentLengthHeader = getHeaderValue(details.responseHeaders, 'content-length');
  const contentRangeHeader = getHeaderValue(details.responseHeaders, 'content-range');

  const contentLength = contentLengthHeader ? parseInt(contentLengthHeader, 10) : 0;
  const totalSize = parseContentRangeTotal(contentRangeHeader) || contentLength;

  // 1. HLS Playlist (.m3u8) - check BEFORE asset/text exclusions so disguised or text/plain playlists work
  const isHls =
    /\.m3u8(\?|$|#)/i.test(lowerUrl) ||
    pathname.endsWith('.m3u8') ||
    contentType.includes('mpegurl') ||
    contentType.includes('x-mpegurl');

  if (isHls) {
    const item = {
      url,
      type: 'hls',
      ext: 'mp4',
      size: 0,
      duration: 0,
      quality: inferQualityLabel(url, 'hls', 'mp4'),
      fileName: inferMediaTitleFromUrl(url, 'mp4').replace(/\.m3u8$/i, '.mp4')
    };
    item.priority = computeStreamPriority(item);
    return item;
  }

  // 2. DASH Manifest (.mpd)
  const isDash =
    /\.mpd(\?|$|#)/i.test(lowerUrl) ||
    pathname.endsWith('.mpd') ||
    contentType.includes('dash+xml');

  if (isDash) {
    const item = {
      url,
      type: 'dash',
      ext: 'mp4',
      size: 0,
      duration: 0,
      quality: inferQualityLabel(url, 'dash', 'mp4'),
      fileName: inferMediaTitleFromUrl(url, 'mp4').replace(/\.mpd$/i, '.mp4')
    };
    item.priority = computeStreamPriority(item);
    return item;
  }

  // Exclude known media chunk / non-media URLs after HLS/DASH playlist checks
  if (
    lowerUrl.includes('googlevideo.com/videoplayback') ||
    lowerUrl.includes('bytestart=') ||
    /[?&]range=\d+-\d+/i.test(lowerUrl) ||
    /[?&]sq=\d+/i.test(lowerUrl) ||
    /\/(seg|segment|chunk|frag|fragment)[_-]?\d+/i.test(pathname) ||
    contentType.includes('video/mp2t') ||
    contentType.includes('application/javascript') ||
    contentType.includes('application/json') ||
    contentType.includes('image/') ||
    /\.(ts|m4s|m4f|vtt|srt|ass|key|png|jpe?g|webp|gif|svg|css|js|woff2?)(\?|$)/i.test(pathname)
  ) {
    return null;
  }

  // Exclude HTML/plain text pages after HLS/DASH playlist checks
  if (contentType.includes('text/')) {
    return null;
  }

  // 3. Direct Video or Audio stream
  const extMatch = pathname.match(/\.([a-z0-9]{2,5})$/i);
  const urlExt = extMatch ? extMatch[1].toLowerCase() : '';
  const directVideoExts = ['mp4', 'webm', 'mkv', 'mov', 'flv', 'm4v', '3gp', 'avi'];
  const directAudioExts = ['mp3', 'm4a', 'aac', 'ogg', 'wav', 'flac'];

  const isVideoMime = contentType.startsWith('video/');
  const isAudioMime = contentType.startsWith('audio/');
  const isVideoExt = directVideoExts.includes(urlExt);
  const isAudioExt = directAudioExts.includes(urlExt);

  if (isVideoMime || isAudioMime || isVideoExt || isAudioExt) {
    if (totalSize > 0 && totalSize < MIN_DIRECT_VIDEO_BYTES) {
      return null;
    }

    const isAudio = (isAudioMime || isAudioExt) && !isVideoMime && !isVideoExt;
    const ext = isAudio
      ? (isAudioExt ? urlExt : (contentType.includes('mpeg') ? 'mp3' : 'm4a'))
      : (isVideoExt ? urlExt : (contentType.includes('webm') ? 'webm' : 'mp4'));

    const type = isAudio ? 'audio' : 'direct';
    const quality = inferQualityLabel(url, type, ext);
    const item = {
      url,
      type,
      ext,
      size: totalSize,
      duration: 0,
      quality,
      fileName: inferMediaTitleFromUrl(url, ext)
    };
    item.priority = computeStreamPriority(item);
    return item;
  }

  return null;
}

function updateTabBadge(tabId, count) {
  if (tabId < 0) return;
  try {
    chrome.action.setBadgeText({ tabId, text: count > 0 ? String(count) : '' }, () => {
      if (chrome.runtime.lastError) {
        // Ignore closed tabs
      }
    });
    if (count > 0) {
      chrome.action.setBadgeBackgroundColor({ tabId, color: '#00e676' }, () => {
        if (chrome.runtime.lastError) {
          // Ignore
        }
      });
      if (chrome.action.setBadgeTextColor) {
        chrome.action.setBadgeTextColor({ tabId, color: '#000000' }, () => {
          if (chrome.runtime.lastError) {
            // Ignore
          }
        });
      }
    }
  } catch {
    // Ignore badge errors
  }
}

async function fetchTextWithTimeout(targetUrl, customHeaders = {}, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(targetUrl, {
      method: 'GET',
      headers: customHeaders,
      signal: controller.signal
    });
    if (!res.ok) return '';
    return await res.text();
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

function setProbedHlsCache(key, value) {
  if (probedHlsCache.size >= 100 && !probedHlsCache.has(key)) {
    const oldestKey = probedHlsCache.keys().next().value;
    if (oldestKey) probedHlsCache.delete(oldestKey);
  }
  probedHlsCache.set(key, value);
}

async function probeHlsMetadata(tabId, mediaItem) {
  if (tabId < 0 || !mediaItem || mediaItem.type !== 'hls' || !mediaItem.url) return;
  const key = normalizeUrlKey(mediaItem.url);
  const cached = probedHlsCache.get(key);
  if (cached) {
    if (
      !cached.failed &&
      ((cached.duration || 0) > (mediaItem.duration || 0) ||
        (cached.estimatedSize || 0) > (mediaItem.size || 0))
    ) {
      recordTabMedia(tabId, {
        ...mediaItem,
        duration: cached.duration || mediaItem.duration || 0,
        bandwidth: cached.bandwidth || mediaItem.bandwidth || 0,
        resolution: cached.resolution || mediaItem.resolution || '',
        quality: cached.quality || mediaItem.quality,
        size: cached.estimatedSize || mediaItem.size || 0,
        isEstimatedSize: Boolean(cached.estimatedSize || mediaItem.isEstimatedSize)
      }, mediaItem.initiator || '');
    }
    return;
  }

  if (probingHlsInFlight.has(key)) return;
  probingHlsInFlight.add(key);

  try {
    const headers = getTabCustomHeaders(tabId, mediaItem.url);
    const playlistText = await fetchTextWithTimeout(mediaItem.url, headers, 6000);
    const parsed = parseHlsMetadata(playlistText);
    if (!parsed) {
      setProbedHlsCache(key, { failed: true, duration: 0, bandwidth: 0, resolution: '', quality: '', estimatedSize: 0 });
      return;
    }

    const bw = parsed.bandwidth || 0;
    const resLabel = parsed.height ? `${parsed.height}p` : '';
    const resolution = parsed.resolution || '';
    let duration = parsed.duration || 0;

    if (parsed.isMaster && parsed.bestVariantUrl && duration === 0) {
      try {
        const variantUrl = new URL(parsed.bestVariantUrl, mediaItem.url).href;
        const variantText = await fetchTextWithTimeout(variantUrl, getTabCustomHeaders(tabId, variantUrl), 6000);
        const variantParsed = parseHlsMetadata(variantText);
        if (variantParsed && variantParsed.duration > 0) {
          duration = variantParsed.duration;
        }
      } catch {
        // Ignore variant probe failure
      }
    }

    const effectiveBw = bw > 0 ? bw : (duration > 0 ? 1500000 : 0);
    const estimatedSize = duration > 0 && effectiveBw > 0 ? Math.round((effectiveBw / 8) * duration) : 0;
    const result = {
      failed: false,
      duration,
      bandwidth: bw,
      resolution,
      quality: resLabel || mediaItem.quality,
      estimatedSize
    };

    setProbedHlsCache(key, result);

    if (duration > 0 || estimatedSize > 0 || resLabel) {
      recordTabMedia(tabId, {
        ...mediaItem,
        duration,
        bandwidth: bw,
        resolution,
        quality: resLabel || mediaItem.quality,
        size: estimatedSize || mediaItem.size || 0,
        isEstimatedSize: estimatedSize > 0 ? true : Boolean(mediaItem.isEstimatedSize)
      }, mediaItem.initiator || '');
    }
  } catch {
    setProbedHlsCache(key, { failed: true, duration: 0, bandwidth: 0, resolution: '', quality: '', estimatedSize: 0 });
  } finally {
    probingHlsInFlight.delete(key);
  }
}

function recordTabMedia(tabId, mediaItem, initiator) {
  if (tabId < 0 || !mediaItem || !mediaItem.url) return;
  if (isAdNetworkUrl(mediaItem.url)) return;

  const existing = tabMedia.get(tabId) || [];
  const key = normalizeUrlKey(mediaItem.url);

  const idx = existing.findIndex((item) => normalizeUrlKey(item.url) === key);
  const entry = {
    ...mediaItem,
    initiator: initiator || '',
    detectedAt: Date.now()
  };

  let changed = false;

  if (idx !== -1) {
    const prev = existing[idx];
    const next = { ...prev };
    if ((entry.size || 0) > (prev.size || 0)) {
      next.size = entry.size;
      next.isEstimatedSize = Boolean(entry.isEstimatedSize);
      changed = true;
    }
    if ((entry.duration || 0) > (prev.duration || 0)) {
      next.duration = entry.duration;
      changed = true;
    }
    if ((entry.bandwidth || 0) > (prev.bandwidth || 0)) {
      next.bandwidth = entry.bandwidth;
      changed = true;
    }
    if (entry.resolution && !prev.resolution) {
      next.resolution = entry.resolution;
      changed = true;
    }
    if (entry.quality && (!prev.quality || /^HLS (Master|Stream)$/i.test(prev.quality)) && !/^HLS (Master|Stream)$/i.test(entry.quality)) {
      next.quality = entry.quality;
      changed = true;
    }
    const recomputed = computeStreamPriority(next);
    if (recomputed !== (prev.priority || 0)) {
      next.priority = recomputed;
      changed = true;
    }
    existing[idx] = next;
  } else {
    entry.priority = computeStreamPriority(entry);
    existing.unshift(entry);
    changed = true;
  }

  // Propagate duration / estimated size from a variant .m3u8 to a sibling master .m3u8 on the same host + parent path
  const activeItem = idx !== -1 ? existing[idx] : entry;
  if (activeItem.type === 'hls' && activeItem.duration > 0) {
    const parentDir = extractParentDir(activeItem.url);
    for (let i = 0; i < existing.length; i++) {
      const sibling = existing[i];
      if (!sibling || sibling === activeItem || sibling.type !== 'hls') continue;
      if ((sibling.duration || 0) === 0 && extractParentDir(sibling.url) === parentDir && /(master|playlist|index)/i.test(sibling.url)) {
        sibling.duration = activeItem.duration;
        if (!sibling.size && activeItem.size) {
          sibling.size = activeItem.size;
          sibling.isEstimatedSize = true;
        }
        const siblingRecomputed = computeStreamPriority(sibling);
        if (siblingRecomputed !== (sibling.priority || 0)) {
          sibling.priority = siblingRecomputed;
        }
        changed = true;
      }
    }
  }

  if (activeItem.type === 'hls' && !(activeItem.duration > 0) && !probedHlsCache.has(key)) {
    probeHlsMetadata(tabId, activeItem);
  }

  if (!changed) return;

  // Sort by priority desc, then size desc, then duration desc, then detectedAt desc
  existing.sort((a, b) => {
    if ((b.priority || 0) !== (a.priority || 0)) return (b.priority || 0) - (a.priority || 0);
    if ((b.size || 0) !== (a.size || 0)) return (b.size || 0) - (a.size || 0);
    if ((b.duration || 0) !== (a.duration || 0)) return (b.duration || 0) - (a.duration || 0);
    return (b.detectedAt || 0) - (a.detectedAt || 0);
  });

  const trimmed = existing.slice(0, MAX_MEDIA_PER_TAB);
  tabMedia.set(tabId, trimmed);
  updateTabBadge(tabId, trimmed.length);

  // Notify content scripts in this tab
  try {
    chrome.tabs.sendMessage(tabId, {
      type: 'IDMLITE_MEDIA_UPDATED',
      mediaList: trimmed
    }, () => {
      if (chrome.runtime.lastError) {
        // Ignore if content script not ready or frame closed
      }
    });
  } catch {
    // Ignore
  }
}

function removeTabMediaUrl(tabId, targetUrl) {
  if (tabId < 0 || !targetUrl) return;
  const existing = tabMedia.get(tabId);
  if (!existing || existing.length === 0) return;
  const key = normalizeUrlKey(targetUrl);
  const next = existing.filter((item) => normalizeUrlKey(item.url) !== key);
  if (next.length !== existing.length) {
    tabMedia.set(tabId, next);
    updateTabBadge(tabId, next.length);
    try {
      chrome.tabs.sendMessage(tabId, {
        type: 'IDMLITE_MEDIA_UPDATED',
        mediaList: next
      }, () => {
        if (chrome.runtime.lastError) {
          // Ignore
        }
      });
    } catch {
      // Ignore
    }
  }
}

function isExtensionOwnRequest(details) {
  const init = typeof details?.initiator === 'string' ? details.initiator : '';
  const doc = typeof details?.documentUrl === 'string' ? details.documentUrl : '';
  return init.startsWith('chrome-extension://') || doc.startsWith('chrome-extension://');
}

function resolveTabIdForRequest(details) {
  if (isExtensionOwnRequest(details)) {
    return Promise.resolve(-1);
  }
  if (typeof details.tabId === 'number' && details.tabId >= 0) {
    return Promise.resolve(details.tabId);
  }

  const initiatorUrl = details.initiator || details.documentUrl || '';
  if (!/^https?:\/\//i.test(initiatorUrl)) {
    return Promise.resolve(-1);
  }

  try {
    const reqOrigin = new URL(initiatorUrl).origin;
    for (const [tabId, mainUrl] of tabMainUrls.entries()) {
      try {
        if (new URL(mainUrl).origin === reqOrigin) {
          return Promise.resolve(tabId);
        }
      } catch {
        // Ignore invalid tab URL
      }
    }
  } catch {
    // Ignore invalid initiator URL
  }

  return new Promise((resolve) => {
    try {
      chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
        if (chrome.runtime.lastError || !Array.isArray(tabs) || tabs.length === 0) {
          resolve(-1);
          return;
        }
        resolve(typeof tabs[0].id === 'number' ? tabs[0].id : -1);
      });
    } catch {
      resolve(-1);
    }
  });
}

// Sniff verified 2xx HLS & DASH playlist responses (including cached 200 and Web Worker requests)
chrome.webRequest.onResponseStarted.addListener(
  (details) => {
    if (isExtensionOwnRequest(details)) return;
    if (!details.url || !details.url.startsWith('http')) return;
    if (details.url.startsWith('http://127.0.0.1') || details.url.startsWith('http://localhost')) return;
    if (isAdNetworkUrl(details.url)) return;
    if (details.statusCode < 200 || details.statusCode >= 300) return;

    const lowerUrl = details.url.toLowerCase();
    const isHls = /\.m3u8(\?|$|#)/i.test(lowerUrl);
    const isDash = /\.mpd(\?|$|#)/i.test(lowerUrl);
    if (!isHls && !isDash) return;

    const type = isHls ? 'hls' : 'dash';
    const mediaItem = {
      url: details.url,
      type,
      ext: 'mp4',
      size: 0,
      duration: 0,
      quality: inferQualityLabel(details.url, type, 'mp4'),
      fileName: inferMediaTitleFromUrl(details.url, 'mp4').replace(/\.(m3u8|mpd)$/i, '.mp4'),
      verified: true
    };
    mediaItem.priority = computeStreamPriority(mediaItem);
    const initiator = details.initiator || details.documentUrl || '';

    if (typeof details.tabId === 'number' && details.tabId >= 0) {
      recordTabMedia(details.tabId, mediaItem, initiator);
      return;
    }

    resolveTabIdForRequest(details).then((resolvedTabId) => {
      if (resolvedTabId >= 0) {
        recordTabMedia(resolvedTabId, mediaItem, initiator);
      }
    });
  },
  { urls: ['<all_urls>'] }
);

const IGNORED_CUSTOM_HEADERS = new Set([
  'x-client-data',
  'x-chrome-connected',
  'x-chrome-uma-enabled',
  'x-chrome-id-consistency-request',
  'x-requested-with',
  'x-csrf-token',
  'x-xsrf-token',
  'x-livewire',
  'x-inertia',
  'x-pjax'
]);

function recordTabCustomHeaders(tabId, requestUrl, requestHeaders) {
  if (typeof tabId !== 'number' || tabId < 0 || !Array.isArray(requestHeaders)) return;
  const captured = {};
  for (const h of requestHeaders) {
    if (!h || !h.name || typeof h.value !== 'string' || !h.value) continue;
    const lower = h.name.toLowerCase();
    if (IGNORED_CUSTOM_HEADERS.has(lower) || lower.startsWith('x-chrome-')) continue;
    if (lower.startsWith('x-') || lower === 'authorization') {
      captured[lower] = h.value;
    }
  }
  if (Object.keys(captured).length === 0) return;

  let originKey = '__global__';
  try {
    originKey = new URL(requestUrl).origin;
  } catch {
    // Keep __global__
  }

  let entry = tabCustomHeaders.get(tabId);
  if (!entry) {
    entry = { byOrigin: new Map(), latest: {} };
    tabCustomHeaders.set(tabId, entry);
  }
  const prevOriginHeaders = entry.byOrigin.get(originKey) || {};
  entry.byOrigin.set(originKey, { ...prevOriginHeaders, ...captured });
  entry.latest = { ...entry.latest, ...captured };
}

function getTabCustomHeaders(tabId, targetUrl) {
  if (typeof tabId !== 'number' || tabId < 0) return {};
  const entry = tabCustomHeaders.get(tabId);
  if (!entry) return {};
  let originHeaders = {};
  try {
    const origin = new URL(targetUrl).origin;
    originHeaders = entry.byOrigin.get(origin) || {};
  } catch {
    // Ignore invalid URL
  }
  const cdnShared = {};
  for (const [k, v] of Object.entries(entry.latest || {})) {
    if (k.toLowerCase().startsWith('x-cdn-')) {
      cdnShared[k] = v;
    }
  }
  return { ...cdnShared, ...originHeaders };
}

// Capture custom CDN auth headers (e.g. x-cdn-auth, x-cdn-app) sent by page players
try {
  chrome.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
      if (isExtensionOwnRequest(details) || details.tabId < 0 || !details.url) return;
      recordTabCustomHeaders(details.tabId, details.url, details.requestHeaders);
    },
    { urls: ['<all_urls>'] },
    ['requestHeaders', 'extraHeaders']
  );
} catch {
  chrome.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
      if (isExtensionOwnRequest(details) || details.tabId < 0 || !details.url) return;
      recordTabCustomHeaders(details.tabId, details.url, details.requestHeaders);
    },
    { urls: ['<all_urls>'] },
    ['requestHeaders']
  );
}

// Remove failed/timed-out CDN probes from detected media list (never remove on hls.js aborts)
const FATAL_MEDIA_NETWORK_ERRORS = new Set([
  'net::ERR_CONNECTION_TIMED_OUT',
  'net::ERR_TIMED_OUT',
  'net::ERR_CONNECTION_REFUSED',
  'net::ERR_NAME_NOT_RESOLVED',
  'net::ERR_ADDRESS_UNREACHABLE',
  'net::ERR_CONNECTION_RESET'
]);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    if (isExtensionOwnRequest(details) || details.tabId < 0 || !details.url) return;
    const errStr = typeof details.error === 'string' ? details.error : '';
    if (!FATAL_MEDIA_NETWORK_ERRORS.has(errStr)) return;
    removeTabMediaUrl(details.tabId, details.url);
  },
  { urls: ['<all_urls>'] }
);

// Sniff video/audio network responses across all tabs (including Web Worker requests)
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (isExtensionOwnRequest(details)) return;
    const item = classifySniffedRequest(details);
    if (!item) return;
    const initiator = details.initiator || details.documentUrl || '';
    if (typeof details.tabId === 'number' && details.tabId >= 0) {
      recordTabMedia(details.tabId, item, initiator);
      return;
    }
    resolveTabIdForRequest(details).then((resolvedTabId) => {
      if (resolvedTabId >= 0) {
        recordTabMedia(resolvedTabId, item, initiator);
      }
    });
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

// Clear sniffed media when a tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  tabMedia.delete(tabId);
  tabMainUrls.delete(tabId);
  tabCustomHeaders.delete(tabId);
});

// Clear sniffed media when main frame navigates to a different page
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  const newBase = normalizeUrlKey(changeInfo.url);
  const prevBase = tabMainUrls.get(tabId);
  if (prevBase && prevBase !== newBase) {
    tabMedia.delete(tabId);
    tabCustomHeaders.delete(tabId);
    updateTabBadge(tabId, 0);
  }
  tabMainUrls.set(tabId, newBase);
});

function collectMergedCookies(urls, callback) {
  const validUrls = [...new Set(urls.filter((u) => typeof u === 'string' && u.startsWith('http')))];
  if (validUrls.length === 0) {
    callback('', []);
    return;
  }

  let pending = validUrls.length;
  const cookieMap = new Map();

  const finalize = () => {
    const cookieList = Array.from(cookieMap.values()).map((c) => ({
      domain: c.domain || '',
      hostOnly: Boolean(c.hostOnly),
      path: c.path || '/',
      secure: Boolean(c.secure),
      expirationDate: c.expirationDate || 0,
      name: c.name || '',
      value: c.value || ''
    }));
    const nameMap = new Map();
    for (const c of cookieList) {
      if (c.name) nameMap.set(c.name, c.value);
    }
    const cookieStr = Array.from(nameMap.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
    callback(cookieStr, cookieList);
  };

  validUrls.forEach((u) => {
    try {
      chrome.cookies.getAll({ url: u }, (cookies) => {
        if (chrome.runtime.lastError) {
          // Ignore error and continue
        } else if (Array.isArray(cookies)) {
          for (const c of cookies) {
            const k = `${c.name}|${c.domain}|${c.path}`;
            cookieMap.set(k, c);
          }
        }
        pending--;
        if (pending === 0) finalize();
      });
    } catch {
      pending--;
      if (pending === 0) finalize();
    }
  });
}

// Message broker for content.js and popup.js
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  if (msg.type === 'IDMLITE_REPORT_MEDIA') {
    const tabId = sender.tab?.id;
    if (typeof tabId === 'number' && tabId >= 0 && Array.isArray(msg.mediaList)) {
      for (const item of msg.mediaList) {
        if (item && typeof item.url === 'string' && item.url.startsWith('http')) {
          recordTabMedia(tabId, item, sender.tab?.url || '');
        }
      }
    }
    sendResponse({ success: true });
    return false;
  }

  if (msg.type === 'IDMLITE_GET_TAB_MEDIA') {
    const tabId = typeof msg.tabId === 'number' ? msg.tabId : sender.tab?.id;
    const mediaList = typeof tabId === 'number' ? (tabMedia.get(tabId) || []) : [];
    pingAppVersion(false);
    sendResponse({ success: true, tabId, mediaList });
    return false;
  }

  if (msg.type === 'IDMLITE_PING_APP') {
    pingAppVersion(true).then((config) => {
      if (config && config.success) {
        sendResponse({ connected: true, config });
      } else {
        sendResponse({ connected: false });
      }
    });
    return true;
  }

  if (msg.type === 'IDMLITE_DOWNLOAD_VIDEO') {
    const pageUrl = msg.pageUrl || sender.tab?.url || '';
    const targetUrl = msg.url || pageUrl;
    const referrer = msg.referrer || pageUrl || '';
    const tabId = typeof msg.tabId === 'number' ? msg.tabId : sender.tab?.id;
    const tabList = typeof tabId === 'number' ? (tabMedia.get(tabId) || []) : [];
    const targetKey = normalizeUrlKey(targetUrl);
    const isRequestedHls = msg.videoType === 'hls' || /\.m3u8(\?|$|#)/i.test(targetUrl);
    const backupUrls = tabList
      .filter((item) => {
        if (!item || !item.url || normalizeUrlKey(item.url) === targetKey) return false;
        if (isAdNetworkUrl(item.url) || isPreviewClipUrl(item.url)) return false;
        if (item.duration > 0 && item.duration <= 60) return false;
        if ((item.priority || 0) < 80) return false;
        if (isRequestedHls && item.type !== 'hls') return false;
        return true;
      })
      .slice(0, 4)
      .map((item) => ({ url: item.url, videoType: item.type || 'auto' }));
    const capturedHeaders = getTabCustomHeaders(tabId, targetUrl);
    const customHeaders = {
      ...capturedHeaders,
      ...(msg.customHeaders && typeof msg.customHeaders === 'object' ? msg.customHeaders : {})
    };

    collectMergedCookies([targetUrl, pageUrl, referrer], (cookieStr, cookieList) => {
      const payload = {
        url: targetUrl,
        pageUrl,
        backupUrls,
        customHeaders,
        fileName: msg.fileName || '',
        title: msg.title || '',
        cookies: cookieStr,
        cookieList,
        referrer,
        userAgent: navigator.userAgent || '',
        isVideo: true,
        videoType: msg.videoType || 'auto',
        quality: msg.quality || 'best'
      };

      fetch(`${IDM_SERVER_URL}/add-download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
        .then(async (res) => {
          const data = await res.json().catch(() => ({}));
          if (res.ok && data.success) {
            sendResponse({ success: true, data });
          } else {
            sendResponse({ success: false, error: data.error || data.message || 'IDM Lite rejected request' });
          }
        })
        .catch(() => {
          sendResponse({ success: false, error: 'Không kết nối được với IDM Lite (Hãy mở ứng dụng IDM Lite).' });
        });
    });

    return true;
  }

  return false;
});

// Standard file download interceptor
chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
  const ignoreDomains = [
    'g-portal.com',
    'g-portal.services',
    'gportal.com'
  ];

  try {
    const parsedUrl = new URL(downloadItem.url);
    const hostname = parsedUrl.hostname;
    const shouldIgnore = ignoreDomains.some((domain) => hostname.endsWith(domain));
    if (shouldIgnore) {
      console.log('Ignore download interception for security-protected domain:', hostname);
      suggest();
      return;
    }
  } catch {
    // Bỏ qua
  }

  // Bỏ qua nếu là liên kết nội bộ loopback hoặc URL blob:, data: tạo cục bộ trong trình duyệt
  if (
    downloadItem.url.startsWith('http://127.0.0.1') ||
    downloadItem.url.startsWith('http://localhost') ||
    downloadItem.url.startsWith('blob:') ||
    downloadItem.url.startsWith('data:')
  ) {
    suggest();
    return;
  }

  // 1. Chỉ xử lý nếu download đang ở trạng thái in_progress (đang tải)
  if (downloadItem.state && downloadItem.state !== 'in_progress') {
    suggest();
    return;
  }

  // 2. Tránh hiện tượng bắt link hàng loạt khi mở Chrome (Chrome restore/load lại lịch sử tải cũ)
  const startTime = new Date(downloadItem.startTime);
  const now = new Date();
  const timeDiff = now.getTime() - startTime.getTime();
  if (timeDiff > 5000) {
    console.log('Ignore restored/old download from previous session:', downloadItem.url, 'Time difference:', timeDiff, 'ms');
    suggest();
    return;
  }

  const extVersion = chrome.runtime.getManifest().version;
  // Gửi yêu cầu nhanh tới server để xem IDM Lite có đang chạy và cấu hình thế nào
  fetch(`${IDM_SERVER_URL}/get-extensions?extVersion=${extVersion}`)
    .then((res) => res.json())
    .then((config) => {
      if (!config.success || !config.isInterceptionEnabled) {
        suggest();
        return; // Không can thiệp nếu tắt tính năng bắt link hoặc server báo false
      }

      // Ưu tiên finalUrl (URL trực tiếp sau redirect) nếu có, fallback về url gốc
      const url = (downloadItem.finalUrl && downloadItem.finalUrl.startsWith('http'))
        ? downloadItem.finalUrl
        : downloadItem.url;
      const filename = downloadItem.filename || '';

      // Lấy đuôi file
      let ext = '';
      if (filename.includes('.')) {
        ext = filename.split('.').pop().toLowerCase();
      } else {
        try {
          const parsed = new URL(url);
          const pathname = parsed.pathname;
          ext = pathname.split('.').pop().split(/[?#]/)[0].toLowerCase();
        } catch {
          // Bỏ qua
        }
      }

      // 1. Tệp tin có phần mở rộng nằm trong danh sách cấu hình của ứng dụng
      const matchesExtension = config.extensions.includes(ext);

      // 2. Các liên kết dịch vụ đám mây đặc biệt (Drive, Mediafire, Mega...) hoặc có dấu hiệu tải file
      const isCloudOrDownloadPattern =
        url.includes('drive.usercontent.google.com') ||
        url.includes('drive.google.com/uc') ||
        url.includes('mediafire.com/file') ||
        url.includes('/download') ||
        url.includes('attachment') ||
        url.includes('gmail') ||
        url.includes('gportal');

      if (matchesExtension || isCloudOrDownloadPattern) {
        console.log('IDM Lite dynamic capture triggered:', url, 'Filename:', filename);

        // Giải phóng Chrome trước để chuyển trạng thái download sang in_progress
        suggest();
        // Thực hiện hủy và xóa lịch sử
        try {
          chrome.downloads.cancel(downloadItem.id, () => {
            if (chrome.runtime.lastError) {
              // Đọc để xóa lỗi
            }
            try {
              chrome.downloads.erase({ id: downloadItem.id }, () => {
                if (chrome.runtime.lastError) {
                  // Đọc để xóa lỗi
                }
              });
            } catch {
              // Bỏ qua
            }
          });
        } catch {
          // Bỏ qua
        }

        const referrerUrl = downloadItem.referrer || '';

        collectMergedCookies([url, referrerUrl], (cookieStr, cookieList) => {
          fetch(`${IDM_SERVER_URL}/add-download`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              url: url,
              fileName: filename,
              cookies: cookieStr,
              cookieList: cookieList,
              referrer: referrerUrl,
              userAgent: navigator.userAgent || ''
            })
          }).catch((e) => console.error('Error posting download to IDM Lite:', e));
        });
      } else {
        suggest();
      }
    })
    .catch(() => {
      // IDM Lite đang đóng, để trình duyệt tải tự nhiên
      console.log('IDM Lite loopback is not active. Standard native download proceed.');
      suggest();
    });

  return true;
});
