'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, clipboard, session, shell, powerMonitor, powerSaveBlocker } = require('electron');

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
const { UpdateChecker } = require('./updates');
const { repairAutostart } = require('./autostart');
const { PauseTimer, untilLabel, HOUR_MS } = require('./pausetimer');
const { KeepAwake, wirePower } = require('./power');
const links = require('./links');
const permissions = require('./permissions');
const wol = require('./wol');
const diagnose = require('./diagnose');

let store, signaling, input, core, engineWin, uiWin, tray, updates, pauseTimer, keepAwake;
let notifiedVersion = null;
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
  // First run (nothing paired, nothing open): show the QR straight away instead of an extra "Pair a new phone" click.
  if (store && core && !store.data.slots.length) { store.createSlot(); core.refreshSlots(); }
  if (uiWin && !uiWin.isDestroyed()) { uiWin.show(); uiWin.focus(); return; }
  uiWin = new BrowserWindow({
    width: 440, height: 780, minWidth: 400, minHeight: 600, backgroundColor: '#000000', autoHideMenuBar: true,
    title: 'Glidr Screen', icon: nativeImage.createFromBuffer(icon.png(256)),
    webPreferences: { preload: path.join(__dirname, '..', 'renderer', 'ui-preload.js'), contextIsolation: true, sandbox: true },
  });
  uiWin.loadFile(path.join(__dirname, '..', 'renderer', 'ui.html'));
  uiWin.webContents.setWindowOpenHandler(({ url }) => { openLink(url); return { action: 'deny' }; });
  uiWin.on('close', (e) => { if (!quitting) { e.preventDefault(); uiWin.hide(); } });
  // State is only pushed while the window is visible, so catch up whenever it is shown again from the tray.
  uiWin.on('show', pushState);
}

/** Opens web links in the browser. Anything else (file:, custom protocols) is refused. */
function openLink(url) {
  if (/^https:\/\//i.test(String(url))) shell.openExternal(url);
}

/** Login item: started hidden in the tray. The same args must be passed when reading the setting back. */
const LOGIN_ITEM = { args: ['--hidden'] };

/** Every manual change of sharing goes through here, so it cancels a running timed pause. */
function setSharing(on) {
  pauseTimer?.clear();
  core.setSharing(on);
}

/** Pauses now and resumes by itself. [arm] picks when (see PauseTimer). */
function pauseTimed(arm) {
  core.setSharing(false);
  arm(pauseTimer);
  pushState();
}

/** Runs a glidr-screen:// verb. Anything that is not exactly one of three known verbs is ignored (see links.js). */
function runLink(url) {
  if (!core) return null;
  return links.handleLink(url, {
    pause: () => setSharing(false),
    resume: () => setSharing(true),
    disconnect: () => core.endSession('disconnected by link', true),
  });
}

/** Wake-on-LAN details for pairing links (adapter lookup is cheap but the panel refreshes often). */
let wolCache = { at: 0, v: null };
function wolInfo() {
  if (Date.now() - wolCache.at > 30_000) wolCache = { at: Date.now(), v: wol.primaryAdapter() };
  return wolCache.v;
}

/** Pairing link for a slot. Guests are view only and temporary, so their link does not carry this PC's MAC address. */
function linkFor(slot) {
  const key = Buffer.from(slot.key, 'base64url');
  const w = slot.viewOnly ? null : wolInfo();
  return crypto.toLink(key, store.get('hostName'), store.get('signalBase'), w?.mac, w?.broadcast);
}

async function buildState() {
  store.pruneSlots();
  const snap = core.snapshot();
  const open = store.data.slots.filter((s) => !s.claimedAt && !s.needsRepair).sort((a, b) => b.createdAt - a.createdAt)[0];
  let pairing = null;
  if (open) {
    const key = Buffer.from(open.key, 'base64url');
    const link = linkFor(open);
    pairing = {
      id: open.id, guest: open.viewOnly === true, wol: !open.viewOnly && !!wolInfo(), link, code: crypto.toManualCode(key),
      qr: await QRCode.toDataURL(link, { margin: 1, width: 280, errorCorrectionLevel: 'M', color: { dark: '#0B0C0A', light: '#F3F2EE' } }),
      expiresAt: open.createdAt + UNCLAIMED_TTL_MS,
    };
  }
  return {
    ...snap, pairing,
    devices: store.data.slots.filter((s) => s.claimedAt).map((s) => ({
      id: s.id, name: s.name || 'Phone', lastSeen: s.lastSeen, connected: snap.device?.slotId === s.id, needsRepair: !!s.needsRepair,
      ...permissions.describe(s, Date.now()),
    })),
    settings: {
      hostName: store.get('hostName'), allowControl: store.get('allowControl'), allowFiles: store.get('allowFiles') !== false, quality: store.get('quality'),
      codec: store.get('codec'), signalBase: store.get('signalBase'),
      autostart: app.getLoginItemSettings(LOGIN_ITEM).openAtLogin,
      keepAwake: store.get('keepAwake'), endOnLock: store.get('endOnLock'), shareAudio: store.get('shareAudio'),
    },
    pausedLabel: snap.sharing ? null : pauseTimer.label(),
    version: app.getVersion(),
    update: updates.state,
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
  const timed = !s.sharing ? pauseTimer.label() : null;
  const status = timed || label;
  tray.setToolTip(`Glidr Screen: ${status}`);
  const u = updates.state;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Glidr Screen', click: createUiWindow },
    { label: status, enabled: false },
    ...(u.status === 'available' ? [{ label: `Download update ${u.latest}`, click: () => openLink(u.download) }] : []),
    ...(s.status === 'streaming' || s.status === 'connecting'
      ? [{ label: 'Disconnect phone', click: () => core.endSession('disconnected on PC', true) }] : []),
    { label: s.sharing ? 'Pause sharing' : 'Resume sharing', click: () => setSharing(!s.sharing) },
    ...(s.sharing ? [
      { label: 'Pause for 1 hour', click: () => pauseTimed((t) => t.pauseFor(HOUR_MS)) },
      { label: untilLabel(Date.now()), click: () => pauseTimed((t) => t.pauseUntilHour(8)) },
    ] : []),
    { label: 'Check for updates', click: () => updates.check() },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
}

function registerIpc() {
  ipcMain.handle('state', () => buildState());
  ipcMain.handle('act', async (e, name, arg) => {
    let result;
    switch (name) {
      case 'newPairing': store.createSlot(); core.refreshSlots(); break;
      case 'guest': // view only, access ends 1 hour after the phone pairs, sessions capped at 60 min
        store.createSlot({ viewOnly: true, expireAfterClaimMs: 60 * 60_000, maxSessionMin: 60 });
        core.refreshSlots(); break;
      case 'phone': { // {id, viewOnly?: boolean, expiresIn?: 'never'|'1h'|'1d'|'7d'}; anything else is ignored
        if (!arg || typeof arg.id !== 'string') break;
        const slot = store.slot(arg.id);
        if (!slot || !slot.claimedAt) break;
        const wasViewOnly = slot.viewOnly === true;
        if (permissions.applyUpdate(slot, arg, Date.now())) {
          store.save();
          core.refreshSlots();
          if ((slot.viewOnly === true) !== wasViewOnly) core.controlChanged();
        }
        break;
      }
      case 'cancelPairing': store.data.slots = store.data.slots.filter((s) => s.claimedAt); store.save(); core.refreshSlots(); break;
      case 'revoke':
        if (core.sess?.slotId === arg) core.endSession('device removed', true);
        store.revoke(arg); core.refreshSlots(); break;
      case 'disconnect': core.endSession('disconnected on PC', true); break;
      case 'sharing': setSharing(!!arg); break;
      case 'repair': // a phone whose key cannot be read: drop it and open a fresh pairing
        if (core.sess?.slotId === arg) core.endSession('device removed', true);
        store.revoke(arg); store.createSlot(); core.refreshSlots(); break;
      case 'setting': {
        const patch = {};
        for (const k of ['allowControl', 'allowFiles', 'keepAwake', 'endOnLock', 'shareAudio']) if (typeof arg[k] === 'boolean') patch[k] = arg[k];
        if (['auto', 'low', 'balanced', 'high'].includes(arg.quality)) patch.quality = arg.quality;
        if (['auto', 'h264', 'vp8'].includes(arg.codec)) patch.codec = arg.codec;
        if (typeof arg.hostName === 'string' && arg.hostName.trim()) patch.hostName = arg.hostName.trim().slice(0, 40);
        if (typeof arg.signalBase === 'string' && /^https?:\/\/[^\s]+$/.test(arg.signalBase.trim())) {
          patch.signalBase = arg.signalBase.trim().replace(/\/+$/, '');
        }
        if (typeof arg.autostart === 'boolean') app.setLoginItemSettings({ ...LOGIN_ITEM, openAtLogin: arg.autostart });
        store.set(patch);
        if (patch.signalBase) signaling.setBase(patch.signalBase);
        if ('allowControl' in patch) core.controlChanged();
        if ('allowFiles' in patch) core.filesChanged();
        if ('keepAwake' in patch) keepAwake.sync();
        break;
      }
      case 'copy': clipboard.writeText(String(arg)); break;
      case 'diagnose':
        result = await diagnose.runChecks({
          dgram: require('dgram'), createSignaling: (b) => new Signaling(b), signalBase: store.get('signalBase'),
        });
        break;
      case 'checkUpdate': await updates.check(); break;
      case 'openUpdate': if (updates.state.download) openLink(updates.state.download); break;
      case 'quit': quitting = true; app.quit(); break;
      default: break;
    }
    pushState();
    return result;
  });
}

app.whenReady().then(async () => {
  if (!primaryInstance) return;
  store = new Store(app.getPath('userData'));
  signaling = new Signaling(store.get('signalBase'));
  input = new InputInjector();
  core = new HostCore({ store, signaling, engine, input });
  pauseTimer = new PauseTimer({ onResume: () => core.setSharing(true) });
  // Hold off sleep only while sharing is on (a paused PC may sleep) and the user wants it.
  keepAwake = new KeepAwake(powerSaveBlocker, () => !SELFTEST && store.get('sharing') && store.get('keepAwake'));
  core.on('changed', () => { keepAwake.sync(); pushState(); });
  updates = new UpdateChecker(app.getVersion(), { repo: process.env.GLIDR_UPDATE_REPO }); // env: dev aid
  updates.on('changed', (u) => {
    pushState();
    if (u.status === 'available' && tray && notifiedVersion !== u.latest) {
      notifiedVersion = u.latest; // one balloon per new version
      tray.displayBalloon({ title: 'Glidr Screen update', content: `Version ${u.latest} is available. Open the tray menu to download it.` });
    }
  });
  // Data only: the file's name and the phone's name, never a path. Files can only land in Downloads\Glidr.
  core.on('file-received', ({ name, from }) => {
    if (tray) tray.displayBalloon({ title: 'Glidr Screen', content: `Received ${name} from ${from}` });
  });
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
  tray.on('balloon-click', () => { if (updates.state.status === 'available') openLink(updates.state.download); });
  core.start();
  keepAwake.sync();
  // Wake from sleep and unlock: reconnect signaling at once; lock: tell the core, optionally end the session.
  wirePower({ monitor: powerMonitor, signaling, core, store, keepAwake, pauseTimer });
  if (app.isPackaged) { try { app.setAsDefaultProtocolClient(links.SCHEME); } catch { /* registry not writable: links just stay off */ } }
  updates.start();
  updateTray();
  if (app.isPackaged && process.platform === 'win32') {
    // Login item pointing at a moved or half-extracted copy: point it at this one (see autostart.js).
    repairAutostart({ execPath: process.execPath, register: () => app.setLoginItemSettings({ ...LOGIN_ITEM, openAtLogin: true }) })
      .then((fixed) => { if (fixed) console.log('[host] autostart entry repointed to this copy'); })
      .catch(() => {});
  }
  const startLink = process.argv.some(links.isLinkArg); // started by a glidr-screen:// link: act, stay in the tray
  if (startLink) runLink(links.findLink(process.argv));
  if (!process.argv.includes('--hidden') && !startLink) createUiWindow();
  if (process.env.GLIDR_PAIR_OUT) {
    // dev aid for end-to-end tests: open a pairing and write its link to a file
    const slot = store.createSlot(); core.refreshSlots();
    fs.writeFileSync(process.env.GLIDR_PAIR_OUT, linkFor(slot));
  }
  if (process.env.GLIDR_SHOT) {
    // dev aid: screenshot the control panel (optionally with a pairing open) and quit
    store.createSlot(); core.refreshSlots(); updates.check();
    setTimeout(async () => { fs.writeFileSync(process.env.GLIDR_SHOT, (await uiWin.webContents.capturePage()).toPNG()); quitting = true; app.quit(); }, 3500);
  }
});

app.on('second-instance', (_e, argv) => {
  if (!app.isReady() || !core) return;
  // A link from automation does its one action and leaves the window alone; a plain second launch shows the window.
  if (argv.some(links.isLinkArg)) runLink(links.findLink(argv)); else createUiWindow();
});
// Both windows show local files only: never navigate them anywhere else.
app.on('web-contents-created', (_e, wc) => {
  wc.on('will-navigate', (e) => e.preventDefault());
  wc.on('will-redirect', (e) => e.preventDefault());
});
app.on('window-all-closed', () => { /* keep running in the tray */ });
app.on('before-quit', () => {
  quitting = true;
  // A timed pause is not persisted: if the app is closed during one, sharing is on again at the next start.
  if (pauseTimer?.active) { pauseTimer.clear(); store.set({ sharing: true }); }
  keepAwake?.release();
  core?.endSession('host quit', true);
});
