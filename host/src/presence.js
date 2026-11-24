'use strict';
// "PC last seen": while the PC is asleep, off or Glidr Screen is closed, a phone can only time out. So the host leaves
// small sealed markers on every paired topic (ntfy keeps them, `Cache: yes`) that the phone reads later to say what
// probably happened: online / went to sleep / sharing paused / app closed. See docs/PROTOCOL.md ("Presence").
//
// Free of Electron: the signaling object, the store, the clock and the timers are injected, so it is unit tested with
// plain node. Publishing is best effort: every failure is swallowed, presence must never disturb the app.

const HEARTBEAT_MS = 5 * 60_000; // while sharing is on; the phone treats an 'online' marker older than ~7 min as stale
const STARTUP_DELAY_MS = 4_000; // let the signaling stream come up first
const RESUME_DELAY_MS = 3_000; // the network is often not back yet right after wake
const QUIT_TIMEOUT_MS = 1_500; // quitting must not wait longer than this for the network
const STATES = ['online', 'sleep', 'paused', 'quit'];

class Presence {
  /**
   * @param {{signaling: {publish: (key:string, msg:object, timeoutMs?:number) => Promise<void>, base?: string},
   *   store: {get: (k:string) => any}, now?: () => number, timers?: object, log?: (m:string) => void,
   *   heartbeatMs?: number, startupDelayMs?: number, resumeDelayMs?: number, quitTimeoutMs?: number}} o
   */
  constructor({ signaling, store, now = Date.now, timers, log, heartbeatMs, startupDelayMs, resumeDelayMs, quitTimeoutMs }) {
    this.signaling = signaling;
    this.store = store;
    this.now = now;
    this.t = timers || { setTimeout, clearTimeout, setInterval, clearInterval };
    this.log = log || (() => {});
    this.heartbeatMs = heartbeatMs ?? HEARTBEAT_MS;
    this.startupDelayMs = startupDelayMs ?? STARTUP_DELAY_MS;
    this.resumeDelayMs = resumeDelayMs ?? RESUME_DELAY_MS;
    this.quitTimeoutMs = quitTimeoutMs ?? QUIT_TIMEOUT_MS;
    this.started = false;
    this.asleep = false;
    this.quitting = false;
    this.sharing = false; // last seen value of the store's `sharing`, to notice a change
    this.base = null; // last seen signaling base, a new server needs a fresh marker
    this.announced = new Set(); // slot ids that already got a marker
    this.heartbeat = null;
    this.startupTimer = null;
    this.resumeTimer = null;
  }

  /** The plaintext message for a state. About 60 bytes; sealed it is far below the 3900 character frame limit. */
  message(state) {
    return { t: 'presence', from: 'h', ts: this.now(), state };
  }

  /** Claimed slots we can publish to (a slot with an unreadable key, or one still waiting for a phone, is skipped). */
  #slots() {
    const slots = this.store.get('slots');
    return (Array.isArray(slots) ? slots : []).filter((s) => s && s.claimedAt && s.key && !s.needsRepair);
  }

  #state() { return this.store.get('sharing') ? 'online' : 'paused'; }

  /**
   * Publishes [state] to every claimed slot (or just [only], a list of slot objects). Never rejects.
   * @returns {Promise<void>}
   */
  publish(state, { timeoutMs, only } = {}) {
    if (!STATES.includes(state)) return Promise.resolve();
    let slots;
    try { slots = only || this.#slots(); } catch { return Promise.resolve(); }
    const msg = this.message(state);
    return Promise.allSettled(slots.map((s) => {
      this.announced.add(s.id);
      try {
        return Promise.resolve(this.signaling.publish(s.key, msg, timeoutMs));
      } catch (e) {
        return Promise.reject(e);
      }
    })).then((results) => {
      const failed = results.filter((r) => r.status === 'rejected').length;
      if (failed) this.log(`presence ${state}: ${failed} of ${results.length} publishes failed`);
    });
  }

  /** Schedules the first marker and, when sharing is on, the heartbeat. */
  start() {
    if (this.started || this.quitting) return;
    this.started = true;
    this.sharing = !!this.store.get('sharing');
    this.base = this.signaling.base ?? null;
    if (this.sharing) this.#startHeartbeat();
    this.startupTimer = this.t.setTimeout(() => {
      this.startupTimer = null;
      this.#beat();
    }, this.startupDelayMs);
    this.startupTimer?.unref?.();
  }

  #beat() {
    if (this.quitting || this.asleep) return Promise.resolve();
    return this.publish(this.#state());
  }

  #startHeartbeat() {
    this.#stopHeartbeat();
    this.heartbeat = this.t.setInterval(() => { if (this.sharing) this.#beat(); }, this.heartbeatMs);
    this.heartbeat?.unref?.();
  }

  #stopHeartbeat() {
    if (this.heartbeat) this.t.clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  /**
   * Call whenever the host state may have changed (cheap; wired to the core's 'changed' event). Publishes when sharing
   * turned on or off, when the rendezvous server changed, and to a slot a phone just claimed.
   */
  sync() {
    if (!this.started || this.quitting || this.asleep) return;
    const sharing = !!this.store.get('sharing');
    const base = this.signaling.base ?? null;
    if (sharing !== this.sharing) {
      this.sharing = sharing;
      if (sharing) this.#startHeartbeat(); else this.#stopHeartbeat();
      this.#beat();
      return;
    }
    if (base !== this.base) {
      this.base = base;
      this.#beat();
      return;
    }
    if (this.startupTimer) return; // the startup marker will cover every slot
    const slots = this.#slots();
    const ids = new Set(slots.map((s) => s.id));
    for (const id of this.announced) if (!ids.has(id)) this.announced.delete(id); // removed phones
    const fresh = slots.filter((s) => !this.announced.has(s.id));
    if (fresh.length) this.publish(this.#state(), { only: fresh });
  }

  /** powerMonitor 'suspend': best effort, the machine may be gone before the request leaves. */
  suspend() {
    if (this.quitting) return Promise.resolve();
    this.asleep = true;
    this.#stopHeartbeat();
    this.t.clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
    return this.publish('sleep', { timeoutMs: this.quitTimeoutMs });
  }

  /** powerMonitor 'resume': say so once the network has had a moment to come back. */
  resume() {
    if (!this.started || this.quitting) return;
    this.asleep = false;
    this.t.clearTimeout(this.resumeTimer);
    this.resumeTimer = this.t.setTimeout(() => {
      this.resumeTimer = null;
      if (this.asleep) return;
      this.sharing = !!this.store.get('sharing');
      if (this.sharing) this.#startHeartbeat();
      this.#beat();
    }, this.resumeDelayMs);
    this.resumeTimer?.unref?.();
  }

  /**
   * The app is closing: publishes 'quit' and resolves when that is done or after [quitTimeoutMs], whichever is first.
   * Never rejects and publishes only once.
   */
  quit() {
    if (this.quitting) return Promise.resolve();
    const wasStarted = this.started;
    this.quitting = true;
    this.#stopHeartbeat();
    this.t.clearTimeout(this.startupTimer);
    this.t.clearTimeout(this.resumeTimer);
    if (!wasStarted) return Promise.resolve();
    let guard;
    const limit = new Promise((resolve) => { guard = this.t.setTimeout(resolve, this.quitTimeoutMs); });
    return Promise.race([this.publish('quit', { timeoutMs: this.quitTimeoutMs }), limit]).then(() => this.t.clearTimeout(guard));
  }

  /** Wires the core's 'changed' event and Electron's powerMonitor, then starts. */
  attach({ core, monitor }) {
    const safe = (fn) => () => { try { fn(); } catch { /* presence never breaks the app */ } };
    core?.on?.('changed', safe(() => this.sync()));
    monitor?.on?.('suspend', safe(() => { this.suspend(); }));
    monitor?.on?.('resume', safe(() => this.resume()));
    this.start();
    return this;
  }
}

module.exports = { Presence, STATES, HEARTBEAT_MS, STARTUP_DELAY_MS, RESUME_DELAY_MS, QUIT_TIMEOUT_MS };
