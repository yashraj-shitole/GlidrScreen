'use strict';
const assert = require('assert');
const p = require('../src/permissions');

const NOW = 1_700_000_000_000;
const H = 3_600_000;

// isExpired: missing / zero / bad values never expire
assert.strictEqual(p.isExpired(undefined, NOW), false);
assert.strictEqual(p.isExpired({}, NOW), false);
assert.strictEqual(p.isExpired({ expiresAt: 0 }, NOW), false);
assert.strictEqual(p.isExpired({ expiresAt: 'soon' }, NOW), false);
assert.strictEqual(p.isExpired({ expiresAt: NaN }, NOW), false);
assert.strictEqual(p.isExpired({ expiresAt: NOW + 1 }, NOW), false);
assert.strictEqual(p.isExpired({ expiresAt: NOW }, NOW), true, 'expires at the instant');
assert.strictEqual(p.isExpired({ expiresAt: NOW - 1 }, NOW), true);

// canControl: global switch AND not viewOnly
assert.strictEqual(p.canControl({}, true), true);
assert.strictEqual(p.canControl(undefined, true), true);
assert.strictEqual(p.canControl({ viewOnly: false }, true), true);
assert.strictEqual(p.canControl({ viewOnly: true }, true), false);
assert.strictEqual(p.canControl({}, false), false);
assert.strictEqual(p.canControl({ viewOnly: true }, false), false);
assert.strictEqual(p.canControl({}, undefined), false);

// sessionDeadline: earliest of the session limit and the end of access, 0 for neither
assert.strictEqual(p.sessionDeadline({}, NOW), 0);
assert.strictEqual(p.sessionDeadline(undefined, NOW), 0);
assert.strictEqual(p.sessionDeadline({ maxSessionMin: 60 }, NOW), NOW + H);
assert.strictEqual(p.sessionDeadline({ maxSessionMin: 0 }, NOW), 0);
assert.strictEqual(p.sessionDeadline({ expiresAt: NOW + 2 * H }, NOW), NOW + 2 * H);
assert.strictEqual(p.sessionDeadline({ maxSessionMin: 60, expiresAt: NOW + 2 * H }, NOW), NOW + H);
assert.strictEqual(p.sessionDeadline({ maxSessionMin: 60, expiresAt: NOW + 10 * 60_000 }, NOW), NOW + 10 * 60_000);

// describe
let d = p.describe({}, NOW);
assert.deepStrictEqual([d.viewOnly, d.expired, d.text, d.access], [false, false, '', 'never']);
d = p.describe({ viewOnly: true }, NOW);
assert.strictEqual(d.text, 'View only');
d = p.describe({ viewOnly: true, expiresAt: NOW + 45 * 60_000, maxSessionMin: 60 }, NOW);
assert.strictEqual(d.text, 'View only, Access ends in 45 min, 1 h per session');
assert.strictEqual(d.access, '1h');
d = p.describe({ expiresAt: NOW + 5 * H }, NOW);
assert.strictEqual(d.text, 'Access ends in 5 h');
assert.strictEqual(d.access, '1d');
d = p.describe({ expiresAt: NOW + 3 * 24 * H - 1 }, NOW);
assert.strictEqual(d.text, 'Access ends in 3 d');
assert.strictEqual(d.access, '7d');
d = p.describe({ expiresAt: NOW - 5 }, NOW);
assert.strictEqual(d.expired, true);
assert.strictEqual(d.text, 'Access expired');
assert.strictEqual(p.describe({ expiresAt: NOW + 1 }, NOW).text, 'Access ends in 1 min', 'never shows 0 min');

// applyUpdate: strict validation
const slot = () => ({ id: 'a', claimedAt: 1, maxSessionMin: 60 });
let s = slot();
assert.strictEqual(p.applyUpdate(s, { viewOnly: true }, NOW), true);
assert.strictEqual(s.viewOnly, true);
assert.strictEqual(s.maxSessionMin, 60, 'view only does not touch the session limit');
assert.strictEqual(p.applyUpdate(s, { viewOnly: true }, NOW), false, 'no change');
assert.strictEqual(p.applyUpdate(s, { viewOnly: false }, NOW), true);
assert.ok(!('viewOnly' in s));
for (const bad of ['1h ', '2h', '1H', '', 'toString', '__proto__', 'constructor', 'hasOwnProperty', 3600000, null, undefined, {}, ['1h'], true]) {
  s = slot();
  assert.strictEqual(p.applyUpdate(s, { expiresIn: bad }, NOW), false, 'rejected: ' + String(bad));
  assert.deepStrictEqual(s, slot());
}
for (const bad of ['true', 1, 0, null, 'yes']) {
  s = slot();
  assert.strictEqual(p.applyUpdate(s, { viewOnly: bad }, NOW), false);
  assert.deepStrictEqual(s, slot());
}
for (const bad of [null, undefined, 'x', 5]) assert.strictEqual(p.applyUpdate(slot(), bad, NOW), false);
assert.strictEqual(p.applyUpdate(null, { viewOnly: true }, NOW), false);
s = slot();
p.applyUpdate(s, { expiresIn: '1h' }, NOW);
assert.strictEqual(s.expiresAt, NOW + H);
assert.ok(!('maxSessionMin' in s), 'a chosen access length replaces the guest session cap');
p.applyUpdate(s, { expiresIn: '1d' }, NOW);
assert.strictEqual(s.expiresAt, NOW + 24 * H);
p.applyUpdate(s, { expiresIn: '7d' }, NOW);
assert.strictEqual(s.expiresAt, NOW + 7 * 24 * H);
p.applyUpdate(s, { expiresIn: 'never' }, NOW);
assert.strictEqual(s.expiresAt, 0);
s = { expiresAt: NOW - 1 }; // an expired phone can be renewed
p.applyUpdate(s, { expiresIn: '1h', extra: 'ignored' }, NOW);
assert.strictEqual(p.isExpired(s, NOW), false);
assert.ok(!('extra' in s));
// both fields at once
s = slot();
assert.strictEqual(p.applyUpdate(s, { viewOnly: true, expiresIn: '7d' }, NOW), true);
assert.strictEqual(s.viewOnly, true);
assert.strictEqual(s.expiresAt, NOW + 7 * 24 * H);

console.log('ok permissions');
