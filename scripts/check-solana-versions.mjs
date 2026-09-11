// D1: no two versions of any @solana/* package may coexist in the lockfile. The canonical message's
// byte-level determinism is a property of one compiler version, so a second copy is a silent fork.
import { readFileSync } from 'node:fs';

const lock = readFileSync(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8');
const versions = new Map();
for (const [, name, version] of lock.matchAll(/^ {2}'?(@solana\/[^@'\s]+)@([^('\s:]+)/gm)) {
  if (!versions.has(name)) versions.set(name, new Set());
  versions.get(name).add(version);
}

if (versions.size === 0) {
  console.error('check-solana-versions: no @solana/* entries found in pnpm-lock.yaml — is the pattern out of date?');
  process.exit(1);
}

const duplicates = [...versions].filter(([, found]) => found.size > 1);
for (const [name, found] of duplicates) console.error(`  ${name}: ${[...found].join(', ')}`);
if (duplicates.length > 0) {
  console.error('check-solana-versions: FAILED — pin the package in the pnpm catalog (D1)');
  process.exit(1);
}
console.log(`check-solana-versions: ok — ${versions.size} @solana/* packages, one version each`);
