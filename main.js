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

let tray = null;
let mainWindow = null;
let deeplinkingUrl = null;
let wss = null;
let discoverySocket = null;
let wsConnections = new Set();
let isQuitting = false; // Flag pour gérer la fermeture réelle

// Configuration
const WS_PORT = 9876;
const DISCOVERY_PORT = 9877;
const SERVICE_NAME = "wagoo-desktop";

// Config centralisée dev/prod
const CONFIG = (() => {
  const isDev = !app.isPackaged;
  return {
    isDev,
    baseURL: isDev ? "http://localhost:3000" : "https://dashtest.wagoo.app",
    wsURL: isDev ? "ws://localhost:" + WS_PORT : "wss://dashtest.wagoo.app",
  };
})();

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
  }

  wss.on("error", (err) => {
    console.error("[WebSocket] Erreur serveur:", err);
  });

  wss.on("listening", () => {
    const localIP = getLocalIPAddress();
    console.log(`[WebSocket] Serveur démarré sur ws://${localIP}:${WS_PORT}`);
  });

  wss.on("connection", (ws, req) => {
    const clientIP = req.socket.remoteAddress;
    console.log(`[WebSocket] Nouvelle connexion depuis ${clientIP}`);
    wsConnections.add(ws);
    sendConnectionStatus();
    ws.send(
      JSON.stringify({
        type: "connected",
        message: "Connecté à Wagoo Desktop",
        version: app.getVersion(),
      })
    );

    ws.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString());
        console.log("[WebSocket] Message reçu:", message);
        handleWebSocketMessage(message, ws);
      } catch (err) {
        console.error("[WebSocket] Erreur parsing message:", err);
      }
    });

    ws.on("close", () => {
      console.log(`[WebSocket] Connexion fermée depuis ${clientIP}`);
      wsConnections.delete(ws);
      sendConnectionStatus();
    });

    ws.on("error", (err) => {
      console.error("[WebSocket] Erreur connexion:", err);
      wsConnections.delete(ws);
      sendConnectionStatus();
    });
  });
}

function handleWebSocketMessage(message, ws) {
  const { type, data } = message;

  switch (type) {
    case "qr_scanned":
      handleQRScanned(data, ws);
      break;

    case "ping":
      ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
      break;

    case "notification":
      showNotification(data.title, data.body);
      break;

    default:
      console.log("[WebSocket] Type de message inconnu:", type);
      if (mainWindow) {
        mainWindow.webContents.send("ws:message", message);
      }
  }
}

function handleQRScanned(data, ws) {
  console.log("[QR Code] Scanné:", data);

  if (mainWindow) {
    mainWindow.webContents.send("qr:scanned", data);
  }

  ws.send(
    JSON.stringify({
      type: "qr_received",
      success: true,
      timestamp: Date.now(),
    })
  );

  if (data.content && data.content.startsWith("wagoo://")) {
    handleDeepLink(data.content);
  }
}

function showNotification(title, body, qrContent = null) {
  if (Notification.isSupported()) {
    const notification = new Notification({
      title: title,
      body: body,
      icon: path.join(__dirname, "assets/logo.png"),
      timeoutType: "default",
    });

    notification.on("click", () => {
      console.log("[Notification] Cliquée");

      if (mainWindow) {
        if (mainWindow.isMinimized()) {
          mainWindow.restore();
        }
        mainWindow.show();
        mainWindow.focus();

        if (qrContent) {
          if (
            qrContent.startsWith("http://") ||
            qrContent.startsWith("https://")
          ) {
            mainWindow.loadURL(qrContent).catch((err) => {
              console.error("[Notification] Erreur chargement URL:", err);
              mainWindow.loadURL(
                `${CONFIG.baseURL}/?qr=${encodeURIComponent(qrContent)}`
              );
            });
          } else if (qrContent.startsWith("wagoo://")) {
            handleDeepLink(qrContent);
          } else {
            mainWindow.loadURL(
              `${CONFIG.baseURL}/?qr=${encodeURIComponent(qrContent)}`
            );
          }
        }
      }
    });

    notification.show();
  }
}

function stopWebSocketServer() {
  if (wss) {
    wsConnections.forEach((ws) => {
      ws.close();
    });
    wsConnections.clear();

    wss.close(() => {
      console.log("[WebSocket] Serveur arrêté");
    });
    wss = null;
  }
}

function broadcastToClients(message) {
  wsConnections.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  });
}

// ========================================
// IPC HANDLERS POUR WEBSOCKET
// ========================================

ipcMain.handle("ws:send", async (event, message) => {
  broadcastToClients(message);
  return { success: true };
});

ipcMain.handle("ws:getStatus", async () => {
  return {
    running: wss !== null,
    connections: wsConnections.size,
    port: WS_PORT,
    ip: getLocalIPAddress(),
  };
});

ipcMain.handle("discovery:getInfo", async () => {
  return {
    running: discoverySocket !== null,
    port: DISCOVERY_PORT,
    ip: getLocalIPAddress(),
    serviceName: SERVICE_NAME,
  };
});

// ========================================
// TRAY (System Tray Icon)
// ========================================

function createTray() {
  // Si le tray existe déjà, ne pas le recréer
  if (tray) return;

  tray = new Tray(path.join(__dirname, "assets/logo.png"));

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Ouvrir Wagoo",
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
          if (mainWindow.isMinimized()) {
            mainWindow.restore();
          }
        } else {
          createWindow();
        }
      },
    },
    { type: "separator" },
    {
      label: `Version ${app.getVersion()}`,
      enabled: false,
    },
    {
      label: "À propos",
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
        // Afficher la fenêtre "À propos"
        showAboutDialog();
      },
    },
    { type: "separator" },
    {
      label: "Vérifier les mises à jour",
      click: () => {
        autoUpdater.checkForUpdates();
      },
    },
    { type: "separator" },
    {
      label: "Quitter",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setToolTip("Wagoo Desktop");
  tray.setContextMenu(contextMenu);

  // Clic gauche sur l'icône : ouvrir/masquer la fenêtre
  tray.on("click", () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        mainWindow.show();
        mainWindow.focus();
        if (mainWindow.isMinimized()) {
          mainWindow.restore();
        }
      }
    } else {
      createWindow();
    }
  }

  // Crée le splash screen
  createSplash() {
    if (this.splashWindow && !this.splashWindow.isDestroyed()) {
      return;
    }
  });
}

// ========================================
// FENÊTRES
// ========================================

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

  createMenu();

  offlineWindow.once("ready-to-show", () => {
    offlineWindow.show();
  });
}

function createWindow() {
  const wagooSession = session.fromPartition("persist:wagoo-session");

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: "Wagoo Desktop - v" + app.getVersion(),
    frame: false,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      session: wagooSession,
      preload: path.join(__dirname, "preload.js"),
      devTools: CONFIG.isDev,
    },
    show: false, // Démarrer caché
  });

  const loadMainURL = async () => {
    const targetURL = deeplinkingUrl
      ? buildTargetFromWagoo(deeplinkingUrl)
      : CONFIG.baseURL;

    try {
      const res = await fetch(targetURL, { method: "HEAD", timeout: 5000 });
      if (!res.ok) throw new Error("Site inaccessible");

      mainWindow.loadURL(targetURL);
    } catch (err) {
      console.error("[main] Site non joignable :", err);
      if (mainWindow) mainWindow.close();

      showOfflineWindow();
    }
  };

  loadMainURL();

  mainWindow.webContents.on("did-finish-load", () => {
    // Afficher la fenêtre au démarrage
    mainWindow.show();
    mainWindow.maximize();
    console.log("[App] Fenêtre affichée au démarrage");
  });

  // IMPORTANT: Empêcher la fermeture complète, juste masquer la fenêtre
  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();

      // Afficher une notification pour informer l'utilisateur
      if (Notification.isSupported()) {
        new Notification({
          title: "Wagoo Desktop",
          body: "L'application continue de fonctionner en arrière-plan. Utilisez l'icône dans la barre des tâches pour la rouvrir.",
          icon: path.join(__dirname, "assets/logo.png"),
        }).show();
      }

      return false;
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function showAboutDialog() {
  const aboutWindow = new BrowserWindow({
    width: 500,
    height: 400,
    parent: mainWindow,
    modal: false,
    resizable: false,
    frame: false,
    transparent: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
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
    const base = CONFIG.baseURL + "/";
    return path ? `${base}${path}${urlObj.search}` : `${base}${urlObj.search}`;
  } catch (err) {
    console.error("[main] buildTargetFromWagoo error:", err, "rawUrl:", rawUrl);
    return CONFIG.baseURL + "/";
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

    // Configurer le démarrage automatique au démarrage du PC
    app.setLoginItemSettings({
      openAtLogin: true,
      openAsHidden: true, // Démarrer caché en arrière-plan
      path: app.getPath("exe"),
    });

    if (process.platform === "win32" || process.platform === "linux") {
      const cliDeepLink = process.argv.find(
        (arg) => typeof arg === "string" && arg.startsWith("wagoo://")
      );
      if (cliDeepLink) {
        console.log("[App] Deep link CLI:", cliDeepLink);
        appState.setDeeplinkUrl(cliDeepLink);
      }
    }

    // Créer le tray AVANT la fenêtre pour qu'il soit toujours présent
    createTray();
    createWindow();

    if (deeplinkingUrl) {
      handleDeepLink(deeplinkingUrl);
      deeplinkingUrl = null;
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

ipcMain.on("window:minimize", () => mainWindow?.minimize());
ipcMain.on("window:maximize", () => {
  if (!mainWindow) return;
  // Cross-platform: vérifier si maximizable avant d'appeler maximize
  if (process.platform !== "darwin" || mainWindow.isMaximizable()) {
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
  }
});
ipcMain.on("window:close", () => {
  // Ne pas fermer complètement, juste masquer
  if (mainWindow) {
    mainWindow.hide();
  }
});

function sendConnectionStatus() {
  const status = {
    devices: Array.from(wsConnections).map((ws) => ({
      ip: ws._socket.remoteAddress,
      port: ws._socket.remotePort,
      platform: "unknown",
    })),
  };

  // Envoi via IPC
  if (mainWindow) {
    mainWindow.webContents.send("connection:status", status);
  }
}

ipcMain.handle("app:getVersion", () => {
  return app.getVersion();
});
