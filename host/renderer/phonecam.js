'use strict';
// The phone's camera and microphone, inside the engine window (see src/phonemedia.js and docs/PROTOCOL.md).
//
// A MediaStream cannot cross from one Electron window to another, and the engine renderer owns the peer connection, so
// the picture is shown right here: engine.html holds a hidden #phonecam panel; the main process shows the engine window
// (titled "Glidr Screen: phone camera") while tracks arrive and hides it again when they end. Capture permission is not
// involved: nothing on the PC is captured, the tracks come from the phone.
//
// engine.js only calls four things: attach(pc, sid) after it built the connection, detach() when it closes it, and
// handle(cmd) for the `pm-offer` / `pm-drop` commands. Everything the page tells the host goes out as {t:'pm', sid, k, ...}.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.PhoneCam = api.create({
      $: (id) => document.getElementById(id), doc: document, emit: (m) => root.engineBridge.emit(m),
      makeStream: (tracks) => new MediaStream(tracks),
      devices: () => navigator.mediaDevices.enumerateDevices(),
      onDevicesChanged: (cb) => navigator.mediaDevices.addEventListener('devicechange', cb),
    });
    root.PhoneCam.bind(); // the script sits at the end of engine.html: the panel exists
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const GATHER_TIMEOUT_MS = 4000;
  const TITLE = 'Glidr Screen: phone camera';

  function create({ $, doc, emit, makeStream, devices, onDevicesChanged, setTimer = setTimeout, clearTimer = clearTimeout }) {
    let pc = null;
    let sid = null;
    let baseline = new Set(); // the transceivers the PC itself made (screen video, optional PC audio): never shown
    let sinkId = '';
    let current = { video: null, audio: null };
    let reported = { video: false, audio: false };
    let normalTitle = null;
    const el = () => ({
      root: $('phonecam'), video: $('pcVideo'), audio: $('pcAudio'), sink: $('pcSink'), mute: $('pcMute'),
      mirror: $('pcMirror'), stop: $('pcStop'), title: $('pcTitle'), note: $('pcNote'),
    });

    const tell = (o) => emit({ t: 'pm', sid, ...o });

    function waitGathered() {
      return new Promise((resolve) => {
        if (pc.iceGatheringState === 'complete') return resolve();
        const p = pc;
        const done = () => { clearTimer(t); p.removeEventListener('icegatheringstatechange', on); resolve(); };
        const on = () => { if (p.iceGatheringState === 'complete') done(); };
        const t = setTimer(done, GATHER_TIMEOUT_MS);
        p.addEventListener('icegatheringstatechange', on);
      });
    }

    /** Live tracks the PHONE sends: transceivers this side did not create whose receiving direction is on. */
    function incoming() {
      const out = { video: null, audio: null };
      if (!pc) return out;
      for (const tr of pc.getTransceivers()) {
        if (baseline.has(tr)) continue;
        const d = tr.currentDirection;
        const t = tr.receiver && tr.receiver.track;
        if ((d !== 'recvonly' && d !== 'sendrecv') || !t || t.readyState !== 'live') continue;
        if (t.kind === 'video' && !out.video) out.video = t;
        if (t.kind === 'audio' && !out.audio) out.audio = t;
      }
      return out;
    }

    function paint() {
      const e = el();
      const v = current.video;
      const a = current.audio;
      const on = !!(v || a);
      e.root.hidden = !on;
      e.video.hidden = !v;
      e.video.srcObject = v ? makeStream([v]) : null;
      e.audio.srcObject = a ? makeStream([a]) : null;
      e.title.textContent = v ? 'Phone camera' : 'Phone microphone';
      e.note.textContent = v ? (a ? 'Camera and microphone are live' : 'Camera is live, no sound') : 'Microphone is live, no picture';
      if (on) {
        const p1 = e.video.play && v ? e.video.play() : null;
        if (p1 && p1.catch) p1.catch(() => {});
        const p2 = e.audio.play && a ? e.audio.play() : null;
        if (p2 && p2.catch) p2.catch(() => {});
        applySink();
        if (normalTitle === null) normalTitle = doc.title;
        doc.title = TITLE;
      } else if (normalTitle !== null) {
        doc.title = normalTitle;
        normalTitle = null;
      }
      if (reported.video !== !!v || reported.audio !== !!a) {
        reported = { video: !!v, audio: !!a };
        tell({ k: 'tracks', video: !!v, audio: !!a });
      }
    }

    /** Re-reads the connection after a renegotiation. */
    function refresh() {
      const n = incoming();
      if (n.video === current.video && n.audio === current.audio) return;
      current = n;
      paint();
    }

    /** Stop showing and playing (the PC owner pressed Stop, switched the feature off, or the session ended). */
    function drop() {
      current = { video: null, audio: null };
      paint();
    }

    async function offer(cmd) {
      if (!pc || (sid && cmd.sid !== sid)) return;
      const p = pc;
      if (typeof cmd.sink === 'string') sinkId = cmd.sink;
      if (p.signalingState !== 'stable') return tell({ k: 'error', reason: 'busy', message: 'signaling state ' + p.signalingState });
      try {
        await p.setRemoteDescription({ type: 'offer', sdp: cmd.sdp });
      } catch (err) {
        return tell({ k: 'error', reason: 'bad-sdp', message: String(err && err.message || err) });
      }
      try {
        await p.setLocalDescription(await p.createAnswer());
        await waitGathered();
        if (pc !== p) return; // the session ended meanwhile
        tell({ k: 'answer', sdp: p.localDescription.sdp });
      } catch (err) {
        try { await p.setLocalDescription({ type: 'rollback' }); } catch { /* nothing to roll back */ }
        return tell({ k: 'error', reason: 'failed', message: String(err && err.message || err) });
      }
      refresh();
    }

    function applySink() {
      const e = el();
      if (typeof e.audio.setSinkId !== 'function') return;
      const want = sinkId || '';
      Promise.resolve(e.audio.setSinkId(want)).catch(() => {
        // the remembered device is gone (unplugged cable): the system default is used, and the choice shows that
        sinkId = '';
        e.sink.value = '';
        return e.audio.setSinkId('').catch(() => {});
      });
    }

    async function listSinks() {
      const e = el();
      let list = [];
      try { list = (await devices()).filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.deviceId !== 'communications'); } catch { /* none */ }
      e.sink.textContent = '';
      const first = doc.createElement('option');
      first.value = ''; first.textContent = 'System default';
      e.sink.appendChild(first);
      list.forEach((d, i) => {
        const o = doc.createElement('option');
        o.value = d.deviceId;
        o.textContent = d.label || 'Audio output ' + (i + 1); // labels can be empty until Windows lets this page read them
        e.sink.appendChild(o);
      });
      e.sink.value = list.some((d) => d.deviceId === sinkId) ? sinkId : '';
    }

    function bind() {
      const e = el();
      e.stop.addEventListener('click', () => { drop(); tell({ k: 'stop' }); });
      e.mute.addEventListener('click', () => {
        e.audio.muted = !e.audio.muted;
        e.mute.textContent = e.audio.muted ? 'Unmute' : 'Mute';
        e.mute.setAttribute('aria-pressed', String(e.audio.muted));
      });
      e.mirror.addEventListener('click', () => {
        const on = !e.video.classList.contains('mirrored');
        e.video.classList.toggle('mirrored', on);
        e.mirror.setAttribute('aria-pressed', String(on));
      });
      e.sink.addEventListener('change', () => {
        sinkId = e.sink.value;
        applySink();
        tell({ k: 'sink', id: sinkId });
      });
      if (onDevicesChanged) onDevicesChanged(() => { listSinks(); });
      listSinks();
    }

    return {
      /** Called by engine.js right after it built the connection, so what is there now counts as "the PC's own". */
      attach(peer, session) {
        pc = peer; sid = session;
        baseline = new Set(peer.getTransceivers());
        current = { video: null, audio: null };
        reported = { video: false, audio: false };
        paint();
      },
      detach() {
        drop(); // while the session id is still known, so the host can tell the report belongs to a finished session
        pc = null; sid = null;
        baseline = new Set();
      },
      /** `pm-offer` {sid, sdp, sink} and `pm-drop` {sid} from the host. */
      async handle(cmd) {
        if (cmd.t === 'pm-offer') await offer(cmd);
        else if (cmd.t === 'pm-drop' && (!sid || cmd.sid === sid)) drop();
      },
      bind,
      listSinks,
      incoming,
    };
  }

  return { create };
});
