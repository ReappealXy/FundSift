'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

async function collectInstalledFiles(directory, parents = []) {
  const files = [];
  const entries = await fs.readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  for (const entry of entries) {
    const relative = [...parents, entry.name];
    if (entry.isDirectory()) {
      files.push(...await collectInstalledFiles(path.join(directory, entry.name), relative));
    } else if (entry.isFile()) {
      files.push(relative.join('\\'));
    } else {
      throw new Error('Unsupported entry in installer payload: ' + relative.join('/'));
    }
  }
  return files;
}

exports.default = async function createRemovalManifest(context) {
  if (!context.targets.some(target => target.name === 'nsis')) return;
  const files = await collectInstalledFiles(context.appOutDir);
  const manifestPath = await context.packager.getTempFile('fundsift-installed-files.json');
  await fs.writeFile(manifestPath, JSON.stringify(files), 'utf8');
  // Each build gets its own manifest, including simultaneous builds of the same version.
  process.env.FUNDSIFT_NSIS_REMOVAL_MANIFEST = manifestPath;
};
