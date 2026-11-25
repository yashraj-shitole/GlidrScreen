'use strict';
// Session recording, the PC side. Pure logic with an injectable file system and clock, unit tested with plain node.
//
// The engine window records what the phone is viewing with MediaRecorder and hands over WebM chunks (see
// docs/PROTOCOL.md, "Recording"). This module writes them to <Videos>\Glidr and nowhere else:
//   * file names are `Glidr-<phone name>-<YYYYMMDD-HHMMSS>.webm`; the phone name goes through the same sanitiser as received
//     files, a file is only ever created with exclusive create (never overwritten) and only inside the given folder;
//   * a monitor / window switch starts a new segment (`...-2.webm`), so the file keeps going;
//   * a file stops at 2 GB (clean end, the owner is told through `onStopped`), too-small leftovers (< 1 KB) are deleted;
//   * bytes are written through a stream; when the disk cannot keep up, chunks are dropped rather than queued without bound.
// Nothing here logs a file name or path (error codes only).
const nodeFs = require('fs');
const path = require('path');
const { sanitizeName } = require('./files');

const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const MIN_KEEP_BYTES = 1024;
const MAX_QUEUE_BYTES = 32 * 1024 * 1024; // written to the stream but not yet flushed to disk
const MAX_CHUNK_BYTES = 64 * 1024 * 1024;
const MAX_NAME_CHARS = 40;
const FLUSH_TIMEOUT_MS = 10_000;
const EXT = '.webm';

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** 20260528-141503 in the PC's local time. */
function stamp(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** The phone's name as one safe file name part: no path, nothing Windows rejects, no spaces, at most 40 characters. */
function safePhoneName(raw) {
  let s = sanitizeName(typeof raw === 'string' ? raw : '');
  if (s === 'file') s = 'Phone'; // sanitizeName's "nothing left" answer
  s = s.replace(/\s+/g, '_').replace(/\.+/g, '_');
  s = Array.from(s).slice(0, MAX_NAME_CHARS).join('');
  return s || 'Phone';
}

/** `Glidr-<phone>-<stamp>` without extension: the stem every segment of one recording shares. */
function recordingStem(phoneName, ms) {
  return `Glidr-${safePhoneName(phoneName)}-${stamp(ms)}`;
}

/** Segment 1 is `<stem>.webm`, segment n is `<stem>-n.webm`. */
const segmentName = (stem, n) => (n <= 1 ? stem + EXT : `${stem}-${n}${EXT}`);

/**
 * Records one session. `dir` is the Videos\Glidr folder (created on start), `fs` and `clock` are injectable.
 * `onStopped(reason)` is called when the recording ends by itself: 'limit' (2 GB) or 'error' (disk trouble).
 * `debug(line)` may carry more detail; the caller decides whether it is shown at all.
 */
class SessionRecorder {
  constructor({ dir, fs = nodeFs, clock = Date.now, maxBytes = MAX_FILE_BYTES, minKeep = MIN_KEEP_BYTES, maxQueue = MAX_QUEUE_BYTES, onStopped, log, debug } = {}) {
    if (typeof dir !== 'string' || !dir) throw new Error('recording folder missing');
    this.dir = path.resolve(dir);
    this.fs = fs;
    this.clock = clock;
    this.maxBytes = maxBytes;
    this.minKeep = minKeep;
    this.maxQueue = maxQueue;
    this.onStopped = onStopped || (() => {});
    this.log = log || (() => {});
    this.debug = debug || (() => {});
    this.active = false;
    this.cur = null; // {seg, file, stream, bytes, failed}
    this.stem = null;
    this.kept = 0; // files kept so far
    this.dropped = 0; // chunks dropped because the disk lagged
    this.closing = new Set(); // finalisations in flight
  }

  /** Creates the folder and the first file. Returns false (and logs a code) when that is not possible. */
  start(phoneName) {
    if (this.active) return true;
    try {
      this.fs.mkdirSync(this.dir, { recursive: true });
      this.stem = recordingStem(phoneName, this.clock());
      this.kept = 0;
      this.dropped = 0;
      this.cur = this.#open(1, 1);
      this.active = true;
      return true;
    } catch (e) {
      this.log('recording: cannot start (' + (e && e.code || 'error') + ')');
      this.cur = null;
      return false;
    }
  }

  /** Exclusively creates the first free segment file at or after [from]; never overwrites anything. */
  #open(from, seg) {
    for (let n = from; n < from + 1000; n++) {
      const file = path.join(this.dir, segmentName(this.stem, n));
      if (path.dirname(path.resolve(file)) !== this.dir) throw new Error('outside the recording folder'); // cannot happen with a sanitised name
      let fd;
      try {
        fd = this.fs.openSync(file, 'wx');
      } catch (e) {
        if (e && e.code === 'EEXIST') continue;
        throw e;
      }
      const stream = this.fs.createWriteStream(file, { fd, autoClose: true });
      const c = { seg, idx: n, file, stream, bytes: 0, failed: false };
      stream.on('error', (e) => this.#failed(c, e));
      this.debug('recording: segment ' + n + ' -> ' + file);
      return c;
    }
    throw new Error('no free file name');
  }

  #failed(c, e) {
    if (c.failed) return;
    c.failed = true;
    this.log('recording: write failed (' + (e && e.code || 'error') + ')');
    if (this.cur === c) this.#end('error');
  }

  /**
   * One chunk of WebM. [seg] is the engine's segment counter: a larger one than the current moves on to the next file
   * (monitor / window switch), a smaller one is a late chunk of a finished segment and is dropped.
   * Returns 'ok', 'dropped' (disk too slow, or a stale chunk), 'ignored' (not recording, or not bytes) or 'stopped' (the
   * recording ended because of this chunk: file limit or disk error).
   */
  write(data, seg = 1) {
    if (!this.active || !this.cur) return 'ignored';
    const buf = toBuffer(data);
    if (!buf || buf.length === 0 || buf.length > MAX_CHUNK_BYTES) return 'ignored';
    const n = Number.isInteger(seg) && seg > 0 ? seg : 1;
    if (n < this.cur.seg) return 'dropped';
    try {
      if (n > this.cur.seg) this.#roll(n);
    } catch (e) {
      this.log('recording: cannot continue (' + (e && e.code || 'error') + ')');
      this.#end('error');
      return 'stopped';
    }
    const c = this.cur;
    if (c.bytes + buf.length > this.maxBytes) { this.#end('limit'); return 'stopped'; }
    if ((c.stream.writableLength || 0) + buf.length > this.maxQueue) { this.dropped++; return 'dropped'; }
    c.stream.write(buf);
    c.bytes += buf.length;
    return 'ok';
  }

  /** Next segment: the old file is finalised in the background and the new one is opened first, so no chunk is lost. */
  #roll(n) {
    const old = this.cur;
    this.cur = this.#open(old.idx + 1, n);
    this.#finalize(old);
  }

  /** Ends the recording from inside (limit, error): finalise, then tell the owner. */
  #end(reason) {
    if (!this.active) return;
    this.active = false;
    const c = this.cur;
    this.cur = null;
    if (c) this.#finalize(c);
    try { this.onStopped(reason); } catch { /* the owner's problem */ }
  }

  /** Closes a segment file (flushes the stream) and deletes it when it holds less than minKeep bytes. */
  #finalize(c) {
    const p = new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(t);
        if (c.bytes < this.minKeep) {
          try { this.fs.unlinkSync(c.file); } catch { /* already gone */ }
        } else {
          this.kept++;
        }
        resolve();
      };
      // never hang the quit on a stuck disk: give up waiting after 10 s
      const t = setTimeout(finish, FLUSH_TIMEOUT_MS);
      if (t.unref) t.unref();
      if (c.failed) { try { c.stream.destroy(); } catch { /* ignore */ } finish(); return; }
      try { c.stream.end(finish); } catch { finish(); }
      c.stream.once('error', finish);
      c.stream.once('close', finish);
    });
    this.closing.add(p);
    p.then(() => this.closing.delete(p));
    return p;
  }

  /** Stops, flushes and closes. Resolves {saved, files}: saved is true when at least one file was kept. */
  async stop() {
    if (this.active) {
      this.active = false;
      const c = this.cur;
      this.cur = null;
      if (c) this.#finalize(c);
    }
    await this.done();
    return { saved: this.kept > 0, files: this.kept };
  }

  /** Resolves when every file has been flushed (also those closed by a segment change or by the limit). */
  async done() {
    while (this.closing.size) await Promise.all([...this.closing]);
  }
}

function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

/** Where recordings go: <Videos>\Glidr. [videosDir] is app.getPath('videos'). */
const recordingsDirIn = (videosDir) => path.join(videosDir, 'Glidr');

module.exports = {
  MAX_FILE_BYTES, MIN_KEEP_BYTES, MAX_QUEUE_BYTES, safePhoneName, stamp, recordingStem, segmentName, recordingsDirIn, SessionRecorder,
};
