'use strict';
// Phone camera / microphone policy (src/phonemedia.js): what an offer may contain, and the order of the checks.
// No Electron, no peer connection. Run: node host/test/phonemedia.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PhoneMedia, parseOffer, MAX_SDP } = require('../src/phonemedia');
const { Store } = require('../src/store');

// ---------------------------------------------------------------- SDP samples (shape of a libwebrtc re-offer)
const head = 'v=0\r\no=- 4611 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0 1 2 3\r\n';
const sect = {
  screen: (dir = 'recvonly') => `m=video 9 UDP/TLS/RTP/SAVPF 96 97\r\nc=IN IP4 0.0.0.0\r\na=mid:0\r\na=${dir}\r\na=rtpmap:96 H264/90000\r\n`,
  pcAudio: (dir = 'recvonly') => `m=audio 9 UDP/TLS/RTP/SAVPF 111\r\nc=IN IP4 0.0.0.0\r\na=mid:1\r\na=${dir}\r\na=rtpmap:111 opus/48000/2\r\n`,
  data: () => 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\nc=IN IP4 0.0.0.0\r\na=mid:2\r\na=sctp-port:5000\r\n',
  camera: (dir = 'sendonly', port = 9) => `m=video ${port} UDP/TLS/RTP/SAVPF 96\r\nc=IN IP4 0.0.0.0\r\na=mid:3\r\na=${dir}\r\na=rtpmap:96 VP8/90000\r\n`,
  mic: (dir = 'sendonly', port = 9) => `m=audio ${port} UDP/TLS/RTP/SAVPF 111\r\nc=IN IP4 0.0.0.0\r\na=mid:4\r\na=${dir}\r\na=rtpmap:111 opus/48000/2\r\n`,
};
const sdp = (...parts) => head + parts.join('');

// ---------------------------------------------------------------- parseOffer
{
  const both = parseOffer(sdp(sect.screen(), sect.pcAudio(), sect.data(), sect.camera(), sect.mic()));
  assert.deepStrictEqual(both, { ok: true, sending: { video: true, audio: true } });
  assert.deepStrictEqual(parseOffer(sdp(sect.screen(), sect.data(), sect.camera())), { ok: true, sending: { video: true, audio: false } });
  assert.deepStrictEqual(parseOffer(sdp(sect.screen(), sect.data(), sect.mic())), { ok: true, sending: { video: false, audio: true } });
  // the phone stopping: the camera and microphone sections are inactive or rejected (port 0), nothing is sent
  assert.deepStrictEqual(parseOffer(sdp(sect.screen(), sect.data(), sect.camera('inactive'), sect.mic('inactive'))).sending, { video: false, audio: false });
  assert.deepStrictEqual(parseOffer(sdp(sect.screen(), sect.data(), sect.camera('sendonly', 0), sect.mic('sendonly', 0))).sending, { video: false, audio: false });
  // the PC's own sections are recvonly on the phone's side: they are not "the phone sending"
  assert.deepStrictEqual(parseOffer(sdp(sect.screen(), sect.pcAudio(), sect.data())).sending, { video: false, audio: false });
  // a section without any direction line defaults to sendrecv
  assert.strictEqual(parseOffer(head + 'm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nc=IN IP4 0.0.0.0\r\n' + sect.data()).sending.audio, true);
  // LF only line endings are tolerated
  assert.strictEqual(parseOffer(sdp(sect.data(), sect.camera()).replace(/\r\n/g, '\n')).ok, true);
}
{
  const bad = (s) => assert.deepStrictEqual(parseOffer(s), { ok: false, reason: 'bad-sdp' });
  for (const v of [undefined, null, 5, {}, [], '', 'x']) bad(v);
  bad('v=1\r\n' + sect.data()); // not an SDP
  bad(head); // no media at all
  bad(sdp(sect.data(), sect.data())); // a second data section
  bad(sdp(sect.data(), 'm=application 9 UDP/TLS/RTP/SAVPF 96\r\n')); // an "application" section that is not SCTP
  bad(sdp(sect.data(), 'm=text 9 RTP/AVP 98\r\n')); // other kinds
  bad(sdp(sect.data(), 'm=message 9 TCP/MSRP *\r\n'));
  bad(sdp(sect.screen(), sect.data(), sect.camera(), sect.camera())); // two cameras
  bad(sdp(sect.screen(), sect.data(), sect.mic(), sect.mic()));
  bad(sdp(sect.data(), sect.camera('sendrecv'), sect.camera('sendonly'))); // sendrecv counts as sending too
  bad(sdp(...Array(9).fill(sect.screen()))); // too many sections
  bad(sdp(sect.data(), sect.camera()) + '\0'); // control characters
  bad(sdp(sect.data(), sect.camera()) + 'a=é\r\n'); // non ASCII
  bad(sdp(sect.data(), sect.camera()) + 'a=x:' + 'y'.repeat(MAX_SDP)); // over the cap
  assert.strictEqual(parseOffer(sdp(sect.data()) + 'a=x:' + 'y'.repeat(MAX_SDP - 1000)).ok, true); // just under it is fine
  bad(head + 'a=x\r\n'.repeat(2600) + sect.data()); // too many lines
}

// ---------------------------------------------------------------- PhoneMedia
function setup({ allow = true, control = true, timeoutMs = 40 } = {}) {
  const st = { allow, control, sink: 'sink-1' };
  const sent = [];
  const engine = [];
  const windows = [];
  const logs = [];
  const pm = new PhoneMedia({
    allowed: () => st.allow, canControl: () => st.control,
    send: (o) => sent.push(o), engineSend: (c) => engine.push(c),
    getSink: () => st.sink, setSink: (id) => { st.sink = id; }, log: (m) => logs.push(m), timeoutMs,
  });
  pm.on('window', (w) => windows.push(w));
  const s = { sid: 'S1', live: true, name: 'Pixel' };
  return { st, pm, s, sent, engine, windows, logs };
}
const offer = sdp(sect.screen(), sect.data(), sect.camera(), sect.mic());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ---- happy path: offer -> engine -> answer -> tracks -> window
  {
    const t = setup();
    t.pm.onRenegotiate(t.s, { t: 'renegotiate', sdp: offer });
    assert.deepStrictEqual(t.engine, [{ t: 'pm-offer', sid: 'S1', sdp: offer, sink: 'sink-1' }]);
    assert.deepStrictEqual(t.sent, []);
    t.pm.onEngine(t.s, { k: 'answer', sdp: 'v=0 answer' });
    assert.deepStrictEqual(t.sent, [{ t: 'renegotiate-answer', sdp: 'v=0 answer' }]);
    t.pm.onEngine(t.s, { k: 'tracks', video: true, audio: true });
    assert.deepStrictEqual(t.windows, [{ show: true, video: true, audio: true, name: 'Pixel' }]);
    assert.deepStrictEqual(t.pm.view(t.s), { video: true, audio: true, name: 'Pixel' });
    // the phone stops: an offer that sends nothing is answered, then the tracks end and the window goes
    t.pm.onRenegotiate(t.s, { sdp: sdp(sect.screen(), sect.data(), sect.camera('inactive'), sect.mic('inactive')) });
    t.pm.onEngine(t.s, { k: 'answer', sdp: 'v=0 answer2' });
    t.pm.onEngine(t.s, { k: 'tracks', video: false, audio: false });
    assert.deepStrictEqual(t.windows.pop(), { show: false, video: false, audio: false, name: 'Pixel' });
    assert.strictEqual(t.pm.view(t.s), null);
    assert.strictEqual(t.sent.length, 2);
  }
  // ---- 'busy': one at a time; the answer frees it
  {
    const t = setup();
    t.pm.onRenegotiate(t.s, { sdp: offer });
    t.pm.onRenegotiate(t.s, { sdp: offer });
    assert.deepStrictEqual(t.sent, [{ t: 'renegotiate-error', reason: 'busy' }]);
    assert.strictEqual(t.engine.length, 1);
    t.pm.onEngine(t.s, { k: 'answer', sdp: 'a' });
    t.pm.onRenegotiate(t.s, { sdp: offer });
    assert.strictEqual(t.engine.length, 2);
  }
  // ---- 'disabled': setting off, control off, view-only phone; checked before anything goes to the engine
  for (const cfg of [{ allow: false }, { control: false }]) {
    const t = setup(cfg);
    t.pm.onRenegotiate(t.s, { sdp: offer });
    assert.deepStrictEqual(t.sent, [{ t: 'renegotiate-error', reason: 'disabled' }]);
    assert.deepStrictEqual(t.engine, []);
    // ...but an offer that sends nothing is answered, so the phone is never left half-way
    t.pm.onRenegotiate(t.s, { sdp: sdp(sect.screen(), sect.data(), sect.camera('inactive')) });
    assert.strictEqual(t.engine.length, 1);
  }
  // ---- 'bad-sdp' wins over nothing else sensitive; never reaches the engine, never logged
  {
    const t = setup();
    for (const m of [{}, { sdp: 5 }, { sdp: 'v=0\r\nm=text 9 RTP/AVP 98\r\n' }, { sdp: sdp(sect.data(), sect.data()) }, { sdp: 'v=0' + 'x'.repeat(MAX_SDP) }]) t.pm.onRenegotiate(t.s, m);
    assert.deepStrictEqual(t.sent.map((o) => o.reason), ['bad-sdp', 'bad-sdp', 'bad-sdp', 'bad-sdp', 'bad-sdp']);
    assert.deepStrictEqual(t.engine, []);
    assert.deepStrictEqual(t.logs, []);
    // a bad offer does not leave the state busy
    t.pm.onRenegotiate(t.s, { sdp: offer });
    assert.strictEqual(t.engine.length, 1);
  }
  // ---- not live / no session: ignored
  {
    const t = setup();
    t.pm.onRenegotiate({ ...t.s, live: false }, { sdp: offer });
    t.pm.onRenegotiate(null, { sdp: offer });
    assert.deepStrictEqual([t.sent, t.engine], [[], []]);
  }
  // ---- engine errors are mapped; unknown ones become 'failed'; an oversized answer is not sent
  {
    const t = setup();
    t.pm.onRenegotiate(t.s, { sdp: offer });
    t.pm.onEngine(t.s, { k: 'error', reason: 'bad-sdp', message: 'could not apply' });
    t.pm.onRenegotiate(t.s, { sdp: offer });
    t.pm.onEngine(t.s, { k: 'error', reason: 'something', message: 'x' });
    t.pm.onRenegotiate(t.s, { sdp: offer });
    t.pm.onEngine(t.s, { k: 'answer', sdp: 'a'.repeat(MAX_SDP + 1) });
    t.pm.onRenegotiate(t.s, { sdp: offer });
    t.pm.onEngine(t.s, { k: 'answer', sdp: '' });
    assert.deepStrictEqual(t.sent.map((o) => o.reason), ['bad-sdp', 'failed', 'failed', 'failed']);
    // answers and errors nobody asked for are ignored
    t.pm.onEngine(t.s, { k: 'answer', sdp: 'late' });
    t.pm.onEngine(t.s, { k: 'error', reason: 'busy' });
    assert.strictEqual(t.sent.length, 4);
  }
  // ---- the engine never answers: 'failed' after the timeout, and the next offer is accepted
  {
    const t = setup({ timeoutMs: 30 });
    t.pm.onRenegotiate(t.s, { sdp: offer });
    await sleep(80);
    assert.deepStrictEqual(t.sent, [{ t: 'renegotiate-error', reason: 'failed' }]);
    t.pm.onRenegotiate(t.s, { sdp: offer });
    assert.strictEqual(t.engine.length, 2);
    t.pm.end(t.s); // clears the timer: no late error
    await sleep(80);
    assert.strictEqual(t.sent.length, 1);
  }
  // ---- Stop in the camera window: the engine drops it, the phone is asked to stop, the window hides
  {
    const t = setup();
    t.pm.onEngine(t.s, { k: 'tracks', video: true, audio: false });
    t.pm.onEngine(t.s, { k: 'stop' });
    assert.deepStrictEqual(t.engine.pop(), { t: 'pm-drop', sid: 'S1' });
    assert.deepStrictEqual(t.sent.pop(), { t: 'media-stop', reason: 'pc' });
    assert.strictEqual(t.windows.pop().show, false);
    // closing the window by its title bar is the same
    t.pm.onEngine(t.s, { k: 'tracks', video: true, audio: true });
    t.pm.windowClosed(t.s);
    assert.deepStrictEqual(t.sent.pop(), { t: 'media-stop', reason: 'pc' });
    // ...and does nothing when nothing is showing
    t.sent.length = 0;
    t.pm.windowClosed(t.s);
    assert.deepStrictEqual(t.sent, []);
  }
  // ---- the owner switches the feature off while the camera runs
  {
    const t = setup();
    t.pm.onEngine(t.s, { k: 'tracks', video: true, audio: true });
    t.pm.recheck(t.s); // still allowed: nothing happens
    assert.deepStrictEqual(t.sent, []);
    t.st.allow = false;
    t.pm.recheck(t.s);
    assert.deepStrictEqual(t.engine.pop(), { t: 'pm-drop', sid: 'S1' });
    assert.deepStrictEqual(t.sent.pop(), { t: 'media-stop', reason: 'disabled' });
    assert.strictEqual(t.windows.pop().show, false);
    t.pm.recheck(t.s); // nothing is showing any more
    assert.strictEqual(t.sent.length, 0);
    // the phone made it view only
    t.st.allow = true; t.pm.onEngine(t.s, { k: 'tracks', video: true, audio: false });
    t.st.control = false;
    t.pm.recheck(t.s);
    assert.strictEqual(t.sent.pop().reason, 'disabled');
  }
  // ---- tracks that arrive after the feature was switched off (renegotiation in flight) are dropped at once
  {
    const t = setup();
    t.pm.onRenegotiate(t.s, { sdp: offer });
    t.st.allow = false;
    t.pm.onEngine(t.s, { k: 'answer', sdp: 'a' });
    t.pm.onEngine(t.s, { k: 'tracks', video: true, audio: true });
    assert.deepStrictEqual(t.sent.pop(), { t: 'media-stop', reason: 'disabled' });
    assert.deepStrictEqual(t.windows, []); // it never showed
  }
  // ---- the output chosen in the window is remembered; junk is not
  {
    const t = setup();
    t.pm.onEngine(t.s, { k: 'sink', id: 'cable-9' });
    assert.strictEqual(t.st.sink, 'cable-9');
    t.pm.onEngine(t.s, { k: 'sink', id: 5 });
    t.pm.onEngine(t.s, { k: 'sink', id: 'x'.repeat(301) });
    assert.strictEqual(t.st.sink, 'cable-9');
  }
  // ---- session end hides the window once
  {
    const t = setup();
    t.pm.onEngine(t.s, { k: 'tracks', video: true, audio: false });
    t.pm.end(t.s);
    t.pm.end(t.s);
    assert.deepStrictEqual(t.windows.map((w) => w.show), [true, false]);
    t.pm.end({ sid: 'other' }); // a session that never used the feature
  }

  // ---------------------------------------------------------------- the setting
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glidr-pm-'));
    const a = new Store(dir, { safeStorage: null });
    assert.strictEqual(a.get('allowPhoneMedia'), false); // off by default
    assert.strictEqual(a.get('phoneMediaSink'), '');
    a.set({ allowPhoneMedia: true, phoneMediaSink: 'cable' });
    const b = new Store(dir, { safeStorage: null });
    assert.deepStrictEqual([b.get('allowPhoneMedia'), b.get('phoneMediaSink')], [true, 'cable']);
    // a hand-edited file cannot switch it on with a truthy non-boolean or break the sink
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ allowPhoneMedia: 'yes', phoneMediaSink: { a: 1 } }));
    const c = new Store(dir, { safeStorage: null });
    assert.deepStrictEqual([c.get('allowPhoneMedia'), c.get('phoneMediaSink')], [false, '']);
  }
  console.log('ok');
})().catch((e) => { console.error(e); process.exit(1); });
