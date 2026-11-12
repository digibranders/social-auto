import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CopyStage, CopyStageError, weekOfPost, weeksOf } from './copy-stage.ts';
import { createReviewServer } from './review-server.ts';
import { ProductBrands } from './product-brands.ts';
import { JobStore } from './job-store.ts';
import { engineArgs } from './job-runner.ts';
import { mondayOf } from './picture-limit.ts';

const W1 = '2026-11-16';
const W2 = '2026-11-23';
const post = (id: string, date: string) => ({ postId: id, date, headline: `Headline ${id}`, caption: `Caption ${id}`, captions: { instagram: { text: `ig ${id}` }, facebook: { text: `fb ${id}` } } });
const posts = [post('w1-d1', '2026-11-16'), post('w1-d2', '2026-11-17'), post('w2-d1', '2026-11-23'), post('w2-d2', '2026-11-24')];

function stage(): { stage: CopyStage; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'copy-weeks-'));
  const s = new CopyStage(dir, 'bb-acme');
  s.open('week-01.json', posts);
  return { stage: s, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a batch knows its weeks from the days of its posts, Monday to Sunday', () => {
  const s = stage();
  try {
    const batch = s.stage.get('week-01.json');
    assert.deepEqual(weeksOf(batch), [W1, W2]);
    assert.equal(weekOfPost(batch.posts[0] as never), W1);
    assert.equal(mondayOf('2026-11-22'), W1, 'a Sunday belongs to the week that began the Monday before');
    assert.equal(mondayOf('2026-11-23'), W2);
    assert.deepEqual(weeksOf({ posts: [{}, {}] }), [], 'posts with no day make one piece with no weeks');
  } finally {
    s.done();
  }
});

test('drawing one week makes only that week final: its posts cannot be decided or edited, the later week still can', () => {
  const s = stage();
  try {
    s.stage.decide('week-01.json', 'w1-d1', 'kept', 'u');
    s.stage.decide('week-01.json', 'w2-d1', 'kept', 'u');
    s.stage.markWeekDrawn('week-01.json', W1);
    const after = s.stage.get('week-01.json');
    assert.equal(after.drawnAt, undefined, 'the batch is not drawn as a whole while a week is waiting');
    assert.ok(after.weekDrawn?.[W1]);
    const refused = (work: () => unknown): string | undefined => { try { work(); } catch (error) { return error instanceof CopyStageError ? error.code : String(error); } return undefined; };
    assert.equal(refused(() => s.stage.decide('week-01.json', 'w1-d1', 'dropped', 'u')), 'ALREADY_DRAWN');
    assert.equal(refused(() => s.stage.decide('week-01.json', 'w1-d2', 'kept', 'u')), 'ALREADY_DRAWN', 'a post of the drawn week not yet decided is final too');
    assert.equal(refused(() => s.stage.edit('week-01.json', 'w1-d1', { headline: 'New', caption: 'New' }, 'u', () => undefined)), 'ALREADY_DRAWN');
    assert.equal(refused(() => s.stage.decide('week-01.json', 'w2-d2', 'kept', 'u')), undefined, 'the later week is still open');
    assert.equal(refused(() => s.stage.edit('week-01.json', 'w2-d1', { headline: 'Better headline', caption: 'Caption w2-d1' }, 'u', () => undefined)), undefined);
    assert.equal(s.stage.get('week-01.json').posts.find((p) => p.postId === 'w2-d1')?.headline, 'Better headline');
    assert.equal(refused(() => s.stage.markWeekDrawn('week-01.json', W1)), 'ALREADY_DRAWN', 'a week is never drawn twice');
    assert.equal(refused(() => s.stage.markWeekDrawn('week-01.json', '2030-01-07')), 'NOT_FOUND');
  } finally {
    s.done();
  }
});

test('the batch counts as drawn once every week is drawn or given up, and a given-up week is final', () => {
  const s = stage();
  try {
    s.stage.markWeekDrawn('week-01.json', W1);
    s.stage.markWeekLapsed('week-01.json', W2);
    const batch = s.stage.get('week-01.json');
    assert.ok(batch.drawnAt, 'every week is settled');
    assert.ok(batch.weekLapsed?.[W2]);
    s.stage.markWeekLapsed('week-01.json', W2);
    assert.throws(() => s.stage.decide('week-01.json', 'w2-d1', 'kept', 'u'), CopyStageError);
  } finally {
    s.done();
  }
});

test('the kept posts to draw can be limited to one week, and only kept ones with unchanged words', () => {
  const s = stage();
  try {
    for (const id of ['w1-d1', 'w2-d1', 'w2-d2']) s.stage.decide('week-01.json', id, 'kept', 'u');
    const current = posts.map((p) => ({ postId: p.postId, headline: p.headline, caption: p.caption, captions: { instagram: p.captions.instagram.text, facebook: p.captions.facebook.text } }));
    assert.deepEqual(s.stage.toDraw('week-01.json', current, W2).postIds, ['w2-d1', 'w2-d2']);
    assert.deepEqual(s.stage.toDraw('week-01.json', current, W1).postIds, ['w1-d1']);
    assert.deepEqual(s.stage.toDraw('week-01.json', current).postIds, ['w1-d1', 'w2-d1', 'w2-d2']);
  } finally {
    s.done();
  }
});

test('a draw job carries its week to the engine, and the key keeps the weeks of one batch apart', () => {
  const job = { id: 'j', key: 'k', kind: 'draw', brand: 'bb-acme', site: 'https://a.example', by: 'u', state: 'queued', networks: [], planFile: 'week-01.json', week: W2 } as never;
  assert.deepEqual(engineArgs(job).slice(-4), ['--draw-kept', 'week-01.json', '--draw-week', W2]);
  const dir = mkdtempSync(join(tmpdir(), 'jobs-'));
  try {
    const jobs = new JobStore(dir);
    const spec = { kind: 'draw' as const, brand: 'bb-acme', site: 'https://a.example', by: 'u', planFile: 'week-01.json' };
    const first = jobs.enqueue({ ...spec, week: W1 });
    const second = jobs.enqueue({ ...spec, week: W2 });
    assert.notEqual(first.job.id, second.job.id);
    assert.equal(jobs.enqueue({ ...spec, week: W1 }).created, false, 'the same week asked twice is the same job');
    assert.equal(first.job.week, W1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const PRODUCT = 'brandbasket-secret-0123456789';

async function start(at = '2026-11-12T06:30:00Z', everyMs = 0) {
  const root = mkdtempSync(join(tmpdir(), 'draw-weeks-'));
  const brandsRoot = join(root, 'brands');
  const dir = join(brandsRoot, 'bb-acme');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'brand.json'), JSON.stringify({ name: 'Acme', website: 'https://acme.example' }));
  writeFileSync(join(dir, 'week-01.json'), JSON.stringify({ brand: 'bb-acme', timezone: '+05:30', renderMode: 'ai_v1', posts: posts.map((p) => ({ id: p.postId, date: `${p.date}T10:00:00+05:30`, painPoint: 'p', mode: 'ai', headline: p.headline, subline: '', caption: p.caption, hashtags: [], imagePrompt: 'a picture', variants: { instagram: { caption: p.captions.instagram.text, hashtags: [] }, facebook: { caption: p.captions.facebook.text, hashtags: [] } } })) }));
  new ProductBrands(brandsRoot).claim('bb-acme', 'brandbasket', () => false);
  const copy = new CopyStage(dir, 'bb-acme');
  copy.open('week-01.json', posts);
  const server = createReviewServer({ brandsRoot, secret: 'staff-secret-0123456789', jobsRoot: join(root, 'jobs'), products: [{ id: 'brandbasket', secret: PRODUCT }], ledgerFile: join(root, 'none.jsonl'), now: () => new Date(at), weeklyDrawEveryMs: everyMs });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, body?: unknown, method?: string): Promise<Response> => fetch(`${base}${path}`, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { Authorization: `Bearer ${PRODUCT}`, 'X-Brand': 'bb-acme', 'X-Actor': 'brandbasket:user-42', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { call, copy, jobs: new JobStore(join(root, 'jobs')), done: async () => { await new Promise((resolve) => server.close(resolve)); rmSync(root, { recursive: true, force: true }); } };
}

type Listed = { batches: Array<{ weeks?: Array<{ from: string; to: string; state: string; postIds: string[] }>; posts: Array<{ postId: string; date?: string }> }> };

test('the copy list shows the weeks of a batch with their state; each week is drawn on its own and the rest stay open', async () => {
  const s = await start();
  try {
    for (const id of ['w1-d1', 'w1-d2', 'w2-d1']) assert.equal((await s.call(`/review/copy/bb-acme/week-01.json/${id}/keep`, {})).status, 200);
    const before = (await (await s.call('/review/copy')).json()) as Listed;
    assert.deepEqual(before.batches[0]?.weeks?.map((w) => [w.from, w.to, w.state, w.postIds]), [[W1, '2026-11-22', 'waiting', ['w1-d1', 'w1-d2']], [W2, '2026-11-29', 'waiting', ['w2-d1', 'w2-d2']]]);
    assert.equal(before.batches[0]?.posts[0]?.date, '2026-11-16');

    // No week asked for: the first one not drawn yet.
    const first = await s.call('/review/copy/bb-acme/week-01.json/draw', {});
    assert.equal(first.status, 202, JSON.stringify(await first.clone().json()));
    const job = ((await first.json()) as { job: { id: string; week: string } }).job;
    assert.equal(job.week, W1);
    const again = await s.call('/review/copy/bb-acme/week-01.json/draw', { week: W1 });
    assert.equal(again.status, 200);
    assert.equal(((await again.json()) as { job: { id: string } }).job.id, job.id, 'the same week asked twice is the same job');

    const mid = (await (await s.call('/review/copy')).json()) as Listed;
    assert.deepEqual(mid.batches[0]?.weeks?.map((w) => w.state), ['drawing', 'waiting']);
    // The drawn week is final; the later one can still be changed.
    assert.equal((await s.call('/review/copy/bb-acme/week-01.json/w1-d1/drop', {})).status, 409);
    assert.equal((await s.call('/review/copy/bb-acme/week-01.json/w2-d2/keep', {})).status, 200);

    const second = await s.call('/review/copy/bb-acme/week-01.json/draw', { week: W2 });
    assert.equal(second.status, 202);
    assert.notEqual(((await second.json()) as { job: { id: string } }).job.id, job.id);
    assert.equal((await s.call('/review/copy/bb-acme/week-01.json/draw', { week: '2026-11-30' })).status, 400, 'a week the batch does not have');
    assert.equal((await s.call('/review/copy/bb-acme/week-01.json/draw', { week: 'soon' })).status, 400);
  } finally {
    await s.done();
  }
});

test('a week with nothing kept is not drawn, and a week already settled answers ALREADY_DRAWN', async () => {
  const s = await start();
  try {
    await s.call('/review/copy/bb-acme/week-01.json/w1-d1/keep', {});
    const empty = await s.call('/review/copy/bb-acme/week-01.json/draw', { week: W2 });
    assert.equal(empty.status, 422);
    s.copy.markWeekDrawn('week-01.json', W1);
    const done = await s.call('/review/copy/bb-acme/week-01.json/draw', { week: W1 });
    assert.equal(done.status, 409);
    assert.equal(((await done.json()) as { code: string }).code, 'ALREADY_DRAWN');
  } finally {
    await s.done();
  }
});

test('the review service draws a later week by itself when it is due, for the connected networks only, and never twice', async () => {
  const s = await start('2026-11-19T05:00:00Z', 40);
  try {
    // Thursday 19 November, after 10:00 India time: week 2 is due. Keep a post of it; the service's own pass asks for the draw.
    assert.equal((await s.call('/review/copy/bb-acme/week-01.json/w2-d1/keep', {})).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const drawn = s.jobs.list({ brand: 'bb-acme' }).filter((j) => j.kind === 'draw');
    assert.equal(drawn.length, 1, 'asked once, however many passes ran');
    assert.deepEqual([drawn[0]?.week, drawn[0]?.by, drawn[0]?.auto], [W2, 'system:weekly-draw', true]);
    const listed = (await (await s.call('/review/copy')).json()) as Listed;
    assert.equal(listed.batches[0]?.weeks?.find((w) => w.from === W2)?.state, 'drawing');
    assert.equal(listed.batches[0]?.weeks?.find((w) => w.from === W1)?.state, 'waiting', 'week 1 waits for the customer');
  } finally {
    await s.done();
  }
});

test('the product records its connected networks; only a product may, only the four networks count, and a draw is asked for just those', async () => {
  const s = await start();
  try {
    const put = (body: unknown): Promise<Response> => s.call('/review/connected', body, 'PUT');
    assert.deepEqual(await (await put({ networks: ['instagram', 'myspace'] })).json(), { changed: true });
    assert.deepEqual(await (await put({ networks: ['instagram'] })).json(), { changed: false });
    assert.equal((await put({ networks: 'instagram' })).status, 400);
    assert.equal((await put({})).status, 400);
    const staff = await fetch(`${(await s.call('/review/limits')).url.split('/review')[0]}/review/connected`, { method: 'PUT', headers: { Authorization: 'Bearer staff-secret-0123456789', 'Content-Type': 'application/json' }, body: JSON.stringify({ networks: ['facebook'] }) });
    assert.equal(staff.status, 404, 'staff do not write it');
  } finally {
    await s.done();
  }
});
