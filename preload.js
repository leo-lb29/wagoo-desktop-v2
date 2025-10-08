const { contextBridge, app } = require("electron");


contextBridge.exposeInMainWorld("appInfo", {
  version: "1.0.6",
});

contextBridge.exposeInMainWorld("electron", {
  isElectron: true,
});