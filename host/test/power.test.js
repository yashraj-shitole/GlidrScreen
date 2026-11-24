'use strict';
const assert = require('assert');
const { EventEmitter } = require('events');
const { KeepAwake, wirePower } = require('../src/power');

// KeepAwake
{
  const calls = [];
  const blocker = { start: (t) => { calls.push(['start', t]); return 7; }, stop: (id) => calls.push(['stop', id]) };
  let sharing = true; let setting = true;
  const k = new KeepAwake(blocker, () => sharing && setting);
  assert.strictEqual(k.sync(), true);
  k.sync(); // idempotent: no second block
  assert.deepStrictEqual(calls, [['start', 'prevent-app-suspension']]);
  sharing = false; // paused
  assert.strictEqual(k.sync(), false);
  sharing = true; setting = false; // setting off
  k.sync();
  assert.deepStrictEqual(calls, [['start', 'prevent-app-suspension'], ['stop', 7]]);
  setting = true; k.sync();
  assert.strictEqual(k.active, true);
  k.release();
  assert.strictEqual(k.active, false);
  assert.strictEqual(calls[calls.length - 1][0], 'stop');
}

// wirePower
function rig(settings = {}, withSetLocked = true) {
  const log = [];
  const monitor = new EventEmitter();
  const core = { endSession: (...a) => log.push(['end', ...a]) };
  if (withSetLocked) core.setLocked = (v) => log.push(['locked', v]);
  wirePower({
    monitor, core,
    signaling: { reconnect: () => log.push(['reconnect']) },
    store: { get: (k) => settings[k] },
    keepAwake: { sync: () => log.push(['sync']) },
    pauseTimer: { check: () => log.push(['check']) },
  });
  return { monitor, log };
}
{
  const { monitor, log } = rig();
  monitor.emit('resume');
  assert.deepStrictEqual(log, [['reconnect'], ['check'], ['sync']]);
}
{
  const { monitor, log } = rig({ endOnLock: false });
  monitor.emit('lock-screen');
  assert.deepStrictEqual(log, [['locked', true]]); // setting off: session survives the lock
  log.length = 0;
  monitor.emit('unlock-screen');
  assert.deepStrictEqual(log, [['locked', false], ['reconnect']]);
}
{
  const { monitor, log } = rig({ endOnLock: true });
  monitor.emit('lock-screen');
  assert.deepStrictEqual(log, [['locked', true], ['end', 'PC locked', true]]);
}
{ // core without setLocked (older host.js) must not throw; lock still ends the session when asked
  const { monitor, log } = rig({ endOnLock: true }, false);
  monitor.emit('lock-screen');
  monitor.emit('unlock-screen');
  assert.deepStrictEqual(log, [['end', 'PC locked', true], ['reconnect']]);
}
{ // a throwing handler does not escape
  const monitor = new EventEmitter();
  wirePower({ monitor, core: {}, signaling: { reconnect: () => { throw new Error('x'); } }, store: { get: () => false } });
  monitor.emit('resume');
}

console.log('ok');
