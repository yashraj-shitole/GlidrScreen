const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('engineBridge', {
  onCmd: (cb) => ipcRenderer.on('cmd', (_e, m) => cb(m)),
  emit: (m) => ipcRenderer.send('evt', m),
});
