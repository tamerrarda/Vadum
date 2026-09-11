// 20-ARCHITECTURE: core is the package a reviewer reads, so it must stay small enough to read. The
// budget is on source bytes, excluding tests (plan/questions/stream-0.md records the number).
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUDGET_BYTES = 64 * 1024;
const src = fileURLToPath(new URL('../packages/core/src/', import.meta.url));

const walk = (dir) =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

const sources = walk(src).filter((file) => file.endsWith('.ts') && !/\.(test|spec)\.ts$/.test(file));
const bytes = sources.reduce((sum, file) => sum + statSync(file).size, 0);

if (bytes > BUDGET_BYTES) {
  console.error(`check-core-size: FAILED — ${bytes} bytes of source, budget ${BUDGET_BYTES}`);
  process.exit(1);
}
console.log(`check-core-size: ok — ${bytes} / ${BUDGET_BYTES} bytes across ${sources.length} files`);
