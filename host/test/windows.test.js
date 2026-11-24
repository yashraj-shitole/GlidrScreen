'use strict';
// Window sharing, pure logic (src/windows.js): list filtering, change detection, id validation, HWND parsing and
// the fall-back decisions, with fake sources and rectangles. Run: node host/test/windows.test.js
const assert = require('assert');
const W = require('../src/windows');

// ---- HWND parsing
assert.strictEqual(W.parseHwnd('window:1234:0'), 1234);
assert.strictEqual(W.parseHwnd('window:918534:12'), 918534);
assert.strictEqual(W.parseHwnd('screen:1234:0'), null, 'screens are not windows');
for (const bad of ['window:0:0', 'window:-5:0', 'window:abc:0', 'window:12:', 'window:12', 'window:1234:0:1', ' window:1:0', 'window:1:0 ',
  'window:99999999999999999999:0', '', null, undefined, 42, {}, ['window:1:0']]) {
  assert.strictEqual(W.parseHwnd(bad), null, 'rejects ' + JSON.stringify(bad));
}

// ---- titles are cleaned and cut
assert.strictEqual(W.cleanTitle('  Notes \u0000 -\tEditor\n'), 'Notes - Editor');
assert.strictEqual(W.cleanTitle('a‮b'), 'a b', 'bidi override removed');
assert.strictEqual(W.cleanTitle(7), '');
assert.strictEqual(Array.from(W.cleanTitle('x'.repeat(200))).length, W.MAX_TITLE);
const emoji = '\u{1F600}'.repeat(100); // 100 code points, 200 UTF-16 units: cut on code points, never mid-pair
assert.strictEqual(Array.from(W.cleanTitle(emoji)).length, 80);
assert.ok(!/[\ud800-\udbff]$/.test(W.cleanTitle(emoji)), 'no lone surrogate at the end');

// ---- list filtering
const rects = {
  1: { x: 0, y: 0, w: 1280, h: 720, iconic: false },
  2: { x: 10, y: 10, w: 800, h: 600, iconic: false },
  3: { x: 0, y: 0, w: 100, h: 500, iconic: false }, // too narrow
  4: { x: 0, y: 0, w: 500, h: 119, iconic: false }, // too short
  5: { x: -32000, y: -32000, w: 0, h: 0, iconic: true }, // minimised
  6: { x: 0, y: 0, w: 640.4, h: 480.6, iconic: false },
  7: { x: 0, y: 0, w: 640, h: 480, iconic: false }, // our own window by id
  8: { x: 0, y: 0, w: 640, h: 480, iconic: false }, // our own window by title
  9: { x: 0, y: 0, w: 640, h: 480, iconic: false }, // untitled
};
const rectOf = (h) => rects[h] || null; // 99 is not a window any more
const src = [
  { id: 'window:1:0', name: 'Docs - Browser' },
  { id: 'window:2:0', name: 'Notes' },
  { id: 'window:3:0', name: 'Narrow' },
  { id: 'window:4:0', name: 'Short' },
  { id: 'window:5:0', name: 'Minimised' },
  { id: 'window:6:0', name: 'Fractional' },
  { id: 'window:7:0', name: 'Settings' },
  { id: 'window:8:0', name: 'Glidr Screen' },
  { id: 'window:9:0', name: '   ' },
  { id: 'window:99:0', name: 'Closed' },
  { id: 'screen:1:0', name: 'Entire screen' },
  { id: 'window:2:0', name: 'Notes again (duplicate id)' },
  { id: 5, name: 'bad id' },
  null,
];
let list = W.buildList(src, { rectOf, ownIds: new Set(['window:7:0']) });
assert.deepStrictEqual(list, [
  { id: 'window:1:0', title: 'Docs - Browser', w: 1280, h: 720 },
  { id: 'window:2:0', title: 'Notes', w: 800, h: 600 },
  { id: 'window:6:0', title: 'Fractional', w: 640, h: 481 },
]);
assert.deepStrictEqual(W.buildList(null, { rectOf }), []);
assert.deepStrictEqual(W.buildList([{ id: 'window:1:0', name: 'X' }], { rectOf: () => { throw new Error('win32'); } }), [], 'a failing rect lookup drops the window');
assert.strictEqual(W.buildList([{ id: 'window:8:0', name: 'GLIDR SCREEN ' }], { rectOf }).length, 0, 'own title, any case');
// a long title is cut inside the list
list = W.buildList([{ id: 'window:1:0', name: 'T'.repeat(300) }], { rectOf });
assert.strictEqual(list[0].title.length, 80);

// ---- at most 30 windows
const many = Array.from({ length: 50 }, (_, i) => ({ id: `window:${100 + i}:0`, name: 'W' + i }));
const big = W.buildList(many, { rectOf: () => ({ x: 0, y: 0, w: 400, h: 300, iconic: false }) });
assert.strictEqual(big.length, W.MAX_WINDOWS);
assert.strictEqual(big[0].id, 'window:100:0', 'front to back order is kept');

// ---- previews: the first 12
assert.strictEqual(W.thumbIds(big).length, 12);
assert.deepStrictEqual(W.thumbIds(big.slice(0, 3)), ['window:100:0', 'window:101:0', 'window:102:0']);
assert.deepStrictEqual(W.thumbIds([]), []);

// ---- change detection
{
  const d = new W.ChangeDetector();
  const a = [{ id: 'window:1:0', title: 'A', w: 300, h: 200 }];
  assert.strictEqual(d.changed([]), true, 'first look always reports, even an empty list');
  assert.strictEqual(d.changed([]), false);
  assert.strictEqual(d.changed(a), true);
  assert.strictEqual(d.changed(a.map((x) => ({ ...x }))), false, 'equal content is not a change');
  assert.strictEqual(d.changed([{ ...a[0], title: 'A*' }]), true, 'title change');
  assert.strictEqual(d.changed([{ ...a[0], title: 'A*', w: 301 }]), true, 'size change');
  assert.strictEqual(d.changed([{ ...a[0], title: 'A*', w: 301 }, { id: 'window:2:0', title: 'B', w: 300, h: 200 }]), true, 'new window');
  d.reset();
  assert.strictEqual(d.changed([{ ...a[0], title: 'A*', w: 301 }, { id: 'window:2:0', title: 'B', w: 300, h: 200 }]), true, 'after reset the list is sent again');
}

// ---- id validation: only ids of the latest list
{
  const l = [{ id: 'window:1:0', title: 'A', w: 300, h: 200 }];
  assert.strictEqual(W.validate('window:1:0', l), l[0]);
  assert.strictEqual(W.validate('window:2:0', l), null);
  assert.strictEqual(W.validate('window:1:0', null), null, 'no list yet');
  assert.strictEqual(W.validate('window:1:0', []), null);
  assert.strictEqual(W.validate(1, l), null);
  assert.strictEqual(W.validate(undefined, l), null);
  assert.strictEqual(W.validate({ toString: () => 'window:1:0' }, l), null);
}

// ---- fall-back decisions
assert.deepStrictEqual(W.decide({ x: 5, y: 6, w: 700, h: 500, iconic: false }), { action: 'ok', bounds: { x: 5, y: 6, w: 700, h: 500 } });
assert.strictEqual(W.decide(null).action, 'gone', 'closed');
assert.strictEqual(W.decide({ x: 0, y: 0, w: 0, h: 0, iconic: true }).action, 'gone', 'minimised');
assert.strictEqual(W.decide({ x: 0, y: 0, w: 0, h: 10, iconic: false }).action, 'gone', 'empty rectangle');
assert.strictEqual(W.decide(undefined).action, 'gone');

// ---- tracker: refresh at most every 250 ms, report "gone" exactly once
{
  let t = 1000;
  let rect = { x: 0, y: 0, w: 800, h: 600, iconic: false };
  let calls = 0;
  const tr = new W.WindowTracker({ rectOf: (h) => { calls++; assert.strictEqual(h, 77); return rect; }, now: () => t });
  assert.strictEqual(tr.poll().state, 'idle', 'not started');
  tr.start(77, { x: 0, y: 0, w: 800, h: 600 });
  assert.strictEqual(tr.active, true);
  t += 100;
  assert.strictEqual(tr.poll().state, 'wait');
  assert.strictEqual(calls, 0, 'no Win32 call inside the 250 ms window');
  t += 150;
  let r = tr.poll();
  assert.deepStrictEqual([r.state, r.moved, calls], ['ok', false, 1]);
  t += 100; assert.strictEqual(tr.poll().state, 'wait');
  rect = { x: 50, y: 40, w: 900, h: 650, iconic: false };
  t += 150;
  r = tr.poll();
  assert.deepStrictEqual([r.state, r.moved, r.bounds], ['ok', true, { x: 50, y: 40, w: 900, h: 650 }]);
  t += 250;
  assert.strictEqual(tr.poll().moved, false, 'same bounds again');
  rect = { x: -32000, y: -32000, w: 0, h: 0, iconic: true };
  t += 250;
  assert.strictEqual(tr.poll().state, 'gone');
  t += 1000;
  assert.strictEqual(tr.poll().state, 'idle', 'reported once, then quiet');
  tr.start(77, null); // sharing another window re-arms it
  rect = { x: 0, y: 0, w: 400, h: 300, iconic: false };
  t += 300;
  assert.strictEqual(tr.poll().state, 'ok');
  tr.stop();
  assert.strictEqual(tr.poll().state, 'idle');
  assert.strictEqual(tr.active, false);
}
{
  let t = 0;
  const tr = new W.WindowTracker({ rectOf: () => { throw new Error('boom'); }, now: () => t });
  tr.start(5, null); t = 500;
  assert.strictEqual(tr.poll().state, 'gone', 'a throwing Win32 call counts as gone');
}

console.log('ok windows');
