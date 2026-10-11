'use strict';
const $ = (id) => document.getElementById(id);
let state = null;
let editing = false;

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

function render(s) {
  state = s;
  const [cls, label] = STATUS[s.status];
  const offline = s.sharing && s.signal === 'offline';
  $('pill').className = 'pill ' + (offline ? 'offline' : cls);
  $('pillText').textContent = offline ? 'No internet' : label;

  $('live').classList.toggle('hidden', !s.device);
  if (s.device) {
    $('liveName').textContent = s.device.name;
    const st = s.stats;
    const cells = st ? [
      [st.fps, 'fps'], [`${st.w}x${st.h}`, 'video'], [`${(st.kbps / 1000).toFixed(1)}`, 'Mbit/s'],
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
    const left = Math.max(0, Math.round((p.expiresAt - Date.now()) / 60000));
    $('expires').textContent = `Expires in ${left} min. Anyone with this code can pair, so show it only to yourself.`;
  }

  $('noDevices').classList.toggle('hidden', s.devices.length > 0);
  $('devices').innerHTML = '';
  for (const d of s.devices) {
    const li = document.createElement('li');
    const left = document.createElement('div');
    left.textContent = d.name;
    const sm = document.createElement('small');
    sm.textContent = d.connected ? 'Connected now' : `Last seen ${ago(d.lastSeen)}`;
    left.append(sm);
    const btn = document.createElement('button');
    btn.className = 'ghost danger'; btn.textContent = 'Remove';
    btn.onclick = () => { if (confirm(`Remove ${d.name}? It will need to be paired again.`)) window.glidr.act('revoke', d.id); };
    li.append(left, btn);
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
    $('allowControl').checked = s.settings.allowControl;
    $('autostart').checked = s.settings.autostart;
    $('quality').value = s.settings.quality;
    $('codec').value = s.settings.codec;
    $('hostName').value = s.settings.hostName;
    $('signalBase').value = s.settings.signalBase;
  }
  $('signalStatus').textContent = `Signaling: ${s.signal}`;
  $('version').textContent = `Glidr Screen ${s.version}`;
}

$('newPairing').onclick = () => window.glidr.act('newPairing');
$('cancelPairing').onclick = () => window.glidr.act('cancelPairing');
$('copyLink').onclick = () => state.pairing && window.glidr.act('copy', state.pairing.link);
$('code').onclick = () => state.pairing && window.glidr.act('copy', state.pairing.code);
$('disconnect').onclick = () => window.glidr.act('disconnect');
$('quit').onclick = (e) => { e.preventDefault(); window.glidr.act('quit'); };
$('sharing').onchange = (e) => window.glidr.act('sharing', e.target.checked);
for (const id of ['allowControl', 'autostart']) $(id).onchange = (e) => window.glidr.act('setting', { [id]: e.target.checked });
for (const id of ['quality', 'codec']) $(id).onchange = (e) => window.glidr.act('setting', { [id]: e.target.value });
for (const id of ['hostName', 'signalBase']) {
  $(id).onfocus = () => { editing = true; };
  $(id).onblur = () => { editing = false; };
  $(id).onchange = (e) => window.glidr.act('setting', { [id]: e.target.value });
}

window.glidr.onState(render);
window.glidr.state().then(render);
setInterval(() => state && render(state), 30_000); // refresh "x min ago" and pairing countdown
