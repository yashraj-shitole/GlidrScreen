'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { newKey } = require('./crypto');

const UNCLAIMED_TTL_MS = 15 * 60 * 1000;

const DEFAULTS = {
  signalBase: 'https://ntfy.sh',
  hostName: os.hostname(),
  sharing: true,
  allowControl: true,
  quality: 'auto', // auto | low | balanced | high
  codec: 'auto', // auto | h264 | vp8
  stun: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun.cloudflare.com:3478'],
  turn: null, // optional {urls, username, credential}; off by default, TURN would relay media through a server
  slots: [], // {id, key(b64url), name, createdAt, claimedAt, lastSeen}
};

class Store {
  constructor(dir) {
    this.file = path.join(dir, 'settings.json');
    this.data = { ...DEFAULTS };
    try {
      this.data = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
    } catch { /* first run */ }
    this.pruneSlots();
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
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

  /** New one-time pairing slot; becomes a permanent device slot once a phone claims it. */
  createSlot() {
    this.pruneSlots();
    // keep at most one open (unclaimed) pairing at a time
    this.data.slots = this.data.slots.filter((s) => s.claimedAt);
    const slot = {
      id: crypto.randomBytes(6).toString('hex'),
      key: newKey().toString('base64url'),
      name: '', createdAt: Date.now(), claimedAt: 0, lastSeen: 0,
    };
    this.data.slots.push(slot);
    this.save();
    return slot;
  }

  slot(id) { return this.data.slots.find((s) => s.id === id); }

  claim(id, name) {
    const s = this.slot(id);
    if (!s) return;
    if (!s.claimedAt) s.claimedAt = Date.now();
    if (name) s.name = name.slice(0, 48);
    s.lastSeen = Date.now();
    this.save();
  }

  revoke(id) {
    this.data.slots = this.data.slots.filter((s) => s.id !== id);
    this.save();
  }
}

module.exports = { Store, UNCLAIMED_TTL_MS };
