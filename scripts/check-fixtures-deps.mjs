// D33: packages/fixtures is an independent reference implementation. Fixtures produced by the code
// they are meant to test prove nothing, so the package may neither depend on nor import @vadum/*.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../packages/fixtures/', import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const problems = [];

for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
  for (const name of Object.keys(manifest[field] ?? {})) {
    if (name === 'vadum' || name.startsWith('@vadum/')) problems.push(`package.json ${field} lists ${name}`);
  }
}

const walk = (dir) =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

const importsVadum = /(?:from\s+|import\s*\(\s*|import\s+)['"](?:vadum|@vadum\/)/;
for (const file of walk(join(root, 'src'))) {
  if (importsVadum.test(readFileSync(file, 'utf8'))) problems.push(`${file} imports a @vadum/* package`);
}

for (const problem of problems) console.error(`  ${problem}`);
if (problems.length > 0) {
  console.error('check-fixtures-deps: FAILED (D33)');
  process.exit(1);
}
console.log('check-fixtures-deps: ok — packages/fixtures is independent of @vadum/*');
