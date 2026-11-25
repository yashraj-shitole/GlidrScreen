'use strict';
// Silent update: downloads the release's NSIS installer, proves it is the file GitHub published (SHA-256 digest from the
// release API), and runs it silently when the user clicks "Restart to update".
//
// Everything outside the module is injected (fetch, fs, spawn, clock, paths), so it is unit tested without a network,
// a disk or an installer. Rules:
//  - only https on github.com / *.githubusercontent.com is ever requested, and every redirect hop is checked again;
//  - no valid sha256 digest, or a missing/oversized size: no silent install (the UI falls back to the release page);
//  - the file is streamed to a temp .part file, hashed while streaming, and deleted on any mismatch, error or cancel;
//  - only a copy installed by the installer (under %LOCALAPPDATA%\Programs) installs; a portable copy keeps the link;
//  - the installer is hashed again right before it is started.
const { EventEmitter } = require('events');
const nodeCrypto = require('crypto');
const path = require('path');

const MAX_BYTES = 300 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const IDLE_MS = 30_000; // no bytes for this long: give up
const DIGEST_RE = /^sha256:([0-9a-f]{64})$/i;
const SETUP_RE = /-setup\.exe$/i;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
// electron-builder NSIS: /S silent; --updated marks it as an update (keeps the user's choices), --force-run starts the app
// again at the end (silent installs do not by default).
const INSTALL_ARGS = ['/S', '--updated', '--force-run'];
const EXACT_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);

class UpdateError extends Error {
  constructor(message, retry = true) { super(message); this.retry = retry; }
}

/** https only, no credentials, default port, and github.com or a subdomain of githubusercontent.com. */
function isAllowedUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
  const h = u.hostname.toLowerCase();
  return EXACT_HOSTS.has(h) || h.endsWith('.githubusercontent.com');
}

/** "sha256:<64 hex>" -> lowercase hex, anything else -> null. */
function parseDigest(d) {
  const m = DIGEST_RE.exec(String(d || ''));
  return m ? m[1].toLowerCase() : null;
}

/**
 * Picks the installer out of a GitHub release asset list.
 * @returns {{name: string, url: string, size: number, digest: string|null}|null} digest is the raw API value
 */
function pickInstaller(assets, repo) {
  const a = (assets || []).find((x) => x && SETUP_RE.test(String(x.name || '')));
  if (!a) return null;
  const url = String(a.browser_download_url || '');
  // the asset must live in this repo's releases: a tampered or odd URL is not recorded
  if (!url.startsWith(`https://github.com/${repo}/releases/download/`)) return null;
  return { name: String(a.name), url, size: Number(a.size) || 0, digest: typeof a.digest === 'string' ? a.digest : null };
}

/**
 * Whether an installer asset may be downloaded and installed silently.
 * @returns {{ok: true, sha256: string} | {ok: false, reason: string}}
 */
function assessInstaller(inst) {
  if (!inst) return { ok: false, reason: 'no installer in this release' };
  if (!isAllowedUrl(inst.url)) return { ok: false, reason: 'installer address is not allowed' };
  const sha256 = parseDigest(inst.digest);
  if (!sha256) return { ok: false, reason: 'release has no valid sha256 digest' };
  if (!Number.isSafeInteger(inst.size) || inst.size <= 0) return { ok: false, reason: 'release has no valid size' };
  if (inst.size > MAX_BYTES) return { ok: false, reason: 'installer is larger than 300 MB' };
  return { ok: true, sha256 };
}

class Updater extends EventEmitter {
  /**
   * @param {object} o
   * @param {typeof fetch} o.fetchImpl
   * @param {{promises: object, createReadStream: Function}} o.fs  node:fs shaped
   * @param {Function} o.spawn  child_process.spawn shaped
   * @param {() => number} [o.now]
   * @param {string} o.tempDir  the app's temp dir
   * @param {string} o.execPath process.execPath
   * @param {string} [o.localAppData] %LOCALAPPDATA%
   * @param {string} [o.platform]
   * @param {() => void} o.quit  the app's normal quit path (presence markers, sessions end cleanly)
   * @param {number} [o.idleMs]
   */
  constructor(o) {
    super();
    this.fetch = o.fetchImpl || fetch;
    this.fs = o.fs;
    this.spawn = o.spawn;
    this.now = o.now || Date.now;
    this.tempDir = o.tempDir;
    this.execPath = o.execPath;
    this.localAppData = o.localAppData || '';
    this.platform = o.platform || process.platform;
    this.quit = o.quit;
    this.idleMs = o.idleMs || IDLE_MS;
    this.userAgent = o.userAgent || 'GlidrScreen';
    this.state = { status: 'idle', version: null, percent: 0, received: 0, total: 0, error: null, retry: false };
    this.file = null;     // final path of the verified installer, when status is ready
    this.sha256 = null;
    this.ctl = null;      // AbortController of the running download
    this.lastPercent = -1;
  }

  /** True when this running copy was put in place by the installer (so the installer can replace it in place). */
  canInstall() {
    if (this.platform !== 'win32' || !this.localAppData || !this.execPath) return false;
    const w = path.win32;
    const rel = w.relative(w.join(this.localAppData, 'Programs'), this.execPath);
    return !!rel && !rel.startsWith('..') && !w.isAbsolute(rel);
  }

  #set(patch) { this.state = { ...this.state, ...patch }; this.emit('changed', this.state); }

  get #dir() { return path.join(this.tempDir, 'GlidrScreenUpdate'); }

  /** What the renderer sees: no URL, no path, no digest. */
  view(checker) {
    const inst = checker?.installer ? assessInstaller(checker.installer) : { ok: false };
    const s = this.state;
    return {
      mode: this.canInstall() && inst.ok ? 'install' : 'link',
      status: s.status, version: s.version, percent: s.percent, error: s.error, retry: s.retry,
    };
  }

  /** The checker found something else (a newer version, or this build is current): drop a stale download. */
  async sync(checker) {
    if (this.state.status === 'idle' || !this.state.version) return;
    const stale = checker.status === 'latest' || checker.status === 'none'
      || (checker.status === 'available' && checker.latest !== this.state.version);
    if (stale) await this.reset();
  }

  async reset() {
    this.ctl?.abort(new UpdateError('cancelled', false));
    await this.#cleanup();
    this.file = null; this.sha256 = null;
    this.#set({ status: 'idle', version: null, percent: 0, received: 0, total: 0, error: null, retry: false });
  }

  cancel() {
    if (this.state.status === 'downloading') this.ctl?.abort(new UpdateError('cancelled', false));
    else if (this.state.status === 'ready' || this.state.status === 'error') return this.reset();
    return Promise.resolve();
  }

  /** Removes every file this module may have left in its temp dir. */
  async #cleanup() {
    const { promises: p } = this.fs;
    let names = [];
    try { names = await p.readdir(this.#dir); } catch { return; }
    for (const n of names) {
      if (/^GlidrScreen-.+-setup\.exe(\.part)?$/.test(n)) { try { await p.unlink(path.join(this.#dir, n)); } catch { /* gone already */ } }
    }
  }

  /** GET with manual redirects: every hop must be an allowed address. */
  async #get(url, signal) {
    let cur = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!isAllowedUrl(cur)) throw new UpdateError('The download address is not allowed', false);
      const res = await this.fetch(cur, {
        redirect: 'manual', signal, headers: { 'User-Agent': this.userAgent, Accept: 'application/octet-stream' },
      });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get('location');
        try { await res.body?.cancel?.(); } catch { /* ignore */ }
        if (!loc) throw new UpdateError('Bad redirect from the download server');
        let next;
        try { next = new URL(loc, cur).toString(); } catch { throw new UpdateError('Bad redirect from the download server'); }
        cur = next;
        continue;
      }
      return res;
    }
    throw new UpdateError('Too many redirects');
  }

  /**
   * Downloads and verifies the installer the checker recorded. Never throws: the outcome is in `state`.
   * @param {object} checker UpdateChecker.state: the renderer cannot pass an address or a path
   */
  async download(checker) {
    if (this.state.status === 'downloading') return this.state;
    if (!this.canInstall()) return this.#fail(new UpdateError('This copy was not installed by the installer', false), checker?.latest);
    const version = String(checker?.latest || '');
    if (checker?.status !== 'available' || !VERSION_RE.test(version)) return this.#fail(new UpdateError('No update to download', false), version);
    const inst = checker.installer;
    const verdict = assessInstaller(inst);
    if (!verdict.ok) return this.#fail(new UpdateError(`Cannot install silently: ${verdict.reason}`, false), version);

    const { promises: p } = this.fs;
    const total = inst.size;
    const final = path.join(this.#dir, `GlidrScreen-${version}-setup.exe`);
    const part = `${final}.part`;
    this.file = null; this.sha256 = null; this.lastPercent = -1;
    const ctl = this.ctl = new AbortController();
    let idle = null;
    const bump = () => { clearTimeout(idle); idle = setTimeout(() => ctl.abort(new UpdateError('The download stalled')), this.idleMs); };
    const aborted = new Promise((_, rej) => {
      ctl.signal.addEventListener('abort', () => rej(ctl.signal.reason instanceof Error ? ctl.signal.reason : new UpdateError('cancelled', false)), { once: true });
    });
    aborted.catch(() => {}); // only awaited inside race()
    const race = (pr) => Promise.race([pr, aborted]);
    let fh = null, reader = null;

    this.#set({ status: 'downloading', version, percent: 0, received: 0, total, error: null, retry: false });
    try {
      await p.mkdir(this.#dir, { recursive: true });
      await this.#cleanup();
      bump();
      const res = await race(this.#get(inst.url, ctl.signal));
      if (!res.ok) throw new UpdateError(`Download failed (HTTP ${res.status})`);
      const len = res.headers.get('content-length');
      if (len != null && Number(len) !== total) throw new UpdateError('The download size does not match the release', false);
      if (!res.body?.getReader) throw new UpdateError('The download has no content');
      reader = res.body.getReader();
      fh = await p.open(part, 'w');
      const hash = nodeCrypto.createHash('sha256');
      let received = 0;
      for (;;) {
        const { done, value } = await race(reader.read());
        if (done) break;
        bump();
        received += value.length;
        if (received > total) throw new UpdateError('The download is larger than the release says', false);
        hash.update(value);
        await race(writeAll(fh, value));
        const percent = Math.floor((received / total) * 100);
        if (percent !== this.lastPercent) { this.lastPercent = percent; this.#set({ percent, received }); }
      }
      if (received !== total) throw new UpdateError('The download is incomplete');
      await fh.close(); fh = null;
      if (hash.digest('hex') !== verdict.sha256) throw new UpdateError('The download does not match its checksum', false);
      await p.rename(part, final);
      this.file = final; this.sha256 = verdict.sha256;
      this.#set({ status: 'ready', percent: 100, received: total });
    } catch (e) {
      const err = ctl.signal.aborted && ctl.signal.reason instanceof Error ? ctl.signal.reason : e;
      try { await reader?.cancel(); } catch { /* ignore */ }
      try { await fh?.close(); } catch { /* ignore */ }
      fh = null;
      await this.#cleanup();
      this.file = null; this.sha256 = null;
      if (err.message === 'cancelled') this.#set({ status: 'idle', version: null, percent: 0, received: 0, total: 0, error: null, retry: false });
      else this.#fail(err, version);
    } finally {
      clearTimeout(idle);
      this.ctl = null;
    }
    return this.state;
  }

  #fail(err, version) {
    const retry = err instanceof UpdateError ? err.retry : true;
    this.#set({ status: 'error', version: version || null, percent: 0, received: 0, error: err.message || String(err), retry });
    return this.state;
  }

  /** SHA-256 of a file on disk, streamed. */
  #hashFile(file) {
    return new Promise((resolve, reject) => {
      const h = nodeCrypto.createHash('sha256');
      const s = this.fs.createReadStream(file);
      s.on('data', (c) => h.update(c)); s.on('error', reject); s.on('end', () => resolve(h.digest('hex')));
    });
  }

  /**
   * Starts the verified installer silently and quits the app. Only valid when status is "ready".
   * @returns {Promise<boolean>} whether the installer was started
   */
  async install() {
    if (this.state.status !== 'ready' || !this.file || !this.sha256) return false;
    if (!this.canInstall()) { this.#fail(new UpdateError('This copy was not installed by the installer', false), this.state.version); return false; }
    try {
      // The file sat in the temp dir for a while: check that it is still exactly what was verified.
      const st = await this.fs.promises.stat(this.file);
      if (st.size !== this.state.total || await this.#hashFile(this.file) !== this.sha256) {
        throw new UpdateError('The downloaded update changed on disk. Download it again.');
      }
      const child = this.spawn(this.file, INSTALL_ARGS, { detached: true, stdio: 'ignore', windowsHide: true });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.unref();
    } catch (e) {
      await this.#cleanup();
      this.file = null; this.sha256 = null;
      this.#fail(e instanceof UpdateError ? e : new UpdateError(`Could not start the installer: ${e.message || e}`), this.state.version);
      return false;
    }
    this.emit('installing');
    this.quit();
    return true;
  }
}

async function writeAll(fh, buf) {
  let off = 0;
  while (off < buf.length) {
    const { bytesWritten } = await fh.write(buf, off, buf.length - off);
    off += bytesWritten;
  }
}

module.exports = { Updater, UpdateError, isAllowedUrl, parseDigest, pickInstaller, assessInstaller, MAX_BYTES, INSTALL_ARGS };
