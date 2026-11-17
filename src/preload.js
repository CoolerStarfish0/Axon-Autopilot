const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("autopilot", {
  submitTask: (task) => ipcRenderer.invoke("autopilot:submit", task),
  updateSettings: (settings) => ipcRenderer.send("autopilot:settings", settings),
  hide: () => ipcRenderer.send("autopilot:hide"),
  stopTask: () => ipcRenderer.send("autopilot:stop"),

  onStatus: (callback) => {
    ipcRenderer.on("autopilot:status", (_event, message) => callback(message));
  },

  onIndicatorLoading: (callback) => {
    ipcRenderer.on("indicator:loading", () => callback());
  },

  onIndicatorComplete: (callback) => {
    ipcRenderer.on("indicator:complete", () => callback());
  }
});
