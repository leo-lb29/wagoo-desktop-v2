const { app, BrowserWindow, session, Menu } = require("electron");
const { autoUpdater } = require("electron-updater");

let mainWindow;

app.on("ready", () => {
  // Crée une session persistante
  const persistentSession = session.fromPartition("persist:wagoo-session");

  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      contextIsolation: true,
      enableRemoteModule: false,
      nodeIntegration: false,
      sandbox: true,
      session: persistentSession, // Associe la session persistante à la fenêtre
    },
  });

  mainWindow.maximize(); // Maximiser la fenêtre

  mainWindow.loadURL("http://localhost:3001");

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Vérifie les mises à jour après le démarrage de l'application
  autoUpdater.checkForUpdatesAndNotify();

  // Crée un menu avec un bouton pour vérifier les mises à jour
  const menuTemplate = [
    {
      label: "Fichier",
      submenu: [
        {
          label: "Vérifier les mises à jour",
          click: () => {
            autoUpdater.checkForUpdatesAndNotify();
          },
        },
        { role: "quit" },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(menuTemplate);
  Menu.setApplicationMenu(menu);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (mainWindow === null) {
    const persistentSession = session.fromPartition("persist:wagoo-session");

    mainWindow = new BrowserWindow({
      width: 800,
      height: 600,
      webPreferences: {
        contextIsolation: true,
        enableRemoteModule: false,
        nodeIntegration: false,
        sandbox: true,
        session: persistentSession,
      },
    });

    mainWindow.maximize(); // Maximiser la fenêtre

    mainWindow.loadURL("http://localhost:3001");
  }
});

// Gestion des événements de mise à jour
autoUpdater.on("update-available", () => {
  console.log("Une mise à jour est disponible.");
});

autoUpdater.on("update-not-available", () => {
  console.log("Aucune mise à jour disponible.");
});

autoUpdater.on("error", (err) => {
  console.error("Erreur lors de la vérification des mises à jour :", err);
});

autoUpdater.on("download-progress", (progressObj) => {
  console.log(`Progression du téléchargement : ${progressObj.percent}%`);
});

autoUpdater.on("update-downloaded", () => {
  console.log(
    "Mise à jour téléchargée. Elle sera appliquée au prochain démarrage."
  );
});
