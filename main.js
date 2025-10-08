// main.js
const {
  app,
  BrowserWindow,
  dialog,
  session,
  Menu,
} = require("electron");
const { autoUpdater } = require("electron-updater");
const path = require("path");

let mainWindow = null;
// stocke un potentiel deep link reçu avant la création de la fenêtre
let deeplinkingUrl = null;

function createWindow() {
  const wagooSession = session.fromPartition("persist:wagoo-session");

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      session: wagooSession,
      preload: path.join(__dirname, "preload.js"),
      devTools: true,
    },
  });

  // Si on a reçu un deep link avant la création de la fenêtre, on l'utilise.
  if (deeplinkingUrl) {
    console.log("[main] Launching from deep link:", deeplinkingUrl);
    const target = buildTargetFromWagoo(deeplinkingUrl);
    mainWindow.loadURL(target).catch((e) => console.error(e));
    // on nettoie la variable après usage
    deeplinkingUrl = null;
  } else {
    // page par défaut si pas de deep link
    mainWindow.loadURL("http://localhost:3000/login-magic-link").catch((e) => console.error(e));
  }

  mainWindow.maximize();

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  createMenu();
}

// Convertit "wagoo://..." -> "http://localhost:3000/<path>?<query>"
function buildTargetFromWagoo(rawUrl) {
  try {
    const urlObj = new URL(rawUrl);
    // Certains liens peuvent utiliser le hostname comme première partie du chemin
    // e.g. wagoo://login-magic-link?token=...  => hostname = 'login-magic-link'
    // ou wagoo://app/login-magic-link?token=... => hostname='app', pathname='/login-magic-link'
    let path = "";
    if (urlObj.hostname && urlObj.hostname !== "") path += `/${urlObj.hostname}`;
    if (urlObj.pathname && urlObj.pathname !== "/") path += urlObj.pathname;
    // nettoie les slashes en début
    path = path.replace(/^\/+/, "");
    const base = "http://localhost:3000";
    // si pas de path, on ouvre la racine avec les querys (ex: ?token=...)
    return path ? `${base}/${path}${urlObj.search}` : `${base}${urlObj.search}`;
  } catch (err) {
    console.error("[main] buildTargetFromWagoo error:", err, "rawUrl:", rawUrl);
    return "http://localhost:3000/";
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
  if (!app.isPackaged) return;

  autoUpdater.checkForUpdatesAndNotify();

  autoUpdater.on("update-available", () => {
    dialog.showMessageBox({
      type: "info",
      title: "Mise à jour disponible",
      message: "Une nouvelle version est disponible et sera téléchargée.",
    });
  });

  autoUpdater.on("update-downloaded", () => {
    dialog
      .showMessageBox({
        type: "info",
        title: "Mise à jour prête",
        message: "Redémarrage pour installer la mise à jour.",
      })
      .then(() => autoUpdater.quitAndInstall());
  });

  autoUpdater.on("error", (err) => console.error("Erreur de mise à jour :", err));
}

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
    const deepLink = argv.find((arg) => typeof arg === "string" && arg.startsWith("wagoo://"));
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
        app.setAsDefaultProtocolClient("wagoo", process.execPath, [path.resolve(process.argv[1])]);
      }
    } else {
      app.setAsDefaultProtocolClient("wagoo");
    }

    // Si l'app a été démarrée AVEC un arg wagoo:// (premier lancement),
    // il se trouvera dans process.argv (Windows/Linux). On le capture ici.
    if (process.platform === "win32" || process.platform === "linux") {
      const cliDeepLink = process.argv.find((arg) => typeof arg === "string" && arg.startsWith("wagoo://"));
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
      label: "App",
      submenu: [
        {
          label: "Ouvrir DevTools",
          accelerator: "F12",
          click: () => mainWindow?.webContents.openDevTools(),
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
  if (!mainWindow) createWindow();
});
