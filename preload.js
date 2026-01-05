// preload.js - Version Sécurisée et Professionnelle
const { contextBridge, ipcRenderer } = require("electron");

/**
 * Validation des callbacks pour éviter les injections
 * @param {Function} callback - Callback à valider
 * @returns {boolean}
 */
function isValidCallback(callback) {
  return typeof callback === "function";
}

/**
 * Crée un listener IPC sécurisé avec nettoyage automatique
 * @param {string} channel - Canal IPC
 * @param {Function} callback - Fonction de rappel
 * @returns {Function} Fonction de nettoyage
 */
function createSecureListener(channel, callback) {
  if (!isValidCallback(callback)) {
    console.error(`[Preload] Callback invalide pour ${channel}`);
    return () => {};
  }

  const handler = (event, ...args) => {
    try {
      callback(...args);
    } catch (err) {
      console.error(`[Preload] Erreur dans le callback ${channel}:`, err);
    }
  };

  ipcRenderer.on(channel, handler);

  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

// ========================================
// API ELECTRON (Contrôles fenêtre)
// ========================================

contextBridge.exposeInMainWorld("electron", {
  isElectron: true,

  // Contrôles de la fenêtre
  minimize: () => {
    try {
      ipcRenderer.send("window:minimize");
    } catch (err) {
      console.error("[Electron] Erreur minimize:", err);
    }
  },

  maximize: () => {
    try {
      ipcRenderer.send("window:maximize");
    } catch (err) {
      console.error("[Electron] Erreur maximize:", err);
    }
  },

  close: () => {
    try {
      ipcRenderer.send("window:close");
    } catch (err) {
      console.error("[Electron] Erreur close:", err);
    }
  },

  // Listener pour les mises à jour (conservé pour compatibilité)
  updateAvailable: (callback) => {
    return createSecureListener("app:updateAvailable", callback);
  },
});

// ========================================
// API UPDATER (Mises à jour)
// ========================================

contextBridge.exposeInMainWorld("updater", {
  /**
   * Vérifie les mises à jour disponibles
   * @returns {Promise<Object>}
   */
  checkForUpdates: async () => {
    try {
      return await ipcRenderer.invoke("updater:check");
    } catch (err) {
      console.error("[Updater] Erreur checkForUpdates:", err);
      return { success: false, error: err.message };
    }
  },

  /**
   * Télécharge une mise à jour
   * @returns {Promise<Object>}
   */
  downloadUpdate: async () => {
    try {
      return await ipcRenderer.invoke("updater:download");
    } catch (err) {
      console.error("[Updater] Erreur downloadUpdate:", err);
      return { success: false, error: err.message };
    }
  },

  /**
   * Installe la mise à jour et redémarre l'application
   * @returns {Promise<Object>}
   */
  installUpdate: async () => {
    try {
      return await ipcRenderer.invoke("updater:install");
    } catch (err) {
      console.error("[Updater] Erreur installUpdate:", err);
      return { success: false, error: err.message };
    }
  },

  // Listeners pour les événements de mise à jour

  /**
   * Écoute l'événement de vérification en cours
   * @param {Function} callback
   * @returns {Function} Fonction de nettoyage
   */
  onChecking: (callback) => {
    return createSecureListener("updater:checking", callback);
  },

  /**
   * Écoute l'événement de mise à jour disponible
   * @param {Function} callback
   * @returns {Function} Fonction de nettoyage
   */
  onUpdateAvailable: (callback) => {
    return createSecureListener("updater:available", callback);
  },

  /**
   * Écoute l'événement d'aucune mise à jour disponible
   * @param {Function} callback
   * @returns {Function} Fonction de nettoyage
   */
  onUpdateNotAvailable: (callback) => {
    return createSecureListener("updater:not-available", callback);
  },

  /**
   * Écoute la progression du téléchargement
   * @param {Function} callback
   * @returns {Function} Fonction de nettoyage
   */
  onDownloadProgress: (callback) => {
    return createSecureListener("updater:progress", callback);
  },

  /**
   * Écoute l'événement de téléchargement terminé
   * @param {Function} callback
   * @returns {Function} Fonction de nettoyage
   */
  onUpdateDownloaded: (callback) => {
    return createSecureListener("updater:downloaded", callback);
  },

  /**
   * Écoute les erreurs du système de mise à jour
   * @param {Function} callback
   * @returns {Function} Fonction de nettoyage
   */
  onError: (callback) => {
    return createSecureListener("updater:error", callback);
  },
});

// ========================================
// API ELECTRON (Informations et Connexions)
// ========================================

contextBridge.exposeInMainWorld("electronAPI", {
  /**
   * Récupère les informations de l'application
   * @returns {Promise<Object>}
   */
  getAppInfo: async () => {
    try {
      const version = await ipcRenderer.invoke("app:getVersion");
      return {
        nameProduct: "Wagoo Desktop",
        version,
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
        v8: process.versions.v8,
        platform: process.platform,
        arch: process.arch,
      };
    } catch (err) {
      console.error("[ElectronAPI] Erreur getAppInfo:", err);
      return {
        nameProduct: "Wagoo Desktop",
        version: "unknown",
        error: err.message,
      };
    }
  },

  /**
   * Écoute les changements de statut des connexions
   * @param {Function} callback
   * @returns {Function} Fonction de nettoyage
   */
  onConnectionStatus: (callback) => {
    return createSecureListener("connection:status", callback);
  },

  /**
   * Écoute les messages WebSocket
   * @param {Function} callback
   * @returns {Function} Fonction de nettoyage
   */
  onWebSocketMessage: (callback) => {
    return createSecureListener("ws:message", callback);
  },

  /**
   * Écoute les QR codes scannés
   * @param {Function} callback
   * @returns {Function} Fonction de nettoyage
   */
  onQRScanned: (callback) => {
    return createSecureListener("qr:scanned", callback);
  },
});

// ========================================
// API WEBSOCKET (Communication réseau)
// ========================================

contextBridge.exposeInMainWorld("webSocketAPI", {
  /**
   * Envoie un message via WebSocket
   * @param {Object} message - Message à envoyer
   * @returns {Promise<Object>}
   */
  send: async (message) => {
    try {
      if (!message || typeof message !== "object") {
        throw new Error("Message invalide");
      }
      return await ipcRenderer.invoke("ws:send", message);
    } catch (err) {
      console.error("[WebSocketAPI] Erreur send:", err);
      return { success: false, error: err.message };
    }
  },

  /**
   * Récupère le statut du serveur WebSocket
   * @returns {Promise<Object>}
   */
  getStatus: async () => {
    try {
      return await ipcRenderer.invoke("ws:getStatus");
    } catch (err) {
      console.error("[WebSocketAPI] Erreur getStatus:", err);
      return { running: false, error: err.message };
    }
  },
});

// ========================================
// API DISCOVERY (Service de découverte)
// ========================================

contextBridge.exposeInMainWorld("discoveryAPI", {
  /**
   * Récupère les informations du service de découverte
   * @returns {Promise<Object>}
   */
  getInfo: async () => {
    try {
      return await ipcRenderer.invoke("discovery:getInfo");
    } catch (err) {
      console.error("[DiscoveryAPI] Erreur getInfo:", err);
      return { running: false, error: err.message };
    }
  },
});

// ========================================
// LOGS DE DÉMARRAGE
// ========================================

console.log("[Preload] Script de préchargement chargé avec succès");
console.log("[Preload] Contexte sécurisé initialisé");
console.log("[Preload] APIs exposées: electron, updater, electronAPI, webSocketAPI, discoveryAPI");