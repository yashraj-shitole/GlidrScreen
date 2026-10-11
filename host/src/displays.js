'use strict';
const { screen, desktopCapturer } = require('electron');

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

module.exports = { list, byId, sourceIdFor, thumbnails };
