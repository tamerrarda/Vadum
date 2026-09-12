import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Listed rather than globbed: `apps/*` also matches AIRPLANE-MODE-CHECKLIST.md, which vitest reads
    // as a project config. Add an app here when it gets its first test.
    projects: ['packages/*', 'apps/shared'],
    passWithNoTests: true,
  },
});
