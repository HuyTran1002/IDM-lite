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

  function isNoiseMediaUrl(urlStr) {
    if (!urlStr || !urlStr.startsWith('http')) return true;
    const lower = urlStr.toLowerCase();
    return (
      lower.includes('googlevideo.com/videoplayback') ||
      lower.includes('bytestart=') ||
      /[?&]range=\d+-\d+/i.test(lower) ||
      /[?&]sq=\d+/i.test(lower) ||
      /\/(seg|segment|chunk|frag|fragment)[_-]?\d+/i.test(lower)
    );
  }

  function inferStreamEntry(rawUrl, priorityBoost = 0) {
    if (!rawUrl || isNoiseMediaUrl(rawUrl)) return null;
    const lower = rawUrl.toLowerCase();
    const isHls = /\.m3u8(\?|$|#)/i.test(lower);
    const isDash = /\.mpd(\?|$|#)/i.test(lower);
    const directMatch = lower.match(/\.(mp4|webm|mkv|mov|flv|m4v)(\?|$|#)/i);
    if (!isHls && !isDash && !directMatch) return null;

    const type = isHls ? 'hls' : (isDash ? 'dash' : 'direct');
    const ext = isHls || isDash ? 'mp4' : directMatch[1].toLowerCase();
    const quality = isHls
      ? (/(master|playlist|index)/i.test(lower) ? 'HLS Master' : 'HLS Stream')
      : (isDash ? 'DASH Stream' : ext.toUpperCase());

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

    return {
      url: rawUrl,
      type,
      ext,
      size: 0,
      quality,
      fileName,
      priority: (isHls ? 95 : (isDash ? 80 : 85)) + priorityBoost,
      detectedAt: Date.now()
    };
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
      }
    };

    // 1. Performance resource entries (catches JWPlayer/HLS.js/Video.js cached or early requests)
    try {
      const entries = performance.getEntriesByType('resource');
      for (let i = entries.length - 1; i >= 0; i--) {
        addCandidate(entries[i].name, 10);
      }
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

    if (found.length > 0) {
      let changed = false;
      for (const item of found) {
        if (!sniffedMedia.some((m) => m.url === item.url)) {
          sniffedMedia.unshift(item);
          changed = true;
        }
      }
      if (changed) {
        sniffedMedia.sort((a, b) => (b.priority || 0) - (a.priority || 0));
        try {
          chrome.runtime.sendMessage({ type: 'IDMLITE_REPORT_MEDIA', mediaList: found }, () => {
            if (chrome.runtime.lastError) {
              // Ignore
            }
          });
        } catch {
          // Ignore
        }
      }
    }

    return found;
  }

  // Create neutral custom-tag Shadow DOM host immune to adblock/WebShield overlay heuristics
  const host = document.createElement('idm-ext-ui');
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

  function ensureHostIntegrity() {
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
    const hostObserver = new MutationObserver(() => {
      ensureHostIntegrity();
    });
    hostObserver.observe(host, {
      attributes: true,
      attributeFilter: ['style', 'hidden', 'class']
    });

    const parentObserver = new MutationObserver(() => {
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
    discoverLocalPageStreams();
    const permalink = findClosestVideoPermalink(video);
    const title = extractVideoTitle(video);
    const directUrls = getDirectVideoUrls(video);
    const isPlatform = isMajorVideoPlatform(permalink);
    const options = [];

    if (!isPlatform) {
      directUrls.forEach((u, idx) => {
        const isHls = /\.m3u8(\?|$|#)/i.test(u);
        const ext = isHls ? 'mp4' : (u.match(/\.(mp4|webm|mkv|mov|flv)(\?|$)/i)?.[1]?.toLowerCase() || 'mp4');
        options.push({
          group: 'stream',
          label: idx === 0 ? `Video trực tiếp (${ext.toUpperCase()})` : `Nguồn video #${idx + 1} (${ext.toUpperCase()})`,
          tag: isHls ? 'HLS' : ext.toUpperCase(),
          url: u,
          pageUrl: permalink,
          videoType: isHls ? 'hls' : 'direct',
          quality: 'best',
          fileName: `${title}.${ext}`
        });
      });
    }

    const isYouTube = /(^|\.)youtube\.com$|(^|\.)youtu\.be$/i.test(window.location.hostname);
    if (!isYouTube) {
      for (const m of sniffedMedia) {
        if (options.some((o) => o.url === m.url)) continue;
        const sizeLabel = m.size ? ` (${formatBytes(m.size)})` : '';
        options.push({
          group: 'stream',
          label: `${m.fileName || 'Stream'}${sizeLabel}`,
          tag: m.quality || m.type.toUpperCase(),
          url: m.url,
          pageUrl: permalink,
          videoType: m.type,
          quality: 'best',
          fileName: `${title}.${m.ext || 'mp4'}`
        });
      }
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

  function triggerDownload(option) {
    showToast('⏳ Đang gửi tới IDM Lite...');
    chrome.runtime.sendMessage(
      {
        type: 'IDMLITE_DOWNLOAD_VIDEO',
        url: option.url,
        pageUrl: option.pageUrl,
        title: extractVideoTitle(activeVideo),
        fileName: option.fileName,
        videoType: option.videoType,
        quality: option.quality,
        referrer: window.location.href
      },
      (res) => {
        if (chrome.runtime.lastError) {
          showToast('⚠ Lỗi giao tiếp extension', true);
          return;
        }
        if (res && res.success) {
          showToast('✓ Đã mở hộp thoại tải IDM Lite!');
        } else {
          showToast(`⚠ ${res?.error || 'Hãy bật ứng dụng IDM Lite'}`, true);
        }
      }
    );
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

  function isEligibleVideo(video) {
    if (!(video instanceof HTMLVideoElement) || !video.isConnected) return false;
    if (dismissedVideos.has(video)) return false;
    const rect = video.getBoundingClientRect();
    if (rect.width < 160 || rect.height < 90) return false;
    if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= window.innerHeight || rect.left >= window.innerWidth) {
      return false;
    }
    const style = window.getComputedStyle(video);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
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
      if (!isEligibleVideo(v)) continue;
      const r = v.getBoundingClientRect();
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
    const pad = 8;
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

  function scheduleLeaveHide(delay = 350) {
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
    if (!isEligibleVideo(video)) {
      activeVideo = null;
      isPointerInsideBar = false;
      isMenuOpen = false;
      clearHideTimers();
      wrapEl.classList.remove('visible');
      menuEl.classList.remove('open');
      return;
    }

    const rect = video.getBoundingClientRect();
    const top = Math.max(8, Math.min(window.innerHeight - 44, rect.top + 10));
    const right = Math.max(8, Math.min(window.innerWidth - 190, window.innerWidth - rect.right + 10));
    wrapEl.style.top = `${Math.round(top)}px`;
    wrapEl.style.right = `${Math.round(right)}px`;
  }

  function showFloatingBar(video) {
    if (!isEligibleVideo(video)) return;
    const isNewVideo = activeVideo !== video || !wrapEl.classList.contains('visible');
    activeVideo = video;
    ensureHostIntegrity();
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
        scheduleLeaveHide(350);
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
  setInterval(() => {
    ensureHostIntegrity();
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
  try {
    chrome.runtime.sendMessage({ type: 'IDMLITE_GET_TAB_MEDIA' }, (res) => {
      if (chrome.runtime.lastError) return;
      if (res && Array.isArray(res.mediaList)) {
        sniffedMedia = res.mediaList;
        if (activeVideo && wrapEl.classList.contains('visible')) {
          updatePrimaryBadge();
        }
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
})();
