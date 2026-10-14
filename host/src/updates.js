'use strict';
// "Check for updates": asks GitHub for the latest published release and compares its tag with this build.
// Only notifies and links to the download; nothing is downloaded or installed automatically.
const { EventEmitter } = require('events');

const RELEASES_REPO = 'yashraj-shitole/GlidrScreen';
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 15_000;

/** Numeric parts of "v1.2.3" / "1.2.3-beta" -> [1, 2, 3]. */
function parseVersion(v) {
  return String(v || '').trim().replace(/^v/i, '').split(/[.+-]/).slice(0, 3).map((p) => parseInt(p, 10) || 0);
}

/** > 0 when a is newer than b. */
function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
}

class UpdateChecker extends EventEmitter {
  /**
   * @param {string} current this build's version, e.g. app.getVersion()
   * @param {{repo?: string, fetchImpl?: typeof fetch}} [opts]
   */
  constructor(current, opts = {}) {
    super();
    this.current = current;
    this.repo = opts.repo || RELEASES_REPO;
    this.fetch = opts.fetchImpl || fetch;
    // status: idle | checking | latest | available | none (no release published yet) | error
    this.state = { status: 'idle', current, latest: null, page: null, download: null, checkedAt: 0, error: null };
    this.timer = null;
  }

  start() {
    clearTimeout(this.timer);
    const loop = async () => { await this.check(); this.timer = setTimeout(loop, CHECK_EVERY_MS); };
    this.timer = setTimeout(loop, FIRST_CHECK_MS);
  }

  stop() { clearTimeout(this.timer); this.timer = null; }

  #set(patch) { this.state = { ...this.state, ...patch }; this.emit('changed', this.state); }

  async check() {
    if (this.state.status === 'checking') return this.state;
    this.#set({ status: 'checking', error: null });
    try {
      const res = await this.fetch(`https://api.github.com/repos/${this.repo}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': `GlidrScreen/${this.current}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 404) { this.#set({ status: 'none', checkedAt: Date.now() }); return this.state; }
      if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`);
      const rel = await res.json();
      const latest = String(rel.tag_name || '').replace(/^v/i, '');
      if (!latest) throw new Error('release has no tag');
      // the PC package: an .exe or a Windows .zip; otherwise the release page has everything
      const asset = (rel.assets || []).find((a) => /\.exe$/i.test(a.name) || /win.*\.zip$/i.test(a.name));
      const newer = compareVersions(latest, this.current) > 0;
      const page = /^https:\/\//.test(rel.html_url || '') ? rel.html_url : `https://github.com/${this.repo}/releases/latest`;
      this.#set({
        status: newer ? 'available' : 'latest', latest, page,
        download: asset?.browser_download_url || page, checkedAt: Date.now(),
      });
    } catch (e) {
      this.#set({ status: 'error', error: e.message || String(e), checkedAt: Date.now() });
    }
    return this.state;
  }
}

module.exports = { UpdateChecker, compareVersions, parseVersion, RELEASES_REPO };
