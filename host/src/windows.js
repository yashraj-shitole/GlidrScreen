'use strict';
// Window sharing, pure logic: which application windows are offered to the phone, change detection for the
// list stream, source id validation, and the decision to fall back to a monitor when the shared window goes away.
// Nothing here touches Electron or Win32: sources and window rectangles are injected, so plain node can test it.
//
// Window titles are untrusted text (a web page can name its own tab). They are cleaned and cut here, shown to the
// phone, and never written to a log.

const MAX_WINDOWS = 30; // entries in one `windows` list
const MAX_TITLE = 80; // characters (code points) of a title
const MIN_SIZE = 120; // px; smaller windows (tooltips, helper windows, tray popups) are not offered
const THUMB_COUNT = 12; // only the first windows get a preview
const OWN_TITLES = ['glidr screen'];

/** "window:1234:0" -> 1234 (the HWND as a number), or null for anything else (including screens). */
function parseHwnd(sourceId) {
  if (typeof sourceId !== 'string') return null;
  const m = /^window:(\d{1,15}):\d+$/.exec(sourceId);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Title as shown on the phone: control characters and bidi overrides become spaces, trimmed, at most 80 code points. */
function cleanTitle(raw) {
  if (typeof raw !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const t = raw.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]+/g, ' ').replace(/\s+/g, ' ').trim();
  const cps = Array.from(t);
  return cps.length > MAX_TITLE ? cps.slice(0, MAX_TITLE).join('').trimEnd() : t;
}

/**
 * The windows to offer, front to back (desktopCapturer lists them in z order).
 * @param sources   [{id, name}] from desktopCapturer {types:['window']}
 * @param rectOf    (hwnd) => {x,y,w,h,iconic} | null   (null: not a window any more)
 * @param ownIds    optional Set of source ids that belong to this app (BrowserWindow.getMediaSourceId())
 * @param ownTitles optional lower-case titles that are this app's own windows
 * @returns [{id, title, w, h}]
 */
function buildList(sources, { rectOf, ownIds = new Set(), ownTitles = OWN_TITLES, max = MAX_WINDOWS } = {}) {
  const out = [];
  const seen = new Set();
  for (const s of Array.isArray(sources) ? sources : []) {
    if (out.length >= max) break;
    if (!s || typeof s.id !== 'string' || seen.has(s.id)) continue;
    const hwnd = parseHwnd(s.id);
    if (hwnd === null) continue;
    const title = cleanTitle(s.name);
    if (!title) continue; // untitled windows are helpers, not something a person would pick
    if (ownIds.has(s.id) || ownTitles.includes(title.toLowerCase())) continue; // never offer our own window
    let r = null;
    try { r = rectOf ? rectOf(hwnd) : null; } catch { r = null; }
    if (!r || r.iconic) continue; // closed, or minimised (nothing to show)
    if (!(r.w >= MIN_SIZE) || !(r.h >= MIN_SIZE)) continue;
    seen.add(s.id);
    out.push({ id: s.id, title, w: Math.round(r.w), h: Math.round(r.h) });
  }
  return out;
}

/** Stable text form of a list, to tell whether anything the phone shows has changed. */
function signature(list) {
  return JSON.stringify(list.map((w) => [w.id, w.title, w.w, w.h]));
}

/** Remembers the last list that was sent: `changed(list)` is true the first time and whenever the list differs. */
class ChangeDetector {
  constructor() { this.last = null; }
  changed(list) {
    const sig = signature(list);
    if (sig === this.last) return false;
    this.last = sig;
    return true;
  }
  reset() { this.last = null; }
}

/** The entry of `list` with this id, or null: an id the phone makes up (or one that vanished) is never captured. */
function validate(id, list) {
  if (typeof id !== 'string' || !Array.isArray(list)) return null;
  return list.find((w) => w.id === id) || null;
}

/** ids of the windows that get a preview: the first THUMB_COUNT of the list. */
function thumbIds(list) {
  return list.slice(0, THUMB_COUNT).map((w) => w.id);
}

/**
 * What to do with the shared window, from a fresh rectangle (null = IsWindow false, iconic = minimised).
 * 'gone' means: tell the phone and fall back to the primary monitor. Bounds are only trusted when sane.
 */
function decide(rect) {
  if (!rect || rect.iconic) return { action: 'gone' };
  if (!(rect.w > 0) || !(rect.h > 0)) return { action: 'gone' };
  return { action: 'ok', bounds: { x: rect.x, y: rect.y, w: rect.w, h: rect.h } };
}

const sameBounds = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

/**
 * Follows the shared window: refreshes its bounds at most every `intervalMs` and reports, once, that it is gone.
 * `poll()` returns
 *   {state:'wait'}                 too soon since the last look
 *   {state:'ok', bounds, moved}    `moved` is true when the bounds differ from the previous look
 *   {state:'gone'}                 minimised or closed; returned once, after that {state:'idle'}
 */
class WindowTracker {
  constructor({ rectOf, now = Date.now, intervalMs = 250 }) {
    Object.assign(this, { rectOf, now, intervalMs });
    this.hwnd = null; this.bounds = null; this.lastAt = -Infinity; this.reported = false;
  }

  get active() { return this.hwnd !== null; }

  /** Starts following `hwnd` from `bounds` (the rectangle already read for the switch). */
  start(hwnd, bounds) {
    this.hwnd = hwnd; this.bounds = bounds || null; this.lastAt = this.now(); this.reported = false;
  }

  stop() { this.hwnd = null; this.bounds = null; this.reported = false; }

  poll() {
    if (this.hwnd === null || this.reported) return { state: 'idle' };
    const t = this.now();
    if (t - this.lastAt < this.intervalMs) return { state: 'wait' };
    this.lastAt = t;
    let rect = null;
    try { rect = this.rectOf(this.hwnd); } catch { rect = null; }
    const d = decide(rect);
    if (d.action === 'gone') { this.reported = true; return { state: 'gone' }; }
    const moved = !sameBounds(this.bounds, d.bounds);
    this.bounds = d.bounds;
    return { state: 'ok', bounds: d.bounds, moved };
  }
}

module.exports = {
  MAX_WINDOWS, MAX_TITLE, MIN_SIZE, THUMB_COUNT,
  parseHwnd, cleanTitle, buildList, signature, ChangeDetector, validate, thumbIds, decide, WindowTracker,
};
