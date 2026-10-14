'use strict';
// `npm run selftest`: plays the phone's part against the real host. Uses the real rendezvous (needs internet),
// real screen capture, real WebRTC and the real input injector. Prints a report and returns an exit code.
const crypto = require('crypto');
const { BrowserWindow } = require('electron');
const { Signaling } = require('./signaling');
const { InputInjector } = require('./input');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitFor(emitter, event, pred, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { emitter.off(event, on); reject(new Error('timeout: ' + label)); }, ms);
    const on = (v) => { if (!pred || pred(v)) { clearTimeout(t); emitter.off(event, on); resolve(v); } };
    emitter.on(event, on);
  });
}

async function run({ store, core, engine, input, displays }) {
  const report = { checks: {}, info: {} };
  const ok = (name, pass, detail) => { report.checks[name] = pass; console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); };
  let anim;
  try {
    // A moving window so the screen content really changes (static screens legitimately produce few frames).
    anim = new BrowserWindow({ x: 40, y: 40, width: 480, height: 320, frame: false, alwaysOnTop: true, focusable: false, show: true, skipTaskbar: true });
    await anim.loadURL('data:text/html,' + encodeURIComponent(
      '<body style="margin:0;background:#123"><canvas id=c width=480 height=320></canvas><script>const g=c.getContext("2d");let t=0;(function f(){t++;g.fillStyle="hsl("+(t*3%360)+",70%,40%)";g.fillRect(0,0,480,320);g.fillStyle="#fff";g.font="40px sans-serif";g.fillText("Glidr "+t,40+(t*4)%300,160);requestAnimationFrame(f)})()</script></body>'));

    const slot = store.createSlot();
    core.start();
    await waitFor(core.sig, 'status', (s) => s === 'online', 20000, 'host signaling online').catch(() => {});
    ok('host signaling online', core.sigStatus === 'online');

    const phone = new Signaling(store.get('signalBase'));
    phone.setSlots([slot]);
    phone.start();
    await waitFor(phone, 'status', (s) => s === 'online', 20000, 'phone signaling online');

    const sid = crypto.randomBytes(8).toString('hex');
    const gotOffer = waitFor(phone, 'message', (m) => m.msg.from === 'h' && m.msg.t === 'offer' && m.msg.sid === sid, 30000, 'offer');
    await phone.publish(slot.key, { t: 'req', from: 'p', sid, n: 'SelfTest Phone', ts: Date.now() });
    const offer = (await gotOffer).msg;
    ok('request -> offer over signaling', true, `sdp ${offer.sdp.length} chars`);
    report.info.codecsInOffer = [...offer.sdp.matchAll(/a=rtpmap:\d+ ([A-Za-z0-9]+)\/90000/g)].map((m) => m[1]);
    report.info.candidates = [...offer.sdp.matchAll(/a=candidate:\S+ \d+ udp \d+ (\S+) \d+ typ (\w+)/g)].map((m) => `${m[2]} ${m[1]}`);
    console.log('offer codecs', report.info.codecsInOffer.join(','), '| candidates', report.info.candidates.join(' ; '));

    const gotAnswer = waitFor(engine, 'evt', (e) => e.t === 'v-answer', 20000, 'viewer answer');
    const helloP = new Promise((resolve) => {
      const on = (e) => { if (e.t === 'v-ctl' && JSON.parse(e.data).t === 'hello') { engine.off('evt', on); resolve(JSON.parse(e.data)); } };
      engine.on('evt', on);
    });
    engine.send({ t: 'v-start', sdp: offer.sdp, iceServers: [{ urls: store.get('stun') }] });
    const answer = await gotAnswer;
    await phone.publish(slot.key, { t: 'answer', from: 'p', sid, ts: Date.now(), sdp: answer.sdp });
    const hello = await Promise.race([helloP, sleep(25000).then(() => null)]);
    ok('WebRTC connected, data channel hello', !!hello, hello ? `monitors=${hello.monitors.length} active=${hello.active}` : '');
    if (!hello) throw new Error('no hello');

    const vsend = (o) => engine.send({ t: 'v-send', data: JSON.stringify(o) });
    const vctl = (pred, ms, label) => waitFor(engine, 'evt', (e) => e.t === 'v-ctl' && pred(JSON.parse(e.data)), ms, label).then((e) => JSON.parse(e.data));

    // ping
    const pong = vctl((m) => m.t === 'pong', 5000, 'pong');
    vsend({ t: 'ping', n: 7, ts: Date.now() });
    ok('ping/pong', (await pong).n === 7);

    // video: let it settle, then sample frames over 8 s
    await sleep(2500);
    const sample = async () => { engine.send({ t: 'v-stats' }); return (await waitFor(engine, 'evt', (e) => e.t === 'v-stats', 5000, 'v-stats')); };
    const a = await sample();
    const t0 = Date.now();
    await sleep(8000);
    const b = await sample();
    const fps = (b.frames - a.frames) / ((Date.now() - t0) / 1000);
    report.info.video = { w: b.w, h: b.h, codec: b.codec, decoder: b.decoder, fps: +fps.toFixed(1), blank: b.blank };
    console.log('video', JSON.stringify(report.info.video), 'host stats', JSON.stringify(core.stats));
    ok('video decoded > 15 fps', fps > 15, fps.toFixed(1) + ' fps');
    ok('video is not blank', !!b.blank && b.blank.range > 30, JSON.stringify(b.blank));

    // thumbnails of every monitor
    vsend({ t: 'thumbs', on: true });
    const thumb = await vctl((m) => m.t === 'thumb', 8000, 'thumb');
    ok('monitor thumbnails', thumb.jpg.length > 500, `${thumb.w}x${thumb.h}, ${Math.round(thumb.jpg.length / 1024)} KB b64`);
    vsend({ t: 'thumbs', on: false });

    // monitor switch (only meaningful with 2+ displays)
    const list = displays.list();
    report.info.monitors = list.map((d) => `${d.name} ${d.w}x${d.h}@${d.x},${d.y}`);
    if (list.length > 1) {
      const other = list.find((d) => d.id !== hello.active);
      const active = vctl((m) => m.t === 'active', 15000, 'active');
      vsend({ t: 'monitor', id: other.id });
      const act = await active;
      ok('monitor switch', act.id === other.id, `${act.w}x${act.h}`);
      vsend({ t: 'monitor', id: hello.active });
      await vctl((m) => m.t === 'active', 15000, 'active back');
    } else {
      console.log('SKIP  monitor switch (one display attached)');
    }

    // remote mouse (moves the real cursor a few pixels and back). Start from the middle of the shared display: from
    // wherever the user left the cursor (an edge, another monitor) the move is legitimately clamped.
    const home = InputInjector.cursorPos();
    const shared = list.find((d) => d.id === hello.active) || list[0];
    input.moveTo(shared.x + shared.w / 2, shared.y + shared.h / 2);
    await sleep(100);
    const start = InputInjector.cursorPos();
    vsend({ t: 'mv', dx: 30, dy: 20 });
    await sleep(500);
    const moved = InputInjector.cursorPos();
    ok('remote mouse move', Math.abs(moved.x - (start.x + 30)) <= 1 && Math.abs(moved.y - (start.y + 20)) <= 1, `${start.x},${start.y} -> ${moved.x},${moved.y}`);
    input.moveTo(home.x, home.y);

    // quality preset change must not break the stream
    vsend({ t: 'quality', p: 'low' });
    await sleep(2500);
    const c = await sample();
    ok('quality switch keeps decoding', c.frames > b.frames, `${c.w}x${c.h}`);

    const bye = waitFor(phone, 'message', (m) => m.msg.t === 'bye', 8000, 'bye').catch(() => null);
    core.endSession('selftest done', true);
    ok('session teardown', core.snapshot().status === 'waiting');
    await bye;
    engine.send({ t: 'v-stop' });
    phone.stop();
  } catch (e) {
    console.error('SELFTEST ERROR', e);
    report.checks.error = false;
  } finally {
    anim?.destroy();
  }
  const failed = Object.entries(report.checks).filter(([, v]) => !v);
  console.log(failed.length ? `\nFAILED: ${failed.map(([k]) => k).join(', ')}` : '\nALL PASSED');
  console.log(JSON.stringify(report.info, null, 2));
  return failed.length ? 1 : 0;
}

module.exports = { run };
