'use strict';
// Rendezvous over an ntfy topic (https://ntfy.sh, self-hostable). Only a few small AES-GCM sealed
// messages per connection pass through it (request, offer, answer); no media, no state, and the
// topic name is derived from the pairing key so it cannot be guessed. See docs/PROTOCOL.md.
const { EventEmitter } = require('events');
const { deriveSlot, seal, open } = require('./crypto');

class Signaling extends EventEmitter {
  /** @param {string} base e.g. https://ntfy.sh */
  constructor(base) {
    super();
    this.base = base.replace(/\/+$/, '');
    this.slots = new Map(); // topic -> {id, encKey}
    this.abort = null;
    this.running = false;
    this.lastId = null;
    this.backoff = 1000;
    this.generation = 0;
  }

  /** @param {{id:string,key:string}[]} slots */
  setSlots(slots) {
    this.slots = new Map();
    for (const s of slots) {
      const d = deriveSlot(Buffer.from(s.key, 'base64url'));
      this.slots.set(d.topic, { id: s.id, encKey: d.encKey });
    }
    if (this.running) this.#restart();
  }

  /** Switch to another ntfy server. Message ids are per server, so the resume point is dropped. */
  setBase(base) {
    this.base = base.replace(/\/+$/, '');
    this.lastId = null;
    if (this.running) this.#restart();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.#restart();
  }

  stop() {
    this.running = false;
    this.generation++;
    this.abort?.abort();
    this.emit('status', 'stopped');
  }

  #restart() {
    this.generation++;
    this.abort?.abort();
    if (!this.slots.size) { this.emit('status', 'idle'); return; }
    this.#loop(this.generation);
  }

  async #loop(gen) {
    while (this.running && gen === this.generation) {
      const ac = new AbortController();
      this.abort = ac;
      try {
        const topics = [...this.slots.keys()].join(',');
        const since = this.lastId ? `?since=${encodeURIComponent(this.lastId)}` : '';
        const res = await fetch(`${this.base}/${topics}/json${since}`, { signal: ac.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        this.backoff = 1000;
        this.emit('status', 'online');
        let buf = '';
        let watchdog = setTimeout(() => ac.abort(), 120_000); // ntfy sends a keepalive every 45 s
        const dec = new TextDecoder();
        for await (const chunk of res.body) {
          clearTimeout(watchdog);
          watchdog = setTimeout(() => ac.abort(), 120_000);
          buf += dec.decode(chunk, { stream: true });
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (line) this.#onEvent(line);
          }
        }
        clearTimeout(watchdog);
      } catch (e) {
        if (gen !== this.generation || !this.running) return;
      }
      if (gen !== this.generation || !this.running) return;
      this.emit('status', 'offline');
      await new Promise((r) => setTimeout(r, this.backoff));
      this.backoff = Math.min(this.backoff * 2, 30_000);
    }
  }

  #onEvent(line) {
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    if (ev.event !== 'message') return;
    this.lastId = ev.id;
    const slot = this.slots.get(ev.topic);
    if (!slot) return;
    const msg = open(slot.encKey, ev.message);
    if (!msg || typeof msg !== 'object') return; // not authentic: ignore silently
    this.emit('message', { slotId: slot.id, msg, serverTime: (ev.time || 0) * 1000 });
  }

  /** Seal and publish a message to the topic of the given key. */
  async publish(keyB64, obj) {
    const { topic, encKey } = deriveSlot(Buffer.from(keyB64, 'base64url'));
    const res = await fetch(`${this.base}/${topic}`, {
      method: 'POST',
      body: seal(encKey, obj),
      headers: { 'Content-Type': 'text/plain', Cache: 'yes' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`publish HTTP ${res.status}`);
  }
}

module.exports = { Signaling };
