'use strict';
// Core host logic: pairing slots -> signaling -> one WebRTC session -> remote control. No Electron UI here.
const { EventEmitter } = require('events');
const displays = require('./displays');
const media = require('./media');
const { ClipboardSync, CursorStream } = require('./sync');

const CONNECT_TIMEOUT_MS = 30_000;
const DISCONNECT_GRACE_MS = 10_000;
const MAX_REQ_AGE_MS = 90_000;
const PROTOCOL = 1;

// Electron's clipboard and the koffi-backed cursor reader are required lazily so unit tests can load this file.
const defaultClipboard = () => require('electron').clipboard;
const defaultCursorPos = () => require('./input').InputInjector.cursorPos();

class HostCore extends EventEmitter {
  /**
   * @param store Store
   * @param signaling Signaling
   * @param engine {send(cmd)} bridge to the engine window
   * @param input InputInjector
   * @param clipboard optional {readText, writeText} (tests); defaults to Electron's clipboard
   * @param cursorPos optional () => {x,y} (tests); defaults to InputInjector.cursorPos
   */
  constructor({ store, signaling, engine, input, clipboard, cursorPos }) {
    super();
    this.store = store;
    this.sig = signaling;
    this.engine = engine;
    this.input = input;
    this.clipboard = clipboard || null;
    this.cursorPos = cursorPos || defaultCursorPos;
    this.locked = false;
    this.sess = null;
    this.seen = new Set();
    this.stats = null;
    this.sigStatus = 'idle';
    this.thumbTimer = null;

    this.sig.on('message', (m) => this.#onSignal(m));
    this.sig.on('status', (s) => { this.sigStatus = s; this.#changed(); });
    engine.on('evt', (e) => this.#onEngine(e));
  }

  start() {
    this.sig.setSlots(this.store.get('slots'));
    if (this.store.get('sharing')) this.sig.start(); else this.sig.stop();
    this.#changed();
  }

  refreshSlots() { this.sig.setSlots(this.store.get('slots')); this.#changed(); }

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

    if (!this.store.get('sharing')) return reply({ t: 'deny', reason: 'paused' });
    if (this.sess && this.sess.slotId !== slotId) return reply({ t: 'busy' });
    if (this.sess) this.endSession('replaced', false);

    this.store.claim(slotId, String(msg.n || ''));
    this.refreshSlots();
    const monitors = displays.list();
    const primary = monitors.find((d) => d.primary) || monitors[0];
    if (!primary) return reply({ t: 'deny', reason: 'no display' });
    const q = media.resolveQuality({ preset: this.store.get('quality') });
    const s = {
      sid: msg.sid, slotId, key: slot.key, name: slot.name || String(msg.n || 'Phone'),
      live: false, monitorId: primary.id, quality: q.preset, fps: q.fps, saver: q.saver,
      audio: false, // set from the engine's offer: true only when system audio is really being captured
      clip: null, cursor: null,
      timer: setTimeout(() => this.endSession('connect timeout', true), CONNECT_TIMEOUT_MS),
    };
    this.sess = s;
    this.#changed();
    try {
      const sourceId = await displays.sourceIdFor(primary.id);
      if (this.sess !== s) return; // ended or replaced while looking up the capture source
      this.engine.send({
        t: 'start', sid: s.sid, sourceId,
        iceServers: this.#iceServers(), codec: this.store.get('codec'),
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
      case 'switched':
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
      control: this.store.get('allowControl'), quality: s.quality,
      monitors: displays.list(), active: s.monitorId,
      locked: this.locked, audio: s.audio,
    });
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
        getBounds: () => this.#bounds(s.monitorId), // follows monitor switches
        send: ({ x, y }) => this.#send({ t: 'cur', x, y }),
      });
    }
    s.cursor.start();
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
    const control = this.store.get('allowControl');
    if (process.env.GLIDR_DEBUG && m.t !== 'ping') this.emit('log', 'ctl ' + data);
    switch (m.t) {
      case 'ping': this.#send({ t: 'pong', n: m.n, ts: m.ts }); break;
      case 'monitors': this.#send({ t: 'monitors', monitors: displays.list(), active: s.monitorId }); break;
      case 'monitor': await this.switchMonitor(Number(m.id)); break;
      case 'thumbs': this.#thumbs(!!m.on); break;
      case 'quality': this.#setQuality(s, m); break;
      case 'clip': if (control && s.live) this.#clipSync(s).fromPhone(m.s); break; // never log the text
      case 'clipsync': if (s.live) this.#clipSync(s).setOn(m.on === true); break;
      case 'curs': this.#cursorStream(m.on === true); break;
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
    this.input.reset();
    this.input.setBounds({ x: d.x, y: d.y, w: d.w, h: d.h });
    const cur = require('./input').InputInjector.cursorPos();
    if (cur.x < d.x || cur.y < d.y || cur.x >= d.x + d.w || cur.y >= d.y + d.h) {
      this.input.moveTo(d.x + d.w / 2, d.y + d.h / 2);
    }
    const sourceId = await displays.sourceIdFor(id);
    if (this.sess !== s) return;
    this.engine.send({ t: 'switch', sid: s.sid, monitorId: id, sourceId });
  }

  /** "Allow remote control" was switched on the PC: tell the phone so it shows (or clears) "View only". */
  controlChanged() {
    const s = this.sess;
    if (!s?.live) return;
    const on = !!this.store.get('allowControl');
    if (!on) this.input.reset(); // release anything the phone was holding
    this.#send({ t: 'control', on });
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
    clearInterval(this.thumbTimer);
    this.thumbTimer = null;
    s.clip?.stop();
    s.cursor?.stop();
    this.stats = null;
    this.input.reset();
    this.engine.send({ t: 'stop', sid: s.sid });
    if (notify) this.sig.publish(s.key, { t: 'bye', from: 'h', sid: s.sid, ts: Date.now(), reason }).catch(() => {});
    this.emit('log', `session ended: ${reason}`);
    this.#changed();
  }
}

module.exports = { HostCore };
