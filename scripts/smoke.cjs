'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const executable = process.argv[2] ? path.resolve(process.argv[2]) : require('electron');
const packaged = Boolean(process.argv[2]);
const version = require('../package.json').version;

async function launch(config, configPath) {
  await fs.writeFile(configPath, JSON.stringify(config));
  return new Promise((resolve, reject) => {
    const env = { ...process.env, FUNDSIFT_SMOKE_CONFIG: configPath };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(executable, packaged ? [] : ['.'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Smoke run timed out\n' + output.slice(-3000))); }, 55000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', async code => {
      clearTimeout(timer);
      try {
        const result = JSON.parse(await fs.readFile(config.result, 'utf8'));
        if (!result.ok || code !== 0) throw new Error(JSON.stringify(result) + '\n' + output.slice(-3000));
        resolve(result);
      } catch (error) { reject(new Error(error.message + '\n' + output.slice(-3000))); }
    });
  });
}

async function seedLegacy(workspace, profile) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/run-electron-node.cjs', 'scripts/seed-v1-smoke.cjs', workspace, profile], {
      cwd: root, windowsHide: true, stdio: 'inherit'
    });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('Legacy fixture failed: ' + code)));
  });
}

(async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'fundsift-m0-smoke-'));
  const profile = path.join(temp, 'profile');
  const workspace = path.join(temp, 'workspace');
  await fs.mkdir(profile);
  const output = path.join(root, 'artifacts', 'm0-hardening-' + version + (packaged ? '-packaged' : '-development'));
  await fs.mkdir(output, { recursive: true });
  const results = [];
  const { createImportFixtures, createFailedImportFixture } = require('./import-smoke-fixtures.cjs');
  const importDirectory = path.join(temp, 'import-fixtures');
  const importFixtures = createImportFixtures(importDirectory);
  const failedFixture = createFailedImportFixture(importDirectory);
  const exportFolder = path.join(temp, 'export-output');
  await fs.mkdir(exportFolder);
  const legacyWorkspace = path.join(temp, 'legacy-workspace'), legacyProfile = path.join(temp, 'legacy-profile');
  await seedLegacy(legacyWorkspace, legacyProfile);
  const upgrade = { phase: 'upgrade', profile: legacyProfile, workspace: legacyWorkspace, result: path.join(output, 'upgrade.json'), screenshot: path.join(output, 'upgrade.png') };
  results.push(await launch(upgrade, path.join(temp, 'upgrade.json')));
  console.log('PASS ' + (packaged ? 'packaged ' : '') + 'v1 upgrade');
  for (const phase of ['create', 'reopen']) {
    const config = { phase, profile, workspace, ...(phase === 'create' ? {
      importFixtures: [...importFixtures, importFixtures[0], failedFixture], exportFolder
    } : {}), result: path.join(output, phase + '.json'), screenshot: path.join(output, phase + '.png') };
    results.push(await launch(config, path.join(temp, phase + '.json')));
    console.log('PASS ' + (packaged ? 'packaged ' : '') + phase);
  }
  console.log('Screenshots and results:', output);
  console.log('Synthetic temporary workspace:', temp);
})().catch(error => { console.error(error); process.exitCode = 1; });
