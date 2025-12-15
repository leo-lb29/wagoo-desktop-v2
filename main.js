// main.js - Version Refactorisée et Ultra-Stable
const {
  app,
  BrowserWindow,
  dialog,
  session,
  Tray,
  Menu,
  ipcMain,
  Notification,
} = require("electron");
const { autoUpdater } = require("electron-updater");
const path = require("path");
const dgram = require("dgram");
const WebSocket = require("ws");
const os = require("os");

// ========================================
// CONFIGURATION PLATEFORME (AVANT app.whenReady())
// ========================================

if (process.platform === "linux") {
  const isWayland = process.env.XDG_SESSION_TYPE === "wayland" || 
                    process.env.WAYLAND_DISPLAY;
  
  if (isWayland) {
    app.commandLine.appendSwitch("enable-features", "UseOzonePlatform");
    app.commandLine.appendSwitch("ozone-platform", "wayland");
  }
  
  app.commandLine.appendSwitch("disable-dev-shm-usage");
  app.commandLine.appendSwitch("disable-gpu-compositing");
  app.commandLine.appendSwitch("disable-software-rasterizer");
}

if (process.platform === "win32") {
  app.setAppUserModelId("Wagoo.Desktop");
}

// ========================================
// CONFIGURATION
// ========================================

const CONFIG = Object.freeze({
  WS_PORT: 9876,
  DISCOVERY_PORT: 9877,
  SERVICE_NAME: "wagoo-desktop",
  LOCALHOST: "127.0.0.1",
  MAIN_URL: "http://localhost:3000/",
  FETCH_TIMEOUT: 5000,
  SPLASH_DURATION_MIN: 1000,
  WINDOW_CREATE_DELAY: 150, // Délai sécurisé pour éviter les races conditions
  WINDOW_SHOW_DELAY: 50,
});

// ========================================
// GESTIONNAIRE D'ÉTAT CENTRALISÉ
// ========================================

class AppStateManager {
  constructor() {
    this.state = {
      isQuitting: false,
      isInitialized: false,
      hasShownGlobalError: false,
      deeplinkingUrl: null,
      windowCreationInProgress: false,
      lastWindowAction: 0, // Timestamp de la dernière action fenêtre
    };
    this.MIN_ACTION_INTERVAL = 100; // ms entre actions fenêtre
  }

  canPerformWindowAction() {
    const now = Date.now();
    if (now - this.state.lastWindowAction < this.MIN_ACTION_INTERVAL) {
      console.warn("[State] Action fenêtre trop rapprochée, ignorée");
      return false;
    }
    this.state.lastWindowAction = now;
    return true;
  }

  setQuitting(value) {
    console.log(`[State] setQuitting: ${value}`);
    this.state.isQuitting = value;
  }

  isQuitting() {
    return this.state.isQuitting;
  }

  setWindowCreationInProgress(value) {
    this.state.windowCreationInProgress = value;
  }

  isWindowCreationInProgress() {
    return this.state.windowCreationInProgress;
  }

  setDeeplinkUrl(url) {
    this.state.deeplinkingUrl = url;
  }

  getDeeplinkUrl() {
    return this.state.deeplinkingUrl;
  }

  clearDeeplinkUrl() {
    this.state.deeplinkingUrl = null;
  }

  setInitialized(value) {
    this.state.isInitialized = value;
  }

  isInitialized() {
    return this.state.isInitialized;
  }

  setHasShownError(value) {
    this.state.hasShownGlobalError = value;
  }

  hasShownError() {
    return this.state.hasShownGlobalError;
  }
}

const appState = new AppStateManager();

// ========================================
// GESTIONNAIRE DE FENÊTRES ROBUSTE
// ========================================

class WindowManager {
  constructor() {
    this.mainWindow = null;
    this.splashWindow = null;
    this.createLock = false;
  }

  // Vérifie si la fenêtre principale existe et est valide
  isMainWindowValid() {
    return this.mainWindow !== null && !this.mainWindow.isDestroyed();
  }

  // Détruit proprement la fenêtre principale
  destroyMainWindow() {
    if (this.mainWindow) {
      try {
        if (!this.mainWindow.isDestroyed()) {
          this.mainWindow.destroy();
        }
      } catch (err) {
        console.error("[WindowManager] Erreur destruction fenêtre:", err);
      }
      this.mainWindow = null;
    }
  }

  // Crée la fenêtre principale de façon sécurisée
  async createMainWindow() {
    // Prévenir les créations multiples simultanées
    if (this.createLock) {
      console.warn("[WindowManager] Création déjà en cours, ignorée");
      return null;
    }

    if (appState.isWindowCreationInProgress()) {
      console.warn("[WindowManager] Création en cours (state), ignorée");
      return null;
    }

    if (this.isMainWindowValid()) {
      console.log("[WindowManager] Fenêtre déjà valide");
      return this.mainWindow;
    }

    this.createLock = true;
    appState.setWindowCreationInProgress(true);

    try {
      console.log("[WindowManager] Création nouvelle fenêtre principale...");
      
      // Splash screen
      this.createSplash();

      // Session sécurisée
      const wagooSession = session.fromPartition("persist:wagoo-session");
      
      // CSP strict
      wagooSession.webRequest.onHeadersReceived((details, callback) => {
        callback({
          responseHeaders: {
            ...details.responseHeaders,
            "Content-Security-Policy": [
              "default-src 'self' http://localhost:* ws://localhost:*; " +
              "script-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:*; " +
              "style-src 'self' 'unsafe-inline' http://localhost:*; " +
              "img-src 'self' data: http://localhost:*; " +
              "connect-src 'self' http://localhost:* ws://localhost:*;",
            ],
          },
        });
      });

      this.mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        title: `Wagoo Desktop - v${app.getVersion()}`,
        frame: false,
        autoHideMenuBar: true,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          session: wagooSession,
          preload: path.join(__dirname, "preload.js"),
          devTools: !app.isPackaged,
          webSecurity: true,
          allowRunningInsecureContent: false,
        },
        show: false,
      });

      // Chargement URL
      await this.loadMainURL();

      // Gestion événements
      this.setupMainWindowEvents();

      // Fallback: fermer le splash et afficher la fenêtre si did-finish-load ne vient pas
      setTimeout(() => {
        try {
          if (this.splashWindow && !this.splashWindow.isDestroyed()) {
            this.closeSplash();
          }
          if (this.isMainWindowValid()) {
            this.mainWindow.show();
            this.mainWindow.maximize();
          }
        } catch (e) {
          console.warn("[WindowManager] Fallback show échoué:", e?.message);
        }
      }, CONFIG.SPLASH_DURATION_MIN + 800);

      console.log("[WindowManager] Fenêtre créée avec succès");
      return this.mainWindow;

    } catch (err) {
      console.error("[WindowManager] Erreur création fenêtre:", err);
      this.destroyMainWindow();
      throw err;
    } finally {
      this.createLock = false;
      appState.setWindowCreationInProgress(false);
    }
  }

  // Configure les événements de la fenêtre principale
  setupMainWindowEvents() {
    if (!this.isMainWindowValid()) return;

    this.mainWindow.webContents.on("did-finish-load", () => {
      this.closeSplash();
      if (this.isMainWindowValid()) {
        this.mainWindow.show();
        this.mainWindow.maximize();
      }
    });

    this.mainWindow.on("close", (event) => {
      if (!appState.isQuitting()) {
        event.preventDefault();
        this.hideMainWindow();
        
        if (Notification.isSupported()) {
          new Notification({
            title: "Wagoo Desktop",
            body: "L'application continue en arrière-plan.",
            icon: path.join(__dirname, "assets/logo.png"),
          }).show();
        }
      }
    });

    this.mainWindow.on("closed", () => {
      console.log("[WindowManager] Fenêtre fermée");
      this.mainWindow = null;
    });

    // Bloquer navigation externe
    this.mainWindow.webContents.on("will-navigate", (event, url) => {
      const sanitized = sanitizeURL(url);
      if (!sanitized) {
        event.preventDefault();
        console.warn(`[Security] Navigation bloquée: ${url}`);
      }
    });
  }

  // Affiche la fenêtre principale de façon sécurisée
  async showMainWindow() {
    if (!appState.canPerformWindowAction()) return;

    try {
      // Si la fenêtre n'existe pas, la créer
      if (!this.isMainWindowValid()) {
        console.log("[WindowManager] Fenêtre inexistante, création...");
        await this.createMainWindow();
        return;
      }

      // Fenêtre existe, l'afficher
      if (this.mainWindow.isMinimized()) {
        this.mainWindow.restore();
      }
      
      this.mainWindow.show();
      this.mainWindow.focus();
      
      console.log("[WindowManager] Fenêtre affichée");
    } catch (err) {
      console.error("[WindowManager] Erreur showMainWindow:", err);
      // En cas d'erreur, recréer la fenêtre
      this.destroyMainWindow();
      setTimeout(() => this.createMainWindow(), CONFIG.WINDOW_CREATE_DELAY);
    }
  }

  // Cache la fenêtre principale
  hideMainWindow() {
    if (!this.isMainWindowValid()) return;

    try {
      this.mainWindow.hide();
      console.log("[WindowManager] Fenêtre cachée");
    } catch (err) {
      console.error("[WindowManager] Erreur hideMainWindow:", err);
    }
  }

  // Bascule la visibilité (pour le tray)
  async toggleMainWindow() {
    if (!appState.canPerformWindowAction()) return;

    try {
      if (!this.isMainWindowValid()) {
        console.log("[WindowManager] Toggle: fenêtre invalide, création...");
        await this.createMainWindow();
        return;
      }

      if (this.mainWindow.isVisible() && !this.mainWindow.isMinimized()) {
        this.hideMainWindow();
      } else {
        await this.showMainWindow();
      }
    } catch (err) {
      console.error("[WindowManager] Erreur toggleMainWindow:", err);
    }
  }

  // Minimise la fenêtre
  minimize() {
    if (this.isMainWindowValid()) {
      this.mainWindow.minimize();
    }
  }

  // Maximise/Restore la fenêtre
  maximize() {
    if (!this.isMainWindowValid()) return;
    
    if (this.mainWindow.isMaximized()) {
      this.mainWindow.unmaximize();
    } else {
      this.mainWindow.maximize();
    }
  }

  // Charge l'URL principale
  async loadMainURL() {
    const targetURL = appState.getDeeplinkUrl()
      ? buildTargetFromWagoo(appState.getDeeplinkUrl())
      : CONFIG.MAIN_URL;

    const sanitized = sanitizeURL(targetURL);
    if (!sanitized) {
      console.error("[Security] URL invalide:", targetURL);
      // Ne pas détruire la fenêtre; afficher l'offline si nécessaire
      this.showOfflineWindow();
      return;
    }

    try {
      // Charger directement l'URL (évite les blocages du splash si le serveur met du temps)
      await this.mainWindow.loadURL(sanitized);
      console.log("[WindowManager] URL chargée");
    } catch (err) {
      console.error("[WindowManager] Impossible de charger:", err.message);
      // Fermer le splash mais garder la fenêtre et montrer l'offline
      this.closeSplash();
      // Ne pas détruire la fenêtre ici; afficher une fenêtre offline
      this.showOfflineWindow();
    }
  }

  // Crée le splash screen
  createSplash() {
    if (this.splashWindow && !this.splashWindow.isDestroyed()) {
      return;
    }

    this.splashWindow = new BrowserWindow({
      width: 320,
      height: 280,
      transparent: true,
      frame: false,
      alwaysOnTop: true,
      resizable: false,
      center: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });

    const splashHTML = `
    <!DOCTYPE html>
    <html lang="fr">
      <head>
        <meta charset="UTF-8" />
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com;">
        <style>
          @import url('https://fonts.googleapis.com/css2?family=Baloo+2:wght@400;600;800&display=swap');
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
            font-family: 'Baloo 2', sans-serif;
            background: transparent;
          }
          .card {
            background: #fff;
            border-radius: 16px;
            padding: 40px;
            text-align: center;
            width: 320px;
            animation: fadeIn 0.4s ease-out;
          }
          @keyframes fadeIn {
            from { opacity: 0; transform: scale(0.95); }
            to { opacity: 1; transform: scale(1); }
          }
          .logo {
            font-size: 36px;
            font-weight: 800;
            color: #7c3aed;
            margin-bottom: 20px;
          }
          .loader {
            display: flex;
            justify-content: center;
            gap: 8px;
            margin-bottom: 16px;
          }
          .dot {
            width: 10px;
            height: 10px;
            background: #7c3aed;
            border-radius: 50%;
            animation: bounce 0.6s infinite alternate;
          }
          .dot:nth-child(2) { animation-delay: 0.2s; }
          .dot:nth-child(3) { animation-delay: 0.4s; }
          @keyframes bounce {
            from { transform: translateY(0); opacity: 0.5; }
            to { transform: translateY(-12px); opacity: 1; }
          }
          .version { margin-top: 12px; font-size: 12px; color: #999; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="logo">Wagoo</div>
          <div class="loader">
            <div class="dot"></div>
            <div class="dot"></div>
            <div class="dot"></div>
          </div>
          <div class="version">Sakura-${app.getVersion()}</div>
        </div>
      </body>
    </html>
    `;

    this.splashWindow.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(splashHTML)}`
    );
    this.splashWindow.show();
  }

  // Ferme le splash screen
  closeSplash() {
    if (this.splashWindow && !this.splashWindow.isDestroyed()) {
      setTimeout(() => {
        if (this.splashWindow && !this.splashWindow.isDestroyed()) {
          this.splashWindow.close();
        }
        this.splashWindow = null;
      }, CONFIG.SPLASH_DURATION_MIN);
    }
  }

  // Affiche la fenêtre hors-ligne
  showOfflineWindow() {
    const offlineWindow = new BrowserWindow({
      width: 480,
      height: 300,
      frame: false,
      transparent: true,
      resizable: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });

    const html = `
    <!DOCTYPE html>
    <html lang="fr">
      <head>
        <meta charset="UTF-8" />
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            -webkit-app-region: drag;
            height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background-color: transparent;
          }
          .card {
            text-align: center;
            padding: 30px;
            border-radius: 12px;
            box-shadow: 0 8px 30px rgba(0,0,0,0.1);
            background: #fff;
            width: 380px;
          }
          h2 { margin-bottom: 10px; }
          p { color: #555; font-size: 14px; margin: 8px 0; }
          button {
            margin-top: 20px;
            padding: 10px 18px;
            border: none;
            border-radius: 8px;
            background: #b700ff;
            color: white;
            cursor: pointer;
            font-size: 14px;
          }
        </style>
      </head>
      <body>
        <div class="card">
          <h2>⚠️ Connexion impossible</h2>
          <p>Le serveur Wagoo n'est pas accessible.</p>
          <p>Vérifiez que le serveur local est démarré sur localhost:3000</p>
          <button onclick="window.close()">Fermer</button>
        </div>
      </body>
    </html>
    `;

    offlineWindow.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
    );
    offlineWindow.once("ready-to-show", () => offlineWindow.show());
  }

  // Affiche la boîte "À propos"
  showAboutDialog() {
    const aboutWindow = new BrowserWindow({
      width: 500,
      height: 400,
      parent: this.mainWindow,
      modal: false,
      resizable: false,
      frame: false,
      transparent: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });

    const htmlContent = `
    <!DOCTYPE html>
    <html lang="fr">
      <head>
        <meta charset="UTF-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            padding: 30px;
            background-color: transparent;
            -webkit-app-region: drag;
          }
          .container {
            background: #fff;
            padding: 30px;
            border-radius: 10px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.1);
            position: relative;
          }
          .close-btn {
            position: absolute;
            top: 15px;
            right: 15px;
            width: 30px;
            height: 30px;
            border-radius: 50%;
            background: #f0f0f0;
            border: none;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 18px;
            color: #666;
            -webkit-app-region: no-drag;
          }
          h1 { font-size: 1.8em; }
          .info-grid {
            display: grid;
            grid-template-columns: auto 1fr;
            gap: 8px 16px;
            margin-top: 20px;
          }
          .label { font-weight: 600; color: #666; }
        </style>
      </head>
      <body>
        <div class="container">
          <button class="close-btn" onclick="window.close()">×</button>
          <h1>À propos de Wagoo Desktop</h1>
          <div class="info-grid">
            <span class="label">Version :</span>
            <span>${app.getVersion()}</span>
            <span class="label">Electron :</span>
            <span>${process.versions.electron}</span>
            <span class="label">Plateforme :</span>
            <span>${process.platform} (${process.arch})</span>
          </div>
        </div>
      </body>
    </html>
    `;

    aboutWindow.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(htmlContent)}`
    );
  }

  // Envoie le statut de connexion
  sendConnectionStatus(connections) {
    if (!this.isMainWindowValid()) return;

    const devices = Array.from(connections)
      .filter((ws) => ws._socket)
      .map((ws) => ({
        ip: ws._socket.remoteAddress || "unknown",
        port: ws._socket.remotePort || 0,
        connected: ws.readyState === WebSocket.OPEN,
      }));

    this.mainWindow.webContents.send("connection:status", {
      devices,
      count: connections.size,
      timestamp: Date.now(),
    });
  }
}

const windowManager = new WindowManager();

// ========================================
// UTILITAIRES SÉCURITÉ
// ========================================

function isLocalhost(ip) {
  const patterns = [/^127\./, /^::1$/, /^::ffff:127\./, /^localhost$/i];
  return patterns.some((p) => p.test(ip));
}

function sanitizeURL(url) {
  try {
    const urlObj = new URL(url);
    if (
      urlObj.protocol === "wagoo:" ||
      (urlObj.protocol === "http:" && isLocalhost(urlObj.hostname)) ||
      (urlObj.protocol === "https:" && isLocalhost(urlObj.hostname))
    ) {
      return url;
    }
    console.warn(`[Security] URL rejetée: ${url}`);
    return null;
  } catch {
    console.error(`[Security] URL invalide: ${url}`);
    return null;
  }
}

function validateWebSocketMessage(message) {
  if (!message || typeof message !== "object") return false;
  if (!message.type || typeof message.type !== "string") return false;
  if (message.type.length > 100) return false;
  return true;
}

// ========================================
// GESTIONNAIRE RÉSEAU
// ========================================

class NetworkManager {
  constructor() {
    this.wss = null;
    this.discoverySocket = null;
    this.wsConnections = new Set();
  }

  // WebSocket Server
  startWebSocketServer() {
    if (this.wss) {
      console.warn("[WS] Serveur déjà actif");
      return;
    }

    try {
      this.wss = new WebSocket.Server({
        port: CONFIG.WS_PORT,
        host: CONFIG.LOCALHOST,
      });

      this.wss.on("error", (err) => {
        console.error("[WS] Erreur serveur:", err.message);
        this.stopWebSocketServer();
      });

      this.wss.on("listening", () => {
        console.log(`[WS] Serveur actif sur ws://${CONFIG.LOCALHOST}:${CONFIG.WS_PORT}`);
      });

      this.wss.on("connection", (ws, req) => this.handleConnection(ws, req));
    } catch (err) {
      console.error("[WS] Impossible de démarrer:", err.message);
    }
  }

  handleConnection(ws, req) {
    const clientIP = req.socket.remoteAddress;

    if (!isLocalhost(clientIP)) {
      console.warn(`[WS] Connexion rejetée: ${clientIP}`);
      ws.close(1008, "Localhost uniquement");
      return;
    }

    console.log(`[WS] Connexion acceptée: ${clientIP}`);
    this.wsConnections.add(ws);
    windowManager.sendConnectionStatus(this.wsConnections);

    ws.send(JSON.stringify({
      type: "connected",
      message: "Connecté à Wagoo Desktop",
      version: app.getVersion(),
      timestamp: Date.now(),
    }));

    ws.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString());
        if (validateWebSocketMessage(message)) {
          this.handleMessage(message, ws);
        }
      } catch (err) {
        console.error("[WS] Erreur parsing:", err.message);
      }
    });

    ws.on("close", () => {
      this.wsConnections.delete(ws);
      windowManager.sendConnectionStatus(this.wsConnections);
    });

    ws.on("error", (err) => {
      console.error("[WS] Erreur connexion:", err.message);
      this.wsConnections.delete(ws);
    });
  }

  handleMessage(message, ws) {
    const { type, data } = message;

    switch (type) {
      case "qr_scanned":
        this.handleQRScanned(data, ws);
        break;
      case "ping":
        ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
        break;
      case "notification":
        if (data?.title && data?.body) {
          showNotification(data.title, data.body);
        }
        break;
      default:
        if (windowManager.isMainWindowValid()) {
          windowManager.mainWindow.webContents.send("ws:message", message);
        }
    }
  }

  handleQRScanned(data, ws) {
    console.log("[QR] Scanné:", data);
    
    const content = data?.content || "Code détecté";
    showNotification("QR Code scanné", content, data?.content);

    if (windowManager.isMainWindowValid()) {
      windowManager.mainWindow.webContents.send("qr:scanned", data);
    }

    ws.send(JSON.stringify({
      type: "qr_received",
      success: true,
      timestamp: Date.now(),
    }));

    if (data?.content && data.content.startsWith("wagoo://")) {
      handleDeepLink(data.content);
    }
  }

  broadcastToClients(message) {
    const jsonMessage = JSON.stringify(message);
    let sentCount = 0;

    this.wsConnections.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(jsonMessage);
          sentCount++;
        } catch (err) {
          console.error("[WS] Erreur broadcast:", err.message);
        }
      }
    });

    console.log(`[WS] Broadcast à ${sentCount} client(s)`);
  }

  stopWebSocketServer() {
    if (!this.wss) return;

    try {
      this.wsConnections.forEach((ws) => {
        try {
          ws.close(1001, "Server shutdown");
        } catch (err) {
          console.error("[WS] Erreur fermeture client:", err.message);
        }
      });
      this.wsConnections.clear();

      this.wss.close(() => console.log("[WS] Serveur arrêté"));
      this.wss = null;
    } catch (err) {
      console.error("[WS] Erreur arrêt:", err.message);
    }
  }

  // Discovery Service
  startDiscoveryService() {
    if (this.discoverySocket) {
      console.warn("[Discovery] Service déjà actif");
      return;
    }

    this.discoverySocket = dgram.createSocket("udp4");

    this.discoverySocket.on("error", (err) => {
      console.error("[Discovery] Erreur:", err.message);
      this.stopDiscoveryService();
    });

    this.discoverySocket.on("message", (msg, rinfo) => {
      if (!isLocalhost(rinfo.address)) {
        console.warn(`[Discovery] Requête rejetée: ${rinfo.address}`);
        return;
      }

      const message = msg.toString().trim();
      if (message === "WAGOO_DISCOVERY_REQUEST") {
        const response = JSON.stringify({
          service: CONFIG.SERVICE_NAME,
          ip: CONFIG.LOCALHOST,
          wsPort: CONFIG.WS_PORT,
          hostname: os.hostname(),
          version: app.getVersion(),
          platform: process.platform,
          timestamp: Date.now(),
        });

        this.discoverySocket.send(response, rinfo.port, rinfo.address, (err) => {
          if (err) {
            console.error("[Discovery] Erreur envoi:", err.message);
          }
        });
      }
    });

    this.discoverySocket.on("listening", () => {
      const address = this.discoverySocket.address();
      console.log(`[Discovery] Service actif: ${address.address}:${address.port}`);
    });

    this.discoverySocket.bind(CONFIG.DISCOVERY_PORT, CONFIG.LOCALHOST);
  }

  stopDiscoveryService() {
    if (this.discoverySocket) {
      try {
        this.discoverySocket.close();
        this.discoverySocket = null;
        console.log("[Discovery] Service arrêté");
      } catch (err) {
        console.error("[Discovery] Erreur arrêt:", err.message);
      }
    }
  }

  getWebSocketStatus() {
    return {
      running: this.wss !== null,
      connections: this.wsConnections.size,
      port: CONFIG.WS_PORT,
      ip: CONFIG.LOCALHOST,
    };
  }

  getDiscoveryInfo() {
    return {
      running: this.discoverySocket !== null,
      port: CONFIG.DISCOVERY_PORT,
      ip: CONFIG.LOCALHOST,
      serviceName: CONFIG.SERVICE_NAME,
    };
  }
}

const networkManager = new NetworkManager();

// ========================================
// GESTIONNAIRE TRAY ROBUSTE
// ========================================

class TrayManager {
  constructor() {
    this.tray = null;
  }

  create() {
    if (this.tray) {
      console.warn("[Tray] Déjà créé");
      return;
    }

    const iconPath = path.join(__dirname, "assets/logo.png");
    this.tray = new Tray(iconPath);

    this.updateMenu();
    
    this.tray.setToolTip("Wagoo Desktop");
    
    // Simple click = toggle
    this.tray.on("click", () => {
      windowManager.toggleMainWindow();
    });
    
    // Double-click = toujours afficher
    this.tray.on("double-click", () => {
      windowManager.showMainWindow();
    });

    console.log("[Tray] Créé avec succès");
  }

  updateMenu() {
    if (!this.tray) return;

    const contextMenu = Menu.buildFromTemplate([
      {
        label: "Ouvrir Wagoo",
        click: () => windowManager.showMainWindow(),
      },
      { type: "separator" },
      {
        label: `Version ${app.getVersion()}`,
        enabled: false,
      },
      {
        label: "À propos",
        click: () => {
          windowManager.showMainWindow();
          windowManager.showAboutDialog();
        },
      },
      { type: "separator" },
      {
        label: "Vérifier les mises à jour",
        click: () => autoUpdater.checkForUpdates(),
      },
      { type: "separator" },
      {
        label: "Quitter",
        click: () => {
          appState.setQuitting(true);
          app.quit();
        },
      },
    ]);

    this.tray.setContextMenu(contextMenu);
  }

  destroy() {
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }
}

const trayManager = new TrayManager();

// ========================================
// NOTIFICATIONS
// ========================================

function showNotification(title, body, qrContent = null) {
  if (!Notification.isSupported()) return;

  const notification = new Notification({
    title,
    body,
    icon: path.join(__dirname, "assets/logo.png"),
    timeoutType: "default",
  });

  notification.on("click", () => {
    windowManager.showMainWindow().then(() => {
      if (qrContent) {
        const sanitized = sanitizeURL(qrContent);
        if (sanitized) {
          if (sanitized.startsWith("wagoo://")) {
            handleDeepLink(sanitized);
          } else if (windowManager.isMainWindowValid()) {
            windowManager.mainWindow.loadURL(sanitized).catch(() => {
              windowManager.mainWindow.loadURL(
                `${CONFIG.MAIN_URL}?qr=${encodeURIComponent(qrContent)}`
              );
            });
          }
        }
      }
    });
  });

  notification.show();
}

// ========================================
// DEEP LINKS
// ========================================

function buildTargetFromWagoo(rawUrl) {
  try {
    const urlObj = new URL(rawUrl);
    let path = "";

    if (urlObj.hostname && urlObj.hostname !== "") {
      path += `/${urlObj.hostname}`;
    }
    if (urlObj.pathname && urlObj.pathname !== "/") {
      path += urlObj.pathname;
    }

    path = path.replace(/^\/+/, "");
    const target = path
      ? `${CONFIG.MAIN_URL}${path}${urlObj.search}`
      : `${CONFIG.MAIN_URL}${urlObj.search}`;

    console.log(`[DeepLink] ${rawUrl} -> ${target}`);
    return target;
  } catch (err) {
    console.error("[DeepLink] Erreur transformation:", err.message);
    return CONFIG.MAIN_URL;
  }
}

function handleDeepLink(rawUrl) {
  console.log("[DeepLink] Traitement:", rawUrl);

  if (!rawUrl || !rawUrl.startsWith("wagoo://")) {
    console.warn("[DeepLink] URL invalide:", rawUrl);
    return;
  }

  const target = buildTargetFromWagoo(rawUrl);
  const sanitized = sanitizeURL(target);

  if (!sanitized) {
    console.error("[DeepLink] URL non sécurisée:", target);
    return;
  }

  if (windowManager.isMainWindowValid()) {
    windowManager.mainWindow
      .loadURL(sanitized)
      .then(() => {
        windowManager.showMainWindow();
        console.log("[DeepLink] Navigation réussie");
      })
      .catch((err) => {
        console.error("[DeepLink] Erreur navigation:", err.message);
      });
  } else {
    console.log("[DeepLink] Fenêtre non prête, sauvegarde");
    appState.setDeeplinkUrl(rawUrl);
  }
}

// ========================================
// AUTO-UPDATER
// ========================================

function initAutoUpdater() {
  if (!app.isPackaged) {
    console.log("[Updater] Mode dev, désactivé");
    return;
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on("checking-for-update", () => {
    console.log("[Updater] Vérification...");
    if (windowManager.isMainWindowValid()) {
      windowManager.mainWindow.webContents.send("updater:checking");
    }
  });

  autoUpdater.on("update-not-available", () => {
    console.log("[Updater] Aucune MAJ");
    if (windowManager.isMainWindowValid()) {
      windowManager.mainWindow.webContents.send("updater:not-available");
    }
  });

  autoUpdater.on("update-available", (info) => {
    console.log(`[Updater] MAJ disponible: v${info.version}`);
    if (windowManager.isMainWindowValid()) {
      windowManager.mainWindow.webContents.send("updater:available", {
        version: info.version,
        releaseDate: info.releaseDate,
        releaseNotes: info.releaseNotes,
      });
    }
  });

  autoUpdater.on("download-progress", (progressObj) => {
    const percent = Math.round(progressObj.percent);
    console.log(`[Updater] ${percent}%`);
    if (windowManager.isMainWindowValid()) {
      windowManager.mainWindow.webContents.send("updater:progress", {
        percent: progressObj.percent,
        transferred: progressObj.transferred,
        total: progressObj.total,
      });
    }
  });

  autoUpdater.on("update-downloaded", (info) => {
    console.log(`[Updater] Téléchargement terminé: v${info.version}`);
    if (windowManager.isMainWindowValid()) {
      windowManager.mainWindow.webContents.send("updater:downloaded", {
        version: info.version,
      });
    }
  });

  autoUpdater.on("error", (err) => {
    console.error("[Updater] Erreur:", err.message);
    if (windowManager.isMainWindowValid()) {
      windowManager.mainWindow.webContents.send("updater:error", {
        message: err.message || "Erreur inconnue",
      });
    }
  });

  setTimeout(() => {
    autoUpdater.checkForUpdatesAndNotify();
  }, 3000);

  console.log("[Updater] Initialisé");
}

// ========================================
// IPC HANDLERS
// ========================================

function setupIPCHandlers() {
  // Fenêtre
  ipcMain.on("window:minimize", () => windowManager.minimize());
  ipcMain.on("window:maximize", () => windowManager.maximize());
  ipcMain.on("window:close", () => windowManager.hideMainWindow());

  // App info
  ipcMain.handle("app:getVersion", () => app.getVersion());

  // WebSocket
  ipcMain.handle("ws:send", async (event, message) => {
    try {
      networkManager.broadcastToClients(message);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("ws:getStatus", async () => {
    return networkManager.getWebSocketStatus();
  });

  // Discovery
  ipcMain.handle("discovery:getInfo", async () => {
    return networkManager.getDiscoveryInfo();
  });

  // Updater
  ipcMain.handle("updater:check", async () => {
    try {
      const result = await autoUpdater.checkForUpdates();
      return { success: true, updateInfo: result?.updateInfo };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("updater:download", async () => {
    try {
      await autoUpdater.downloadUpdate();
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("updater:install", () => {
    try {
      appState.setQuitting(true);
      autoUpdater.quitAndInstall(false, true);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  console.log("[IPC] Handlers configurés");
}

// ========================================
// MENU
// ========================================

function createMenu() {
  const template = [
    {
      label: "Application",
      submenu: [
        {
          label: "Vérifier les MAJ",
          click: () => autoUpdater.checkForUpdates(),
        },
        {
          label: "À propos",
          click: () => windowManager.showAboutDialog(),
        },
        { type: "separator" },
        {
          label: `Version ${app.getVersion()}`,
          enabled: false,
        },
        { type: "separator" },
        {
          role: "quit",
          label: "Quitter",
          accelerator: "CmdOrCtrl+Q",
          click: () => {
            appState.setQuitting(true);
            app.quit();
          },
        },
      ],
    },
    {
      label: "Édition",
      submenu: [
        { role: "undo", label: "Annuler" },
        { role: "redo", label: "Refaire" },
        { type: "separator" },
        { role: "cut", label: "Couper" },
        { role: "copy", label: "Copier" },
        { role: "paste", label: "Coller" },
        { role: "selectAll", label: "Tout sélectionner" },
      ],
    },
  ];

  if (!app.isPackaged) {
    template.push({
      label: "Développement",
      submenu: [
        { role: "reload", label: "Recharger" },
        { role: "forceReload", label: "Forcer rechargement" },
        { role: "toggleDevTools", label: "DevTools" },
      ],
    });
  }

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// ========================================
// ERREURS GLOBALES
// ========================================

function setupGlobalErrorHandlers() {
  const handleError = (err, origin) => {
    console.error(`[GlobalError][${origin}]`, err);

    if (appState.hasShownError()) return;
    appState.setHasShownError(true);

    dialog.showErrorBox(
      "Erreur Wagoo Desktop",
      `Une erreur est survenue: ${err?.message || "Erreur inconnue"}`
    );
  };

  process.on("uncaughtException", (err) =>
    handleError(err, "uncaughtException")
  );
  process.on("unhandledRejection", (reason) =>
    handleError(
      reason instanceof Error ? reason : new Error(String(reason)),
      "unhandledRejection"
    )
  );
}

// ========================================
// LIFECYCLE
// ========================================

// Deep links
app.on("open-url", (event, url) => {
  event.preventDefault();
  console.log("[App] Deep link reçu:", url);

  if (appState.isInitialized() && windowManager.isMainWindowValid()) {
    handleDeepLink(url);
  } else {
    appState.setDeeplinkUrl(url);
  }
});

// Single instance
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  console.log("[App] Instance déjà en cours");
  app.quit();
} else {
  app.on("second-instance", (event, argv) => {
    console.log("[App] Tentative seconde instance");
    
    const deepLink = argv.find(
      (arg) => typeof arg === "string" && arg.startsWith("wagoo://")
    );
    
    if (deepLink) {
      handleDeepLink(deepLink);
    }
    
    // Toujours afficher la fenêtre
    setTimeout(() => {
      windowManager.showMainWindow();
    }, CONFIG.WINDOW_SHOW_DELAY);
  });

  // Initialisation
  app.whenReady().then(async () => {
    console.log(`[App] Démarrage Wagoo Desktop v${app.getVersion()}`);

    setupGlobalErrorHandlers();
    setupIPCHandlers();

    // macOS: cacher dock
    if (process.platform === "darwin" && app.dock) {
      try {
        app.dock.hide();
      } catch {}
    }

    // Protocol handler
    if (process.defaultApp) {
      if (process.argv.length >= 2) {
        app.setAsDefaultProtocolClient("wagoo", process.execPath, [
          path.resolve(process.argv[1]),
        ]);
      }
    } else {
      app.setAsDefaultProtocolClient("wagoo");
    }

    // Deep link CLI (Windows/Linux)
    if (process.platform === "win32" || process.platform === "linux") {
      const cliDeepLink = process.argv.find(
        (arg) => typeof arg === "string" && arg.startsWith("wagoo://")
      );
      if (cliDeepLink) {
        console.log("[App] Deep link CLI:", cliDeepLink);
        appState.setDeeplinkUrl(cliDeepLink);
      }
    }

    // Tray en premier
    trayManager.create();

    // Fenêtre principale
    await windowManager.createMainWindow();

    // Deep link si présent
    if (appState.getDeeplinkUrl()) {
      handleDeepLink(appState.getDeeplinkUrl());
      appState.clearDeeplinkUrl();
    }

    // Services réseau
    networkManager.startWebSocketServer();
    networkManager.startDiscoveryService();

    // Menu
    createMenu();

    // Auto-updater
    initAutoUpdater();

    appState.setInitialized(true);
    console.log("[App] Initialisation terminée");
  });
}

// Fermeture fenêtres
app.on("window-all-closed", () => {
  console.log("[App] Fenêtres fermées, reste en arrière-plan");
  // Ne pas quitter, rester actif avec le tray
});

// Activation macOS
app.on("activate", () => {
  windowManager.showMainWindow();
});

// Avant quitter
app.on("before-quit", () => {
  console.log("[App] Arrêt...");
  appState.setQuitting(true);

  networkManager.stopWebSocketServer();
  networkManager.stopDiscoveryService();

  console.log("[App] Services arrêtés");
});

// ========================================
// EXPORTS
// ========================================

module.exports = {
  CONFIG,
  isLocalhost,
  sanitizeURL,
  validateWebSocketMessage,
};