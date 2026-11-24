'use strict';
const assert = require('assert');
const { parseLink, findLink, isLinkArg, handleLink } = require('../src/links');

for (const v of ['pause', 'resume', 'disconnect']) {
  assert.strictEqual(parseLink(`glidr-screen://${v}`), v);
  assert.strictEqual(parseLink(`glidr-screen://${v}/`), v); // Windows appends a slash
  assert.strictEqual(parseLink(`GLIDR-SCREEN://${v.toUpperCase()}`), v);
}

const rejected = [
  'glidr-screen://start', 'glidr-screen://pair', 'glidr-screen://pair?key=abc', 'glidr-screen://share',
  'glidr-screen://', 'glidr-screen://pause/extra', 'glidr-screen://pause?x=1', 'glidr-screen://pause#x',
  'glidr-screen://user@pause', 'glidr-screen://pause@evil', 'glidr-screen://pause:80', 'glidr-screen:pause',
  'glidr-screen:///pause', 'glidr-screen://pause%0a', 'glidr-screen://pause\nglidr-screen://start',
  'glidr-screen://pauses', 'glidr-screen://xpause', 'http://pause', 'file://pause', 'pause', '', ' ',
  'glidr-screen://' + 'a'.repeat(100), null, undefined, 42, {}, ['glidr-screen://pause'],
];
for (const r of rejected) assert.strictEqual(parseLink(r), null, String(r));

assert.strictEqual(findLink(['C:\\app\\GlidrScreen.exe', '--hidden', 'glidr-screen://resume']), 'resume');
assert.strictEqual(findLink(['x', 'glidr-screen://start', 'glidr-screen://pause']), 'pause'); // invalid one is skipped, never run
assert.strictEqual(findLink(['x', 'glidr-screen://start']), null);
assert.strictEqual(findLink(undefined), null);
assert.strictEqual(isLinkArg('glidr-screen://start'), true);
assert.strictEqual(isLinkArg('--hidden'), false);

const log = [];
const actions = { pause: () => log.push('pause'), resume: () => log.push('resume'), disconnect: () => log.push('disconnect') };
assert.strictEqual(handleLink('glidr-screen://disconnect', actions), 'disconnect');
assert.strictEqual(handleLink('glidr-screen://start', actions), null);
assert.strictEqual(handleLink('glidr-screen://pause?then=start', actions), null);
assert.deepStrictEqual(log, ['disconnect']);

console.log('ok');
