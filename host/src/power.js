'use strict';
// Power and lock behaviour, kept free of Electron so it can be tested: the blocker and the powerMonitor are injected.

/** Holds a "prevent app suspension" block while sharing is on and the user wants the PC kept awake. */
class KeepAwake {
  /**
   * @param {{start:(type:string)=>number, stop:(id:number)=>void}} blocker Electron's powerSaveBlocker
   * @param {() => boolean} wanted whether a block should be held right now
   */
  constructor(blocker, wanted) {
    this.blocker = blocker;
    this.wanted = wanted;
    this.id = null;
  }

  get active() { return this.id !== null; }

  /** Start or release the block to match [wanted]. Cheap; call after any change of sharing or the setting. */
  sync() {
    let want = false;
    try { want = !!this.wanted(); } catch { /* treat as not wanted */ }
    if (want && this.id === null) this.id = this.blocker.start('prevent-app-suspension');
    else if (!want && this.id !== null) {
      const id = this.id;
      this.id = null;
      try { this.blocker.stop(id); } catch { /* already gone */ }
    }
    return this.active;
  }

  release() { this.wanted = () => false; this.sync(); }
}

/**
 * Wires Electron's powerMonitor to the host.
 * - resume / unlock-screen: reopen the signaling stream at once (it is dead after sleep) and re-check the pause timer.
 * - lock-screen / unlock-screen: tell the core (core.setLocked may not exist yet), and end the session on lock when
 *   the user asked for that.
 * @param {{monitor: {on: Function}, signaling: {reconnect: Function}, core: object, store: {get: Function},
 *   keepAwake?: KeepAwake, pauseTimer?: {check: Function}}} o
 */
function wirePower({ monitor, signaling, core, store, keepAwake, pauseTimer }) {
  const safe = (fn) => { try { fn(); } catch { /* never let a power event break the app */ } };
  monitor.on('resume', () => safe(() => {
    signaling.reconnect();
    pauseTimer?.check();
    keepAwake?.sync();
  }));
  monitor.on('unlock-screen', () => safe(() => {
    core.setLocked?.(false);
    signaling.reconnect();
  }));
  monitor.on('lock-screen', () => safe(() => {
    core.setLocked?.(true);
    if (store.get('endOnLock')) core.endSession('PC locked', true);
  }));
}

module.exports = { KeepAwake, wirePower };
