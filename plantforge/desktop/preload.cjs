// The bridge between the Studio page and the desktop program. The page never gets Node.js or the file
// system: it can only ask for these few things (open, save, export, dialogs, window title).

const { contextBridge, ipcRenderer, webUtils } = require("electron");

const listeners = { menu: new Set(), "open-path": new Set(), "close-requested": new Set() };
for (const channel of Object.keys(listeners)) {
  ipcRenderer.on(channel, (_e, ...args) => {
    for (const fn of listeners[channel]) {
      try {
        fn(...args);
      } catch (err) {
        console.error(err);
      }
    }
  });
}

contextBridge.exposeInMainWorld("plantforgeDesktop", {
  info: () => ipcRenderer.invoke("app:info"),
  initialFile: () => ipcRenderer.invoke("file:initial"),
  openDialog: () => ipcRenderer.invoke("file:open-dialog"),
  readFile: (path) => ipcRenderer.invoke("file:read", path),
  saveFile: (o) => ipcRenderer.invoke("file:save", o),
  exportFile: (o) => ipcRenderer.invoke("file:export", o),
  setDocument: (state) => ipcRenderer.send("doc:state", state),
  ask: (o) => ipcRenderer.invoke("dialog:ask", o),
  closeNow: (how) => ipcRenderer.send("win:close-now", how),
  showInFolder: (path) => ipcRenderer.send("shell:show", path),
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || null;
    } catch {
      return null;
    }
  },
  on: (channel, fn) => {
    if (!listeners[channel] || typeof fn !== "function") return () => {};
    listeners[channel].add(fn);
    if (channel === "close-requested") ipcRenderer.send("close:handled");
    return () => listeners[channel].delete(fn);
  },
});
