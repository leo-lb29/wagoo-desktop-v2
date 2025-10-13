// main.js
const {
  app,
  BrowserWindow,
  dialog,
  session,
  Menu,
  ipcMain,
} = require("electron");
const { autoUpdater } = require("electron-updater");
const path = require("path");
let mainWindow = null;
// stocke un potentiel deep link reçu avant la création de la fenêtre
let deeplinkingUrl = null;
let splashWindow = null;

if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-features', 'UseOzonePlatform');
  app.commandLine.appendSwitch('ozone-platform', 'wayland'); // ou 'x11'
}

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
  createSplash(); // affiche le loader

  const wagooSession = session.fromPartition("persist:wagoo-session");

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: "Wagoo Desktop - v" + app.getVersion(),
    frame: true, // contrôles custom
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
      : "https://dashtest.wagoo.app";

    try {
      // 🧠 Vérifie la connectivité avant de charger
      const res = await fetch(targetURL, { method: "HEAD", timeout: 5000 });
      if (!res.ok) throw new Error("Site inaccessible");

      // Si OK, on charge normalement
      mainWindow.loadURL(targetURL);
    } catch (err) {
      console.error("[main] Site non joignable :", err);
      if (splashWindow) splashWindow.close();
      if (mainWindow) mainWindow.close();

      showOfflineWindow(); // 🚨 Ouvre la fenêtre d'erreur
    }
  };

  loadMainURL();

  // Quand la page principale est prête, on ferme le loader et on montre la fenêtre
  mainWindow.webContents.on("did-finish-load", () => {
    if (splashWindow) {
      splashWindow.close();
      splashWindow = null;
    }
    mainWindow.show();
    mainWindow.maximize();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // createMenu();
}

// Convertit "wagoo://..." -> "https://dashtest.wagoo.app/<path>?<query>"
function buildTargetFromWagoo(rawUrl) {
  try {
    const urlObj = new URL(rawUrl);
    // Certains liens peuvent utiliser le hostname comme première partie du chemin
    // e.g. wagoo://login-magic-link?token=...  => hostname = 'login-magic-link'
    // ou wagoo://app/login-magic-link?token=... => hostname='app', pathname='/login-magic-link'
    let path = "";
    if (urlObj.hostname && urlObj.hostname !== "")
      path += `/${urlObj.hostname}`;
    if (urlObj.pathname && urlObj.pathname !== "/") path += urlObj.pathname;
    // nettoie les slashes en début
    path = path.replace(/^\/+/, "");
    const base = "https://dashtest.wagoo.app";
    // si pas de path, on ouvre la racine avec les querys (ex: ?token=...)
    return path ? `${base}/${path}${urlObj.search}` : `${base}${urlObj.search}`;
  } catch (err) {
    console.error("[main] buildTargetFromWagoo error:", err, "rawUrl:", rawUrl);
    return "https://dashtest.wagoo.app/";
  }
}

function handleDeepLink(rawUrl) {
  console.log("[main] handleDeepLink:", rawUrl);
  if (!rawUrl || !rawUrl.startsWith("wagoo://")) return;

  // Si la fenêtre existe, charge directement. Sinon mémorise pour après createWindow.
  const target = buildTargetFromWagoo(rawUrl);
  if (mainWindow) {
    console.log("[main] loading target:", target);
    mainWindow.loadURL(target).catch((e) => console.error(e));
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  } else {
    console.log("[main] no window yet, saving deeplink to handle after ready");
    deeplinkingUrl = rawUrl;
  }
}

// Auto-update (inchangé, minimal)
function initAutoUpdater() {
  if (!app.isPackaged) {
    console.log("[AutoUpdater] Ignoré (app non packagée)");
    return;
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  // 🔍 Événements de l'auto-updater
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

  // ✅ Vérification automatique au démarrage
  autoUpdater.checkForUpdatesAndNotify();
}

// 📡 Handlers IPC pour le site web
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

// macOS: open-url (peut arriver avant ready)
app.on("open-url", (event, url) => {
  event.preventDefault();
  console.log("[main] open-url event:", url);
  // si l'app est prête et la fenêtre existante, traiter tout de suite
  if (app.isReady() && mainWindow) {
    handleDeepLink(url);
  } else {
    // sinon mémoriser pour traiter après la création de la fenêtre
    deeplinkingUrl = url;
  }
});

// Assure single instance (Windows/Linux)
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", (event, argv /*, workingDir */) => {
    console.log("[main] second-instance argv:", argv);
    // argv peut contenir le wagoo:// sur Windows
    const deepLink = argv.find(
      (arg) => typeof arg === "string" && arg.startsWith("wagoo://")
    );
    if (deepLink) {
      handleDeepLink(deepLink);
    }
    // focus fenêtre existante
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    // En DEV, pour que setAsDefaultProtocolClient fonctionne quand on lance `electron .`,
    // utiliser ce pattern (process.defaultApp true quand on lance via `electron .`)
    if (process.defaultApp) {
      if (process.argv.length >= 2) {
        app.setAsDefaultProtocolClient("wagoo", process.execPath, [
          path.resolve(process.argv[1]),
        ]);
      }
    } else {
      app.setAsDefaultProtocolClient("wagoo");
    }

    // Si l'app a été démarrée AVEC un arg wagoo:// (premier lancement),
    // il se trouvera dans process.argv (Windows/Linux). On le capture ici.
    if (process.platform === "win32" || process.platform === "linux") {
      const cliDeepLink = process.argv.find(
        (arg) => typeof arg === "string" && arg.startsWith("wagoo://")
      );
      if (cliDeepLink) {
        console.log("[main] deep link found in process.argv:", cliDeepLink);
        deeplinkingUrl = cliDeepLink;
      }
    }

    // crée la fenêtre (elle utilisera deeplinkingUrl si présent)
    createWindow();

    // si on avait mémorisé un deep link, on le traite explicitement après createWindow
    if (deeplinkingUrl) {
      handleDeepLink(deeplinkingUrl);
      deeplinkingUrl = null;
    }

    initAutoUpdater();
  });
}

// Menu minimal
function createMenu() {
  const template = [
    {
      label: "Application",
      submenu: [
        // {
        //   label: "Ouvrir DevTools",
        //   accelerator: "F12",
        //   click: () => mainWindow?.webContents.openDevTools(),
        // },
        {
          label: "Vérifier les mises à jour",
          click: () => autoUpdater.checkForUpdates(),
        },
        {
          label: "Afficher les informations de l'application",
          click: () => {
            const showAboutModal = async () => {
              try {
                const res = await fetch("https://dashtest.wagoo.app/version", {
                  method: "HEAD",
                  timeout: 5000,
                });
                if (res.ok) {
                  mainWindow.loadURL("https://dashtest.wagoo.app/version");
                } else {
                  throw new Error("Site non accessible");
                }
              } catch (err) {
                // Site non joignable, afficher le HTML statique
                const infoWindow = new BrowserWindow({
                  width: 500,
                  height: 400,
                  parent: mainWindow,
                  modal: true,
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
                      <h1>À propos de l'application</h1>
                      <p><strong>Version :</strong> ${app.getVersion()}</p>
                      <p><strong>Auteur :</strong> WAGOO SAAS</p>
                      <p><strong>POWERED By :</strong> Electron.JS</p>
                    </div>
                  </body>
                </html>
              `;

                infoWindow.loadURL(
                  `data:text/html;charset=utf-8,${encodeURIComponent(
                    htmlContent
                  )}`
                );
                infoWindow.setMenuBarVisibility(false);
              }
            };

            showAboutModal();
          },
        },

        { type: "separator" },
        {
          role: "quit",
          label: "Quitter",
        },
      ],
    },
  ];
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (!mainWindow) creatcrWindow();
});
ipcMain.on("window:minimize", () => mainWindow?.minimize());
ipcMain.on("window:maximize", () => {
  if (!mainWindow) return;
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.on("window:close", () => mainWindow?.close());

ipcMain.handle("app:getVersion", () => {
  return app.getVersion();
});


