'use strict';
const $ = (id) => document.getElementById(id);
let state = null;
let editing = false;
const TOGGLES = ['allowControl', 'allowActions', 'allowFiles', 'shareAudio', 'keepAwake', 'endOnLock', 'autostart', 'allowLan', 'recordSessions'];

TOGGLES.push('allowPhoneMedia'); // phone camera and microphone (src/phonemedia.js)
TOGGLES.push('allowPhoneRecording'); // the phone's Record button (src/host.js #phoneRecord)

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
    $('liveRec').classList.toggle('hidden', !s.recording); // session recording
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
    $('guestNote').classList.toggle('hidden', !p.guest);
    $('wolNote').classList.toggle('hidden', !p.wol);
    if ($('qr').dataset.id !== p.id) { $('qr').src = p.qr; $('qr').dataset.id = p.id; }
    $('code').textContent = p.code;
    renderExpires(p);
  }

  $('noDevices').classList.toggle('hidden', s.devices.length > 0);
  // An open dropdown would be closed by rebuilding the list (state arrives every second while streaming).
  const picking = document.activeElement && document.activeElement.tagName === 'SELECT' && $('devices').contains(document.activeElement);
  if (!picking) renderDevices(s);
  renderMonitors(s);
  renderSettings(s);
  renderActions(s);
}

const ACCESS = [['never', 'Always'], ['1h', '1 hour'], ['1d', '1 day'], ['7d', '7 days']];

function renderDevices(s) {
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
    const seen = d.connected ? 'Connected now' : `Last seen ${ago(d.lastSeen)}`;
    sm.textContent = d.needsRepair ? 'Pair again: its key cannot be read on this PC' : d.text ? `${seen}. ${d.text}` : seen;
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
    if (!d.needsRepair) li.append(permissionRow(d));
    $('devices').append(li);
  }
}

/** "View only" switch and "Access" length for one phone. */
function permissionRow(d) {
  const row = document.createElement('div');
  row.className = 'perm';
  const vo = document.createElement('label');
  const cb = document.createElement('input');
  cb.type = 'checkbox'; cb.className = 'switch'; cb.checked = !!d.viewOnly;
  cb.onchange = () => window.glidr.act('phone', { id: d.id, viewOnly: cb.checked });
  vo.append(cb, document.createTextNode('View only'));
  const al = document.createElement('label');
  const sel = document.createElement('select');
  for (const [v, t] of ACCESS) { const o = document.createElement('option'); o.value = v; o.textContent = t; sel.append(o); }
  sel.value = d.access;
  sel.onchange = () => { window.glidr.act('phone', { id: d.id, expiresIn: sel.value }); sel.blur(); };
  al.append(document.createTextNode('Access'), sel);
  row.append(vo, al);
  return row;
}

/** Quick actions card: the list is rebuilt only when it changed, so a click is never lost to the 1 s state push. */
let actionsSig = '';
const LAUNCH_ERRORS = {
  label: 'Give it a name (up to 40 characters).',
  path: 'That program was not found on this PC. Use a full path to an existing .exe, .bat, .cmd or .lnk, or an https:// link.',
  url: 'Only plain https:// links are allowed.',
  args: 'Too many arguments, or one is too long.',
  batch: 'Batch files take plain arguments only (letters, digits and . _ : / \\ @ + -) and cannot have special characters in their path.',
  full: 'The limit of 12 launchers is reached. Remove one first.',
  invalid: 'Something was missing.',
  id: 'Could not create the launcher. Try again.',
};
const ACTION_NOTES = {
  restart: 'Restarts after 15 seconds. The phone asks to confirm first. Off until you switch it on',
  shutdown: 'Shuts down after 15 seconds. The phone asks to confirm first. Off until you switch it on',
};

function actionRow(it, extra) {
  const li = document.createElement('li');
  const left = document.createElement('div');
  const name = document.createElement('div');
  name.className = 'name';
  const nameEl = document.createElement('span');
  nameEl.textContent = it.label;
  name.append(nameEl);
  left.append(name);
  if (extra) { const sm = document.createElement('small'); sm.textContent = extra; sm.title = extra; left.append(sm); }
  const cb = document.createElement('input');
  cb.type = 'checkbox'; cb.className = 'switch'; cb.checked = !!it.enabled;
  cb.setAttribute('aria-label', 'Allow ' + it.label);
  cb.onchange = () => window.glidr.act('actionToggle', { id: it.id, on: cb.checked });
  li.append(left, cb);
  return li;
}

function renderActions(s) {
  const a = s.actions;
  if (!a) return;
  const sig = JSON.stringify([s.settings.allowActions, a]);
  if (sig === actionsSig) return;
  actionsSig = sig;
  $('actionsBody').classList.toggle('off', !s.settings.allowActions);
  $('actionList').innerHTML = '';
  for (const it of a.items) {
    if (it.implicit || !it.builtin) continue; // cancel follows restart / shut down; launchers have their own list
    $('actionList').append(actionRow(it, ACTION_NOTES[it.id]));
  }
  $('launcherList').innerHTML = '';
  for (const l of a.launchers) {
    const it = a.items.find((x) => x.id === l.id) || { id: l.id, label: l.label, enabled: false };
    const li = actionRow(it, l.path + (l.args.length ? ' ' + l.args.join(' ') : ''));
    const rm = document.createElement('button');
    rm.className = 'ghost danger'; rm.textContent = 'Remove';
    rm.onclick = () => { if (confirm(`Remove the launcher ${l.label}?`)) window.glidr.act('launcherRemove', { id: l.id }); };
    li.insertBefore(rm, li.lastChild);
    $('launcherList').append(li);
  }
  $('noLaunchers').classList.toggle('hidden', a.launchers.length > 0);
  $('lnAdd').disabled = a.launchers.length >= a.max;
}

function renderMonitors(s) {
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
}

function renderSettings(s) {
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
  renderUpdate(u);
  $('updateStatus').textContent = {
    checking: ' (checking...)', latest: ' (up to date)', none: ' (no releases yet)', error: ' (could not check)',
  }[u.status] || '';
}

// <update-banner> (pure: test/updater-ui.test.js loads this block on its own)
/** What the update banner shows for the state's `update` object. `action` is the act() name the main button sends. */
function updateBanner(u) {
  const i = u.install || {};
  const busy = i.status === 'downloading' || i.status === 'ready' || i.status === 'error';
  const out = { show: u.status === 'available' || busy, title: `Version ${i.version || u.latest} is available`, note: '', bad: false,
    button: 'Download', action: 'openUpdate', arg: undefined, cancel: false, bar: null };
  if (i.status === 'downloading') {
    out.button = null; out.cancel = true; out.bar = i.percent || 0;
    out.note = `Downloading ${i.percent || 0}%`;
  } else if (i.status === 'ready') {
    out.button = 'Restart to update'; out.action = 'installUpdate';
    out.note = 'Ready. The app closes, updates and opens again. Your phones stay paired.';
  } else if (i.status === 'error') {
    out.bad = true; out.note = i.error || 'The update failed.';
    if (i.retry && i.mode === 'install') { out.button = 'Try again'; out.action = 'downloadUpdate'; } else { out.button = 'Open release page'; out.arg = 'page'; }
  } else if (i.mode === 'install') {
    out.button = 'Download and install'; out.action = 'downloadUpdate';
    out.note = 'Installs in the background and restarts the app. Your phones stay paired.';
  } else {
    out.note = 'Download it, then quit this app and run the new version.';
  }
  return out;
}
// </update-banner>

function renderUpdate(u) {
  const b = updateBanner(u);
  $('update').classList.toggle('hidden', !b.show);
  $('updateTitle').textContent = b.title;
  $('updateNote').textContent = b.note;
  $('updateNote').classList.toggle('bad', b.bad);
  $('updateGet').classList.toggle('hidden', !b.button);
  $('updateGet').textContent = b.button || '';
  $('updateGet').dataset.action = b.action; $('updateGet').dataset.arg = b.arg || '';
  $('updateCancel').classList.toggle('hidden', !b.cancel);
  $('updateBar').classList.toggle('hidden', b.bar === null);
  $('updateFill').style.width = `${b.bar || 0}%`;
  $('updateBar').setAttribute('aria-valuenow', String(b.bar || 0));
}

$('newPairing').onclick = () => window.glidr.act('newPairing');
$('newGuest').onclick = () => window.glidr.act('guest');
$('diagnose').onclick = async () => {
  const btn = $('diagnose');
  btn.disabled = true; btn.textContent = 'Testing...';
  $('diagResults').innerHTML = '';
  let results = [];
  try { results = await window.glidr.act('diagnose'); } catch { results = [{ name: 'Test', ok: false, detail: 'The test could not run', ms: 0 }]; }
  for (const r of results || []) {
    const li = document.createElement('li');
    li.className = r.ok ? 'ok' : 'bad';
    const mark = document.createElement('b');
    mark.textContent = r.ok ? '\u2713' : '\u2717';
    const text = document.createElement('span');
    text.textContent = r.name;
    const sm = document.createElement('small');
    sm.textContent = `${r.detail} (${r.ms} ms)`;
    text.append(sm);
    li.append(mark, text);
    $('diagResults').append(li);
  }
  btn.disabled = false; btn.textContent = 'Test connection';
};
$('lnPick').onclick = async () => {
  const p = await window.glidr.act('launcherPick');
  if (typeof p === 'string' && p) $('lnPath').value = p;
};
$('lnAdd').onclick = async () => {
  $('lnError').textContent = '';
  const r = await window.glidr.act('launcherAdd', { label: $('lnLabel').value, path: $('lnPath').value, args: $('lnArgs').value });
  if (r && r.ok) {
    for (const id of ['lnLabel', 'lnPath', 'lnArgs']) $(id).value = '';
    $('lnError').textContent = 'Added. Switch it on in the list to let the phone use it.';
  } else $('lnError').textContent = LAUNCH_ERRORS[r && r.error] || 'Could not add it.';
};
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
// the main button sends only a fixed action name (and 'page'); the main process knows the asset and the file
$('updateGet').onclick = (e) => window.glidr.act(e.currentTarget.dataset.action || 'openUpdate', e.currentTarget.dataset.arg || undefined);
$('updateCancel').onclick = () => window.glidr.act('cancelUpdate');
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
