// Gate G1 (D34): no stub body from the stub-first protocol may survive in core. The code itself is a
// legitimate member of the VadumErrorCode union, so the check looks for it being thrown.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = fileURLToPath(new URL('../packages/core/src/', import.meta.url));
const stub = /new\s+VadumError\(\s*['"`]INTERNAL_NOT_IMPLEMENTED['"`]/;

const walk = (dir) =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

const offenders = walk(src).filter((file) => file.endsWith('.ts') && stub.test(readFileSync(file, 'utf8')));

for (const file of offenders) console.error(`  stub body in ${file}`);
if (offenders.length > 0) {
  console.error('check-no-stubs: FAILED — gate G1 requires every core function implemented');
  process.exit(1);
}
console.log('check-no-stubs: ok');
