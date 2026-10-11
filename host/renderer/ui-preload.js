const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('glidr', {
  state: () => ipcRenderer.invoke('state'),
  act: (name, arg) => ipcRenderer.invoke('act', name, arg),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
});
