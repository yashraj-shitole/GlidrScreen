// Builds the per-user NSIS installer (host/dist-installer/GlidrScreen-<version>-setup.exe) from the packaged app folder.
// The folder is made by scripts/pkg.js (npm run dist); it is rebuilt here when missing or when it is another version.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { version } = require('../package.json');

const root = path.join(__dirname, '..');
const packaged = path.join(root, 'dist', 'GlidrScreen-win32-x64');

function packagedVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(packaged, 'resources', 'app', 'package.json'), 'utf8')).version; } catch { return null; }
}

function run(script, args) {
  const r = spawnSync(process.execPath, [script, ...args], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) { console.error(`failed: ${path.basename(script)} (exit ${r.status})`); process.exit(r.status || 1); }
}

if (packagedVersion() !== version) {
  console.log(`packaging the app first (${packagedVersion() ? `found ${packagedVersion()}, need ${version}` : 'no packaged folder'})`);
  run(path.join(__dirname, 'pkg.js'), []);
}
run(require.resolve('electron-builder/cli.js'), ['--prepackaged', packaged, '--win', 'nsis', '--x64', '--publish', 'never']);
const out = path.join(root, 'dist-installer', `GlidrScreen-${version}-setup.exe`);
if (!fs.existsSync(out)) { console.error(`expected ${out}`); process.exit(1); }
console.log(`installer: ${out} (${(fs.statSync(out).size / 1048576).toFixed(1)} MB)`);
