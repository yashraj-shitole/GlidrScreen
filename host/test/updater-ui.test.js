'use strict';
// The update banner's states, taken from the pure updateBanner() block of renderer/ui.js (no DOM needed).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'ui.js'), 'utf8');
const m = /\/\/ <update-banner>[^\n]*\n([\s\S]*?)\/\/ <\/update-banner>/.exec(src);
assert.ok(m, 'update-banner block found in ui.js');
const ctx = {};
vm.runInNewContext(m[1] + '\nthis.updateBanner = updateBanner;', ctx);
const banner = ctx.updateBanner;

const base = { status: 'available', latest: '2.1.0' };
const inst = (o) => ({ mode: 'install', status: 'idle', version: null, percent: 0, error: null, retry: false, ...o });

// not available: hidden
assert.strictEqual(banner({ status: 'latest' }).show, false);
assert.strictEqual(banner({ status: 'checking', install: inst({}) }).show, false);

// "Download": portable copy, or a release that cannot be verified
let b = banner({ ...base, install: inst({ mode: 'link' }) });
assert.deepStrictEqual([b.show, b.button, b.action, b.bar, b.cancel], [true, 'Download', 'openUpdate', null, false]);
assert.match(b.title, /2\.1\.0/);
b = banner(base); // an old state without the install part
assert.strictEqual(b.button, 'Download');

// "Download and install"
b = banner({ ...base, install: inst({}) });
assert.deepStrictEqual([b.button, b.action, b.bar, b.cancel], ['Download and install', 'downloadUpdate', null, false]);

// progress
b = banner({ ...base, install: inst({ status: 'downloading', percent: 42, version: '2.1.0' }) });
assert.strictEqual(b.note, 'Downloading 42%'); assert.strictEqual(b.bar, 42); assert.strictEqual(b.cancel, true); assert.strictEqual(b.button, null);
b = banner({ ...base, install: inst({ status: 'downloading' }) });
assert.strictEqual(b.note, 'Downloading 0%'); assert.strictEqual(b.bar, 0);
// still shown while a re-check runs
assert.strictEqual(banner({ status: 'checking', latest: '2.1.0', install: inst({ status: 'downloading', percent: 5, version: '2.1.0' }) }).show, true);

// restart
b = banner({ ...base, install: inst({ status: 'ready', percent: 100, version: '2.1.0' }) });
assert.deepStrictEqual([b.button, b.action, b.bar, b.cancel], ['Restart to update', 'installUpdate', null, false]);

// errors: retry, or the release page
b = banner({ ...base, install: inst({ status: 'error', error: 'The download stalled', retry: true }) });
assert.deepStrictEqual([b.button, b.action, b.arg, b.bad, b.note], ['Try again', 'downloadUpdate', undefined, true, 'The download stalled']);
b = banner({ ...base, install: inst({ status: 'error', error: 'The download does not match its checksum', retry: false }) });
assert.deepStrictEqual([b.button, b.action, b.arg, b.bad], ['Open release page', 'openUpdate', 'page', true]);
b = banner({ ...base, install: inst({ status: 'error', error: 'x', retry: true, mode: 'link' }) });
assert.strictEqual(b.button, 'Open release page');

// the renderer only ever names a fixed action: no address or path is part of any state
for (const u of [base, { ...base, install: inst({}) }, { ...base, install: inst({ status: 'ready' }) }]) {
  const out = banner(u);
  assert.ok(['openUpdate', 'downloadUpdate', 'installUpdate'].includes(out.action));
  assert.ok(out.arg === undefined || out.arg === 'page');
}
console.log('ok');
