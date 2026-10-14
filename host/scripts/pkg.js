// Packages the Windows app (no asar, so the koffi native module loads from disk).
const { packager } = require('@electron/packager');
const { version } = require('../package.json');
packager({
  dir: '.', name: 'GlidrScreen', platform: 'win32', arch: 'x64', out: 'dist', overwrite: true, asar: false,
  icon: 'build/icon.ico', appVersion: version, ignore: [/^\/dist/, /^\/test/, /^\/scripts/],
}).then((p) => console.log('packaged:', p.join(', '))).catch((e) => { console.error(e); process.exit(1); });
