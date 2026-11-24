'use strict';
const $ = (id) => document.getElementById(id);
let state = null;
let editing = false;
const TOGGLES = ['allowControl', 'shareAudio', 'keepAwake', 'endOnLock', 'autostart'];

const STATUS = {
  waiting: ['waiting', 'Ready'], connecting: ['connecting', 'Connecting'],
  streaming: ['streaming', 'Streaming'], paused: ['paused', 'Paused'],
};

function ago(ts) {
  if (!ts) return 'never connected';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/** Rounds up, so "Expires in 1 min" lasts until it really expires. Fetches fresh state once it has: main prunes it then. */
let expiryFetchAt = 0;
function renderExpires(p) {
  const ms = p.expiresAt - Date.now();
  if (ms <= 0) {
    // at most one refresh per 5 s, so a state that still lists the pairing cannot loop
    if (Date.now() - expiryFetchAt > 5000) { expiryFetchAt = Date.now(); window.glidr.state().then(render); }
    $('expires').textContent = 'This code has expired. Cancel and generate a new one.';
    return;
  }
  const min = Math.ceil(ms / 60000);
  $('expires').textContent = `Expires in ${min} min. Anyone with this code can pair, so show it only to yourself.`;
}

function render(s) {
  state = s;
  const [cls, label] = STATUS[s.status];
  const offline = s.sharing && s.signal === 'offline';
  $('pill').className = 'pill ' + (offline ? 'offline' : cls);
  $('pillText').textContent = offline ? 'No internet' : (s.status === 'paused' && s.pausedLabel) || label;

  $('live').classList.toggle('hidden', !s.device);
  if (s.device) {
    $('liveName').textContent = s.device.name;
    const st = s.stats;
    const cells = st ? [
      [st.fps, 'fps'], [st.w ? `${st.w}x${st.h}` : '...', 'video'], [`${(st.kbps / 1000).toFixed(1)}`, 'Mbit/s'],
      [st.path === 'relay' ? 'relay' : 'direct', st.rtt != null ? `${Math.round(st.rtt * 1000)} ms` : 'path'],
    ] : [['...', 'fps'], ['', 'video'], ['', 'Mbit/s'], ['', 'path']];
    $('stats').innerHTML = cells.map(([v, l]) => `<div><b>${v}</b><span>${l}</span></div>`).join('');
  }

  const p = s.pairing;
  $('pairIdle').classList.toggle('hidden', !!p);
  $('pairOpen').classList.toggle('hidden', !p);
  if (p) {
    if ($('qr').dataset.id !== p.id) { $('qr').src = p.qr; $('qr').dataset.id = p.id; }
    $('code').textContent = p.code;
    renderExpires(p);
  }

  $('noDevices').classList.toggle('hidden', s.devices.length > 0);
  $('devices').innerHTML = '';
  for (const d of s.devices) {
    const li = document.createElement('li');
    const left = document.createElement('div');
    const nameRow = document.createElement('div');
    nameRow.className = 'name';
    if (d.connected) { const dot = document.createElement('i'); dot.className = 'dot'; nameRow.append(dot); }
    const nameEl = document.createElement('span');
    nameEl.textContent = d.name;
    nameEl.title = d.name; // the full name when it is long enough to be cut off
    nameRow.append(nameEl);
    left.append(nameRow);
    const sm = document.createElement('small');
    sm.textContent = d.needsRepair ? 'Pair again: its key cannot be read on this PC' : d.connected ? 'Connected now' : `Last seen ${ago(d.lastSeen)}`;
    left.append(sm);
    const btn = document.createElement('button');
    btn.className = 'ghost danger'; btn.textContent = 'Remove';
    btn.onclick = () => { if (confirm(`Remove ${d.name}? It will need to be paired again.`)) window.glidr.act('revoke', d.id); };
    if (d.needsRepair) {
      const fix = document.createElement('button');
      fix.className = 'ghost'; fix.textContent = 'Pair again';
      fix.onclick = () => window.glidr.act('repair', d.id);
      li.append(left, fix, btn);
    } else li.append(left, btn);
    $('devices').append(li);
  }

  $('monitors').innerHTML = '';
  for (const m of s.monitors) {
    const el = document.createElement('div');
    el.className = 'mon' + (m.id === s.active ? ' active' : '');
    el.textContent = m.name + (m.primary ? ' (main)' : '');
    const sm = document.createElement('small');
    sm.textContent = `${m.w} x ${m.h}`;
    el.append(sm);
    $('monitors').append(el);
  }

  if (!editing) {
    $('sharing').checked = s.sharing;
    for (const id of TOGGLES) $(id).checked = s.settings[id];
    $('quality').value = s.settings.quality;
    $('codec').value = s.settings.codec;
    $('hostName').value = s.settings.hostName;
    $('signalBase').value = s.settings.signalBase;
  }
  $('signalStatus').textContent = `Signaling: ${s.signal}`;
  $('version').textContent = `Glidr Screen ${s.version}`;

  const u = s.update || {};
  $('update').classList.toggle('hidden', u.status !== 'available');
  $('updateTitle').textContent = `Version ${u.latest} is available`;
  $('updateStatus').textContent = {
    checking: ' (checking...)', latest: ' (up to date)', none: ' (no releases yet)', error: ' (could not check)',
  }[u.status] || '';
}

$('newPairing').onclick = () => window.glidr.act('newPairing');
$('cancelPairing').onclick = () => window.glidr.act('cancelPairing');
/** Briefly shows [text] in [el], then puts the original text back. */
function flash(el, text) {
  if (el.dataset.orig === undefined) el.dataset.orig = el.textContent;
  el.textContent = text;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.textContent = el.dataset.orig; delete el.dataset.orig; }, 1500);
}
$('copyLink').onclick = () => { if (state.pairing) { window.glidr.act('copy', state.pairing.link); flash($('copyLink'), 'Copied'); } };
$('code').onclick = () => { if (state.pairing) { window.glidr.act('copy', state.pairing.code); flash($('copyHint'), 'Code copied'); } };
$('disconnect').onclick = () => window.glidr.act('disconnect');
$('quit').onclick = (e) => { e.preventDefault(); window.glidr.act('quit'); };
$('checkUpdate').onclick = (e) => { e.preventDefault(); window.glidr.act('checkUpdate'); };
$('updateGet').onclick = () => window.glidr.act('openUpdate');
$('sharing').onchange = (e) => window.glidr.act('sharing', e.target.checked);
for (const id of TOGGLES) $(id).onchange = (e) => window.glidr.act('setting', { [id]: e.target.checked });
for (const id of ['quality', 'codec']) $(id).onchange = (e) => window.glidr.act('setting', { [id]: e.target.value });
for (const id of ['hostName', 'signalBase']) {
  $(id).onfocus = () => { editing = true; };
  $(id).onblur = () => { editing = false; };
  $(id).onchange = (e) => {
    // A phone keeps the server it was paired with. Switching here leaves every paired phone waiting for a PC that
    // is listening somewhere else, so say so before it happens.
    if (id === 'signalBase' && state && state.devices.length && e.target.value.trim().replace(/\/+$/, '') !== state.settings.signalBase) {
      if (!confirm('Phones that are already paired keep using the old signaling server and will not connect until they are paired again. Change it anyway?')) {
        e.target.value = state.settings.signalBase;
        return;
      }
    }
    window.glidr.act('setting', { [id]: e.target.value });
  };
}

window.glidr.onState(render);
window.glidr.state().then(render);
// Refresh "x min ago" and the pairing countdown. Fetch fresh state: the main process prunes an expired pairing
// on each fetch, and re-rendering the old state would keep showing its QR code.
setInterval(() => window.glidr.state().then(render), 30_000);
// The pairing countdown ticks every few seconds without asking the main process.
setInterval(() => { if (state && state.pairing) renderExpires(state.pairing); }, 5_000);
