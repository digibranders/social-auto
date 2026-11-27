import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AUTO_POST_BY } from './auto-posting.ts';
import { writeConnected } from './connected-networks.ts';
import { CopyStage } from './copy-stage.ts';
import { ProductBrands } from './product-brands.ts';
import { createReviewServer } from './review-server.ts';

const PRODUCT = 'brandbasket-secret-0123456789';
const NOW = '2026-11-12T06:30:00Z';
const post = (id: string, date: string) => ({ postId: id, date, headline: `Headline ${id}`, caption: `Caption ${id}`, captions: { instagram: { text: `ig ${id}` } } });
const wait = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** A product brand with one Instagram-only written batch, a review service whose automatic pass runs every `everyMs` (the weekly draw is off). */
async function start(everyMs: number) {
  const root = mkdtempSync(join(tmpdir(), 'auto-timer-'));
  const brandsRoot = join(root, 'brands');
  const dir = join(brandsRoot, 'bb-acme');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'brand.json'), JSON.stringify({ name: 'Acme', website: 'https://acme.example' }));
  new ProductBrands(brandsRoot).claim('bb-acme', 'brandbasket', () => false);
  const copy = new CopyStage(dir, 'bb-acme');
  copy.open('week-01.json', [post('w1-d1', '2026-11-16'), post('w1-d2', '2026-11-17')]);
  writeConnected(dir, ['instagram']);
  const server = createReviewServer({ brandsRoot, secret: 'staff-secret-0123456789', jobsRoot: join(root, 'jobs'), products: [{ id: 'brandbasket', secret: PRODUCT }], ledgerFile: join(root, 'none.jsonl'), now: () => new Date(NOW), weeklyDrawEveryMs: 0, autoPostingEveryMs: everyMs });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, body?: unknown, method?: string): Promise<Response> => fetch(`${base}${path}`, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { Authorization: `Bearer ${PRODUCT}`, 'X-Brand': 'bb-acme', 'X-Actor': 'brandbasket:user-42', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const states = (): string[] => new CopyStage(dir, 'bb-acme').list().flatMap((b) => b.posts.map((p) => p.state));
  return { call, states, done: async () => { await new Promise((resolve) => server.close(resolve)); rmSync(root, { recursive: true, force: true }); } };
}

test('the automatic pass runs on its own short timer, not only with the weekly draw: written topics are kept within moments', async () => {
  const s = await start(30);
  try {
    const saved = await s.call('/review/auto-posting', { channels: ['instagram'], safetyHours: 0, by: 'brandbasket:user-42' }, 'PUT');
    assert.equal(saved.status, 200);
    await wait(400);
    assert.deepEqual(s.states(), ['kept', 'kept']);
  } finally {
    await s.done();
  }
});

test('saving the choice runs the pass at once, even when the timer is off', async () => {
  const s = await start(0);
  try {
    assert.deepEqual(s.states(), ['pending', 'pending']);
    const saved = await s.call('/review/auto-posting', { channels: ['instagram'], safetyHours: 0, by: 'brandbasket:user-42' }, 'PUT');
    assert.equal(saved.status, 200);
    assert.deepEqual(s.states(), ['kept', 'kept']);
  } finally {
    await s.done();
  }
});

test('a customer who did not choose automatic posting is left alone by the timer', async () => {
  const s = await start(30);
  try {
    await wait(300);
    assert.deepEqual(s.states(), ['pending', 'pending']);
    assert.equal(AUTO_POST_BY, 'system:auto-posting');
  } finally {
    await s.done();
  }
});
