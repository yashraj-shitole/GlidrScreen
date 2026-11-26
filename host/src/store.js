'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { newKey } = require('./crypto');
const { sanitizeLaunchers } = require('./actions');
const { normalizeCodecPref } = require('./media');

const UNCLAIMED_TTL_MS = 15 * 60 * 1000;

const TURN_URL = /^turns?:[^\s?,]+(\?transport=(udp|tcp))?$/i;

/** The relay (TURN) addresses in [text] (comma / space separated): only valid turn: and turns: ones, at most 4. */
function parseRelayUrls(text) {
  return String(text || '').split(/[\s,]+/).filter((u) => u.length <= 200 && TURN_URL.test(u)).slice(0, 4);
}

/** A stored relay setting as {urls, username, credential}, or null when it is unusable (no valid address). */
function normalizeTurn(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const urls = (Array.isArray(raw.urls) ? raw.urls : typeof raw.urls === 'string' ? [raw.urls] : []).map(String).filter((u) => u.length <= 200 && TURN_URL.test(u)).slice(0, 4);
  if (!urls.length) return null;
  const text = (v) => (typeof v === 'string' ? v.slice(0, 300) : '');
  return { urls, username: text(raw.username), credential: text(raw.credential) };
}
/** Pairing keys are stored as `enc:v1:<base64 of safeStorage ciphertext>`. Base64url keys never contain ':'. */
const ENC_PREFIX = 'enc:v1:';

const DEFAULTS = {
  signalBase: 'https://ntfy.sh',
  hostName: os.hostname(),
  sharing: true,
  allowControl: true,
  keepAwake: true, // hold off sleep while sharing is on
  endOnLock: false, // end the phone session when this PC locks
  shareAudio: false, // send PC audio to the phone (read by the engine)
  allowFiles: true, // accept files sent from the phone into Downloads\Glidr (also needs allowControl and a phone that is not view only)
  allowActions: false, // quick actions from the phone (lock, sleep, restart, launchers): off until the PC owner turns it on; see actions.js
  actionsEnabled: null, // ids switched on individually; null = defaults (lock, sleep only). Restart, shutdown and launchers need an explicit yes
  launchers: [], // {id, label, path, args[]}: defined on this PC only, max 12; the phone never sees paths or arguments
  allowLan: true, // LAN signaling: a phone on the same Wi-Fi sets up the connection directly with this PC (see lanserver.js)
  lanPort: 0, // port of that server; 0 = pick a random free one in 49152-65535 at the first start, then keep it
  recordSessions: false, // save what the phone views to Videos\Glidr (off by default; the phone is told while it runs; see recording.js)
  useUpnp: true, // while a phone is connected, ask the router to open ONE UDP port so a phone on mobile data can reach this PC (see upnp.js)
  allowPhoneRecording: true, // the phone may start and stop a recording of its own session (never records unless the phone taps Record; see host.js #phoneRecord)
  allowPhoneMedia: true, // the phone may send its camera and microphone (on by default; the PC owner can switch it off); shown in a window on this PC (see phonemedia.js). Also needs allowControl and a phone that is not view only
  phoneMediaSink: '', // audio output chosen in that window for the phone's microphone; '' = the system default
  quality: 'auto', // auto | low | balanced | high
  codec: 'auto', // auto | h264 | vp8 | vp9 | av1 (vp9 / av1 only when the phone can decode them)
  stun: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun.cloudflare.com:3478'],
  turn: null, // optional {urls, username, credential}; off by default, TURN would relay media through a server
  // {id, key(b64url), name, createdAt, claimedAt, lastSeen, needsRepair?, viewOnly?, expiresAt?, maxSessionMin?}
  slots: [],
};

class Store {
  /**
   * @param {string} dir settings folder
   * @param {{safeStorage?: {isEncryptionAvailable():boolean, encryptString(s:string):Buffer, decryptString(b:Buffer):string}|null}} [deps]
   *   safeStorage defaults to Electron's, loaded lazily; pass null to force plaintext.
   */
  constructor(dir, deps = {}) {
    this.file = path.join(dir, 'settings.json');
    this._safe = deps.safeStorage;
    /** slot id -> stored `enc:v1:` string of a key that could not be decrypted, kept so a later load can retry */
    this.locked = new Map();
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { /* first run */ }
    this.data = { ...DEFAULTS, ...(raw || {}), slots: Array.isArray(raw?.slots) ? raw.slots.map((s) => ({ ...s })) : [] };
    this.data.launchers = sanitizeLaunchers(this.data.launchers); // a hand-edited file must not widen what can run
    this.data.codec = normalizeCodecPref(this.data.codec); // a hand-edited file must not break the engine
    if (this.data.allowActions !== true) this.data.allowActions = false;
    if (typeof this.data.allowLan !== 'boolean') this.data.allowLan = true;
    if (this.data.recordSessions !== true) this.data.recordSessions = false; // a hand-edited file cannot switch it on by accident
    if (!Number.isInteger(this.data.lanPort) || this.data.lanPort < 1024 || this.data.lanPort > 65535) this.data.lanPort = 0;
    if (this.data.actionsEnabled !== null && !Array.isArray(this.data.actionsEnabled)) this.data.actionsEnabled = null;
    this.data.turn = normalizeTurn(this.data.turn); // a damaged or hand-edited relay setting is dropped, never half-used
    if (typeof this.data.useUpnp !== 'boolean') this.data.useUpnp = true; // a damaged value falls back to the default (on)
    if (typeof this.data.allowPhoneRecording !== 'boolean') this.data.allowPhoneRecording = true; // a damaged value falls back to the default (on)
    if (typeof this.data.allowPhoneMedia !== 'boolean') this.data.allowPhoneMedia = true; // phone camera: a damaged value falls back to the default (on)
    if (typeof this.data.phoneMediaSink !== 'string' || this.data.phoneMediaSink.length > 300) this.data.phoneMediaSink = '';
    const migrate = this.#openKeys();
    this.pruneSlots();
    if (migrate && this.#canEncrypt()) this.save(); // existing plaintext keys: rewrite the file encrypted
  }

  #safeStorage() {
    if (this._safe === undefined) {
      try { this._safe = require('electron').safeStorage || null; } catch { this._safe = null; }
    }
    return this._safe;
  }

  #canEncrypt() {
    try { const s = this.#safeStorage(); return !!s && !!s.isEncryptionAvailable(); } catch { return false; }
  }

  /** Decrypts stored keys in place. Returns whether any slot still held a plaintext key. */
  #openKeys() {
    let plaintext = false;
    for (const s of this.data.slots) {
      delete s.needsRepair;
      if (typeof s.key !== 'string' || !s.key) continue;
      if (!s.key.startsWith(ENC_PREFIX)) { plaintext = true; continue; }
      const stored = s.key;
      try {
        if (!this.#canEncrypt()) throw new Error('encryption unavailable');
        s.key = this.#safeStorage().decryptString(Buffer.from(stored.slice(ENC_PREFIX.length), 'base64'));
        if (!s.key) throw new Error('empty key');
      } catch {
        // Unreadable here (other Windows user, restored profile): keep the slot and the ciphertext, ask for re-pairing.
        this.locked.set(s.id, stored);
        s.key = '';
        s.needsRepair = true;
      }
    }
    return plaintext;
  }

  #seal(key) {
    if (!key || !this.#canEncrypt()) return key;
    try { return ENC_PREFIX + this.#safeStorage().encryptString(key).toString('base64'); } catch { return key; }
  }

  #serialize() {
    const slots = this.data.slots.map((s) => {
      const { needsRepair, ...rest } = s;
      return { ...rest, key: needsRepair ? (this.locked.get(s.id) || '') : this.#seal(s.key) };
    });
    return JSON.stringify({ ...this.data, slots }, null, 2);
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, this.#serialize(), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  get(k) { return this.data[k]; }
  set(patch) { Object.assign(this.data, patch); this.save(); }

  pruneSlots() {
    const now = Date.now();
    const before = this.data.slots.length;
    this.data.slots = this.data.slots.filter((s) => s.claimedAt || now - s.createdAt < UNCLAIMED_TTL_MS);
    if (before !== this.data.slots.length) this.save();
  }

  /**
   * New one-time pairing slot; becomes a permanent device slot once a phone claims it.
   * [opts] (all optional, see permissions.js): viewOnly, maxSessionMin, and expireAfterClaimMs, which turns into
   * `expiresAt` when a phone claims the slot, so a guest's hour starts when pairing starts, not when the code is shown.
   */
  createSlot(opts = {}) {
    this.pruneSlots();
    // keep at most one open (unclaimed) pairing at a time
    this.data.slots = this.data.slots.filter((s) => s.claimedAt);
    const slot = {
      id: crypto.randomBytes(6).toString('hex'),
      key: newKey().toString('base64url'),
      name: '', createdAt: Date.now(), claimedAt: 0, lastSeen: 0,
    };
    const pos = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
    if (opts.viewOnly === true) slot.viewOnly = true;
    if (pos(opts.maxSessionMin)) slot.maxSessionMin = pos(opts.maxSessionMin);
    if (pos(opts.expireAfterClaimMs)) slot.expireAfterClaimMs = pos(opts.expireAfterClaimMs);
    this.data.slots.push(slot);
    this.save();
    return slot;
  }

  slot(id) { return this.data.slots.find((s) => s.id === id); }

  claim(id, name) {
    const s = this.slot(id);
    if (!s) return;
    if (!s.claimedAt) {
      s.claimedAt = Date.now();
      if (s.expireAfterClaimMs > 0) s.expiresAt = s.claimedAt + s.expireAfterClaimMs; // guest: the clock starts now
      delete s.expireAfterClaimMs;
    }
    if (name) s.name = name.slice(0, 48);
    s.lastSeen = Date.now();
    this.save();
  }

  revoke(id) {
    this.data.slots = this.data.slots.filter((s) => s.id !== id);
    this.locked.delete(id);
    this.save();
  }
}

module.exports = { Store, UNCLAIMED_TTL_MS, ENC_PREFIX, parseRelayUrls, normalizeTurn };
