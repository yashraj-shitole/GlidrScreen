'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, clipboard, session, shell } = require('electron');

const SELFTEST = process.argv.includes('--selftest');
if (SELFTEST) app.setPath('userData', path.join(os.tmpdir(), 'glidr-screen-selftest-' + process.pid));

// Keep real LAN addresses in ICE candidates: mDNS-obfuscated ones cannot be resolved by the phone.
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// A second copy only wakes the first one (see 'second-instance') and must not start its own tray, engine or signaling.
const primaryInstance = SELFTEST || app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();

const QRCode = require('qrcode');
const { Store, UNCLAIMED_TTL_MS } = require('./store');
const { Signaling } = require('./signaling');
const { InputInjector } = require('./input');
const { HostCore } = require('./host');
const displays = require('./displays');
const crypto = require('./crypto');
const icon = require('./icon');

let store, signaling, input, core, engineWin, uiWin, tray;
const engine = new EventEmitter();
engine.send = (cmd) => { if (engineWin && !engineWin.isDestroyed()) engineWin.webContents.send('cmd', cmd); };
engine.ready = new Promise((resolve) => engine.once('ready', resolve));
let quitting = false;
let pushTimer = null;

function createEngineWindow() {
  engineWin = new BrowserWindow({
    show: false, width: 320, height: 240, skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'renderer', 'engine-preload.js'),
      backgroundThrottling: false, contextIsolation: true, sandbox: true,
    },
  });
  engineWin.loadFile(path.join(__dirname, '..', 'renderer', 'engine.html'));
  // The engine owns the peer connection; if its renderer dies the session is gone. End it and start a fresh engine.
  engineWin.webContents.on('render-process-gone', (_e, details) => {
    core?.emit('log', 'engine renderer gone: ' + details.reason);
    core?.endSession('engine crashed', true);
    if (!quitting && !engineWin.isDestroyed()) engineWin.reload();
  });
  engineWin.webContents.on('console-message', (e) => {
    if (SELFTEST || process.env.GLIDR_DEBUG) console.log('[engine]', e.message || e);
  });
  ipcMain.on('evt', (e, m) => {
    if (e.sender !== engineWin.webContents) return;
    if (m.t === 'ready') engine.emit('ready');
    engine.emit('evt', m);
  });
}

function createUiWindow() {
  if (uiWin && !uiWin.isDestroyed()) { uiWin.show(); uiWin.focus(); return; }
  uiWin = new BrowserWindow({
    width: 440, height: 780, minWidth: 400, minHeight: 600, backgroundColor: '#000000', autoHideMenuBar: true,
    title: 'Glidr Screen', icon: nativeImage.createFromBuffer(icon.png(256)),
    webPreferences: { preload: path.join(__dirname, '..', 'renderer', 'ui-preload.js'), contextIsolation: true, sandbox: true },
  });
  uiWin.loadFile(path.join(__dirname, '..', 'renderer', 'ui.html'));
  uiWin.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  uiWin.on('close', (e) => { if (!quitting) { e.preventDefault(); uiWin.hide(); } });
  // State is only pushed while the window is visible, so catch up whenever it is shown again from the tray.
  uiWin.on('show', pushState);
}

async function buildState() {
  store.pruneSlots();
  const snap = core.snapshot();
  const open = store.data.slots.filter((s) => !s.claimedAt).sort((a, b) => b.createdAt - a.createdAt)[0];
  let pairing = null;
  if (open) {
    const key = Buffer.from(open.key, 'base64url');
    const link = crypto.toLink(key, store.get('hostName'), store.get('signalBase'));
    pairing = {
      id: open.id, link, code: crypto.toManualCode(key),
      qr: await QRCode.toDataURL(link, { margin: 1, width: 280, errorCorrectionLevel: 'M', color: { dark: '#0B0C0A', light: '#F3F2EE' } }),
      expiresAt: open.createdAt + UNCLAIMED_TTL_MS,
    };
  }
  return {
    ...snap, pairing,
    devices: store.data.slots.filter((s) => s.claimedAt).map((s) => ({
      id: s.id, name: s.name || 'Phone', lastSeen: s.lastSeen, connected: snap.device?.slotId === s.id,
    })),
    settings: {
      hostName: store.get('hostName'), allowControl: store.get('allowControl'), quality: store.get('quality'),
      codec: store.get('codec'), signalBase: store.get('signalBase'),
      autostart: app.getLoginItemSettings().openAtLogin,
    },
    version: app.getVersion(),
  };
}

function pushState() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    updateTray();
    if (uiWin && !uiWin.isDestroyed() && uiWin.isVisible()) uiWin.webContents.send('state', await buildState());
  }, 80);
}

function updateTray() {
  if (!tray) return;
  const s = core.snapshot();
  const label = { paused: 'Sharing paused', waiting: 'Ready', connecting: 'Connecting...', streaming: `Streaming to ${s.device?.name}` }[s.status];
  tray.setToolTip(`Glidr Screen: ${label}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Glidr Screen', click: createUiWindow },
    { label, enabled: false },
    ...(s.status === 'streaming' || s.status === 'connecting'
      ? [{ label: 'Disconnect phone', click: () => core.endSession('disconnected on PC', true) }] : []),
    { label: s.sharing ? 'Pause sharing' : 'Resume sharing', click: () => core.setSharing(!s.sharing) },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
}

function registerIpc() {
  ipcMain.handle('state', () => buildState());
  ipcMain.handle('act', async (e, name, arg) => {
    switch (name) {
      case 'newPairing': store.createSlot(); core.refreshSlots(); break;
      case 'cancelPairing': store.data.slots = store.data.slots.filter((s) => s.claimedAt); store.save(); core.refreshSlots(); break;
      case 'revoke':
        if (core.sess?.slotId === arg) core.endSession('device removed', true);
        store.revoke(arg); core.refreshSlots(); break;
      case 'disconnect': core.endSession('disconnected on PC', true); break;
      case 'sharing': core.setSharing(!!arg); break;
      case 'setting': {
        const patch = {};
        if (typeof arg.allowControl === 'boolean') patch.allowControl = arg.allowControl;
        if (['auto', 'low', 'balanced', 'high'].includes(arg.quality)) patch.quality = arg.quality;
        if (['auto', 'h264', 'vp8'].includes(arg.codec)) patch.codec = arg.codec;
        if (typeof arg.hostName === 'string' && arg.hostName.trim()) patch.hostName = arg.hostName.trim().slice(0, 40);
        if (typeof arg.signalBase === 'string' && /^https?:\/\/[^\s]+$/.test(arg.signalBase.trim())) {
          patch.signalBase = arg.signalBase.trim().replace(/\/+$/, '');
        }
        if (typeof arg.autostart === 'boolean') app.setLoginItemSettings({ openAtLogin: arg.autostart });
        store.set(patch);
        if (patch.signalBase) signaling.setBase(patch.signalBase);
        if ('allowControl' in patch) core.controlChanged();
        break;
      }
      case 'copy': clipboard.writeText(String(arg)); break;
      case 'quit': quitting = true; app.quit(); break;
      default: break;
    }
    pushState();
  });
}

app.whenReady().then(async () => {
  if (!primaryInstance) return;
  store = new Store(app.getPath('userData'));
  signaling = new Signaling(store.get('signalBase'));
  input = new InputInjector();
  core = new HostCore({ store, signaling, engine, input });
  core.on('changed', pushState);
  core.on('log', (m) => { if (SELFTEST || process.env.GLIDR_DEBUG) console.log('[host]', m); });
  screen.on('display-added', () => core.displaysChanged());
  screen.on('display-removed', () => core.displaysChanged());
  screen.on('display-metrics-changed', () => core.displaysChanged());

  // Only the engine window may use capture; nothing else gets media or other permissions.
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(permission === 'media' && wc === engineWin?.webContents));
  session.defaultSession.setPermissionCheckHandler((wc, permission) => permission === 'media' && wc === engineWin?.webContents);

  createEngineWindow();
  registerIpc();
  await engine.ready;

  if (SELFTEST) {
    const code = await require('./selftest').run({ app, store, signaling, core, engine, input, displays });
    quitting = true;
    app.exit(code);
    return;
  }

  tray = new Tray(nativeImage.createFromBuffer(icon.png(32)));
  tray.on('click', createUiWindow);
  core.start();
  updateTray();
  if (!process.argv.includes('--hidden')) createUiWindow();
  if (process.env.GLIDR_PAIR_OUT) {
    // dev aid for end-to-end tests: open a pairing and write its link to a file
    const slot = store.createSlot(); core.refreshSlots();
    fs.writeFileSync(process.env.GLIDR_PAIR_OUT, crypto.toLink(Buffer.from(slot.key, 'base64url'), store.get('hostName'), store.get('signalBase')));
  }
  if (process.env.GLIDR_SHOT) {
    // dev aid: screenshot the control panel (optionally with a pairing open) and quit
    store.createSlot(); core.refreshSlots();
    setTimeout(async () => { fs.writeFileSync(process.env.GLIDR_SHOT, (await uiWin.webContents.capturePage()).toPNG()); quitting = true; app.quit(); }, 3500);
  }
});

app.on('second-instance', () => { if (app.isReady()) createUiWindow(); });
app.on('window-all-closed', () => { /* keep running in the tray */ });
app.on('before-quit', () => { quitting = true; core?.endSession('host quit', true); });
