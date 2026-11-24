'use strict';
const assert = require('assert');
const { parseRunValue, isBroken, needsRepair, repairAutostart } = require('../src/autostart');

const out = '\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\r\n'
  + '    electron.app.GlidrScreen    REG_SZ    "C:\\Users\\me\\Downloads\\GlidrScreen\\GlidrScreen.exe" --hidden\r\n\r\n';
assert.strictEqual(parseRunValue(out), 'C:\\Users\\me\\Downloads\\GlidrScreen\\GlidrScreen.exe');
assert.strictEqual(parseRunValue('    x    REG_SZ    C:\\a b\\g.exe --hidden\r\n'), 'C:\\a b\\g.exe');
assert.strictEqual(parseRunValue('nothing here'), null);

const all = () => true;
const noIcu = (p) => !/icudtl\.dat$/.test(p);
assert.strictEqual(isBroken('C:\\a\\g.exe', all), false);
assert.strictEqual(isBroken('C:\\a\\g.exe', noIcu), true); // the half-extracted 1.0.1 folder
assert.strictEqual(isBroken('C:\\a\\g.exe', () => false), true);

const mine = 'C:\\new\\GlidrScreen.exe';
assert.strictEqual(needsRepair('C:\\old\\GlidrScreen.exe', mine, noIcu), true);
assert.strictEqual(needsRepair('c:\\NEW\\glidrscreen.exe', mine, noIcu), false); // already me, any case
assert.strictEqual(needsRepair('C:\\old\\GlidrScreen.exe', mine, all), false); // other copy that works: leave it
assert.strictEqual(needsRepair(null, mine, noIcu), false); // autostart is off

(async () => {
  let registered = 0;
  const run = (q, ex) => repairAutostart({ execPath: mine, register: () => { registered++; }, exists: ex, query: async () => q });
  assert.strictEqual(await run('C:\\old\\GlidrScreen.exe', noIcu), true);
  assert.strictEqual(registered, 1);
  assert.strictEqual(await run(null, noIcu), false);
  assert.strictEqual(await run('C:\\old\\GlidrScreen.exe', all), false);
  assert.strictEqual(registered, 1);
  console.log('ok');
})();
