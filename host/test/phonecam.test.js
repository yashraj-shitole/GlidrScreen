'use strict';
// The engine page's phone camera panel (renderer/phonecam.js) with a fake peer connection and fake elements:
// which transceivers count, answer / error reporting, tracks and window title, Stop / mute / mirror / output selection.
// Run: node host/test/phonecam.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { create } = require('../renderer/phonecam');

// ---------------------------------------------------------------- fakes
class El {
  constructor(tag = 'div') {
    this.tag = tag; this.hidden = false; this.srcObject = null; this.muted = false; this.value = ''; this.textContent = '';
    this.children = []; this.attrs = {}; this.handlers = {}; this.classes = new Set(); this.sinkCalls = [];
    this.classList = { contains: (c) => this.classes.has(c), toggle: (c, on) => { if (on) this.classes.add(c); else this.classes.delete(c); } };
  }
  addEventListener(n, f) { this.handlers[n] = f; }
  click() { this.handlers.click(); }
  setAttribute(k, v) { this.attrs[k] = v; }
  appendChild(c) { this.children.push(c); }
  play() { return Promise.resolve(); }
}
function page() {
  const ids = ['phonecam', 'pcVideo', 'pcAudio', 'pcSink', 'pcMute', 'pcMirror', 'pcStop', 'pcTitle', 'pcNote'];
  const els = Object.fromEntries(ids.map((i) => [i, new El(i)]));
  els.phonecam.hidden = true;
  Object.defineProperty(els.pcSink, 'textContent', {
    get() { return ''; }, set() { els.pcSink.children = []; },
  });
  els.pcAudio.setSinkId = async function (id) { this.sinkCalls.push(id); if (id === 'gone') throw new Error('NotFoundError'); };
  return { els, doc: { title: 'Glidr Screen engine', createElement: (t) => new El(t) } };
}
const track = (kind, state = 'live') => ({ kind, readyState: state });
const tr = (kind, dir, withSender) => ({ currentDirection: dir, sender: { track: withSender ? track(kind) : null }, receiver: { track: track(kind) } });

function fakePc(initial) {
  const pc = {
    signalingState: 'stable', iceGatheringState: 'complete', localDescription: null, trs: [...initial], log: [],
    getTransceivers() { return this.trs; },
    addEventListener() {}, removeEventListener() {},
    async setRemoteDescription(d) { if (/BAD/.test(d.sdp)) throw new Error('Failed to parse'); this.log.push(['remote', d.type]); this.signalingState = 'have-remote-offer'; },
    async createAnswer() { return { type: 'answer', sdp: 'v=0 answer' }; },
    async setLocalDescription(d) {
      if (d.type === 'rollback') { this.log.push(['rollback']); this.signalingState = 'stable'; return; }
      if (this.failLocal) throw new Error('local failed');
      this.localDescription = d; this.signalingState = 'stable';
    },
  };
  return pc;
}

function rig() {
  const p = page();
  const events = [];
  const cam = create({
    $: (id) => p.els[id], doc: p.doc, emit: (m) => events.push(m), makeStream: (tracks) => ({ tracks }),
    devices: async () => [
      { kind: 'audiooutput', deviceId: 'default', label: 'Default' }, { kind: 'audiooutput', deviceId: 'cable', label: 'CABLE Input' },
      { kind: 'audiooutput', deviceId: 'spk', label: '' }, { kind: 'videoinput', deviceId: 'cam', label: 'Camera' },
    ],
  });
  return { p, events, cam, ev: (k) => events.filter((e) => e.k === k) };
}

(async () => {
  // ---- the PC's own transceivers (screen video, PC audio) are never shown; the phone's are
  {
    const { cam, p, events } = rig();
    const screen = tr('video', 'sendonly', true);
    const pcAudio = tr('audio', 'sendonly', true);
    const pc = fakePc([screen, pcAudio]);
    cam.attach(pc, 'S1');
    assert.deepStrictEqual(cam.incoming(), { video: null, audio: null });
    pc.trs.push(tr('video', 'recvonly', false), tr('audio', 'recvonly', false));
    const n = cam.incoming();
    assert.ok(n.video && n.audio);
    // renegotiation: answer reported (before tracks), picture and sound appear, the window title says what it is
    await cam.handle({ t: 'pm-offer', sid: 'S1', sdp: 'v=0 offer', sink: 'cable' });
    assert.deepStrictEqual(events[0], { t: 'pm', sid: 'S1', k: 'answer', sdp: 'v=0 answer' });
    assert.deepStrictEqual(events[1], { t: 'pm', sid: 'S1', k: 'tracks', video: true, audio: true });
    assert.strictEqual(p.els.phonecam.hidden, false);
    assert.strictEqual(p.els.pcVideo.hidden, false);
    assert.strictEqual(p.els.pcTitle.textContent, 'Phone camera');
    assert.strictEqual(p.doc.title, 'Glidr Screen: phone camera');
    assert.deepStrictEqual(p.els.pcVideo.srcObject.tracks.map((t) => t.kind), ['video']);
    assert.deepStrictEqual(p.els.pcAudio.srcObject.tracks.map((t) => t.kind), ['audio']);
    assert.strictEqual(p.els.pcAudio.sinkCalls.pop(), 'cable'); // the remembered output is used
    // the phone stops: its transceivers go inactive, the panel empties and reports it, the title comes back
    pc.trs[2].currentDirection = 'inactive'; pc.trs[3].currentDirection = 'stopped';
    await cam.handle({ t: 'pm-offer', sid: 'S1', sdp: 'v=0 offer2' });
    assert.deepStrictEqual(events.pop(), { t: 'pm', sid: 'S1', k: 'tracks', video: false, audio: false });
    assert.strictEqual(p.els.phonecam.hidden, true);
    assert.strictEqual(p.doc.title, 'Glidr Screen engine');
    assert.strictEqual(p.els.pcVideo.srcObject, null);
  }
  // ---- microphone only: labelled as such, no picture
  {
    const { cam, p } = rig();
    const pc = fakePc([tr('video', 'sendonly', true)]);
    cam.attach(pc, 'S1');
    pc.trs.push(tr('audio', 'recvonly', false));
    await cam.handle({ t: 'pm-offer', sid: 'S1', sdp: 'v=0 offer' });
    assert.strictEqual(p.els.pcTitle.textContent, 'Phone microphone');
    assert.strictEqual(p.els.pcVideo.hidden, true);
    assert.strictEqual(p.els.phonecam.hidden, false);
  }
  // ---- a track that already ended does not count
  {
    const { cam } = rig();
    const pc = fakePc([]);
    cam.attach(pc, 'S1');
    const dead = tr('video', 'recvonly', false); dead.receiver.track.readyState = 'ended';
    pc.trs.push(dead);
    assert.deepStrictEqual(cam.incoming(), { video: null, audio: null });
  }
  // ---- errors: unparsable offer -> 'bad-sdp'; busy; a failing answer rolls back
  {
    const { cam, ev } = rig();
    const pc = fakePc([]);
    cam.attach(pc, 'S1');
    await cam.handle({ t: 'pm-offer', sid: 'S1', sdp: 'BAD' });
    assert.strictEqual(ev('error')[0].reason, 'bad-sdp');
    pc.signalingState = 'have-local-offer';
    await cam.handle({ t: 'pm-offer', sid: 'S1', sdp: 'v=0' });
    assert.strictEqual(ev('error')[1].reason, 'busy');
    pc.signalingState = 'stable'; pc.failLocal = true;
    await cam.handle({ t: 'pm-offer', sid: 'S1', sdp: 'v=0' });
    assert.strictEqual(ev('error')[2].reason, 'failed');
    assert.deepStrictEqual(pc.log.pop(), ['rollback']);
    assert.strictEqual(pc.signalingState, 'stable');
    // an offer for another session is ignored
    const n = ev('error').length + ev('answer').length;
    await cam.handle({ t: 'pm-offer', sid: 'OTHER', sdp: 'v=0' });
    assert.strictEqual(ev('error').length + ev('answer').length, n);
  }
  // ---- Stop, drop, mute, mirror, output
  {
    const { cam, p, events } = rig();
    const pc = fakePc([]);
    cam.attach(pc, 'S1');
    cam.bind();
    await new Promise((r) => setImmediate(r));
    // the list: system default first, then the real outputs (the "default" alias is not repeated), labels fall back to a number
    assert.deepStrictEqual(p.els.pcSink.children.map((o) => [o.value, o.textContent]), [['', 'System default'], ['cable', 'CABLE Input'], ['spk', 'Audio output 2']]);
    pc.trs.push(tr('video', 'recvonly', false));
    await cam.handle({ t: 'pm-offer', sid: 'S1', sdp: 'v=0' });
    events.length = 0;
    p.els.pcMute.click();
    assert.deepStrictEqual([p.els.pcAudio.muted, p.els.pcMute.textContent], [true, 'Unmute']);
    p.els.pcMute.click();
    assert.strictEqual(p.els.pcAudio.muted, false);
    p.els.pcMirror.click();
    assert.strictEqual(p.els.pcVideo.classList.contains('mirrored'), true);
    p.els.pcMirror.click();
    assert.strictEqual(p.els.pcVideo.classList.contains('mirrored'), false);
    p.els.pcSink.value = 'cable';
    p.els.pcSink.handlers.change();
    assert.deepStrictEqual(events.pop(), { t: 'pm', sid: 'S1', k: 'sink', id: 'cable' });
    p.els.pcStop.click();
    assert.deepStrictEqual(events.slice(-2), [
      { t: 'pm', sid: 'S1', k: 'tracks', video: false, audio: false }, { t: 'pm', sid: 'S1', k: 'stop' },
    ]);
    assert.strictEqual(p.els.phonecam.hidden, true);
    // the host dropping it (feature switched off) also empties the panel, and a later offer shows it again
    await cam.handle({ t: 'pm-offer', sid: 'S1', sdp: 'v=0' });
    assert.strictEqual(p.els.phonecam.hidden, false);
    await cam.handle({ t: 'pm-drop', sid: 'S1' });
    assert.strictEqual(p.els.phonecam.hidden, true);
  }
  // ---- an output that disappeared falls back to the default and says so
  {
    const { cam, p } = rig();
    const pc = fakePc([]);
    cam.attach(pc, 'S1');
    pc.trs.push(tr('audio', 'recvonly', false));
    await cam.handle({ t: 'pm-offer', sid: 'S1', sdp: 'v=0', sink: 'gone' });
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(p.els.pcAudio.sinkCalls, ['gone', '']);
    assert.strictEqual(p.els.pcSink.value, '');
  }
  // ---- the session ends: panel hidden, nothing more is accepted
  {
    const { cam, p, events } = rig();
    const pc = fakePc([]);
    cam.attach(pc, 'S1');
    pc.trs.push(tr('video', 'recvonly', false));
    await cam.handle({ t: 'pm-offer', sid: 'S1', sdp: 'v=0' });
    cam.detach();
    assert.strictEqual(p.els.phonecam.hidden, true);
    assert.strictEqual(events.pop().sid, 'S1'); // reported against the session that is ending
    const n = events.length;
    await cam.handle({ t: 'pm-offer', sid: 'S1', sdp: 'v=0' });
    assert.strictEqual(events.length, n);
  }

  // ---------------------------------------------------------------- the page itself
  {
    const dir = path.join(__dirname, '..', 'renderer');
    const html = fs.readFileSync(path.join(dir, 'engine.html'), 'utf8');
    const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html)[1];
    assert.ok(/default-src 'none'/.test(csp) && /script-src 'self'/.test(csp) && /style-src 'self'/.test(csp));
    assert.ok(!/unsafe-inline|unsafe-eval|https?:/.test(csp), 'strict CSP');
    assert.ok(!/<style|style="/.test(html), 'no inline styles under that CSP');
    assert.ok(/<script src="phonecam\.js"><\/script><script src="\.\.\/src\/adaptation\.js"><\/script><script src="engine\.js">/.test(html), 'phonecam.js loads before engine.js');
    for (const id of ['phonecam', 'pcVideo', 'pcAudio', 'pcSink', 'pcMute', 'pcMirror', 'pcStop', 'pcTitle', 'pcNote']) assert.ok(html.includes(`id="${id}"`), id);
    assert.ok(/id="phonecam" hidden/.test(html), 'hidden until the phone sends');
    assert.ok(/>Phone camera</.test(html));
    // the preload still exposes nothing but the two bridge functions
    const pre = fs.readFileSync(path.join(dir, 'engine-preload.js'), 'utf8');
    assert.deepStrictEqual((pre.match(/^\s+(\w+):/gm) || []).map((s) => s.trim()), ['onCmd:', 'emit:']);
    // engine.js keeps to the three hooks
    const eng = fs.readFileSync(path.join(dir, 'engine.js'), 'utf8');
    assert.strictEqual((eng.match(/PhoneCam\./g) || []).length, 3);
  }
  console.log('ok');
})().catch((e) => { console.error(e); process.exit(1); });
