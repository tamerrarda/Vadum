// Turns Vite's build manifest into the service worker's precache list (C1, C-2 in
// plan/questions/stream-c.md). No service-worker plugin is in the catalog, and adding a dependency
// needs a decision record, so this is the whole build step.
//
//   node scripts/build-precache.mjs apps/payer/dist
//
// Every emitted asset goes in, plus index.html and the manifest, plus the zxing .wasm — which is the
// one file whose absence leaves the iOS scanner dead with the radio off (D10).

import { createHash } from 'node:crypto';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

const [distArgument] = process.argv.slice(2);
if (distArgument === undefined) {
  console.error('usage: node scripts/build-precache.mjs <dist directory>');
  process.exit(2);
}

const dist = distArgument;

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? walk(path) : [path];
    }),
  );
  return files.flat();
}

const files = (await walk(dist))
  .map((path) => `/${relative(dist, path).split(sep).join('/')}`)
  .filter((path) => !path.endsWith('/precache-manifest.json') && !path.startsWith('/.vite/'))
  .sort();

if (!files.includes('/index.html')) {
  console.error(`build-precache: ${dist} has no index.html — the navigation fallback would never work`);
  process.exit(1);
}
const wasm = files.filter((path) => path.endsWith('.wasm'));
if (wasm.length === 0) {
  console.error('build-precache: no .wasm in the build. The scanner would fetch it from a CDN, which fails offline (D10)');
  process.exit(1);
}

// A digest of the file list and their bytes: the service worker uses it as its cache name, so a new
// build replaces the old cache instead of serving a half-updated shell.
const digest = createHash('sha256');
for (const path of files) {
  digest.update(path);
  digest.update(await readFile(join(dist, path.slice(1))));
}
const version = digest.digest('hex').slice(0, 16);

const manifest = { version, files };
await writeFile(join(dist, 'precache-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const bytes = (await Promise.all(files.map(async (path) => (await stat(join(dist, path.slice(1)))).size))).reduce((total, size) => total + size, 0);
console.log(`build-precache: ${files.length} files, ${(bytes / 1024).toFixed(0)} KiB, version ${version} (wasm: ${wasm.join(', ')})`);
