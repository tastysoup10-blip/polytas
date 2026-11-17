/*
 * The game window's bridge: what the game's own 0.6.3 preload gives it (window.electron), plus
 * window.tasBridge for the TAS mod — opening the TAS window (on its input editor or its bruteforce), and
 * talking to each of its two parts.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  quit: () => ipcRenderer.send('quit'),
  addFullscreenChangeListener: (fn) => ipcRenderer.on('fullscreen-change', () => fn()),
  isFullscreen: () => ipcRenderer.sendSync('is-fullscreen'),
  setFullscreen: (on) => ipcRenderer.send('set-fullscreen', on),
  getArgv: () => ipcRenderer.sendSync('get-argv'),
  log: (text) => ipcRenderer.send('log-message', text),
});

contextBridge.exposeInMainWorld('tasBridge', {
  openEditor: () => ipcRenderer.send('tas-open-editor'),
  send: (msg) => ipcRenderer.send('tas-to-editor', msg),
  onMessage: (fn) => ipcRenderer.on('tas-from-editor', (e, msg) => fn(msg)),
  openBrute: () => ipcRenderer.send('tas-open-brute'),
  sendBrute: (msg) => ipcRenderer.send('tas-to-brute', msg),
  onBruteMessage: (fn) => ipcRenderer.on('tas-from-brute', (e, msg) => fn(msg)),
});
