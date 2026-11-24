'use strict';
const assert = require('assert');
const { PauseTimer, untilLabel, nextLocalHour, formatResume, pausedLabel, HOUR_MS } = require('../src/pausetimer');

const at = (y, mo, d, h, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime(); // local time

// next 08:00
assert.strictEqual(nextLocalHour(at(2026, 5, 10, 22, 30)), at(2026, 5, 11, 8));
assert.strictEqual(nextLocalHour(at(2026, 5, 10, 3, 0)), at(2026, 5, 10, 8)); // before 08:00: this morning
assert.strictEqual(nextLocalHour(at(2026, 5, 10, 8, 0)), at(2026, 5, 11, 8)); // exactly 08:00: tomorrow
assert.strictEqual(nextLocalHour(at(2026, 5, 31, 23, 0)), at(2026, 6, 1, 8)); // month rollover

// labels
const now = at(2026, 5, 10, 17, 0);
assert.strictEqual(formatResume(at(2026, 5, 10, 18, 0), now), '18:00');
assert.strictEqual(formatResume(at(2026, 5, 11, 8, 5), now), 'tomorrow 08:05');
assert.strictEqual(pausedLabel(at(2026, 5, 10, 18, 0), now), 'Paused, resumes at 18:00');
assert.strictEqual(pausedLabel(at(2026, 5, 11, 8, 0), now), 'Paused, resumes tomorrow 08:00');
assert.strictEqual(untilLabel(now), 'Pause until tomorrow 08:00');
assert.strictEqual(untilLabel(at(2026, 5, 10, 2, 0)), 'Pause until 08:00');

// fake clock and timers
function rig() {
  const r = { t: at(2026, 5, 10, 17, 0), timers: new Map(), id: 0, resumed: 0 };
  r.timer = new PauseTimer({
    onResume: () => { r.resumed++; },
    now: () => r.t,
    setTimer: (fn, ms) => { r.timers.set(++r.id, { fn, due: r.t + ms }); return r.id; },
    clearTimer: (h) => r.timers.delete(h),
  });
  r.advance = (ms) => {
    r.t += ms;
    for (const [h, tm] of [...r.timers]) if (tm.due <= r.t) { r.timers.delete(h); tm.fn(); }
  };
  return r;
}

{
  const r = rig();
  assert.strictEqual(r.timer.label(), null);
  r.timer.pauseFor(HOUR_MS);
  assert.ok(r.timer.active);
  assert.strictEqual(r.timer.label(), 'Paused, resumes at 18:00');
  r.advance(HOUR_MS - 1);
  assert.strictEqual(r.resumed, 0);
  r.advance(1);
  assert.strictEqual(r.resumed, 1);
  assert.ok(!r.timer.active);
  assert.strictEqual(r.timers.size, 0);
  assert.strictEqual(r.timer.label(), null);
}

{ // a manual change clears the timer: the timer must not resume later
  const r = rig();
  r.timer.pauseFor(HOUR_MS);
  r.timer.clear();
  assert.strictEqual(r.timers.size, 0);
  r.advance(2 * HOUR_MS);
  assert.strictEqual(r.resumed, 0);
  assert.strictEqual(r.timer.label(), null);
}

{ // a new pause replaces the old one
  const r = rig();
  r.timer.pauseFor(HOUR_MS);
  r.timer.pauseUntilHour(8);
  assert.strictEqual(r.timers.size, 1);
  assert.strictEqual(r.timer.label(), 'Paused, resumes tomorrow 08:00');
  r.advance(HOUR_MS * 2);
  assert.strictEqual(r.resumed, 0);
  r.advance(15 * HOUR_MS);
  assert.strictEqual(r.resumed, 1);
}

{ // after sleep, timers may be late or lost: check() resumes when due and re-arms when early
  const r = rig();
  r.timer.pauseFor(HOUR_MS);
  r.timers.clear(); // timer lost while asleep
  r.t += 2 * HOUR_MS;
  assert.strictEqual(r.timer.check(), true);
  assert.strictEqual(r.resumed, 1);
  assert.strictEqual(r.timer.check(), false); // nothing active
  r.timer.pauseFor(HOUR_MS);
  assert.strictEqual(r.timer.check(), false);
  assert.strictEqual(r.timers.size, 1);
}

console.log('ok');
