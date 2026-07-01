/* global chrome */
chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
  const ignoreDomains = [
    'g-portal.com',
    'g-portal.services',
    'gportal.com'
  ];

  try {
    const parsedUrl = new URL(downloadItem.url);
    const hostname = parsedUrl.hostname;
    const shouldIgnore = ignoreDomains.some(domain => hostname.endsWith(domain));
    if (shouldIgnore) {
      console.log('Ignore download interception for security-protected domain:', hostname);
      suggest();
      return;
    }
  } catch {
    // Bỏ qua
  }

  // Bỏ qua nếu là liên kết nội bộ loopback
  if (downloadItem.url.startsWith('http://127.0.0.1') || downloadItem.url.startsWith('http://localhost')) {
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
  fetch(`http://127.0.0.1:9091/get-extensions?extVersion=${extVersion}`)
    .then((res) => res.json())
    .then((config) => {
      if (!config.success || !config.isInterceptionEnabled) {
        suggest();
        return; // Không can thiệp nếu tắt tính năng bắt link hoặc server báo false
      }

      const url = downloadItem.url;
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
      const isCloudOrDownloadPattern = url.includes('drive.usercontent.google.com') ||
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

        // Retrieve cookies for both the download URL and the referrer site, then merge them
        chrome.cookies.getAll({ url: url }, (cookies1) => {
          const sendData = (mergedCookies) => {
            const cookieStr = mergedCookies ? mergedCookies.map(c => `${c.name}=${c.value}`).join('; ') : '';
            
            fetch('http://127.0.0.1:9091/add-download', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                url: url,
                fileName: filename,
                cookies: cookieStr,
                referrer: referrerUrl
              })
            }).catch(e => console.error('Error posting download to IDM Lite:', e));
          };

          if (referrerUrl && !referrerUrl.startsWith('chrome') && referrerUrl.startsWith('http')) {
            try {
              const urlHost = new URL(url).host;
              const refHost = new URL(referrerUrl).host;
              if (urlHost !== refHost) {
                chrome.cookies.getAll({ url: referrerUrl }, (cookies2) => {
                  const cookieMap = {};
                  (cookies1 || []).forEach(c => cookieMap[c.name] = c);
                  (cookies2 || []).forEach(c => cookieMap[c.name] = c);
                  sendData(Object.values(cookieMap));
                });
                return;
              }
            } catch {
              // Bỏ qua
            }
          }
          sendData(cookies1 || []);
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
