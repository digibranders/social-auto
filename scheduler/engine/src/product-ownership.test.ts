import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReviewServer } from './review-server.ts';
import { ReviewStore, type NewVersion } from './review-store.ts';
import { JobStore } from './job-store.ts';
import { ProductBrands } from './product-brands.ts';

const STAFF = 'staff-secret-0123456789';
const BB = 'brandbasket-secret-0123456789';
const OTHER = 'otherproduct-secret-0123456789';

async function start() {
  const root = mkdtempSync(join(tmpdir(), 'product-owned-'));
  const brandsRoot = join(root, 'brands');
  mkdirSync(brandsRoot, { recursive: true });
  const server = createReviewServer({ brandsRoot, secret: STAFF, jobsRoot: join(root, 'jobs'), products: [{ id: 'brandbasket', secret: BB }, { id: 'other', secret: OTHER }] });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (secret: string, path: string, init: { method?: string; body?: unknown; brand?: string; actor?: string } = {}): Promise<Response> =>
    fetch(`${base}${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json', ...(init.brand ? { 'X-Brand': init.brand } : {}), ...(init.actor ? { 'X-Actor': init.actor } : {}) },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  /** A product's brand with one poster waiting, made the way the engine leaves it. */
  const brandWithPoster = (brand: string, productId: string): { versionId: string } => {
    const dir = join(brandsRoot, brand);
    mkdirSync(dir, { recursive: true });
    new ProductBrands(brandsRoot).claim(brand, productId, () => false);
    const picture = join(root, `${brand}.jpg`);
    writeFileSync(picture, `${brand} picture`);
    const added = new ReviewStore(dir, brand).addVersion({
      postId: 'w01-d1', planFile: 'week-01.json', headline: 'Answers from your own docs', caption: 'Caption.', ctaUrl: 'https://acme.example', factIds: ['f1'],
      evidence: [{ factId: 'f1', text: 't', quote: 'q', url: 'https://acme.example/', context: 'c' }], imagePath: picture,
      validation: { accepted: true, readings: 2, defects: [], reportFile: 'r.json' }, attempts: 1, costUsd: 0.016,
    } satisfies NewVersion);
    return { versionId: added.versionId };
  };
  return { root, brandsRoot, call, brandWithPoster, done: async () => { await new Promise((resolve) => server.close(resolve)); rmSync(root, { recursive: true, force: true }); } };
}

const JOB = (brand: string) => ({ kind: 'copy', site: 'https://same-site.example.com', brand, networks: ['instagram'], days: 2 });

test('two customers of one product with the same website are two brands that never meet', async () => {
  const s = await start();
  try {
    const one = await s.call(BB, '/review/jobs', { body: JOB('bb-one'), brand: 'bb-one', actor: 'brandbasket:user-1' });
    const two = await s.call(BB, '/review/jobs', { body: JOB('bb-two'), brand: 'bb-two', actor: 'brandbasket:user-2' });
    assert.equal(one.status, 202);
    assert.equal(two.status, 202);
    const jobOne = ((await one.json()) as { job: { id: string; brand: string; by: string } }).job;
    const jobTwo = ((await two.json()) as { job: { id: string; brand: string } }).job;
    assert.notEqual(jobOne.id, jobTwo.id, 'the same website does not collapse two customers into one job');
    assert.equal(jobOne.brand, 'bb-one');
    assert.equal(jobTwo.brand, 'bb-two');
    assert.equal(jobOne.by, 'brandbasket:user-1', 'the person is recorded from the header, not from anything the browser sent');
    // Each sees only its own jobs, and cannot read the other's by id.
    const listOne = (await (await s.call(BB, '/review/jobs', { brand: 'bb-one', actor: 'brandbasket:user-1' })).json()) as { jobs: Array<{ brand: string }> };
    assert.deepEqual(listOne.jobs.map((j) => j.brand), ['bb-one']);
    assert.equal((await s.call(BB, `/review/jobs/${jobTwo.id}`, { brand: 'bb-one', actor: 'brandbasket:user-1' })).status, 404);
  } finally {
    await s.done();
  }
});

test('a product is let in for one brand only, and learns nothing about any other', async () => {
  const s = await start();
  try {
    const a = s.brandWithPoster('bb-one', 'brandbasket');
    const b = s.brandWithPoster('bb-two', 'brandbasket');
    const mine = { brand: 'bb-one', actor: 'brandbasket:user-1' };
    const list = (await (await s.call(BB, '/review/posts?status=all', mine)).json()) as { posts: Array<{ versionId: string }> };
    assert.deepEqual(list.posts.map((p) => p.versionId), [a.versionId]);
    assert.equal((await s.call(BB, `/review/posts/${b.versionId}`, mine)).status, 404, 'another customer of the same product');
    assert.equal((await s.call(BB, `/review/posts/${b.versionId}/approve`, { ...mine, body: {} })).status, 404);
    assert.equal((await s.call(BB, `/review/posts/${b.versionId}/redraw`, { ...mine, body: {} })).status, 404);
    assert.equal((await s.call(BB, '/review/campaigns', mine)).status, 404, 'staff-only view');
    assert.equal((await s.call(BB, '/review/posts', {})).status, 400, 'no brand named');
    assert.equal((await s.call(BB, '/review/posts', { brand: 'bb-one' })).status, 400, 'no person named');
    // A different product cannot reach it even by naming it.
    assert.equal((await s.call(OTHER, `/review/posts/${a.versionId}`, { brand: 'bb-one', actor: 'other:u' })).status, 404);
    assert.equal(((await (await s.call(OTHER, '/review/posts?status=all', { brand: 'bb-one', actor: 'other:u' })).json()) as { posts: unknown[] }).posts.length, 0);
  } finally {
    await s.done();
  }
});

test('the customer decides: the approval is recorded as them, whatever the request says', async () => {
  const s = await start();
  try {
    const a = s.brandWithPoster('bb-one', 'brandbasket');
    const res = await s.call(BB, `/review/posts/${a.versionId}/approve`, { brand: 'bb-one', actor: 'brandbasket:user-1', body: { by: 'owner' } });
    assert.equal(res.status, 200);
    const detail = (await (await s.call(BB, '/review/posts?status=approved', { brand: 'bb-one', actor: 'brandbasket:user-1' })).json()) as { posts: Array<{ decidedBy: string }> };
    assert.equal(detail.posts[0]?.decidedBy, 'brandbasket:user-1');
  } finally {
    await s.done();
  }
});

test('staff can look at a product brand but cannot change anything on it', async () => {
  const s = await start();
  try {
    const a = s.brandWithPoster('bb-one', 'brandbasket');
    assert.equal((await s.call(STAFF, `/review/posts/${a.versionId}`)).status, 200, 'read only view');
    assert.equal(((await (await s.call(STAFF, '/review/posts?status=all')).json()) as { posts: unknown[] }).posts.length, 1);
    for (const [path, body] of [[`/review/posts/${a.versionId}/approve`, { by: 'steve' }], [`/review/posts/${a.versionId}/reject`, { by: 'steve', reason: 'other' }], [`/review/posts/${a.versionId}/redraw`, { by: 'steve' }], ['/review/topics/bb-one/week-01.json/w01-d1/approve', { by: 'steve' }], ['/review/copy/bb-one/week-01.json/w01-d1/keep', { by: 'steve' }], ['/review/copy/bb-one/week-01.json/close', { by: 'steve' }], ['/review/copy/bb-one/week-01.json/draw', { by: 'steve' }]] as const) {
      const res = await s.call(STAFF, path, { body });
      assert.equal(res.status, 403, path);
      assert.equal(((await res.json()) as { code: string }).code, 'FORBIDDEN');
    }
    assert.equal((await s.call(STAFF, '/review/copy/bb-one/week-01.json/w01-d1/edit', { method: 'PUT', body: { headline: 'x', caption: 'y' } })).status, 403);
    assert.equal((await s.call(STAFF, '/review/brands/bb-one/facts/f1/remove', { body: {} })).status, 403);
    assert.equal(new JobStore(join(s.root, 'jobs')).list().length, 0, 'nothing was queued');
  } finally {
    await s.done();
  }
});

test('a product cannot take a name that is already one of ours, and staff cannot start work on a product brand', async () => {
  const s = await start();
  try {
    mkdirSync(join(s.brandsRoot, 'digibranders'), { recursive: true });
    const taken = await s.call(BB, '/review/jobs', { body: JOB('digibranders'), brand: 'digibranders', actor: 'brandbasket:u' });
    assert.equal(taken.status, 409);
    // A request already queued by staff under that name also blocks it.
    assert.equal((await s.call(STAFF, '/review/jobs', { body: { kind: 'copy', site: 'https://acme.example.com', networks: ['instagram'], days: 1, by: 'steve' } })).status, 202);
    assert.equal((await s.call(BB, '/review/jobs', { body: JOB('acme'), brand: 'acme', actor: 'brandbasket:u' })).status, 409);
    // A product brand's name cannot be claimed by another product, nor by a staff request for the same site name.
    assert.equal((await s.call(BB, '/review/jobs', { body: JOB('bb-one'), brand: 'bb-one', actor: 'brandbasket:u' })).status, 202);
    assert.equal((await s.call(OTHER, '/review/jobs', { body: JOB('bb-one'), brand: 'bb-one', actor: 'other:u' })).status, 409);
    const staffSameName = await s.call(STAFF, '/review/jobs', { body: { kind: 'copy', site: 'https://bb-one.example.com', networks: ['instagram'], days: 1, by: 'steve' } });
    assert.equal(staffSameName.status, 403);
    // The product must name the brand itself, and it must be the one in its header.
    assert.equal((await s.call(BB, '/review/jobs', { body: { ...JOB('bb-one'), brand: 'bb-other' }, brand: 'bb-one', actor: 'brandbasket:u' })).status, 400);
    assert.equal((await s.call(BB, '/review/jobs', { body: { kind: 'copy', site: 'https://x.example.com', networks: ['instagram'], days: 1 }, brand: 'bb-one', actor: 'brandbasket:u' })).status, 400);
  } finally {
    await s.done();
  }
});

test('staff keep working on their own brands exactly as before', async () => {
  const s = await start();
  try {
    mkdirSync(join(s.brandsRoot, 'acme'), { recursive: true });
    const store = new ReviewStore(join(s.brandsRoot, 'acme'), 'acme');
    const picture = join(s.root, 'a.jpg');
    writeFileSync(picture, 'acme picture');
    const v = store.addVersion({ postId: 'w01-d1', planFile: 'week-01.json', headline: 'Answers', caption: 'Caption.', ctaUrl: 'https://acme.example', factIds: ['f1'], evidence: [{ factId: 'f1', text: 't', quote: 'q', url: 'https://acme.example/', context: 'c' }], imagePath: picture, validation: { accepted: true, readings: 2, defects: [], reportFile: 'r.json' }, attempts: 1, costUsd: 0.016 });
    assert.equal((await s.call(STAFF, `/review/posts/${v.versionId}/approve`, { body: { by: 'steve' } })).status, 200);
  } finally {
    await s.done();
  }
});
