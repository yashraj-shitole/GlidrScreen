'use strict';
// Phone -> PC file transfer, the PC side. Pure logic with an injectable folder, so it is unit tested with plain node.
//
// Flow (see docs/PROTOCOL.md, "File transfer"): the phone offers a file on `ctl`; the host decides (policy, size, one at a
// time) and answers accept / reject; the phone then streams the bytes on the `files` channel (begin, binary chunks, end).
// Bytes go straight to a temp file in the target folder, hashed as they arrive, and the temp file is renamed to its final,
// unique name only when the byte count and SHA-256 both match. Nothing here ever opens or runs the file.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_BYTES = 200 * 1024 * 1024;
const MAX_NAME = 120;
const MAX_CHUNK = 16384; // what the phone sends; a chunk a little bigger is tolerated, a huge one is not
const MAX_FRAME = 256 * 1024;
const BEGIN_TIMEOUT_MS = 30_000; // accepted, but the phone never started
const IDLE_TIMEOUT_MS = 60_000; // nothing received for this long: give up
const PART_SUFFIX = '.glidr-part';

const REJECT = Object.freeze({
  DISABLED: 'disabled', TOO_BIG: 'too-big', VIEW_ONLY: 'view-only', BUSY: 'busy', BAD_NAME: 'bad-name',
});

const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)$/i;
// Control characters, the characters Windows forbids in file names, and the bidi overrides used to fake extensions.
const FORBIDDEN = /[\u0000-\u001f\u007f-\u009f<>:"/\\|?*‎‏‪-‮⁦-⁩]/g;

/**
 * A name that is safe to create in the Downloads\Glidr folder: no directory part, nothing Windows would reject or
 * reinterpret, at most 120 characters (the extension survives truncation), and never empty ("file").
 */
function sanitizeName(raw) {
  let s = typeof raw === 'string' ? raw : '';
  s = s.normalize('NFC');
  s = s.slice(Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')) + 1); // strip any path, either separator
  s = s.replace(FORBIDDEN, '');
  s = s.replace(/^[ .]+/, '').replace(/[ .]+$/, ''); // leading dots hide files / ".." ; trailing dots and spaces are dropped by Windows
  if (!s) return 'file';
  s = clip(s);
  s = s.replace(/[ .]+$/, '');
  if (!s) return 'file';
  // "CON", "con.txt", "NUL.tar.gz": the part before the first dot names the device
  const stem = s.split('.')[0].replace(/ +$/, '');
  if (RESERVED.test(stem)) s = '_' + s;
  return clip(s);
}

/** Cuts to MAX_NAME code points but keeps a normal-looking extension. */
function clip(s) {
  const chars = Array.from(s);
  if (chars.length <= MAX_NAME) return s;
  const dot = s.lastIndexOf('.');
  const ext = dot > 0 ? s.slice(dot) : '';
  if (ext && Array.from(ext).length <= 16) {
    return Array.from(s.slice(0, dot)).slice(0, MAX_NAME - Array.from(ext).length).join('') + ext;
  }
  return chars.slice(0, MAX_NAME).join('');
}

/** "name.ext" -> "name (2).ext" (n = 2, 3, ...). */
function numbered(name, n) {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  return `${stem} (${n})${ext}`;
}

/** The first of "name", "name (2)", "name (3)", ... that [taken] says is free. */
function uniqueName(name, taken) {
  if (!taken(name)) return name;
  for (let i = 2; i < 10_000; i++) {
    const c = numbered(name, i);
    if (!taken(c)) return c;
  }
  return numbered(name, crypto.randomBytes(4).toString('hex'));
}

/**
 * Why an offer must be refused, or null. The order matters for what the phone is told: a switched-off feature or a
 * view-only phone first, then a malformed offer, then size, then "busy".
 * @param {{allowFiles:boolean, allowControl:boolean, viewOnly:boolean, busy:boolean, maxBytes?:number}} ctx
 */
function rejectReason(offer, ctx) {
  if (ctx.allowFiles !== true || ctx.allowControl !== true) return REJECT.DISABLED;
  if (ctx.viewOnly === true) return REJECT.VIEW_ONLY;
  if (!offer || typeof offer.name !== 'string' || !validId(offer.id)) return REJECT.BAD_NAME;
  if (!Number.isSafeInteger(offer.size) || offer.size < 0) return REJECT.BAD_NAME;
  if (offer.size > (ctx.maxBytes || MAX_BYTES)) return REJECT.TOO_BIG;
  if (ctx.busy) return REJECT.BUSY;
  return null;
}

const validId = (id) => typeof id === 'string' && /^[0-9a-f]{8}$/.test(id);

/**
 * Exclusively creates (an empty file) the first free "name (n).ext" in [dir], so two writers can never pick the same
 * name, and returns {name, file}. The caller renames its finished temp file over the reservation.
 */
async function reserveName(dir, name, fsp = fs.promises) {
  for (let i = 1; i < 10_000; i++) {
    const candidate = i === 1 ? name : numbered(name, i);
    try {
      const h = await fsp.open(path.join(dir, candidate), 'wx');
      await h.close();
      return { name: candidate, file: path.join(dir, candidate) };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  throw new Error('no free file name');
}

/**
 * One incoming transfer at a time. The host feeds it the phone's offer and the `files` channel frames; it reports
 * through the callbacks and never throws into the caller.
 */
class FileReceiver {
  /**
   * @param {object} o
   * @param {() => string} o.dir where files are saved (called per transfer; created when missing)
   * @param {(m:object) => void} o.send sends a control message to the phone on `ctl`
   * @param {(info:{name:string, size:number}) => void} [o.onSaved]
   * @param {(msg:string) => void} [o.log] never receives file names, contents or hashes
   * @param {number} [o.maxBytes]
   * @param {number} [o.beginTimeoutMs]
   * @param {number} [o.idleTimeoutMs]
   * @param {object} [o.fsp] fs.promises compatible (tests)
   */
  constructor({ dir, send, onSaved, log, maxBytes = MAX_BYTES, beginTimeoutMs = BEGIN_TIMEOUT_MS, idleTimeoutMs = IDLE_TIMEOUT_MS, fsp = fs.promises }) {
    this.dir = dir;
    this.send = send;
    this.onSaved = onSaved || (() => {});
    this.log = log || (() => {});
    this.maxBytes = maxBytes;
    this.beginTimeoutMs = beginTimeoutMs;
    this.idleTimeoutMs = idleTimeoutMs;
    this.fsp = fsp;
    this.settling = Promise.resolve(); // the last transfer's cleanup and reply
    this.t = null; // current transfer: {id, name, size, state, received, hash, handle, part, chain, timer, failed}
  }

  get busy() { return this.t !== null; }

  /** Progress of the running transfer (for the control panel), or null. */
  get progress() { return this.t ? { name: this.t.name, size: this.t.size, received: this.t.received } : null; }

  /**
   * Handles a `file-offer`. [policy] = {allowFiles, allowControl, viewOnly}. Replies with accept or reject.
   * Returns the rejection reason, or null when accepted.
   */
  offer(m, policy) {
    const reason = rejectReason(m, { ...policy, busy: this.busy, maxBytes: this.maxBytes });
    if (reason) {
      this.send({ t: 'file-reject', id: validId(m?.id) ? m.id : '', reason });
      return reason;
    }
    const t = {
      id: m.id, name: sanitizeName(m.name), size: m.size, state: 'accepted', received: 0,
      hash: crypto.createHash('sha256'), handle: null, part: null, chain: Promise.resolve(), timer: null, failed: false,
    };
    this.t = t;
    this.#arm(t, this.beginTimeoutMs, 'no start');
    this.send({ t: 'file-accept', id: t.id });
    return null;
  }

  /** A text frame from the `files` channel: {"t":"begin","id"}, {"t":"end","id","sha256"} or {"t":"cancel","id"}. */
  onText(text) {
    let m;
    try { m = JSON.parse(text); } catch { return; }
    const t = this.t;
    if (!t || !m || m.id !== t.id) return;
    if (m.t === 'begin' && t.state === 'accepted') this.#begin(t);
    else if (m.t === 'end' && t.state === 'receiving') this.#end(t, m);
    else if (m.t === 'cancel') this.#fail(t, 'cancelled by the phone');
  }

  /** A binary frame (Buffer / Uint8Array) from the `files` channel. */
  onBinary(buf) {
    const t = this.t;
    if (!t || t.state !== 'receiving') return;
    const chunk = ArrayBuffer.isView(buf) ? Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength) : Buffer.from(buf);
    if (chunk.length === 0) return;
    if (chunk.length > MAX_FRAME || t.received + chunk.length > t.size) { this.#fail(t, 'too much data'); return; }
    t.received += chunk.length;
    t.hash.update(chunk);
    this.#arm(t, this.idleTimeoutMs, 'stalled');
    t.chain = t.chain.then(() => (t.handle && !t.failed ? t.handle.write(chunk, 0, chunk.length, null) : null))
      .catch((e) => this.#fail(t, 'write failed: ' + (e.code || e.message)));
  }

  #begin(t) {
    t.state = 'receiving';
    this.#arm(t, this.idleTimeoutMs, 'stalled');
    t.chain = t.chain.then(async () => {
      const dir = this.dir();
      await this.fsp.mkdir(dir, { recursive: true });
      t.dir = dir;
      t.part = path.join(dir, `.${t.id}${PART_SUFFIX}`);
      t.handle = await this.fsp.open(t.part, 'wx');
    }).catch((e) => this.#fail(t, 'cannot create file: ' + (e.code || e.message)));
  }

  #end(t, m) {
    t.state = 'finishing';
    clearTimeout(t.timer);
    t.chain = t.chain.then(async () => {
      if (t.failed) return;
      const want = typeof m.sha256 === 'string' ? m.sha256.toLowerCase() : '';
      const got = t.hash.digest('hex');
      if (t.received !== t.size) throw new Error('size mismatch');
      if (want !== got) throw new Error('checksum mismatch');
      await t.handle.close();
      t.handle = null;
      const { name, file } = await reserveName(t.dir, t.name, this.fsp);
      t.reserved = file;
      await this.fsp.rename(t.part, file); // replaces the empty reservation made above
      t.part = null; t.reserved = null;
      this.#finish(t, true, name);
    }).catch((e) => this.#fail(t, e.message));
  }

  /** Stops the transfer (session ended, feature switched off). Deletes the partial file. Tells the phone only if [notify]. */
  abort(reason, notify = false) {
    const t = this.t;
    if (t) this.#fail(t, reason, notify);
  }

  #fail(t, reason, notify = true) {
    if (t.failed || this.t !== t) return;
    t.failed = true;
    this.log(`file transfer failed: ${reason}`);
    this.#finish(t, false, '', notify);
  }

  #finish(t, ok, name, notify = true) {
    if (this.t !== t) return;
    this.t = null;
    clearTimeout(t.timer);
    const cleanup = Promise.resolve(t.chain).catch(() => {}).then(async () => {
      try { await t.handle?.close(); } catch { /* ignore */ }
      t.handle = null;
      if (!ok) {
        for (const f of [t.part, t.reserved]) if (f) { try { await this.fsp.rm(f, { force: true }); } catch { /* ignore */ } }
      }
    });
    this.settling = cleanup.then(() => {
      if (notify) this.send({ t: 'file-done', id: t.id, ok, name: ok ? name : '' });
      if (ok) this.onSaved({ name, size: t.size });
    });
  }

  #arm(t, ms, why) {
    clearTimeout(t.timer);
    t.timer = setTimeout(() => this.#fail(t, 'timed out: ' + why), ms);
    t.timer.unref?.();
  }

  /** Resolves when everything queued for the current / last transfer has been written (tests, shutdown). */
  async idle() {
    for (let i = 0; i < 5; i++) {
      const t = this.t;
      if (t) await t.chain.catch(() => {});
      await new Promise((r) => setImmediate(r));
      await this.settling;
      if (!this.t) return;
    }
  }
}

module.exports = {
  MAX_BYTES, MAX_NAME, MAX_CHUNK, REJECT, PART_SUFFIX, sanitizeName, uniqueName, rejectReason, reserveName, FileReceiver,
};
