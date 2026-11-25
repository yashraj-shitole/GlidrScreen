'use strict';
// Phone camera and microphone on the PC (see docs/PROTOCOL.md, "Phone camera and microphone").
//
// The phone is the offerer here. It adds sendonly camera / microphone transceivers to the running peer connection and
// sends the new offer over the `ctl` channel; the engine page applies it and the answer goes back the same way. This
// file is the PC-side policy and bookkeeping, pure Node (the peer connection itself lives in the engine renderer,
// see renderer/phonecam.js):
//
//   phone -> PC   {"t":"renegotiate","sdp":"<offer>"}
//   PC -> phone   {"t":"renegotiate-answer","sdp":"<answer>"}  or  {"t":"renegotiate-error","reason":"disabled|busy|bad-sdp|failed"}
//   PC -> phone   {"t":"media-stop","reason":"pc|disabled"}    the PC asks the phone to stop sending (the phone then renegotiates)
//
// What is decided here, in this order, for every offer:
//   1. one renegotiation at a time ('busy');
//   2. the offer is plain text within MAX_SDP and describes only what a camera / microphone renegotiation can look like
//      ('bad-sdp', see parseOffer);
//   3. an offer that would make the phone SEND media needs the setting `allowPhoneMedia`, the PC-wide "Allow remote
//      control" and a phone that is not view only ('disabled'). An offer that sends nothing (the phone stopping its
//      camera) is always answered, so the phone never stays stuck in a half-finished negotiation.
//
// Nothing here opens a camera or a microphone on the PC: media only ever flows from the phone to the PC.

const { EventEmitter } = require('events');

/** Largest SDP (offer or answer) accepted or sent over the data channel. The channel itself allows 256 KB. */
const MAX_SDP = 60 * 1024;
/** m-sections in a whole offer: the screen video, the optional PC audio, the data channels, the camera and the microphone, with room for reuse. */
const MAX_SECTIONS = 8;
const MAX_LINES = 2500;
/** How long the engine may take to answer before the phone is told 'failed'. */
const ANSWER_TIMEOUT_MS = 15_000;
const MAX_SINK_ID = 300;

/**
 * Looks at an offer from the phone and says what it would do. A renegotiation offer always repeats the sections that
 * already exist (the PC's screen video, the optional PC audio and the data channels), so those have to pass; what must
 * stay out is anything else.
 *
 *   - a string of at most MAX_SDP characters, printable ASCII plus CR / LF, starting with `v=0`;
 *   - at most MAX_SECTIONS m-sections, kinds `video`, `audio` and at most one `application` (the existing SCTP section,
 *     which the offer has to repeat; a second one, text, message or any other kind is refused);
 *   - at most one video and one audio section in which the PHONE sends (port not 0, `sendonly` or `sendrecv`): the camera
 *     and the microphone, nothing more.
 *
 * Returns {ok:true, sending:{video, audio}} or {ok:false, reason:'bad-sdp'}.
 */
function parseOffer(sdp) {
  const bad = { ok: false, reason: 'bad-sdp' };
  if (typeof sdp !== 'string' || sdp.length === 0 || sdp.length > MAX_SDP) return bad;
  if (/[^\x20-\x7e\r\n]/.test(sdp)) return bad; // controls, NUL and non-ASCII never appear in the SDP the phone makes
  const lines = sdp.split(/\r?\n/);
  if (lines.length > MAX_LINES || lines[0] !== 'v=0') return bad;
  const sections = [];
  for (const line of lines) {
    const m = /^m=([a-z]+) (\d+) (\S+)/.exec(line);
    if (m) { sections.push({ kind: m[1], port: Number(m[2]), proto: m[3], dir: 'sendrecv' }); continue; }
    if (!sections.length) continue;
    const d = /^a=(sendrecv|sendonly|recvonly|inactive)$/.exec(line);
    if (d) sections[sections.length - 1].dir = d[1];
  }
  if (sections.length === 0 || sections.length > MAX_SECTIONS) return bad;
  const sending = { video: 0, audio: 0 };
  let app = 0;
  for (const s of sections) {
    if (s.kind === 'application') {
      if (++app > 1 || !/SCTP/i.test(s.proto)) return bad;
    } else if (s.kind === 'video' || s.kind === 'audio') {
      if (s.port !== 0 && (s.dir === 'sendonly' || s.dir === 'sendrecv')) sending[s.kind]++;
    } else return bad;
  }
  if (sending.video > 1 || sending.audio > 1) return bad;
  return { ok: true, sending: { video: sending.video === 1, audio: sending.audio === 1 } };
}

class PhoneMedia extends EventEmitter {
  /**
   * @param allowed () => bool            the setting `allowPhoneMedia`
   * @param canControl (session) => bool  PC-wide control switch and a phone that is not view only (permissions.canControl)
   * @param send (obj) => void            JSON to the phone on `ctl`
   * @param engineSend (cmd) => void      command to the engine page
   * @param getSink () => string          remembered audio output
   * @param setSink (id) => void          remember the output chosen in the camera window
   * @param log (text) => void
   * @param timeoutMs                     engine answer timeout (tests shorten it)
   */
  constructor({ allowed, canControl, send, engineSend, getSink, setSink, log, timeoutMs }) {
    super();
    this.allowed = allowed;
    this.canControl = canControl;
    this.send = send;
    this.engineSend = engineSend;
    this.getSink = getSink || (() => '');
    this.setSink = setSink || (() => {});
    this.log = log || (() => {});
    this.timeoutMs = timeoutMs || ANSWER_TIMEOUT_MS;
  }

  #st(s) {
    if (!s.pm) s.pm = { busy: false, timer: null, video: false, audio: false, shown: false };
    return s.pm;
  }

  /** The phone may send camera / microphone right now. */
  permitted(s) {
    return this.allowed() === true && this.canControl(s) === true;
  }

  /** What the camera window should show for [s]: null when nothing arrives. */
  view(s) {
    const pm = s?.pm;
    return pm && (pm.video || pm.audio) ? { video: pm.video, audio: pm.audio, name: s.name } : null;
  }

  #error(reason) {
    this.send({ t: 'renegotiate-error', reason });
  }

  /** `renegotiate` from the phone. */
  onRenegotiate(s, m) {
    if (!s || !s.live) return;
    const pm = this.#st(s);
    if (pm.busy) return this.#error('busy');
    const v = parseOffer(m && m.sdp);
    if (!v.ok) return this.#error('bad-sdp'); // nothing about the offer is logged
    if ((v.sending.video || v.sending.audio) && !this.permitted(s)) return this.#error('disabled');
    pm.busy = true;
    clearTimeout(pm.timer);
    pm.timer = setTimeout(() => {
      if (s.pm !== pm || !pm.busy) return;
      pm.busy = false;
      this.log('phone media: the engine did not answer');
      this.#error('failed');
    }, this.timeoutMs);
    this.engineSend({ t: 'pm-offer', sid: s.sid, sdp: m.sdp, sink: this.getSink() });
  }

  /** The engine page's `pm` events: answer, error, tracks, stop, sink. */
  onEngine(s, e) {
    if (!s) return;
    const pm = this.#st(s);
    switch (e.k) {
      case 'answer':
        if (!pm.busy) return;
        pm.busy = false;
        clearTimeout(pm.timer);
        if (typeof e.sdp !== 'string' || e.sdp.length === 0 || e.sdp.length > MAX_SDP) { this.#error('failed'); break; }
        this.send({ t: 'renegotiate-answer', sdp: e.sdp });
        break;
      case 'error':
        if (!pm.busy) return;
        pm.busy = false;
        clearTimeout(pm.timer);
        this.log('phone media: ' + String(e.message || e.reason || 'error').slice(0, 200));
        this.#error(e.reason === 'bad-sdp' || e.reason === 'busy' ? e.reason : 'failed');
        break;
      case 'tracks':
        pm.video = e.video === true;
        pm.audio = e.audio === true;
        if ((pm.video || pm.audio) && !this.permitted(s)) { this.#drop(s, 'disabled'); break; } // switched off while it was being set up
        this.#show(s);
        break;
      case 'stop': // the Stop button in the camera window
        this.#drop(s, 'pc');
        break;
      case 'sink':
        if (typeof e.id === 'string' && e.id.length <= MAX_SINK_ID) this.setSink(e.id);
        break;
      default: break;
    }
  }

  /** The PC owner switched "Allow the phone to send its camera and microphone" or remote control off, or made the phone view only. */
  recheck(s) {
    if (!s || this.permitted(s)) return;
    const pm = s.pm;
    if (pm && (pm.video || pm.audio)) this.#drop(s, 'disabled');
  }

  /** The camera window was closed with its title bar: the same as pressing Stop. */
  windowClosed(s) {
    if (s && this.view(s)) this.#drop(s, 'pc');
  }

  /** Stops showing and playing, and asks the phone to stop sending. The phone answers with a renegotiation that removes its tracks. */
  #drop(s, reason) {
    const pm = this.#st(s);
    pm.video = false;
    pm.audio = false;
    this.engineSend({ t: 'pm-drop', sid: s.sid });
    this.send({ t: 'media-stop', reason });
    this.#show(s);
  }

  #show(s) {
    const pm = this.#st(s);
    const on = pm.video || pm.audio;
    if (on === pm.shown && !on) return;
    pm.shown = on;
    this.emit('window', { show: on, video: pm.video, audio: pm.audio, name: s.name });
  }

  /** The session is over: the engine closes its peer connection (which ends the tracks), only the window is left to hide. */
  end(s) {
    const pm = s?.pm;
    if (!pm) return;
    clearTimeout(pm.timer);
    pm.busy = false;
    pm.video = false;
    pm.audio = false;
    if (pm.shown) { pm.shown = false; this.emit('window', { show: false, video: false, audio: false, name: s.name }); }
  }
}

module.exports = { PhoneMedia, parseOffer, MAX_SDP, MAX_SECTIONS, ANSWER_TIMEOUT_MS };
