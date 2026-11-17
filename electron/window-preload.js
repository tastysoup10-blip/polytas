/*
 * The TAS window's bridges (tas/window/): the input editor's and the bruteforce's to the game window (each its
 * own channel, through the main process), and the window's own (which part to show, staying on top).
 */
const { contextBridge, ipcRenderer } = require('electron');

// the input editor's (tas/window/editor.js), and its file dialogs
contextBridge.exposeInMainWorld('tasBridge', {
  send: (msg) => ipcRenderer.send('tas-to-game', msg),
  onMessage: (fn) => ipcRenderer.on('tas-from-game', (e, msg) => fn(msg)),
  focusGame: () => ipcRenderer.send('tas-focus-game'),
  saveFile: (name, text) => ipcRenderer.invoke('tas-save-file', { name, text }),
  openFile: () => ipcRenderer.invoke('tas-open-file'),
});

// the bruteforce's (tas/window/brute.js)
contextBridge.exposeInMainWorld('tasBruteBridge', {
  send: (msg) => ipcRenderer.send('tas-brute-to-game', msg),
  onMessage: (fn) => ipcRenderer.on('tas-brute-from-game', (e, msg) => fn(msg)),
});

// the window's (tas/window/window.js)
contextBridge.exposeInMainWorld('tasWindow', {
  setOnTop: (on) => ipcRenderer.send('tas-window-on-top', on),
  onShow: (fn) => ipcRenderer.on('tas-window-show', (e, part) => fn(part)),
  argv: () => ipcRenderer.sendSync('get-argv'),
  log: (text) => ipcRenderer.send('log-message', text),
});
