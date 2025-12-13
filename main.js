// main.js
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
let splashWindow = null;
let wss = null;
let discoverySocket = null;
let wsConnections = new Set();
let isQuitting = false; // Flag pour gérer la fermeture réelle

// Configuration
const WS_PORT = 9876;
const DISCOVERY_PORT = 9877;
const SERVICE_NAME = "wagoo-desktop";

if (process.platform === "linux") {
  app.commandLine.appendSwitch("enable-features", "UseOzonePlatform");
  app.commandLine.appendSwitch("ozone-platform", "wayland");
}

// ========================================
// DÉCOUVERTE RÉSEAU (UDP Broadcast)
// ========================================

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

function startDiscoveryService() {
  discoverySocket = dgram.createSocket("udp4");

  discoverySocket.on("error", (err) => {
    console.error("[Discovery] Erreur:", err);
    discoverySocket.close();
  });

  discoverySocket.on("message", (msg, rinfo) => {
    const message = msg.toString();
    console.log(
      `[Discovery] Message reçu de ${rinfo.address}:${rinfo.port} - ${message}`
    );

    if (message === "WAGOO_DISCOVERY_REQUEST") {
      const localIP = getLocalIPAddress();
      const response = JSON.stringify({
        service: SERVICE_NAME,
        ip: localIP,
        wsPort: WS_PORT,
        hostname: os.hostname(),
        version: app.getVersion(),
        platform: process.platform,
      });

      discoverySocket.send(response, rinfo.port, rinfo.address, (err) => {
        if (err) {
          console.error("[Discovery] Erreur envoi réponse:", err);
        } else {
          console.log(
            `[Discovery] Réponse envoyée à ${rinfo.address}:${rinfo.port}`
          );
        }
      });
    }
  });

  discoverySocket.on("listening", () => {
    const address = discoverySocket.address();
    console.log(
      `[Discovery] Service d'écoute sur ${address.address}:${address.port}`
    );
    discoverySocket.setBroadcast(true);
  });

  discoverySocket.bind(DISCOVERY_PORT);
}

function stopDiscoveryService() {
  if (discoverySocket) {
    discoverySocket.close();
    discoverySocket = null;
    console.log("[Discovery] Service arrêté");
  }
}

// ========================================
// SERVEUR WEBSOCKET
// ========================================

function startWebSocketServer() {
  try {
    wss = new WebSocket.Server({
      port: WS_PORT,
      host: "0.0.0.0",
    });
  } catch (err) {
    console.error("[WebSocket] Erreur lors du démarrage:", err);
    try {
      wss = new WebSocket.Server({
        port: WS_PORT + 1,
        host: "0.0.0.0",
      });
      console.log(`[WebSocket] Démarré sur le port alternatif ${WS_PORT + 1}`);
    } catch (err2) {
      console.error("[WebSocket] Impossible de démarrer le serveur:", err2);
      return;
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

  showNotification(
    "QR Code scanné",
    data.content || "Code détecté",
    data.content
  );

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
                `http://localhost:3000/?qr=${encodeURIComponent(qrContent)}`
              );
            });
          } else if (qrContent.startsWith("wagoo://")) {
            handleDeepLink(qrContent);
          } else {
            mainWindow.loadURL(
              `http://localhost:3000/?qr=${encodeURIComponent(qrContent)}`
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
}

// ========================================
// FENÊTRES
// ========================================

function createSplash() {
  splashWindow = new BrowserWindow({
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
    },
  });

  const splashHTML = `
  <!DOCTYPE html>
  <html lang="fr">
    <head>
      <meta charset="UTF-8" />
      <meta name="color-scheme" content="light dark">
      <style>
        @import url('https://fonts.googleapis.com/css2?family=Baloo+2:wght@400;600;800&display=swap');

        body {
          margin: 0;
          height: 100vh;
          display: flex;
          justify-content: center;
          shadow: none;
          align-items: center;
          font-family: 'Baloo 2', sans-serif;
          background: transparent;
        }

        .card {
          background: #fff;
          border-radius: 16px;
          padding: 40px;
          text-align: center;
          shadow: none;
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
          align-items: center;
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

        .text {
          font-weight: 500;
          color: #333;
        }

        @media (prefers-color-scheme: dark) {
          .card {
            background: #1e1e1e;
            box-shadow: 0 10px 30px rgba(0,0,0,0.3);
          }

          .logo {
            color: #a78bfa;
          }

          .dot {
            background: #a78bfa;
          }

          .text {
            color: #e5e5e5;
          }

          .version {
            color: #666 !important;
          }
        }
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
    
        <div class="version" style="margin-top: 12px; font-size: 12px; color: #999;">Sakura-${app.getVersion()}</div>
      </div>
    </body>
  </html>
  `;

  splashWindow.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(splashHTML)}`
  );

  splashWindow.show();
}

function showOfflineWindow() {
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
            -webkit-app-region: no-drag;
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
}

function createWindow() {
  createSplash();

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
      devTools: false,
    },
    show: false,
  });

  const loadMainURL = async () => {
    const targetURL = deeplinkingUrl
      ? buildTargetFromWagoo(deeplinkingUrl)
      : "http://localhost:3000/";

    try {
      const res = await fetch(targetURL, { method: "HEAD", timeout: 5000 });
      if (!res.ok) throw new Error("Site inaccessible");

      mainWindow.loadURL(targetURL);
    } catch (err) {
      console.error("[main] Site non joignable :", err);
      if (splashWindow) splashWindow.close();
      if (mainWindow) mainWindow.close();

      showOfflineWindow();
    }
  };

  loadMainURL();

  mainWindow.webContents.on("did-finish-load", () => {
    if (splashWindow) {
      splashWindow.close();
      splashWindow = null;
    }
    mainWindow.show();
    mainWindow.maximize();
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
}

function buildTargetFromWagoo(rawUrl) {
  try {
    const urlObj = new URL(rawUrl);
    let path = "";
    if (urlObj.hostname && urlObj.hostname !== "")
      path += `/${urlObj.hostname}`;
    if (urlObj.pathname && urlObj.pathname !== "/") path += urlObj.pathname;
    path = path.replace(/^\/+/, "");
    const base = "http://localhost:3000/";
    return path ? `${base}/${path}${urlObj.search}` : `${base}${urlObj.search}`;
  } catch (err) {
    console.error("[main] buildTargetFromWagoo error:", err, "rawUrl:", rawUrl);
    return "http://localhost:3000//";
  }
}

function handleDeepLink(rawUrl) {
  console.log("[main] handleDeepLink:", rawUrl);
  if (!rawUrl || !rawUrl.startsWith("wagoo://")) return;

  const target = buildTargetFromWagoo(rawUrl);
  if (mainWindow) {
    console.log("[main] loading target:", target);
    mainWindow.loadURL(target).catch((e) => console.error(e));
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  } else {
    console.log("[main] no window yet, saving deeplink to handle after ready");
    deeplinkingUrl = rawUrl;
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
  // Arrêter les services réseau avant de quitter
  isQuitting = true;
  stopWebSocketServer();
  stopDiscoveryService();
});

// ========================================
// IPC HANDLERS
// ========================================

ipcMain.on("window:minimize", () => mainWindow?.minimize());
ipcMain.on("window:maximize", () => {
  if (!mainWindow) return;
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
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