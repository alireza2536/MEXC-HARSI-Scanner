const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("harsiDesktop", {
  getStatus: () => ipcRenderer.invoke("harsi:status"),
  refreshNow: (timeframes) => ipcRenderer.invoke("harsi:refresh", timeframes),
  cancelNow: () => ipcRenderer.invoke("harsi:cancel"),
  exportText: (content, fileName) => ipcRenderer.invoke("harsi:exportText", { content, fileName }),
  onStatus: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("harsi:status", listener);
    return () => ipcRenderer.removeListener("harsi:status", listener);
  }
});
