'use strict';
// Core host logic: pairing slots -> signaling -> one WebRTC session -> remote control. No Electron UI here.
const { EventEmitter } = require('events');
const displays = require('./displays');
const media = require('./media');
const { ClipboardSync, CursorStream } = require('./sync');
const permissions = require('./permissions');
const { FileReceiver, cleanStaleParts } = require('./files');
const Windows = require('./windows');
const Actions = require('./actions');
const path = require('path');

const MAX_TIMER_MS = 2 ** 31 - 1; // setTimeout fires at once above this
const CONNECT_TIMEOUT_MS = 30_000;
const DISCONNECT_GRACE_MS = 10_000;
const MAX_REQ_AGE_MS = 90_000;
const PROTOCOL = 1;

// Electron's clipboard and the koffi-backed cursor reader are required lazily so unit tests can load this file.
const defaultClipboard = () => require('electron').clipboard;
const defaultCursorPos = () => require('./input').InputInjector.cursorPos();
const defaultWindowRect = (hwnd) => require('./input').windowRect(hwnd);
const defaultFocusWindow = (hwnd) => require('./input').focusWindow(hwnd);
const WINDOW_LIST_MS = 2000; // `windows` list refresh while the phone has it on
const WINDOW_THUMB_MS = 3000; // `wthumb` previews
const WINDOW_POLL_MS = 100; // timer of the shared-window follower; the tracker itself looks at most every 250 ms
/** Received files go to <Downloads>\Glidr and nowhere else. */
const defaultFilesDir = () => path.join(require('electron').app.getPath('downloads'), 'Glidr');

class HostCore extends EventEmitter {
  /**
   * @param store Store
   * @param signaling Signaling
   * @param engine {send(cmd)} bridge to the engine window
   * @param input InputInjector
   * @param clipboard optional {readText, writeText} (tests); defaults to Electron's clipboard
   * @param cursorPos optional () => {x,y} (tests); defaults to InputInjector.cursorPos
   * @param filesDir optional () => string (tests): where received files are saved; defaults to Downloads\Glidr
   * @param windowRect optional (hwnd) => {x,y,w,h,iconic}|null (tests): defaults to input.windowRect (GetWindowRect via koffi)
   * @param focusWindow optional (hwnd) => bool (tests): defaults to input.focusWindow
   * @param runAction optional ({file,args,opts}) => Promise (tests): runs a quick action; defaults to a detached shell-less spawn
   * @param actionClock optional () => ms (tests): the quick-action rate limiter's clock
   */
  constructor({ store, signaling, engine, input, clipboard, cursorPos, filesDir, windowRect, focusWindow, runAction, actionClock }) {
    super();
    this.store = store;
    this.sig = signaling;
    this.engine = engine;
    this.input = input;
    this.clipboard = clipboard || null;
    this.cursorPos = cursorPos || defaultCursorPos;
    this.filesDir = filesDir || defaultFilesDir;
    this.windowRectFn = windowRect || defaultWindowRect;
    this.focusWindowFn = focusWindow || defaultFocusWindow;
    this.runActionFn = runAction || null; // created on first use: nothing spawns unless an action really runs
    this.actionClock = actionClock || Date.now;
    this.actionLimiters = new Map(); // slot id -> RateLimiter (kept across reconnects, so reconnecting does not reset it)
    this.locked = false;
    this.sess = null;
    this.seen = new Set();
    this.stats = null;
    this.sigStatus = 'idle';
    this.thumbTimer = null;
    this.winTimer = null; // window list stream
    this.winThumbTimer = null;
    this.winLatest = null; // newest list computed: the ids the phone may ask for
    this.winDetect = new Windows.ChangeDetector();

    this.sig.on('message', (m) => this.#onSignal(m));
    this.sig.on('status', (s) => { this.sigStatus = s; this.#changed(); });
    engine.on('evt', (e) => this.#onEngine(e));
  }

  start() {
    this.sig.setSlots(this.store.get('slots'));
    cleanStaleParts(this.filesDir()).catch(() => {}); // leftovers of a transfer that was cut off by a crash
    if (this.store.get('sharing')) this.sig.start(); else this.sig.stop();
    this.#changed();
  }

  refreshSlots() {
    this.sig.setSlots(this.store.get('slots'));
    if (this.sess) this.#armLimit(this.sess); // a changed access length applies to a running session too
    this.#changed();
  }

  /** Control input is allowed only with the PC-wide switch on and a phone that is not view only. */
  #canControl(s) {
    return permissions.canControl(this.store.slot(s.slotId), this.store.get('allowControl'));
  }

  /** (Re)arms the timer that ends the session at its time limit or when the phone's access runs out. */
  #armLimit(s) {
    clearTimeout(s.limitTimer);
    s.limitTimer = null;
    const deadline = permissions.sessionDeadline(this.store.slot(s.slotId), s.startedAt);
    if (!deadline) return;
    s.limitTimer = setTimeout(() => {
      if (this.sess !== s) return;
      const d = permissions.sessionDeadline(this.store.slot(s.slotId), s.startedAt);
      if (d && Date.now() >= d - 2) this.endSession('time limit', true);
      else this.#armLimit(s); // limit moved (or the timer was clamped): look again
    }, Math.min(Math.max(0, deadline - Date.now()), MAX_TIMER_MS));
  }

  setSharing(on) {
    this.store.set({ sharing: on });
    if (!on) { this.endSession('sharing paused', true); this.sig.stop(); } else this.sig.start();
    this.#changed();
  }

  snapshot() {
    const s = this.sess;
    return {
      sharing: this.store.get('sharing'),
      signal: this.sigStatus,
      status: !this.store.get('sharing') ? 'paused' : !s ? 'waiting' : s.live ? 'streaming' : 'connecting',
      device: s ? { slotId: s.slotId, name: s.name } : null,
      stats: s?.live ? this.stats : null,
      monitors: displays.list(),
      active: s?.monitorId ?? null,
    };
  }

  #changed() { this.emit('changed'); }

  // -------------------------------------------------------------- signaling

  async #onSignal({ slotId, msg, serverTime }) {
    if (msg.from !== 'p') return; // our own echo
    if (msg.t === 'req') return this.#onRequest(slotId, msg, serverTime);
    const s = this.sess;
    if (!s || s.slotId !== slotId || s.sid !== msg.sid) return;
    if (msg.t === 'answer' && typeof msg.sdp === 'string') this.engine.send({ t: 'answer', sid: s.sid, sdp: msg.sdp });
    if (msg.t === 'bye') this.endSession('viewer left', false);
  }

  async #onRequest(slotId, msg, serverTime) {
    const slot = this.store.slot(slotId);
    if (!slot || typeof msg.sid !== 'string' || this.seen.has(msg.sid)) return;
    if (serverTime && Math.abs(Date.now() - serverTime) > MAX_REQ_AGE_MS) return; // stale replay
    this.seen.add(msg.sid);
    if (this.seen.size > 200) this.seen.delete(this.seen.values().next().value);
    const reply = (obj) => this.sig.publish(slot.key, { from: 'h', sid: msg.sid, ts: Date.now(), ...obj }).catch(() => {});

    if (permissions.isExpired(slot, Date.now())) return reply({ t: 'deny', reason: 'expired' }); // slot is kept
    if (!this.store.get('sharing')) return reply({ t: 'deny', reason: 'paused' });
    if (this.sess && this.sess.slotId !== slotId) return reply({ t: 'busy' });
    if (this.sess) this.endSession('replaced', false);

    this.store.claim(slotId, String(msg.n || ''));
    this.refreshSlots();
    const monitors = displays.list();
    const primary = monitors.find((d) => d.primary) || monitors[0];
    if (!primary) return reply({ t: 'deny', reason: 'no display' });
    const q = media.resolveQuality({ preset: this.store.get('quality') });
    const decoders = media.parseDecoders(msg.dec); // what the phone can decode; null = old phone (H.264 / VP8 only)
    const s = {
      sid: msg.sid, slotId, key: slot.key, name: slot.name || String(msg.n || 'Phone'),
      live: false, monitorId: primary.id, quality: q.preset, fps: q.fps, saver: q.saver,
      audio: false, // set from the engine's offer: true only when system audio is really being captured
      clip: null, cursor: null,
      timer: setTimeout(() => this.endSession('connect timeout', true), CONNECT_TIMEOUT_MS),
      startedAt: Date.now(), limitTimer: null,
    };
    this.sess = s;
    this.#armLimit(s);
    this.#changed();
    try {
      const sourceId = await displays.sourceIdFor(primary.id);
      if (this.sess !== s) return; // ended or replaced while looking up the capture source
      const codec = media.normalizeCodecPref(this.store.get('codec'));
      this.engine.send({
        t: 'start', sid: s.sid, sourceId,
        iceServers: this.#iceServers(), codec, decoders, codecOrder: media.codecOrder(codec, decoders),
        ...q, quality: q.preset, audio: this.store.get('shareAudio') === true,
      });
    } catch (e) {
      if (this.sess === s) this.endSession('capture failed: ' + e.message, true);
    }
  }

  #iceServers() {
    const list = [{ urls: this.store.get('stun') }];
    const turn = this.store.get('turn');
    if (turn?.urls) list.push(turn);
    return list;
  }

  // -------------------------------------------------------------- engine events

  #onEngine(e) {
    const s = this.sess;
    if (e.sid && (!s || s.sid !== e.sid)) return;
    switch (e.t) {
      case 'offer':
        s.audio = e.audio === true;
        this.sig.publish(s.key, {
          t: 'offer', from: 'h', sid: s.sid, ts: Date.now(), sdp: e.sdp, v: PROTOCOL, host: this.store.get('hostName'),
        }).catch((err) => this.endSession('signaling failed: ' + err.message, true));
        break;
      case 'dc-open':
        clearTimeout(s.timer);
        clearTimeout(s.graceTimer);
        s.live = true;
        this.input.setBounds(this.#bounds(s.monitorId));
        this.#sendHello();
        this.#changed();
        break;
      case 'dc-close':
        this.endSession('data channel closed', false);
        break;
      case 'state':
        if (e.state === 'failed' || e.state === 'closed') this.endSession('connection ' + e.state, true);
        else if (e.state === 'disconnected') {
          // replace, never stack: an orphaned timer would end this (or the next) session after it recovered
          clearTimeout(s.graceTimer);
          s.graceTimer = setTimeout(() => { if (this.sess === s) this.endSession('connection lost', false); }, DISCONNECT_GRACE_MS);
        }
        else if (e.state === 'connected') clearTimeout(s.graceTimer);
        break;
      case 'ctl':
        this.#onCtl(s, e.data);
        break;
      case 'files': s.files?.onText(String(e.data)); break; // `files` channel, text frame (begin / end)
      case 'files-bin': s.files?.onBinary(e.data); break; // `files` channel, binary chunk
      case 'files-close': s.files?.abort('files channel closed', true); break;
      case 'switched':
        if (e.kind === 'window') { this.#windowSwitched(s, e); break; }
        s.monitorId = e.monitorId;
        this.#send({ t: 'active', id: e.monitorId, w: e.w, h: e.h });
        this.#changed();
        break;
      case 'stats':
        this.stats = e;
        this.#changed();
        break;
      case 'error':
        this.emit('log', `engine error in ${e.where}: ${e.message}`);
        if (e.where === 'start') this.endSession('capture failed: ' + e.message, true);
        if (e.where === 'switch' && s?.pending) { // the window could not be captured: nothing changed, tell the phone
          this.#send({ t: 'source-error', id: s.pending.id, reason: 'gone' });
          s.pending = null;
        }
        break;
      case 'log':
        this.emit('log', 'engine: ' + e.message);
        break;
      default: break;
    }
  }

  #send(obj) {
    this.engine.send({ t: 'send', data: JSON.stringify(obj) });
  }

  #sendHello() {
    const s = this.sess;
    this.#send({
      t: 'hello', v: PROTOCOL, host: this.store.get('hostName'), os: 'Windows', fps: s.fps,
      control: this.#canControl(s), quality: s.quality,
      monitors: displays.list(), active: s.monitorId,
      locked: this.locked, audio: s.audio, actions: this.#actionList(s),
    });
  }

  // -------------------------------------------------------------- quick actions (see actions.js)

  #actionCfg() {
    return {
      allowActions: this.store.get('allowActions'), allowControl: this.store.get('allowControl'),
      actionsEnabled: this.store.get('actionsEnabled'), launchers: this.store.get('launchers'),
    };
  }

  /** What this phone may see: nothing while the master switch is off or the phone cannot control (view only). */
  #actionList(s) {
    return this.#canControl(s) ? Actions.phoneList(this.#actionCfg()) : [];
  }

  /** The PC owner changed the quick actions (master switch, enabled list or launchers): the live phone gets the new list. */
  actionsChanged() {
    const s = this.sess;
    if (s?.live) this.#send({ t: 'actions', list: this.#actionList(s) });
  }

  async #runAction(s, m) {
    let limiter = this.actionLimiters.get(s.slotId);
    if (!limiter) { limiter = new Actions.RateLimiter(this.actionClock); this.actionLimiters.set(s.slotId, limiter); }
    if (!this.runActionFn) this.runActionFn = Actions.spawnRunner();
    // Only the id and the outcome are logged (and only when GLIDR_DEBUG is set), never a path or an argument.
    const res = await Actions.handle(m, {
      cfg: this.#actionCfg(), slot: this.store.slot(s.slotId), limiter, run: this.runActionFn,
      log: (line) => { if (process.env.GLIDR_DEBUG) this.emit('log', line); },
    });
    if (res && this.sess === s) this.#send({ t: 'action-result', ...res });
  }

  /** PC lock state (wired to powerMonitor lock/unlock in main.js). Tells a live phone straight away. */
  setLocked(on) {
    const v = !!on;
    if (v === this.locked) return;
    this.locked = v;
    if (this.sess?.live) this.#send({ t: 'locked', on: v });
  }

  #clipboardApi() {
    if (!this.clipboard) this.clipboard = defaultClipboard();
    return this.clipboard;
  }

  #clipSync(s) {
    if (!s.clip) {
      s.clip = new ClipboardSync({
        read: () => this.#clipboardApi().readText(),
        write: (t) => this.#clipboardApi().writeText(t),
        send: (text) => this.#send({ t: 'clip', s: text }),
      });
    }
    return s.clip;
  }

  #cursorStream(on) {
    const s = this.sess;
    if (!s?.live) return;
    if (!on) { s.cursor?.stop(); return; }
    if (!s.cursor) {
      s.cursor = new CursorStream({
        getPos: () => this.cursorPos(),
        getBounds: () => (s.window && s.winTracker?.bounds) || this.#bounds(s.monitorId), // follows monitor and window switches
        send: ({ x, y }) => this.#send({ t: 'cur', x, y }),
      });
    }
    s.cursor.start();
  }

  /** The phone's file offer: policy decides, the receiver streams the bytes to Downloads\Glidr (see files.js). */
  #fileOffer(s, m) {
    this.#fileReceiver(s).offer(m, {
      allowFiles: this.store.get('allowFiles') !== false, // default on
      allowControl: this.store.get('allowControl') === true,
      viewOnly: this.store.slot(s.slotId)?.viewOnly === true,
    });
    this.#changed();
  }

  #fileReceiver(s) {
    if (!s.files) {
      s.files = new FileReceiver({
        dir: () => this.filesDir(),
        send: (obj) => { if (this.sess === s) { this.#send(obj); this.#changed(); } },
        onSaved: ({ name, size }) => this.emit('file-received', { name, size, from: s.name }),
        log: (msg) => this.emit('log', msg),
      });
    }
    return s.files;
  }

  /** "Allow receiving files" was switched on the PC: a transfer in progress is cut off when it was switched off. */
  filesChanged() {
    const s = this.sess;
    if (s?.files && this.store.get('allowFiles') === false) s.files.abort('switched off on the PC', true);
  }

  #setQuality(s, m) {
    const q = media.parseQualityMessage(m, s.quality);
    if (!q) return;
    s.quality = q.preset; s.fps = q.fps; s.saver = q.saver;
    s.mode = media.normalizeMode(m.mode, s.mode); // missing keeps the session's mode, unknown -> 'auto'
    this.engine.send({ t: 'quality', sid: s.sid, ...q, mode: s.mode });
  }

  #bounds(monitorId) {
    const d = displays.byId(monitorId);
    return { x: d.x, y: d.y, w: d.w, h: d.h };
  }

  // -------------------------------------------------------------- phone -> host control

  async #onCtl(s, data) {
    let m;
    try { m = JSON.parse(data); } catch { return; }
    const control = this.#canControl(s);
    if (process.env.GLIDR_DEBUG && m.t !== 'ping') this.emit('log', 'ctl ' + data);
    switch (m.t) {
      case 'ping': this.#send({ t: 'pong', n: m.n, ts: m.ts }); break;
      case 'monitors': this.#send({ t: 'monitors', monitors: displays.list(), active: s.monitorId }); break;
      case 'monitor': await this.switchMonitor(Number(m.id)); break;
      case 'source':
        if (m.kind === 'window') await this.switchWindow(m.id);
        else if (m.kind === 'monitor') await this.switchMonitor(Number(m.id)); // same as `monitor`
        break;
      case 'thumbs': this.#thumbs(!!m.on); break;
      case 'windows': this.#windows(m.on === true); break;
      case 'quality': this.#setQuality(s, m); break;
      case 'clip': if (control && s.live) this.#clipSync(s).fromPhone(m.s); break; // never log the text
      case 'clipsync': if (s.live) this.#clipSync(s).setOn(m.on === true); break;
      case 'curs': this.#cursorStream(m.on === true); break;
      case 'file-offer': if (s.live) this.#fileOffer(s, m); break; // never log the name
      case 'action': if (s.live) await this.#runAction(s, m); break; // the phone sends an id only; see actions.js
      case 'mv': if (control) this.input.moveBy(+m.dx || 0, +m.dy || 0); break;
      case 'abs': if (control) this.input.moveNorm(+m.x || 0, +m.y || 0); break;
      case 'btn': if (control) this.input.button(m.b, m.a); break;
      case 'wheel': if (control) this.input.wheel(+m.x || 0, +m.y || 0); break;
      case 'key': if (control && typeof m.k === 'string') this.input.key(m.k, m.a || 'p'); break;
      case 'combo': if (control && Array.isArray(m.keys)) this.input.combo(m.keys.map(String).slice(0, 6)); break;
      case 'text': if (control && typeof m.s === 'string') this.input.text(m.s.slice(0, 500)); break;
      default: break;
    }
  }

  async switchMonitor(id) {
    const s = this.sess;
    if (!s || !s.live) return;
    const d = displays.list().find((x) => x.id === id);
    if (!d) return;
    this.#stopWindow(s); // the window (if one was shared) is no longer the source
    s.pending = null;
    this.input.reset();
    this.input.setBounds({ x: d.x, y: d.y, w: d.w, h: d.h });
    const cur = this.cursorPos();
    if (cur.x < d.x || cur.y < d.y || cur.x >= d.x + d.w || cur.y >= d.y + d.h) {
      this.input.moveTo(d.x + d.w / 2, d.y + d.h / 2);
    }
    const sourceId = await displays.sourceIdFor(id);
    if (this.sess !== s) return;
    this.engine.send({ t: 'switch', sid: s.sid, monitorId: id, sourceId });
  }

  // -------------------------------------------------------------- window sharing

  #rect(hwnd) {
    try { return this.windowRectFn(hwnd) || null; } catch { return null; } // Win32 trouble counts as "gone"
  }

  /**
   * Phone asked to share one window. The id must be in the latest list we showed (or, when the list was never
   * started, in a fresh one) and the window must still exist and not be minimised; otherwise `source-error` gone.
   */
  async switchWindow(id) {
    const s = this.sess;
    if (!s || !s.live || typeof id !== 'string' || id.length > 200) return;
    let entry = Windows.validate(id, this.winLatest);
    if (!entry && !this.winLatest) {
      try { entry = Windows.validate(id, await displays.windowList((h) => this.#rect(h))); } catch { entry = null; }
      if (this.sess !== s) return;
    }
    const hwnd = Windows.parseHwnd(id);
    const d = entry && hwnd !== null ? Windows.decide(this.#rect(hwnd)) : { action: 'gone' };
    if (d.action !== 'ok') { this.#send({ t: 'source-error', id, reason: 'gone' }); return; }
    this.input.reset();
    this.focusWindowFn(hwnd); // best effort: the pointer must land on this window, not on one covering it
    // Nothing is committed until the engine confirms the new capture ('switched'): a failed capture changes nothing.
    s.pending = { kind: 'window', id, hwnd, title: entry.title, bounds: d.bounds };
    this.engine.send({ t: 'switch', sid: s.sid, kind: 'window', id, monitorId: null, sourceId: id });
  }

  /** The engine now captures the window: input follows its bounds, and the phone is told what it is looking at. */
  #windowSwitched(s, e) {
    const p = s.pending;
    if (!p || p.id !== e.id) return; // superseded by another switch
    s.pending = null;
    s.window = { id: p.id, hwnd: p.hwnd, title: p.title };
    s.winTracker = new Windows.WindowTracker({ rectOf: (h) => this.#rect(h) });
    s.winTracker.start(p.hwnd, p.bounds);
    clearInterval(s.winPoll);
    s.winPoll = setInterval(() => this.pollWindow(), WINDOW_POLL_MS);
    this.input.setBounds(p.bounds);
    const cur = this.cursorPos();
    if (cur.x < p.bounds.x || cur.y < p.bounds.y || cur.x >= p.bounds.x + p.bounds.w || cur.y >= p.bounds.y + p.bounds.h) {
      this.input.moveTo(p.bounds.x + p.bounds.w / 2, p.bounds.y + p.bounds.h / 2);
    }
    this.#send({ t: 'active', kind: 'window', id: p.id, title: p.title, w: e.w, h: e.h });
    this.#changed();
  }

  /** Follows the shared window (at most every 250 ms): new bounds go to the input clamp; closed or minimised falls back. */
  pollWindow() {
    const s = this.sess;
    if (!s?.window || !s.winTracker) return;
    const r = s.winTracker.poll();
    if (r.state === 'ok' && r.moved) this.input.setBounds(r.bounds);
    else if (r.state === 'gone') this.#windowGone(s);
  }

  /** The shared window was closed or minimised: tell the phone once, then show the primary monitor again. */
  #windowGone(s) {
    const id = s.window.id;
    this.#stopWindow(s);
    this.#send({ t: 'source-error', id, reason: 'gone' });
    const monitors = displays.list();
    const primary = monitors.find((d) => d.primary) || monitors[0];
    if (primary) this.switchMonitor(primary.id).catch((err) => this.emit('log', 'window fallback: ' + err.message));
    this.#changed();
  }

  #stopWindow(s) {
    clearInterval(s.winPoll);
    s.winPoll = null;
    s.winTracker?.stop();
    s.window = null;
  }

  /** Window list (every 2 s, only when it changed) and previews (every 3 s, first 12) while the phone has them on. */
  #windows(on) {
    this.#stopWindowStream();
    if (!on || !this.sess?.live) return;
    const s = this.sess;
    this.winDetect.reset();
    let listBusy = false;
    let thumbBusy = false;
    const thumbTick = async () => {
      if (this.sess !== s || thumbBusy || !this.winLatest) return;
      thumbBusy = true;
      try {
        const ids = Windows.thumbIds(this.winLatest);
        if (ids.length) {
          for (const t of await displays.windowThumbnails(ids)) {
            if (this.sess === s && this.winTimer) this.#send({ t: 'wthumb', ...t });
          }
        }
      } catch (e) { this.emit('log', 'window previews: ' + e.message); } finally { thumbBusy = false; }
    };
    let first = true;
    const listTick = async () => {
      if (this.sess !== s || listBusy) return;
      listBusy = true;
      try {
        const list = await displays.windowList((h) => this.#rect(h));
        if (this.sess !== s || !this.winTimer) return; // ended or switched off while looking
        this.winLatest = list;
        if (this.winDetect.changed(list)) this.#send({ t: 'windows', list });
        if (first) { first = false; thumbTick(); }
      } catch (e) { this.emit('log', 'windows: ' + e.message); } finally { listBusy = false; }
    };
    this.winTimer = setInterval(listTick, WINDOW_LIST_MS);
    this.winThumbTimer = setInterval(thumbTick, WINDOW_THUMB_MS);
    listTick();
  }

  #stopWindowStream() {
    clearInterval(this.winTimer);
    clearInterval(this.winThumbTimer);
    this.winTimer = null;
    this.winThumbTimer = null;
  }

  /** "Allow remote control" or the phone's "View only" was switched on the PC: tell the phone so it shows (or clears) "View only". */
  controlChanged() {
    const s = this.sess;
    if (!s?.live) return;
    const on = this.#canControl(s);
    if (!on) { this.input.reset(); s.files?.abort('control switched off', true); } // release anything the phone was holding
    this.#send({ t: 'control', on });
    this.#send({ t: 'actions', list: this.#actionList(s) }); // quick actions need control too
  }

  #thumbs(on) {
    clearInterval(this.thumbTimer);
    this.thumbTimer = null;
    if (!on) return;
    const tick = async () => {
      if (!this.sess?.live) return;
      try {
        for (const t of await displays.thumbnails()) this.#send({ t: 'thumb', ...t });
      } catch (e) { this.emit('log', 'thumbs: ' + e.message); }
    };
    tick();
    this.thumbTimer = setInterval(tick, 1500);
  }

  /** Display layout changed (monitor plugged / unplugged / resolution). */
  displaysChanged() {
    const s = this.sess;
    if (s?.live) this.#send({ t: 'monitors', monitors: displays.list(), active: s.monitorId });
    this.#changed();
  }

  endSession(reason, notify) {
    const s = this.sess;
    if (!s) return;
    this.sess = null;
    clearTimeout(s.timer);
    clearTimeout(s.graceTimer);
    clearTimeout(s.limitTimer);
    clearInterval(this.thumbTimer);
    this.thumbTimer = null;
    this.#stopWindowStream();
    this.#stopWindow(s);
    this.winLatest = null;
    s.pending = null;
    s.clip?.stop();
    s.cursor?.stop();
    s.files?.abort('session ended', false); // partial file deleted, nobody left to tell
    this.stats = null;
    this.input.reset();
    this.engine.send({ t: 'stop', sid: s.sid });
    if (notify) this.sig.publish(s.key, { t: 'bye', from: 'h', sid: s.sid, ts: Date.now(), reason }).catch(() => {});
    this.emit('log', `session ended: ${reason}`);
    this.#changed();
  }
}

module.exports = { HostCore };
