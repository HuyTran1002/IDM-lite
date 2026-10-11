const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  isElectron: true,
  startDownload: (id, url, saveFolder, fileName, cookies, referrer, userAgent) => ipcRenderer.send('start-download', { id, url, saveFolder, fileName, cookies, referrer, userAgent }),
  pauseDownload: (id) => ipcRenderer.send('pause-download', id),
  resumeDownload: (id) => ipcRenderer.send('resume-download', id),
  onDownloadNeedsRestart: (callback) => {
    const subscription = (event, value) => callback(event, value);
    ipcRenderer.on('download-needs-restart', subscription);
    return () => {
      ipcRenderer.removeListener('download-needs-restart', subscription);
    };
  },
  cancelDownload: (id) => ipcRenderer.send('cancel-download', id),
  openFolder: (folderPath) => ipcRenderer.send('open-folder', folderPath),
  confirmPromptDownload: (data) => ipcRenderer.send('confirm-prompt-download', data),
  openExtensionFolder: () => ipcRenderer.send('open-extension-folder'),
  exportExtensionFolder: () => ipcRenderer.invoke('export-extension-folder'),
  getExtensionPath: () => ipcRenderer.invoke('get-extension-path'),
  onDownloadProgress: (callback) => {
    const subscription = (event, value) => callback(event, value);
    ipcRenderer.on('download-progress', subscription);
    return () => {
      ipcRenderer.removeListener('download-progress', subscription);
    };
  },
  onCaptureDownload: (callback) => {
    const subscription = (event, value) => callback(event, value);
    ipcRenderer.on('capture-download', subscription);
    return () => {
      ipcRenderer.removeListener('capture-download', subscription);
    };
  },
  onInitPrompt: (callback) => {
    const subscription = (event, value) => callback(event, value);
    ipcRenderer.on('init-prompt', subscription);
    return () => {
      ipcRenderer.removeListener('init-prompt', subscription);
    };
  },
  getAppConfig: () => ipcRenderer.invoke('get-app-config'),
  saveAppConfig: (config) => ipcRenderer.invoke('save-app-config', config),
  onConfigChanged: (callback) => {
    const subscription = (event, value) => callback(event, value);
    ipcRenderer.on('config-changed', subscription);
    return () => ipcRenderer.removeListener('config-changed', subscription);
  },
  onUpdateAvailable: (callback) => {
    const subscription = (event, value) => callback(event, value);
    ipcRenderer.on('update-available', subscription);
    return () => ipcRenderer.removeListener('update-available', subscription);
  },
  onUpdateNotAvailable: (callback) => {
    const subscription = (event, value) => callback(event, value);
    ipcRenderer.on('update-not-available', subscription);
    return () => ipcRenderer.removeListener('update-not-available', subscription);
  },
  startAppUpdate: (updateInfo) => ipcRenderer.send('start-app-update', updateInfo),
  cancelAppUpdate: () => ipcRenderer.send('cancel-app-update'),
  onUpdateDownloadProgress: (callback) => {
    const subscription = (event, value) => callback(event, value);
    ipcRenderer.on('update-download-progress', subscription);
    return () => ipcRenderer.removeListener('update-download-progress', subscription);
  },
  onUpdateDownloadComplete: (callback) => {
    const subscription = (event, value) => callback(event, value);
    ipcRenderer.on('update-download-complete', subscription);
    return () => ipcRenderer.removeListener('update-download-complete', subscription);
  },
  onUpdateError: (callback) => {
    const subscription = (event, value) => callback(event, value);
    ipcRenderer.on('update-error', subscription);
    return () => ipcRenderer.removeListener('update-error', subscription);
  },
  openReleaseUrl: (url) => ipcRenderer.send('open-release-url', url),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  getVersion: () => ipcRenderer.invoke('get-version'),
  getExtensionStatus: () => ipcRenderer.invoke('get-extension-status'),
  onExtensionStatusUpdate: (callback) => {
    const subscription = (event, value) => callback(event, value);
    ipcRenderer.on('extension-status-update', subscription);
    return () => {
      ipcRenderer.removeListener('extension-status-update', subscription);
    };
  }
});
