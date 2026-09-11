// D33: the fixture generator's reference modules are exported for tooling (tools/phase0) only. A
// stream that imports them tests its code against a copy of its own reference, which proves nothing.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const scanned = ['packages/core', 'packages/wire', 'packages/client', 'apps'];

const walk = (dir) =>
  readdirSync(dir).flatMap((entry) => {
    if (entry === 'node_modules' || entry === 'dist') return [];
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

const offenders = scanned
  .map((dir) => join(root, dir))
  .filter((dir) => existsSync(dir))
  .flatMap(walk)
  .filter((file) => /\.(ts|tsx|js|mjs|cjs)$/.test(file) && readFileSync(file, 'utf8').includes('@vadum/fixtures/reference'));

for (const file of offenders) console.error(`  ${file} imports @vadum/fixtures/reference`);
if (offenders.length > 0) {
  console.error('check-reference-imports: FAILED (D33) — build from the specs; use @vadum/fixtures for data only');
  process.exit(1);
}
console.log('check-reference-imports: ok — no stream imports the reference modules');
