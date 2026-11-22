/* global chrome */
const IDM_SERVER_URL = 'http://127.0.0.1:9091';
const MIN_DIRECT_VIDEO_BYTES = 150 * 1024; // 150 KB threshold to skip tiny ad/tracker clips
const MAX_MEDIA_PER_TAB = 25;

// In-memory store of detected media streams per tab: tabId -> MediaItem[]
const tabMedia = new Map();
// Track active main-frame URL per tab to clear stale streams on navigation
const tabMainUrls = new Map();
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

// Immediately register extension version with IDM Lite Desktop on worker load / install / tab switch
pingAppVersion(true);
chrome.runtime.onInstalled.addListener(() => {
  pingAppVersion(true);
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

function classifySniffedRequest(details) {
  const url = details.url;
  if (!url || !url.startsWith('http')) return null;
  if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) return null;

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

  // Exclude known media chunk / non-media URLs first
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

  // 1. HLS Playlist (.m3u8) - check BEFORE text/ exclusion since some servers serve m3u8 as text/plain
  const isHls =
    /\.m3u8(\?|$|#)/i.test(lowerUrl) ||
    pathname.endsWith('.m3u8') ||
    contentType.includes('mpegurl') ||
    contentType.includes('x-mpegurl');

  if (isHls) {
    return {
      url,
      type: 'hls',
      ext: 'mp4',
      size: 0,
      quality: inferQualityLabel(url, 'hls', 'mp4'),
      fileName: inferMediaTitleFromUrl(url, 'mp4').replace(/\.m3u8$/i, '.mp4'),
      priority: /(master|playlist|index)/i.test(lowerUrl) ? 100 : 85
    };
  }

  // 2. DASH Manifest (.mpd)
  const isDash =
    /\.mpd(\?|$|#)/i.test(lowerUrl) ||
    pathname.endsWith('.mpd') ||
    contentType.includes('dash+xml');

  if (isDash) {
    return {
      url,
      type: 'dash',
      ext: 'mp4',
      size: 0,
      quality: inferQualityLabel(url, 'dash', 'mp4'),
      fileName: inferMediaTitleFromUrl(url, 'mp4').replace(/\.mpd$/i, '.mp4'),
      priority: 80
    };
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
    let priority = isAudio ? 40 : 75;
    if (totalSize > 10 * 1024 * 1024) priority += 20;
    else if (totalSize > 1024 * 1024) priority += 10;
    if (/1080|2160|4k/i.test(quality)) priority += 15;
    else if (/720/i.test(quality)) priority += 8;

    return {
      url,
      type,
      ext,
      size: totalSize,
      quality,
      fileName: inferMediaTitleFromUrl(url, ext),
      priority
    };
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

function recordTabMedia(tabId, mediaItem, initiator) {
  if (tabId < 0) return;
  const existing = tabMedia.get(tabId) || [];
  const key = normalizeUrlKey(mediaItem.url);

  const idx = existing.findIndex((item) => normalizeUrlKey(item.url) === key);
  const entry = {
    ...mediaItem,
    initiator: initiator || '',
    detectedAt: Date.now()
  };

  if (idx !== -1) {
    // Keep higher known size/priority
    if ((existing[idx].size || 0) > (entry.size || 0)) {
      entry.size = existing[idx].size;
    }
    existing[idx] = entry;
  } else {
    existing.unshift(entry);
  }

  // Sort by priority desc, then size desc, then detectedAt desc
  existing.sort((a, b) => {
    if ((b.priority || 0) !== (a.priority || 0)) return (b.priority || 0) - (a.priority || 0);
    if ((b.size || 0) !== (a.size || 0)) return (b.size || 0) - (a.size || 0);
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

// Sniff cached/early HLS & DASH playlist requests before cache hits
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0 || !details.url || !details.url.startsWith('http')) return;
    if (details.url.startsWith('http://127.0.0.1') || details.url.startsWith('http://localhost')) return;
    const lowerUrl = details.url.toLowerCase();
    const isHls = /\.m3u8(\?|$|#)/i.test(lowerUrl);
    const isDash = /\.mpd(\?|$|#)/i.test(lowerUrl);
    if (!isHls && !isDash) return;

    const type = isHls ? 'hls' : 'dash';
    recordTabMedia(
      details.tabId,
      {
        url: details.url,
        type,
        ext: 'mp4',
        size: 0,
        quality: inferQualityLabel(details.url, type, 'mp4'),
        fileName: inferMediaTitleFromUrl(details.url, 'mp4').replace(/\.(m3u8|mpd)$/i, '.mp4'),
        priority: isHls ? (/(master|playlist|index)/i.test(lowerUrl) ? 100 : 85) : 80
      },
      details.initiator || details.documentUrl || ''
    );
  },
  { urls: ['<all_urls>'] }
);

// Sniff video/audio network responses across all tabs
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const item = classifySniffedRequest(details);
    if (item) {
      recordTabMedia(details.tabId, item, details.initiator || details.documentUrl || '');
    }
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

// Clear sniffed media when a tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  tabMedia.delete(tabId);
  tabMainUrls.delete(tabId);
});

// Clear sniffed media when main frame navigates to a different page
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  const newBase = normalizeUrlKey(changeInfo.url);
  const prevBase = tabMainUrls.get(tabId);
  if (prevBase && prevBase !== newBase) {
    tabMedia.delete(tabId);
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

    collectMergedCookies([targetUrl, pageUrl, referrer], (cookieStr, cookieList) => {
      const payload = {
        url: targetUrl,
        pageUrl,
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
