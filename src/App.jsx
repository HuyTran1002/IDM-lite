import { useState, useEffect } from 'react'
import {
  Download,
  Play,
  Pause,
  Trash2,
  Plus,
  Search,
  FileText,
  Video,
  Music,
  Cpu,
  File,
  X,
  RefreshCw,
  FolderOpen,
  CheckCircle,
  AlertCircle,
  ChevronDown,
  ChevronUp,
  FileArchive,
  Settings,
  Folder,
  Globe
} from 'lucide-react'

// Initial mock data
const INITIAL_DOWNLOADS = [
  {
    id: '1',
    name: 'Windows_11_English_x64v1.iso',
    url: 'https://software.download.prss.microsoft.com/db/Win11_23H2_English_x64v1.iso',
    size: 6228308480, // 5.8 GB
    downloaded: 2200000000,
    status: 'paused',
    speed: 0,
    category: 'program',
    savePath: 'C:\\Downloads\\Programs',
    addedAt: Date.now() - 3600000
  },
  {
    id: '2',
    name: 'avengers_endgame_4k_hdr.mp4',
    url: 'https://media.yts.mx/movies/avengers_endgame_2019/avengers_endgame_2019_4k.mp4',
    size: 13743895347, // 12.8 GB
    downloaded: 9345000000,
    status: 'paused',
    speed: 0,
    category: 'video',
    savePath: 'C:\\Downloads\\Videos',
    addedAt: Date.now() - 7200000
  },
  {
    id: '3',
    name: 'taylor_swift_folklore_album.zip',
    url: 'https://musicfiles.co/albums/taylor_swift_folklore.zip',
    size: 152043520, // 145 MB
    downloaded: 152043520,
    status: 'completed',
    speed: 0,
    category: 'music',
    savePath: 'C:\\Downloads\\Music',
    addedAt: Date.now() - 86400000
  },
  {
    id: '4',
    name: 'react_documentation_guide_2026.pdf',
    url: 'https://react.dev/assets/docs/react-docs-2026.pdf',
    size: 4404019, // 4.2 MB
    downloaded: 4404019,
    status: 'completed',
    speed: 0,
    category: 'document',
    savePath: 'C:\\Downloads\\Documents',
    addedAt: Date.now() - 400000
  }
];

const detectCategory = (filename) => {
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
};

const formatBytes = (bytes, decimals = 1) => {
  if (!bytes || bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
};

const formatSpeed = (bytesPerSec) => {
  if (!bytesPerSec || bytesPerSec === 0) return '0 KB/s';
  return `${formatBytes(bytesPerSec, 1)}/s`;
};

const formatETA = (item) => {
  if (item.status === 'completed') return 'Completed';
  if (item.status === 'paused') return 'Paused';
  if (item.status === 'failed') return 'Failed';
  if (!item.speed || item.speed === 0) return 'Unknown';

  const remainingBytes = item.size - item.downloaded;
  const secondsLeft = Math.ceil(remainingBytes / item.speed);

  if (secondsLeft <= 0) return '0s';
  if (secondsLeft < 60) return `${secondsLeft}s`;

  const minutes = Math.floor(secondsLeft / 60);
  const seconds = secondsLeft % 60;

  if (minutes < 60) return `${minutes}m ${seconds}s`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
};

const getFileIcon = (fileName, category) => {
  const ext = fileName.split('.').pop().toLowerCase();
  const zipExtensions = ['zip', 'rar', '7z', 'tar', 'gz'];
  
  if (zipExtensions.includes(ext)) {
    return (
      <div className="file-icon icon-zip">
        <FileArchive size={16} />
      </div>
    );
  }

  switch (category) {
    case 'document':
      return (
        <div className="file-icon icon-doc">
          <FileText size={16} />
        </div>
      );
    case 'video':
      return (
        <div className="file-icon icon-video">
          <Video size={16} />
        </div>
      );
    case 'music':
      return (
        <div className="file-icon icon-music">
          <Music size={16} />
        </div>
      );
    case 'program':
      return (
        <div className="file-icon icon-program">
          <Cpu size={16} />
        </div>
      );
    default:
      return (
        <div className="file-icon icon-other">
          <File size={16} />
        </div>
      );
  }
};

function App() {
  const isDesktop = typeof window.api !== 'undefined';

  // Detect routing mode from query params
  const isPromptMode = window.location.hash.startsWith('#prompt');

  // Parse prompt parameters from hash URL if present
  const getPromptParams = () => {
    try {
      const hash = window.location.hash;
      const questionIndex = hash.indexOf('?');
      if (questionIndex !== -1) {
        const searchParams = new URLSearchParams(hash.slice(questionIndex));
        return {
          url: searchParams.get('url') || '',
          fileName: searchParams.get('fileName') || '',
          cookies: searchParams.get('cookies') || '',
          referrer: searchParams.get('referrer') || ''
        };
      }
    } catch (e) {
      console.error('Error parsing prompt parameters from hash', e);
    }
    return { url: '', fileName: '', cookies: '', referrer: '' };
  };

  const initialParams = getPromptParams();

  // PROMPT MODE STATE
  const [promptUrl, setPromptUrl] = useState(initialParams.url);
  const [promptName, setPromptName] = useState(initialParams.fileName);
  const [promptCookies, setPromptCookies] = useState(initialParams.cookies);
  const [promptReferrer, setPromptReferrer] = useState(initialParams.referrer);
  const [promptSavePath, setPromptSavePath] = useState(() => {
    return localStorage.getItem('idm_default_save_path') || 'C:\\Downloads';
  });

  // MAIN MODE STATE
  const [downloads, setDownloads] = useState(() => {
    const saved = localStorage.getItem('idm_downloads');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        return parsed.map(item => {
          if (item.status === 'downloading' || item.status === 'merging') {
            return { ...item, status: 'paused', speed: 0 };
          }
          return item;
        });
      } catch (e) {
        console.error(e);
      }
    }
    return INITIAL_DOWNLOADS;
  });

  const [defaultSavePath, setDefaultSavePath] = useState(() => {
    return localStorage.getItem('idm_default_save_path') || 'C:\\Downloads';
  });

  const [activeCategory, setActiveCategory] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortField, setSortField] = useState('addedAt');
  const [sortOrder, setSortOrder] = useState('desc');
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState('general');

  // App Config Settings State
  const [isInterceptionEnabled, setIsInterceptionEnabled] = useState(true);
  const [startWithWindows, setStartWithWindows] = useState(false);
  const [extensionsString, setExtensionsString] = useState('');

  // Update notification state
  const [updateInfo, setUpdateInfo] = useState(null);
  const [appVersion, setAppVersion] = useState('1.0.2');
  const [extensionStatus, setExtensionStatus] = useState({
    bundledVersion: '1.0.2',
    installedVersion: 'Chưa nhận diện',
    needsUpdate: false
  });

  // Fetch app version and extension status on mount
  useEffect(() => {
    if (isDesktop) {
      if (window.api.getVersion) {
        window.api.getVersion().then((ver) => {
          setAppVersion(ver);
        });
      }
      if (window.api.getExtensionStatus) {
        window.api.getExtensionStatus().then((status) => {
          setExtensionStatus(status);
        });
      }
    }
  }, [isDesktop]);

  // Listen for extension status updates from backend
  useEffect(() => {
    if (isDesktop && window.api.onExtensionStatusUpdate) {
      const unsubscribe = window.api.onExtensionStatusUpdate((event, status) => {
        setExtensionStatus(status);
      });
      return () => unsubscribe();
    }
  }, [isDesktop]);
  
  // New download form state
  const [newUrl, setNewUrl] = useState('');
  const [newName, setNewName] = useState('');
  const [newSize, setNewSize] = useState('150'); // MB
  const [newSizeUnit, setNewSizeUnit] = useState('MB');
  const [customSavePath, setCustomSavePath] = useState('');

  // Fetch configs from Electron when settings modal is opened
  useEffect(() => {
    if (isDesktop && isSettingsOpen) {
      window.api.getAppConfig().then((config) => {
        setIsInterceptionEnabled(config.isInterceptionEnabled);
        setStartWithWindows(config.startWithWindows);
        setExtensionsString(config.extensions.join(', '));
      });
    }
  }, [isSettingsOpen, isDesktop]);

  // Synchronize changes when they happen in Tray
  useEffect(() => {
    if (isDesktop && window.api.onConfigChanged) {
      const unsubscribe = window.api.onConfigChanged((event, data) => {
        setIsInterceptionEnabled(data.isInterceptionEnabled);
        if (data.extensions) {
          setExtensionsString(data.extensions.join(', '));
        }
      });
      return () => unsubscribe();
    }
  }, [isDesktop]);

  // Listen for update notifications from main process
  useEffect(() => {
    if (isDesktop && window.api.onUpdateAvailable) {
      const unsubscribe = window.api.onUpdateAvailable((event, data) => {
        setUpdateInfo(data);
      });
      return () => unsubscribe();
    }
  }, [isDesktop]);

  // Save config to localStorage
  useEffect(() => {
    if (isPromptMode) return;
    localStorage.setItem('idm_downloads', JSON.stringify(downloads));
  }, [downloads, isPromptMode]);

  useEffect(() => {
    localStorage.setItem('idm_default_save_path', defaultSavePath);
  }, [defaultSavePath]);


  // ELECTRON IPC PROGRESS LISTENER
  useEffect(() => {
    if (isPromptMode) return;

    if (isDesktop && window.api.onDownloadProgress) {
      const unsubscribe = window.api.onDownloadProgress((event, data) => {
        setDownloads((prev) =>
          prev.map((item) => {
            if (item.id === data.id) {
              return {
                ...item,
                downloaded: data.downloaded,
                size: data.total || item.size,
                speed: data.speed,
                status: data.status,
                savePath: data.savePath || item.savePath,
                name: data.name || item.name,
                category: data.category || item.category,
                segments: data.segments || item.segments || [],
                errorMsg: data.errorMsg || ''
              };
            }
            return item;
          })
        );
      });
      return () => unsubscribe();
    }
  }, [isDesktop, isPromptMode]);

  // ELECTRON IPC BROWSER LINK INTERCEPTOR LISTENER
  useEffect(() => {
    if (isPromptMode) return;

    if (isDesktop && window.api.onCaptureDownload) {
      const unsubscribe = window.api.onCaptureDownload((event, data) => {
        const name = data.fileName || 'download_' + Date.now();
        const category = detectCategory(name);
        const saveFolder = data.savePath || defaultSavePath;
        const url = data.url;
        const cookies = data.cookies || '';
        const referrer = data.referrer || '';

        // Create item and start downloading immediately without opening another modal
        const newItem = {
          id: Date.now().toString(),
          name,
          url,
          size: 0,
          downloaded: 0,
          status: 'downloading',
          speed: 0,
          category,
          savePath: saveFolder,
          addedAt: Date.now(),
          cookies,
          referrer
        };

        setDownloads((prev) => [newItem, ...prev]);

        if (window.api.startDownload) {
          window.api.startDownload(newItem.id, newItem.url, saveFolder, name, cookies, referrer);
        }
      });
      return () => unsubscribe();
    }
  }, [isDesktop, isPromptMode, defaultSavePath]);

  // LISTEN FOR PROMPT WINDOW INITIALIZATION DATA
  useEffect(() => {
    if (isPromptMode && isDesktop && window.api.onInitPrompt) {
      const unsubscribe = window.api.onInitPrompt((event, data) => {
        setPromptUrl(data.url);
        setPromptName(data.fileName);
        setPromptCookies(data.cookies || '');
        setPromptReferrer(data.referrer || '');
      });
      return () => unsubscribe();
    }
  }, [isPromptMode, isDesktop]);

  // BROWSER BACKEND SIMULATION LOOP
  useEffect(() => {
    if (isDesktop || isPromptMode) return;

    const timer = setInterval(() => {
      setDownloads((prevDownloads) =>
        prevDownloads.map((item) => {
          if (item.status !== 'downloading') return item;

          const baseSpeed = item.speed || 1024 * 1024 * 2;
          const randomFactor = 0.85 + Math.random() * 0.3;
          let currentSpeed = Math.floor(baseSpeed * randomFactor);

          if (item.category === 'document' && currentSpeed > 1024 * 1024 * 3) {
            currentSpeed = Math.floor(1024 * 500 + Math.random() * 1024 * 500);
          } else if (currentSpeed < 1024 * 50) {
            currentSpeed = 1024 * 100;
          }

          const increment = currentSpeed;
          const nextDownloaded = Math.min(item.downloaded + increment, item.size);
          const isFinished = nextDownloaded >= item.size;

          return {
            ...item,
            downloaded: nextDownloaded,
            status: isFinished ? 'completed' : 'downloading',
            speed: isFinished ? 0 : currentSpeed
          };
        })
      );
    }, 1000);

    return () => clearInterval(timer);
  }, [isDesktop, isPromptMode]);

  const handleUrlChange = (e) => {
    const url = e.target.value;
    setNewUrl(url);
    try {
      const parsedUrl = new URL(url);
      const pathname = parsedUrl.pathname;
      const filename = pathname.substring(pathname.lastIndexOf('/') + 1);
      if (filename && filename.includes('.')) {
        setNewName(decodeURIComponent(filename));
      } else {
        setNewName('download_file_' + Math.floor(Math.random() * 1000));
      }
    } catch {
      const parts = url.split('/');
      const lastPart = parts[parts.length - 1];
      if (lastPart && lastPart.includes('.')) {
        setNewName(lastPart);
      }
    }
  };

  const handleAddDownload = (e) => {
    e.preventDefault();
    if (!newUrl) return;

    let sizeInBytes = parseFloat(newSize) || 1024 * 1024 * 10;
    const multiplier = newSizeUnit === 'GB' ? 1024 * 1024 * 1024 : 1024 * 1024;
    sizeInBytes = Math.floor(sizeInBytes * multiplier);

    const name = newName.trim() || 'untitled_download_' + Date.now();
    const category = detectCategory(name);
    const saveFolder = customSavePath.trim() || defaultSavePath;

    const newItem = {
      id: Date.now().toString(),
      name,
      url: newUrl,
      size: sizeInBytes,
      downloaded: 0,
      status: 'downloading',
      speed: 0,
      category,
      savePath: saveFolder,
      addedAt: Date.now()
    };

    setDownloads([newItem, ...downloads]);
    setIsAddModalOpen(false);

    if (isDesktop && window.api.startDownload) {
      window.api.startDownload(newItem.id, newItem.url, saveFolder, name);
    } else {
      newItem.speed = Math.floor(1024 * 1024 * (2 + Math.random() * 8));
    }

    setNewUrl('');
    setNewName('');
    setNewSize('150');
    setNewSizeUnit('MB');
    setCustomSavePath('');
  };

  // Trigger from prompt popup confirmation
  const handlePromptConfirm = (e) => {
    e.preventDefault();
    if (isDesktop && window.api.confirmPromptDownload) {
      window.api.confirmPromptDownload({
        url: promptUrl,
        name: promptName,
        savePath: promptSavePath,
        cookies: promptCookies,
        referrer: promptReferrer
      });
    }
  };

  const handleSaveSettings = () => {
    localStorage.setItem('idm_default_save_path', defaultSavePath);
    if (isDesktop && window.api.saveAppConfig) {
      const extensions = extensionsString
        .split(',')
        .map(ext => ext.trim().toLowerCase())
        .filter(ext => ext !== '');

      window.api.saveAppConfig({
        isInterceptionEnabled,
        startWithWindows,
        extensions
      });
    }
    setIsSettingsOpen(false);
  };

  const handleOpenFolder = (item) => {
    if (isDesktop && window.api.openFolder) {
      window.api.openFolder(item.savePath);
    } else {
      alert(`Opening Save Directory:\n${item.savePath}\n\nSelected File:\n${item.name}`);
    }
  };

  const handlePause = (id) => {
    if (isDesktop && window.api.pauseDownload) {
      window.api.pauseDownload(id);
    } else {
      setDownloads((prev) =>
        prev.map((item) => (item.id === id ? { ...item, status: 'paused', speed: 0 } : item))
      );
    }
  };

  const handleResume = (id) => {
    const item = downloads.find((d) => d.id === id);
    if (!item) return;

    if (isDesktop && window.api.resumeDownload) {
      // Use dedicated resume IPC so the existing task resumes from the correct file path
      window.api.resumeDownload(id);
    } else {
      setDownloads((prev) =>
        prev.map((i) =>
          i.id === id
            ? {
                ...i,
                status: 'downloading',
                speed: Math.floor(1024 * 1024 * (1 + Math.random() * 5))
              }
            : i
        )
      );
    }
  };

  const handleStop = (id) => {
    if (isDesktop && window.api.cancelDownload) {
      window.api.cancelDownload(id);
    } else {
      setDownloads((prev) =>
        prev.map((item) => (item.id === id ? { ...item, status: 'failed', speed: 0 } : item))
      );
    }
  };

  const handleDelete = (id) => {
    if (isDesktop && window.api.cancelDownload) {
      window.api.cancelDownload(id);
    }
    setDownloads((prev) => prev.filter((item) => item.id !== id));
  };

  const handlePauseAll = () => {
    downloads.forEach((item) => {
      if (item.status === 'downloading') {
        handlePause(item.id);
      }
    });
  };

  const handleResumeAll = () => {
    downloads.forEach((item) => {
      if (item.status === 'paused' || item.status === 'failed') {
        handleResume(item.id);
      }
    });
  };

  const handleDeleteCompleted = () => {
    setDownloads((prev) => prev.filter((item) => item.status !== 'completed'));
  };

  const requestSort = (field) => {
    let order = 'asc';
    if (sortField === field && sortOrder === 'asc') {
      order = 'desc';
    }
    setSortField(field);
    setSortOrder(order);
  };

  const getCategoryCount = (category) => {
    if (category === 'all') return downloads.length;
    if (category === 'downloading') return downloads.filter((d) => d.status === 'downloading').length;
    if (category === 'completed') return downloads.filter((d) => d.status === 'completed').length;
    return downloads.filter((d) => d.category === category).length;
  };

  const filteredDownloads = downloads.filter((item) => {
    if (activeCategory === 'downloading' && item.status !== 'downloading') return false;
    if (activeCategory === 'completed' && item.status !== 'completed') return false;
    if (
      activeCategory !== 'all' &&
      activeCategory !== 'downloading' &&
      activeCategory !== 'completed' &&
      item.category !== activeCategory
    ) {
      return false;
    }

    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      return item.name.toLowerCase().includes(query) || item.url.toLowerCase().includes(query) || item.savePath.toLowerCase().includes(query);
    }

    return true;
  });

  const sortedDownloads = [...filteredDownloads].sort((a, b) => {
    let aValue = a[sortField];
    let bValue = b[sortField];

    if (sortField === 'progress') {
      aValue = a.downloaded / a.size;
      bValue = b.downloaded / b.size;
    } else if (sortField === 'eta') {
      if (a.status === 'completed') aValue = 0;
      else if (a.status === 'paused' || a.status === 'failed') aValue = 999999999;
      else aValue = (a.size - a.downloaded) / (a.speed || 1);

      if (b.status === 'completed') bValue = 0;
      else if (b.status === 'paused' || b.status === 'failed') bValue = 999999999;
      else bValue = (b.size - b.downloaded) / (b.speed || 1);
    }

    if (typeof aValue === 'string') {
      return sortOrder === 'asc'
        ? aValue.localeCompare(bValue)
        : bValue.localeCompare(aValue);
    } else {
      return sortOrder === 'asc' ? aValue - bValue : bValue - aValue;
    }
  });

  const totalFiles = downloads.length;
  const downloadingCount = downloads.filter((d) => d.status === 'downloading').length;
  const completedCount = downloads.filter((d) => d.status === 'completed').length;
  const totalSpeed = downloads.reduce((acc, curr) => acc + (curr.status === 'downloading' ? curr.speed : 0), 0);

  const getSortIcon = (field) => {
    if (sortField !== field) return null;
    return sortOrder === 'asc' ? <ChevronUp size={14} className="sort-indicator" /> : <ChevronDown size={14} className="sort-indicator" />;
  };


  // RENDER DEDICATED POPUP PROMPT WINDOW
  if (isPromptMode) {
    return (
      <div className="idm-window" style={{ height: '100vh', backgroundColor: '#14161f' }}>
        <form onSubmit={handlePromptConfirm} style={{ display: 'flex', flexDirection: 'column', height: '100%', boxSizing: 'border-box' }}>
          <header className="modal-header" style={{ padding: '12px 16px' }}>
            <h3 style={{ margin: 0, fontSize: '14px' }}>Start New Download</h3>
            <button type="button" className="close-btn" onClick={() => window.close()}>
              <X size={16} />
            </button>
          </header>
          <div className="modal-body" style={{ flex: 1, padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px', overflowY: 'auto' }}>
            <div className="form-group">
              <label htmlFor="prompt-url-input" style={{ fontSize: '11px', marginBottom: '2px' }}>Address (URL)</label>
              <input
                id="prompt-url-input"
                className="form-input"
                type="url"
                value={promptUrl}
                onChange={(e) => setPromptUrl(e.target.value)}
                required
                autoFocus
                style={{ padding: '8px 10px', fontSize: '12px' }}
              />
            </div>
            <div className="form-group">
              <label htmlFor="prompt-name-input" style={{ fontSize: '11px', marginBottom: '2px' }}>Save As (File Name)</label>
              <input
                id="prompt-name-input"
                className="form-input"
                type="text"
                value={promptName}
                onChange={(e) => setPromptName(e.target.value)}
                required
                style={{ padding: '8px 10px', fontSize: '12px' }}
              />
            </div>
            <div className="form-group">
              <label htmlFor="prompt-save-path-input" style={{ fontSize: '11px', marginBottom: '2px' }}>Save To (Folder Path)</label>
              <input
                id="prompt-save-path-input"
                className="form-input"
                type="text"
                value={promptSavePath}
                onChange={(e) => setPromptSavePath(e.target.value)}
                required
                style={{ padding: '8px 10px', fontSize: '12px' }}
              />
            </div>
          </div>
          <div className="modal-footer" style={{ borderTop: '1px solid var(--border-color)', padding: '12px 16px', display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
            <button type="button" className="btn btn-secondary" onClick={() => window.close()} style={{ padding: '6px 14px', fontSize: '12px' }}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" style={{ padding: '6px 14px', fontSize: '12px' }}>
              OK (Start Download)
            </button>
          </div>
        </form>
      </div>
    );
  }

  // RENDER MAIN APPLICATION LAYOUT
  return (
    <div className="idm-window">
      {/* Title bar */}
      <header className="idm-titlebar">
        <div className="idm-logo-group">
          <div className="idm-logo-icon">↓</div>
          <span className="idm-title">Internet Download Manager Lite v{appVersion}</span>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <span style={{ fontSize: '11px', color: 'var(--color-text-muted)', background: 'var(--bg-app)', padding: '2px 8px', borderRadius: '4px', border: '1px solid var(--border-color)' }}>
            {isDesktop ? 'Desktop Native Mode' : 'Web Browser Simulation Mode'}
          </span>
        </div>
      </header>

      {/* Update notification banner */}
      {updateInfo && (
        <div style={{
          background: 'linear-gradient(90deg, rgba(0,230,118,0.12) 0%, rgba(0,180,255,0.10) 100%)',
          borderBottom: '1px solid rgba(0,230,118,0.35)',
          padding: '8px 18px',
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          animation: 'slideDown 0.35s ease',
          position: 'relative',
          zIndex: 10
        }}>
          {/* Pulse dot */}
          <div style={{
            width: '8px', height: '8px', borderRadius: '50%',
            background: 'var(--idm-green)',
            boxShadow: '0 0 8px var(--idm-green)',
            animation: 'pulse 1.5s ease-in-out infinite',
            flexShrink: 0
          }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <span style={{ fontSize: '13px', fontWeight: 700, color: '#fff' }}>
              🎉 Phiên bản mới {updateInfo.latestVersion} có sẵn!
            </span>
            <span style={{ fontSize: '11px', color: 'var(--color-text-muted)', marginLeft: '10px' }}>
              (Hiện tại: v{updateInfo.currentVersion})
            </span>
            {updateInfo.releaseNotes && (
              <div style={{
                fontSize: '11px', color: 'var(--color-text-secondary)',
                marginTop: '2px', whiteSpace: 'nowrap',
                overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '500px'
              }}>
                {updateInfo.releaseNotes.split('\n')[0]}
              </div>
            )}
          </div>
          <button
            onClick={() => window.api?.openReleaseUrl(updateInfo.releaseUrl)}
            style={{
              background: 'linear-gradient(135deg, var(--idm-green), #00b4ff)',
              color: '#000', border: 'none', borderRadius: '6px',
              padding: '6px 18px', fontWeight: 800, fontSize: '12px',
              cursor: 'pointer', flexShrink: 0,
              boxShadow: '0 2px 12px rgba(0,230,118,0.4)',
              transition: 'all 0.2s'
            }}
            onMouseEnter={e => e.target.style.transform = 'scale(1.05)'}
            onMouseLeave={e => e.target.style.transform = 'scale(1)'}
          >
            ⬇ Tải cập nhật
          </button>
          <button
            onClick={() => setUpdateInfo(null)}
            title="Bỏ qua lần này"
            style={{
              background: 'transparent', border: 'none',
              color: 'var(--color-text-muted)', cursor: 'pointer',
              fontSize: '16px', padding: '2px 4px', lineHeight: 1,
              flexShrink: 0
            }}
          >
            ×
          </button>
        </div>
      )}

      {/* Extension Update notification banner */}
      {extensionStatus.needsUpdate && (
        <div style={{
          background: 'linear-gradient(90deg, rgba(255,179,0,0.12) 0%, rgba(255,82,82,0.10) 100%)',
          borderBottom: '1px solid rgba(255,179,0,0.35)',
          padding: '8px 18px',
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          animation: 'slideDown 0.35s ease',
          position: 'relative',
          zIndex: 10
        }}>
          {/* Warning dot */}
          <div style={{
            width: '8px', height: '8px', borderRadius: '50%',
            background: 'var(--status-paused)',
            boxShadow: '0 0 8px var(--status-paused)',
            animation: 'pulse-soft 1.5s ease-in-out infinite',
            flexShrink: 0
          }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <span style={{ fontSize: '13px', fontWeight: 700, color: '#fff' }}>
              ⚠️ Phát hiện Extension IDM Lite trên trình duyệt của bạn đã cũ!
            </span>
            <span style={{ fontSize: '11px', color: 'var(--color-text-muted)', marginLeft: '10px' }}>
              (Bản mới: v{extensionStatus.bundledVersion} • Bản hiện tại: v{extensionStatus.installedVersion})
            </span>
            <div style={{ fontSize: '11px', color: 'var(--color-text-secondary)', marginTop: '2px' }}>
              Vui lòng vào Cài đặt để xuất và cập nhật lại extension trên trình duyệt của bạn.
            </div>
          </div>
          <button
            onClick={() => {
              setIsSettingsOpen(true);
              setSettingsTab('general'); // Switch to settings tab containing instructions
            }}
            style={{
              background: 'linear-gradient(135deg, var(--status-paused), #ff5252)',
              color: '#000', border: 'none', borderRadius: '6px',
              padding: '6px 18px', fontWeight: 800, fontSize: '12px',
              cursor: 'pointer', flexShrink: 0,
              boxShadow: '0 2px 12px rgba(255,179,0,0.4)',
              transition: 'all 0.2s'
            }}
            onMouseEnter={e => e.target.style.transform = 'scale(1.05)'}
            onMouseLeave={e => e.target.style.transform = 'scale(1)'}
          >
            ⚙️ Vào Cài đặt
          </button>
          <button
            onClick={() => setExtensionStatus(prev => ({ ...prev, needsUpdate: false }))}
            title="Bỏ qua"
            style={{
              background: 'transparent', border: 'none',
              color: 'var(--color-text-muted)', cursor: 'pointer',
              fontSize: '16px', padding: '2px 4px', lineHeight: 1,
              flexShrink: 0
            }}
          >
            ×
          </button>
        </div>
      )}

      {/* Toolbar */}
      <section className="idm-toolbar">
        <div className="toolbar-actions">
          <button className="toolbar-btn" onClick={() => {
            setCustomSavePath(defaultSavePath);
            setIsAddModalOpen(true);
          }}>
            <Plus />
            <span>Add URL</span>
          </button>
          <div className="toolbar-divider" />
          <button className="toolbar-btn" onClick={handleResumeAll} disabled={downloads.filter(d => d.status === 'paused' || d.status === 'failed').length === 0}>
            <Play />
            <span>Resume All</span>
          </button>
          <button className="toolbar-btn" onClick={handlePauseAll} disabled={downloadingCount === 0}>
            <Pause />
            <span>Pause All</span>
          </button>
          <div className="toolbar-divider" />
          <button className="toolbar-btn" onClick={() => setIsSettingsOpen(true)}>
            <Settings />
            <span>Settings</span>
          </button>
          <button className="toolbar-btn btn-danger" onClick={handleDeleteCompleted} disabled={completedCount === 0}>
            <Trash2 />
            <span>Clear Done</span>
          </button>
        </div>

        {/* Search filter */}
        <div className="search-box">
          <Search className="search-icon" />
          <input
            type="text"
            placeholder="Search name, URL or path..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
      </section>

      {/* App Body */}
      <div className="idm-body">
        {/* Sidebar */}
        <aside className="idm-sidebar">
          <div className="sidebar-section-title">Categories</div>
          <ul className="sidebar-menu">
            <li
              className={`sidebar-item ${activeCategory === 'all' ? 'active' : ''}`}
              onClick={() => setActiveCategory('all')}
            >
              <div className="sidebar-item-content">
                <FolderOpen size={16} />
                <span>All Downloads</span>
              </div>
              <span className="sidebar-badge">{getCategoryCount('all')}</span>
            </li>
            <li
              className={`sidebar-item ${activeCategory === 'downloading' ? 'active' : ''}`}
              onClick={() => setActiveCategory('downloading')}
            >
              <div className="sidebar-item-content">
                <RefreshCw size={16} />
                <span>Downloading</span>
              </div>
              <span className="sidebar-badge">{getCategoryCount('downloading')}</span>
            </li>
            <li
              className={`sidebar-item ${activeCategory === 'completed' ? 'active' : ''}`}
              onClick={() => setActiveCategory('completed')}
            >
              <div className="sidebar-item-content">
                <CheckCircle size={16} />
                <span>Completed</span>
              </div>
              <span className="sidebar-badge">{getCategoryCount('completed')}</span>
            </li>
          </ul>

          <div className="sidebar-section-title">File Types</div>
          <ul className="sidebar-menu">
            <li
              className={`sidebar-item ${activeCategory === 'document' ? 'active' : ''}`}
              onClick={() => setActiveCategory('document')}
            >
              <div className="sidebar-item-content">
                <FileText size={16} />
                <span>Documents</span>
              </div>
              <span className="sidebar-badge">{getCategoryCount('document')}</span>
            </li>
            <li
              className={`sidebar-item ${activeCategory === 'video' ? 'active' : ''}`}
              onClick={() => setActiveCategory('video')}
            >
              <div className="sidebar-item-content">
                <Video size={16} />
                <span>Videos</span>
              </div>
              <span className="sidebar-badge">{getCategoryCount('video')}</span>
            </li>
            <li
              className={`sidebar-item ${activeCategory === 'music' ? 'active' : ''}`}
              onClick={() => setActiveCategory('music')}
            >
              <div className="sidebar-item-content">
                <Music size={16} />
                <span>Music</span>
              </div>
              <span className="sidebar-badge">{getCategoryCount('music')}</span>
            </li>
            <li
              className={`sidebar-item ${activeCategory === 'program' ? 'active' : ''}`}
              onClick={() => setActiveCategory('program')}
            >
              <div className="sidebar-item-content">
                <Cpu size={16} />
                <span>Programs</span>
              </div>
              <span className="sidebar-badge">{getCategoryCount('program')}</span>
            </li>
          </ul>
        </aside>

        {/* Table list */}
        <main className="idm-main">
          <div className="table-container">
            {sortedDownloads.length === 0 ? (
              <div className="empty-placeholder">
                <Download size={48} />
                <p style={{ fontSize: '15px', fontWeight: 600, color: 'var(--color-text-primary)' }}>
                  No downloads found
                </p>
                <p style={{ fontSize: '13px', maxWidth: '300px' }}>
                  {searchQuery ? 'Try matching another name, URL or path.' : 'Click "Add URL" to start a new download.'}
                </p>
              </div>
            ) : (
              <table className="idm-table">
                <thead>
                  <tr>
                    <th style={{ width: '30%' }} onClick={() => requestSort('name')}>
                      File Name {getSortIcon('name')}
                    </th>
                    <th style={{ width: '10%' }} onClick={() => requestSort('size')}>
                      Size {getSortIcon('size')}
                    </th>
                    <th style={{ width: '18%' }} onClick={() => requestSort('progress')}>
                      Progress {getSortIcon('progress')}
                    </th>
                    <th style={{ width: '14%' }} onClick={() => requestSort('status')}>
                      Status {getSortIcon('status')}
                    </th>
                    <th style={{ width: '10%' }} onClick={() => requestSort('speed')}>
                      Speed {getSortIcon('speed')}
                    </th>
                    <th style={{ width: '10%' }} onClick={() => requestSort('eta')}>
                      Time Left {getSortIcon('eta')}
                    </th>
                    <th style={{ width: '8%', textAlign: 'center' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedDownloads.map((item) => {
                    const percent = item.size > 0 ? Math.floor((item.downloaded / item.size) * 100) : 0;
                    return (
                      <tr key={item.id}>
                        <td>
                          <div className="file-name-cell">
                            {getFileIcon(item.name, item.category)}
                            <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0, flex: 1 }}>
                              <span style={{ fontWeight: '600', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap', display: 'block' }} title={item.name}>
                                {item.name}
                              </span>
                              <span style={{ fontSize: '11px', color: 'var(--color-text-muted)', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap', display: 'block' }} title={`Save path: ${item.savePath}`}>
                                Path: {item.savePath}
                              </span>
                              {item.status === 'failed' && item.errorMsg && (
                                <span style={{ fontSize: '11px', color: '#ff4d4d', fontWeight: 'bold', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap', display: 'block' }} title={item.errorMsg}>
                                  Lỗi: {item.errorMsg}
                                </span>
                              )}
                            </div>
                          </div>
                        </td>
                        <td>{item.size > 0 ? formatBytes(item.size) : 'Unknown'}</td>
                        <td>
                          <div className="progress-bar-wrapper">
                            {item.segments && item.segments.length > 0 && item.status === 'downloading' ? (
                              <div className="segments-track">
                                {item.segments.map((seg) => {
                                  const segSize = seg.endPos - seg.startPos + 1;
                                  const segPercent = segSize > 0 ? Math.min(100, Math.floor((seg.downloaded / segSize) * 100)) : 0;
                                  return (
                                    <div
                                      key={seg.index}
                                      style={{
                                        flex: 1,
                                        height: '100%',
                                        backgroundColor: seg.completed ? 'var(--idm-green)' : '#5cff9c',
                                        opacity: seg.completed ? 1 : 0.15 + (segPercent / 100) * 0.85,
                                        borderRadius: '1px',
                                        transition: 'all 0.1s ease',
                                        boxShadow: segPercent > 0 && !seg.completed ? '0 0 4px var(--idm-green-glow)' : 'none'
                                      }}
                                      title={`Segment ${seg.index + 1}: ${segPercent}%`}
                                    />
                                  );
                                })}
                              </div>
                            ) : (
                              <div className="progress-track">
                                <div
                                  className={`progress-fill ${
                                    item.status === 'downloading' || item.status === 'merging' ? 'active' : ''
                                  } ${
                                    item.status === 'paused' ? 'paused' : ''
                                  } ${
                                    item.status === 'failed' ? 'failed' : ''
                                  } ${
                                    item.status === 'merging' ? 'merging' : ''
                                  }`}
                                  style={{ width: `${item.status === 'merging' ? 100 : percent}%` }}
                                />
                              </div>
                            )}
                            <span className="progress-percent">
                              {item.status === 'merging' ? 'Merging segments...' : `${percent}% (${formatBytes(item.downloaded)} done)`}
                            </span>
                          </div>
                        </td>
                        <td>
                          <span className={`status-tag ${item.status}`}>
                            {(item.status === 'downloading' || item.status === 'merging') && <RefreshCw size={10} style={{ animation: 'spin 2s linear infinite' }} />}
                            {item.status === 'completed' && <CheckCircle size={10} />}
                            {item.status === 'failed' && <AlertCircle size={10} />}
                            {item.status}
                          </span>
                        </td>
                        <td>
                          <span style={{ color: item.status === 'downloading' ? 'var(--idm-green)' : 'inherit', fontWeight: item.status === 'downloading' ? 600 : 'normal' }}>
                            {item.status === 'downloading' ? formatSpeed(item.speed) : '0 KB/s'}
                          </span>
                        </td>
                        <td>{formatETA(item)}</td>
                        <td>
                          <div className="row-actions">
                            {item.status === 'downloading' && (
                              <button
                                className="action-icon-btn pause"
                                onClick={() => handlePause(item.id)}
                                title="Pause"
                              >
                                <Pause size={14} />
                              </button>
                            )}
                            {(item.status === 'paused' || item.status === 'failed') && (
                              <button
                                className="action-icon-btn play"
                                onClick={() => handleResume(item.id)}
                                title="Resume/Start"
                              >
                                <Play size={14} />
                              </button>
                            )}
                            {item.status === 'downloading' && (
                              <button
                                className="action-icon-btn"
                                onClick={() => handleStop(item.id)}
                                title="Stop/Cancel"
                              >
                                <X size={14} />
                              </button>
                            )}
                            {item.status === 'completed' && (
                              <button
                                className="action-icon-btn"
                                onClick={() => handleOpenFolder(item)}
                                title="Open Folder location"
                                style={{ color: '#ffb300' }}
                              >
                                <Folder size={14} />
                              </button>
                            )}
                            <button
                              className="action-icon-btn delete"
                              onClick={() => handleDelete(item.id)}
                              title="Delete from list"
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </main>
      </div>

      {/* Footer / Status bar */}
      <footer className="idm-statusbar">
        <div className="stats-left">
          <div className="stats-item">
            <span>Files:</span>
            <strong style={{ color: '#fff' }}>{totalFiles}</strong>
          </div>
          <div className="stats-item">
            <span>Downloading:</span>
            <strong style={{ color: 'var(--status-downloading)' }}>{downloadingCount}</strong>
          </div>
          <div className="stats-item">
            <span>Completed:</span>
            <strong style={{ color: 'var(--status-completed)' }}>{completedCount}</strong>
          </div>
        </div>
        <div style={{ flex: 1, textAlign: 'center', fontSize: '11px', color: 'var(--color-text-muted)', opacity: 0.8 }}>
          Developed by <strong style={{ color: 'var(--idm-green)' }}>HuyTran1002</strong>
        </div>
        <div className="stats-right">
          {totalSpeed > 0 ? (
            <>
              <span className="stats-speed-pulse" />
              <span>Total Speed:</span>
              <span style={{ color: 'var(--idm-green)' }}>{formatSpeed(totalSpeed)}</span>
            </>
          ) : (
            <span style={{ color: 'var(--color-text-muted)' }}>Idle</span>
          )}
        </div>
      </footer>

      {/* Add URL Modal */}
      {isAddModalOpen && (
        <div className="modal-overlay">
          <div className="modal-content">
            <div className="modal-header">
              <h3>Enter new address to download</h3>
              <button className="close-btn" onClick={() => setIsAddModalOpen(false)}>
                <X size={18} />
              </button>
            </div>
            <form onSubmit={handleAddDownload}>
              <div className="modal-body">
                <div className="form-group">
                  <label htmlFor="url-input">Address (URL)</label>
                  <input
                    id="url-input"
                    className="form-input"
                    type="url"
                    placeholder="https://example.com/file.zip"
                    value={newUrl}
                    onChange={handleUrlChange}
                    required
                    autoFocus
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="name-input">Save As (File Name)</label>
                  <input
                    id="name-input"
                    className="form-input"
                    type="text"
                    placeholder="filename.zip"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    required
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="save-path-input">Save To (Folder Path)</label>
                  <input
                    id="save-path-input"
                    className="form-input"
                    type="text"
                    value={customSavePath}
                    onChange={(e) => setCustomSavePath(e.target.value)}
                    placeholder="C:\Downloads"
                    required
                  />
                </div>
                {!isDesktop && (
                  <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '12px' }}>
                    <div className="form-group">
                      <label htmlFor="size-input">Simulated File Size</label>
                      <input
                        id="size-input"
                        className="form-input"
                        type="number"
                        min="1"
                        step="any"
                        value={newSize}
                        onChange={(e) => setNewSize(e.target.value)}
                        required
                      />
                    </div>
                    <div className="form-group">
                      <label htmlFor="unit-input">Unit</label>
                      <select
                        id="unit-input"
                        className="form-input"
                        value={newSizeUnit}
                        onChange={(e) => setNewSizeUnit(e.target.value)}
                        style={{ background: 'var(--bg-app)', color: '#fff' }}
                      >
                        <option value="MB">MB</option>
                        <option value="GB">GB</option>
                      </select>
                    </div>
                  </div>
                )}
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setIsAddModalOpen(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary">
                  OK (Start Download)
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Global Settings Modal */}
      {isSettingsOpen && (
        <div className="modal-overlay">
          <div className="modal-content" style={{ maxWidth: '600px' }}>
            <div className="modal-header">
              <h3>IDM Configuration Options</h3>
              <button className="close-btn" onClick={() => setIsSettingsOpen(false)}>
                <X size={18} />
              </button>
            </div>
            
            <div style={{ display: 'flex', borderBottom: '1px solid var(--border-color)', backgroundColor: '#1a1c29' }}>
              <button
                className={`btn`}
                style={{
                  borderRadius: 0,
                  borderBottom: settingsTab === 'general' ? '2px solid var(--idm-green)' : 'none',
                  color: settingsTab === 'general' ? '#fff' : 'var(--color-text-muted)',
                  background: 'transparent',
                  padding: '12px 20px',
                  fontWeight: 600
                }}
                onClick={() => setSettingsTab('general')}
              >
                General Settings
              </button>
              <button
                className={`btn`}
                style={{
                  borderRadius: 0,
                  borderBottom: settingsTab === 'browser' ? '2px solid var(--idm-green)' : 'none',
                  color: settingsTab === 'browser' ? '#fff' : 'var(--color-text-muted)',
                  background: 'transparent',
                  padding: '12px 20px',
                  fontWeight: 600,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px'
                }}
                onClick={() => setSettingsTab('browser')}
              >
                <Globe size={14} />
                Browser Intercept
              </button>
            </div>

            <div className="modal-body" style={{ maxHeight: '420px', overflowY: 'auto' }}>
              {settingsTab === 'general' ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                  <div className="form-group">
                    <label htmlFor="default-path-input">Default Download Directory</label>
                    <input
                      id="default-path-input"
                      className="form-input"
                      type="text"
                      value={defaultSavePath}
                      onChange={(e) => setDefaultSavePath(e.target.value)}
                      placeholder="e.g. C:\Downloads"
                    />
                    <span style={{ fontSize: '11px', color: 'var(--color-text-muted)', marginTop: '4px' }}>
                      All new downloads will use this path as the default location.
                    </span>
                  </div>

                  {isDesktop && (
                    <>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', padding: '8px 0' }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '13px' }}>
                          <input
                            type="checkbox"
                            checked={startWithWindows}
                            onChange={(e) => setStartWithWindows(e.target.checked)}
                            style={{ accentColor: 'var(--idm-green)' }}
                          />
                          Launch IDM Lite automatically when Windows starts
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '13px' }}>
                          <input
                            type="checkbox"
                            checked={isInterceptionEnabled}
                            onChange={(e) => setIsInterceptionEnabled(e.target.checked)}
                            style={{ accentColor: 'var(--idm-green)' }}
                          />
                          Enable automatic link capture from browser downloads
                        </label>
                      </div>

                      <div className="form-group">
                        <label htmlFor="extensions-input">Capture Link Extensions (comma separated)</label>
                        <textarea
                          id="extensions-input"
                          className="form-input"
                          rows="3"
                          value={extensionsString}
                          onChange={(e) => setExtensionsString(e.target.value)}
                          style={{ resize: 'vertical', fontFamily: 'monospace', fontSize: '12px' }}
                          placeholder="zip, rar, exe, msi, dmg, iso, mp4, mp3, pdf"
                        />
                        <span style={{ fontSize: '11px', color: 'var(--color-text-muted)', marginTop: '4px' }}>
                          Chrome extension will intercept files ending with these extensions and load them into IDM Lite.
                        </span>
                      </div>
                    </>
                  )}
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                  {/* Header */}
                  <div style={{
                    background: 'linear-gradient(135deg, rgba(0,230,118,0.08), rgba(0,230,118,0.03))',
                    border: '1px solid rgba(0,230,118,0.2)',
                    borderRadius: '8px',
                    padding: '14px 16px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px'
                  }}>
                    <div style={{
                      background: 'var(--idm-green)',
                      color: '#000',
                      width: '36px', height: '36px',
                      borderRadius: '8px',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: '18px', fontWeight: 'bold', flexShrink: 0
                    }}>↓</div>
                    <div>
                      <div style={{ fontSize: '13px', fontWeight: '700', color: '#fff', marginBottom: '2px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                        IDM Lite Chrome Extension
                        <span style={{
                          fontSize: '9px',
                          background: 'rgba(255,255,255,0.06)',
                          color: 'var(--color-text-secondary)',
                          padding: '1px 5px',
                          borderRadius: '4px',
                          border: '1px solid var(--border-color)'
                        }}>
                          Bản đi kèm: v{extensionStatus.bundledVersion}
                        </span>
                        <span style={{
                          fontSize: '9px',
                          background: extensionStatus.needsUpdate ? 'rgba(255,179,0,0.12)' : 'rgba(0,230,118,0.08)',
                          color: extensionStatus.needsUpdate ? 'var(--status-paused)' : 'var(--idm-green)',
                          padding: '1px 5px',
                          borderRadius: '4px',
                          border: extensionStatus.needsUpdate ? '1px solid rgba(255,179,0,0.25)' : '1px solid rgba(0,230,118,0.2)',
                          fontWeight: '600'
                        }}>
                          Đang chạy: v{extensionStatus.installedVersion}
                        </span>
                        {extensionStatus.needsUpdate && (
                          <span style={{
                            fontSize: '9px',
                            background: 'rgba(255,82,82,0.12)',
                            color: '#ff5252',
                            padding: '1px 5px',
                            borderRadius: '4px',
                            border: '1px solid rgba(255,82,82,0.25)',
                            fontWeight: 'bold'
                          }}>
                            Yêu cầu cập nhật!
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>
                        Tự động bắt link tải từ trình duyệt và chuyển thẳng về IDM Lite • Developed by HuyTran1002
                      </div>
                    </div>
                  </div>

                  {/* Steps */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    {[
                      {
                        step: '1',
                        title: 'Tải thư mục Extension',
                        desc: 'Bấm nút bên dưới để chọn nơi lưu thư mục extension IDM Lite trên máy tính của bạn.',
                        action: isDesktop ? (
                          <button
                            className="btn btn-primary"
                            style={{
                              fontSize: '12px',
                              padding: '7px 16px',
                              display: 'flex',
                              alignItems: 'center',
                              gap: '6px',
                              width: 'fit-content'
                            }}
                            onClick={async () => {
                              if (window.api.exportExtensionFolder) {
                                const res = await window.api.exportExtensionFolder();
                                if (res.success) {
                                  alert(`Đã tải và lưu thư mục extension thành công tại: ${res.path}`);
                                } else if (res.error && res.error !== 'Đã hủy chọn thư mục.') {
                                  alert(`Lỗi: ${res.error}`);
                                }
                              }
                            }}
                          >
                            <Download size={14} />
                            Tải Thư Mục Extension Về Máy
                          </button>
                        ) : null
                      },
                      {
                        step: '2',
                        title: 'Mở Chrome Extensions',
                        desc: 'Trên Chrome, gõ vào thanh địa chỉ: chrome://extensions/ rồi nhấn Enter.',
                        code: 'chrome://extensions/'
                      },
                      {
                        step: '3',
                        title: 'Bật Developer Mode',
                        desc: 'Bật công tắc "Developer mode" ở góc trên bên phải trang Extensions.'
                      },
                      {
                        step: '4',
                        title: 'Load Unpacked',
                        desc: 'Bấm "Load unpacked", chọn thư mục extension vừa mở ở Bước 1. Extension sẽ được cài ngay lập tức!'
                      }
                    ].map(({ step, title, desc, action, code }) => (
                      <div key={step} style={{
                        display: 'flex',
                        gap: '12px',
                        padding: '12px',
                        background: 'rgba(255,255,255,0.02)',
                        borderRadius: '6px',
                        border: '1px solid var(--border-color)'
                      }}>
                        <div style={{
                          width: '24px', height: '24px',
                          background: 'var(--idm-green)', color: '#000',
                          borderRadius: '50%', display: 'flex',
                          alignItems: 'center', justifyContent: 'center',
                          fontSize: '12px', fontWeight: '800', flexShrink: 0
                        }}>{step}</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', flex: 1 }}>
                          <div style={{ fontSize: '13px', fontWeight: '600', color: '#fff' }}>{title}</div>
                          <div style={{ fontSize: '12px', color: 'var(--color-text-secondary)' }}>{desc}</div>
                          {code && (
                            <code style={{
                              background: 'var(--bg-app)', padding: '4px 8px',
                              borderRadius: '4px', fontSize: '12px',
                              color: 'var(--idm-green)', fontFamily: 'monospace',
                              border: '1px solid var(--border-color)',
                              width: 'fit-content'
                            }}>{code}</code>
                          )}
                          {action}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn btn-primary" onClick={handleSaveSettings}>
                Save & Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
