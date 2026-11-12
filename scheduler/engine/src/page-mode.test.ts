import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pageModeBlocked } from './page-mode.ts';
import { FACTS_FILE, FACTS_VERSION } from './evidence-pipeline.ts';

const dir = (): { path: string; done: () => void } => {
  const path = mkdtempSync(join(tmpdir(), 'page-mode-'));
  return { path, done: () => rmSync(path, { recursive: true, force: true }) };
};

test('a one-page read is allowed for a website that was never read, and for one whose first try left a profile but no facts', async () => {
  const d = dir();
  try {
    assert.equal(await pageModeBlocked(d.path), false, 'nothing saved');
    writeFileSync(join(d.path, 'brand.json'), '{}');
    assert.equal(await pageModeBlocked(d.path), false, 'a profile with no facts: the first try did not finish, so a page may be read again');
    writeFileSync(join(d.path, FACTS_FILE), 'not json');
    assert.equal(await pageModeBlocked(d.path), false, 'a facts file that cannot be read is not a finished read');
  } finally {
    d.done();
  }
});

test('a one-page read is refused for a website that already has a profile with its facts', async () => {
  const d = dir();
  try {
    writeFileSync(join(d.path, 'brand.json'), '{}');
    writeFileSync(join(d.path, FACTS_FILE), JSON.stringify({ version: FACTS_VERSION, builtAt: '2026-11-01T00:00:00.000Z', facts: [], snapshots: [] }));
    assert.equal(await pageModeBlocked(d.path), true);
  } finally {
    d.done();
  }
});
