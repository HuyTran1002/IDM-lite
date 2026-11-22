/* global chrome */
document.addEventListener('DOMContentLoaded', () => {
  const statusEl = document.getElementById('app-status');
  const pageTitleEl = document.getElementById('page-title');
  const qualitySelect = document.getElementById('quality-select');
  const downloadPageBtn = document.getElementById('download-page-btn');
  const streamListEl = document.getElementById('stream-list');
  const streamCountEl = document.getElementById('stream-count');
  const feedbackEl = document.getElementById('feedback-box');

  let activeTab = null;
  let detectedStreams = [];

  function showFeedback(message, isError = false) {
    feedbackEl.textContent = message;
    feedbackEl.className = `feedback ${isError ? 'err' : 'ok'}`;
  }

  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return 'Stream';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let val = bytes;
    while (val >= 1024 && i < units.length - 1) {
      val /= 1024;
      i++;
    }
    return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }

  const PLATFORM_HOSTS = [
    'youtube.com', 'youtu.be', 'tiktok.com', 'facebook.com', 'fb.watch',
    'instagram.com', 'twitter.com', 'x.com', 'vimeo.com', 'bilibili.com',
    'dailymotion.com', 'twitch.tv', 'reddit.com', 'soundcloud.com', 'threads.net', 'douyin.com'
  ];

  function isMajorVideoPlatform(urlStr) {
    try {
      const host = new URL(urlStr).hostname.toLowerCase();
      return PLATFORM_HOSTS.some((d) => host === d || host.endsWith('.' + d));
    } catch {
      return false;
    }
  }

  function sanitizeTitle(raw) {
    return (raw || `video_${Date.now()}`)
      .replace(/\s*[-|•·]\s*(YouTube|TikTok|Facebook|Instagram|X|Twitter|Vimeo|Bilibili|Twitch|Dailymotion).*$/i, '')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || `video_${Date.now()}`;
  }

  function sendDownloadRequest(payload) {
    chrome.runtime.sendMessage({ type: 'IDMLITE_DOWNLOAD_VIDEO', ...payload }, (res) => {
      if (chrome.runtime.lastError) {
        showFeedback('Lỗi giao tiếp extension.', true);
        return;
      }
      if (res && res.success) {
        showFeedback('✓ Đã gửi liên kết tới IDM Lite!');
      } else {
        showFeedback(res?.error || 'Không thể kết nối tới IDM Lite. Hãy mở app trước.', true);
      }
    });
  }

  function renderStreams(mediaList) {
    detectedStreams = Array.isArray(mediaList) ? mediaList : [];
    streamListEl.innerHTML = '';
    streamCountEl.textContent = String(detectedStreams.length);

    if (detectedStreams.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'Chưa bắt được luồng media riêng. Hãy bấm phát video trên trang hoặc dùng nút "Tải ngay" ở trên (hỗ trợ YouTube, TikTok, Facebook, Instagram...).';
      streamListEl.appendChild(empty);
      return;
    }

    const baseTitle = sanitizeTitle(activeTab?.title);

    detectedStreams.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'stream-item';

      const info = document.createElement('div');
      info.className = 'stream-info';

      const name = document.createElement('div');
      name.className = 'stream-name';
      name.textContent = item.fileName || `${baseTitle}.${item.ext || 'mp4'}`;
      name.title = item.url;

      const meta = document.createElement('div');
      meta.className = 'stream-meta';

      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = item.quality || item.type.toUpperCase();

      const sizeSpan = document.createElement('span');
      sizeSpan.textContent = `${item.type.toUpperCase()} • ${formatBytes(item.size)}`;

      meta.appendChild(tag);
      meta.appendChild(sizeSpan);
      info.appendChild(name);
      info.appendChild(meta);

      const btn = document.createElement('button');
      btn.className = 'btn-dl';
      btn.textContent = '↓ Tải';
      btn.addEventListener('click', () => {
        const ext = item.ext || 'mp4';
        sendDownloadRequest({
          url: item.url,
          pageUrl: activeTab?.url || '',
          title: baseTitle,
          fileName: `${baseTitle}.${ext}`,
          videoType: item.type,
          quality: 'best',
          referrer: activeTab?.url || ''
        });
      });

      row.appendChild(info);
      row.appendChild(btn);
      streamListEl.appendChild(row);
    });
  }

  // Ping desktop app
  chrome.runtime.sendMessage({ type: 'IDMLITE_PING_APP' }, (res) => {
    if (res && res.connected) {
      statusEl.textContent = '● Đã kết nối IDM Lite';
      statusEl.classList.add('online');
    } else {
      statusEl.textContent = '○ IDM Lite chưa chạy';
      statusEl.classList.remove('online');
    }
  });

  // Load active tab & detected media
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    activeTab = tabs && tabs[0] ? tabs[0] : null;
    if (!activeTab || !activeTab.url || !activeTab.url.startsWith('http')) {
      pageTitleEl.textContent = 'Trang hiện tại không hỗ trợ bắt video';
      downloadPageBtn.disabled = true;
      renderStreams([]);
      return;
    }

    pageTitleEl.textContent = activeTab.title || activeTab.url;
    pageTitleEl.title = activeTab.url;

    chrome.runtime.sendMessage({ type: 'IDMLITE_GET_TAB_MEDIA', tabId: activeTab.id }, (res) => {
      if (res && Array.isArray(res.mediaList)) {
        renderStreams(res.mediaList);
      } else {
        renderStreams([]);
      }
    });
  });

  downloadPageBtn.addEventListener('click', () => {
    if (!activeTab || !activeTab.url) return;
    const quality = qualitySelect.value || 'best';
    const baseTitle = sanitizeTitle(activeTab.title);
    const primaryStream = !isMajorVideoPlatform(activeTab.url) && detectedStreams.length > 0 ? detectedStreams[0] : null;
    const ext = quality === 'audio' ? 'm4a' : (primaryStream?.ext || 'mp4');

    sendDownloadRequest({
      url: primaryStream ? primaryStream.url : activeTab.url,
      pageUrl: activeTab.url,
      title: baseTitle,
      fileName: `${baseTitle}.${ext}`,
      videoType: primaryStream ? primaryStream.type : 'ytdlp',
      quality,
      referrer: activeTab.url
    });
  });
});
