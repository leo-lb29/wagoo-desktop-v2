const { contextBridge, app } = require("electron");
const { version } = require("./package.json");

contextBridge.exposeInMainWorld("appInfo", {
  version: version
});
