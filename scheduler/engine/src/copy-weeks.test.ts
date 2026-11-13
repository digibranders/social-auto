import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CopyStage, CopyStageError, weekOfPost, weeksOf } from './copy-stage.ts';
import { createReviewServer } from './review-server.ts';
import { ProductBrands } from './product-brands.ts';
import { ReviewStore } from './review-store.ts';
import { JobStore } from './job-store.ts';
import { engineArgs } from './job-runner.ts';
import { mondayOf } from './picture-limit.ts';
import { ConnectedUnknownError, connectedForDraw, readConnected, writeConnected } from './connected-networks.ts';

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
  writeConnected(dir, ['instagram', 'facebook']);
  const server = createReviewServer({ brandsRoot, secret: 'staff-secret-0123456789', jobsRoot: join(root, 'jobs'), products: [{ id: 'brandbasket', secret: PRODUCT }], ledgerFile: join(root, 'none.jsonl'), now: () => new Date(at), weeklyDrawEveryMs: everyMs });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, body?: unknown, method?: string): Promise<Response> => fetch(`${base}${path}`, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { Authorization: `Bearer ${PRODUCT}`, 'X-Brand': 'bb-acme', 'X-Actor': 'brandbasket:user-42', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { call, copy, root, base, jobs: new JobStore(join(root, 'jobs')), done: async () => { await new Promise((resolve) => server.close(resolve)); rmSync(root, { recursive: true, force: true }); } };
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

test('the plan read says where the customer\'s plan ends, counting drawn batches and not put-away ones', async () => {
  const s = await start();
  try {
    const plan = async (): Promise<Record<string, unknown>> => (await (await s.call('/review/plan')).json()) as Record<string, unknown>;
    assert.deepEqual(await plan(), { brand: 'bb-acme', endsOn: '2026-11-24', startsOn: '2026-11-16' });
    s.copy.markWeekDrawn('week-01.json', W1);
    s.copy.markWeekDrawn('week-01.json', W2);
    assert.equal((await plan())['endsOn'], '2026-11-24', 'a drawn batch still counts');
    s.copy.open('week-02.json', [post('x-d1', '2026-12-07')]);
    assert.equal((await plan())['endsOn'], '2026-12-07');
    s.copy.close('week-02.json', 'u');
    assert.equal((await plan())['endsOn'], '2026-11-24', 'a batch put away does not count');
    assert.equal((await fetch(`${(await s.call('/review/limits')).url.split('/review')[0]}/review/plan?brand=bb-acme`, { headers: { Authorization: 'Bearer staff-secret-0123456789' } })).status, 200, 'staff may read a product brand\'s plan');
  } finally {
    await s.done();
  }
});

test('a week the plan was asked for and got no post is listed as empty, with the days that are missing in the weeks that have posts', async () => {
  const s = await start();
  try {
    // The plan asked for Monday to Friday of three weeks; week 2 got posts on two days only, week 3 on none.
    s.copy.close('week-01.json', 'u');
    s.copy.open('week-02.json', [post('x-d1', '2026-11-23'), post('x-d2', '2026-11-24')], ['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27', '2026-11-30', '2026-12-01']);
    const listed = (await (await s.call('/review/copy')).json()) as { batches: Array<{ planFile: string; weeks?: Array<{ from: string; state: string; postIds: string[]; missingDays?: string[] }> }> };
    const weeks = listed.batches.find((b) => b.planFile === 'week-02.json')?.weeks;
    assert.deepEqual(weeks?.map((w) => [w.from, w.state, w.postIds, w.missingDays]), [['2026-11-23', 'waiting', ['x-d1', 'x-d2'], ['2026-11-25', '2026-11-26', '2026-11-27']], ['2026-11-30', 'empty', [], ['2026-11-30', '2026-12-01']]]);
  } finally {
    await s.done();
  }
});

test('the product can tell the poster service its connected networks before the brand\'s first job has made its folder; another product\'s brand, or one nobody owns, is refused', async () => {
  const s = await start();
  try {
    const bare = mkdtempSync(join(tmpdir(), 'connected-bare-'));
    rmSync(bare, { recursive: true, force: true });
    // bb-acme's folder exists; claim another brand for the same product with no folder, as it is right after the first job is asked for.
    const owners = new ProductBrands(join(s.root, 'brands'));
    owners.claim('bb-new', 'brandbasket', () => false);
    const asNew = (networks: unknown): Promise<Response> => fetch(`${s.base}/review/connected`, { method: 'PUT', headers: { Authorization: `Bearer ${PRODUCT}`, 'X-Brand': 'bb-new', 'X-Actor': 'brandbasket:u', 'Content-Type': 'application/json' }, body: JSON.stringify({ networks }) });
    const told = await asNew(['instagram', 'facebook']);
    assert.equal(told.status, 200, JSON.stringify(await told.clone().json()));
    assert.deepEqual([...(readConnected(join(s.root, 'brands', 'bb-new')) as Set<string>)].sort(), ['facebook', 'instagram']);
    const nobody = await fetch(`${s.base}/review/connected`, { method: 'PUT', headers: { Authorization: `Bearer ${PRODUCT}`, 'X-Brand': 'bb-stranger', 'X-Actor': 'brandbasket:u', 'Content-Type': 'application/json' }, body: JSON.stringify({ networks: ['instagram'] }) });
    assert.equal(nobody.status, 404, 'a brand nobody owns is not made by this call');
  } finally {
    await s.done();
  }
});

test('a draw for a product customer stops when the connected networks were never recorded, and a client of ours is not stopped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'connected-known-'));
  try {
    assert.throws(() => connectedForDraw(dir, true), ConnectedUnknownError);
    assert.equal(connectedForDraw(dir, false), null, 'ours: every network the posts were written for, as before');
    writeConnected(dir, ['instagram']);
    assert.deepEqual([...(connectedForDraw(dir, true) as Set<string>)], ['instagram']);
    writeConnected(dir, []);
    assert.equal((connectedForDraw(dir, true) as Set<string>).size, 0, 'recorded as none connected: nothing is drawn, and nothing is refused as unknown');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- a customer asks for a carousel

const inDays = (n: number): string => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

test('a customer asks for a carousel: it is made for her own brand and only the channels she has connected, and a second ask is the same job', async () => {
  const s = await start();
  try {
    const ask = (over: Record<string, unknown> = {}): Promise<Response> => s.call('/review/jobs', { kind: 'carousel', site: 'acme.example', brand: 'bb-acme', networks: ['instagram', 'linkedin', 'facebook'], startDate: inDays(3), ...over });
    const first = await ask();
    assert.equal(first.status, 202, JSON.stringify(await first.clone().json()));
    const { job } = (await first.json()) as { job: { id: string; kind: string; brand: string; networks: string[]; by: string } };
    assert.deepEqual([job.kind, job.brand, job.networks], ['carousel', 'bb-acme', ['instagram', 'facebook']], 'linkedin is not connected, so nothing is made for it');
    assert.deepEqual(engineArgs(job as never).slice(0, 5), ['src/carousel-cli.ts', '--site', 'https://acme.example', '--brand', 'bb-acme']);
    const again = await ask();
    assert.equal(again.status, 200);
    assert.equal(((await again.json()) as { job: { id: string } }).job.id, job.id);
    assert.equal((await ask({ brand: 'bb-other' })).status, 400, 'the brand must be the one named in X-Brand');
    assert.equal((await ask({ networks: ['linkedin'] })).status, 400, 'no connected channel among those asked for');
  } finally {
    await s.done();
  }
});

test('a carousel is refused while the connected channels are not known, and once a week is made another is refused with the day it starts again', async () => {
  const s = await start();
  try {
    const dir = join(s.root, 'brands', 'bb-acme');
    const day = inDays(3);
    const ask = (): Promise<Response> => s.call('/review/jobs', { kind: 'carousel', site: 'acme.example', brand: 'bb-acme', networks: ['instagram'], startDate: day });
    rmSync(join(dir, 'connected.json'), { force: true });
    const unknown = await ask();
    assert.equal(unknown.status, 409);
    assert.match(((await unknown.json()) as { error: string }).error, /CONNECTED_UNKNOWN/);
    writeConnected(dir, ['instagram']);
    // A carousel already made for that week (not rejected: it has no slides in review yet, so it still counts).
    writeFileSync(join(dir, 'carousels.json'), JSON.stringify({ carousels: [{ id: 'car-made', topic: 't', createdAt: new Date().toISOString(), planFile: 'week-02.json', date: `${day}T10:00:00+05:30` }] }));
    const full = await ask();
    assert.equal(full.status, 429);
    const body = (await full.json()) as { code: string; restart: string; error: string };
    assert.equal(body.code, 'CAROUSEL_LIMIT_REACHED');
    assert.match(body.restart, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(body.error, /already made for the week/);
  } finally {
    await s.done();
  }
});

test('a customer sees only her own carousels: the list holds hers, and another brand\'s carousel is not hers to read or decide', async () => {
  const s = await start();
  try {
    const dir = join(s.root, 'brands', 'bb-acme');
    writeFileSync(join(dir, 'carousels.json'), JSON.stringify({ carousels: [{ id: 'car-1', topic: 'Why it works', createdAt: '2026-11-12T00:00:00Z', planFile: 'week-02.json', date: '2026-11-17T10:00:00+05:30' }] }));
    const own = (await (await s.call('/review/carousels')).json()) as { carousels: Array<{ id: string; topic: string; status: string; count: number }> };
    assert.deepEqual(own.carousels.map((c) => [c.id, c.topic, c.status, c.count]), [['car-1', 'Why it works', 'incomplete', 0]]);
    const owners = new ProductBrands(join(s.root, 'brands'));
    mkdirSync(join(s.root, 'brands', 'bb-other'), { recursive: true });
    owners.claim('bb-other', 'brandbasket', () => false);
    const asOther = (path: string, body?: unknown): Promise<Response> => fetch(`${s.base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${PRODUCT}`, 'X-Brand': 'bb-other', 'X-Actor': 'brandbasket:u', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.deepEqual(((await (await asOther('/review/carousels')).json()) as { carousels: unknown[] }).carousels, []);
    assert.ok([403, 404].includes((await asOther('/review/carousels/bb-acme/car-1')).status), 'reading another brand\'s carousel is refused');
    assert.ok([403, 404].includes((await asOther('/review/carousels/bb-acme/car-1/approve', { by: 'x' })).status), 'deciding it is refused');
  } finally {
    await s.done();
  }
});

test('a carousel slide is not one of a customer\'s pictures: it is not in her list and cannot be approved, rejected or redrawn on its own', async () => {
  const s = await start();
  try {
    const dir = join(s.root, 'brands', 'bb-acme');
    const image = join(s.root, 'slide.jpg');
    writeFileSync(image, 'slide');
    const store = new ReviewStore(dir, 'bb-acme');
    const base = { headline: 'H', caption: '', ctaUrl: 'https://acme.example', factIds: ['f1'], evidence: [{ factId: 'f1', text: 't', quote: 'q', url: 'https://acme.example/', context: 'c' }], imagePath: image, validation: { accepted: true, readings: 2, defects: [], reportFile: 'r.json' }, attempts: 1, costUsd: 0 };
    const slide = store.addVersion({ ...base, postId: 'car-1-s1', planFile: 'week-02.json', carousel: { id: 'car-1', position: 1, count: 3 } });
    const single = store.addVersion({ ...base, postId: 'w1-d1', planFile: 'week-01.json', network: 'instagram' });
    const list = (await (await s.call('/review/posts?status=all')).json()) as { posts: Array<{ versionId: string }> };
    assert.deepEqual(list.posts.map((p) => p.versionId), [single.versionId], 'only the ordinary picture is listed');
    for (const action of ['approve', 'reject', 'redraw']) {
      const answer = await s.call(`/review/posts/${slide.versionId}/${action}`, { by: 'x', reason: 'other' });
      assert.equal(answer.status, 409, action);
      assert.match(((await answer.json()) as { error: string }).error, /carousel as a whole/);
    }
    assert.equal(store.get(slide.versionId).status, 'pending', 'nothing was decided');
    assert.equal((await s.call(`/review/posts/${slide.versionId}/image`)).status, 200, 'the picture itself can still be read');
  } finally {
    await s.done();
  }
});

test('the weekly carousel is switched on or off by the customer for her own brand only, and staff have no switch', async () => {
  const s = await start();
  try {
    assert.deepEqual(await (await s.call('/review/carousel-weekly')).json(), { enabled: false });
    const on = await s.call('/review/carousel-weekly', { enabled: true }, 'PUT');
    assert.equal(on.status, 200, JSON.stringify(await on.clone().json()));
    assert.deepEqual(await (await s.call('/review/carousel-weekly')).json(), { enabled: true });
    assert.equal((await s.call('/review/carousel-weekly', { enabled: 'yes' }, 'PUT')).status, 400);
    assert.deepEqual(await (await s.call('/review/carousel-weekly', { enabled: false }, 'PUT')).json(), { enabled: false });
    const staff = await fetch(`${s.base}/review/carousel-weekly`, { headers: { Authorization: 'Bearer staff-secret-0123456789' } });
    assert.equal(staff.status, 404);
  } finally {
    await s.done();
  }
});
