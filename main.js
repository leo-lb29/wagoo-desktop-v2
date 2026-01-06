require("dotenv").config();

// Configuration fallback si .env manquant (production)
if (!process.env.PROD_BASE_URL) {
  console.warn("[INIT] Variables d'environnement manquantes, utilisation fallback");
  process.env.PROD_BASE_URL = "https://dashtest.wagoo.app/dashboard";
  process.env.DEV_BASE_URL = "http://localhost:3000/dashboard";
  process.env.DEV_WS_URL = "ws://localhost:9876";
  process.env.PROD_WS_URL = "wss://dashtest.wagoo.app";
  process.env.WS_PORT = "9876";
  process.env.DISCOVERY_PORT = "9877";
  process.env.SERVICE_NAME = "wagoo-desktop";
  process.env.WS_MAX_CONNECTIONS = "100";
  process.env.WS_RATE_LIMIT_WINDOW_MS = "60000";
  process.env.WS_RATE_LIMIT_MAX_MESSAGES = "100";
  process.env.FETCH_TIMEOUT = "5000";
  process.env.WS_HEARTBEAT_INTERVAL = "30000";
  process.env.WS_CONNECTION_TIMEOUT = "10000";
  process.env.LOG_LEVEL = "info";
  process.env.WS_LOCALHOST_ONLY = "true";
}
const {
  app,
  BrowserWindow,
  dialog,
  session,
  Tray,
  Menu,
  ipcMain,
  Notification,
  nativeTheme,
} = require("electron");
const { autoUpdater } = require("electron-updater");
const path = require("path");
const dgram = require("dgram");
const WebSocket = require("ws");
const os = require("os");
const fs = require("fs");

// Charger le logger avec fallback robuste
let initLogger, createModuleLogger;
try {
  ({ initLogger, createModuleLogger } = require("./logger"));
} catch (err) {
  console.error("[INIT] Erreur chargement logger.js, utilisation fallback", err.message);
  // Fallback logger si fichier manquant en production
  const log = require("electron-log");
  initLogger = (dir) => {
    log.transports.file.file = path.join(dir, "wagoo-desktop.log");
    return log;
  };
  createModuleLogger = (name) => ({
    debug: (msg) => log.debug(`[${name}] ${msg}`),
    info: (msg) => log.info(`[${name}] ${msg}`),
    warn: (msg) => log.warn(`[${name}] ${msg}`),
    error: (msg) => log.error(`[${name}] ${msg}`),
  });
}

// Initialiser le logger
const logDir = app.getPath("logs");
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}
initLogger(logDir);
const logger = createModuleLogger("MAIN");

let tray = null;
let mainWindow = null;
let deeplinkingUrl = null;
let wss = null;
let discoverySocket = null;
let wsConnections = new Map(); // Map au lieu de Set pour meilleure gestion
let isQuitting = false;
let wsHeartbeatIntervals = new Map();

/**
 * Configuration centralisée dev/prod depuis les variables d'environnement
 */
const CONFIG = (() => {
  const isDev = !app.isPackaged;
  return {
    isDev,
    baseURL: isDev 
      ? process.env.DEV_BASE_URL 
      : process.env.PROD_BASE_URL,
    wsURL: isDev 
      ? process.env.DEV_WS_URL 
      : process.env.PROD_WS_URL,
    wsPort: parseInt(process.env.WS_PORT) || 9876,
    discoveryPort: parseInt(process.env.DISCOVERY_PORT) || 9877,
    serviceName: process.env.SERVICE_NAME || "wagoo-desktop",
    maxConnections: parseInt(process.env.WS_MAX_CONNECTIONS) || 100,
    rateLimitWindow: parseInt(process.env.WS_RATE_LIMIT_WINDOW_MS) || 60000,
    rateLimitMax: parseInt(process.env.WS_RATE_LIMIT_MAX_MESSAGES) || 100,
    fetchTimeout: parseInt(process.env.FETCH_TIMEOUT) || 5000,
    wsHeartbeat: parseInt(process.env.WS_HEARTBEAT_INTERVAL) || 30000,
    wsConnectionTimeout: parseInt(process.env.WS_CONNECTION_TIMEOUT) || 10000,
    localhostOnly: process.env.WS_LOCALHOST_ONLY !== "false",
  };
})();

logger.info(`Configuration chargée [isDev=${CONFIG.isDev}]`);

if (process.platform === "linux") {
  app.commandLine.appendSwitch("enable-features", "UseOzonePlatform");
  app.commandLine.appendSwitch("ozone-platform", "wayland");
}

/**
 * Utilitaire pour faire un fetch avec timeout
 * @param {string} url - URL à charger
 * @param {object} options - Options fetch
 * @param {number} timeout - Timeout en millisecondes
 * @returns {Promise} Réponse fetch
 */
async function fetchWithTimeout(url, options = {}, timeout = CONFIG.fetchTimeout) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Retourne l'adresse IP locale pour le service de découverte
 * @returns {string} Adresse IPv4 locale
 */
function getLocalIPAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return "127.0.0.1";
}

/**
 * Démarre le service de découverte UDP
 */
function startDiscoveryService() {
  try {
    discoverySocket = dgram.createSocket("udp4");

    discoverySocket.on("error", (err) => {
      logger.error("Erreur découverte:", err);
      discoverySocket.close();
    });

    discoverySocket.on("message", (msg, rinfo) => {
      try {
        const message = msg.toString();
        logger.debug(`Message reçu de ${rinfo.address}:${rinfo.port}`);

        if (message === "WAGOO_DISCOVERY_REQUEST") {
          const localIP = getLocalIPAddress();
          const response = JSON.stringify({
            service: CONFIG.serviceName,
            ip: localIP,
            wsPort: CONFIG.wsPort,
            hostname: os.hostname(),
            version: app.getVersion(),
            platform: process.platform,
          });

          discoverySocket.send(response, rinfo.port, rinfo.address, (err) => {
            if (err) {
              logger.error("Erreur envoi réponse découverte:", err);
            } else {
              logger.debug(`Réponse envoyée à ${rinfo.address}:${rinfo.port}`);
            }
          });
        }
      } catch (err) {
        logger.error("Erreur traitement message découverte:", err);
      }
    });

    discoverySocket.on("listening", () => {
      const address = discoverySocket.address();
      logger.info(
        `Service découverte en écoute sur ${address.address}:${address.port}`
      );
      discoverySocket.setBroadcast(true);
    });

    discoverySocket.bind(CONFIG.discoveryPort);
  } catch (err) {
    logger.error("Impossible démarrer service découverte:", err);
  }
}

/**
 * Arrête le service de découverte UDP
 */
function stopDiscoveryService() {
  if (discoverySocket) {
    try {
      discoverySocket.close();
      discoverySocket = null;
      logger.info("Service découverte arrêté");
    } catch (err) {
      logger.error("Erreur arrêt service découverte:", err);
    }
  }
}

// ========================================
// SERVEUR WEBSOCKET
// ========================================

/**
 * Valide un message WebSocket pour la sécurité
 * @param {object} message - Message à valider
 * @returns {boolean} Message valide ou non
 */
function validateWSMessage(message) {
  if (!message || typeof message !== "object") return false;
  if (!message.type || typeof message.type !== "string") return false;
  if (message.type.length > 50) return false; // Limite raisonnable
  return true;
}

/**
 * Démarre le serveur WebSocket avec gestion d'erreurs et limites
 */
function startWebSocketServer() {
  try {
    const wsHost = CONFIG.localhostOnly ? "127.0.0.1" : "0.0.0.0";
    
    wss = new WebSocket.Server({
      port: CONFIG.wsPort,
      host: wsHost,
      clientTracking: true,
      maxPayload: 100 * 1024, // 100KB max
    });

    logger.info(`WebSocket serveur configuré en écoute sur ${wsHost}:${CONFIG.wsPort}`);
  } catch (err) {
    logger.error("Erreur démarrage WebSocket principal:", err);
    // Essayer port alternatif
    try {
      const altPort = CONFIG.wsPort + 1;
      wss = new WebSocket.Server({
        port: altPort,
        host: CONFIG.localhostOnly ? "127.0.0.1" : "0.0.0.0",
        maxPayload: 100 * 1024,
      });
      logger.warn(`WebSocket démarré sur port alternatif ${altPort}`);
    } catch (err2) {
      logger.error("Impossible démarrer WebSocket (port alternatif aussi):", err2);
      return;
    }
  }

  wss.on("error", (err) => {
    logger.error("Erreur serveur WebSocket:", err);
  });

  wss.on("connection", (ws, req) => {
    try {
      // Vérifier limite de connexions
      if (wsConnections.size >= CONFIG.maxConnections) {
        logger.warn(`Limite connexions atteinte (${CONFIG.maxConnections})`);
        ws.close(1008, "Serveur plein");
        return;
      }

      const clientIP = req.socket.remoteAddress;
      const wsId = `${clientIP}-${Date.now()}`;

      logger.info(`Nouvelle connexion WebSocket depuis ${clientIP}`);
      
      // Initialiser rate limiting
      const clientData = {
        ip: clientIP,
        messageCount: 0,
        windowStart: Date.now(),
      };

      wsConnections.set(wsId, { ws, clientData });
      sendConnectionStatus();

      // Notification de connexion d'un nouvel appareil
      try {
        const notificationMessage = `Appareil appairé depuis ${clientIP}`;
        if (Notification.isSupported()) {
          const notification = new Notification({
            title: "Wagoo Desktop",
            body: notificationMessage,
            icon: path.join(__dirname, "assets/logo.png"),
          });
          notification.show();
        }
        logger.info(`Notification envoyée: ${notificationMessage}`);
      } catch (err) {
        logger.debug("Erreur notification connexion:", err);
      }

      // Envoi message bienvenue
      try {
        ws.send(
          JSON.stringify({
            type: "connected",
            message: "Connecté à Wagoo Desktop",
            version: app.getVersion(),
          })
        );
      } catch (err) {
        logger.error("Erreur envoi message connexion:", err);
      }

      // Heartbeat pour maintenir la connexion
      const heartbeatInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.ping();
          } catch (err) {
            logger.debug("Erreur ping heartbeat:", err);
          }
        }
      }, CONFIG.wsHeartbeat);

      wsHeartbeatIntervals.set(wsId, heartbeatInterval);

      ws.on("message", (data) => {
        try {
          // Rate limiting
          clientData.messageCount++;
          const now = Date.now();
          if (now - clientData.windowStart > CONFIG.rateLimitWindow) {
            clientData.messageCount = 1;
            clientData.windowStart = now;
          }

          if (clientData.messageCount > CONFIG.rateLimitMax) {
            logger.warn(`Rate limit dépassé pour ${clientIP}`);
            ws.close(1008, "Rate limit exceeded");
            return;
          }

          // Valider et traiter message
          const message = JSON.parse(data.toString());
          if (!validateWSMessage(message)) {
            logger.warn(`Message invalide reçu de ${clientIP}`);
            return;
          }

          handleWebSocketMessage(message, ws);
        } catch (err) {
          logger.error("Erreur traitement message WebSocket:", err);
        }
      });

      ws.on("close", () => {
        logger.info(`Connexion fermée depuis ${clientIP}`);
        wsConnections.delete(wsId);
        
        const interval = wsHeartbeatIntervals.get(wsId);
        if (interval) {
          clearInterval(interval);
          wsHeartbeatIntervals.delete(wsId);
        }

        sendConnectionStatus();
      });

      ws.on("error", (err) => {
        logger.error("Erreur connexion WebSocket:", err);
        wsConnections.delete(wsId);
        
        const interval = wsHeartbeatIntervals.get(wsId);
        if (interval) {
          clearInterval(interval);
          wsHeartbeatIntervals.delete(wsId);
        }

        sendConnectionStatus();
      });
    } catch (err) {
      logger.error("Erreur dans handler connexion:", err);
      ws.close(1011, "Erreur interne");
    }
  });
}

/**
 * Gère les messages WebSocket entrants
 * @param {object} message - Message à traiter
 * @param {WebSocket} ws - Connection WebSocket
 */
function handleWebSocketMessage(message, ws) {
  const { type, data } = message;

  switch (type) {
    case "qr_scanned":
      handleQRScanned(data, ws);
      break;

    case "ping":
      try {
        ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
      } catch (err) {
        logger.error("Erreur envoi pong:", err);
      }
      break;

    case "notification":
      if (data && data.title && data.body) {
        showNotification(data.title, data.body);
      }
      break;

    default:
      logger.debug(`Type message inconnu: ${type}`);
      if (mainWindow) {
        mainWindow.webContents.send("ws:message", message);
      }
  }
}

/**
 * Traite un QR code scanné
 * @param {object} data - Données QR
 * @param {WebSocket} ws - Connection WebSocket
 */
function handleQRScanned(data, ws) {
  try {
    logger.info("QR code scanné");

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

    if (data && data.content && data.content.startsWith("wagoo://")) {
      handleDeepLink(data.content);
    }
  } catch (err) {
    logger.error("Erreur traitement QR scanné:", err);
  }
}

/**
 * Affiche une notification système
 * @param {string} title - Titre notification
 * @param {string} body - Corps notification
 * @param {string} qrContent - Contenu QR optionnel
 */
function showNotification(title, body, qrContent = null) {
  try {
    if (!Notification.isSupported()) {
      logger.warn("Notifications non supportées");
      return;
    }

    const notification = new Notification({
      title: title || "Wagoo",
      body: body || "",
      icon: getIconPath("logo.png"),
      timeoutType: "default",
    });

    notification.on("click", () => {
      logger.debug("Notification cliquée");

      if (mainWindow) {
        if (mainWindow.isMinimized()) {
          mainWindow.restore();
        }
        mainWindow.show();
        mainWindow.focus();

        if (qrContent) {
          handleNotificationClick(qrContent);
        }
      }
    });

    notification.show();
  } catch (err) {
    logger.error("Erreur affichage notification:", err);
  }
}

/**
 * Gère le clic sur une notification
 * @param {string} qrContent - Contenu du QR
 */
function handleNotificationClick(qrContent) {
  try {
    if (
      qrContent.startsWith("http://") ||
      qrContent.startsWith("https://")
    ) {
      mainWindow.loadURL(qrContent).catch((err) => {
        logger.error("Erreur chargement URL notification:", err);
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
  } catch (err) {
    logger.error("Erreur gestion clic notification:", err);
  }
}

/**
 * Arrête le serveur WebSocket et ferme les connexions
 */
function stopWebSocketServer() {
  if (wss) {
    try {
      // Fermer tous les heartbeat intervals
      wsHeartbeatIntervals.forEach((interval) => {
        clearInterval(interval);
      });
      wsHeartbeatIntervals.clear();

      // Fermer toutes les connexions
      wsConnections.forEach((connData) => {
        try {
          connData.ws.close(1000, "Arrêt serveur");
        } catch (err) {
          logger.debug("Erreur fermeture WS:", err);
        }
      });
      wsConnections.clear();

      // Fermer le serveur
      wss.close(() => {
        logger.info("Serveur WebSocket arrêté");
      });
      wss = null;
    } catch (err) {
      logger.error("Erreur arrêt WebSocket:", err);
    }
  }
}

/**
 * Broadcast un message à tous les clients connectés
 * @param {object} message - Message à envoyer
 */
function broadcastToClients(message) {
  wsConnections.forEach((connData) => {
    try {
      if (connData.ws && connData.ws.readyState === WebSocket.OPEN) {
        connData.ws.send(JSON.stringify(message));
      }
    } catch (err) {
      logger.debug("Erreur broadcast:", err);
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
    port: CONFIG.wsPort,
    ip: getLocalIPAddress(),
  };
});

ipcMain.handle("discovery:getInfo", async () => {
  return {
    running: discoverySocket !== null,
    port: CONFIG.discoveryPort,
    ip: getLocalIPAddress(),
    serviceName: CONFIG.serviceName,
  };
});

// ========================================
// TRAY (System Tray Icon)
// ========================================

/**
 * Retourne le chemin de l'icône avec fallback
 * @param {string} filename - Nom du fichier
 * @returns {string} Chemin de l'icône ou icône par défaut
 */
function getIconPath(filename) {
  const paths = [
    path.join(__dirname, `assets/${filename}`),
    path.join(__dirname, `assets/icons/${filename}`),
    path.join(__dirname, filename),
  ];

  for (const iconPath of paths) {
    if (fs.existsSync(iconPath)) {
      return iconPath;
    }
  }

  logger.warn(`Icône introuvable: ${filename}, utilisation fallback`);
  // Créer une icône vide par défaut pour éviter le crash
  return nativeTheme.shouldUseDarkColors
    ? path.join(__dirname, "assets/tray/icon-dark.png")
    : path.join(__dirname, "assets/tray/icon-light.png");
}

/**
 * Retourne l'icône du tray selon le thème
 * @returns {string} Chemin de l'icône tray
 */
function getTrayIcon() {
  const isDark = nativeTheme.shouldUseDarkColors;

  if (isDark) {
    return getIconPath("tray/icon-dark.png");
  } else {
    return getIconPath("tray/icon-light.png");
  }
}

/**
 * Crée l'icône du tray système
 */
function createTray() {
  if (tray) return;

  try {
    const iconPath = getTrayIcon();
    tray = new Tray(iconPath);

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
    });

    // Double-clic : toujours afficher
    tray.on("double-click", () => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
        if (mainWindow.isMinimized()) {
          mainWindow.restore();
        }
      } else {
        createWindow();
      }
    });

    // Écouter les changements de thème et mettre à jour l'icône
    nativeTheme.on("updated", () => {
      try {
        if (tray && !tray.isDestroyed()) {
          tray.setImage(getTrayIcon());
        }
      } catch (err) {
        logger.error("Erreur mise à jour icône tray:", err);
      }
    });

    logger.info("Tray créé avec succès");
  } catch (err) {
    logger.error("Erreur création tray:", err);
  }
}

// ========================================
// FENÊTRES
// ========================================

/**
 * Affiche la fenêtre offline avec gestion d'erreurs
 */
function showOfflineWindow() {
  try {
    const offlineWindow = new BrowserWindow({
      width: 480,
      height: 300,
      frame: false,
      transparent: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    const html = `
      <!DOCTYPE html>
      <html lang="fr">
        <head>
          <meta charset="UTF-8" />
          <meta name="color-scheme" content="light dark">
          <style>
            body {
              margin: 0;
              -webkit-app-region: drag;
              height: 100vh;
              display: flex;
              align-items: center;
              justify-content: center;
              flex-direction: column;
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
              background-color: transparent;
              color: #333;
            }
            .card {
              text-align: center;
              padding: 30px;
              border-radius: 12px;
              box-shadow: 0 8px 30px rgba(0,0,0,0.1);
              background: #fff;
              width: 380px;
            }
            h2 {
              margin-bottom: 10px;
              -webkit-app-region: no-drag;
            }
            p {
              color: #555;
              font-size: 14px;
              -webkit-app-region: no-drag;
            }
            a {
              color: #b700ff;
              text-decoration: none;
              font-weight: 500;
              -webkit-app-region: no-drag;
            }
            a:hover {
              text-decoration: underline;
            }
            button {
              margin-top: 20px;
              padding: 10px 18px;
              border: none;
              border-radius: 8px;
              background: #b700ff;
              color: white;
              cursor: pointer;
              -webkit-app-region: no-drag;
              font-size: 14px;
            }
            button:hover {
              background: #a000e0;
            }

            @media (prefers-color-scheme: dark) {
              body {
                color: #e5e5e5;
              }
              .card {
                background: #1e1e1e;
                box-shadow: 0 8px 30px rgba(0,0,0,0.3);
              }
              p {
                color: #b0b0b0;
              }
              a {
                color: #c77dff;
              }
              button {
                background: #9d4edd;
              }
              button:hover {
                background: #7b2cbf;
              }
            }
          </style>
        </head>
        <body>
          <div class="card">
            <h2>⚠️ Un problème est survenu</h2>
            <p>Impossible de contacter le serveur Wagoo.</p>
            <p>Consultez notre uptime : 
              <a href="https://uptime.wagoo.app" target="_blank">uptime.wagoo.app</a>
            </p>
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

    offlineWindow.on("closed", () => {
      logger.info("Fenêtre offline fermée");
    });
  } catch (err) {
    logger.error("Erreur affichage fenêtre offline:", err);
  }
}

/**
 * Crée la fenêtre principale avec gestion d'erreurs robuste
 */
function createWindow() {
  try {
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
      show: false,
    });

    const loadMainURL = async () => {
      const targetURL = deeplinkingUrl
        ? buildTargetFromWagoo(deeplinkingUrl)
        : CONFIG.baseURL;

      try {
        const res = await fetchWithTimeout(targetURL, { method: "HEAD" });
        if (!res.ok) throw new Error("Site inaccessible");

        mainWindow.loadURL(targetURL);
      } catch (err) {
        logger.error("Erreur chargement URL:", err);
        if (mainWindow) mainWindow.close();
        showOfflineWindow();
      }
    };

    loadMainURL();

    mainWindow.webContents.on("did-finish-load", () => {
      mainWindow.show();
      mainWindow.maximize();
      logger.info("Fenêtre affichée au démarrage");
    });

    mainWindow.on("close", (event) => {
      if (!isQuitting) {
        event.preventDefault();
        mainWindow.hide();

        if (Notification.isSupported()) {
          try {
            new Notification({
              title: "Wagoo Desktop",
              body: "L'application continue de fonctionner en arrière-plan. Utilisez l'icône dans la barre des tâches pour la rouvrir.",
              icon: getIconPath("logo.png"),
            }).show();
          } catch (err) {
            logger.error("Erreur notification fermeture:", err);
          }
        }

        return false;
      }
    });

    mainWindow.on("closed", () => {
      mainWindow = null;
    });

    // Gestion des erreurs de contenu
    mainWindow.webContents.on("crashed", () => {
      logger.error("Contenu webview crashed");
      showOfflineWindow();
    });

    mainWindow.webContents.on("unresponsive", () => {
      logger.warn("Contenu webview ne répond pas");
    });
  } catch (err) {
    logger.error("Erreur création fenêtre:", err);
    showOfflineWindow();
  }
}

/**
 * Affiche le dialog "À propos" avec gestion d'erreurs
 */
function showAboutDialog() {
  try {
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
          <meta name="color-scheme" content="light dark">
          <title>À propos</title>
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
              margin: 0;
              padding: 30px;
              background-color: transparent;
              color: #333;
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
              transition: background 0.2s;
            }
            .close-btn:hover {
              background: #e0e0e0;
              color: #333;
            }
            h1 {
              margin-top: 0;
              font-size: 1.8em;
              -webkit-app-region: no-drag;
            }
            p {
              color: #555;
              line-height: 1.6;
              margin: 10px 0;
              -webkit-app-region: no-drag;
            }

            @media (prefers-color-scheme: dark) {
              body {
                color: #e5e5e5;
              }
              .container {
                background: #1e1e1e;
                box-shadow: 0 4px 20px rgba(0,0,0,0.3);
              }
              .close-btn {
                background: #2a2a2a;
                color: #999;
              }
              .close-btn:hover {
                background: #3a3a3a;
                color: #e5e5e5;
              }
              p {
                color: #b0b0b0;
              }
            }
          </style>
        </head>
        <body>
          <div class="container">
            <button class="close-btn" onclick="window.close()">×</button>
            <h1>À propos de Wagoo Desktop</h1>
            <p><strong>Version :</strong> ${app.getVersion()}</p>
            <p><strong>Auteur :</strong> WAGOO SAAS</p>
            <p><strong>Powered by :</strong> Electron.JS</p>
            <p style="margin-top: 20px; font-size: 12px; color: #888;">
              L'application reste active en arrière-plan même après fermeture de la fenêtre.
            </p>
          </div>
        </body>
      </html>
    `;

    aboutWindow.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(htmlContent)}`
    );
    aboutWindow.setMenuBarVisibility(false);
  } catch (err) {
    logger.error("Erreur affichage dialog À propos:", err);
  }
}

/**
 * Construit une URL cible depuis un deeplink wagoo://
 * @param {string} rawUrl - URL brute à traiter
 * @returns {string} URL complète à charger
 */
function buildTargetFromWagoo(rawUrl) {
  try {
    const urlObj = new URL(rawUrl);
    let pathStr = "";
    if (urlObj.hostname && urlObj.hostname !== "")
      pathStr += `/${urlObj.hostname}`;
    if (urlObj.pathname && urlObj.pathname !== "/") pathStr += urlObj.pathname;
    pathStr = pathStr.replace(/^\/+/, "");
    const base = CONFIG.baseURL + "/";
    return pathStr ? `${base}${pathStr}${urlObj.search}` : `${base}${urlObj.search}`;
  } catch (err) {
    logger.error("Erreur buildTargetFromWagoo:", err);
    return CONFIG.baseURL + "/";
  }
}

/**
 * Gère les deeplinks wagoo://
 * @param {string} rawUrl - URL deeplink
 */
function handleDeepLink(rawUrl) {
  try {
    logger.info(`Traitement deeplink: ${rawUrl}`);
    if (!rawUrl || !rawUrl.startsWith("wagoo://")) return;

    const target = buildTargetFromWagoo(rawUrl);
    if (mainWindow) {
      logger.debug(`Chargement cible: ${target}`);
      mainWindow.loadURL(target).catch((e) => {
        logger.error("Erreur chargement deeplink:", e);
      });
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    } else {
      logger.debug("Fenêtre pas prête, sauvegarde deeplink");
      deeplinkingUrl = rawUrl;
    }
  } catch (err) {
    logger.error("Erreur gestion deeplink:", err);
  }
}

// ========================================
// AUTO-UPDATER
// ========================================

function initAutoUpdater() {
  if (!app.isPackaged) {
    console.log("[AutoUpdater] Ignoré (app non packagée)");
    return;
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on("checking-for-update", () => {
    console.log("[Updater] Vérification...");
    mainWindow?.webContents.send("updater:checking");
  });

  autoUpdater.on("update-not-available", () => {
    console.log("[Updater] Aucune mise à jour trouvée.");
    mainWindow?.webContents.send("updater:not-available");
  });

  autoUpdater.on("update-available", (info) => {
    console.log("[Updater] Mise à jour trouvée :", info.version);
    mainWindow?.webContents.send("updater:available", {
      version: info.version,
      releaseDate: info.releaseDate,
      releaseNotes: info.releaseNotes,
    });
  });

  autoUpdater.on("download-progress", (progressObj) => {
    mainWindow?.webContents.send("updater:progress", {
      percent: progressObj.percent,
      transferred: progressObj.transferred,
      total: progressObj.total,
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    console.log("[Updater] Téléchargement terminé !");
    mainWindow?.webContents.send("updater:downloaded", {
      version: info.version,
    });
  });

  autoUpdater.on("error", (err) => {
    console.error("[Updater] Erreur :", err);
    mainWindow?.webContents.send("updater:error", {
      message: err.message || "Erreur inconnue",
    });
  });

  autoUpdater.checkForUpdatesAndNotify();
}

ipcMain.handle("updater:check", async () => {
  try {
    await autoUpdater.checkForUpdates();
    return { success: true };
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
  autoUpdater.quitAndInstall(false, true);
  return { success: true };
});

// ========================================
// APP LIFECYCLE
// ========================================

app.on("open-url", (event, url) => {
  event.preventDefault();
  console.log("[main] open-url event:", url);
  if (app.isReady() && mainWindow) {
    handleDeepLink(url);
  } else {
    deeplinkingUrl = url;
  }
});

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", (event, argv) => {
    console.log("[main] second-instance argv:", argv);
    const deepLink = argv.find(
      (arg) => typeof arg === "string" && arg.startsWith("wagoo://")
    );
    if (deepLink) {
      handleDeepLink(deepLink);
    }
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
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
        console.log("[main] deep link found in process.argv:", cliDeepLink);
        deeplinkingUrl = cliDeepLink;
      }
    }

    // Créer le tray AVANT la fenêtre pour qu'il soit toujours présent
    createTray();
    createWindow();

    if (deeplinkingUrl) {
      handleDeepLink(deeplinkingUrl);
      deeplinkingUrl = null;
    }

    // Démarrage des services réseau
    startWebSocketServer();
    startDiscoveryService();

    initAutoUpdater();
  });
}

function createMenu() {
  const template = [
    {
      label: "Application",
      submenu: [
        {
          label: "Vérifier les mises à jour",
          click: () => autoUpdater.checkForUpdates(),
        },
        {
          label: "Afficher les informations de l'application",
          click: () => showAboutDialog(),
        },
        { type: "separator" },
        {
          role: "quit",
          label: "Quitter",
          click: () => {
            isQuitting = true;
            app.quit();
          },
        },
      ],
    },
  ];
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

app.on("window-all-closed", () => {
  // Ne PAS quitter l'app quand toutes les fenêtres sont fermées
  // L'app continue en arrière-plan avec le tray
  console.log("[App] Toutes les fenêtres fermées, l'app reste en arrière-plan");
});

app.on("activate", () => {
  // Sur macOS, recréer la fenêtre si elle n'existe pas
  if (!mainWindow) {
    createWindow();
  } else {
    mainWindow.show();
  }
});

app.on("before-quit", () => {
  logger.info("Application en train de fermer...");
  isQuitting = true;
  stopWebSocketServer();
  stopDiscoveryService();
  logger.info("Services arrêtés, arrêt application");
});

// ========================================
// IPC HANDLERS
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

/**
 * Envoie le statut des connexions WebSocket à la fenêtre
 */
function sendConnectionStatus() {
  const status = {
    devices: Array.from(wsConnections.values()).map((connData) => ({
      ip: connData.clientData.ip,
      platform: "unknown",
      timestamp: Date.now(),
    })),
  };

  if (mainWindow && mainWindow.webContents) {
    try {
      mainWindow.webContents.send("connection:status", status);
    } catch (err) {
      logger.debug("Erreur envoi status:", err);
    }
  }
}

ipcMain.handle("app:getVersion", () => {
  return app.getVersion();
});
