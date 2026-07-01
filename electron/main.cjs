const { app, BrowserWindow, ipcMain, shell, Menu, Tray, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const os = require('os');

// ── Single instance lock ─────────────────────────────────────────────────────
// Prevent multiple instances from running and competing on port 9091
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // Another instance is already running — bring it to focus and quit this one
  app.quit();
}

app.on('second-instance', () => {
  // Someone tried to launch a second instance → restore the first one
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});
// ─────────────────────────────────────────────────────────────────────────────

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 128, keepAliveMsecs: 10000 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 128, keepAliveMsecs: 10000 });

// ── Auto-Update via GitHub Releases ──────────────────────────────────────────
// TODO: Change this to your actual GitHub repo path before publishing
const GITHUB_REPO = 'HuyTran1002/IDM-lite';
const GITHUB_RELEASES_URL = `https://github.com/${GITHUB_REPO}/releases/latest`;
const GITHUB_API_URL     = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

/** Returns true when `latest` semver is greater than `current`. */
function isNewerVersion(latest, current) {
  const parse = (v) => String(v).replace(/^v/, '').split('.').map(Number);
  const l = parse(latest);
  const c = parse(current);
  for (let i = 0; i < 3; i++) {
    if ((l[i] || 0) > (c[i] || 0)) return true;
    if ((l[i] || 0) < (c[i] || 0)) return false;
  }
  return false;
}

/** Fetch latest release from GitHub and notify renderer if update is available. */
async function checkForUpdates() {
  try {
    const currentVersion = app.getVersion();
    const res = await fetch(GITHUB_API_URL, {
      headers: { 'User-Agent': `IDMLite/${currentVersion}` }
    });
    if (!res.ok) return;
    const data = await res.json();
    const latestVersion = (data.tag_name || '').replace(/^v/, '');
    if (latestVersion && isNewerVersion(latestVersion, currentVersion)) {
      console.log(`[Update] New version available: ${currentVersion} → ${latestVersion}`);
      if (mainWindow) {
        mainWindow.webContents.send('update-available', {
          currentVersion,
          latestVersion,
          releaseNotes: data.body || '',
          releaseUrl: data.html_url || GITHUB_RELEASES_URL
        });
      }
    } else {
      console.log(`[Update] App is up to date (v${currentVersion}).`);
    }
  } catch (err) {
    // No internet or API rate limit — silently ignore
    console.log('[Update] Check skipped:', err.message);
  }
}
// ─────────────────────────────────────────────────────────────────────────────

let mainWindow;
let promptWindow;
let server;
let tray = null;

// Interception and extensions config
let isInterceptionEnabled = true;
let interceptedExtensions = ['zip', 'rar', '7z', 'exe', 'msi', 'dmg', 'pkg', 'deb', 'sh', 'apk', 'iso', 'bin', 'tar', 'gz', 'bz2', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'mp4', 'mkv', 'avi', 'mov', 'wmv', 'mp3', 'wav', 'flac', 'm4a'];
let startWithWindows = false; // Persisted to config.json; used to reliably track startup state

let extensionVersion = '1.0.2'; // Fallback
let lastSeenExtensionVersion = '';

function loadExtensionVersion() {
  try {
    let manifestPath = '';
    if (app.isPackaged) {
      manifestPath = path.join(process.resourcesPath, 'extension', 'manifest.json');
    } else {
      manifestPath = path.join(app.getAppPath(), 'extension', 'manifest.json');
    }
    if (fs.existsSync(manifestPath)) {
      const manifestData = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (manifestData && manifestData.version) {
        extensionVersion = manifestData.version;
        console.log(`Bundled extension version detected: ${extensionVersion}`);
      }
    }
  } catch (e) {
    console.error('Failed to read extension manifest:', e);
  }
}

const configPath = path.join(app.getPath('userData'), 'config.json');

function loadConfig() {
  try {
    if (fs.existsSync(configPath)) {
      const data = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (data.extensions) interceptedExtensions = data.extensions;
      if (data.isInterceptionEnabled !== undefined) isInterceptionEnabled = data.isInterceptionEnabled;
      if (data.startWithWindows !== undefined) startWithWindows = data.startWithWindows;
      console.log('IDM Lite config loaded successfully.');
    }
  } catch (e) {
    console.error('Failed to load config:', e);
  }

  // Check for installer-written startup flag (set on first run after install)
  const startupFlagPath = path.join(app.getPath('userData'), 'startup_requested.flag');
  if (fs.existsSync(startupFlagPath)) {
    startWithWindows = true;
    saveConfig();
    try { fs.unlinkSync(startupFlagPath); } catch (e) {}
    console.log('IDM Lite: Startup-with-Windows enabled via installer option.');
  }

  // Sync Electron login item setting with our in-memory config state
  app.setLoginItemSettings({
    openAtLogin: startWithWindows,
    path: app.getPath('exe'),
    args: startWithWindows ? ['--hidden'] : []
  });
}

function saveConfig() {
  try {
    fs.writeFileSync(configPath, JSON.stringify({
      extensions: interceptedExtensions,
      isInterceptionEnabled: isInterceptionEnabled,
      startWithWindows: startWithWindows
    }, null, 2));
    console.log('IDM Lite config saved.');
  } catch (e) {
    console.error('Failed to save config:', e);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'Internet Download Manager Lite',
    backgroundColor: '#0d0e12',
    show: false, // Start hidden to prevent flashing on startup
    icon: app.isPackaged
      ? path.join(process.resourcesPath, 'icon.png')
      : (fs.existsSync(path.join(__dirname, '../build/icon.png'))
          ? path.join(__dirname, '../build/icon.png')
          : undefined),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs')
    }
  });

  const isDev = process.env.NODE_ENV === 'development' || process.argv.includes('--dev');

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  const isHidden = process.argv.includes('--hidden');
  mainWindow.once('ready-to-show', () => {
    if (!isHidden) {
      mainWindow.show();
    }
    // Check for updates 5s after window is ready (non-blocking)
    setTimeout(checkForUpdates, 5000);
    // Re-check every 6 hours while app is running
    setInterval(checkForUpdates, 6 * 60 * 60 * 1000);
  });

  mainWindow.setMenuBarVisibility(false);

  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createTray() {
  // Use resourcesPath in packaged app, fallback to build folder in dev
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'icon.png')
    : (fs.existsSync(path.join(__dirname, '../build/icon.png'))
        ? path.join(__dirname, '../build/icon.png')
        : path.join(__dirname, 'icon.png'));
    
  try {
    tray = new Tray(iconPath);
  } catch (e) {
    console.error('Failed to create Tray with icon:', e);
    return;
  }
  
  const updateTrayMenu = () => {
    const contextMenu = Menu.buildFromTemplate([
      { label: 'Open IDM Lite', click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      }},
      { type: 'separator' },
      { label: 'Intercept Downloads', type: 'checkbox', checked: isInterceptionEnabled, click: (item) => {
        isInterceptionEnabled = item.checked;
        saveConfig();
        if (mainWindow) {
          mainWindow.webContents.send('config-changed', { isInterceptionEnabled, extensions: interceptedExtensions });
        }
      }},
      { label: 'Start with Windows', type: 'checkbox', checked: startWithWindows, click: (item) => {
        startWithWindows = item.checked;
        app.setLoginItemSettings({
          openAtLogin: item.checked,
          path: app.getPath('exe'),
          args: item.checked ? ['--hidden'] : []
        });
        saveConfig();
      }},
      { type: 'separator' },
      { label: 'Exit', click: () => {
        app.isQuitting = true;
        app.quit();
      }}
    ]);
    tray.setContextMenu(contextMenu);
  };

  tray.setToolTip('IDM Lite - Active Interceptor');
  updateTrayMenu();

  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  ipcMain.on('update-tray-menu', () => {
    updateTrayMenu();
  });

  app.on('update-tray', () => {
    updateTrayMenu();
  });
}

function openPromptWindow(url, fileName, cookies, referrer) {
  if (promptWindow) {
    try {
      promptWindow.close();
    } catch (e) {}
  }

  promptWindow = new BrowserWindow({
    width: 580,
    height: 420,
    resizable: false,
    maximizable: false,
    title: 'Start New Download',
    backgroundColor: '#14161f',
    alwaysOnTop: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs')
    }
  });

  const isDev = process.env.NODE_ENV === 'development' || process.argv.includes('--dev');
  const queryStr = `?url=${encodeURIComponent(url)}&fileName=${encodeURIComponent(fileName)}&cookies=${encodeURIComponent(cookies || '')}&referrer=${encodeURIComponent(referrer || '')}`;

  if (isDev) {
    promptWindow.loadURL(`http://localhost:5173/#prompt${queryStr}`);
  } else {
    promptWindow.loadFile(path.join(__dirname, '../dist/index.html'), { hash: `prompt${queryStr}` });
  }

  // Send data to the window when ready
  promptWindow.webContents.on('did-finish-load', () => {
    promptWindow.webContents.send('init-prompt', { url, fileName, cookies: cookies || '', referrer: referrer || '' });
  });

  promptWindow.setMenuBarVisibility(false);

  promptWindow.on('closed', () => {
    promptWindow = null;
  });
}

function getFilenameFromUrl(urlStr) {
  try {
    const parsed = new URL(urlStr);
    const pathname = parsed.pathname;
    let filename = pathname.substring(pathname.lastIndexOf('/') + 1);
    filename = decodeURIComponent(filename);
    if (filename && filename.includes('.') && !filename.endsWith('/')) {
      return sanitizeFilename(filename);
    }
  } catch (e) {}
  return null;
}

function decodeMimeWords(str) {
  if (!str) return str;
  // RFC 2047 MIME encoded-word pattern: =?charset?encoding?encoded-text?=
  const mimeRegex = /=\?([^?]+)\?([QBqb])\?([^?]*)\?=/g;
  
  return str.replace(mimeRegex, (match, charset, encoding, encodedText) => {
    if (encoding.toUpperCase() === 'B') {
      try {
        const buffer = Buffer.from(encodedText, 'base64');
        return buffer.toString(charset.toLowerCase() === 'utf-8' ? 'utf8' : 'latin1');
      } catch (e) {
        return match;
      }
    } else if (encoding.toUpperCase() === 'Q') {
      try {
        let decoded = encodedText.replace(/_/g, ' ');
        decoded = decoded.replace(/=([0-9A-F]{2})/gi, (m, hex) => {
          return String.fromCharCode(parseInt(hex, 16));
        });
        return Buffer.from(decoded, 'binary').toString(charset.toLowerCase() === 'utf-8' ? 'utf8' : 'latin1');
      } catch (e) {
        return match;
      }
    }
    return match;
  });
}

function parseContentDisposition(headerValue) {
  if (!headerValue) return null;
  // 1. Try to find filename* first (RFC 5987 / RFC 6266)
  const filenameStarMatch = headerValue.match(/filename\*=(?:UTF-8'')?["']?([^"';\n]+)["']?/i);
  if (filenameStarMatch && filenameStarMatch[1]) {
    try {
      return decodeURIComponent(filenameStarMatch[1].replace(/['"]/g, ''));
    } catch (e) {}
  }
  // 2. Fall back to standard filename=
  const filenameMatch = headerValue.match(/filename=["']?([^"';\n]+)["']?/i);
  if (filenameMatch && filenameMatch[1]) {
    let name = filenameMatch[1].replace(/['"]/g, '');
    try {
      // Node.js HTTP parser decodes headers as Latin1. Re-encode and decode as UTF-8.
      const buf = Buffer.from(name, 'latin1');
      const utf8Name = buf.toString('utf8');
      if (utf8Name !== name && !utf8Name.includes('\uFFFD')) {
        name = utf8Name;
      }
    } catch (e) {}
    try {
      return decodeURIComponent(name);
    } catch (e) {
      return name;
    }
  }
  return null;
}

function sanitizeFilename(filename) {
  if (!filename) return filename;
  
  // Convert Latin1 (ISO-8859-1) representation of UTF-8 back to proper UTF-8 if detected.
  // This handles files whose names were corrupted by Latin1 decoding of UTF-8 bytes (e.g. "HÆ°á»›ng dáº«n")
  try {
    const buf = Buffer.from(filename, 'latin1');
    const utf8Str = buf.toString('utf8');
    if (utf8Str !== filename && !utf8Str.includes('\uFFFD')) {
      filename = utf8Str;
    }
  } catch (e) {}

  // 1. Decode RFC 2047 MIME words
  let decoded = decodeMimeWords(filename);
  
  // 2. Decode percent-encoding
  try {
    decoded = decodeURIComponent(decoded);
  } catch (e) {}

  // 3. Remove Windows forbidden characters: \ / : * ? " < > |
  decoded = decoded.replace(/[\\/:*?"<>|]/g, '_');
  
  // Remove multiple spaces/underscores
  decoded = decoded.replace(/\s+/g, ' ').trim();
  
  return decoded;
}

/**
 * If a file already exists at `folder/name`, returns a unique path like
 * `folder/name (1).ext`, `folder/name (2).ext`, etc.
 */
function resolveUniqueFilePath(folder, name) {
  const ext = path.extname(name);           // e.g. ".zip"
  const base = path.basename(name, ext);    // e.g. "setup"
  let candidate = path.join(folder, name);
  let counter = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(folder, `${base} (${counter})${ext}`);
    counter++;
  }
  return candidate;
}

function detectCategory(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  const docExtensions = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'epub', 'md'];
  const videoExtensions = ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', '3gp'];
  const musicExtensions = ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'wma'];
  const programExtensions = ['exe', 'msi', 'dmg', 'pkg', 'deb', 'sh', 'apk', 'iso', 'bin'];
  const zipExtensions = ['zip', 'rar', '7z', 'tar', 'gz', 'bz2'];

  if (docExtensions.includes(ext)) return 'document';
  if (videoExtensions.includes(ext)) return 'video';
  if (musicExtensions.includes(ext)) return 'music';
  if (programExtensions.includes(ext) || zipExtensions.includes(ext)) return 'program';
  return 'other';
}

function startHttpServer() {
  server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost:9091'}`);

    if (parsedUrl.pathname === '/add-download') {
      if (!isInterceptionEnabled) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Interception is disabled' }));
        return;
      }
      
      if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => {
          body += chunk.toString();
        });
        req.on('end', () => {
          try {
            const data = JSON.parse(body);
            const downloadUrl = data.url;
            if (downloadUrl) {
              const fileName = data.fileName || getFilenameFromUrl(downloadUrl) || 'download_file_' + Math.floor(Math.random() * 1000);
              const cookies = data.cookies || '';
              const referrer = data.referrer || '';
              openPromptWindow(downloadUrl, fileName, cookies, referrer);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true, message: 'IDM Lite interceptor popup triggered' }));
            } else {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, error: 'Missing url in body' }));
            }
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
          }
        });
      } else {
        const downloadUrl = parsedUrl.searchParams.get('url');
        if (downloadUrl) {
          let fileName = parsedUrl.searchParams.get('fileName') || getFilenameFromUrl(downloadUrl) || 'download_file_' + Math.floor(Math.random() * 1000);
          openPromptWindow(downloadUrl, fileName, '', '');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: 'IDM Lite interceptor popup triggered' }));
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Missing url parameter' }));
        }
      }
    } else if (parsedUrl.pathname === '/get-extensions') {
      const extVer = parsedUrl.searchParams.get('extVersion');
      if (extVer) {
        const oldVersion = lastSeenExtensionVersion;
        lastSeenExtensionVersion = extVer;
        
        if (oldVersion !== extVer && mainWindow && !mainWindow.isDestroyed()) {
          const parsedBundled = extensionVersion.split('.').map(Number);
          const parsedLastSeen = extVer.split('.').map(Number);
          let needsUpdate = false;
          for (let i = 0; i < Math.max(parsedBundled.length, parsedLastSeen.length); i++) {
            const b = parsedBundled[i] || 0;
            const l = parsedLastSeen[i] || 0;
            if (b > l) {
              needsUpdate = true;
              break;
            } else if (l > b) {
              break;
            }
          }
          mainWindow.webContents.send('extension-status-update', {
            bundledVersion: extensionVersion,
            installedVersion: extVer,
            needsUpdate
          });
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        extensions: interceptedExtensions,
        isInterceptionEnabled: isInterceptionEnabled
      }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Endpoint not found' }));
    }
  });

  server.listen(9091, '127.0.0.1', () => {
    console.log('IDM Lite HTTP API Capture Server listening on http://127.0.0.1:9091');
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn('Port 9091 is already in use. Another IDM Lite instance may be running. Capture server disabled.');
      server = null; // disable so will-quit does not crash
    } else {
      console.error('HTTP server error:', err);
    }
  });
}

app.whenReady().then(() => {
  loadExtensionVersion();
  loadConfig();
  createWindow();
  createTray();
  startHttpServer();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  if (server) {
    server.close();
  }
});

// Download Manager state
const activeDownloads = {};

class DownloadTask {
  constructor(id, url, saveFolder, fileName, cookies, referrer) {
    this.id = id;
    this.url = url;
    this.saveFolder = saveFolder;
    // Resolve a unique file path up-front so we never overwrite an existing file
    const safeFileName = sanitizeFilename(fileName);
    this.filePath = resolveUniqueFilePath(saveFolder, safeFileName);
    this.fileName = path.basename(this.filePath);
    this.cookies = cookies || '';
    this.referrer = referrer || '';
    
    this.downloaded = 0;
    this.total = 0;
    this.status = 'downloading';
    this.speed = 0;
    
    this.request = null;
    this.segmentRequests = [];
    this.segmentStreams = [];
    this.fileStream = null;
    this.acceptsRanges = false;
    
    this.lastBytes = 0;
    this.speedInterval = null;
    this.category = detectCategory(this.fileName);
    this.segments = [];
    this.lastProgressSentTime = 0;
  }

  start() {
    if (!fs.existsSync(this.saveFolder)) {
      fs.mkdirSync(this.saveFolder, { recursive: true });
    }

    this.status = 'downloading';
    this.lastBytes = 0;
    this.startSpeedTracker();

    // Check if the URL contains tokens/auth keys or belongs to portals that use one-time links
    const isSensitiveUrl = this.url.includes('token=') || 
                           this.url.includes('auth=') || 
                           this.url.includes('signature=') ||
                           this.url.includes('g-portal') ||
                           this.url.includes('gmail') ||
                           this.url.includes('drive.google');

    if (isSensitiveUrl) {
      console.log(`Sensitive URL detected (one-time token or auth gateway). Bypassing range check to download directly using single-connection stream.`);
      this.startDirectSingleConnectionDownload(this.url);
    } else {
      this.getHeadersAndStart(this.url);
    }
  }

  startDirectSingleConnectionDownload(targetUrl) {
    try {
      const parsedUrl = new URL(targetUrl);
      const isHttps = parsedUrl.protocol === 'https:';
      const client = isHttps ? https : http;
      const agent = isHttps ? httpsAgent : httpAgent;

      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Encoding': 'identity',
        'Connection': 'keep-alive'
      };
      if (this.cookies) {
        headers['Cookie'] = this.cookies;
      }
      if (this.referrer) {
        headers['Referer'] = this.referrer;
      }
      try {
        headers['Origin'] = new URL(this.url).origin;
      } catch (e) {}

      const options = {
        agent: agent,
        headers: headers
      };

      this.request = client.get(targetUrl, options, (res) => {
        // Handle redirect
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          let redirectUrl = res.headers.location;
          if (redirectUrl) {
            try {
              redirectUrl = new URL(redirectUrl, targetUrl).href;
            } catch (e) {
              console.error('Failed to resolve redirect URL:', e);
            }
            console.log(`Redirecting direct download to: ${redirectUrl}`);
            const nameFromRedirect = getFilenameFromUrl(redirectUrl);
            if (nameFromRedirect) {
              const safeRedirectName = sanitizeFilename(nameFromRedirect);
              this.filePath = resolveUniqueFilePath(this.saveFolder, safeRedirectName);
              this.fileName = path.basename(this.filePath);
              this.category = detectCategory(this.fileName);
            }
            this.startDirectSingleConnectionDownload(redirectUrl);
            return;
          }
        }

        if (res.statusCode >= 400 && res.statusCode !== 416) {
          this.handleError(new Error(`Server returned status code: ${res.statusCode}`));
          return;
        }

        const contentType = res.headers['content-type'] || '';
        const isHtmlResponse = contentType.includes('text/html') || contentType.includes('application/xhtml+xml');
        const ext = this.fileName.split('.').pop().toLowerCase();
        const nonHtmlExtensions = ['zip', 'rar', '7z', 'tar', 'gz', 'exe', 'msi', 'dmg', 'pkg', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'mp4', 'mkv', 'mp3', 'bin', 'dll'];
        
        if (isHtmlResponse && nonHtmlExtensions.includes(ext)) {
          this.handleError(new Error('Server trả về trang web (HTML) thay vì file tải xuống. Vui lòng kiểm tra lại quyền đăng nhập hoặc liên kết.'));
          res.req.destroy();
          return;
        }

        this.url = targetUrl; // Save resolved URL

        // Update file name from Content-Disposition if present
        const contentDisposition = res.headers['content-disposition'];
        if (contentDisposition) {
          const parsedName = parseContentDisposition(contentDisposition);
          if (parsedName) {
            const safeParsedName = sanitizeFilename(parsedName);
            this.filePath = resolveUniqueFilePath(this.saveFolder, safeParsedName);
            this.fileName = path.basename(this.filePath);
            this.category = detectCategory(this.fileName);
          }
        }

        const contentLength = res.headers['content-length'];
        this.total = contentLength ? parseInt(contentLength, 10) : 0;
        this.downloaded = 0;

        this.fileStream = fs.createWriteStream(this.filePath, { 
          flags: 'w',
          highWaterMark: 1024 * 1024 // 1MB buffer
        });

        res.on('data', (chunk) => {
          this.downloaded += chunk.length;
          const canContinue = this.fileStream.write(chunk);
          if (!canContinue) {
            res.pause();
            this.fileStream.once('drain', () => res.resume());
          }
          this.sendProgress();
        });

        res.on('end', () => {
          if (this.fileStream) {
            this.fileStream.end(() => {
              this.complete();
            });
          } else {
            this.complete();
          }
        });

        res.on('error', (err) => {
          if (this.fileStream) this.fileStream.end();
          this.handleError(err);
        });
      });

      this.request.on('socket', (socket) => {
        socket.setNoDelay(true);
        socket.setKeepAlive(true, 10000);
      });

      this.request.on('error', (err) => {
        this.handleError(err);
      });

    } catch (err) {
      this.handleError(err);
    }
  }

  getHeadersAndStart(targetUrl) {
    try {
      const parsedUrl = new URL(targetUrl);
      const isHttps = parsedUrl.protocol === 'https:';
      const client = isHttps ? https : http;
      const agent = isHttps ? httpsAgent : httpAgent;

      // Perform a range request for the first byte to verify server range support with Keep-Alive
      const options = {
        method: 'GET',
        agent: agent,
        headers: {
          'Range': 'bytes=0-0',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': '*/*',
          'Accept-Encoding': 'identity',
          'Connection': 'keep-alive'
        }
      };
      if (this.cookies) {
        options.headers['Cookie'] = this.cookies;
      }
      if (this.referrer) {
        options.headers['Referer'] = this.referrer;
      }
      try {
        options.headers['Origin'] = new URL(this.url).origin;
      } catch (e) {}

      const req = client.get(targetUrl, options, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          let redirectUrl = res.headers.location;
          if (redirectUrl) {
            try {
              redirectUrl = new URL(redirectUrl, targetUrl).href;
            } catch (e) {
              console.error('Failed to resolve redirect URL:', e);
            }
            console.log(`Redirecting header request to: ${redirectUrl}`);
            const nameFromRedirect = getFilenameFromUrl(redirectUrl);
            if (nameFromRedirect) {
              const safeRedirectName = sanitizeFilename(nameFromRedirect);
              // Re-resolve a unique path in case the redirected name conflicts with an existing file
              this.filePath = resolveUniqueFilePath(this.saveFolder, safeRedirectName);
              this.fileName = path.basename(this.filePath);
              this.category = detectCategory(this.fileName);
            }
            this.getHeadersAndStart(redirectUrl);
            return;
          }
        }

        this.url = targetUrl; // Save resolved URL

        const contentDisposition = res.headers['content-disposition'];
        if (contentDisposition) {
          const parsedName = parseContentDisposition(contentDisposition);
          if (parsedName) {
            const safeParsedName = sanitizeFilename(parsedName);
            // Re-resolve a unique path in case the server-supplied name conflicts
            this.filePath = resolveUniqueFilePath(this.saveFolder, safeParsedName);
            this.fileName = path.basename(this.filePath);
            this.category = detectCategory(this.fileName);
          }
        }
        const contentType = res.headers['content-type'] || '';
        const isHtmlResponse = contentType.includes('text/html') || contentType.includes('application/xhtml+xml');
        const ext = this.fileName.split('.').pop().toLowerCase();
        const nonHtmlExtensions = ['zip', 'rar', '7z', 'tar', 'gz', 'exe', 'msi', 'dmg', 'pkg', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'mp4', 'mkv', 'mp3', 'bin', 'dll'];
        
        if (isHtmlResponse && nonHtmlExtensions.includes(ext)) {
          this.handleError(new Error('Server trả về trang web (HTML) thay vì file tải xuống. Vui lòng kiểm tra lại quyền đăng nhập hoặc liên kết.'));
          req.destroy();
          return;
        }
        const contentRange = res.headers['content-range'];
        this.acceptsRanges = res.statusCode === 206 || contentRange !== undefined;

        let totalSize = 0;
        if (contentRange) {
          const match = contentRange.match(/\/(\d+)$/);
          if (match) totalSize = parseInt(match[1], 10);
        }
        if (!totalSize) {
          const contentLength = res.headers['content-length'];
          totalSize = contentLength ? parseInt(contentLength, 10) : 0;
        }

        this.total = totalSize;
        req.destroy(); // Disconnect range verification request

        if (this.acceptsRanges && totalSize > 1024 * 1024) {
          console.log(`Server supports Range requests. Initiating multi-connection download (8 threads) for file of size ${totalSize} bytes.`);
          this.startMultiConnectionDownload(targetUrl, totalSize);
        } else {
          console.log(`Server does not support Range requests or file is small. Falling back to single-connection stream.`);
          this.startSingleConnectionDownload(targetUrl);
        }
      });

      req.on('socket', (socket) => {
        socket.setNoDelay(true);
        socket.setKeepAlive(true, 10000);
      });

      req.on('error', (err) => {
        this.handleError(err);
      });
    } catch (err) {
      this.handleError(err);
    }
  }

  startSingleConnectionDownload(targetUrl) {
    try {
      const parsedUrl = new URL(targetUrl);
      const isHttps = parsedUrl.protocol === 'https:';
      const client = isHttps ? https : http;
      const agent = isHttps ? httpsAgent : httpAgent;

      // If the file already exists (i.e. a paused resume), pick up from the already-downloaded bytes.
      // The filePath is set in the constructor, so it is always the correct unique path.
      let localDownloaded = 0;
      if (fs.existsSync(this.filePath)) {
        localDownloaded = fs.statSync(this.filePath).size;
      }
      this.downloaded = localDownloaded;

      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Encoding': 'identity',
        'Connection': 'keep-alive'
      };
      // Resume from the byte offset we already have
      if (localDownloaded > 0) {
        headers['Range'] = `bytes=${localDownloaded}-`;
      }
      if (this.cookies) {
        headers['Cookie'] = this.cookies;
      }
      if (this.referrer) {
        headers['Referer'] = this.referrer;
      }
      try {
        headers['Origin'] = new URL(this.url).origin;
      } catch (e) {}

      const options = {
        agent: agent,
        headers: headers
      };

      this.request = client.get(targetUrl, options, (res) => {
        if (res.statusCode >= 400 && res.statusCode !== 416) {
          this.handleError(new Error(`Server returned status code: ${res.statusCode}`));
          return;
        }

        const contentType = res.headers['content-type'] || '';
        const isHtmlResponse = contentType.includes('text/html') || contentType.includes('application/xhtml+xml');
        const ext = this.fileName.split('.').pop().toLowerCase();
        const nonHtmlExtensions = ['zip', 'rar', '7z', 'tar', 'gz', 'exe', 'msi', 'dmg', 'pkg', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'mp4', 'mkv', 'mp3', 'bin', 'dll'];
        
        if (isHtmlResponse && nonHtmlExtensions.includes(ext)) {
          this.handleError(new Error('Server trả về trang web (HTML) thay vì file tải xuống. Vui lòng kiểm tra lại quyền đăng nhập hoặc liên kết.'));
          res.req.destroy();
          return;
        }

        this.fileStream = fs.createWriteStream(this.filePath, { 
          flags: localDownloaded > 0 ? 'a' : 'w',
          highWaterMark: 1024 * 1024 // 1MB buffer size for fast writing
        });

        res.on('data', (chunk) => {
          this.downloaded += chunk.length;
          const canContinue = this.fileStream.write(chunk);
          if (!canContinue) {
            res.pause();
            this.fileStream.once('drain', () => res.resume());
          }
          this.sendProgress();
        });

        res.on('end', () => {
          if (this.fileStream) {
            this.fileStream.end(() => {
              this.complete();
            });
          } else {
            this.complete();
          }
        });

        res.on('error', (err) => {
          this.handleError(err);
        });
      });

      this.request.on('socket', (socket) => {
        socket.setNoDelay(true);
        socket.setKeepAlive(true, 10000);
      });

      this.request.on('error', (err) => {
        this.handleError(err);
      });

    } catch (err) {
      this.handleError(err);
    }
  }

  startMultiConnectionDownload(targetUrl, totalSize) {
    try {
      // Adaptive threads: >500MB = 32 threads, >100MB = 24 threads, >20MB = 16 threads, else 8 threads
      let numConnections = 8;
      if (totalSize > 500 * 1024 * 1024) {
        numConnections = 32;
      } else if (totalSize > 100 * 1024 * 1024) {
        numConnections = 24;
      } else if (totalSize > 20 * 1024 * 1024) {
        numConnections = 16;
      }
      
      const chunkSize = Math.ceil(totalSize / numConnections);
      this.segments = [];
      this.segmentRequests = [];
      this.segmentStreams = [];
      this.downloaded = 0;

      let activeSegmentsCount = numConnections;

      const tempDir = path.join(os.tmpdir(), 'IDMLite', this.id);
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      for (let i = 0; i < numConnections; i++) {
        const startPos = i * chunkSize;
        const endPos = Math.min((i + 1) * chunkSize - 1, totalSize - 1);
        const tempPath = path.join(tempDir, `part_${i}`);

        let segDownloaded = 0;
        if (fs.existsSync(tempPath)) {
          segDownloaded = fs.statSync(tempPath).size;
        }
        this.downloaded += segDownloaded;

        this.segments.push({
          index: i,
          startPos,
          endPos,
          downloaded: segDownloaded,
          tempPath,
          completed: segDownloaded >= (endPos - startPos + 1)
        });
      }

      this.sendProgress();

      const checkCompletion = () => {
        if (this.status !== 'downloading') return;

        const allDone = this.segments.every(s => s.completed);
        if (allDone) {
          this.mergeSegments().catch(err => this.handleError(err));
        }
      };

      this.segments.forEach((seg) => {
        if (seg.completed) {
          activeSegmentsCount--;
          if (activeSegmentsCount === 0) {
            checkCompletion();
          }
          return;
        }

        this.downloadSegment(targetUrl, seg, () => {
          checkCompletion();
        });
      });
    } catch (err) {
      this.handleError(err);
    }
  }

  downloadSegment(targetUrl, seg, callback) {
    try {
      const parsedUrl = new URL(targetUrl);
      const isHttps = parsedUrl.protocol === 'https:';
      const client = isHttps ? https : http;
      const agent = isHttps ? httpsAgent : httpAgent;

      const start = seg.startPos + seg.downloaded;
      const end = seg.endPos;

      if (start > end) {
        seg.completed = true;
        callback();
        return;
      }

      const options = {
        agent: agent,
        headers: {
          'Range': `bytes=${start}-${end}`,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': '*/*',
          'Accept-Encoding': 'identity',
          'Connection': 'keep-alive'
        }
      };
      if (this.cookies) {
        options.headers['Cookie'] = this.cookies;
      }
      if (this.referrer) {
        options.headers['Referer'] = this.referrer;
      }
      try {
        options.headers['Origin'] = new URL(this.url).origin;
      } catch (e) {}

      const req = client.get(targetUrl, options, (res) => {
        if (res.statusCode !== 206 && res.statusCode !== 200) {
          this.handleError(new Error(`Segment ${seg.index} server returned: ${res.statusCode}`));
          return;
        }

        const stream = fs.createWriteStream(seg.tempPath, { 
          flags: seg.downloaded > 0 ? 'a' : 'w',
          highWaterMark: 1024 * 1024 // 1MB buffer
        });
        this.segmentStreams.push(stream);

        res.on('data', (chunk) => {
          if (this.status !== 'downloading') {
            req.destroy();
            stream.end();
            this.segmentStreams = this.segmentStreams.filter(s => s !== stream);
            return;
          }
          seg.downloaded += chunk.length;
          this.downloaded += chunk.length;
          const canContinue = stream.write(chunk);
          if (!canContinue) {
            res.pause();
            stream.once('drain', () => res.resume());
          }
          this.sendProgress();
        });

        res.on('end', () => {
          this.segmentStreams = this.segmentStreams.filter(s => s !== stream);
          if (seg.downloaded >= (seg.endPos - seg.startPos + 1)) {
            seg.completed = true;
          }
          stream.end(() => {
            callback();
          });
        });

        res.on('error', (err) => {
          stream.end();
          this.segmentStreams = this.segmentStreams.filter(s => s !== stream);
          this.handleError(err);
        });
      });

      req.on('socket', (socket) => {
        socket.setNoDelay(true);
        socket.setKeepAlive(true, 10000);
      });

      req.on('error', (err) => {
        this.handleError(err);
      });

      this.segmentRequests.push(req);
    } catch (err) {
      this.handleError(err);
    }
  }

  async mergeSegments() {
    this.status = 'merging';
    this.sendProgress(true);

    try {
      const writeStream = fs.createWriteStream(this.filePath);

      for (const seg of this.segments) {
        if (!fs.existsSync(seg.tempPath)) continue;
        await new Promise((resolve, reject) => {
          const readStream = fs.createReadStream(seg.tempPath, { highWaterMark: 4 * 1024 * 1024 });
          readStream.on('data', (chunk) => {
            const canContinue = writeStream.write(chunk);
            if (!canContinue) {
              readStream.pause();
              writeStream.once('drain', () => readStream.resume());
            }
          });
          readStream.on('end', resolve);
          readStream.on('error', reject);
        });
      }

      await new Promise((resolve, reject) => {
        writeStream.end(() => resolve());
        writeStream.on('error', reject);
      });
    } catch (err) {
      this.handleError(err);
      return;
    }

    // Clean up segment files
    this.segments.forEach(s => {
      try {
        if (fs.existsSync(s.tempPath)) {
          fs.unlinkSync(s.tempPath);
        }
      } catch (e) {
        console.error('Failed to delete segment file:', e);
      }
    });

    // Clean up temp directory
    try {
      const tempDir = path.join(os.tmpdir(), 'IDMLite', this.id);
      if (fs.existsSync(tempDir)) {
        fs.rmdirSync(tempDir);
      }
    } catch (e) {
      console.error('Failed to delete temp folder:', e);
    }

    this.complete();
  }

  pause() {
    this.status = 'paused';
    this.cleanup();
    this.sendProgress();
  }

  cancel() {
    this.status = 'failed';
    this.cleanup();
    this.sendProgress();
  }

  cleanup() {
    if (this.request) {
      this.request.destroy();
      this.request = null;
    }
    if (this.segmentRequests) {
      this.segmentRequests.forEach(req => {
        try {
          req.destroy();
        } catch (e) {}
      });
      this.segmentRequests = [];
    }
    if (this.segmentStreams) {
      this.segmentStreams.forEach(stream => {
        try {
          stream.end();
        } catch (e) {}
      });
      this.segmentStreams = [];
    }
    if (this.fileStream) {
      this.fileStream.end();
      this.fileStream = null;
    }
    if (this.speedInterval) {
      clearInterval(this.speedInterval);
      this.speedInterval = null;
    }
    this.speed = 0;
  }

  complete() {
    this.status = 'completed';
    this.cleanup();
    this.sendProgress();
  }

  handleError(err) {
    console.error(`Download error for item ${this.id}:`, err);
    try {
      const logDir = app.getPath('userData');
      const logFile = path.join(logDir, 'download_error_debug.log');
      const time = new Date().toISOString();
      const logMessage = `[${time}] ID: ${this.id} | URL: ${this.url} | File: ${this.fileName}\nError: ${err.stack || err.message || err}\n\n`;
      fs.appendFileSync(logFile, logMessage);
    } catch (e) {
      console.error('Failed to write download error log:', e);
    }
    this.status = 'failed';
    this.errorMsg = err.message || String(err);
    this.cleanup();
    this.sendProgress();
  }

  startSpeedTracker() {
    if (this.speedInterval) clearInterval(this.speedInterval);
    
    this.speedInterval = setInterval(() => {
      if (this.status === 'downloading') {
        const currentBytes = this.downloaded;
        this.speed = Math.max(0, currentBytes - this.lastBytes);
        this.lastBytes = currentBytes;
        this.sendProgress();
      }
    }, 1000);
  }

  sendProgress(force = false) {
    const now = Date.now();
    if (!force && this.status === 'downloading' && now - this.lastProgressSentTime < 150) {
      return;
    }
    this.lastProgressSentTime = now;

    if (mainWindow) {
      mainWindow.webContents.send('download-progress', {
        id: this.id,
        downloaded: this.downloaded,
        total: this.total,
        speed: this.speed,
        status: this.status,
        savePath: this.saveFolder,
        name: this.fileName,
        category: this.category,
        errorMsg: this.errorMsg || '',
        segments: this.segments ? this.segments.map(s => ({
          index: s.index,
          startPos: s.startPos,
          endPos: s.endPos,
          downloaded: s.downloaded,
          completed: s.completed
        })) : []
      });
    }
  }
}

// IPC listeners
ipcMain.on('start-download', (event, { id, url, saveFolder, fileName, cookies, referrer }) => {
  console.log(`Starting download: ${url} -> ${saveFolder}/${fileName}`);
  
  if (activeDownloads[id]) {
    activeDownloads[id].cleanup();
  }
  
  const task = new DownloadTask(id, url, saveFolder, fileName, cookies, referrer);
  activeDownloads[id] = task;
  task.start();
});

ipcMain.on('pause-download', (event, id) => {
  console.log(`Pausing download: ${id}`);
  if (activeDownloads[id]) {
    activeDownloads[id].pause();
  }
});

ipcMain.on('resume-download', (event, id) => {
  console.log(`Resuming download: ${id}`);
  if (activeDownloads[id]) {
    activeDownloads[id].start();
  }
});

ipcMain.on('cancel-download', (event, id) => {
  console.log(`Cancelling download: ${id}`);
  if (activeDownloads[id]) {
    activeDownloads[id].cancel();
  }
});

ipcMain.on('open-folder', (event, folderPath) => {
  console.log(`Opening folder: ${folderPath}`);
  if (fs.existsSync(folderPath)) {
    shell.openPath(folderPath).catch((err) => {
      console.error('Failed to open path:', err);
    });
  } else {
    console.warn('Folder does not exist:', folderPath);
  }
});

ipcMain.on('confirm-prompt-download', (event, data) => {
  console.log(`Confirming prompt download: ${data.name}`);
  if (mainWindow) {
    mainWindow.webContents.send('capture-download', {
      url: data.url,
      fileName: data.name,
      savePath: data.savePath,
      cookies: data.cookies || '',
      referrer: data.referrer || ''
    });

    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }

  if (promptWindow) {
    promptWindow.close();
  }
});

// Settings IPC Handlers
ipcMain.handle('get-app-config', () => {
  return {
    isInterceptionEnabled,
    extensions: interceptedExtensions,
    startWithWindows // Return from in-memory variable — reliable across all Windows versions
  };
});

ipcMain.handle('get-version', () => {
  return app.getVersion();
});

ipcMain.handle('get-extension-status', () => {
  let needsUpdate = false;
  if (lastSeenExtensionVersion) {
    const parsedBundled = extensionVersion.split('.').map(Number);
    const parsedLastSeen = lastSeenExtensionVersion.split('.').map(Number);
    for (let i = 0; i < Math.max(parsedBundled.length, parsedLastSeen.length); i++) {
      const b = parsedBundled[i] || 0;
      const l = parsedLastSeen[i] || 0;
      if (b > l) {
        needsUpdate = true;
        break;
      } else if (l > b) {
        break;
      }
    }
  }
  return {
    bundledVersion: extensionVersion,
    installedVersion: lastSeenExtensionVersion || 'Chưa nhận diện',
    needsUpdate
  };
});

ipcMain.handle('save-app-config', (event, newConfig) => {
  if (newConfig.isInterceptionEnabled !== undefined) {
    isInterceptionEnabled = newConfig.isInterceptionEnabled;
  }
  if (newConfig.extensions !== undefined) {
    interceptedExtensions = newConfig.extensions;
  }
  if (newConfig.startWithWindows !== undefined) {
    startWithWindows = newConfig.startWithWindows; // Update in-memory variable first
    app.setLoginItemSettings({
      openAtLogin: startWithWindows,
      path: app.getPath('exe'),
      args: startWithWindows ? ['--hidden'] : []
    });
  }
  saveConfig(); // Persist all settings including startWithWindows
  
  app.emit('update-tray');

  // Notify main window if open
  if (mainWindow) {
    mainWindow.webContents.send('config-changed', { isInterceptionEnabled, extensions: interceptedExtensions });
  }

  return { success: true };
});

// Open GitHub release page in the system browser
ipcMain.on('open-release-url', (event, url) => {
  shell.openExternal(url || GITHUB_RELEASES_URL);
});

ipcMain.on('open-extension-folder', () => {
  const extPath = app.isPackaged
    ? path.join(process.resourcesPath, 'extension')
    : path.join(__dirname, '../extension');
  if (fs.existsSync(extPath)) {
    shell.openPath(extPath);
  } else {
    console.warn('Extension folder not found:', extPath);
  }
});

ipcMain.handle('get-extension-path', () => {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'extension')
    : path.join(__dirname, '../extension');
});

ipcMain.handle('export-extension-folder', async () => {
  const extPath = app.isPackaged
    ? path.join(process.resourcesPath, 'extension')
    : path.join(__dirname, '../extension');

  if (!fs.existsSync(extPath)) {
    return { success: false, error: 'Không tìm thấy thư mục extension gốc.' };
  }

  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Chọn thư mục để lưu Extension',
    properties: ['openDirectory', 'createDirectory']
  });

  if (canceled || filePaths.length === 0) {
    return { success: false, error: 'Đã hủy chọn thư mục.' };
  }

  const targetDir = path.join(filePaths[0], 'idmlite-extension');
  try {
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const files = fs.readdirSync(extPath);
    for (const file of files) {
      const srcFile = path.join(extPath, file);
      const destFile = path.join(targetDir, file);
      fs.copyFileSync(srcFile, destFile);
    }
    
    shell.openPath(targetDir);
    return { success: true, path: targetDir };
  } catch (err) {
    console.error('Lỗi khi xuất extension:', err);
    return { success: false, error: err.message };
  }
});
