'use strict';
// Update check logic against a fake GitHub (no network).
const assert = require('assert');
const { UpdateChecker, compareVersions } = require('../src/updates');

assert.ok(compareVersions('1.0.1', '1.0.0') > 0);
assert.ok(compareVersions('v1.10.0', '1.9.9') > 0);
assert.strictEqual(compareVersions('v1.0.0', '1.0.0'), 0);
assert.ok(compareVersions('1.0.0', '1.0.0-beta') === 0);
assert.ok(compareVersions('0.9', '1.0.0') < 0);

const fake = (status, body) => async (url, opts) => {
  assert.ok(url.endsWith('/releases/latest'));
  assert.ok(opts.headers['User-Agent']);
  return { status, ok: status >= 200 && status < 300, json: async () => body };
};

(async () => {
  const release = {
    tag_name: 'v1.2.0', html_url: 'https://github.com/x/y/releases/tag/v1.2.0',
    assets: [{ name: 'GlidrScreen-1.2.0.apk', browser_download_url: 'https://dl/apk' },
      { name: 'GlidrScreen-1.2.0-win-x64.zip', browser_download_url: 'https://dl/zip' }],
  };
  let s = await new UpdateChecker('1.0.0', { fetchImpl: fake(200, release) }).check();
  assert.strictEqual(s.status, 'available'); assert.strictEqual(s.latest, '1.2.0'); assert.strictEqual(s.download, 'https://dl/zip');

  s = await new UpdateChecker('1.2.0', { fetchImpl: fake(200, release) }).check();
  assert.strictEqual(s.status, 'latest');

  s = await new UpdateChecker('1.0.0', { fetchImpl: fake(404, {}) }).check();
  assert.strictEqual(s.status, 'none');

  s = await new UpdateChecker('1.0.0', { fetchImpl: fake(500, {}) }).check();
  assert.strictEqual(s.status, 'error');

  s = await new UpdateChecker('1.0.0', { fetchImpl: async () => { throw new Error('offline'); } }).check();
  assert.strictEqual(s.status, 'error'); assert.strictEqual(s.error, 'offline');

  // a release without a Windows asset links to the release page
  s = await new UpdateChecker('1.0.0', { fetchImpl: fake(200, { ...release, assets: [] }) }).check();
  assert.strictEqual(s.download, release.html_url);
  console.log('ok');
})().catch((e) => { console.error(e); process.exit(1); });
