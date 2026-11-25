'use strict';
// Silent update: download rules, checksum, redirects, cancel, install conditions. Everything faked (no network, disk, installer).
const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const { Readable } = require('stream');
const { EventEmitter } = require('events');
const { Updater, isAllowedUrl, parseDigest, pickInstaller, assessInstaller, MAX_BYTES, INSTALL_ARGS } = require('../src/updater');
const { UpdateChecker } = require('../src/updates');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const REPO = 'yashraj-shitole/GlidrScreen';
const URL0 = `https://github.com/${REPO}/releases/download/v2.1.0/GlidrScreen-2.1.0-setup.exe`;
const CDN = 'https://release-assets.githubusercontent.com/github-production-release-asset/1/abc?sig=x';
const LOCAL = 'C:\\Users\\me\\AppData\\Local';
const INSTALLED_EXE = `${LOCAL}\\Programs\\Glidr Screen\\GlidrScreen.exe`;
const TEMP = 'C:\\Users\\me\\AppData\\Local\\Temp';

// ---- pure helpers ------------------------------------------------------------------------------------------------
for (const ok of ['https://github.com/a/b', 'https://objects.githubusercontent.com/x', 'https://release-assets.githubusercontent.com/x',
  'https://foo.githubusercontent.com/x', 'https://GitHub.com/a']) assert.ok(isAllowedUrl(ok), ok);
for (const bad of ['http://github.com/a', 'https://evil.com/github.com', 'https://github.com.evil.com/a', 'https://evilgithub.com/a',
  'https://evilgithubusercontent.com/a', 'https://githubusercontent.com.evil.com/a', 'https://user:pw@github.com/a', 'https://github.com:8443/a',
  'ftp://github.com/a', 'file:///C:/x.exe', 'javascript:alert(1)', '', null, undefined, 'github.com/a', 'https://api.github.com.evil.io/']) {
  assert.ok(!isAllowedUrl(bad), String(bad));
}

assert.strictEqual(parseDigest('sha256:' + 'AB'.repeat(32)), 'ab'.repeat(32));
for (const bad of [null, '', 'sha256:', 'sha256:abc', 'sha1:' + 'a'.repeat(40), 'sha256:' + 'g'.repeat(64), 'sha256:' + 'a'.repeat(65), ' sha256:' + 'a'.repeat(64)]) {
  assert.strictEqual(parseDigest(bad), null, String(bad));
}

const assets = [
  { name: 'GlidrScreen-2.1.0.apk', browser_download_url: 'https://x/apk' },
  { name: 'GlidrScreen-2.1.0-SETUP.EXE', browser_download_url: URL0, size: 1234, digest: 'sha256:' + 'a'.repeat(64) },
];
assert.deepStrictEqual(pickInstaller(assets, REPO), { name: 'GlidrScreen-2.1.0-SETUP.EXE', url: URL0, size: 1234, digest: 'sha256:' + 'a'.repeat(64) });
assert.strictEqual(pickInstaller([assets[0]], REPO), null);
assert.strictEqual(pickInstaller(null, REPO), null);
assert.strictEqual(pickInstaller(assets, 'someone/else'), null, 'asset outside the configured repo is not recorded');
assert.strictEqual(pickInstaller([{ name: 'a-setup.exe', browser_download_url: 'https://evil.com/a-setup.exe', size: 1, digest: null }], REPO), null);
assert.strictEqual(pickInstaller([{ name: 'a-setup.exe', browser_download_url: URL0, size: 5 }], REPO).digest, null);

const good = { name: 'x-setup.exe', url: URL0, size: 100, digest: 'sha256:' + 'a'.repeat(64) };
assert.deepStrictEqual(assessInstaller(good), { ok: true, sha256: 'a'.repeat(64) });
assert.ok(!assessInstaller(null).ok);
assert.ok(!assessInstaller({ ...good, digest: null }).ok, 'no digest, no silent install');
assert.ok(!assessInstaller({ ...good, digest: 'md5:abc' }).ok);
assert.ok(!assessInstaller({ ...good, size: 0 }).ok);
assert.ok(!assessInstaller({ ...good, size: -5 }).ok);
assert.ok(!assessInstaller({ ...good, size: 1.5 }).ok);
assert.ok(!assessInstaller({ ...good, size: MAX_BYTES + 1 }).ok, 'cap 300 MB');
assert.ok(assessInstaller({ ...good, size: MAX_BYTES }).ok);
assert.ok(!assessInstaller({ ...good, url: 'https://evil.com/x-setup.exe' }).ok);
assert.deepStrictEqual(INSTALL_ARGS[0], '/S');

// ---- fakes -------------------------------------------------------------------------------------------------------
function fakeFs() {
  const files = new Map(); // path -> Buffer
  const handles = [];
  const fs = {
    files, handles,
    promises: {
      async mkdir() {},
      async readdir(dir) {
        const names = [...files.keys()].filter((f) => path.dirname(f) === dir).map((f) => path.basename(f));
        if (!names.length && !fs.dirMade) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
        return names;
      },
      async open(p) {
        files.set(p, Buffer.alloc(0));
        const h = { closed: false, async write(buf, off, len) { files.set(p, Buffer.concat([files.get(p), Buffer.from(buf.subarray(off, off + len))])); return { bytesWritten: len }; }, async close() { h.closed = true; } };
        handles.push(h);
        return h;
      },
      async unlink(p) { if (!files.delete(p)) throw new Error('ENOENT'); },
      async rename(a, b) { files.set(b, files.get(a)); files.delete(a); },
      async stat(p) { if (!files.has(p)) throw new Error('ENOENT'); return { size: files.get(p).length }; },
    },
    createReadStream: (p) => Readable.from([files.get(p)]),
  };
  return fs;
}

/** A fetch Response whose body yields [chunks]. hooks.pauseAt: the read at that index waits for hooks.gate. */
function resp(status, { headers = {}, chunks = [], hooks = {} } = {}) {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  let i = 0;
  const body = {
    cancelled: false,
    getReader: () => ({
      async read() {
        if (hooks.pauseAt === i) { hooks.onPause?.(); await hooks.gate; }
        if (i >= chunks.length) return { done: true };
        return { done: false, value: chunks[i++] };
      },
      async cancel() { body.cancelled = true; },
    }),
    async cancel() { body.cancelled = true; },
  };
  return { status, ok: status >= 200 && status < 300, headers: { get: (k) => h[k.toLowerCase()] ?? null }, body };
}

function setup({ routes, content, size, digestOf, exe = INSTALLED_EXE, spawnImpl, platform = 'win32', idleMs } = {}) {
  const fs = fakeFs(); fs.dirMade = true;
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    const r = routes[url];
    if (!r) throw new Error('unexpected request ' + url);
    return typeof r === 'function' ? r(opts) : r;
  };
  const spawned = [];
  const spawn = spawnImpl || ((file, args, opts) => {
    const c = new EventEmitter(); c.unref = () => { c.unrefd = true; };
    spawned.push({ file, args, opts, child: c });
    setImmediate(() => c.emit('spawn'));
    return c;
  });
  let quits = 0;
  const u = new Updater({ fetchImpl, fs, spawn, tempDir: TEMP, execPath: exe, localAppData: LOCAL, platform, quit: () => { quits++; }, idleMs });
  const states = [];
  u.on('changed', (s) => states.push({ ...s }));
  const checker = {
    status: 'available', latest: '2.1.0',
    installer: { name: 'GlidrScreen-2.1.0-setup.exe', url: URL0, size: size ?? content?.length, digest: 'sha256:' + (digestOf ?? sha(content || Buffer.alloc(0))) },
  };
  return { u, fs, calls, spawned, states, checker, quits: () => quits };
}

const chunked = (buf, n) => { const out = []; for (let i = 0; i < buf.length; i += n) out.push(new Uint8Array(buf.subarray(i, i + n))); return out; };
const FINAL = path.join(TEMP, 'GlidrScreenUpdate', 'GlidrScreen-2.1.0-setup.exe');

(async () => {
  const content = crypto.randomBytes(5000);
  const okRoutes = (extra = {}) => ({
    [URL0]: resp(302, { headers: { location: CDN } }),
    [CDN]: resp(200, { headers: { 'content-length': String(content.length) }, chunks: chunked(content, 700) }),
    ...extra,
  });

  // canInstall: only a copy under %LOCALAPPDATA%\Programs
  for (const [exe, want] of [
    [INSTALLED_EXE, true], [`${LOCAL}\\programs\\x\\GlidrScreen.exe`, true], ['C:\\Users\\me\\Downloads\\GlidrScreen\\GlidrScreen.exe', false],
    [`${LOCAL}\\Programs\\..\\Evil\\GlidrScreen.exe`, false], [`${LOCAL}\\ProgramsEvil\\GlidrScreen.exe`, false], [`${LOCAL}\\Programs`, false],
    ['C:\\Program Files\\Glidr\\GlidrScreen.exe', false], ['', false],
  ]) assert.strictEqual(setup({ routes: {}, content, exe }).u.canInstall(), want, exe);
  assert.strictEqual(setup({ routes: {}, content, platform: 'linux' }).u.canInstall(), false);

  // happy path, with a redirect from github.com to the CDN and progress
  {
    const t = setup({ routes: okRoutes(), content });
    const s = await t.u.download(t.checker);
    assert.strictEqual(s.status, 'ready');
    assert.deepStrictEqual(t.calls.map((c) => c.url), [URL0, CDN]);
    assert.ok(t.calls.every((c) => c.opts.redirect === 'manual' && !c.opts.headers.Authorization));
    assert.ok(t.fs.files.get(FINAL).equals(content), 'verified file in place');
    assert.ok(![...t.fs.files.keys()].some((k) => k.endsWith('.part')), 'no .part left');
    const pcts = t.states.filter((x) => x.status === 'downloading').map((x) => x.percent);
    assert.ok(pcts.length >= 3 && pcts.every((p, i) => i === 0 || p >= pcts[i - 1]), 'progress callbacks climb: ' + pcts);
    assert.strictEqual(t.states.at(-1).percent, 100);
    assert.ok(t.fs.handles.every((h) => h.closed));
    // the renderer view carries no address, path or digest
    const v = t.u.view(t.checker);
    assert.deepStrictEqual(Object.keys(v).sort(), ['error', 'mode', 'percent', 'retry', 'status', 'version']);
    assert.strictEqual(v.mode, 'install'); assert.strictEqual(v.status, 'ready');
    assert.ok(!JSON.stringify(v).includes('github') && !JSON.stringify(v).includes('Temp'));

    // install: re-verifies, spawns detached with /S, then quits
    assert.strictEqual(await t.u.install(), true);
    assert.strictEqual(t.spawned.length, 1);
    assert.strictEqual(t.spawned[0].file, FINAL);
    assert.deepStrictEqual(t.spawned[0].args, INSTALL_ARGS);
    assert.strictEqual(t.spawned[0].args[0], '/S');
    assert.strictEqual(t.spawned[0].opts.detached, true);
    assert.strictEqual(t.spawned[0].opts.stdio, 'ignore');
    assert.ok(t.spawned[0].child.unrefd);
    assert.strictEqual(t.quits(), 1);
  }

  // same bytes, another view of the same flow: a portable copy neither downloads nor installs
  {
    const t = setup({ routes: okRoutes(), content, exe: 'C:\\Users\\me\\Downloads\\GlidrScreen\\GlidrScreen.exe' });
    assert.strictEqual(t.u.view(t.checker).mode, 'link');
    const s = await t.u.download(t.checker);
    assert.strictEqual(s.status, 'error'); assert.strictEqual(s.retry, false);
    assert.strictEqual(t.calls.length, 0, 'nothing fetched');
    assert.strictEqual(await t.u.install(), false); assert.strictEqual(t.spawned.length, 0); assert.strictEqual(t.quits(), 0);
  }

  // no digest / malformed digest / bad size: refused before any request
  for (const patch of [{ digest: null }, { digest: 'sha256:xyz' }, { digest: 'sha1:' + 'a'.repeat(40) }, { size: 0 }, { size: MAX_BYTES + 1 }, { url: 'https://evil.com/a-setup.exe' }]) {
    const t = setup({ routes: okRoutes(), content });
    t.checker.installer = { ...t.checker.installer, ...patch };
    assert.strictEqual(t.u.view(t.checker).mode, 'link', JSON.stringify(patch));
    const s = await t.u.download(t.checker);
    assert.strictEqual(s.status, 'error', JSON.stringify(patch)); assert.strictEqual(s.retry, false);
    assert.strictEqual(t.calls.length, 0);
  }
  { // no update, or an unusable version string, to download
    const t = setup({ routes: okRoutes(), content });
    assert.strictEqual((await t.u.download({ ...t.checker, status: 'latest' })).status, 'error');
    assert.strictEqual((await t.u.download({ ...t.checker, latest: '2.1.0\\..\\x' })).status, 'error');
    assert.strictEqual((await t.u.download({ status: 'available', latest: '2.1.0' })).status, 'error');
    assert.strictEqual(t.calls.length, 0);
  }

  // checksum mismatch: file deleted, no retry
  {
    const t = setup({ routes: okRoutes(), content, digestOf: sha(Buffer.from('other')) });
    const s = await t.u.download(t.checker);
    assert.strictEqual(s.status, 'error'); assert.match(s.error, /checksum/); assert.strictEqual(s.retry, false);
    assert.strictEqual(t.fs.files.size, 0, 'nothing left on disk');
    assert.ok(t.fs.handles.every((h) => h.closed));
    assert.strictEqual(await t.u.install(), false); assert.strictEqual(t.spawned.length, 0);
  }

  // right digest, wrong declared size (shorter and longer than the stream)
  for (const size of [content.length - 1, content.length + 1]) {
    const t = setup({ routes: okRoutes({ [CDN]: resp(200, { chunks: chunked(content, 1000) }) }), content, size });
    const s = await t.u.download(t.checker);
    assert.strictEqual(s.status, 'error', 'size ' + size);
    assert.strictEqual(t.fs.files.size, 0);
  }
  { // Content-Length that disagrees with the release
    const t = setup({ routes: okRoutes({ [CDN]: resp(200, { headers: { 'content-length': '999' }, chunks: chunked(content, 1000) }) }), content });
    const s = await t.u.download(t.checker);
    assert.strictEqual(s.status, 'error'); assert.strictEqual(t.fs.files.size, 0);
  }

  // redirects: never to a host that is not allowed
  for (const evil of ['https://evil.example.com/a.exe', 'http://objects.githubusercontent.com/a.exe', 'https://github.com.evil.io/a.exe', 'file:///C:/x.exe', 'https://user@github.com/a']) {
    const t = setup({ routes: { [URL0]: resp(302, { headers: { location: evil } }), [evil]: resp(200, { chunks: chunked(content, 1000) }) }, content });
    const s = await t.u.download(t.checker);
    assert.strictEqual(s.status, 'error', evil);
    assert.deepStrictEqual(t.calls.map((c) => c.url), [URL0], 'the evil address is never requested: ' + evil);
    assert.strictEqual(t.fs.files.size, 0);
  }
  { // a redirect two hops deep that ends on a bad host is stopped too
    const evil = 'https://evil.example.com/a.exe';
    const t = setup({ routes: { [URL0]: resp(302, { headers: { location: CDN } }), [CDN]: resp(307, { headers: { location: evil } }) }, content });
    const s = await t.u.download(t.checker);
    assert.strictEqual(s.status, 'error'); assert.deepStrictEqual(t.calls.map((c) => c.url), [URL0, CDN]);
  }
  { // a loop of redirects ends
    const t = setup({ routes: { [URL0]: resp(302, { headers: { location: URL0 } }) }, content });
    // each call needs a fresh response object (its body is consumed): route by function
    t.u.fetch = async (url, o) => { t.calls.push({ url, o }); return resp(302, { headers: { location: URL0 } }); };
    const s = await t.u.download(t.checker);
    assert.strictEqual(s.status, 'error'); assert.ok(t.calls.length <= 6);
  }
  { // redirect without Location
    const t = setup({ routes: { [URL0]: resp(302) }, content });
    assert.strictEqual((await t.u.download(t.checker)).status, 'error');
  }

  // HTTP error: retryable, nothing on disk
  {
    const t = setup({ routes: { [URL0]: resp(503) }, content });
    const s = await t.u.download(t.checker);
    assert.strictEqual(s.status, 'error'); assert.strictEqual(s.retry, true); assert.match(s.error, /503/);
    assert.strictEqual(t.fs.files.size, 0);
    // "Try again" works: the same updater downloads once the server is back
    t.u.fetch = async (url) => (url === URL0 ? resp(302, { headers: { location: CDN } }) : resp(200, { chunks: chunked(content, 2000) }));
    assert.strictEqual((await t.u.download(t.checker)).status, 'ready');
  }
  { // a network error mid-stream deletes the partial file
    const body = resp(200, { chunks: chunked(content, 1000) });
    let n = 0;
    const orig = body.body.getReader;
    body.body.getReader = () => { const r = orig(); return { read: async () => { if (n++ === 2) throw new Error('socket hang up'); return r.read(); }, cancel: r.cancel }; };
    const t = setup({ routes: okRoutes({ [CDN]: body }), content });
    const s = await t.u.download(t.checker);
    assert.strictEqual(s.status, 'error'); assert.strictEqual(s.retry, true); assert.match(s.error, /socket hang up/);
    assert.strictEqual(t.fs.files.size, 0); assert.ok(t.fs.handles.every((h) => h.closed)); assert.ok(body.body.cancelled);
  }

  // cancel in the middle: partial file removed, state back to idle, nothing installable
  {
    let release, paused;
    const pausedP = new Promise((r) => { paused = r; });
    const gate = new Promise((r) => { release = r; });
    const body = resp(200, { chunks: chunked(content, 1000), hooks: { pauseAt: 2, gate, onPause: paused } });
    const t = setup({ routes: okRoutes({ [CDN]: body }), content });
    const p = t.u.download(t.checker);
    await pausedP;
    assert.strictEqual(t.u.state.status, 'downloading');
    assert.ok(t.fs.files.size >= 1, 'partial file exists while downloading');
    await t.u.cancel();
    const s = await p;
    release();
    assert.strictEqual(s.status, 'idle'); assert.strictEqual(t.fs.files.size, 0);
    assert.strictEqual(await t.u.install(), false); assert.strictEqual(t.spawned.length, 0);
  }

  // stall: no bytes for idleMs
  {
    const body = resp(200, { chunks: chunked(content, 1000), hooks: { pauseAt: 1, gate: new Promise(() => {}) } });
    const t = setup({ routes: okRoutes({ [CDN]: body }), content, idleMs: 40 });
    const s = await t.u.download(t.checker);
    assert.strictEqual(s.status, 'error'); assert.match(s.error, /stalled/); assert.strictEqual(s.retry, true);
    assert.strictEqual(t.fs.files.size, 0);
  }

  // install guards
  {
    const t = setup({ routes: okRoutes(), content });
    assert.strictEqual(await t.u.install(), false, 'nothing downloaded yet');
    await t.u.download(t.checker);
    // the file is swapped on disk between download and click
    t.fs.files.set(FINAL, Buffer.concat([content.subarray(1), Buffer.from([1])]));
    assert.strictEqual(await t.u.install(), false);
    assert.strictEqual(t.spawned.length, 0); assert.strictEqual(t.quits(), 0);
    assert.strictEqual(t.u.state.status, 'error'); assert.strictEqual(t.fs.files.size, 0, 'tampered file removed');
  }
  {
    const t = setup({ routes: okRoutes(), content });
    await t.u.download(t.checker);
    t.fs.files.set(FINAL, content.subarray(1)); // truncated
    assert.strictEqual(await t.u.install(), false); assert.strictEqual(t.spawned.length, 0);
  }
  { // the installer fails to start: no quit
    const t = setup({ routes: okRoutes(), content, spawnImpl: () => { const c = new EventEmitter(); c.unref = () => {}; setImmediate(() => c.emit('error', new Error('EACCES'))); return c; } });
    await t.u.download(t.checker);
    assert.strictEqual(await t.u.install(), false);
    assert.strictEqual(t.quits(), 0); assert.strictEqual(t.u.state.status, 'error'); assert.match(t.u.state.error, /EACCES/);
  }
  { // install only quits once
    const t = setup({ routes: okRoutes(), content });
    await t.u.download(t.checker);
    assert.strictEqual(await t.u.install(), true);
    assert.strictEqual(t.quits(), 1);
  }

  // sync: a newer release (or "up to date") drops the old download
  {
    const t = setup({ routes: okRoutes(), content });
    await t.u.download(t.checker);
    await t.u.sync({ status: 'checking', latest: '2.1.0' });
    assert.strictEqual(t.u.state.status, 'ready', 'a re-check in progress keeps it');
    await t.u.sync({ status: 'available', latest: '2.1.0' });
    assert.strictEqual(t.u.state.status, 'ready');
    await t.u.sync({ status: 'available', latest: '2.2.0' });
    assert.strictEqual(t.u.state.status, 'idle'); assert.strictEqual(t.fs.files.size, 0);
    assert.strictEqual(await t.u.install(), false);
  }
  { // cancel after ready removes the file
    const t = setup({ routes: okRoutes(), content });
    await t.u.download(t.checker);
    await t.u.cancel();
    assert.strictEqual(t.u.state.status, 'idle'); assert.strictEqual(t.fs.files.size, 0);
  }

  // UpdateChecker records the installer asset (name, size, digest) next to the manual download
  {
    const rel = {
      tag_name: 'v2.1.0', html_url: `https://github.com/${REPO}/releases/tag/v2.1.0`,
      assets: [
        { name: 'GlidrScreen-2.1.0.apk', browser_download_url: `https://github.com/${REPO}/releases/download/v2.1.0/GlidrScreen-2.1.0.apk` },
        { name: 'GlidrScreen-2.1.0-win-x64.zip', browser_download_url: `https://github.com/${REPO}/releases/download/v2.1.0/GlidrScreen-2.1.0-win-x64.zip` },
        { name: 'GlidrScreen-2.1.0-setup.exe', size: 77_000_000, digest: 'sha256:' + 'c'.repeat(64), browser_download_url: URL0 },
      ],
    };
    const fake = (body) => async () => ({ status: 200, ok: true, json: async () => body });
    let s = await new UpdateChecker('2.0.0', { fetchImpl: fake(rel) }).check();
    assert.strictEqual(s.status, 'available');
    assert.deepStrictEqual(s.installer, { name: 'GlidrScreen-2.1.0-setup.exe', url: URL0, size: 77_000_000, digest: 'sha256:' + 'c'.repeat(64) });
    assert.ok(s.download.endsWith('win-x64.zip'), 'the zip stays the manual download');
    assert.ok(assessInstaller(s.installer).ok);
    // release without the digest field (older releases): recorded, but not installable
    const noDigest = { ...rel, assets: [{ ...rel.assets[2], digest: undefined }] };
    s = await new UpdateChecker('2.0.0', { fetchImpl: fake(noDigest) }).check();
    assert.strictEqual(s.installer.digest, null); assert.ok(!assessInstaller(s.installer).ok);
    assert.strictEqual(s.download, URL0);
    // no installer at all
    s = await new UpdateChecker('2.0.0', { fetchImpl: fake({ ...rel, assets: [rel.assets[1]] }) }).check();
    assert.strictEqual(s.installer, null);
    // a different repo configured: an asset from github.com/other/... is not trusted
    s = await new UpdateChecker('2.0.0', { repo: 'a/b', fetchImpl: fake(rel) }).check();
    assert.strictEqual(s.installer, null);
  }

  console.log('ok');
})().catch((e) => { console.error(e); process.exit(1); });
