const { app, BrowserWindow, dialog, session, Menu } = require("electron");
const { autoUpdater } = require("electron-updater");
const path = require("path");
const { version } = require("./package.json");

let mainWindow;

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
      preload: path.join(__dirname, "preload.js"), // si besoin
    },
  });

  mainWindow.loadURL("http://localhost:3000");
  mainWindow.maximize();

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Crée le menu
  createMenu();
}

// Auto-update
function initAutoUpdater() {
  if (!app.isPackaged) {
    console.log("Mode développement : auto-update ignoré");
    return;
  }

  autoUpdater.checkForUpdatesAndNotify();

  autoUpdater.on("update-available", () => {
    dialog.showMessageBox({
      type: "info",
      title: "Mise à jour disponible",
      message:
        "Une nouvelle version est disponible. Elle sera téléchargée en arrière-plan.",
    });
  });

  autoUpdater.on("update-downloaded", () => {
    dialog
      .showMessageBox({
        type: "info",
        title: "Mise à jour prête",
        message:
          "La mise à jour a été téléchargée. L'application va redémarrer pour l'installer.",
      })
      .then(() => autoUpdater.quitAndInstall());
  });

  autoUpdater.on("error", (err) => {
    console.error("Erreur de mise à jour :", err);
  });
}

// Crée le menu avec boutons
function createMenu() {
  const template = [
    {
      label: "App",
      submenu: [
        {
          label: "Infos de l'application",
          click: () => {
            const infoWindow = new BrowserWindow({
              width: 500,
              height: 400,
              title: "Infos de l'application",
              resizable: false,
              minimizable: false,
              maximizable: false,
              modal: true,
              parent: mainWindow,
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
                  <title>Infos de l'application</title>
                  <style>
                    body {
                      font-family: Arial, sans-serif;
                      margin: 0;
                      padding: 20px;
                      background-color: #1e1e1e;
                      color: #ffffff;
                      text-align: center;
                    }
                    h1 {
                      color: #0078d7;
                      margin-bottom: 20px;
                    }
                    p {
                      margin: 10px 0;
                    }
                    button {
                      margin-top: 20px;
                      padding: 10px 20px;
                      font-size: 14px;
                      color: #fff;
                      background-color: #0078d7;
                      border: none;
                      border-radius: 5px;
                      cursor: pointer;
                    }
                    button:hover {
                      background-color: #005a9e;
                    }
                  </style>
                </head>
                <body>
                  <h1>Infos de l'application</h1>
                  <p>Nom: ${app.name}</p>
                  <p>Version: ${version}</p>
                  <p>ID: ${app.getName()}</p>
                  <button id="closeBtn">Fermer</button>
                  <script>
                    document.getElementById('closeBtn').addEventListener('click', () => {
                      window.close();
                    });
                  </script>
                </body>
              </html>
            `;

            infoWindow.loadURL(
              `data:text/html;charset=UTF-8,${encodeURIComponent(htmlContent)}`
            );
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

app.on("ready", () => {
  createWindow();
  initAutoUpdater();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (!mainWindow) createWindow();
});
