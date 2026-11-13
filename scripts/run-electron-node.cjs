'use strict';
const { spawn } = require('node:child_process');
const electron = require('electron');
const child = spawn(electron, process.argv.slice(2), {
  cwd: require('node:path').resolve(__dirname, '..'),
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: 'inherit', windowsHide: true
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
