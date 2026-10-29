import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

/**
 * Vercel compiles each .ts to .js but leaves import specifiers as written, so a runtime import that ends in
 * ".ts" cannot be found in production (it broke the live posting job once). Source must say ".js".
 */
test('deployed code imports its own modules with .js endings', () => {
  const root = join(import.meta.dirname, '..');
  const offenders: string[] = [];
  for (const dir of ['api', 'lib']) {
    for (const file of readdirSync(join(root, dir))) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
      const source = readFileSync(join(root, dir, file), 'utf8');
      for (const match of source.matchAll(/from\s+'(\.{1,2}\/[^']*\.ts)'/g)) offenders.push(`${dir}/${file}: ${match[1]}`);
    }
  }
  assert.deepEqual(offenders, []);
});
