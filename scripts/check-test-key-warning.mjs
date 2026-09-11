// 24-SPEC: the fixture seeds are test keys and must say so, so nobody quietly swaps in real material.
import { readFileSync } from 'node:fs';

const WARNING = 'DEVNET TEST KEYS. Zero value. Deterministic on purpose. Never reuse anywhere real.';
const problems = [];

const seeds = readFileSync(new URL('../packages/fixtures/src/seeds.ts', import.meta.url), 'utf8');
if (!seeds.includes(WARNING)) problems.push('packages/fixtures/src/seeds.ts lacks the test-key warning');

const fixtures = JSON.parse(readFileSync(new URL('../packages/fixtures/fixtures.json', import.meta.url), 'utf8'));
if (typeof fixtures._warning !== 'string' || !fixtures._warning.startsWith('DEVNET TEST KEYS.')) {
  problems.push('packages/fixtures/fixtures.json lacks the _warning header');
}

for (const problem of problems) console.error(`  ${problem}`);
if (problems.length > 0) {
  console.error('check-test-key-warning: FAILED');
  process.exit(1);
}
console.log('check-test-key-warning: ok');
