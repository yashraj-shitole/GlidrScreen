'use strict';
// Clipboard sync and cursor stream: pure logic with injected IO so it runs under plain node in tests.
// Clipboard text is never logged anywhere in this file.

const MAX_CLIP_CHARS = 262_144; // 256 KB
const CLIP_POLL_MS = 500;
const CURSOR_MIN_INTERVAL_MS = 33; // ~30 messages per second at most

/** The text if it is a usable clipboard string (non-empty, within the cap), else null. */
function validClipText(s) {
  if (typeof s !== 'string' || s.length === 0 || s.length > MAX_CLIP_CHARS) return null;
  return s;
}

class ClipboardSync {
  /**
   * @param read () => string          current PC clipboard text
   * @param write (text) => void       set PC clipboard text
   * @param send (text) => void        push text to the phone
   */
  constructor({ read, write, send, setInterval: si = setInterval, clearInterval: ci = clearInterval, intervalMs = CLIP_POLL_MS }) {
    Object.assign(this, { read, write, send, si, ci, intervalMs });
    this.timer = null;
    this.last = null; // last clipboard text we have seen or written; changes against it are pushed
  }

  get on() { return this.timer !== null; }

  // Electron's clipboard API returns Promises in current versions, older ones and the tests return plain strings:
  // both are handled, so a Promise is never mistaken for "no text".
  #text(t) { return typeof t === 'string' ? t : ''; }

  #readNow() {
    try { return this.read(); } catch { return ''; }
  }

  /** Start or stop pushing PC clipboard changes. Starting records the current text as the baseline (not pushed). */
  setOn(on) {
    if (on === this.on) return;
    if (!on) { this.ci(this.timer); this.timer = null; return; }
    this.ready = false;
    this.last = null;
    const first = this.#readNow();
    if (first && typeof first.then === 'function') {
      first.then((t) => { this.last = this.#text(t); this.ready = true; }, () => { this.last = ''; this.ready = true; });
    } else {
      this.last = this.#text(first);
      this.ready = true;
    }
    this.timer = this.si(() => this.poll(), this.intervalMs);
  }

  /** One poll step; exported for tests. Sends only when the text changed, is non-empty and within the cap. */
  poll() {
    if (!this.ready) return false; // the baseline read is still pending
    const r = this.#readNow();
    if (r && typeof r.then === 'function') {
      if (this.busy) return false;
      this.busy = true;
      r.then((t) => this.#apply(this.#text(t)), () => {}).finally(() => { this.busy = false; });
      return false; // the result is applied when the read finishes
    }
    return this.#apply(this.#text(r));
  }

  #apply(t) {
    if (!this.on || t === this.last) return false;
    this.last = t;
    const ok = validClipText(t);
    if (ok === null) return false;
    this.send(ok);
    return true;
  }

  /** Phone set the clipboard. Returns whether it was applied. The write is remembered so it is not echoed back. */
  fromPhone(text) {
    const ok = validClipText(text);
    if (ok === null) return false;
    try {
      const r = this.write(ok);
      if (r && typeof r.catch === 'function') r.catch(() => {}); // a rejected async write must not crash the host
    } catch { return false; }
    this.last = ok;
    return true;
  }

  stop() { this.setOn(false); }
}

class CursorStream {
  /**
   * @param getPos () => {x,y}         cursor in physical px
   * @param getBounds () => {x,y,w,h}  shared display in physical px
   * @param send ({x,y}) => void       normalised 0..1
   */
  constructor({ getPos, getBounds, send, now = Date.now, setInterval: si = setInterval, clearInterval: ci = clearInterval, intervalMs = CURSOR_MIN_INTERVAL_MS + 1 }) {
    Object.assign(this, { getPos, getBounds, send, now, si, ci, intervalMs });
    this.timer = null;
    this.lastKey = null;
    this.lastAt = -Infinity;
  }

  get on() { return this.timer !== null; }

  start() {
    if (this.on) return;
    this.lastKey = null; this.lastAt = -Infinity;
    this.timer = this.si(() => this.tick(), this.intervalMs);
    this.tick();
  }

  stop() {
    if (!this.on) return;
    this.ci(this.timer);
    this.timer = null;
  }

  /** One step; exported for tests. Rate limited and only sends when the normalised position changed. */
  tick() {
    const t = this.now();
    if (t - this.lastAt < CURSOR_MIN_INTERVAL_MS) return false;
    let p, b;
    try { p = this.getPos(); b = this.getBounds(); } catch { return false; }
    if (!p || !b || !(b.w > 0) || !(b.h > 0)) return false;
    const x = normalize(p.x - b.x, b.w), y = normalize(p.y - b.y, b.h);
    const key = x + ',' + y;
    if (key === this.lastKey) return false;
    this.lastKey = key; this.lastAt = t;
    this.send({ x, y });
    return true;
  }
}

/** pixel offset inside an extent of `size` px -> 0..1 (pixel centres span 0..size-1), 4 decimals, clamped. */
function normalize(off, size) {
  const v = size > 1 ? off / (size - 1) : 0;
  return Math.round(Math.min(1, Math.max(0, v)) * 10000) / 10000;
}

module.exports = { ClipboardSync, CursorStream, validClipText, normalize, MAX_CLIP_CHARS, CLIP_POLL_MS, CURSOR_MIN_INTERVAL_MS };
