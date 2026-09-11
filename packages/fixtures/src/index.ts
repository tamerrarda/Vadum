// @vadum/fixtures — golden vectors per plan/24-SPEC-fixtures.md. Read them; never edit them.

import data from '../fixtures.json' with { type: 'json' };
import type { FixtureFile } from './types.ts';

export const fixtures = data as unknown as FixtureFile;
export * from './seeds.ts';
export type * from './types.ts';
