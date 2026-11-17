/*
 * PolyTrack TAS — the Electron main process.
 *
 * Everything the game's own 0.6.3 main.js does, kept as it was (one window, the external links it
 * allows, F11 / Alt+Enter, the Origin header its servers expect), plus:
 *   - its own save data ("PolyTrack TAS" next to "PolyTrack"), so it runs beside the game and can
 *     never touch your real records or settings;
 *   - the TAS window: a second window with the input editor and the bruteforce, opened from the game (the
 *     "Open the input editor" and "Open the bruteforce" keys), that remembers where it was and can stay on
 *     top of the game;
 *   - the messages between the game and the window's two parts, and Save / Open dialogs for the editor;
 *   - no record is ever uploaded: requests that submit or verify runs are refused;
 *   - the start-up tweaks the Tweaks mod measured: compiled-code cache for the game's scripts, sound
 *     without a click first, the window shown on the game's colour.
 * --pt-background (tests) keeps the windows off screen and unfocused.
 */
const { app, BrowserWindow, session, shell, ipcMain, dialog, protocol } = require('electron');
const path = require('path');
const fs = require('fs');

const background = process.argv.includes('--pt-background');
// a test window off screen counts as covered, and Chromium would stop drawing it (and its replay with it)
if (background) app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
if (!app.commandLine.hasSwitch('user-data-dir')) app.setPath('userData', path.join(app.getPath('appData'), 'PolyTrack TAS'));
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
protocol.registerSchemesAsPrivileged([{ scheme: 'file', privileges: { standard: true, codeCache: true } }]);

let gameWindow = null;
let toolWindow = null;

if (!app.requestSingleInstanceLock()) app.quit();
else app.on('second-instance', () => {
  if (gameWindow) { if (gameWindow.isMinimized()) gameWindow.restore(); gameWindow.focus(); }
});

const EXTERNAL = ['https://opengameart.org/content/sci-fi-theme-1', 'https://www.crazygames.com/game/polytrack'];
app.on('web-contents-created', (event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://www.kodub.com/') || EXTERNAL.includes(url)) setImmediate(() => shell.openExternal(url));
    return { action: 'deny' };
  });
  contents.on('will-navigate', (e, url) => {
    e.preventDefault();
    const target = e.url || url;
    if (EXTERNAL.includes(target)) setImmediate(() => shell.openExternal(target));
  });
});

// ------------------------------------------------------------------ the game's own messages
ipcMain.on('get-argv', (e) => { e.returnValue = process.argv; });
ipcMain.on('log-message', (e, text) => { console.log(text); });
ipcMain.on('quit', () => app.quit());
ipcMain.on('is-fullscreen', (e) => { e.returnValue = gameWindow ? gameWindow.isFullScreen() : false; });
ipcMain.on('set-fullscreen', (e, on) => { if (gameWindow) gameWindow.setFullScreen(on); });
app.on('window-all-closed', () => app.quit());

// ------------------------------------------------------------------ the TAS window: the input editor and the bruteforce
// One window with both parts (tas/window/). The game's "Open the input editor" key opens it on the input editor,
// "Open the bruteforce" on the bruteforce; each part has its own channel to the game.
const toolState = () => path.join(app.getPath('userData'), 'tas-window.json');
function loadToolState() {
  // where it was; the first time, where the bruteforce window (or the input editor's) was before they were
  // one — at least big enough for the bruteforce
  try { return JSON.parse(fs.readFileSync(toolState(), 'utf8')); } catch { }
  for (const name of ['tas-brute-window.json', 'tas-editor-window.json']) {
    try {
      const st = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), name), 'utf8'));
      if (st.bounds) { st.bounds.width = Math.max(st.bounds.width || 0, 1180); st.bounds.height = Math.max(st.bounds.height || 0, 820); }
      return st;
    } catch { }
  }
  return {};
}
function saveToolState() {
  if (!toolWindow || toolWindow.isDestroyed()) return;
  try {
    const s = { bounds: toolWindow.getNormalBounds(), maximized: toolWindow.isMaximized(), onTop: toolWindow.isAlwaysOnTop() };
    fs.writeFileSync(toolState(), JSON.stringify(s));
  } catch (e) { console.log('[tas] could not save the TAS window position: ' + e.message); }
}
const toGame = (channel, msg) => { if (gameWindow && !gameWindow.isDestroyed()) gameWindow.webContents.send(channel, msg); };
const toTool = (channel, msg) => { if (toolWindow && !toolWindow.isDestroyed()) toolWindow.webContents.send(channel, msg); };

function openTool(part) {
  if (toolWindow && !toolWindow.isDestroyed()) {
    if (toolWindow.isMinimized()) toolWindow.restore();
    if (!background) toolWindow.focus();
    toTool('tas-window-show', part);
    return;
  }
  const st = loadToolState();
  const b = st.bounds || {};
  toolWindow = new BrowserWindow({
    width: b.width || 1180, height: b.height || 860, x: background ? -4000 : b.x, y: background ? -4000 : b.y,
    minWidth: 520, minHeight: 420, title: 'TAS', backgroundColor: '#1e1e28', autoHideMenuBar: true, show: false,
    alwaysOnTop: !!st.onTop, ...(background ? { skipTaskbar: true, focusable: false } : {}),
    webPreferences: { devTools: false, preload: path.join(__dirname, 'window-preload.js'), backgroundThrottling: false },
  });
  toolWindow.removeMenu();
  if (st.maximized && !background) toolWindow.maximize();
  toolWindow.once('ready-to-show', () => { if (background) toolWindow.showInactive(); else toolWindow.show(); });
  toolWindow.webContents.once('did-finish-load', () => toTool('tas-window-show', part));
  toolWindow.on('close', saveToolState);
  toolWindow.on('closed', () => {
    toolWindow = null;
    toGame('tas-from-editor', { type: 'closed' });
    toGame('tas-from-brute', { type: 'closed' });
  });
  toolWindow.loadFile(path.join(__dirname, '..', 'tas', 'window', 'window.html'));
}
ipcMain.on('tas-open-editor', () => openTool('inputs'));
ipcMain.on('tas-open-brute', () => openTool('brute'));
ipcMain.on('tas-to-editor', (e, msg) => toTool('tas-from-game', msg));
ipcMain.on('tas-to-brute', (e, msg) => toTool('tas-brute-from-game', msg));
ipcMain.on('tas-to-game', (e, msg) => toGame('tas-from-editor', msg));
ipcMain.on('tas-brute-to-game', (e, msg) => toGame('tas-from-brute', msg));
ipcMain.on('tas-window-on-top', (e, on) => { if (toolWindow && !toolWindow.isDestroyed()) { toolWindow.setAlwaysOnTop(!!on); saveToolState(); } });
ipcMain.on('tas-focus-game', () => { if (gameWindow && !background) gameWindow.focus(); });
ipcMain.handle('tas-save-file', async (e, { name, text }) => {
  const r = await dialog.showSaveDialog(toolWindow || gameWindow, {
    title: 'Save inputs', defaultPath: name || 'inputs.txt', filters: [{ name: 'Inputs', extensions: ['txt'] }, { name: 'All files', extensions: ['*'] }],
  });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, text);
  return path.basename(r.filePath);
});
ipcMain.handle('tas-open-file', async () => {
  const r = await dialog.showOpenDialog(toolWindow || gameWindow, {
    title: 'Open inputs', properties: ['openFile'], filters: [{ name: 'Inputs', extensions: ['txt', 'inputs'] }, { name: 'All files', extensions: ['*'] }],
  });
  if (r.canceled || !r.filePaths.length) return null;
  const file = r.filePaths[0];
  if (fs.statSync(file).size > 32 * 1024 * 1024) return { error: 'That file is over 32 MB — not an inputs file?' };
  return { name: path.basename(file), text: fs.readFileSync(file, 'utf8') };
});

// ------------------------------------------------------------------ the game window
app.whenReady().then(() => {
  gameWindow = new BrowserWindow({
    width: 1024, height: 800, minWidth: 320, minHeight: 200, fullscreen: !background, useContentSize: true, autoHideMenuBar: true,
    show: false, backgroundColor: '#28346a',
    ...(background ? { x: -4000, y: -4000, width: 1280, height: 720, skipTaskbar: true, focusable: false } : {}),
    webPreferences: { devTools: false, preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false },
  });
  if (background) gameWindow.showInactive(); else gameWindow.show();
  gameWindow.removeMenu();
  gameWindow.webContents.on('before-input-event', (e, input) => {
    if (input.isAutoRepeat || input.type !== 'keyDown') return;
    if (input.code === 'F11' || (input.alt && input.code === 'Enter')) { gameWindow.setFullScreen(!gameWindow.isFullScreen()); e.preventDefault(); }
  });
  gameWindow.webContents.on('will-prevent-unload', (e) => e.preventDefault());
  gameWindow.on('enter-full-screen', () => gameWindow.webContents.send('fullscreen-change', true));
  gameWindow.on('leave-full-screen', () => gameWindow.webContents.send('fullscreen-change', false));
  // the TAS window belongs to the game: it closes with it
  gameWindow.on('closed', () => {
    gameWindow = null;
    if (toolWindow && !toolWindow.isDestroyed()) toolWindow.close();
  });

  // never upload a run, and never take part in verifying others' (any request that would is refused)
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['https://vps.kodub.com/*'] }, (details, done) => {
    // reading leaderboards and recordings (GET) stays; submitting a run (POST .../leaderboard), the
    // verifier's results and the admin endpoints do not. Your profile (POST .../user) is left alone.
    const blocked = details.method !== 'GET' && /\/(leaderboard|verifyRecordings|admin)(\?|\/|$)/i.test(details.url);
    if (blocked) console.log('[tas] refused ' + details.method + ' ' + details.url.replace(/\?.*/, '') + ' (the TAS build never uploads runs)');
    done({ cancel: blocked });
  });
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (details, done) => {
    details.requestHeaders.Origin = 'https://app-polytrack-desktop.kodub.com';
    done({ requestHeaders: details.requestHeaders });
  });
  gameWindow.loadFile(path.join(__dirname, '..', 'index.html'));
});
