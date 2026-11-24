'use strict';
// Quick actions: the phone asks the PC to lock, sleep, restart, or run a launcher the PC owner allow-listed.
// This is remote command execution by design, so everything here is strict and pure (the spawn is injected):
//   * the phone only ever sends an action ID; this module maps it to a fixed argument list it owns,
//   * built-ins are fixed argv arrays (no string building), custom launchers are stored as {path, args[]} and
//     passed as arrays too: spawn with shell:false, so metacharacters in a path or an argument stay one argument,
//   * launchers are defined only on the PC (ids are generated here), never created or edited by the phone,
//   * nothing here ever logs a path or an argument.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_LAUNCHERS = 12;
const MAX_LABEL = 40;
const MAX_ARGS = 16;
const MAX_ARG_LEN = 512;
const MAX_PATH_LEN = 520;
const MIN_GAP_MS = 2000; // at most one action per 2 s per session
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 6; // and at most 6 per minute
const SHUTDOWN_DELAY_S = 15;
const EXTS = ['.exe', '.bat', '.cmd', '.lnk'];

const ID_RE = /^[a-z0-9-]{1,24}$/; // built-in ids ("cancel-shutdown") and 8-hex launcher ids both fit
const LAUNCHER_ID_RE = /^[0-9a-f]{8}$/;

const root = () => (/^[A-Za-z]:\\/.test(process.env.SystemRoot || '') ? process.env.SystemRoot : 'C:\\Windows');
const sys = (exe) => path.win32.join(root(), 'System32', exe);
const explorer = () => path.win32.join(root(), 'explorer.exe');

/** The fixed built-ins. `file` is resolved lazily so tests do not depend on the host OS. `args` are literal. */
const BUILTINS = Object.freeze([
  { id: 'lock', label: 'Lock PC', danger: false, defaultOn: true, file: 'rundll32.exe', args: ['user32.dll,LockWorkStation'] },
  { id: 'sleep', label: 'Sleep', danger: false, defaultOn: true, file: 'rundll32.exe', args: ['powrprof.dll,SetSuspendState', '0,1,0'] },
  { id: 'restart', label: 'Restart PC', danger: true, defaultOn: false, file: 'shutdown.exe', args: ['/r', '/t', String(SHUTDOWN_DELAY_S), '/c', 'Glidr Screen'] },
  { id: 'shutdown', label: 'Shut down PC', danger: true, defaultOn: false, file: 'shutdown.exe', args: ['/s', '/t', String(SHUTDOWN_DELAY_S), '/c', 'Glidr Screen'] },
  { id: 'cancel-shutdown', label: 'Cancel shutdown', danger: false, defaultOn: false, file: 'shutdown.exe', args: ['/a'] },
]);
const BUILTIN_BY_ID = new Map(BUILTINS.map((b) => [b.id, b]));

/** Defaults when the master switch is on and the owner never touched the list: only lock and sleep. */
const DEFAULT_ENABLED = Object.freeze(BUILTINS.filter((b) => b.defaultOn).map((b) => b.id));

const CANCEL = 'cancel-shutdown';
const DRIVE_PATH = /^[A-Za-z]:[\\/]/;
const hasCtl =(s) => /[\u0000-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(s);

/** A phone-supplied id: a short lower-case token. Anything else is "unknown" and ignored without a reply. */
function validId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

/** New launcher id: 8 hex chars, generated here and never taken from outside. */
function newId(taken, rand = (n) => crypto.randomBytes(n)) {
  for (let i = 0; i < 20; i++) {
    const id = rand(4).toString('hex');
    if (LAUNCHER_ID_RE.test(id) && !taken.has(id) && !BUILTIN_BY_ID.has(id)) return id;
  }
  return null;
}

/** https:// URL: no credentials, no whitespace or control characters, a real host. Returns the normalised URL or null. */
function checkUrl(s) {
  if (typeof s !== 'string' || s.length > 2000 || /[\s\u0000-\u001f\u007f]/.test(s)) return null;
  if (!/^https:\/\//i.test(s)) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'https:' || !u.hostname || u.username || u.password) return null;
  return u.href;
}

/** A path to an existing .exe/.bat/.cmd/.lnk on this PC (absolute, no control characters). [exists] is injected. */
function checkFilePath(p, exists = (f) => fs.statSync(f).isFile()) {
  if (typeof p !== 'string' || !p || p.length > MAX_PATH_LEN || hasCtl(p)) return null;
  // A local drive path only: no UNC share, no \\?\ or \\.\ device path, no relative path.
  if (!DRIVE_PATH.test(p)) return null;
  if (!EXTS.includes(path.win32.extname(p).toLowerCase())) return null;
  let ok = false;
  try { ok = !!exists(p); } catch { ok = false; }
  return ok ? path.win32.normalize(p) : null;
}

/**
 * Validates a launcher from the PC's UI: {label, path, args}. [path] is an existing .exe/.bat/.cmd/.lnk or an https URL.
 * Args are an array of strings (or one string, split on lines: one argument per line, so nothing is ever parsed as a
 * command line). Returns {ok:true, launcher} (without id) or {ok:false, error}.
 */
function validateLauncher(input, deps = {}) {
  if (!input || typeof input !== 'object') return { ok: false, error: 'invalid' };
  const label = typeof input.label === 'string' ? input.label.replace(/\s+/g, ' ').trim() : '';
  if (!label || label.length > MAX_LABEL || hasCtl(label)) return { ok: false, error: 'label' };
  const target = typeof input.path === 'string' ? input.path.trim() : '';
  let args = input.args;
  if (typeof args === 'string') args = args.split(/\r?\n/).filter((a) => a.length > 0);
  if (args === undefined || args === null) args = [];
  if (!Array.isArray(args) || args.length > MAX_ARGS) return { ok: false, error: 'args' };
  for (const a of args) if (typeof a !== 'string' || a.length > MAX_ARG_LEN || /[\u0000]/.test(a)) return { ok: false, error: 'args' };
  if (/^https?:/i.test(target)) {
    const url = checkUrl(target);
    if (!url) return { ok: false, error: 'url' };
    return { ok: true, launcher: { label, path: url, args: [] } }; // a URL takes no arguments
  }
  const file = checkFilePath(target, deps.exists);
  if (!file) return { ok: false, error: 'path' };
  if (isBatch(file)) {
    // cmd.exe parses batch arguments itself (& | ^ % ! ...), which no array can protect: refuse anything but a
    // plain path and plain, space-free arguments.
    if (BATCH_UNSAFE.test(file) || args.some((a) => !BATCH_ARG.test(a))) return { ok: false, error: 'batch' };
  }
  return { ok: true, launcher: { label, path: file, args: args.slice() } };
}

const isBatch = (p) => ['.bat', '.cmd'].includes(path.win32.extname(p).toLowerCase());
const BATCH_UNSAFE = /[&|<>^%!()"'`;,=\u0000-\u001f]/; // in a batch file's path
const BATCH_ARG = /^[A-Za-z0-9._:\\/@+-]{1,128}$/; // in a batch file's arguments

/** Drops anything malformed from a stored list (a hand-edited settings file must not widen what can run). */
function sanitizeLaunchers(list) {
  const out = [];
  const seen = new Set();
  if (!Array.isArray(list)) return out;
  for (const l of list) {
    if (out.length >= MAX_LAUNCHERS) break;
    if (!l || typeof l.id !== 'string' || !LAUNCHER_ID_RE.test(l.id) || seen.has(l.id)) continue;
    if (typeof l.label !== 'string' || !l.label || l.label.length > MAX_LABEL) continue;
    if (typeof l.path !== 'string' || !l.path || l.path.length > 2000) continue;
    if (!Array.isArray(l.args) || l.args.length > MAX_ARGS || l.args.some((a) => typeof a !== 'string' || a.length > MAX_ARG_LEN)) continue;
    seen.add(l.id);
    out.push({ id: l.id, label: l.label, path: l.path, args: l.args.slice() });
  }
  return out;
}

/** Adds a validated launcher. Returns {ok, launchers?, id?, error?}; never mutates the input list. */
function addLauncher(list, input, deps = {}) {
  const cur = sanitizeLaunchers(list);
  if (cur.length >= MAX_LAUNCHERS) return { ok: false, error: 'full' };
  const v = validateLauncher(input, deps);
  if (!v.ok) return v;
  const id = newId(new Set(cur.map((l) => l.id)), deps.rand);
  if (!id) return { ok: false, error: 'id' };
  return { ok: true, id, launchers: [...cur, { id, ...v.launcher }] };
}

function removeLauncher(list, id) {
  return sanitizeLaunchers(list).filter((l) => l.id !== id);
}

/**
 * Per-action enable list: ids of the actions the owner switched on. Null / missing = the defaults (lock, sleep).
 * Only known ids survive (a built-in or an existing launcher).
 */
function enabledSet(enabled, launchers) {
  const known = new Set([...BUILTIN_BY_ID.keys(), ...sanitizeLaunchers(launchers).map((l) => l.id)]);
  const src = Array.isArray(enabled) ? enabled : DEFAULT_ENABLED;
  const on = new Set(src.filter((id) => typeof id === 'string' && known.has(id) && id !== CANCEL));
  // The phone must be able to take back a restart or shutdown it started, so "Cancel shutdown" follows them.
  if (on.has('restart') || on.has('shutdown')) on.add(CANCEL);
  return on;
}

/** The full catalogue the PC's UI shows: every action with its on/off state. */
function catalogue(cfg) {
  const on = enabledSet(cfg.actionsEnabled, cfg.launchers);
  const rows = BUILTINS.map((b) => ({ id: b.id, label: b.label, danger: b.danger, builtin: true, implicit: b.id === CANCEL, enabled: on.has(b.id) }));
  for (const l of sanitizeLaunchers(cfg.launchers)) {
    rows.push({ id: l.id, label: l.label, danger: false, builtin: false, enabled: on.has(l.id), kind: /^https:/i.test(l.path) ? 'url' : 'file' });
  }
  return rows;
}

/** What the phone may see: enabled actions only, nothing when the master switch is off. No paths, no args. */
function phoneList(cfg) {
  if (cfg.allowActions !== true) return [];
  return catalogue(cfg).filter((r) => r.enabled).map((r) => ({ id: r.id, label: r.label, danger: r.danger }));
}

/** Flips one action in the enable list (explicit list from then on). Unknown ids are ignored. */
function setEnabled(cfg, id, on) {
  if (typeof id !== 'string' || typeof on !== 'boolean' || id === CANCEL) return null;
  const known = new Set(catalogue(cfg).map((r) => r.id));
  if (!known.has(id)) return null;
  const cur = enabledSet(cfg.actionsEnabled, cfg.launchers);
  if (on) cur.add(id); else cur.delete(id);
  cur.delete(CANCEL); // derived, never stored
  return [...cur];
}

/**
 * Builds the spawn call for an action: {file, args, opts}. `shell` is always false and the arguments are always an
 * array. Built-ins use System32 binaries by absolute path. A URL is opened with explorer.exe (one argument).
 * Returns null for an unknown id.
 */
function buildSpawn(id, cfg) {
  const b = BUILTIN_BY_ID.get(id);
  if (b) return { file: sys(b.file), args: b.args.slice(), opts: spawnOpts(true) };
  const l = sanitizeLaunchers(cfg.launchers).find((x) => x.id === id);
  if (!l) return null;
  // Launchers are programs the owner wants to SEE, so their window is not hidden (windowsHide could start a GUI hidden).
  if (/^https:/i.test(l.path)) {
    const url = checkUrl(l.path);
    return url ? { file: explorer(), args: [url], opts: spawnOpts(false) } : null;
  }
  if (!DRIVE_PATH.test(l.path)) return null; // stored lists are re-checked here, not only when they were added
  const ext = path.win32.extname(l.path).toLowerCase();
  if (ext === '.exe') return { file: l.path, args: l.args.slice(), opts: spawnOpts(false) };
  // .lnk is opened by explorer.exe (the path is its one argument). Batch files go through cmd.exe /d /c with the path
  // as ONE argument; their path and arguments passed validateLauncher's strict charset (see isBatch), because cmd.exe
  // parses them itself. Nothing is ever joined into a command-line string by us.
  if (ext === '.lnk') return { file: explorer(), args: [l.path], opts: spawnOpts(false) };
  if (isBatch(l.path)) {
    if (BATCH_UNSAFE.test(l.path) || l.args.some((a) => !BATCH_ARG.test(a))) return null;
    return { file: sys('cmd.exe'), args: ['/d', '/c', l.path, ...l.args], opts: spawnOpts(false) };
  }
  return null;
}

function spawnOpts(hide) {
  return { shell: false, windowsHide: hide === true, detached: true, stdio: 'ignore' };
}

/** At most one action per 2 s and 6 per minute per session. [now] is an injected clock. */
class RateLimiter {
  constructor(now = Date.now) { this.now = now; this.times = []; }
  /** Returns true and records the attempt when allowed. */
  take() {
    const t = this.now();
    this.times = this.times.filter((x) => t - x < WINDOW_MS);
    const last = this.times[this.times.length - 1];
    if (last !== undefined && t - last < MIN_GAP_MS) return false;
    if (this.times.length >= MAX_PER_WINDOW) return false;
    this.times.push(t);
    return true;
  }
}

/**
 * The whole decision for one phone request, in the order the phone is told about it. [cfg] is the store's view
 * ({allowActions, allowControl, actionsEnabled, launchers}), [slot] the paired phone, [limiter] its session's limiter,
 * [run] the injected runner ({file,args,opts}) => void|Promise. Returns {ok, reason?} or null when the id is unknown
 * (malformed id or not an object: nothing is sent back) and never throws. A well-formed id the host does not have
 * (a launcher removed while the phone still shows it) is answered `unknown`; nothing is run.
 */
async function handle(msg, { cfg, slot, limiter, run, log }) {
  const id = msg && msg.id;
  if (!validId(id)) return null;
  const confirm = msg.confirm === true;
  const note = (outcome) => { try { if (log) log(`action ${id}: ${outcome}`); } catch { /* logging must not matter */ } };
  const cat = catalogue(cfg).find((r) => r.id === id);
  if (!cat) { note('unknown'); return { id, ok: false, reason: 'unknown' }; }
  if (cfg.allowActions !== true || !cat.enabled) { note('disabled'); return { id, ok: false, reason: 'disabled' }; }
  if (cfg.allowControl !== true || (slot && slot.viewOnly === true) || !slot) { note('view-only'); return { id, ok: false, reason: 'view-only' }; }
  if (cat.danger && !confirm) { note('confirm'); return { id, ok: false, reason: 'confirm' }; } // not counted against the rate limit
  if (!limiter.take()) { note('rate'); return { id, ok: false, reason: 'rate' }; }
  const sp = buildSpawn(id, cfg);
  if (!sp) { note('failed'); return { id, ok: false, reason: 'failed' }; }
  try {
    await run(sp);
  } catch {
    note('failed');
    return { id, ok: false, reason: 'failed' };
  }
  note('ok');
  return { id, ok: true };
}

/**
 * Real runner: starts the process detached, with no shell, and resolves once it started (or rejects when it could
 * not). Never waits for it to finish (a launcher may run for hours) and never reads its output.
 */
function spawnRunner(spawn = require('child_process').spawn) {
  return ({ file, args, opts }) => new Promise((resolve, reject) => {
    let child;
    try { child = spawn(file, args, opts); } catch (e) { reject(e); return; }
    child.once('error', reject);
    child.once('spawn', () => { try { child.unref(); } catch { /* ignore */ } resolve(); });
  });
}

module.exports = {
  BUILTINS, DEFAULT_ENABLED, MAX_LAUNCHERS, MAX_LABEL, MAX_ARGS, MIN_GAP_MS, WINDOW_MS, MAX_PER_WINDOW, SHUTDOWN_DELAY_S,
  validId, newId, checkUrl, checkFilePath, validateLauncher, sanitizeLaunchers, addLauncher, removeLauncher,
  enabledSet, catalogue, phoneList, setEnabled, buildSpawn, RateLimiter, handle, spawnRunner,
};
