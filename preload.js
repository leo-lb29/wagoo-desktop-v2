const { contextBridge, ipcRenderer } = require("electron");




contextBridge.exposeInMainWorld("electron", {
  isElectron: true,
  minimize: () => ipcRenderer.send("window:minimize"),
  maximize: () => ipcRenderer.send("window:maximize"),
  close: () => ipcRenderer.send("window:close"),
  updateAvailable: (callback) =>
    ipcRenderer.on("app:updateAvailable", callback),
});

contextBridge.exposeInMainWorld("updater", {
  // Méthodes pour contrôler les mises à jour
  checkForUpdates: () => ipcRenderer.invoke("updater:check"),
  downloadUpdate: () => ipcRenderer.invoke("updater:download"),
  installUpdate: () => ipcRenderer.invoke("updater:install"),

  // Listeners pour les événements
  onChecking: (callback) => {
    ipcRenderer.on("updater:checking", callback);
    return () => ipcRenderer.removeListener("updater:checking", callback);
  },

  onUpdateAvailable: (callback) => {
    ipcRenderer.on("updater:available", (event, data) => callback(data));
    return () => ipcRenderer.removeListener("updater:available", callback);
  },

  onUpdateNotAvailable: (callback) => {
    ipcRenderer.on("updater:not-available", callback);
    return () => ipcRenderer.removeListener("updater:not-available", callback);
  },

  onDownloadProgress: (callback) => {
    ipcRenderer.on("updater:progress", (event, data) => callback(data));
    return () => ipcRenderer.removeListener("updater:progress", callback);
  },

  onUpdateDownloaded: (callback) => {
    ipcRenderer.on("updater:downloaded", (event, data) => callback(data));
    return () => ipcRenderer.removeListener("updater:downloaded", callback);
  },

  onError: (callback) => {
    ipcRenderer.on("updater:error", (event, data) => callback(data));
    return () => ipcRenderer.removeListener("updater:error", callback);
  },
});

contextBridge.exposeInMainWorld("electronAPI", {
  getAppInfo: async () => ({
    nameProduct: "Wagoo Desktop",
    version: await ipcRenderer.invoke("app:getVersion"),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    v8: process.versions.v8,
    platform: process.platform,
    arch: process.arch,
  }),
});