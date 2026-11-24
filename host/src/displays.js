'use strict';
const electron = require('electron');
const { screen, desktopCapturer } = electron;
const Windows = require('./windows');

/** All monitors in left-to-right, top-to-bottom order, in physical pixels. */
function list() {
  const primary = screen.getPrimaryDisplay().id;
  const rows = screen.getAllDisplays().map((d) => {
    const r = screen.dipToScreenRect(null, d.bounds);
    return { id: d.id, label: d.label || '', x: r.x, y: r.y, w: r.width, h: r.height, scale: d.scaleFactor, primary: d.id === primary };
  });
  rows.sort((a, b) => a.x - b.x || a.y - b.y);
  rows.forEach((r, i) => { r.name = `Display ${i + 1}`; });
  return rows;
}

function byId(id) {
  return list().find((d) => d.id === id) || list().find((d) => d.primary) || list()[0];
}

async function sources(thumb) {
  return desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: thumb || { width: 1, height: 1 },
    fetchWindowIcons: false,
  });
}

/** desktopCapturer source id (e.g. "screen:1:0") for a display id. */
async function sourceIdFor(displayId) {
  const srcs = await sources();
  const found = srcs.find((s) => s.display_id === String(displayId));
  if (found) return found.id;
  const idx = list().findIndex((d) => d.id === displayId);
  return (srcs[Math.max(0, idx)] || srcs[0]).id;
}

/** Small JPEG previews of every monitor, for the phone's monitor picker. */
async function thumbnails() {
  const srcs = await sources({ width: 384, height: 216 });
  return list().map((d, i) => {
    const s = srcs.find((x) => x.display_id === String(d.id)) || srcs[i];
    if (!s || s.thumbnail.isEmpty()) return null;
    const size = s.thumbnail.getSize();
    return { id: d.id, w: size.width, h: size.height, jpg: s.thumbnail.toJPEG(55).toString('base64') };
  }).filter(Boolean);
}

// ---------------------------------------------------------------- application windows (see windows.js)

async function windowSources(thumb) {
  return desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: thumb || { width: 1, height: 1 },
    fetchWindowIcons: false,
  });
}

/** Source ids ("window:<hwnd>:0") of this app's own windows, so they are never offered. Best effort. */
function ownWindowIds() {
  const ids = new Set();
  try {
    for (const w of electron.BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) ids.add(w.getMediaSourceId());
    }
  } catch { /* not available (tests): the title check in windows.js still applies */ }
  return ids;
}

/** Windows worth offering, front to back: [{id, title, w, h}]. `rectOf(hwnd)` is input.windowRect. */
async function windowList(rectOf) {
  return Windows.buildList(await windowSources(), { rectOf, ownIds: ownWindowIds() });
}

/** JPEG previews (max 384x216) of the windows with these ids: [{id, w, h, jpg}]. */
async function windowThumbnails(ids) {
  const want = new Set(ids);
  const srcs = await windowSources({ width: 384, height: 216 });
  const out = [];
  for (const s of srcs) {
    if (!want.has(s.id) || !s.thumbnail || s.thumbnail.isEmpty()) continue;
    const size = s.thumbnail.getSize();
    out.push({ id: s.id, w: size.width, h: size.height, jpg: s.thumbnail.toJPEG(55).toString('base64') });
  }
  return out;
}

module.exports = { list, byId, sourceIdFor, thumbnails, windowList, windowThumbnails };
