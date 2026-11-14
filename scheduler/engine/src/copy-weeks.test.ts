import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

test('approving a carousel makes its release record for the networks of its captions, so one made before the record existed, or in a week never drawn, still reaches the calendar', async () => {
  const s = await start();
  try {
    const dir = join(s.root, 'brands', 'bb-acme');
    const image = join(s.root, 'slide.jpg');
    writeFileSync(image, 'slide');
    // A carousel plan file as an earlier version wrote it: one post, with no channels named.
    writeFileSync(join(dir, 'week-09.json'), JSON.stringify({ brand: 'bb-acme', timezone: '+05:30', renderMode: 'ai_v1', posts: [{ id: 'car-9', date: '2099-11-13T10:00:00+05:30', painPoint: 'p', mode: 'ai', headline: 'T', subline: '', caption: 'C', hashtags: [], imagePrompt: 'a carousel', pillar: 'carousel' }] }));
    writeFileSync(join(dir, 'carousels.json'), JSON.stringify({ carousels: [{ id: 'car-9', topic: 'T', createdAt: '2026-11-12T00:00:00Z', planFile: 'week-09.json', date: '2099-11-13T10:00:00+05:30' }] }));
    const store = new ReviewStore(dir, 'bb-acme');
    const base = { planFile: 'week-09.json', headline: 'H', caption: '', ctaUrl: 'https://acme.example', factIds: ['f1'], evidence: [{ factId: 'f1', text: 't', quote: 'q', url: 'https://acme.example/', context: 'c' }], imagePath: image, validation: { accepted: true, readings: 2, defects: [], reportFile: 'r.json' }, attempts: 1, costUsd: 0 };
    for (const n of [1, 2, 3]) store.addVersion({ ...base, postId: `car-9-s${n}`, carousel: { id: 'car-9', position: n, count: 3 } });
    for (const network of ['instagram', 'facebook']) store.addVersion({ ...base, postId: 'car-9', network, caption: `${network} words`, carousel: { id: 'car-9', position: 0, count: 3 } });
    assert.equal(existsSync(join(dir, 'campaigns', 'manual-week-09.json')), false, 'no record before she approves');
    const approved = await s.call('/review/carousels/bb-acme/car-9/approve', {});
    assert.equal(approved.status, 200, JSON.stringify(await approved.clone().json()));
    const record = JSON.parse(readFileSync(join(dir, 'campaigns', 'manual-week-09.json'), 'utf8')) as { brand: string; plan: { platforms: string[] } };
    assert.deepEqual([record.brand, record.plan.platforms.sort()], ['bb-acme', ['facebook', 'instagram']]);
    assert.equal((await s.call('/review/carousels/bb-acme/car-9/approve', {})).status, 200, 'asking again changes nothing');
  } finally {
    await s.done();
  }
});

// ---- a customer adds a topic of her own

test('a customer adds a topic: written for her connected channels only, one topic a week, and a failed one does not use the week', async () => {
  const s = await start();
  try {
    const dir = join(s.root, 'brands', 'bb-acme');
    writeFileSync(join(dir, 'facts.json'), JSON.stringify({ version: 1, builtAt: '2026-11-01T00:00:00Z', site: 'https://acme.example', facts: [], conflicts: [], snapshots: [], coverage: { pages: 0, structured: 0, flatText: 0, usable: 0, needsReview: 0, excluded: 0, notes: [] } }));
    const day = inDays(3);
    const ask = (over: Record<string, unknown> = {}): Promise<Response> => s.call('/review/jobs', { kind: 'topic', site: 'acme.example', brand: 'bb-acme', networks: ['instagram', 'linkedin', 'facebook'], startDate: day, text: 'Diwali special: 20% off all thalis until 2 Nov.', ...over });
    const first = await ask();
    assert.equal(first.status, 202, JSON.stringify(await first.clone().json()));
    const { job } = (await first.json()) as { job: { id: string; kind: string; brand: string; networks: string[]; topicId: string } };
    assert.deepEqual([job.kind, job.brand, job.networks], ['topic', 'bb-acme', ['instagram', 'facebook']], 'linkedin is not connected');
    assert.deepEqual(engineArgs(job as never).slice(0, 9), ['src/autopilot.ts', '--site', 'https://acme.example', '--brand', 'bb-acme', '--copy-first', '--topic', job.topicId, '--days']);
    assert.equal((await ask({ brand: 'bb-other' })).status, 400, 'the brand must be the one in X-Brand');
    assert.equal((await ask({ networks: ['linkedin'] })).status, 400, 'no connected channel among those asked for');

    // Once it is being written, a second ask is the same job; once it is done the week has its topic.
    s.jobs.update(job.id, { state: 'succeeded' });
    const full = await ask({ text: 'New dish: paneer kulcha, served from Monday.' });
    assert.equal(full.status, 429);
    const body = (await full.json()) as { code: string; restart: string; error: string };
    assert.equal(body.code, 'TOPIC_LIMIT_REACHED');
    assert.match(body.restart, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(body.error, /already added a topic for the week/);
    assert.equal(JSON.parse(readFileSync(join(dir, 'customer-facts.json'), 'utf8')).statements.length, 1, 'the refused ask kept nothing');

    // A topic that failed does not use its week (the first one succeeded, so another week is the place to look): a later week is free, and its failure frees it again.
    const later = await ask({ startDate: inDays(12), text: 'Weekend brunch is back from this Saturday.' });
    assert.equal(later.status, 202, JSON.stringify(await later.clone().json()));
    const laterJob = ((await later.json()) as { job: { id: string } }).job;
    s.jobs.update(laterJob.id, { state: 'failed' });
    const retry = await ask({ startDate: inDays(12), text: 'Weekend brunch is back from this Saturday, 10 am.' });
    assert.equal(retry.status, 202, 'a failed topic does not use the week');
    rmSync(join(dir, 'connected.json'), { force: true });
    const unknown = await ask({ startDate: inDays(30) });
    assert.equal(unknown.status, 409);
    assert.match(((await unknown.json()) as { error: string }).error, /CONNECTED_UNKNOWN/);
  } finally {
    await s.done();
  }
});

// ---- the topics a customer asked for: where each stands, as a unit of its own

import { topicRequests } from './topic-requests.ts';

function topicFixture(): { dir: string; jobs: JobStore; done: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'topic-view-'));
  const dir = join(root, 'bb-acme');
  mkdirSync(dir, { recursive: true });
  writeConnected(dir, ['instagram', 'facebook']);
  return { dir, jobs: new JobStore(join(root, 'jobs')), done: () => rmSync(root, { recursive: true, force: true }) };
}

const topicPost = (id: string, date: string) => ({ postId: id, date, headline: 'Diwali |thalis|, 20% off', caption: 'Main caption', captions: { instagram: { text: 'ig words' }, facebook: { text: 'fb words' } } });

test('a topic request says where it stands: writing, waiting for her words with the pictures it would cost, drawing, drawn, or not made with a code', () => {
  const t = topicFixture();
  try {
    const ask = (day: string, planFile?: string): string => {
      const { job } = t.jobs.enqueue({ kind: 'topic', brand: 'bb-acme', site: 'acme.example', by: 'u', networks: ['instagram', 'facebook'], topicId: `t-${day}`, startDate: day, time: '11:30' });
      if (planFile) t.jobs.update(job.id, { state: 'succeeded', planFileMade: planFile });
      return job.id;
    };
    const view = () => topicRequests({ brandDir: t.dir, brand: 'bb-acme', jobs: t.jobs.list({ brand: 'bb-acme' }), made: () => new Set(), connected: readConnected(t.dir) });

    // Being written.
    ask('2026-11-17');
    let [only] = view();
    assert.deepEqual([only?.state, only?.week, only?.goesOutOn, only?.goesOutAt, only?.picturesToDraw], ['writing', { from: W1, to: '2026-11-22' }, '2026-11-17', '11:30', 0]);

    // Written: her words are ready, and the cost is one picture for each connected channel.
    const s = new CopyStage(t.dir, 'bb-acme');
    s.open('week-02.json', [topicPost('w02-d1', '2026-11-17')]);
    t.jobs.update(t.jobs.list({ brand: 'bb-acme' })[0]?.id as string, { state: 'succeeded', planFileMade: 'week-02.json' });
    [only] = view();
    assert.equal(only?.state, 'waiting_for_words');
    assert.deepEqual(only?.words, { headline: 'Diwali thalis, 20% off', captions: { instagram: 'ig words', facebook: 'fb words' } });
    assert.deepEqual([only?.batchId, only?.postId, only?.picturesToDraw], ['week-02.json', 'w02-d1', 2]);
    writeConnected(t.dir, ['instagram']);
    assert.equal(view()[0]?.picturesToDraw, 1, 'only a connected channel is drawn for');
    writeConnected(t.dir, ['instagram', 'facebook']);

    // Drawing, then drawn.
    s.decide('week-02.json', 'w02-d1', 'kept', 'u');
    s.markWeekDrawn('week-02.json', W1);
    const { job: draw } = t.jobs.enqueue({ kind: 'draw', brand: 'bb-acme', site: 'acme.example', by: 'u', planFile: 'week-02.json', week: W1 });
    assert.equal(view()[0]?.state, 'drawing');
    t.jobs.update(draw.id, { state: 'succeeded' });
    const made = new Set(['w02-d1|instagram', 'w02-d1|facebook']);
    const drawn = topicRequests({ brandDir: t.dir, brand: 'bb-acme', jobs: t.jobs.list({ brand: 'bb-acme' }), made: () => made, connected: readConnected(t.dir) });
    assert.deepEqual([drawn[0]?.state, drawn[0]?.picturesToDraw], ['drawn', 0]);
    assert.equal(view()[0]?.reason, 'DRAW_FAILED', 'a week drawn with no picture made is told');
    // A draw that failed before the week was marked and was then retried: pictures exist, so it is drawn.
    const t2 = topicFixture();
    try {
      new CopyStage(t2.dir, 'bb-acme').open('week-02.json', [topicPost('w02-d1', '2026-11-17')]);
      const { job } = t2.jobs.enqueue({ kind: 'topic', brand: 'bb-acme', site: 'acme.example', by: 'u', networks: ['instagram'], topicId: 't-x', startDate: '2026-11-17' });
      t2.jobs.update(job.id, { state: 'succeeded', planFileMade: 'week-02.json' });
      const view2 = topicRequests({ brandDir: t2.dir, brand: 'bb-acme', jobs: t2.jobs.list({ brand: 'bb-acme' }), made: () => new Set(['w02-d1|instagram']), connected: null });
      assert.deepEqual([view2[0]?.state, view2[0]?.picturesToDraw], ['drawn', 0]);
    } finally {
      t2.done();
    }
  } finally {
    t.done();
  }
});

test('a topic that was not made carries a code: dropped, no room for the pictures, a failed writing, a week that passed', () => {
  const t = topicFixture();
  try {
    const s = new CopyStage(t.dir, 'bb-acme');
    const fail = t.jobs.enqueue({ kind: 'topic', brand: 'bb-acme', site: 'acme.example', by: 'u', networks: ['instagram'], topicId: 't-a', startDate: '2026-11-17' }).job;
    t.jobs.update(fail.id, { state: 'failed', error: { code: 'INSUFFICIENT_CONCEPTS', message: 'x' } });
    const other = t.jobs.enqueue({ kind: 'topic', brand: 'bb-acme', site: 'acme.example', by: 'u', networks: ['instagram'], topicId: 't-b', startDate: '2026-11-24' }).job;
    t.jobs.update(other.id, { state: 'failed', error: { code: 'FAILED', message: 'x' } });
    const reasons = () => topicRequests({ brandDir: t.dir, brand: 'bb-acme', jobs: t.jobs.list({ brand: 'bb-acme' }), made: () => new Set(), connected: null }).map((r) => r.reason).sort();
    assert.deepEqual(reasons(), ['NOT_WRITTEN', 'TEXT_REFUSED']);

    for (const [n, topicId, day] of [[3, 't-c', '2026-11-30'], [4, 't-d', '2026-12-07'], [5, 't-e', '2026-12-14']] as const) {
      s.open(`week-0${n}.json`, [topicPost(`w0${n}-d1`, day)]);
      const { job } = t.jobs.enqueue({ kind: 'topic', brand: 'bb-acme', site: 'acme.example', by: 'u', networks: ['instagram'], topicId, startDate: day });
      t.jobs.update(job.id, { state: 'succeeded', planFileMade: `week-0${n}.json` });
    }
    s.decide('week-03.json', 'w03-d1', 'dropped', 'u');
    s.markWeekLapsed('week-04.json', '2026-12-07');
    const byWeek = (): Record<string, string | undefined> => Object.fromEntries(topicRequests({ brandDir: t.dir, brand: 'bb-acme', jobs: t.jobs.list({ brand: 'bb-acme' }), made: () => new Set(), connected: null }).map((r) => [r.week.from, r.reason]));
    assert.equal(byWeek()['2026-11-30'], 'DROPPED');
    assert.equal(byWeek()['2026-12-07'], 'WEEK_PASSED');
    assert.equal(byWeek()['2026-12-14'], undefined, 'the one still waiting has no reason');
    // Kept and drawn, but the channel had no pictures left this week.
    s.decide('week-05.json', 'w05-d1', 'kept', 'u');
    s.markWeekDrawn('week-05.json', '2026-12-14');
    s.setNotDrawn('week-05.json', { 'w05-d1': { code: 'PICTURE_LIMIT_REACHED', reason: 'no room' } as never });
    assert.equal(byWeek()['2026-12-14'], 'NO_PICTURE_ROOM');
  } finally {
    t.done();
  }
});

test('a topic is a unit of its own: a week drawn in the main batch never locks it, and drawing it never locks the main week', () => {
  const t = topicFixture();
  try {
    const s = new CopyStage(t.dir, 'bb-acme');
    s.open('week-01.json', posts);
    s.open('week-02.json', [topicPost('w02-d1', '2026-11-17')]);
    s.decide('week-01.json', 'w1-d1', 'kept', 'u');
    s.markWeekDrawn('week-01.json', W1);
    // The main week is drawn; the topic of that same week can still be kept, edited and drawn.
    assert.doesNotThrow(() => s.decide('week-02.json', 'w02-d1', 'kept', 'u'));
    assert.doesNotThrow(() => s.edit('week-02.json', 'w02-d1', { headline: 'Diwali thalis, 20% off', caption: 'Better main caption' }, 'u', () => undefined));
    s.markWeekDrawn('week-02.json', W1);
    // And the other way round: drawing the topic leaves the main batch's other posts of that week alone.
    const t2 = topicFixture();
    try {
      const s2 = new CopyStage(t2.dir, 'bb-acme');
      s2.open('week-01.json', posts);
      s2.open('week-02.json', [topicPost('w02-d1', '2026-11-17')]);
      s2.decide('week-02.json', 'w02-d1', 'kept', 'u');
      s2.markWeekDrawn('week-02.json', W1);
      assert.doesNotThrow(() => s2.decide('week-01.json', 'w1-d1', 'kept', 'u'));
      assert.doesNotThrow(() => s2.decide('week-01.json', 'w1-d2', 'dropped', 'u'));
    } finally {
      t2.done();
    }
  } finally {
    t.done();
  }
});

test('a customer\'s topic over HTTP: it always gets a day, the same words again are the same request, other words in a full week are refused with the day she can ask again, a refused text says why by a code, and the list shows where each stands', async () => {
  const s = await start();
  try {
    writeFileSync(join(s.root, 'brands', 'bb-acme', 'facts.json'), JSON.stringify({ version: 1, builtAt: '2026-11-01T00:00:00Z', site: 'https://acme.example', facts: [], conflicts: [], snapshots: [], coverage: { pages: 0, structured: 0, flatText: 0, usable: 0, needsReview: 0, excluded: 0, notes: [] } }));
    const ask = (over: Record<string, unknown> = {}): Promise<Response> => s.call('/review/jobs', { kind: 'topic', site: 'acme.example', brand: 'bb-acme', networks: ['instagram'], text: 'Diwali special: 20% off all thalis until 2 Nov.', ...over });
    for (const [text, reason] of [['hi', 'TOO_SHORT'], ['See https://acme.example/diwali for the 20% off offer', 'LINK_NOT_ALLOWED'], ['The best thali in town, 20% off', 'NEEDS_PROOF'], ['x'.repeat(1001), 'TOO_LONG']] as const) {
      const refused = await ask({ text });
      assert.equal(refused.status, 400);
      const body = (await refused.json()) as { reason: string; error: string };
      assert.equal(body.reason, reason);
      assert.ok(body.error.length > 0);
    }
    const first = await ask();
    assert.equal(first.status, 202, JSON.stringify(await first.clone().json()));
    const { job } = (await first.json()) as { job: { id: string; startDate: string } };
    assert.match(job.startDate, /^\d{4}-\d{2}-\d{2}$/, 'a day is always set, so the week can be counted');
    const repeat = await ask({ text: '  Diwali special: 20% off all thalis until 2 Nov.  ' });
    assert.equal(repeat.status, 200, 'the same words for the same week are the same request');
    assert.equal(((await repeat.json()) as { job: { id: string } }).job.id, job.id);
    const spaced = await ask({ text: 'DIWALI special:  20% off   all thalis until 2 Nov.' });
    assert.equal(spaced.status, 200, 'other case and spacing are the same words');
    assert.equal(((await spaced.json()) as { job: { id: string } }).job.id, job.id);
    const other = await ask({ text: 'New dish: paneer kulcha, served from Monday.' });
    assert.equal(other.status, 429);
    assert.equal(((await other.json()) as { code: string }).code, 'TOPIC_LIMIT_REACHED');
    assert.equal(JSON.parse(readFileSync(join(s.root, 'brands', 'bb-acme', 'customer-facts.json'), 'utf8')).statements.length, 1, 'the repeat and the refused ask kept nothing');
    const listed = (await (await s.call('/review/topic-requests')).json()) as { requests: Array<{ jobId: string; state: string; picturesToDraw: number }> };
    assert.deepEqual(listed.requests.map((r) => [r.jobId, r.state, r.picturesToDraw]), [[job.id, 'writing', 0]]);
  } finally {
    await s.done();
  }
});

// ---- a dropped topic gives a new one

import { MAX_REPLACEMENTS_PER_WEEK, replaceProblem } from './copy-stage.ts';

const futureWeek = (): string => mondayOf(new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10));
const dayOf = (monday: string, n: number): string => new Date(Date.parse(`${monday}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const todayIst = (): string => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const fresh = (id: string, date: string) => ({ postId: id, date, headline: `New ${id}`, caption: `Caption ${id}`, captions: { instagram: { text: `ig ${id}` }, facebook: { text: `fb ${id}` } } });

test('a dropped post can be given a new topic: same day, undecided, counted per week, never for a post that is kept, drawn, past, or already replaced', () => {
  const t = topicFixture();
  try {
    const monday = futureWeek();
    const s = new CopyStage(t.dir, 'bb-acme');
    s.open('week-03.json', [0, 1, 2, 3].map((n) => post(`p${n}`, dayOf(monday, n))));
    const batch = (): ReturnType<typeof s.get> => s.get('week-03.json');
    assert.equal(replaceProblem(batch(), 'p0', todayIst())?.code, 'CONFLICT', 'a post that is not dropped');
    assert.equal(replaceProblem(batch(), 'nope', todayIst())?.code, 'NOT_FOUND');
    for (const id of ['p0', 'p1', 'p2', 'p3']) s.decide('week-03.json', id, 'dropped', 'u');
    assert.equal(replaceProblem(batch(), 'p0', todayIst()), null);
    assert.equal(replaceProblem(batch(), 'p0', dayOf(monday, 0))?.code, 'DAY_PASSED', 'its day is today or has passed');

    const after = s.addReplacement('week-03.json', 'p0', fresh('w03-r1', dayOf(monday, 0)), todayIst());
    const added = after.posts.find((p) => p.postId === 'w03-r1');
    assert.deepEqual([added?.date, added?.state, added?.replaces, after.replacedBy, after.replacements], [dayOf(monday, 0), 'pending', 'p0', { p0: 'w03-r1' }, { [monday]: 1 }]);
    assert.equal(added?.contentHash.length, 64, 'the choice is about these exact words');
    assert.equal(after.posts.find((p) => p.postId === 'p0')?.state, 'dropped', 'the dropped post stays dropped');
    assert.equal(replaceProblem(after, 'p0', todayIst())?.code, 'CONFLICT', 'one replacement per dropped post');
    assert.doesNotThrow(() => s.decide('week-03.json', 'w03-r1', 'kept', 'u'), 'the new post is kept like any other');

    s.addReplacement('week-03.json', 'p1', fresh('w03-r2', dayOf(monday, 1)), todayIst());
    s.addReplacement('week-03.json', 'p2', fresh('w03-r3', dayOf(monday, 2)), todayIst());
    assert.equal(MAX_REPLACEMENTS_PER_WEEK, 3);
    assert.equal(replaceProblem(batch(), 'p3', todayIst())?.code, 'LIMIT', 'a week has three');
    assert.throws(() => s.addReplacement('week-03.json', 'p3', fresh('w03-r4', dayOf(monday, 3)), todayIst()), (e: Error) => e instanceof CopyStageError && e.code === 'LIMIT');

    s.markWeekDrawn('week-03.json', monday);
    assert.equal(replaceProblem(batch(), 'p3', todayIst())?.code, 'ALREADY_DRAWN', 'a week that was drawn is final');
  } finally {
    t.done();
  }
});

test('a new topic over HTTP: only for a dropped post, a job per post, the limit counts those being written, and the words are asked for the connected networks only', async () => {
  const s = await start();
  try {
    const monday = futureWeek();
    const copy = new CopyStage(join(s.root, 'brands', 'bb-acme'), 'bb-acme');
    copy.open('week-03.json', [0, 1, 2, 3].map((n) => post(`p${n}`, dayOf(monday, n))));
    const ask = (id: string): Promise<Response> => s.call(`/review/copy/bb-acme/week-03.json/${id}/replace`, {});
    const body = async (res: Response): Promise<Record<string, any>> => (await res.json()) as Record<string, any>;
    const notDropped = await ask('p0');
    assert.equal(notDropped.status, 409);
    assert.equal((await body(notDropped)).code, 'CONFLICT');
    for (const id of ['p0', 'p1', 'p2', 'p3']) assert.equal((await s.call(`/review/copy/bb-acme/week-03.json/${id}/drop`, {})).status, 200);
    const first = await ask('p0');
    assert.equal(first.status, 202, JSON.stringify(await first.clone().json()));
    const { job } = (await body(first)) as { job: { id: string; kind: string; planFile: string; postId: string; networks: string[] } };
    assert.deepEqual([job.kind, job.planFile, job.postId, job.networks], ['replace', 'week-03.json', 'p0', ['instagram', 'facebook']]);
    assert.deepEqual(engineArgs(job as never).slice(5), ['--copy-first', '--replace', 'week-03.json', '--replace-post', 'p0', '--networks', 'instagram,facebook']);
    const again = await ask('p0');
    assert.equal(again.status, 200, 'the same ask while one runs is the same job');
    const sameJob = await body(again);
    assert.equal((sameJob['job'] as { id: string }).id, job.id);
    assert.equal(sameJob['created'], false);

    // Two more being written use the week's three; the fourth is refused with the day she can ask again.
    assert.equal((await ask('p1')).status, 202);
    assert.equal((await ask('p2')).status, 202);
    const full = await ask('p3');
    assert.equal(full.status, 429);
    const limited = await body(full);
    assert.equal(limited['code'], 'REPLACE_LIMIT_REACHED');
    assert.equal(limited['restart'], dayOf(monday, 7));

    // A try that wrote nothing is not counted: once it has failed, a new one may be asked for.
    s.jobs.update(job.id, { state: 'failed', error: { code: 'NOTHING_WRITTEN', message: 'x' } });
    assert.equal(copy.get('week-03.json').replacements, undefined, 'nothing was added or counted');
    assert.equal((await ask('p3')).status, 202, 'the failed one freed its place');
    const retry = await ask('p0');
    assert.equal(retry.status, 429, 'but the week still has its three being written');

    writeConnected(join(s.root, 'brands', 'bb-acme'), ['facebook']);
    copy.open('week-04.json', [post('q0', dayOf(monday, 14))]);
    copy.decide('week-04.json', 'q0', 'dropped', 'u');
    const connected = await s.call('/review/copy/bb-acme/week-04.json/q0/replace', {});
    assert.deepEqual(((await body(connected)).job as { networks: string[] }).networks, ['facebook'], 'instagram is not connected');
    copy.open('week-05.json', [post('r0', dayOf(monday, 21))]);
    copy.decide('week-05.json', 'r0', 'dropped', 'u');
    copy.markWeekDrawn('week-05.json', mondayOf(dayOf(monday, 21)));
    assert.equal((await s.call('/review/copy/bb-acme/week-05.json/r0/replace', {})).status, 409, 'a week that was drawn is final');
    copy.open('week-06.json', [post('s0', todayIst())]);
    copy.decide('week-06.json', 's0', 'dropped', 'u');
    const past = await s.call('/review/copy/bb-acme/week-06.json/s0/replace', {});
    assert.equal(past.status, 409);
    assert.equal((await body(past)).code, 'DAY_PASSED');
  } finally {
    await s.done();
  }
});

// ---- the day and time on every picture and written post

test('every picture and written post says the day and time (India time) it is planned for, read from the plan file, so a moved post shows its new day', async () => {
  const s = await start();
  try {
    const dir = join(s.root, 'brands', 'bb-acme');
    const image = join(s.root, 'pic.jpg');
    writeFileSync(image, 'pic');
    const store = new ReviewStore(dir, 'bb-acme');
    const base = { planFile: 'week-01.json', headline: 'H', caption: 'C', ctaUrl: 'https://acme.example', factIds: ['f1'], evidence: [{ factId: 'f1', text: 't', quote: 'q', url: 'https://acme.example/', context: 'c' }], imagePath: image, validation: { accepted: true, readings: 2, defects: [], reportFile: 'r.json' }, attempts: 1, costUsd: 0 };
    store.addVersion({ ...base, postId: 'w1-d1', network: 'instagram' });
    store.addVersion({ ...base, postId: 'w2-d1', network: 'instagram' });
    // The plan file as written: w1-d1 at 10:00 India time, w2-d1 at 20:30 UTC (which is 02:00 the next day in India).
    writeFileSync(join(dir, 'week-01.json'), JSON.stringify({ brand: 'bb-acme', posts: [{ id: 'w1-d1', date: '2026-11-16T10:00:00+05:30' }, { id: 'w2-d1', date: '2026-11-23T20:30:00Z' }] }));
    const listed = async (): Promise<Array<{ postId: string; date?: string; time?: string }>> => ((await (await s.call('/review/posts?status=all')).json()) as { posts: Array<{ postId: string; date?: string; time?: string }> }).posts;
    const byId = (rows: Array<{ postId: string; date?: string; time?: string }>, id: string) => rows.find((r) => r.postId === id);
    assert.deepEqual([byId(await listed(), 'w1-d1')?.date, byId(await listed(), 'w1-d1')?.time], ['2026-11-16', '10:00']);
    assert.deepEqual([byId(await listed(), 'w2-d1')?.date, byId(await listed(), 'w2-d1')?.time], ['2026-11-24', '02:00'], 'always India time, whatever offset the plan was written with');
    // A post moved to another day shows the new day (the plan file changed, so the cache is read again).
    writeFileSync(join(dir, 'week-01.json'), JSON.stringify({ brand: 'bb-acme', posts: [{ id: 'w1-d1', date: '2026-11-19T10:00:00+05:30' }, { id: 'w2-d1', date: '2026-11-23T20:30:00Z' }] }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(byId(await listed(), 'w1-d1')?.date, '2026-11-19');
    // A picture of a post the plan does not know has no day, and nothing breaks.
    store.addVersion({ ...base, postId: 'ghost', network: 'instagram' });
    assert.equal(byId(await listed(), 'ghost')?.date, undefined);
    // The written posts carry their time too.
    const batches = (await (await s.call('/review/copy')).json()) as { batches: Array<{ posts: Array<{ postId: string; date?: string; time?: string }> }> };
    const post = batches.batches[0]?.posts.find((p) => p.postId === 'w1-d1');
    assert.deepEqual([post?.date, post?.time], ['2026-11-16', '10:00'], 'the batch keeps its own day; the time is the plan\'s');
  } finally {
    await s.done();
  }
});

// ---- another day for a written post

test('a written post moves to another day of its own week, whatever its state, until its week is drawn; the plan file is changed with it and a failure changes nothing', () => {
  const t = topicFixture();
  try {
    const monday = futureWeek();
    const s = new CopyStage(t.dir, 'bb-acme');
    s.open('week-03.json', [0, 1, 2].map((n) => post(`p${n}`, dayOf(monday, n))), [0, 1, 2].map((n) => dayOf(monday, n)));
    s.decide('week-03.json', 'p1', 'kept', 'u');
    s.decide('week-03.json', 'p2', 'dropped', 'u');
    const planned: Array<[string, string]> = [];
    const move = (id: string, day: string, today = todayIst(), plan: (id: string, day: string) => void = (i, d) => { planned.push([i, d]); }) => s.movePost('week-03.json', id, day, today, plan);

    for (const [id, to] of [['p0', dayOf(monday, 4)], ['p1', dayOf(monday, 6)], ['p2', dayOf(monday, 5)]] as const) {
      const result = move(id, to);
      assert.equal(result.moved, true, `${id}: pending, kept and dropped posts all move`);
      assert.equal(result.batch.posts.find((p) => p.postId === id)?.date, to);
    }
    assert.deepEqual(planned.map(([id]) => id), ['p0', 'p1', 'p2'], 'the plan file was changed for each');
    assert.equal(s.get('week-03.json').posts.find((p) => p.postId === 'p1')?.state, 'kept', 'the choice stays');
    // A day the plan asked for that no post is on any more is reported as the day it was moved to, not as a day with no post.
    assert.deepEqual(s.get('week-03.json').requestedDays, [dayOf(monday, 4), dayOf(monday, 5), dayOf(monday, 6)]);

    const same = move('p0', dayOf(monday, 4));
    assert.equal(same.moved, false, 'the day it already has changes nothing');
    assert.equal(planned.length, 3, 'and the plan file is not touched');
    const outside = (work: () => unknown): string | undefined => { try { work(); } catch (error) { return error instanceof CopyStageError ? error.code : String(error); } return undefined; };
    assert.equal(outside(() => move('p0', dayOf(monday, 7))), 'OUTSIDE_WEEK', 'the next Monday is another week');
    assert.equal(outside(() => move('p0', dayOf(monday, -1))), 'OUTSIDE_WEEK');
    assert.equal(outside(() => move('p0', dayOf(monday, 1), dayOf(monday, 1))), 'DAY_PASSED', 'today or earlier');
    assert.equal(outside(() => move('p0', 'next friday')), 'INVALID');
    assert.equal(outside(() => move('p0', '2026-02-31')), 'INVALID', 'not a real day');
    assert.equal(outside(() => move('p0', '2026-13-40')), 'INVALID', 'not a day at all');
    assert.equal(outside(() => move('nope', dayOf(monday, 2))), 'NOT_FOUND');
    assert.equal(outside(() => move('p0', dayOf(monday, 2), todayIst(), () => { throw new Error('disk full'); })), 'Error: disk full');
    assert.equal(s.get('week-03.json').posts.find((p) => p.postId === 'p0')?.date, dayOf(monday, 4), 'a failed plan write leaves the batch as it was');
    s.markWeekDrawn('week-03.json', monday);
    assert.equal(outside(() => move('p0', dayOf(monday, 2))), 'ALREADY_DRAWN', 'a week that was drawn is final');
  } finally {
    t.done();
  }
});

test('moving a post over HTTP changes its day in the batch and in the plan file, keeps its time, and says when its words name a day', async () => {
  const s = await start();
  try {
    const monday = futureWeek();
    const dir = join(s.root, 'brands', 'bb-acme');
    const copy = new CopyStage(dir, 'bb-acme');
    const named = { ...post('p1', dayOf(monday, 1)), caption: 'Come on Friday for the special', captions: { instagram: { text: 'ig Friday' } } };
    copy.open('week-03.json', [post('p0', dayOf(monday, 0)), named]);
    writeFileSync(join(dir, 'week-03.json'), JSON.stringify({ posts: [{ id: 'p0', date: `${dayOf(monday, 0)}T14:30:00+05:30` }, { id: 'p1', date: `${dayOf(monday, 1)}T10:00:00+05:30` }] }));
    const move = (id: string, day: unknown): Promise<Response> => s.call(`/review/copy/bb-acme/week-03.json/${id}/move`, { day });
    const done = await move('p0', dayOf(monday, 3));
    assert.equal(done.status, 200, JSON.stringify(await done.clone().json()));
    const answer = (await done.json()) as { batch: { posts: Array<{ postId: string; date: string }> }; moved: boolean; warnings: string[] };
    assert.deepEqual([answer.moved, answer.warnings, answer.batch.posts.find((p) => p.postId === 'p0')?.date], [true, [], dayOf(monday, 3)]);
    const plan = JSON.parse(readFileSync(join(dir, 'week-03.json'), 'utf8')) as { posts: Array<{ id: string; date: string }> };
    assert.equal(plan.posts.find((p) => p.id === 'p0')?.date, `${dayOf(monday, 3)}T14:30:00+05:30`, 'the plan file has the new day and the same time');
    assert.equal(plan.posts.find((p) => p.id === 'p1')?.date, `${dayOf(monday, 1)}T10:00:00+05:30`, 'the other post is untouched');
    const warned = (await (await move('p1', dayOf(monday, 5))).json()) as { warnings: string[] };
    assert.deepEqual(warned.warnings, ['WORDS_NAME_A_DAY']);
    const same = (await (await move('p1', dayOf(monday, 5))).json()) as { moved: boolean; warnings: string[] };
    assert.deepEqual([same.moved, same.warnings], [false, []]);
    const refused = async (res: Response): Promise<{ status: number; code: string }> => ({ status: res.status, code: ((await res.json()) as { code: string }).code });
    assert.deepEqual(await refused(await move('p0', dayOf(monday, 8))), { status: 400, code: 'OUTSIDE_WEEK' });
    assert.deepEqual(await refused(await move('p0', todayIst())), { status: 400, code: 'OUTSIDE_WEEK' }, 'today is another week than this post\'s (the passed-day rule is in the stage test)');
    assert.deepEqual(await refused(await move('p0', 42)), { status: 400, code: 'INVALID' });
    assert.deepEqual(await refused(await move('nope', dayOf(monday, 2))), { status: 404, code: 'NOT_FOUND' });
    // A day that is today, in this post's own week (not possible on a Sunday, when the week has no later day).
    const tomorrow = dayOf(todayIst(), 1);
    if (mondayOf(tomorrow) === mondayOf(todayIst())) {
      copy.open('week-04.json', [post('c0', tomorrow)]);
      writeFileSync(join(dir, 'week-04.json'), JSON.stringify({ posts: [{ id: 'c0', date: `${tomorrow}T10:00:00+05:30` }] }));
      assert.deepEqual(await refused(await s.call('/review/copy/bb-acme/week-04.json/c0/move', { day: todayIst() })), { status: 400, code: 'DAY_PASSED' });
    }
    // Once its week is drawn the day is final.
    copy.markWeekDrawn('week-03.json', monday);
    assert.deepEqual(await refused(await move('p0', dayOf(monday, 2))), { status: 409, code: 'ALREADY_DRAWN' });
  } finally {
    await s.done();
  }
});

// ---- the lock is on each post, not on the week

import { drawCandidates, openPosts, postLocked } from './copy-stage.ts';

test('a post sent to be drawn is final on its own: the rest of its week stays open, a kept post that got no picture is open again, and a week an older draw closed still locks every post', () => {
  const s = stage();
  try {
    const refused = (work: () => unknown): string | undefined => { try { work(); } catch (error) { return error instanceof CopyStageError ? error.code : String(error); } return undefined; };
    s.stage.decide('week-01.json', 'w1-d1', 'kept', 'u');
    s.stage.decide('week-01.json', 'w1-d2', 'kept', 'u');
    s.stage.markPostsDrawn('week-01.json', ['w1-d1']);
    const batch = s.stage.get('week-01.json');
    assert.equal(postLocked(batch, batch.posts[0] as never), true, 'the drawn post is final');
    assert.equal(postLocked(batch, batch.posts[1] as never), false, 'its neighbour in the same week is not');
    assert.equal(batch.weekDrawn, undefined, 'the week itself is not marked');
    assert.equal(refused(() => s.stage.decide('week-01.json', 'w1-d1', 'dropped', 'u')), 'ALREADY_DRAWN');
    assert.equal(refused(() => s.stage.edit('week-01.json', 'w1-d1', { headline: 'New', caption: 'New' }, 'u', () => undefined)), 'ALREADY_DRAWN');
    assert.equal(refused(() => s.stage.markPostsDrawn('week-01.json', ['w1-d1'])), 'ALREADY_DRAWN', 'a post is never sent to be drawn twice');
    assert.equal(refused(() => s.stage.decide('week-01.json', 'w1-d2', 'dropped', 'u')), undefined, 'an undrawn post of the same week can still be changed');
    assert.equal(refused(() => s.stage.markPostsDrawn('week-01.json', ['w2-d1'])), 'REJECTED', 'only a kept post is drawn');
    assert.equal(refused(() => s.stage.markPostsDrawn('week-01.json', ['nope'])), 'NOT_FOUND');
    // Nothing is changed when one of them is refused.
    s.stage.decide('week-01.json', 'w1-d2', 'kept', 'u');
    assert.equal(refused(() => s.stage.markPostsDrawn('week-01.json', ['w1-d2', 'w1-d1'])), 'ALREADY_DRAWN');
    assert.equal(s.stage.get('week-01.json').posts[1]?.drawnAt, undefined);
    // A drawn post that got no picture is open again, like any kept post without one.
    s.stage.setNotDrawn('week-01.json', { 'w1-d1': { code: 'NO_PICTURE', reason: 'no picture' } as never });
    assert.equal(postLocked(s.stage.get('week-01.json'), s.stage.get('week-01.json').posts[0] as never), false);

    // An older batch (its week was closed as a whole) locks every post of the week, as before.
    const old = stage();
    try {
      old.stage.markWeekDrawn('week-01.json', W1);
      assert.equal(refused(() => old.stage.decide('week-01.json', 'w1-d2', 'kept', 'u')), 'ALREADY_DRAWN');
    } finally {
      old.done();
    }
  } finally {
    s.done();
  }
});

test('what a draw asked for now would draw: kept posts of the week with no picture, whose day is ahead, and not part of a draw that is running; the open posts are those not sent to be drawn', () => {
  const s = stage();
  try {
    for (const id of ['w1-d1', 'w1-d2']) s.stage.decide('week-01.json', id, 'kept', 'u');
    s.stage.decide('week-01.json', 'w2-d1', 'kept', 'u');
    const get = () => s.stage.get('week-01.json');
    assert.deepEqual(drawCandidates(get(), W1, new Set(), '2026-11-12'), ['w1-d1', 'w1-d2']);
    assert.deepEqual(drawCandidates(get(), W1, new Set(), '2026-11-16'), ['w1-d2'], 'the day of a post is today: not drawn for a customer');
    assert.deepEqual(drawCandidates(get(), W1, new Set(['w1-d1|instagram']), '2026-11-12'), ['w1-d2'], 'a post that has a picture');
    assert.deepEqual(drawCandidates(get(), W1, new Set(), '2026-11-12', new Set(['w1-d2'])), ['w1-d1'], 'a post in a draw that is running');
    assert.deepEqual(drawCandidates(get(), W2, new Set(), '2026-11-12'), ['w2-d1'], 'another week of the batch');
    s.stage.markPostsDrawn('week-01.json', ['w1-d1']);
    assert.deepEqual(drawCandidates(get(), W1, new Set(), '2026-11-12'), ['w1-d2'], 'a post that was sent to be drawn is not drawn again');
    assert.deepEqual(openPosts(get(), W1, '2026-11-12'), ['w1-d2'], 'the drawn post is no longer open');
    assert.deepEqual(openPosts(get(), W1, '2026-11-17'), [], 'and a post whose day is today is not open');
  } finally {
    s.done();
  }
});

test('drawing by the post over HTTP: each ask draws only the kept posts with no picture, the rest of the week stays open, a double tap is one job, and the week reads partly drawn', async () => {
  const s = await start();
  try {
    const dir = join(s.root, 'brands', 'bb-acme');
    const store = new ReviewStore(dir, 'bb-acme');
    const image = join(s.root, 'pic.jpg');
    writeFileSync(image, 'pic');
    const base = { planFile: 'week-01.json', headline: 'H', caption: 'C', ctaUrl: 'https://acme.example', factIds: ['f1'], evidence: [{ factId: 'f1', text: 't', quote: 'q', url: 'https://acme.example/', context: 'c' }], imagePath: image, validation: { accepted: true, readings: 2, defects: [], reportFile: 'r.json' }, attempts: 1, costUsd: 0 };
    const call = (path: string, body: unknown = {}): Promise<Response> => s.call(path, body);
    const json = async (res: Response): Promise<Record<string, any>> => (await res.json()) as Record<string, any>;
    const listed = async (): Promise<{ weeks: Array<{ from: string; state: string; openPostIds?: string[] }>; posts: Array<{ postId: string; drawn: boolean; locked: boolean; state: string }> }> => ((await (await s.call('/review/copy')).json()) as { batches: Array<any> }).batches[0];

    for (const id of ['w1-d1']) assert.equal((await call(`/review/copy/bb-acme/week-01.json/${id}/keep`)).status, 200);
    const first = await call('/review/copy/bb-acme/week-01.json/draw', { week: W1 });
    assert.equal(first.status, 202, JSON.stringify(await first.clone().json()));
    const one = (await json(first)) as { job: { id: string; week: string; postIds: string[] }; created: boolean };
    assert.deepEqual([one.job.week, one.job.postIds, one.created], [W1, ['w1-d1'], true]);
    assert.deepEqual(engineArgs(one.job as never).slice(-4), ['--draw-week', W1, '--draw-posts', 'w1-d1']);
    // While it runs, the post in it is locked and a double tap is the same job; the others of the week are open.
    assert.equal((await call('/review/copy/bb-acme/week-01.json/w1-d1/drop')).status, 409, 'a post in a running draw is final');
    const again = await call('/review/copy/bb-acme/week-01.json/draw', { week: W1 });
    assert.equal(again.status, 200);
    assert.equal(((await json(again)).job as { id: string }).id, one.job.id, 'a double tap is the same job, nothing is bought twice');
    assert.equal((await call('/review/copy/bb-acme/week-01.json/w1-d2/keep')).status, 200, 'another post of the same week can still be kept');
    // The draw job does what autopilot does: it marks its posts and the pictures appear.
    new CopyStage(dir, 'bb-acme').markPostsDrawn('week-01.json', ['w1-d1']);
    store.addVersion({ ...base, postId: 'w1-d1', network: 'instagram' });
    s.jobs.update(one.job.id, { state: 'succeeded' });

    const mid = await listed();
    assert.deepEqual([mid.weeks[0]?.state, mid.weeks[0]?.openPostIds], ['partly_drawn', ['w1-d2']], 'one post drawn, the others open');
    assert.deepEqual(mid.posts.map((p) => [p.postId, p.drawn, p.locked]), [['w1-d1', true, true], ['w1-d2', false, false], ['w2-d1', false, false], ['w2-d2', false, false]]);

    // A second ask draws only what was kept since.
    const second = await call('/review/copy/bb-acme/week-01.json/draw', { week: W1 });
    assert.equal(second.status, 202, JSON.stringify(await second.clone().json()));
    const later = (await json(second)) as { job: { postIds: string[] } };
    assert.deepEqual(later.job.postIds, ['w1-d2']);
    // With nothing new kept, there is nothing to draw.
    new CopyStage(dir, 'bb-acme').markPostsDrawn('week-01.json', ['w1-d2']);
    s.jobs.update(((later.job as unknown) as { id: string }).id, { state: 'succeeded' });
    store.addVersion({ ...base, postId: 'w1-d2', network: 'instagram' });
    const none = await call('/review/copy/bb-acme/week-01.json/draw', { week: W1 });
    assert.equal(none.status, 422);
    const after = await listed();
    assert.equal(after.weeks[0]?.state, 'drawn', 'no open post is left in the week');
    assert.equal(after.weeks[1]?.state, 'waiting', 'the other week is untouched');
  } finally {
    await s.done();
  }
});

test('keeping a post whose day is today or has passed is refused with DAY_PASSED, by the clock the service has', async () => {
  const s = await start('2026-11-16T06:30:00Z');
  try {
    const refused = await s.call('/review/copy/bb-acme/week-01.json/w1-d1/keep', {});
    assert.equal(refused.status, 400);
    assert.equal(((await refused.json()) as { code: string }).code, 'DAY_PASSED');
    assert.equal((await s.call('/review/copy/bb-acme/week-01.json/w1-d2/keep', {})).status, 200, 'a later day is fine');
    assert.equal((await s.call('/review/copy/bb-acme/week-01.json/w1-d1/drop', {})).status, 200, 'dropping a post whose day passed is still fine');
  } finally {
    await s.done();
  }
});

test('a kept or dropped post can be put back to undecided until its day or its drawing, and not after', async () => {
  const s = await start('2026-11-16T06:30:00Z');
  try {
    const stateOf = async (res: Response, id: string): Promise<string | undefined> => ((await res.json()) as { batch: { posts: Array<{ postId: string; state: string }> } }).batch.posts.find((p) => p.postId === id)?.state;
    assert.equal((await s.call('/review/copy/bb-acme/week-01.json/w1-d2/keep', {})).status, 200);
    assert.equal(s.copy.get('week-01.json').posts.find((p) => p.postId === 'w1-d2')?.decidedBy !== undefined, true);
    const back = await s.call('/review/copy/bb-acme/week-01.json/w1-d2/reset', {});
    assert.equal(back.status, 200);
    assert.equal(await stateOf(back, 'w1-d2'), 'pending', 'a kept post is undecided again');
    const post = s.copy.get('week-01.json').posts.find((p) => p.postId === 'w1-d2');
    assert.deepEqual([post?.decidedBy, post?.decidedAt], [undefined, undefined], 'nobody is recorded as having decided it');
    assert.equal((await s.call('/review/copy/bb-acme/week-01.json/w1-d2/drop', {})).status, 200);
    assert.equal(await stateOf(await s.call('/review/copy/bb-acme/week-01.json/w1-d2/reset', {}), 'w1-d2'), 'pending', 'and so is a dropped one');
    assert.equal(await stateOf(await s.call('/review/copy/bb-acme/week-01.json/w1-d2/reset', {}), 'w1-d2'), 'pending', 'asking again changes nothing');

    // Today or a day that passed: refused, like keeping it.
    const past = await s.call('/review/copy/bb-acme/week-01.json/w1-d1/reset', {});
    assert.equal(past.status, 400);
    assert.equal(((await past.json()) as { code: string }).code, 'DAY_PASSED');

    // Once it was sent to be drawn its choice is final.
    assert.equal((await s.call('/review/copy/bb-acme/week-01.json/w1-d2/keep', {})).status, 200);
    s.copy.markPostsDrawn('week-01.json', ['w1-d2']);
    const locked = await s.call('/review/copy/bb-acme/week-01.json/w1-d2/reset', {});
    assert.equal(locked.status, 409);
    assert.equal(s.copy.get('week-01.json').posts.find((p) => p.postId === 'w1-d2')?.state, 'kept', 'unchanged');
  } finally {
    await s.done();
  }
});

test('a dropped post that was given a new topic cannot be put back to undecided', () => {
  const root = mkdtempSync(join(tmpdir(), 'reset-replaced-'));
  try {
    const dir = join(root, 'bb-acme');
    mkdirSync(dir, { recursive: true });
    const stage = new CopyStage(dir, 'bb-acme');
    stage.open('week-01.json', [{ postId: 'p1', date: '2026-11-24', headline: 'H', caption: 'C' }]);
    stage.decide('week-01.json', 'p1', 'dropped', 'u');
    stage.addReplacement('week-01.json', 'p1', { postId: 'p1r', date: '2026-11-24', headline: 'H2', caption: 'C2' }, '2026-11-16', 3);
    assert.throws(() => stage.decide('week-01.json', 'p1', 'pending', 'u'), /new topic was already written/);
    assert.equal(stage.get('week-01.json').posts.find((p) => p.postId === 'p1')?.state, 'dropped');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('moving a carousel over HTTP: a carousel that is not waiting or approved is a 409, a day that is not text a 400, another brand\'s carousel is not hers to move', async () => {
  const s = await start('2026-11-16T06:30:00Z');
  try {
    const dir = join(s.root, 'brands', 'bb-acme');
    writeFileSync(join(dir, 'week-09.json'), JSON.stringify({ brand: 'bb-acme', posts: [{ id: 'car-1', date: '2026-11-20T10:00:00+05:30' }] }));
    writeFileSync(join(dir, 'carousels.json'), JSON.stringify({ carousels: [{ id: 'car-1', topic: 'Why it works', createdAt: '2026-11-12T00:00:00Z', planFile: 'week-09.json', date: '2026-11-20T10:00:00+05:30' }] }));
    const incomplete = await s.call('/review/carousels/bb-acme/car-1/move', { day: '2026-11-19' });
    assert.equal(incomplete.status, 409, 'it has no slides, so it is incomplete');
    assert.equal(((await incomplete.json()) as { code: string }).code, 'CONFLICT');
    assert.equal((await s.call('/review/carousels/bb-acme/car-1/move', { day: 19 })).status, 400);
    assert.equal(JSON.parse(readFileSync(join(dir, 'week-09.json'), 'utf8')).posts[0].date, '2026-11-20T10:00:00+05:30', 'nothing moved');
    const owners = new ProductBrands(join(s.root, 'brands'));
    mkdirSync(join(s.root, 'brands', 'bb-other'), { recursive: true });
    owners.claim('bb-other', 'brandbasket', () => false);
    const asOther = await fetch(`${s.base}/review/carousels/bb-acme/car-1/move`, { method: 'POST', headers: { Authorization: `Bearer ${PRODUCT}`, 'X-Brand': 'bb-other', 'X-Actor': 'brandbasket:u', 'Content-Type': 'application/json' }, body: JSON.stringify({ day: '2026-11-19' }) });
    assert.ok([403, 404].includes(asOther.status), 'another brand\'s carousel is refused');
  } finally {
    await s.done();
  }
});

// ---- PRODUCT_LIMITS=off lifts the limits for a stretch of testing, and only when it is exactly "off"

import { productLimitsOff, UNLIMITED } from './limits-switch.ts';
import { weeklyLimitFromEnv } from './picture-limit.ts';

/** Runs `work` with PRODUCT_LIMITS set (or not), and puts the setting back. */
async function withLimits<T>(value: string | undefined, work: () => Promise<T>): Promise<T> {
  const before = process.env['PRODUCT_LIMITS'];
  if (value === undefined) delete process.env['PRODUCT_LIMITS'];
  else process.env['PRODUCT_LIMITS'] = value;
  try {
    return await work();
  } finally {
    if (before === undefined) delete process.env['PRODUCT_LIMITS'];
    else process.env['PRODUCT_LIMITS'] = before;
  }
}

test('the limits switch is on only for exactly PRODUCT_LIMITS=off, and lifts the weekly pictures of a channel', () => {
  assert.equal(productLimitsOff({}), false);
  for (const value of ['', 'on', 'OFF', 'false', 'no', '0', 'off ']) assert.equal(productLimitsOff({ PRODUCT_LIMITS: value }), false, value);
  assert.equal(productLimitsOff({ PRODUCT_LIMITS: 'off' }), true);
  assert.equal(weeklyLimitFromEnv({}), 7, 'the weekly pictures of a channel, as always');
  assert.equal(weeklyLimitFromEnv({ PRODUCT_PICTURES_PER_CHANNEL_WEEK: '5' }), 5);
  assert.throws(() => weeklyLimitFromEnv({ PRODUCT_PICTURES_PER_CHANNEL_WEEK: '99' }), /1 to 20/, 'a bad setting is still an error while the limits are on');
  assert.equal(weeklyLimitFromEnv({ PRODUCT_LIMITS: 'off' }), UNLIMITED);
  assert.equal(weeklyLimitFromEnv({ PRODUCT_LIMITS: 'off', PRODUCT_PICTURES_PER_CHANNEL_WEEK: '5' }), UNLIMITED);
});

test('with the limits off a customer may add more than one topic a week and more than three new topics a week; with them on (or no setting) nothing changes', async () => {
  const s = await start();
  try {
    const dir = join(s.root, 'brands', 'bb-acme');
    writeFileSync(join(dir, 'facts.json'), JSON.stringify({ version: 1, builtAt: '2026-11-01T00:00:00Z', site: 'https://acme.example', facts: [], conflicts: [], snapshots: [], coverage: { pages: 0, structured: 0, flatText: 0, usable: 0, needsReview: 0, excluded: 0, notes: [] } }));
    const day = inDays(3);
    const topic = (text: string): Promise<Response> => s.call('/review/jobs', { kind: 'topic', site: 'acme.example', brand: 'bb-acme', networks: ['instagram'], startDate: day, text });
    const first = await topic('Diwali special: 20% off all thalis until 2 Nov.');
    assert.equal(first.status, 202);
    s.jobs.update(((await first.json()) as { job: { id: string } }).job.id, { state: 'succeeded' });
    assert.equal((await withLimits(undefined, () => topic('New dish: paneer kulcha, served from Monday.'))).status, 429, 'no setting: one a week');
    assert.equal((await withLimits('on', () => topic('New dish: paneer kulcha, served from Monday.'))).status, 429);
    const lifted = await withLimits('off', () => topic('New dish: paneer kulcha, served from Monday.'));
    assert.equal(lifted.status, 202, JSON.stringify(await lifted.clone().json()));

    // New topics of dropped posts: a fourth in one week is refused, unless the limits are off.
    const monday = futureWeek();
    const copy = new CopyStage(dir, 'bb-acme');
    copy.open('week-03.json', [0, 1, 2, 3].map((n) => post(`p${n}`, dayOf(monday, n))));
    for (const id of ['p0', 'p1', 'p2', 'p3']) copy.decide('week-03.json', id, 'dropped', 'u');
    const replace = (id: string): Promise<Response> => s.call(`/review/copy/bb-acme/week-03.json/${id}/replace`, {});
    for (const id of ['p0', 'p1', 'p2']) assert.equal((await replace(id)).status, 202);
    assert.equal((await replace('p3')).status, 429, 'the fourth new topic of a week is refused');
    assert.equal((await withLimits('off', () => replace('p3'))).status, 202, 'unless the limits are off');
    const listed = (await (await withLimits('off', () => s.call('/review/copy'))).json()) as { batches: Array<{ planFile: string; replacementsLeft?: Record<string, number> }> };
    assert.ok((listed.batches.find((b) => b.planFile === 'week-03.json')?.replacementsLeft?.[monday] ?? 0) > 3, 'the screen is told there is room');
  } finally {
    await s.done();
  }
});
