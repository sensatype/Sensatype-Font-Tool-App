// Preload minimal — satu-satunya jembatan renderer↔main (contextBridge, bukan nodeIntegration).
// Tak mengekspos apa pun soal token: login dibuka di browser sistem, token tinggal di keyring
// backend Python. Renderer cukup tahu ini Electron + bisa minta membuka URL login.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("sensatype", {
  isElectron: true,
  openExternal: (url) => ipcRenderer.invoke("sensatype:open-external", url),
  // Bawa jendela app ke depan (dipakai setelah login sukses → "buka app, bukan web").
  focus: () => ipcRenderer.invoke("sensatype:focus"),
});
