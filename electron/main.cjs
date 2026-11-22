const { app, BrowserWindow, ipcMain, shell, Menu, Tray, dialog, session } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

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

// ── Global Error Safety ──────────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('[Main Process] Uncaught Exception caught:', err.stack || err.message || err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Main Process] Unhandled Rejection caught:', reason);
});
// ─────────────────────────────────────────────────────────────────────────────


const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 128, keepAliveMsecs: 10000 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 128, keepAliveMsecs: 10000 });

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

function buildStandardHeaders(options = {}) {
  const headers = {
    'User-Agent': options.userAgent || DEFAULT_USER_AGENT,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Language': 'en-US,en;q=0.9,vi;q=0.8',
    'Accept-Encoding': 'identity',
    'Connection': 'keep-alive',
    'Sec-Ch-Ua': '"Chromium";v="134", "Not:A-Brand";v="24", "Google Chrome";v="134"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': options.range ? 'empty' : 'document',
    'Sec-Fetch-Mode': options.range ? 'cors' : 'navigate',
    'Sec-Fetch-Site': 'cross-site',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1'
  };
  if (options.range) {
    headers['Range'] = options.range;
  }
  if (options.cookies) {
    headers['Cookie'] = options.cookies;
  }
  if (options.referrer) {
    headers['Referer'] = options.referrer;
  }
  return headers;
}

// ── Auto-Update via GitHub Releases ──────────────────────────────────────────
// TODO: Change this to your actual GitHub repo path before publishing
const GITHUB_REPO = 'HuyTran1002/IDM-lite';
const GITHUB_RELEASES_URL = `https://github.com/${GITHUB_REPO}/releases/latest`;
const GITHUB_API_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

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
async function checkForUpdates(isManual = false) {
  try {
    const currentVersion = app.getVersion();
    const res = await fetch(GITHUB_API_URL, {
      headers: { 'User-Agent': `IDMLite/${currentVersion}` }
    });
    if (!res.ok) {
      if (isManual && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update-error', `Không thể kiểm tra cập nhật (HTTP ${res.status})`);
      }
      return;
    }
    const data = await res.json();
    const latestVersion = (data.tag_name || '').replace(/^v/, '');
    if (latestVersion && isNewerVersion(latestVersion, currentVersion)) {
      console.log(`[Update] New version available: ${currentVersion} → ${latestVersion}`);

      const exeAsset = (data.assets || []).find(a =>
        a.name && (a.name.endsWith('.exe') || a.name.toLowerCase().includes('setup'))
      );
      const downloadUrl = exeAsset ? exeAsset.browser_download_url : `https://github.com/${GITHUB_REPO}/releases/download/v${latestVersion}/IDMLite.Setup.${latestVersion}.exe`;
      const assetSize = exeAsset ? exeAsset.size : 0;
      const assetName = exeAsset ? exeAsset.name : `IDMLite.Setup.${latestVersion}.exe`;

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update-available', {
          currentVersion,
          latestVersion,
          releaseNotes: data.body || '',
          releaseUrl: data.html_url || GITHUB_RELEASES_URL,
          downloadUrl,
          assetName,
          assetSize
        });
      }
    } else {
      console.log(`[Update] App is up to date (v${currentVersion}).`);
      if (isManual && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update-not-available', { currentVersion });
      }
    }
  } catch (err) {
    console.log('[Update] Check skipped:', err.message);
    if (isManual && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-error', err.message || 'Lỗi kết nối khi kiểm tra cập nhật');
    }
  }
}

let activeUpdateReq = null;
let updateSpeedInterval = null;

function cancelAppUpdate() {
  if (activeUpdateReq) {
    try {
      activeUpdateReq.destroy();
    } catch (e) { }
    activeUpdateReq = null;
  }
  if (updateSpeedInterval) {
    clearInterval(updateSpeedInterval);
    updateSpeedInterval = null;
  }
}

function downloadUpdate(url, destPath, onProgress, onComplete, onError) {
  cancelAppUpdate();

  const follow = (curUrl, redirectCount = 0) => {
    if (redirectCount > 8) {
      return onError(new Error('Chuyển hướng quá nhiều lần khi tải bản cập nhật.'));
    }

    let parsed;
    try {
      parsed = new URL(curUrl);
    } catch (e) {
      return onError(new Error('Đường dẫn tải bản cập nhật không hợp lệ.'));
    }

    const client = parsed.protocol === 'https:' ? https : http;
    const options = {
      headers: {
        'User-Agent': DEFAULT_USER_AGENT,
        'Accept': '*/*'
      }
    };

    const req = client.get(curUrl, options, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        let redirectUrl = res.headers.location;
        if (redirectUrl) {
          try {
            redirectUrl = new URL(redirectUrl, curUrl).href;
          } catch (e) { }
          return follow(redirectUrl, redirectCount + 1);
        }
      }

      if (res.statusCode !== 200) {
        return onError(new Error(`Máy chủ tải cập nhật trả về mã lỗi: ${res.statusCode}`));
      }

      const total = parseInt(res.headers['content-length'] || '0', 10);
      let transferred = 0;
      let lastTransferred = 0;
      let speed = 0;

      const fileStream = fs.createWriteStream(destPath);

      updateSpeedInterval = setInterval(() => {
        speed = Math.max(0, transferred - lastTransferred) * 2;
        lastTransferred = transferred;
        const percent = total > 0 ? Math.min(100, Math.round((transferred / total) * 100)) : 0;
        onProgress({ percent, transferred, total, speed });
      }, 500);

      res.on('data', (chunk) => {
        transferred += chunk.length;
      });

      res.pipe(fileStream);

      fileStream.on('finish', () => {
        if (updateSpeedInterval) clearInterval(updateSpeedInterval);
        activeUpdateReq = null;
        fileStream.close(() => {
          onComplete(destPath);
        });
      });

      fileStream.on('error', (err) => {
        if (updateSpeedInterval) clearInterval(updateSpeedInterval);
        activeUpdateReq = null;
        try { fs.unlinkSync(destPath); } catch (e) { }
        onError(err);
      });

      res.on('error', (err) => {
        if (updateSpeedInterval) clearInterval(updateSpeedInterval);
        activeUpdateReq = null;
        fileStream.destroy();
        try { fs.unlinkSync(destPath); } catch (e) { }
        onError(err);
      });
    });

    req.on('error', (err) => {
      if (updateSpeedInterval) clearInterval(updateSpeedInterval);
      activeUpdateReq = null;
      onError(err);
    });

    activeUpdateReq = req;
  };

  follow(url);
}

function launchInstallerAndQuit(installerPath) {
  const currentExe = process.execPath;
  const isPackaged = app.isPackaged;

  const tempDir = path.dirname(installerPath);
  const batPath = path.join(tempDir, 'run_update.bat');

  const relaunchCmd = isPackaged ? `start "" "${currentExe}"` : `echo Finished in dev mode`;

  const batContent = `@echo off
chcp 65001 >nul
echo [IDMLite Update] Dang chuan bi cai dat ban moi...
timeout /t 2 /nobreak >nul
taskkill /F /IM IDMLite.exe >nul 2>&1
echo [IDMLite Update] Dang cai dat...
start /wait "" "${installerPath}" /S
if %errorlevel% neq 0 (
  start /wait "" "${installerPath}"
)
echo [IDMLite Update] Khoi dong lai ung dung...
${relaunchCmd}
exit
`;

  try {
    fs.writeFileSync(batPath, batContent, 'utf8');
    const child = spawn('cmd.exe', ['/c', batPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.unref();

    setTimeout(() => {
      app.isQuitting = true;
      app.quit();
    }, 600);
  } catch (err) {
    console.error('Failed to launch update script:', err);
    try {
      const child = spawn(installerPath, ['/S'], {
        detached: true,
        stdio: 'ignore'
      });
      child.unref();
      setTimeout(() => {
        app.isQuitting = true;
        app.quit();
      }, 600);
    } catch (e2) {
      console.error('Direct installer execution failed:', e2);
    }
  }
}
// ─────────────────────────────────────────────────────────────────────────────

let mainWindow;
let promptWindow;
let pendingPromptData = null;
let server;
let tray = null;

// Interception and extensions config
let isInterceptionEnabled = true;
let interceptedExtensions = ['zip', 'rar', '7z', 'exe', 'msi', 'dmg', 'pkg', 'deb', 'sh', 'apk', 'iso', 'bin', 'tar', 'gz', 'bz2', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'mp4', 'mkv', 'avi', 'mov', 'wmv', 'mp3', 'wav', 'flac', 'm4a'];
let startWithWindows = false; // Persisted to config.json; used to reliably track startup state

let extensionVersion = '1.0.8'; // Fallback
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
    try { fs.unlinkSync(startupFlagPath); } catch (e) { }
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
    // Re-check every 30 minutes while app is running
    setInterval(checkForUpdates, 30 * 60 * 1000);
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
      {
        label: 'Open IDM Lite', click: () => {
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
          }
        }
      },
      { type: 'separator' },
      {
        label: 'Intercept Downloads', type: 'checkbox', checked: isInterceptionEnabled, click: (item) => {
          isInterceptionEnabled = item.checked;
          saveConfig();
          if (mainWindow) {
            mainWindow.webContents.send('config-changed', { isInterceptionEnabled, extensions: interceptedExtensions });
          }
        }
      },
      {
        label: 'Start with Windows', type: 'checkbox', checked: startWithWindows, click: (item) => {
          startWithWindows = item.checked;
          app.setLoginItemSettings({
            openAtLogin: item.checked,
            path: app.getPath('exe'),
            args: item.checked ? ['--hidden'] : []
          });
          saveConfig();
        }
      },
      { type: 'separator' },
      {
        label: 'Exit', click: () => {
          app.isQuitting = true;
          app.quit();
        }
      }
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

function openPromptWindow(urlOrData, fileName, cookies, referrer, userAgent) {
  if (promptWindow) {
    try {
      promptWindow.close();
    } catch (e) { }
  }

  const promptData = typeof urlOrData === 'object' && urlOrData !== null
    ? {
      url: urlOrData.url || '',
      pageUrl: urlOrData.pageUrl || '',
      fileName: urlOrData.fileName || '',
      title: urlOrData.title || '',
      cookies: urlOrData.cookies || '',
      cookieList: Array.isArray(urlOrData.cookieList) ? urlOrData.cookieList : [],
      referrer: urlOrData.referrer || '',
      userAgent: urlOrData.userAgent || '',
      isVideo: Boolean(urlOrData.isVideo),
      videoType: urlOrData.videoType || 'auto',
      quality: urlOrData.quality || 'best'
    }
    : {
      url: urlOrData || '',
      pageUrl: '',
      fileName: fileName || '',
      title: '',
      cookies: cookies || '',
      cookieList: [],
      referrer: referrer || '',
      userAgent: userAgent || '',
      isVideo: false,
      videoType: 'auto',
      quality: 'best'
    };

  pendingPromptData = promptData;

  promptWindow = new BrowserWindow({
    width: 590,
    height: promptData.isVideo ? 500 : 440,
    resizable: false,
    maximizable: false,
    title: promptData.isVideo ? 'Download Video - IDM Lite' : 'Start New Download',
    backgroundColor: '#14161f',
    alwaysOnTop: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs')
    }
  });

  const isDev = process.env.NODE_ENV === 'development' || process.argv.includes('--dev');
  const queryStr = `?url=${encodeURIComponent(promptData.url)}&fileName=${encodeURIComponent(promptData.fileName)}&isVideo=${promptData.isVideo ? '1' : '0'}`;

  if (isDev) {
    promptWindow.loadURL(`http://localhost:5173/#prompt${queryStr}`);
  } else {
    promptWindow.loadFile(path.join(__dirname, '../dist/index.html'), { hash: `prompt${queryStr}` });
  }

  // Send full payload to the prompt window when ready
  promptWindow.webContents.on('did-finish-load', () => {
    if (promptWindow && !promptWindow.isDestroyed()) {
      promptWindow.webContents.send('init-prompt', promptData);
    }
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
  } catch (e) { }
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
    } catch (e) { }
  }
  // 2. Fall back to standard filename=
  const filenameMatch = headerValue.match(/filename=["']?([^"';\n]+)["']?/i);
  if (filenameMatch && filenameMatch[1]) {
    let name = filenameMatch[1].replace(/['"]/g, '');
    if (/^[\u0000-\u00FF]+$/.test(name)) {
      try {
        // Node.js HTTP parser decodes headers as Latin1. Re-encode and decode as UTF-8 only if safe.
        const buf = Buffer.from(name, 'latin1');
        const utf8Name = buf.toString('utf8');
        if (utf8Name !== name && !utf8Name.includes('\uFFFD') && !/[\x00-\x1F\x7F]/.test(utf8Name)) {
          name = utf8Name;
        }
      } catch (e) { }
    }
    try {
      return decodeURIComponent(name);
    } catch (e) {
      return name;
    }
  }
  return null;
}

function sanitizeFilename(filename) {
  if (!filename) return 'download_' + Date.now();

  // Convert Latin1 (ISO-8859-1) representation of UTF-8 back to proper UTF-8 ONLY if all characters
  // are within Latin-1 range (0x00-0xFF). This prevents corrupting already-valid Unicode strings (like Vietnamese).
  if (/^[\u0000-\u00FF]+$/.test(filename)) {
    try {
      const buf = Buffer.from(filename, 'latin1');
      const utf8Str = buf.toString('utf8');
      if (utf8Str !== filename && !utf8Str.includes('\uFFFD') && !/[\x00-\x1F\x7F]/.test(utf8Str)) {
        filename = utf8Str;
      }
    } catch (e) { }
  }

  // 1. Decode RFC 2047 MIME words
  let decoded = decodeMimeWords(filename);

  // 2. Decode percent-encoding
  try {
    decoded = decodeURIComponent(decoded);
  } catch (e) { }

  // 3. Remove Windows forbidden characters: \ / : * ? " < > |
  decoded = decoded.replace(/[\\/:*?"<>|]/g, '_');

  // 4. Remove ASCII control characters (0x00 - 0x1F and 0x7F) that cause Windows CreateFileW ENOENT failures
  decoded = decoded.replace(/[\x00-\x1F\x7F]/g, '');

  // 5. Remove multiple spaces/underscores
  decoded = decoded.replace(/\s+/g, ' ').trim();

  // 6. Strip trailing dots and spaces (Windows denies or strips these, causing ENOENT)
  decoded = decoded.replace(/[. ]+$/, '');

  // 7. Check Windows reserved device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
  const ext = path.extname(decoded);
  let base = path.basename(decoded, ext);
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(base)) {
    base = '_' + base;
  }

  // 8. Prevent MAX_PATH issues on Windows by truncating base filename if too long
  if (base.length > 150) {
    base = base.slice(0, 150);
  }

  decoded = (base || 'download_' + Date.now()) + ext;

  return decoded;
}

/**
 * If a file already exists at `folder/name`, returns a unique path like
 * `folder/name (1).ext`, `folder/name (2).ext`, etc.
 */
function resolveUniqueFilePath(folder, name) {
  let targetFolder = folder;
  try {
    if (!fs.existsSync(targetFolder)) {
      fs.mkdirSync(targetFolder, { recursive: true });
    }
  } catch (e) {
    console.error('Failed to create folder in resolveUniqueFilePath, attempting fallback:', e);
    try {
      targetFolder = app.getPath('downloads');
      if (!fs.existsSync(targetFolder)) {
        fs.mkdirSync(targetFolder, { recursive: true });
      }
    } catch (err) { }
  }
  const ext = path.extname(name);           // e.g. ".zip"
  const base = path.basename(name, ext);    // e.g. "setup"
  let candidate = path.join(targetFolder, name);
  let counter = 1;
  try {
    while (fs.existsSync(candidate)) {
      candidate = path.join(targetFolder, `${base} (${counter})${ext}`);
      counter++;
    }
  } catch (e) {
    console.error('Error checking file existence in resolveUniqueFilePath:', e);
  }
  return candidate;
}

function detectCategory(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  const docExtensions = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'epub', 'md'];
  const videoExtensions = ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', '3gp', 'm3u8', 'ts', 'm4v'];
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
      if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => {
          body += chunk.toString();
        });
        req.on('end', () => {
          try {
            const data = JSON.parse(body);
            const isVideo = Boolean(data.isVideo);
            if (!isInterceptionEnabled && !isVideo) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, message: 'Interception is disabled' }));
              return;
            }

            const downloadUrl = data.url || data.pageUrl;
            if (downloadUrl) {
              const quality = data.quality || 'best';
              const defaultExt = quality === 'audio' ? 'm4a' : 'mp4';
              const titleBasedName = data.title ? `${sanitizeFilename(data.title)}.${defaultExt}` : '';
              const fileName =
                data.fileName ||
                titleBasedName ||
                getFilenameFromUrl(downloadUrl) ||
                (isVideo ? `video_${Date.now()}.${defaultExt}` : 'download_file_' + Math.floor(Math.random() * 1000));

              openPromptWindow({
                url: downloadUrl,
                pageUrl: data.pageUrl || '',
                fileName,
                title: data.title || '',
                cookies: data.cookies || '',
                cookieList: Array.isArray(data.cookieList) ? data.cookieList : [],
                referrer: data.referrer || '',
                userAgent: data.userAgent || '',
                isVideo,
                videoType: data.videoType || 'auto',
                quality
              });
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
        if (!isInterceptionEnabled) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Interception is disabled' }));
          return;
        }
        const downloadUrl = parsedUrl.searchParams.get('url');
        if (downloadUrl) {
          let fileName = parsedUrl.searchParams.get('fileName') || getFilenameFromUrl(downloadUrl) || 'download_file_' + Math.floor(Math.random() * 1000);
          const userAgent = parsedUrl.searchParams.get('userAgent') || '';
          openPromptWindow({ url: downloadUrl, fileName, userAgent });
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

function normalizeGoogleDriveUrl(url) {
  if (!url || typeof url !== 'string') return url;
  try {
    const match = url.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/);
    if (match && match[1]) {
      return `https://drive.usercontent.google.com/download?id=${match[1]}&export=download&authuser=0`;
    }
    const matchOpen = url.match(/drive\.google\.com\/open\?id=([a-zA-Z0-9_-]+)/);
    if (matchOpen && matchOpen[1]) {
      return `https://drive.usercontent.google.com/download?id=${matchOpen[1]}&export=download&authuser=0`;
    }
    const matchUc = url.match(/drive\.google\.com\/uc\?(?:.*&)?id=([a-zA-Z0-9_-]+)/);
    if (matchUc && matchUc[1]) {
      return `https://drive.usercontent.google.com/download?id=${matchUc[1]}&export=download&authuser=0`;
    }
  } catch (e) { }
  return url;
}

function handleHtmlDownloadResponse(res, targetUrl, task) {
  let bodyBuffer = '';
  res.on('data', (chunk) => {
    if (bodyBuffer.length < 65536) {
      bodyBuffer += chunk.toString();
    }
  });

  res.on('end', () => {
    // 1. Quota Exceeded on Google Drive
    if (bodyBuffer.includes('Google Drive - Quota exceeded') ||
      bodyBuffer.includes('Too many users have viewed or downloaded this file recently') ||
      bodyBuffer.includes('vượt quá giới hạn')) {
      task.handleError(new Error('Tệp Google Drive đã bị giới hạn tải xuống trong ngày (Quota Exceeded). Google Drive tạm khóa tệp do có quá nhiều lượt tải gần đây. Vui lòng thử lại sau 24h hoặc đăng nhập Google Drive để tạo bản sao (Make a copy) vào Drive cá nhân trước khi tải.'));
      return;
    }

    // 2. Google Drive Virus Scan Warning Form (auto-bypass for large files > 100MB)
    if (bodyBuffer.includes('Google Drive - Virus scan warning') ||
      bodyBuffer.includes('download-form') ||
      bodyBuffer.includes('uc-download-link')) {

      const formActionMatch = bodyBuffer.match(/<form[^>]*action="([^"]+)"[^>]*>/i);
      const action = formActionMatch ? formActionMatch[1] : null;
      const inputRegex = /<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"/gi;
      const params = new URLSearchParams();
      let match;
      while ((match = inputRegex.exec(bodyBuffer)) !== null) {
        params.set(match[1], match[2]);
      }

      // Try extracting real filename from Google Drive warning HTML if available
      const nameMatch = bodyBuffer.match(/<span class="uc-name-size"><a[^>]*>([^<]+)<\/a>/i);
      if (nameMatch && nameMatch[1]) {
        const extractedName = sanitizeFilename(nameMatch[1].trim());
        if (extractedName && (!task.fileName || task.fileName.startsWith('download_file_') || task.fileName === 'download' || !task.fileName.includes('.'))) {
          task.filePath = resolveUniqueFilePath(task.saveFolder, extractedName);
          task.fileName = path.basename(task.filePath);
          task.category = detectCategory(task.fileName);
        }
      }

      // Merge cookies
      const rawCookies = res.headers['set-cookie'];
      if (rawCookies) {
        const newCookieArr = Array.isArray(rawCookies) ? rawCookies : [rawCookies];
        const cookieStr = newCookieArr.map(c => c.split(';')[0]).join('; ');
        task.cookies = task.cookies ? `${task.cookies}; ${cookieStr}` : cookieStr;
      }

      if (action && params.toString()) {
        let resolvedAction = action;
        try {
          resolvedAction = new URL(action, targetUrl).href;
        } catch (e) { }

        const confirmedUrl = resolvedAction.includes('?')
          ? `${resolvedAction}&${params.toString()}`
          : `${resolvedAction}?${params.toString()}`;

        console.log(`[Google Drive] Auto-bypassing virus scan warning: ${confirmedUrl}`);
        task.startSingleConnectionDownload(confirmedUrl);
        return;
      }
    }

    // Default error for unexpected HTML responses
    task.handleError(new Error('Server trả về trang web (HTML) thay vì file tải xuống. Vui lòng kiểm tra lại quyền đăng nhập hoặc liên kết.'));
  });

  res.on('error', (err) => {
    task.handleError(err);
  });
}

// ── Video Engine Helpers (Tier 2 HLS & Tier 3 yt-dlp) ────────────────────────
const VIDEO_PLATFORM_HOSTS = [
  'youtube.com', 'youtu.be', 'tiktok.com', 'facebook.com', 'fb.watch',
  'instagram.com', 'twitter.com', 'x.com', 'vimeo.com', 'bilibili.com',
  'dailymotion.com', 'twitch.tv', 'reddit.com', 'soundcloud.com', 'threads.net', 'douyin.com'
];

function isVideoPlatformUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return false;
  try {
    const parsed = new URL(urlStr);
    const host = parsed.hostname.toLowerCase();
    return VIDEO_PLATFORM_HOSTS.some((d) => host === d || host.endsWith('.' + d));
  } catch {
    return false;
  }
}

let cachedFfmpegPath = undefined;
function findFfmpegPath() {
  if (cachedFfmpegPath !== undefined) return cachedFfmpegPath;
  const binName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const localBin = path.join(app.getPath('userData'), 'bin', binName);
  try {
    if (fs.existsSync(localBin)) {
      cachedFfmpegPath = localBin;
      return cachedFfmpegPath;
    }
  } catch (e) {}

  try {
    const res = spawnSync('ffmpeg', ['-version'], { windowsHide: true, timeout: 4000 });
    if (res && res.status === 0) {
      cachedFfmpegPath = 'ffmpeg';
      return cachedFfmpegPath;
    }
  } catch (e) {}

  cachedFfmpegPath = null;
  return null;
}

function findExistingYtDlpPath() {
  const binName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  const localBin = path.join(app.getPath('userData'), 'bin', binName);
  try {
    if (fs.existsSync(localBin) && fs.statSync(localBin).size > 1024 * 1024) {
      return localBin;
    }
  } catch (e) {}

  try {
    const res = spawnSync('yt-dlp', ['--version'], { windowsHide: true, timeout: 4000 });
    if (res && res.status === 0) {
      return 'yt-dlp';
    }
  } catch (e) {}

  return null;
}

let ytDlpInstallPromise = null;
function ensureYtDlpBinary(onProgressNote) {
  const existing = findExistingYtDlpPath();
  if (existing) return Promise.resolve(existing);

  if (ytDlpInstallPromise) {
    return ytDlpInstallPromise;
  }

  const binDir = path.join(app.getPath('userData'), 'bin');
  const binName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  const destPath = path.join(binDir, binName);
  const tempPath = destPath + '.part';
  const downloadUrl = process.platform === 'win32'
    ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
    : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';

  ytDlpInstallPromise = new Promise((resolve, reject) => {
    try {
      if (!fs.existsSync(binDir)) {
        fs.mkdirSync(binDir, { recursive: true });
      }
    } catch (err) {
      ytDlpInstallPromise = null;
      return reject(err);
    }

    const follow = (curUrl, redirects = 0) => {
      if (redirects > 8) {
        ytDlpInstallPromise = null;
        return reject(new Error('Chuyển hướng quá nhiều lần khi tải công cụ yt-dlp.'));
      }
      let parsed;
      try {
        parsed = new URL(curUrl);
      } catch (err) {
        ytDlpInstallPromise = null;
        return reject(err);
      }
      const client = parsed.protocol === 'https:' ? https : http;
      const req = client.get(curUrl, { headers: { 'User-Agent': DEFAULT_USER_AGENT } }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          let nextUrl = res.headers.location;
          try {
            nextUrl = new URL(nextUrl, curUrl).href;
          } catch (e) {}
          res.resume();
          return follow(nextUrl, redirects + 1);
        }

        if (res.statusCode !== 200) {
          ytDlpInstallPromise = null;
          return reject(new Error(`Không thể tải công cụ video (HTTP ${res.statusCode})`));
        }

        const total = parseInt(res.headers['content-length'] || '0', 10);
        let transferred = 0;
        const out = fs.createWriteStream(tempPath);

        res.on('data', (chunk) => {
          transferred += chunk.length;
          if (onProgressNote && total > 0) {
            const pct = Math.min(99, Math.round((transferred / total) * 100));
            onProgressNote(`Đang khởi tạo công cụ video (${pct}%)...`);
          }
        });

        res.pipe(out);

        out.on('finish', () => {
          out.close(() => {
            try {
              if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
              fs.renameSync(tempPath, destPath);
              if (process.platform !== 'win32') {
                fs.chmodSync(destPath, 0o755);
              }
              ytDlpInstallPromise = null;
              resolve(destPath);
            } catch (err) {
              ytDlpInstallPromise = null;
              reject(err);
            }
          });
        });

        out.on('error', (err) => {
          ytDlpInstallPromise = null;
          try { fs.unlinkSync(tempPath); } catch (e) {}
          reject(err);
        });
      });

      req.on('error', (err) => {
        ytDlpInstallPromise = null;
        try { fs.unlinkSync(tempPath); } catch (e) {}
        reject(err);
      });
    };

    follow(downloadUrl);
  });

  return ytDlpInstallPromise;
}

function writeNetscapeCookiesFile(cookieFilePath, cookieList, cookieStr, targetUrl) {
  const lines = ['# Netscape HTTP Cookie File', '# Generated by IDM Lite', ''];
  let count = 0;

  if (Array.isArray(cookieList) && cookieList.length > 0) {
    for (const c of cookieList) {
      if (!c || !c.name || !c.domain) continue;
      const name = String(c.name).replace(/[\r\n\t]/g, '');
      const val = String(c.value || '').replace(/[\r\n\t]/g, '');
      let domain = String(c.domain).trim();
      if (!domain.startsWith('.') && !c.hostOnly) {
        domain = '.' + domain;
      }
      const includeSubdomains = domain.startsWith('.') ? 'TRUE' : 'FALSE';
      const cookiePath = String(c.path || '/').replace(/[\r\n\t]/g, '');
      const secure = c.secure ? 'TRUE' : 'FALSE';
      const expiry = c.expirationDate ? Math.floor(Number(c.expirationDate)) : Math.floor(Date.now() / 1000 + 86400 * 30);
      lines.push(`${domain}\t${includeSubdomains}\t${cookiePath}\t${secure}\t${expiry}\t${name}\t${val}`);
      count++;
    }
  } else if (cookieStr && typeof cookieStr === 'string' && targetUrl) {
    try {
      const host = new URL(targetUrl).hostname;
      const baseDomain = host.startsWith('www.') ? '.' + host.slice(4) : '.' + host;
      const expiry = Math.floor(Date.now() / 1000 + 86400 * 30);
      const pairs = cookieStr.split(';');
      for (const pair of pairs) {
        const eqIdx = pair.indexOf('=');
        if (eqIdx <= 0) continue;
        const name = pair.slice(0, eqIdx).trim().replace(/[\r\n\t]/g, '');
        const val = pair.slice(eqIdx + 1).trim().replace(/[\r\n\t]/g, '');
        if (!name) continue;
        lines.push(`${baseDomain}\tTRUE\t/\tTRUE\t${expiry}\t${name}\t${val}`);
        count++;
      }
    } catch (e) {}
  }

  if (count === 0) return false;
  try {
    fs.writeFileSync(cookieFilePath, lines.join('\n') + '\n', 'utf8');
    return true;
  } catch (e) {
    return false;
  }
}

function stripDisguisedTsHeader(buf) {
  if (!buf || buf.length < 4) return buf;
  if (buf[0] === 0x47) return buf;

  // Preserve ISO BMFF / fMP4 boxes untouched
  if (buf.length >= 8) {
    const box = buf.toString('ascii', 4, 8);
    if (['ftyp', 'styp', 'moof', 'sidx', 'mdat', 'free', 'moov'].includes(box)) {
      return buf;
    }
  }

  const maxScan = Math.min(buf.length - 377, 4096);
  for (let i = 0; i <= maxScan; i++) {
    if (buf[i] === 0x47 && buf[i + 188] === 0x47 && buf[i + 376] === 0x47) {
      return buf.subarray(i);
    }
  }

  const maxShortScan = Math.min(buf.length - 189, 4096);
  for (let i = 0; i <= maxShortScan; i++) {
    if (buf[i] === 0x47 && buf[i + 188] === 0x47) {
      return buf.subarray(i);
    }
  }

  return buf;
}

function fetchHtmlText(targetUrl, cookies, referrer, userAgent, redirectCount = 0) {
  if (redirectCount > 6) return Promise.reject(new Error('Too many redirects'));
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch (e) {
      return reject(e);
    }
    const isHttps = parsed.protocol === 'https:';
    const client = isHttps ? https : http;
    const agent = isHttps ? httpsAgent : httpAgent;
    const headers = buildStandardHeaders({ cookies, referrer, userAgent });
    delete headers['Range'];

    const req = client.get(targetUrl, { agent, headers }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        let nextUrl = res.headers.location;
        try {
          nextUrl = new URL(nextUrl, targetUrl).href;
        } catch (e) {}
        res.resume();
        fetchHtmlText(nextUrl, cookies, referrer, userAgent, redirectCount + 1).then(resolve, reject);
        return;
      }
      if (res.statusCode >= 400) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let html = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        if (html.length < 1024 * 1024) html += chunk;
      });
      res.on('end', () => resolve({ html, finalUrl: targetUrl }));
      res.on('error', reject);
    });
    req.setTimeout(12000, () => req.destroy(new Error('HTML fetch timeout')));
    req.on('error', reject);
  });
}

async function extractStaticStreamFromHtml(pageUrl, cookies, referrer, userAgent) {
  try {
    const { html, finalUrl } = await fetchHtmlText(pageUrl, cookies, referrer || pageUrl, userAgent);
    if (!html) return null;

    const normalizedHtml = html.replace(/\\\//g, '/');

    // 1. Check active episode attributes (e.g. data-sv-ep / data-episode on movie sites)
    let sv = '';
    let ep = '';
    const bodySvMatch = normalizedHtml.match(/<body[^>]*\bdata-(?:sv-ep|server)=["']([^"']+)["']/i);
    const bodyEpMatch = normalizedHtml.match(/<body[^>]*\bdata-episode=["']([^"']+)["']/i);
    if (bodySvMatch && bodyEpMatch) {
      sv = bodySvMatch[1];
      ep = bodyEpMatch[1];
    } else {
      const urlEpMatch = finalUrl.match(/\/(\d+)-(\d+)\.html(?:\?|$|#)/i);
      if (urlEpMatch) {
        sv = urlEpMatch[1];
        ep = urlEpMatch[2];
      }
    }

    if (sv && ep) {
      const epId = `episode_${sv}-${ep}`;
      const epIdx = normalizedHtml.indexOf(epId);
      if (epIdx !== -1) {
        const snippet = normalizedHtml.slice(Math.max(0, epIdx - 250), epIdx + 600);
        const linkMatch = snippet.match(/\bdata-link=["'](https?:\/\/[^"']+)["']/i);
        if (linkMatch && linkMatch[1]) {
          const found = linkMatch[1].replace(/&amp;/g, '&');
          return { url: found, videoType: /\.m3u8/i.test(found) ? 'hls' : 'direct' };
        }
      }
    }

    // 2. Active episode button fallback
    const activeBtnMatch = normalizedHtml.match(/class=["'][^"']*btn-episode[^"']*active[^"']*["'][^>]*\bdata-link=["'](https?:\/\/[^"']+)["']/i)
      || normalizedHtml.match(/\bdata-link=["'](https?:\/\/[^"']+)["'][^>]*class=["'][^"']*btn-episode[^"']*active/i);
    if (activeBtnMatch && activeBtnMatch[1]) {
      const found = activeBtnMatch[1].replace(/&amp;/g, '&');
      return { url: found, videoType: /\.m3u8/i.test(found) ? 'hls' : 'direct' };
    }

    // 3. Direct m3u8 URLs embedded in HTML/player scripts
    const m3u8Match = normalizedHtml.match(/https?:\/\/[^\s"'<>\\]+\.m3u8(?:\?[^\s"'<>\\]*)?/i);
    if (m3u8Match && m3u8Match[0]) {
      return { url: m3u8Match[0].replace(/&amp;/g, '&'), videoType: 'hls' };
    }

    // 4. Direct <video>/<source> MP4 URLs
    const mp4Match = normalizedHtml.match(/https?:\/\/[^\s"'<>\\]+\.(?:mp4|webm|m4v)(?:\?[^\s"'<>\\]*)?/i);
    if (mp4Match && mp4Match[0]) {
      return { url: mp4Match[0].replace(/&amp;/g, '&'), videoType: 'direct' };
    }
  } catch (e) {
    console.warn('[Webpage Extractor] Static HTML scan failed:', e.message);
  }
  return null;
}

async function sniffStreamWithHiddenBrowser(pageUrl, cookieList, userAgent) {
  const partitionName = `temp-sniffer-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const snifferSession = session.fromPartition(partitionName, { cache: false });

  if (Array.isArray(cookieList) && cookieList.length > 0) {
    for (const c of cookieList.slice(0, 60)) {
      if (!c || !c.name || !c.domain) continue;
      try {
        const cleanDomain = String(c.domain).replace(/^\./, '');
        const scheme = c.secure ? 'https' : 'http';
        await snifferSession.cookies.set({
          url: `${scheme}://${cleanDomain}${c.path || '/'}`,
          name: c.name,
          value: c.value || '',
          domain: c.hostOnly ? undefined : c.domain,
          path: c.path || '/',
          secure: Boolean(c.secure),
          expirationDate: c.expirationDate || undefined
        });
      } catch (e) {}
    }
  }

  return new Promise((resolve) => {
    let win = null;
    let settled = false;
    let bestDirect = null;
    let timeoutId = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      try {
        snifferSession.webRequest.onBeforeRequest(null);
        snifferSession.webRequest.onHeadersReceived(null);
      } catch (e) {}
      if (win && !win.isDestroyed()) {
        try { win.destroy(); } catch (e) {}
      }
      resolve(result);
    };

    snifferSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      const u = details.url || '';
      if (u.startsWith('http') && /\.m3u8(\?|$|#)/i.test(u)) {
        finish({ url: u, videoType: 'hls' });
      } else if (u.startsWith('http') && /\.(mp4|webm|m4v)(\?|$|#)/i.test(u) && !/segment|chunk|frag|bytestart=/i.test(u)) {
        bestDirect = bestDirect || { url: u, videoType: 'direct' };
      }
      callback({});
    });

    snifferSession.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (details, callback) => {
      const u = details.url || '';
      const headers = details.responseHeaders || {};
      const ctKey = Object.keys(headers).find((k) => k.toLowerCase() === 'content-type');
      const ct = ctKey ? String(headers[ctKey][0] || '').toLowerCase() : '';
      if (u.startsWith('http') && ct.includes('mpegurl')) {
        finish({ url: u, videoType: 'hls' });
      } else if (u.startsWith('http') && (ct.startsWith('video/mp4') || ct.startsWith('video/webm'))) {
        const clKey = Object.keys(headers).find((k) => k.toLowerCase() === 'content-length');
        const len = clKey ? parseInt(headers[clKey][0] || '0', 10) : 0;
        if (len === 0 || len >= 150 * 1024) {
          bestDirect = bestDirect || { url: u, videoType: 'direct' };
        }
      }
      callback({});
    });

    timeoutId = setTimeout(() => {
      finish(bestDirect);
    }, 12000);

    try {
      win = new BrowserWindow({
        show: false,
        width: 1280,
        height: 720,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          session: snifferSession
        }
      });
      win.webContents.audioMuted = true;
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.on('closed', () => finish(bestDirect));
      win.loadURL(pageUrl, { userAgent: userAgent || DEFAULT_USER_AGENT }).catch(() => finish(bestDirect));
    } catch (e) {
      finish(bestDirect);
    }
  });
}

async function extractStreamFromWebpage(pageUrl, cookies, referrer, userAgent, cookieList) {
  const staticFound = await extractStaticStreamFromHtml(pageUrl, cookies, referrer, userAgent);
  if (staticFound) return staticFound;
  return sniffStreamWithHiddenBrowser(pageUrl, cookieList, userAgent);
}

// Download Manager state
const activeDownloads = {};

class DownloadTask {
  constructor(id, url, saveFolder, fileName, cookies, referrer, userAgent, options = {}) {
    this.id = id;
    this.url = normalizeGoogleDriveUrl(url);
    this.pageUrl = options.pageUrl || '';
    this.cookieList = Array.isArray(options.cookieList) ? options.cookieList : [];
    this.isVideo = Boolean(options.isVideo);
    this.videoType = options.videoType || 'auto';
    this.quality = options.quality || 'best';
    this.saveFolder = saveFolder;
    // Resolve a unique file path up-front so we never overwrite an existing file
    const safeFileName = sanitizeFilename(fileName);
    this.filePath = resolveUniqueFilePath(saveFolder, safeFileName);
    this.fileName = path.basename(this.filePath);
    this.cookies = cookies || '';
    this.referrer = referrer || this.pageUrl || '';
    this.userAgent = userAgent || DEFAULT_USER_AGENT;

    this.downloaded = 0;
    this.total = 0;
    this.status = 'downloading';
    this.statusNote = '';
    this.speed = 0;

    this.request = null;
    this.childProcess = null;
    this.hlsAborted = false;
    this.triedWebpageFallback = false;
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
    try {
      if (!fs.existsSync(this.saveFolder)) {
        fs.mkdirSync(this.saveFolder, { recursive: true });
      }
    } catch (err) {
      console.warn(`Save directory ${this.saveFolder} is inaccessible. Falling back to system Downloads folder.`);
      try {
        const fallbackFolder = app.getPath('downloads');
        if (!fs.existsSync(fallbackFolder)) {
          fs.mkdirSync(fallbackFolder, { recursive: true });
        }
        this.saveFolder = fallbackFolder;
        this.filePath = resolveUniqueFilePath(this.saveFolder, this.fileName);
        this.fileName = path.basename(this.filePath);
      } catch (fallbackErr) {
        this.handleError(err);
        return;
      }
    }

    this.status = 'downloading';
    this.statusNote = '';
    this.hlsAborted = false;
    this.triedWebpageFallback = false;
    this.lastBytes = 0;
    this.startSpeedTracker();

    // Tier 3: Platform / MSE blob / DASH / explicit yt-dlp extraction
    if (
      this.videoType === 'ytdlp' ||
      this.videoType === 'dash' ||
      (this.url && this.url.startsWith('blob:')) ||
      isVideoPlatformUrl(this.url)
    ) {
      const targetPageUrl = (this.url && this.url.startsWith('blob:'))
        ? (this.pageUrl || this.referrer)
        : (isVideoPlatformUrl(this.url) ? this.url : (this.url || this.pageUrl));
      if (!targetPageUrl || !targetPageUrl.startsWith('http')) {
        this.handleError(new Error('Không xác định được địa chỉ trang gốc của video (blob URL).'));
        return;
      }
      this.startYtDlpDownload(targetPageUrl);
      return;
    }

    // Tier 2: Native 8-thread HLS (.m3u8) stream downloader
    if (this.videoType === 'hls' || /\.m3u8(\?|$|#)/i.test(this.url)) {
      this.startHlsDownload(this.url);
      return;
    }

    // Check if the URL contains tokens/auth keys or belongs to portals that use one-time links
    const isSensitiveUrl = this.url.includes('token=') ||
      this.url.includes('auth=') ||
      this.url.includes('signature=') ||
      this.url.includes('sig=') ||
      this.url.includes('Signature=') ||
      this.url.includes('tempauth=') ||
      this.url.includes('Key-Pair-Id=') ||
      this.url.includes('download_token=') ||
      this.url.includes('access_token=') ||
      this.url.includes('g-portal') ||
      this.url.includes('gmail') ||
      this.url.includes('drive.google') ||
      this.url.includes('drive.usercontent.google') ||
      this.url.includes('onedrive.live.com') ||
      this.url.includes('my.microsoftpersonalcontent.com') ||
      this.url.includes('sharepoint.com') ||
      this.url.includes('mediafire.com') ||
      this.url.includes('fshare.vn') ||
      this.url.includes('pixeldrain.com');

    if (isSensitiveUrl) {
      console.log(`Sensitive URL detected (one-time token or auth gateway). Bypassing range probe to download directly using single-connection stream.`);
      this.startSingleConnectionDownload(this.url);
    } else {
      this.getHeadersAndStart(this.url);
    }
  }

  startDirectSingleConnectionDownload(targetUrl) {
    // Backward-compatibility alias
    this.startSingleConnectionDownload(targetUrl);
  }

  getHeadersAndStart(targetUrl) {
    try {
      const parsedUrl = new URL(targetUrl);
      const isHttps = parsedUrl.protocol === 'https:';
      const client = isHttps ? https : http;
      const agent = isHttps ? httpsAgent : httpAgent;

      const options = {
        method: 'GET',
        agent: agent,
        headers: buildStandardHeaders({
          range: 'bytes=0-0',
          cookies: this.cookies,
          referrer: this.referrer,
          userAgent: this.userAgent
        })
      };

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
              this.filePath = resolveUniqueFilePath(this.saveFolder, safeRedirectName);
              this.fileName = path.basename(this.filePath);
              this.category = detectCategory(this.fileName);
            }
            this.getHeadersAndStart(redirectUrl);
            return;
          }
        }

        // Check HTTP status code FIRST before inspecting HTML content
        if (res.statusCode >= 400 && res.statusCode !== 416) {
          req.destroy();
          this.handleError(new Error(`Server trả về mã lỗi HTTP: ${res.statusCode} (${res.statusMessage || 'Lỗi kết nối'})`));
          return;
        }

        this.url = targetUrl; // Save resolved URL

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

        const contentType = (res.headers['content-type'] || '').toLowerCase();
        if (contentType.includes('mpegurl') || /\.m3u8(\?|$|#)/i.test(targetUrl)) {
          req.destroy();
          this.startHlsDownload(targetUrl);
          return;
        }
        if (contentType.includes('dash+xml') || /\.mpd(\?|$|#)/i.test(targetUrl)) {
          req.destroy();
          this.startYtDlpDownload(this.pageUrl || targetUrl);
          return;
        }

        const isHtmlResponse = contentType.includes('text/html') || contentType.includes('application/xhtml+xml');
        const ext = this.fileName.split('.').pop().toLowerCase();
        const nonHtmlExtensions = ['zip', 'rar', '7z', 'tar', 'gz', 'exe', 'msi', 'dmg', 'pkg', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'mp4', 'mkv', 'mp3', 'bin', 'dll', 'iso'];
        const isGoogleDrive = targetUrl.includes('drive.google') || targetUrl.includes('drive.usercontent.google');

        if (isHtmlResponse && !isGoogleDrive && !this.triedWebpageFallback && (this.isVideo || this.pageUrl || isVideoPlatformUrl(targetUrl))) {
          req.destroy();
          this.startYtDlpDownload(this.pageUrl || targetUrl);
          return;
        }

        if (isHtmlResponse && (nonHtmlExtensions.includes(ext) || isGoogleDrive)) {
          handleHtmlDownloadResponse(res, targetUrl, this);
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
          if (res.statusCode === 200) {
            totalSize = contentLength ? parseInt(contentLength, 10) : 0;
          }
        }

        this.total = totalSize;
        req.destroy(); // Disconnect range verification request

        if (this.acceptsRanges && totalSize > 1024 * 1024) {
          console.log(`Server supports Range requests. Initiating multi-connection download for file of size ${totalSize} bytes.`);
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

      // If the file already exists (i.e. a paused resume), pick up from the already-downloaded bytes
      let localDownloaded = 0;
      if (fs.existsSync(this.filePath)) {
        localDownloaded = fs.statSync(this.filePath).size;
      }
      this.downloaded = localDownloaded;

      const headers = buildStandardHeaders({
        range: localDownloaded > 0 ? `bytes=${localDownloaded}-` : undefined,
        cookies: this.cookies,
        referrer: this.referrer,
        userAgent: this.userAgent
      });

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
            console.log(`Redirecting single connection download to: ${redirectUrl}`);
            const nameFromRedirect = getFilenameFromUrl(redirectUrl);
            if (nameFromRedirect && localDownloaded === 0) {
              const safeRedirectName = sanitizeFilename(nameFromRedirect);
              this.filePath = resolveUniqueFilePath(this.saveFolder, safeRedirectName);
              this.fileName = path.basename(this.filePath);
              this.category = detectCategory(this.fileName);
            }
            this.startSingleConnectionDownload(redirectUrl);
            return;
          }
        }

        if (res.statusCode >= 400 && res.statusCode !== 416) {
          this.handleError(new Error(`Server trả về mã lỗi HTTP: ${res.statusCode} (${res.statusMessage || 'Lỗi tải'})`));
          return;
        }

        const contentType = (res.headers['content-type'] || '').toLowerCase();
        if (contentType.includes('mpegurl') || /\.m3u8(\?|$|#)/i.test(targetUrl)) {
          res.destroy();
          this.startHlsDownload(targetUrl);
          return;
        }
        if (contentType.includes('dash+xml') || /\.mpd(\?|$|#)/i.test(targetUrl)) {
          res.destroy();
          this.startYtDlpDownload(this.pageUrl || targetUrl);
          return;
        }

        const isHtmlResponse = contentType.includes('text/html') || contentType.includes('application/xhtml+xml');
        const ext = this.fileName.split('.').pop().toLowerCase();
        const nonHtmlExtensions = ['zip', 'rar', '7z', 'tar', 'gz', 'exe', 'msi', 'dmg', 'pkg', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'mp4', 'mkv', 'mp3', 'bin', 'dll', 'iso'];
        const isGoogleDrive = targetUrl.includes('drive.google') || targetUrl.includes('drive.usercontent.google');

        if (isHtmlResponse && !isGoogleDrive && !this.triedWebpageFallback && (this.isVideo || this.pageUrl || isVideoPlatformUrl(targetUrl))) {
          res.destroy();
          this.startYtDlpDownload(this.pageUrl || targetUrl);
          return;
        }

        if (isHtmlResponse && (nonHtmlExtensions.includes(ext) || isGoogleDrive)) {
          handleHtmlDownloadResponse(res, targetUrl, this);
          return;
        }

        this.url = targetUrl; // Save resolved URL

        // Update file name from Content-Disposition if present and not yet downloaded
        if (localDownloaded === 0) {
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
        }

        // Parse total file size correctly
        const contentRange = res.headers['content-range'];
        let totalSize = 0;
        if (contentRange) {
          const match = contentRange.match(/\/(\d+)$/);
          if (match) totalSize = parseInt(match[1], 10);
        }
        if (!totalSize) {
          const contentLength = res.headers['content-length'];
          if (contentLength) {
            totalSize = (res.statusCode === 206 && localDownloaded > 0)
              ? localDownloaded + parseInt(contentLength, 10)
              : parseInt(contentLength, 10);
          }
        }
        if (totalSize > 0) {
          this.total = totalSize;
        }

        // If server sent 200 OK instead of 206 Partial Content when we requested a Range resume,
        // it means the server restarted the stream from byte 0. Reset downloaded count.
        const isAppended = localDownloaded > 0 && res.statusCode === 206;
        if (localDownloaded > 0 && res.statusCode === 200) {
          this.downloaded = 0;
          localDownloaded = 0;
        }

        this.fileStream = fs.createWriteStream(this.filePath, {
          flags: isAppended ? 'a' : 'w',
          highWaterMark: 1024 * 1024 // 1MB buffer size for fast writing
        });

        this.fileStream.on('error', (err) => {
          this.handleError(err);
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
              // Verify if file ended prematurely
              if (this.total > 0 && this.downloaded < this.total && this.status === 'downloading') {
                console.warn(`Single-stream connection closed prematurely (${this.downloaded}/${this.total} bytes). Reconnecting to resume...`);
                this.fileStream = null;
                setTimeout(() => {
                  if (this.status === 'downloading') {
                    this.startSingleConnectionDownload(targetUrl);
                  }
                }, 1000);
                return;
              }
              this.complete();
            });
          } else {
            this.complete();
          }
        });

        res.on('error', (err) => {
          if (this.fileStream) {
            try { this.fileStream.end(); } catch (e) { }
            this.fileStream = null;
          }
          if (['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(err.code) && this.status === 'downloading') {
            console.warn(`Single-stream connection error (${err.code}). Reconnecting in 1.5s...`);
            setTimeout(() => {
              if (this.status === 'downloading') {
                this.startSingleConnectionDownload(targetUrl);
              }
            }, 1500);
            return;
          }
          this.handleError(err);
        });
      });

      this.request.on('socket', (socket) => {
        socket.setNoDelay(true);
        socket.setKeepAlive(true, 10000);
      });

      this.request.on('error', (err) => {
        if (['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(err.code) && this.status === 'downloading') {
          console.warn(`Single-stream socket error (${err.code}). Reconnecting in 1.5s...`);
          setTimeout(() => {
            if (this.status === 'downloading') {
              this.startSingleConnectionDownload(targetUrl);
            }
          }, 1500);
          return;
        }
        this.handleError(err);
      });

    } catch (err) {
      this.handleError(err);
    }
  }

  startMultiConnectionDownload(targetUrl, totalSize) {
    try {
      // Standard IDM-grade thread count: 4 threads for small files, max 8 threads for larger files.
      // 8 threads maximizes throughput without triggering CDN socket drops / rate limits.
      let numConnections = 8;
      if (totalSize <= 30 * 1024 * 1024) {
        numConnections = 4;
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
          completed: segDownloaded >= (endPos - startPos + 1),
          retryCount: 0
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
      if (this.status !== 'downloading') return;

      const parsedUrl = new URL(targetUrl);
      const isHttps = parsedUrl.protocol === 'https:';
      const client = isHttps ? https : http;
      const agent = isHttps ? httpsAgent : httpAgent;

      // Read actual written bytes from disk
      if (fs.existsSync(seg.tempPath)) {
        seg.downloaded = fs.statSync(seg.tempPath).size;
      }

      const start = seg.startPos + seg.downloaded;
      const end = seg.endPos;

      if (start > end) {
        seg.completed = true;
        callback();
        return;
      }

      const MAX_SEGMENT_RETRIES = 5;

      const triggerRetry = (err) => {
        if (this.status !== 'downloading') return;

        seg.retryCount = (seg.retryCount || 0) + 1;
        if (seg.retryCount <= MAX_SEGMENT_RETRIES) {
          const delay = Math.min(800 * Math.pow(1.5, seg.retryCount - 1), 5000);
          console.warn(`[Segment ${seg.index}] Reconnecting (${seg.retryCount}/${MAX_SEGMENT_RETRIES}) in ${Math.round(delay)}ms due to: ${err ? (err.message || err) : 'network drop'}`);
          setTimeout(() => {
            if (this.status === 'downloading') {
              this.downloadSegment(targetUrl, seg, callback);
            }
          }, delay);
        } else {
          console.error(`[Segment ${seg.index}] Failed permanently after ${MAX_SEGMENT_RETRIES} retries.`);
          this.handleError(new Error(`Segment ${seg.index} mất kết nối liên tục: ${err ? (err.message || err) : 'Lỗi đường truyền'}`));
        }
      };

      const options = {
        agent: agent,
        headers: buildStandardHeaders({
          range: `bytes=${start}-${end}`,
          cookies: this.cookies,
          referrer: this.referrer,
          userAgent: this.userAgent
        })
      };

      const req = client.get(targetUrl, options, (res) => {
        // Handle redirect in segment
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          let redirectUrl = res.headers.location;
          if (redirectUrl) {
            try {
              redirectUrl = new URL(redirectUrl, targetUrl).href;
            } catch (e) { }
            this.downloadSegment(redirectUrl, seg, callback);
            return;
          }
        }

        // CRITICAL: If server sends 200 OK for a sub-range (seg.startPos > 0), the server ignores Range
        // headers and sends the full file! Fallback immediately to single connection to avoid file corruption.
        if (res.statusCode === 200 && seg.startPos > 0) {
          console.warn(`[Segment ${seg.index}] Server returned 200 OK instead of 206 Partial Content. Range requests are not supported. Falling back to single-connection stream.`);
          this.cleanup();
          this.startSingleConnectionDownload(targetUrl);
          return;
        }

        if (res.statusCode !== 206 && res.statusCode !== 200) {
          triggerRetry(new Error(`Server returned status code: ${res.statusCode}`));
          return;
        }

        const stream = fs.createWriteStream(seg.tempPath, {
          flags: seg.downloaded > 0 ? 'a' : 'w',
          highWaterMark: 1024 * 1024 // 1MB buffer
        });

        stream.on('error', (err) => {
          this.segmentStreams = this.segmentStreams.filter(s => s !== stream);
          triggerRetry(err);
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
          stream.end(() => {
            // Verify actual bytes on disk
            let actualBytes = 0;
            if (fs.existsSync(seg.tempPath)) {
              actualBytes = fs.statSync(seg.tempPath).size;
            }
            const expectedBytes = seg.endPos - seg.startPos + 1;
            if (actualBytes >= expectedBytes) {
              seg.downloaded = expectedBytes;
              seg.completed = true;
              callback();
            } else {
              // Premature stream close (server closed early before sending all bytes)
              console.warn(`[Segment ${seg.index}] Stream ended early: ${actualBytes}/${expectedBytes} bytes. Triggering retry.`);
              triggerRetry(new Error(`Stream ended early (${actualBytes}/${expectedBytes} bytes)`));
            }
          });
        });

        res.on('error', (err) => {
          this.segmentStreams = this.segmentStreams.filter(s => s !== stream);
          try { stream.end(); } catch (e) { }
          triggerRetry(err);
        });
      });

      req.on('socket', (socket) => {
        socket.setNoDelay(true);
        socket.setKeepAlive(true, 10000);
      });

      req.on('error', (err) => {
        triggerRetry(err);
      });

      this.segmentRequests.push(req);
    } catch (err) {
      this.handleError(err);
    }
  }

  async mergeSegments() {
    this.status = 'merging';
    this.sendProgress(true);

    let attempts = 0;
    const maxAttempts = 5;
    let writeSuccess = false;

    while (attempts < maxAttempts && !writeSuccess) {
      attempts++;
      try {
        const writeStream = fs.createWriteStream(this.filePath);
        await new Promise((resolve, reject) => {
          writeStream.on('error', reject);
          (async () => {
            for (const seg of this.segments) {
              if (!fs.existsSync(seg.tempPath)) continue;
              await new Promise((resChunk, rejChunk) => {
                const readStream = fs.createReadStream(seg.tempPath, { highWaterMark: 4 * 1024 * 1024 });
                readStream.on('data', (chunk) => {
                  const canContinue = writeStream.write(chunk);
                  if (!canContinue) {
                    readStream.pause();
                    writeStream.once('drain', () => readStream.resume());
                  }
                });
                readStream.on('end', resChunk);
                readStream.on('error', rejChunk);
              });
            }
            writeStream.end(() => resolve());
          })().catch(reject);
        });
        writeSuccess = true;
      } catch (err) {
        if ((err.code === 'EBUSY' || err.code === 'EPERM') && attempts < maxAttempts) {
          console.warn(`[Merge] Target file locked by antivirus/system (${err.code}). Retrying in 350ms (attempt ${attempts}/${maxAttempts})...`);
          await new Promise(r => setTimeout(r, 350));
          continue;
        }
        this.handleError(err);
        return;
      }
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

  async fetchBuffer(targetUrl, extraHeaders = {}, redirectCount = 0) {
    if (this.hlsAborted || this.status !== 'downloading') {
      throw new Error('Download aborted');
    }
    if (redirectCount > 8) {
      throw new Error('Chuyển hướng quá nhiều lần khi tải luồng HLS.');
    }

    return new Promise((resolve, reject) => {
      let parsed;
      try {
        parsed = new URL(targetUrl);
      } catch (e) {
        return reject(e);
      }

      const isHttps = parsed.protocol === 'https:';
      const client = isHttps ? https : http;
      const agent = isHttps ? httpsAgent : httpAgent;

      const headers = buildStandardHeaders({
        range: extraHeaders.range,
        cookies: this.cookies,
        referrer: this.referrer || this.pageUrl,
        userAgent: this.userAgent
      });
      if (!extraHeaders.range) {
        delete headers['Range'];
      }

      const req = client.get(targetUrl, { agent, headers }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          this.segmentRequests = this.segmentRequests.filter((r) => r !== req);
          let nextUrl = res.headers.location;
          try {
            nextUrl = new URL(nextUrl, targetUrl).href;
          } catch (e) {}
          res.resume();
          this.fetchBuffer(nextUrl, extraHeaders, redirectCount + 1).then(resolve, reject);
          return;
        }

        if (res.statusCode >= 400) {
          this.segmentRequests = this.segmentRequests.filter((r) => r !== req);
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }

        const chunks = [];
        res.on('data', (chunk) => {
          if (this.hlsAborted || this.status !== 'downloading') {
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          this.segmentRequests = this.segmentRequests.filter((r) => r !== req);
          if (this.hlsAborted || this.status !== 'downloading') {
            return reject(new Error('Download aborted'));
          }
          resolve({
            buffer: Buffer.concat(chunks),
            finalUrl: targetUrl,
            contentType: (res.headers['content-type'] || '').toLowerCase()
          });
        });
        res.on('error', (err) => {
          this.segmentRequests = this.segmentRequests.filter((r) => r !== req);
          reject(err);
        });
      });

      this.segmentRequests.push(req);
      req.setTimeout(25000, () => {
        req.destroy(new Error('HLS request timeout'));
      });
      req.on('error', (err) => {
        this.segmentRequests = this.segmentRequests.filter((r) => r !== req);
        reject(err);
      });
    });
  }

  parseM3u8Attributes(attrStr) {
    const attrs = {};
    const regex = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/gi;
    let match;
    while ((match = regex.exec(attrStr)) !== null) {
      attrs[match[1].toUpperCase()] = match[3] !== undefined ? match[3] : match[2];
    }
    return attrs;
  }

  async startHlsDownload(playlistUrl) {
    try {
      this.statusNote = 'Đang phân tích danh sách phát HLS...';
      this.sendProgress(true);

      const initialRes = await this.fetchBuffer(playlistUrl);
      let mediaPlaylistUrl = initialRes.finalUrl;
      let playlistText = initialRes.buffer.toString('utf8');

      if (!playlistText.includes('#EXTM3U')) {
        if (this.pageUrl && this.pageUrl.startsWith('http')) {
          this.startYtDlpDownload(this.pageUrl);
          return;
        }
        throw new Error('Dữ liệu nhận được không phải danh sách phát HLS hợp lệ.');
      }

      // If Master Playlist, choose stream variant matching requested quality
      if (playlistText.includes('#EXT-X-STREAM-INF')) {
        const lines = playlistText.split(/\r?\n/);
        const variants = [];
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (line.startsWith('#EXT-X-STREAM-INF:')) {
            const attrs = this.parseM3u8Attributes(line.slice('#EXT-X-STREAM-INF:'.length));
            const bandwidth = parseInt(attrs.BANDWIDTH || '0', 10);
            const resMatch = (attrs.RESOLUTION || '').match(/(\d+)x(\d+)/i);
            const height = resMatch ? parseInt(resMatch[2], 10) : 0;
            let nextIdx = i + 1;
            while (nextIdx < lines.length && (!lines[nextIdx].trim() || lines[nextIdx].trim().startsWith('#'))) {
              nextIdx++;
            }
            if (nextIdx < lines.length) {
              try {
                const variantUrl = new URL(lines[nextIdx].trim(), mediaPlaylistUrl).href;
                variants.push({ url: variantUrl, bandwidth, height });
              } catch (e) {}
            }
          }
        }

        if (variants.length > 0) {
          variants.sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));
          let chosen = variants[0];
          const maxHeight = this.quality === '480p' ? 480 : this.quality === '720p' ? 720 : this.quality === '1080p' ? 1080 : 0;
          if (maxHeight > 0) {
            const matching = variants.filter((v) => v.height > 0 && v.height <= maxHeight);
            chosen = matching.length > 0 ? matching[0] : variants[variants.length - 1];
          }
          const mediaRes = await this.fetchBuffer(chosen.url);
          mediaPlaylistUrl = mediaRes.finalUrl;
          playlistText = mediaRes.buffer.toString('utf8');
        }
      }

      // Parse Media Playlist
      const lines = playlistText.split(/\r?\n/);
      let mediaSequence = 0;
      let currentKey = null;
      let currentMap = null;
      let pendingByteRange = null;
      let runningByteOffset = 0;
      const hlsSegments = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
          mediaSequence = parseInt(line.split(':')[1] || '0', 10) || 0;
        } else if (line.startsWith('#EXT-X-KEY:')) {
          const attrs = this.parseM3u8Attributes(line.slice('#EXT-X-KEY:'.length));
          const method = (attrs.METHOD || 'NONE').toUpperCase();
          if (method === 'NONE') {
            currentKey = null;
          } else if (method === 'AES-128' && attrs.URI) {
            currentKey = {
              method: 'AES-128',
              keyUrl: new URL(attrs.URI, mediaPlaylistUrl).href,
              ivHex: attrs.IV || null
            };
          } else if (method.includes('SAMPLE-AES')) {
            throw new Error('Video HLS được mã hóa DRM (SAMPLE-AES) nên không thể tải xuống.');
          }
        } else if (line.startsWith('#EXT-X-MAP:')) {
          const attrs = this.parseM3u8Attributes(line.slice('#EXT-X-MAP:'.length));
          if (attrs.URI) {
            let mapRange = null;
            if (attrs.BYTERANGE) {
              const br = attrs.BYTERANGE.split('@');
              const len = parseInt(br[0], 10);
              const offset = br[1] !== undefined ? parseInt(br[1], 10) : 0;
              if (len > 0) mapRange = `bytes=${offset}-${offset + len - 1}`;
            }
            currentMap = {
              url: new URL(attrs.URI, mediaPlaylistUrl).href,
              byteRange: mapRange
            };
          }
        } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
          const br = line.slice('#EXT-X-BYTERANGE:'.length).split('@');
          const len = parseInt(br[0], 10);
          const offset = br[1] !== undefined ? parseInt(br[1], 10) : runningByteOffset;
          if (len > 0) {
            pendingByteRange = `bytes=${offset}-${offset + len - 1}`;
            runningByteOffset = offset + len;
          }
        } else if (!line.startsWith('#')) {
          try {
            const segUrl = new URL(line, mediaPlaylistUrl).href;
            const segIndex = hlsSegments.length;
            hlsSegments.push({
              index: segIndex,
              seqNum: mediaSequence + segIndex,
              url: segUrl,
              byteRange: pendingByteRange,
              keyInfo: currentKey ? { ...currentKey } : null,
              mapInfo: currentMap ? { ...currentMap } : null
            });
          } catch (e) {}
          pendingByteRange = null;
        }
      }

      if (hlsSegments.length === 0) {
        if (this.pageUrl && this.pageUrl.startsWith('http')) {
          this.startYtDlpDownload(this.pageUrl);
          return;
        }
        throw new Error('Không tìm thấy phân đoạn video nào trong playlist HLS.');
      }

      const tempDir = path.join(os.tmpdir(), 'IDMLite', this.id);
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      // Pre-fetch unique AES-128 keys & fMP4 init maps
      const keyCache = new Map();
      const mapCache = new Map();
      for (const seg of hlsSegments) {
        if (this.hlsAborted || this.status !== 'downloading') return;
        if (seg.keyInfo && !keyCache.has(seg.keyInfo.keyUrl)) {
          const keyRes = await this.fetchBuffer(seg.keyInfo.keyUrl);
          keyCache.set(seg.keyInfo.keyUrl, keyRes.buffer);
        }
        if (seg.mapInfo) {
          const mapKey = `${seg.mapInfo.url}|${seg.mapInfo.byteRange || ''}`;
          if (!mapCache.has(mapKey)) {
            const mapRes = await this.fetchBuffer(seg.mapInfo.url, seg.mapInfo.byteRange ? { range: seg.mapInfo.byteRange } : {});
            const mapPath = path.join(tempDir, `hls_init_${mapCache.size}`);
            fs.writeFileSync(mapPath, mapRes.buffer);
            mapCache.set(mapKey, mapPath);
          }
        }
      }

      // Initialize 8 visual progress buckets
      const BUCKETS = 8;
      const bucketSize = Math.ceil(hlsSegments.length / BUCKETS);
      const bucketDone = new Array(BUCKETS).fill(0);
      const bucketTotals = Array.from({ length: BUCKETS }, (_, idx) => {
        const start = idx * bucketSize;
        const end = Math.min(hlsSegments.length, (idx + 1) * bucketSize);
        return Math.max(0, end - start);
      });
      this.segments = Array.from({ length: BUCKETS }, (_, idx) => ({
        index: idx,
        startPos: idx * 100,
        endPos: (idx + 1) * 100 - 1,
        downloaded: 0,
        completed: bucketTotals[idx] === 0
      }));

      this.statusNote = '';
      this.downloaded = 0;
      this.total = 0;
      let completedCount = 0;
      let cursor = 0;

      const worker = async () => {
        while (!this.hlsAborted && this.status === 'downloading') {
          const segIdx = cursor++;
          if (segIdx >= hlsSegments.length) break;
          const seg = hlsSegments[segIdx];
          const segPath = path.join(tempDir, `hls_seg_${seg.index}`);

          let segSuccess = false;
          let lastErr = null;
          for (let attempt = 1; attempt <= 4; attempt++) {
            if (this.hlsAborted || this.status !== 'downloading') return;
            try {
              const res = await this.fetchBuffer(seg.url, seg.byteRange ? { range: seg.byteRange } : {});
              let outBuf = res.buffer;
              if (seg.keyInfo && seg.keyInfo.method === 'AES-128') {
                const keyBuf = keyCache.get(seg.keyInfo.keyUrl);
                let ivBuf = Buffer.alloc(16, 0);
                if (seg.keyInfo.ivHex) {
                  const cleanHex = seg.keyInfo.ivHex.replace(/^0x/i, '').padStart(32, '0').slice(-32);
                  ivBuf = Buffer.from(cleanHex, 'hex');
                } else {
                  ivBuf.writeBigUInt64BE(BigInt(seg.seqNum), 8);
                }
                const decipher = crypto.createDecipheriv('aes-128-cbc', keyBuf, ivBuf);
                outBuf = Buffer.concat([decipher.update(outBuf), decipher.final()]);
              }
              outBuf = stripDisguisedTsHeader(outBuf);
              fs.writeFileSync(segPath, outBuf);
              this.downloaded += outBuf.length;
              segSuccess = true;
              break;
            } catch (err) {
              lastErr = err;
              if (this.hlsAborted || this.status !== 'downloading') return;
              await new Promise((r) => setTimeout(r, 400 * attempt));
            }
          }

          if (!segSuccess) {
            throw lastErr || new Error(`Lỗi khi tải phân đoạn HLS #${seg.index}`);
          }

          completedCount++;
          this.total = Math.round((this.downloaded / completedCount) * hlsSegments.length);
          const bIdx = Math.min(BUCKETS - 1, Math.floor(segIdx / bucketSize));
          bucketDone[bIdx]++;
          const bTot = bucketTotals[bIdx] || 1;
          this.segments[bIdx].downloaded = Math.round((bucketDone[bIdx] / bTot) * 100);
          this.segments[bIdx].completed = bucketDone[bIdx] >= bTot;
          this.sendProgress();
        }
      };

      const workerCount = Math.min(8, hlsSegments.length);
      await Promise.all(Array.from({ length: workerCount }, () => worker()));

      if (this.hlsAborted || this.status !== 'downloading') return;

      // Merge segments
      this.status = 'merging';
      this.statusNote = 'Đang ghép phân đoạn video...';
      this.total = this.downloaded;
      this.sendProgress(true);

      const firstSegPath = path.join(tempDir, 'hls_seg_0');
      let isMpegTs = false;
      try {
        const fd = fs.openSync(firstSegPath, 'r');
        const probe = Buffer.alloc(1);
        fs.readSync(fd, probe, 0, 1, 0);
        fs.closeSync(fd);
        isMpegTs = probe[0] === 0x47;
      } catch (e) {}

      const hasInitMap = mapCache.size > 0;
      const ffmpegPath = findFfmpegPath();
      const shouldRemux = isMpegTs && !hasInitMap && this.filePath.toLowerCase().endsWith('.mp4') && Boolean(ffmpegPath);
      const concatDestPath = shouldRemux ? path.join(tempDir, 'merged_raw.ts') : this.filePath;

      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(concatDestPath);
        out.on('error', reject);
        (async () => {
          let lastMapKey = '';
          for (const seg of hlsSegments) {
            if (seg.mapInfo) {
              const mapKey = `${seg.mapInfo.url}|${seg.mapInfo.byteRange || ''}`;
              if (mapKey !== lastMapKey) {
                lastMapKey = mapKey;
                const mapFile = mapCache.get(mapKey);
                if (mapFile && fs.existsSync(mapFile)) {
                  await new Promise((r, j) => {
                    const rs = fs.createReadStream(mapFile);
                    rs.on('data', (c) => { if (!out.write(c)) { rs.pause(); out.once('drain', () => rs.resume()); } });
                    rs.on('end', r);
                    rs.on('error', j);
                  });
                }
              }
            }
            const segFile = path.join(tempDir, `hls_seg_${seg.index}`);
            if (!fs.existsSync(segFile)) continue;
            await new Promise((r, j) => {
              const rs = fs.createReadStream(segFile, { highWaterMark: 2 * 1024 * 1024 });
              rs.on('data', (c) => { if (!out.write(c)) { rs.pause(); out.once('drain', () => rs.resume()); } });
              rs.on('end', r);
              rs.on('error', j);
            });
          }
          out.end(resolve);
        })().catch(reject);
      });

      if (shouldRemux) {
        let remux = spawnSync(ffmpegPath, ['-y', '-i', concatDestPath, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', this.filePath], { windowsHide: true });
        if (!remux || remux.status !== 0) {
          remux = spawnSync(ffmpegPath, ['-y', '-i', concatDestPath, '-c', 'copy', this.filePath], { windowsHide: true });
        }
        if (!remux || remux.status !== 0) {
          fs.copyFileSync(concatDestPath, this.filePath);
        }
      }

      try {
        if (fs.existsSync(this.filePath)) {
          this.total = fs.statSync(this.filePath).size;
          this.downloaded = this.total;
        }
      } catch (e) {}

      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
      this.statusNote = '';
      this.complete();
    } catch (err) {
      if (this.hlsAborted || this.status !== 'downloading') return;
      this.statusNote = '';
      this.handleError(err);
    }
  }

  async startYtDlpDownload(targetUrl) {
    try {
      // For general movie/streaming websites, try static HTML stream extraction first (fast, no yt-dlp needed)
      if (!isVideoPlatformUrl(targetUrl) && this.videoType !== 'dash' && !this.triedWebpageFallback) {
        this.statusNote = 'Đang kiểm tra luồng video trên trang...';
        this.sendProgress(true);
        const staticStream = await extractStaticStreamFromHtml(
          targetUrl,
          this.cookies,
          this.referrer || this.pageUrl,
          this.userAgent
        );
        if (this.hlsAborted || this.status !== 'downloading') return;
        if (staticStream && staticStream.url) {
          this.triedWebpageFallback = true;
          this.videoType = staticStream.videoType;
          this.url = staticStream.url;
          this.statusNote = '';
          if (staticStream.videoType === 'hls') {
            this.startHlsDownload(staticStream.url);
          } else {
            this.getHeadersAndStart(staticStream.url);
          }
          return;
        }
      }

      this.statusNote = 'Đang chuẩn bị trình tải video...';
      this.sendProgress(true);

      const ytDlpBin = await ensureYtDlpBinary((note) => {
        if (this.status === 'downloading') {
          this.statusNote = note;
          this.sendProgress();
        }
      });

      if (this.hlsAborted || this.status !== 'downloading') return;

      this.downloaded = 0;
      this.total = 0;
      this.statusNote = 'Đang phân tích liên kết video...';
      this.sendProgress(true);

      const tempDir = path.join(os.tmpdir(), 'IDMLite', this.id);
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      const cookieFilePath = path.join(tempDir, 'cookies.txt');
      const hasCookiesFile = writeNetscapeCookiesFile(cookieFilePath, this.cookieList, this.cookies, targetUrl);
      const ffmpegPath = findFfmpegPath();

      const quality = this.quality || 'best';
      let formatArgs = [];
      if (quality === 'audio') {
        const audioExt = this.fileName.toLowerCase().endsWith('.mp3') ? 'mp3' : 'm4a';
        formatArgs = ffmpegPath
          ? ['-f', 'bestaudio/best', '-x', '--audio-format', audioExt]
          : ['-f', 'bestaudio[ext=m4a]/bestaudio/best'];
      } else if (quality === '720p') {
        formatArgs = ffmpegPath
          ? ['-f', 'bv*[height<=720][ext=mp4]+ba[ext=m4a]/bv*[height<=720]+ba/b[height<=720]/b', '--merge-output-format', 'mp4']
          : ['-f', 'b[height<=720][ext=mp4]/b[height<=720]/b'];
      } else if (quality === '480p') {
        formatArgs = ffmpegPath
          ? ['-f', 'bv*[height<=480][ext=mp4]+ba[ext=m4a]/bv*[height<=480]+ba/b[height<=480]/b', '--merge-output-format', 'mp4']
          : ['-f', 'b[height<=480][ext=mp4]/b[height<=480]/b'];
      } else if (quality === '1080p') {
        formatArgs = ffmpegPath
          ? ['-f', 'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/bv*[height<=1080]+ba/b[height<=1080]/b', '--merge-output-format', 'mp4']
          : ['-f', 'b[height<=1080][ext=mp4]/b[height<=1080]/b'];
      } else {
        formatArgs = ffmpegPath
          ? ['-f', 'bv*[ext=mp4]+ba[ext=m4a]/bv*+ba/b[ext=mp4]/b', '--merge-output-format', 'mp4']
          : ['-f', 'b[ext=mp4]/b'];
      }

      const isGenericName = /^(download_file_|untitled_|video_\d+)/i.test(this.fileName);
      const ext = path.extname(this.filePath);
      const basePathNoExt = ext ? this.filePath.slice(0, -ext.length) : this.filePath;
      const outputTemplate = isGenericName
        ? path.join(this.saveFolder, '%(title).120B.%(ext)s')
        : `${basePathNoExt}.%(ext)s`;

      const args = [
        '--newline',
        '--progress',
        '--no-simulate',
        '--no-playlist',
        '--continue',
        '--concurrent-fragments', '8',
        '--no-mtime',
        '--progress-template', 'download:IDMLITE_PROG|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress._percent_str)s',
        '--print', 'after_move:IDMLITE_FINAL|%(filepath)s',
        ...formatArgs
      ];

      if (ffmpegPath && ffmpegPath !== 'ffmpeg') {
        args.push('--ffmpeg-location', path.dirname(ffmpegPath));
      }
      if (hasCookiesFile) {
        args.push('--cookies', cookieFilePath);
      }
      if (this.referrer || this.pageUrl) {
        args.push('--referer', this.referrer || this.pageUrl);
      }
      if (this.userAgent) {
        args.push('--user-agent', this.userAgent);
      }
      args.push('-o', outputTemplate, targetUrl);

      this.segments = Array.from({ length: 8 }, (_, idx) => ({
        index: idx,
        startPos: idx * 100,
        endPos: (idx + 1) * 100 - 1,
        downloaded: 0,
        completed: false
      }));

      const child = spawn(ytDlpBin, args, { windowsHide: true });
      this.childProcess = child;

      let stdoutBuf = '';
      let lastStderr = '';

      const handleLine = (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;

        if (trimmed.startsWith('IDMLITE_PROG|')) {
          const parts = trimmed.split('|');
          const dl = parseFloat(parts[1]);
          const tot = parseFloat(parts[2]);
          const est = parseFloat(parts[3]);
          const spd = parseFloat(parts[4]);
          const pctStr = (parts[5] || '').replace('%', '').trim();

          const validTot = (!Number.isNaN(tot) && tot > 0) ? tot : ((!Number.isNaN(est) && est > 0) ? est : 0);
          if (!Number.isNaN(dl) && dl >= 0) this.downloaded = Math.round(dl);
          if (validTot > 0) this.total = Math.round(validTot);
          if (!Number.isNaN(spd) && spd >= 0) this.speed = Math.round(spd);
          this.statusNote = '';

          const pct = this.total > 0
            ? Math.min(100, (this.downloaded / this.total) * 100)
            : (parseFloat(pctStr) || 0);
          const filledBuckets = Math.floor((pct / 100) * 8);
          this.segments.forEach((seg, idx) => {
            if (idx < filledBuckets) {
              seg.downloaded = 100;
              seg.completed = true;
            } else if (idx === filledBuckets) {
              const frac = Math.max(0, Math.min(100, Math.round(((pct / 100) * 8 - filledBuckets) * 100)));
              seg.downloaded = frac;
              seg.completed = false;
            } else {
              seg.downloaded = 0;
              seg.completed = false;
            }
          });
          this.sendProgress();
        } else if (trimmed.startsWith('IDMLITE_FINAL|')) {
          const finalPath = trimmed.slice('IDMLITE_FINAL|'.length).trim();
          if (finalPath && fs.existsSync(finalPath)) {
            this.filePath = finalPath;
            this.fileName = path.basename(finalPath);
            this.category = detectCategory(this.fileName);
          }
        } else if (trimmed.startsWith('[Merger] Merging formats into "')) {
          this.status = 'merging';
          this.statusNote = 'Đang ghép video & âm thanh...';
          const m = trimmed.match(/into "(.+)"$/);
          if (m && m[1]) {
            this.filePath = m[1];
            this.fileName = path.basename(m[1]);
            this.category = detectCategory(this.fileName);
          }
          this.sendProgress(true);
        } else if (trimmed.startsWith('[download] Destination: ')) {
          const dest = trimmed.slice('[download] Destination: '.length).trim();
          if (dest) {
            this.filePath = dest;
            this.fileName = path.basename(dest);
            this.category = detectCategory(this.fileName);
            this.statusNote = '';
            this.sendProgress();
          }
        }
      };

      child.stdout.on('data', (data) => {
        stdoutBuf += data.toString();
        const lines = stdoutBuf.split(/\r?\n/);
        stdoutBuf = lines.pop() || '';
        lines.forEach(handleLine);
      });

      child.stderr.on('data', (data) => {
        const text = data.toString().trim();
        if (text) {
          const lines = text.split(/\r?\n/).filter(Boolean);
          if (lines.length > 0) {
            lastStderr = lines[lines.length - 1];
          }
        }
      });

      child.on('error', (err) => {
        this.childProcess = null;
        try { if (fs.existsSync(cookieFilePath)) fs.unlinkSync(cookieFilePath); } catch (e) {}
        if (this.status !== 'downloading' && this.status !== 'merging') return;
        this.statusNote = '';
        this.handleError(err);
      });

      child.on('close', async (code) => {
        this.childProcess = null;
        if (stdoutBuf) handleLine(stdoutBuf);
        try { if (fs.existsSync(cookieFilePath)) fs.unlinkSync(cookieFilePath); } catch (e) {}
        try { if (fs.existsSync(tempDir) && fs.readdirSync(tempDir).length === 0) fs.rmdirSync(tempDir); } catch (e) {}

        if (this.status !== 'downloading' && this.status !== 'merging') {
          return;
        }

        if (code === 0) {
          try {
            if (fs.existsSync(this.filePath)) {
              this.total = fs.statSync(this.filePath).size;
              this.downloaded = this.total;
            }
          } catch (e) {}
          this.statusNote = '';
          this.complete();
        } else {
          const cleanErr = lastStderr.replace(/^ERROR:\s*/i, '').trim();
          if (!this.triedWebpageFallback && /unsupported url|no video formats|unable to extract/i.test(lastStderr)) {
            this.triedWebpageFallback = true;
            this.statusNote = 'Đang dò tìm luồng phát video trên trang...';
            this.sendProgress(true);
            try {
              const extracted = await extractStreamFromWebpage(
                targetUrl,
                this.cookies,
                this.referrer || this.pageUrl,
                this.userAgent,
                this.cookieList
              );
              if (this.hlsAborted || this.status !== 'downloading') return;
              if (extracted && extracted.url) {
                this.videoType = extracted.videoType;
                this.url = extracted.url;
                this.statusNote = '';
                if (extracted.videoType === 'hls') {
                  this.startHlsDownload(extracted.url);
                } else {
                  this.getHeadersAndStart(extracted.url);
                }
                return;
              }
            } catch (e) {}
          }
          this.statusNote = '';
          this.handleError(new Error(cleanErr || `Trình tải video thoát với mã lỗi ${code}.`));
        }
      });
    } catch (err) {
      this.statusNote = '';
      if (this.status === 'downloading' || this.status === 'merging') {
        this.handleError(err);
      }
    }
  }

  pause() {
    this.status = 'paused';
    this.statusNote = '';
    this.cleanup();
    this.sendProgress();
  }

  cancel() {
    this.status = 'failed';
    this.statusNote = '';
    this.cleanup();
    this.sendProgress();
  }

  cleanup() {
    this.hlsAborted = true;
    if (this.childProcess) {
      const pid = this.childProcess.pid;
      try {
        if (process.platform === 'win32' && pid) {
          spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
        } else {
          this.childProcess.kill('SIGTERM');
        }
      } catch (e) {}
      this.childProcess = null;
    }
    if (this.request) {
      this.request.destroy();
      this.request = null;
    }
    if (this.segmentRequests) {
      this.segmentRequests.forEach(req => {
        try {
          req.destroy();
        } catch (e) { }
      });
      this.segmentRequests = [];
    }
    if (this.segmentStreams) {
      this.segmentStreams.forEach(stream => {
        try {
          stream.end();
        } catch (e) { }
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
    this.statusNote = '';
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
    this.statusNote = '';
    this.errorMsg = err.message || String(err);
    this.cleanup();
    this.sendProgress();
  }

  startSpeedTracker() {
    if (this.speedInterval) clearInterval(this.speedInterval);

    this.speedInterval = setInterval(() => {
      if (this.status === 'downloading') {
        const currentBytes = this.downloaded;
        if (!this.childProcess) {
          this.speed = Math.max(0, currentBytes - this.lastBytes);
        }
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
        statusNote: this.statusNote || '',
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
ipcMain.on('start-download', (event, { id, url, saveFolder, fileName, cookies, referrer, userAgent, pageUrl, cookieList, isVideo, videoType, quality }) => {
  console.log(`Starting download: ${url} -> ${saveFolder}/${fileName}`);

  if (activeDownloads[id]) {
    activeDownloads[id].cleanup();
  }

  const task = new DownloadTask(id, url, saveFolder, fileName, cookies, referrer, userAgent, {
    pageUrl,
    cookieList,
    isVideo,
    videoType,
    quality
  });
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
  } else {
    if (mainWindow) {
      mainWindow.webContents.send('download-needs-restart', id);
    }
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
  try {
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true });
    }
    shell.openPath(folderPath).catch((err) => {
      console.error('Failed to open path:', err);
    });
  } catch (err) {
    console.error('Failed to process open-folder:', err);
  }
});

ipcMain.handle('get-pending-prompt', () => {
  return pendingPromptData;
});

ipcMain.on('confirm-prompt-download', (event, data) => {
  console.log(`Confirming prompt download: ${data.name}`);
  const fallback = pendingPromptData || {};
  if (mainWindow) {
    mainWindow.webContents.send('capture-download', {
      url: data.url,
      pageUrl: data.pageUrl !== undefined ? data.pageUrl : (fallback.pageUrl || ''),
      fileName: data.name,
      savePath: data.savePath,
      cookies: data.cookies !== undefined ? data.cookies : (fallback.cookies || ''),
      cookieList: Array.isArray(data.cookieList) && data.cookieList.length > 0 ? data.cookieList : (fallback.cookieList || []),
      referrer: data.referrer !== undefined ? data.referrer : (fallback.referrer || ''),
      userAgent: data.userAgent !== undefined ? data.userAgent : (fallback.userAgent || ''),
      isVideo: data.isVideo !== undefined ? Boolean(data.isVideo) : Boolean(fallback.isVideo),
      videoType: data.videoType || fallback.videoType || 'auto',
      quality: data.quality || fallback.quality || 'best'
    });

    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }

  pendingPromptData = null;
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

// Manual update check triggered by user from UI
ipcMain.handle('check-for-updates', async () => {
  await checkForUpdates(true);
  return { success: true };
});

ipcMain.on('start-app-update', (event, updateInfo) => {
  if (!updateInfo || !updateInfo.downloadUrl) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-error', 'Không tìm thấy liên kết tải bản cập nhật.');
    }
    return;
  }

  const tempDir = path.join(app.getPath('temp'), 'IDMLite-Update');
  try {
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
  } catch (err) {
    console.error('Failed to create update directory:', err);
  }

  const assetName = updateInfo.assetName || `IDMLite.Setup.${updateInfo.latestVersion || 'update'}.exe`;
  const installerPath = path.join(tempDir, assetName);

  console.log(`[Update] Starting download from ${updateInfo.downloadUrl} to ${installerPath}`);

  downloadUpdate(
    updateInfo.downloadUrl,
    installerPath,
    (progress) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update-download-progress', progress);
      }
    },
    (completedPath) => {
      console.log(`[Update] Download completed: ${completedPath}`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update-download-complete', { installerPath: completedPath });
      }
      setTimeout(() => {
        launchInstallerAndQuit(completedPath);
      }, 1200);
    },
    (err) => {
      console.error('[Update] Download error:', err);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update-error', err.message || 'Lỗi khi tải bản cập nhật');
      }
    }
  );
});

ipcMain.on('cancel-app-update', () => {
  console.log('[Update] User cancelled update download.');
  cancelAppUpdate();
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

  const selectedDir = filePaths[0];
  const isExistingExtDir =
    path.basename(selectedDir).toLowerCase() === 'idmlite-extension' ||
    fs.existsSync(path.join(selectedDir, 'manifest.json'));
  const targetDir = isExistingExtDir ? selectedDir : path.join(selectedDir, 'idmlite-extension');
  try {
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const nestedCopy = path.join(targetDir, 'idmlite-extension');
    if (fs.existsSync(nestedCopy)) {
      try {
        fs.rmSync(nestedCopy, { recursive: true, force: true });
      } catch (e) {}
    }

    fs.cpSync(extPath, targetDir, { recursive: true, force: true });

    shell.openPath(targetDir);
    return { success: true, path: targetDir };
  } catch (err) {
    console.error('Lỗi khi xuất extension:', err);
    return { success: false, error: err.message };
  }
});
