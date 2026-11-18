'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
function run(command, args, env = {}) {
  const result = spawnSync(command, args, { cwd: root, env: { ...process.env, ...env }, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
for (const dir of ['code/desktop', 'scripts', 'code/prototype']) {
  for (const name of fs.readdirSync(path.join(root, dir))) {
    if (/\.(c?js)$/.test(name)) run(process.execPath, ['--check', path.join(dir, name)]);
  }
}
run(process.execPath, ['code/prototype/checks/intro.check.cjs']);
run(process.execPath, ['code/prototype/checks/prototype.check.cjs']);
run(process.execPath, ['code/prototype/checks/desktop.check.cjs']);
run(process.execPath, ['code/prototype/checks/onboarding.check.cjs']);
const storageChecks = fs.readdirSync(path.join(root, 'code/desktop/checks')).filter(name => name.endsWith('.check.cjs')).map(name => 'code/desktop/checks/' + name);
run(process.execPath, ['scripts/run-electron-node.cjs', '--test', ...storageChecks]);
