import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReviewServer } from './review-server.ts';
import { ProductBrands } from './product-brands.ts';
import { ReviewStore } from './review-store.ts';
import { JobStore } from './job-store.ts';
import { CopyStage } from './copy-stage.ts';

const PRODUCT = 'brandbasket-secret-0123456789';
const STAFF = 'staff-secret-0123456789';
const THURSDAY = new Date('2026-11-12T06:30:00Z');

/** A product brand and a staff brand, a ledger the test fills, and the review service reading it. */
async function start() {
  const root = mkdtempSync(join(tmpdir(), 'picture-limit-'));
  const brandsRoot = join(root, 'brands');
  for (const brand of ['bb-acme', 'staffco']) {
    mkdirSync(join(brandsRoot, brand), { recursive: true });
    writeFileSync(join(brandsRoot, brand, 'brand.json'), JSON.stringify({ name: brand, website: `https://${brand}.example` }));
    writeFileSync(join(brandsRoot, brand, 'week-01.json'), JSON.stringify({ brand, timezone: '+05:30', renderMode: 'ai_v1', posts: [{ id: 'w01-d1', date: '2099-11-10T10:00:00+05:30', painPoint: 'p', mode: 'ai', headline: 'Answers', subline: '', caption: 'C', hashtags: [], imagePrompt: 'a picture' }] }));
  }
  new ProductBrands(brandsRoot).claim('bb-acme', 'brandbasket', () => false);
  const ledger = join(root, 'ledger', 'paid-calls.jsonl');
  mkdirSync(join(root, 'ledger'));
  let n = 0;
  const bought = (brandId: string, network: string | undefined, over: Record<string, unknown> = {}): void => {
    n += 1;
    const call = { callId: `c${n}`, jobId: 'j', tenantId: 'owner', brandId, postId: `${brandId}-p${n}`, ...(network ? { network } : {}), operation: 'image', model: 'm', requestHash: `h${n}`, status: 'completed', reservedCostUsd: 0.02, createdAt: '2026-11-11T05:00:00Z', ...over };
    appendFileSync(ledger, `${JSON.stringify({ type: 'reserve', call })}\n`);
  };
  const server = createReviewServer({ brandsRoot, secret: STAFF, jobsRoot: join(root, 'jobs'), products: [{ id: 'brandbasket', secret: PRODUCT }], ledgerFile: ledger, now: () => THURSDAY });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, body?: unknown): Promise<Response> => fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${PRODUCT}`, 'X-Brand': 'bb-acme', 'X-Actor': 'brandbasket:user-42', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const staff = (path: string): Promise<Response> => fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${STAFF}` } });
  return { root, brandsRoot, bought, call, staff, jobs: new JobStore(join(root, 'jobs')), done: async () => { await new Promise((resolve) => server.close(resolve)); rmSync(root, { recursive: true, force: true }); } };
}

type Limits = { brand: string; week: { from: string; to: string; restart: string }; limit: number; channels: Array<{ network: string; limit: number; used: number; left: number }> };

test('a customer reads what is left for each channel this week; failed tries, other weeks, other brands and carousel slides are not counted', async () => {
  const s = await start();
  try {
    for (let i = 0; i < 7; i += 1) s.bought('bb-acme', 'instagram');
    for (let i = 0; i < 2; i += 1) s.bought('bb-acme', 'facebook');
    s.bought('bb-acme', 'facebook', { status: 'failed' });
    s.bought('bb-acme', 'linkedin', { createdAt: '2026-11-08T18:29:00Z' });
    s.bought('bb-acme', undefined);
    s.bought('staffco', 'google');
    const answer = await s.call('/review/limits');
    assert.equal(answer.status, 200);
    const limits = (await answer.json()) as Limits;
    assert.deepEqual(limits.week, { from: '2026-11-09', to: '2026-11-15', restart: '2026-11-16' });
    assert.equal(limits.limit, 7);
    assert.deepEqual(limits.channels.map((c) => [c.network, c.used, c.left]), [['instagram', 7, 0], ['facebook', 2, 5], ['linkedin', 0, 7], ['google', 0, 7]]);
  } finally {
    await s.done();
  }
});

test('staff can read a product brand\'s limits with ?brand=, and a brand that is not a product\'s has none to read', async () => {
  const s = await start();
  try {
    assert.equal((await s.staff('/review/limits?brand=bb-acme')).status, 200);
    assert.equal((await s.staff('/review/limits?brand=staffco')).status, 404, 'our own clients are not limited this way');
    assert.equal((await s.staff('/review/limits')).status, 404);
  } finally {
    await s.done();
  }
});

test('a redraw of a channel that has used its pictures is refused before a job is queued, naming the channel and the day it starts again; another channel is fine', async () => {
  const s = await start();
  try {
    const store = new ReviewStore(join(s.brandsRoot, 'bb-acme'), 'bb-acme');
    const make = (network: string) => store.addVersion({ postId: 'w01-d1', planFile: 'week-01.json', network, width: 1080, height: 1080, headline: 'Answers', caption: 'C', ctaUrl: 'https://bb-acme.example', factIds: ['f1'], evidence: [{ factId: 'f1', text: 't', quote: 'q', url: 'https://bb-acme.example/', context: 'c' }], imagePath: (() => { const p = join(s.root, `${network}.jpg`); writeFileSync(p, network); return p; })(), validation: { accepted: true, readings: 2, defects: [], reportFile: 'r.json' }, attempts: 1, costUsd: 0.016 });
    const ig = make('instagram');
    const fb = make('facebook');
    for (let i = 0; i < 7; i += 1) s.bought('bb-acme', 'instagram');
    const refused = await s.call(`/review/posts/${ig.versionId}/redraw`, {});
    assert.equal(refused.status, 429);
    assert.deepEqual(await refused.json(), { error: 'You have used your 7 Instagram pictures for this week. You can draw more from Monday 16 November.', code: 'PICTURE_LIMIT_REACHED', channel: 'instagram', restart: '2026-11-16' });
    assert.equal(s.jobs.list({ brand: 'bb-acme' }).length, 0, 'nothing was queued');
    assert.equal((await s.call(`/review/posts/${fb.versionId}/redraw`, {})).status, 202);
  } finally {
    await s.done();
  }
});

test('a draw is refused whole when any channel has too few left, counting only the pictures not yet made; with room it is queued', async () => {
  const s = await start();
  try {
    const stage = new CopyStage(join(s.brandsRoot, 'bb-acme'), 'bb-acme');
    stage.open('week-01.json', [{ postId: 'w01-d1', headline: 'Answers', caption: 'Hook.', captions: { instagram: { text: 'ig' }, facebook: { text: 'fb' } } }]);
    stage.decide('week-01.json', 'w01-d1', 'kept', 'u');
    for (let i = 0; i < 7; i += 1) s.bought('bb-acme', 'facebook');
    const refused = await s.call('/review/copy/bb-acme/week-01.json/draw', {});
    assert.equal(refused.status, 429);
    assert.deepEqual(((await refused.json()) as { code: string; channel: string }).channel, 'facebook');
    assert.equal(s.jobs.list({ brand: 'bb-acme' }).length, 0, 'no job, so nothing half drawn');
    // The same draw for a brand of ours is not limited this way.
    const own = new CopyStage(join(s.brandsRoot, 'staffco'), 'staffco');
    own.open('week-01.json', [{ postId: 'w01-d1', headline: 'Answers', caption: 'Hook.', captions: { instagram: { text: 'ig' }, facebook: { text: 'fb' } } }]);
    own.decide('week-01.json', 'w01-d1', 'kept', 'u');
    for (let i = 0; i < 9; i += 1) s.bought('staffco', 'facebook');
    const staffDraw = await fetch(`${(await s.staff('/review/limits?brand=staffco')).url.split('/review')[0]}/review/copy/staffco/week-01.json/draw`, { method: 'POST', headers: { Authorization: `Bearer ${STAFF}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ by: 'owner' }) });
    assert.equal(staffDraw.status, 202);
  } finally {
    await s.done();
  }
});

test('adding a network to a drawn batch is refused when the new channel has too few left for every kept topic, and is not refused on a batch not yet drawn', async () => {
  const s = await start();
  try {
    const stage = new CopyStage(join(s.brandsRoot, 'bb-acme'), 'bb-acme');
    stage.open('week-01.json', [{ postId: 'w01-d1', headline: 'Answers', caption: 'Hook.', captions: { instagram: { text: 'ig' } } }]);
    stage.decide('week-01.json', 'w01-d1', 'kept', 'u');
    for (let i = 0; i < 7; i += 1) s.bought('bb-acme', 'google');
    const waiting = await s.call('/review/copy/bb-acme/week-01.json/networks', { network: 'google' });
    assert.equal(waiting.status, 202, 'only words are written for a batch not yet drawn');
    s.jobs.claim(1, 1);
    s.jobs.update(((await waiting.json()) as { job: { id: string } }).job.id, { state: 'failed', error: { code: 'X', message: 'x' } });
    stage.markDrawn('week-01.json');
    const drawn = await s.call('/review/copy/bb-acme/week-01.json/networks', { network: 'google' });
    assert.equal(drawn.status, 429);
    assert.equal(((await drawn.json()) as { channel: string }).channel, 'google');
  } finally {
    await s.done();
  }
});
