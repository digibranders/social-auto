import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReviewServer } from './review-server.ts';
import { ProductBrands } from './product-brands.ts';
import { ReviewStore, type NewVersion } from './review-store.ts';
import { JobStore } from './job-store.ts';
import { CopyStage } from './copy-stage.ts';
import { engineArgs } from './job-runner.ts';

const PRODUCT = 'brandbasket-secret-0123456789';

/** A product brand with one topic written for two networks, and a customer's calls on it. */
async function start() {
  const root = mkdtempSync(join(tmpdir(), 'customer-flow-'));
  const brandsRoot = join(root, 'brands');
  const dir = join(brandsRoot, 'bb-acme');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'brand.json'), JSON.stringify({ name: 'Acme', website: 'https://acme.example' }));
  writeFileSync(join(dir, 'week-01.json'), JSON.stringify({ brand: 'bb-acme', timezone: '+05:30', renderMode: 'ai_v1', posts: [{ id: 'w01-d1', date: '2099-11-10T10:00:00+05:30', painPoint: 'p', mode: 'ai', headline: 'Answers from your own docs', subline: '', caption: 'Hook.', hashtags: ['#a'], factIds: ['f1'], imagePrompt: 'a picture', variants: { instagram: { caption: 'Caption for instagram.', hashtags: ['#a'] }, linkedin: { caption: 'Caption for linkedin.', hashtags: ['#a'] } } }] }));
  new ProductBrands(brandsRoot).claim('bb-acme', 'brandbasket', () => false);
  const store = new ReviewStore(dir, 'bb-acme');
  const picture = (name: string): string => { const p = join(root, name); writeFileSync(p, name); return p; };
  const make = (network: string, extra: Partial<NewVersion> = {}) => store.addVersion({
    postId: 'w01-d1', planFile: 'week-01.json', network, width: 1080, height: network === 'instagram' ? 1350 : 1080, headline: 'Answers from your own docs', caption: `Caption for ${network}.`, ctaUrl: 'https://acme.example', factIds: ['f1'],
    evidence: [{ factId: 'f1', text: 't', quote: 'q', url: 'https://acme.example/', context: 'c' }], imagePath: picture(`${network}-${Math.random()}.jpg`),
    validation: { accepted: true, readings: 2, defects: [], reportFile: 'r.json' }, attempts: 1, costUsd: 0.016, ...extra,
  });
  const server = createReviewServer({ brandsRoot, secret: 'staff-secret-0123456789', jobsRoot: join(root, 'jobs'), products: [{ id: 'brandbasket', secret: PRODUCT }] });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, body?: unknown): Promise<Response> => fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${PRODUCT}`, 'X-Brand': 'bb-acme', 'X-Actor': 'brandbasket:user-42', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const jobs = new JobStore(join(root, 'jobs'));
  return { store, make, call, jobs, root, dir, base, done: async () => { await new Promise((resolve) => server.close(resolve)); rmSync(root, { recursive: true, force: true }); } };
}

test('a new version replaces only its own network, and the customer approves the topic once', async () => {
  const s = await start();
  try {
    const ig1 = s.make('instagram');
    const li1 = s.make('linkedin');
    const ig2 = s.make('instagram', { parentVersionId: ig1.versionId });
    const list = (await (await s.call('/review/posts?status=all')).json()) as { posts: Array<{ versionId: string; network: string; status: string }> };
    const status = Object.fromEntries(list.posts.map((p) => [p.versionId, p.status]));
    assert.equal(status[ig1.versionId], 'superseded');
    assert.equal(status[ig2.versionId], 'pending');
    assert.equal(status[li1.versionId], 'pending', 'the other network is untouched');
    assert.equal((await s.call(`/review/posts/${ig1.versionId}/approve`, {})).status, 409, 'an old version cannot be approved');

    const topic = '/review/topics/bb-acme/week-01.json/w01-d1/approve';
    const first = (await (await s.call(topic, {})).json()) as { decisions: Array<{ versionId: string }> };
    assert.deepEqual(first.decisions.map((d) => d.versionId).sort(), [ig2.versionId, li1.versionId].sort());
    const second = await s.call(topic, {});
    assert.equal(second.status, 200, 'a second click is the same answer');
    assert.deepEqual(((await second.json()) as { decisions: Array<{ versionId: string }> }).decisions.map((d) => d.versionId).sort(), [ig2.versionId, li1.versionId].sort());
    const approved = (await (await s.call('/review/posts?status=approved')).json()) as { posts: Array<{ decidedBy: string }> };
    assert.equal(approved.posts.length, 2, 'two approvals, not four');
    assert.ok(approved.posts.every((p) => p.decidedBy === 'brandbasket:user-42'));
  } finally {
    await s.done();
  }
});

test('the customer can withdraw an approved poster, and an approved poster is not served once a newer version exists', async () => {
  const s = await start();
  try {
    const ig = s.make('instagram');
    assert.equal((await s.call(`/review/posts/${ig.versionId}/approve`, {})).status, 200);
    assert.equal((await s.call(`/review/posts/${ig.versionId}/download`)).status, 200);
    const withdrawn = await s.call(`/review/posts/${ig.versionId}/reject`, { reason: 'other', comment: 'changed my mind' });
    assert.equal(withdrawn.status, 200);
    assert.equal(((await withdrawn.json()) as { status: string }).status, 'rejected');
    assert.equal((await s.call(`/review/posts/${ig.versionId}/download`)).status, 409, 'a withdrawn poster is no longer a download');
    const again = await s.call(`/review/posts/${ig.versionId}/reject`, { reason: 'other' });
    assert.equal(again.status, 200, 'withdrawing twice is not an error');
    assert.equal((await s.call(`/review/posts/${ig.versionId}/approve`, {})).status, 409, 'a rejected version needs a new version');
  } finally {
    await s.done();
  }
});

test('a poster that was rejected can be drawn again once, for its own network only, and the allowance is not used by a try that bought nothing', async () => {
  const s = await start();
  try {
    const ig = s.make('instagram');
    const li = s.make('linkedin');
    assert.equal((await s.call(`/review/posts/${ig.versionId}/reject`, { reason: 'poor_design' })).status, 200);
    const before = (await (await s.call('/review/posts?status=rejected')).json()) as { posts: Array<{ canRedraw: boolean; redrawsLeft: number }> };
    assert.deepEqual([before.posts[0]?.canRedraw, before.posts[0]?.redrawsLeft], [true, 1]);

    const asked = await s.call(`/review/posts/${ig.versionId}/redraw`, {});
    assert.equal(asked.status, 202);
    const job = ((await asked.json()) as { job: { id: string; kind: string; planFile: string; postId: string; network: string; by: string } }).job;
    assert.deepEqual([job.kind, job.planFile, job.postId, job.network, job.by], ['redraw', 'week-01.json', 'w01-d1', 'instagram', 'brandbasket:user-42']);
    assert.deepEqual(engineArgs(s.jobs.get(job.id)), ['src/autopilot.ts', '--site', 'https://acme.example', '--brand', 'bb-acme', '--draw-kept', 'week-01.json', '--redraw-post', 'w01-d1', '--redraw-network', 'instagram']);
    const twice = await s.call(`/review/posts/${ig.versionId}/redraw`, {});
    assert.equal(twice.status, 200, 'a second click while it is waiting is the same job');
    assert.equal(((await twice.json()) as { job: { id: string } }).job.id, job.id);

    // It stopped having bought nothing: the allowance is not used and it can be asked for again.
    s.jobs.claim(5, process.pid);
    s.jobs.update(job.id, { state: 'failed', error: { code: 'NOTHING_DRAWN', message: 'nothing passed' } });
    const retry = await s.call(`/review/posts/${ig.versionId}/redraw`, {});
    assert.equal(retry.status, 202);
    // It ran and was spent: the one allowed redraw is used.
    const second = ((await retry.json()) as { job: { id: string } }).job;
    s.jobs.claim(5, process.pid);
    s.jobs.update(second.id, { state: 'succeeded' });
    const limited = await s.call(`/review/posts/${ig.versionId}/redraw`, {});
    assert.equal(limited.status, 409);
    assert.equal(((await limited.json()) as { code: string }).code, 'LIMIT');
    const after = (await (await s.call('/review/posts?status=rejected')).json()) as { posts: Array<{ canRedraw: boolean; redrawsLeft: number }> };
    assert.deepEqual([after.posts[0]?.canRedraw, after.posts[0]?.redrawsLeft], [false, 0]);
    // The other network was never touched and has its own allowance.
    assert.equal((await s.call(`/review/posts/${li.versionId}/redraw`, {})).status, 202);
  } finally {
    await s.done();
  }
});

test('an approved or replaced poster cannot be drawn again', async () => {
  const s = await start();
  try {
    const old = s.make('instagram');
    s.make('instagram', { parentVersionId: old.versionId });
    assert.equal((await s.call(`/review/posts/${old.versionId}/redraw`, {})).status, 409, 'a replaced picture');
    const live = (await (await s.call('/review/posts?status=pending')).json()) as { posts: Array<{ versionId: string }> };
    const current = live.posts[0]?.versionId ?? '';
    assert.equal((await s.call(`/review/posts/${current}/approve`, {})).status, 200);
    const approved = await s.call(`/review/posts/${current}/redraw`, {});
    assert.equal(approved.status, 409, 'an approved poster must be withdrawn first');
    assert.equal(((await approved.json()) as { code: string }).code, 'CONFLICT');
    assert.equal(s.jobs.list().length, 0, 'nothing was queued');
  } finally {
    await s.done();
  }
});

test('a blocked picture can be put away by the customer, and still can never be approved or downloaded', async () => {
  const s = await start();
  try {
    const bad = s.make('instagram', { validation: { accepted: false, readings: 2, defects: ['extra_text'], reportFile: 'r.json' } });
    const before = (await (await s.call('/review/posts?status=blocked')).json()) as { posts: Array<{ versionId: string }> };
    assert.deepEqual(before.posts.map((p) => p.versionId), [bad.versionId]);
    assert.equal((await s.call(`/review/posts/${bad.versionId}/approve`, {})).status, 409);
    const away = await s.call(`/review/posts/${bad.versionId}/reject`, { reason: 'other' });
    assert.equal(away.status, 200);
    assert.equal(((await away.json()) as { status: string }).status, 'rejected');
    assert.equal(((await (await s.call('/review/posts?status=blocked')).json()) as { posts: unknown[] }).posts.length, 0, 'it has left the blocked list');
    assert.equal((await s.call(`/review/posts/${bad.versionId}/approve`, {})).status, 409, 'a put-away picture is not approvable');
    assert.equal((await s.call(`/review/posts/${bad.versionId}/download`)).status, 409);
  } finally {
    await s.done();
  }
});

const NUMBER_ONE = 'We are the number one sweet shop in all of India with 500 shops worldwide.';

test('words can be checked without saving, after a draw too, and only for the customer\'s own brand', async () => {
  const s = await start();
  try {
    const planBefore = readFileSync(join(s.dir, 'week-01.json'), 'utf8');
    const path = '/review/copy/bb-acme/week-01.json/w01-d1/check';
    const ok = await s.call(path, { caption: 'Come and taste our laddoos, made fresh every morning.', network: 'linkedin' });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true });
    const refused = await s.call(path, { caption: NUMBER_ONE });
    assert.equal(refused.status, 422);
    assert.equal(((await refused.json()) as { code: string }).code, 'REJECTED');
    assert.equal((await s.call(path, { caption: 'x'.repeat(5000), network: 'instagram' })).status, 422, 'too long');
    assert.equal((await s.call(path, {})).status, 400, 'nothing to check');
    assert.equal((await s.call('/review/copy/bb-acme/week-01.json/w99-d9/check', { caption: 'Hello there.' })).status, 404);
    assert.equal(readFileSync(join(s.dir, 'week-01.json'), 'utf8'), planBefore, 'nothing was changed');
    const staff = await fetch(`${s.base}${path}`, { method: 'POST', headers: { Authorization: 'Bearer staff-secret-0123456789', 'Content-Type': 'application/json' }, body: JSON.stringify({ caption: 'Hello there.' }) });
    assert.equal(staff.status, 403);
  } finally {
    await s.done();
  }
});

test('new words for a drawn picture make a new pending version of the same picture for that network only, and the other network stays approved', async () => {
  const s = await start();
  try {
    const ig = s.make('instagram', { caption: 'Caption for instagram.\n\n#a' });
    const li = s.make('linkedin');
    assert.equal((await s.call('/review/topics/bb-acme/week-01.json/w01-d1/approve', {})).status, 200);
    const words = (id: string, body: unknown): Promise<Response> => s.call(`/review/posts/${id}/words`, body);

    assert.equal((await words(ig.versionId, { caption: NUMBER_ONE })).status, 422, 'the claim gate');
    assert.equal((await words(ig.versionId, { caption: 'Fine words.', headline: 'Another headline' })).status, 400, 'the headline is on the picture');
    assert.equal((await words(ig.versionId, { caption: ig.caption.split('\n')[0] })).status, 409, 'nothing changed');

    const made = await words(ig.versionId, { caption: 'Come and taste our laddoos, made fresh every morning.\n\n#extra' });
    assert.equal(made.status, 200);
    const created = ((await made.json()) as { version: { versionId: string; status: string; network: string; versionNumber: number; costUsd: number; canRedraw: boolean; redrawsLeft: number; caption: string } }).version;
    assert.deepEqual([created.status, created.network, created.versionNumber, created.costUsd, created.canRedraw, created.redrawsLeft], ['pending', 'instagram', 2, 0, true, 1]);
    assert.match(created.caption, /^Come and taste our laddoos, made fresh every morning\.\n\n#a$/, 'the words changed, the hashtags stayed, a typed hashtag run is not added twice');

    const before = (await (await s.call(`/review/posts/${ig.versionId}`)).json()) as { status: string; version: { imageSha256: string } };
    const after = (await (await s.call(`/review/posts/${created.versionId}`)).json()) as { status: string; version: { imageSha256: string } };
    assert.equal(before.status, 'superseded', 'the older approved version is no longer in force');
    assert.equal(after.version.imageSha256, before.version.imageSha256, 'the same picture');
    assert.equal(((await (await s.call(`/review/posts/${li.versionId}`)).json()) as { status: string }).status, 'approved', 'the other network is untouched');
    assert.equal((await s.call(`/review/posts/${created.versionId}/download`)).status, 409, 'it needs approving again');
    assert.equal((await words(ig.versionId, { caption: 'Other words here.' })).status, 409, 'the older version cannot be changed any more');
    assert.equal((await s.call(`/review/posts/${created.versionId}/approve`, {})).status, 200);
    assert.equal((await s.call(`/review/posts/${created.versionId}/download`)).status, 200);

    const bad = s.make('instagram', { postId: 'w01-d2', validation: { accepted: false, readings: 2, defects: ['extra_text'], reportFile: 'r.json' } });
    assert.equal((await words(bad.versionId, { caption: 'Fine words.' })).status, 409, 'a blocked picture');
  } finally {
    await s.done();
  }
});

test('the sign-off default of a product brand is nothing (no name, no web address), and a customer can still name a post', async () => {
  const s = await start();
  try {
    new CopyStage(s.dir, 'bb-acme').open('week-01.json', [{ postId: 'w01-d1', headline: 'Answers from your own docs', caption: 'Hook.\n\n#a', captions: { instagram: { text: 'Caption for instagram.' } } }]);
    const list = (await (await s.call('/review/copy')).json()) as { batches: Array<{ signoffDefault?: { brandName: string; domain: string; site: string } }> };
    assert.deepEqual(list.batches[0]?.signoffDefault, { brandName: '', domain: '', site: 'acme.example' });
    const put = (body: unknown): Promise<Response> => fetch(`${s.base}/review/copy/bb-acme/week-01.json/w01-d1/edit`, { method: 'PUT', headers: { Authorization: 'Bearer brandbasket-secret-0123456789', 'X-Brand': 'bb-acme', 'X-Actor': 'brandbasket:user-42', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await put({ headline: 'Answers from your own docs', caption: 'Hello there, friends.', brandName: 'Acme Sweets' })).status, 200);
    const plan = JSON.parse(readFileSync(join(s.dir, 'week-01.json'), 'utf8')) as { posts: Array<{ signoff?: { brandName?: string } }> };
    assert.equal(plan.posts[0]?.signoff?.brandName, 'Acme Sweets', 'a name chosen for the post is kept');
    assert.equal((await put({ headline: 'Answers from your own docs', caption: 'Hello there, friends.', brandName: '' })).status, 200);
    const back = JSON.parse(readFileSync(join(s.dir, 'week-01.json'), 'utf8')) as { posts: Array<{ signoff?: unknown }> };
    assert.equal(back.posts[0]?.signoff, undefined, 'an empty name is the default again: nothing is stored');
  } finally {
    await s.done();
  }
});

test('adding a network is a job on a written batch: refused for a network it has, a closed batch, an unknown network, staff and other brands; a second click is the same job', async () => {
  const s = await start();
  try {
    const stage = new CopyStage(s.dir, 'bb-acme');
    stage.open('week-01.json', [{ postId: 'w01-d1', headline: 'Answers from your own docs', caption: 'Hook.\n\n#a', captions: { instagram: { text: 'ig' }, linkedin: { text: 'li' } } }]);
    const path = '/review/copy/bb-acme/week-01.json/networks';
    assert.equal((await s.call(path, { network: 'instagram' })).status, 409, 'it already has Instagram');
    assert.equal(((await (await s.call(path, { network: 'instagram' })).json()) as { code: string }).code, 'CONFLICT');
    assert.equal((await s.call(path, { network: 'myspace' })).status, 400);
    assert.equal((await s.call(path, {})).status, 400);
    assert.equal((await s.call('/review/copy/bb-acme/week-09.json/networks', { network: 'facebook' })).status, 404);
    const asked = await s.call(path, { network: 'facebook' });
    assert.equal(asked.status, 202);
    const job = ((await asked.json()) as { job: { id: string; kind: string; network: string; planFile: string; by: string } }).job;
    assert.deepEqual([job.kind, job.network, job.planFile, job.by], ['network', 'facebook', 'week-01.json', 'brandbasket:user-42']);
    const again = await s.call(path, { network: 'facebook' });
    assert.equal(again.status, 200, 'a second click while it waits');
    assert.equal(((await again.json()) as { job: { id: string } }).job.id, job.id);
    const staff = await fetch(`${s.base}${path}`, { method: 'POST', headers: { Authorization: 'Bearer staff-secret-0123456789', 'Content-Type': 'application/json' }, body: JSON.stringify({ network: 'google' }) });
    assert.equal(staff.status, 403);
    stage.close('week-01.json', 'u');
    const closed = await s.call(path, { network: 'google' });
    assert.equal(closed.status, 409);
    assert.equal(((await closed.json()) as { code: string }).code, 'CLOSED');
  } finally {
    await s.done();
  }
});
