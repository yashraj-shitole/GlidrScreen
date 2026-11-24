'use strict';
// Windows "start with Windows" entry: self-repair. The entry is a registry value that points at one specific
// GlidrScreen.exe. When that copy is later moved, deleted or left half-extracted (a Downloads folder cleaned up,
// an unzip that stopped), Windows starts nothing at login and the phone waits for a PC that is not running.
// Electron's getLoginItemSettings only reports entries that point at the running exe, so the registry is read directly.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

/** Executable path from `reg query` output: `    name    REG_SZ    "C:\\app\\GlidrScreen.exe" --hidden`. */
function parseRunValue(out) {
  const m = /REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m.exec(String(out));
  if (!m) return null;
  const v = m[1].trim();
  const quoted = /^"([^"]+)"/.exec(v);
  return quoted ? quoted[1] : v.replace(/\s+--.*$/, '');
}

function samePath(a, b) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

/** A build that cannot start: the exe is gone, or Chromium's data files next to it are missing. */
function isBroken(exe, exists = fs.existsSync) {
  const dir = path.dirname(exe);
  return !exists(exe) || !exists(path.join(dir, 'icudtl.dat')) || !exists(path.join(dir, 'resources.pak'));
}

/** Another copy is registered and it cannot start. A working other copy is left alone. */
function needsRepair(registered, execPath, exists = fs.existsSync) {
  return !!registered && !samePath(registered, execPath) && isBroken(registered, exists);
}

function queryRegistered(valueName) {
  return new Promise((resolve) => {
    execFile('reg', ['query', RUN_KEY, '/v', valueName], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      resolve(err ? null : parseRunValue(stdout));
    });
  });
}

/**
 * Re-registers the running exe when the registered one is broken.
 * @param {{execPath: string, register: () => void, exists?: Function, query?: Function}} o
 * @returns {Promise<boolean>} whether the entry was repointed
 */
async function repairAutostart({ execPath, register, exists = fs.existsSync, query = queryRegistered }) {
  const valueName = 'electron.app.' + path.basename(execPath, path.extname(execPath));
  const registered = await query(valueName);
  if (!needsRepair(registered, execPath, exists)) return false;
  register();
  return true;
}

module.exports = { parseRunValue, isBroken, needsRepair, repairAutostart };
