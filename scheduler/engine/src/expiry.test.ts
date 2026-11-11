import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CopyStage } from './copy-stage.ts';
import { EXPIRY_BY, readExpiry, sweepExpired } from './expiry.ts';
import { ProductBrands } from './product-brands.ts';
import { createReviewServer } from './review-server.ts';
import { ReviewStore, type NewVersion } from './review-store.ts';

const DAY = 86_400_000;

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'expiry-'));
  const brandsRoot = join(root, 'brands');
  const owners = new ProductBrands(brandsRoot);
  const picture = join(root, 'p.jpg');
  writeFileSync(picture, 'picture');
  const brand = (name: string, productOwned: boolean) => {
    const dir = join(brandsRoot, name);
    mkdirSync(dir, { recursive: true });
    if (productOwned) owners.claim(name, 'brandbasket', () => false);
    const version = (over: Partial<NewVersion> = {}) => new ReviewStore(dir, name).addVersion({
      postId: 'w01-d1', planFile: 'week-01.json', headline: 'Answers', caption: 'Caption.', ctaUrl: 'https://acme.example', factIds: ['f1'],
      evidence: [{ factId: 'f1', text: 't', quote: 'q', url: 'https://acme.example/', context: 'c' }], imagePath: picture,
      validation: { accepted: true, readings: 2, defects: [], reportFile: 'r.json' }, attempts: 1, costUsd: 0.016, ...over,
    });
    return { dir, store: new ReviewStore(dir, name), stage: new CopyStage(dir, name), version };
  };
  return { root, brandsRoot, owners, brand, done: () => rmSync(root, { recursive: true, force: true }) };
}

test('after 14 days an undecided batch is closed and a waiting picture is rejected as expired, for product-owned brands only', () => {
  const s = setup();
  try {
    const mine = s.brand('bb-one', true);
    const ours = s.brand('digibranders', false);
    mine.stage.open('week-01.json', [{ postId: 'w01-d1', headline: 'H', caption: 'C' }]);
    ours.stage.open('week-01.json', [{ postId: 'w01-d1', headline: 'H', caption: 'C' }]);
    const waiting = mine.version();
    const ourWaiting = ours.version();
    const approved = mine.version({ postId: 'w01-d2' });
    mine.store.approve(approved.versionId, 'brandbasket:u1');

    const soon = new Date(Date.now() + 13 * DAY);
    assert.deepEqual(sweepExpired({ brandsRoot: s.brandsRoot, owners: s.owners, now: soon }), [], 'not yet');

    const later = new Date(Date.now() + 15 * DAY);
    const events = sweepExpired({ brandsRoot: s.brandsRoot, owners: s.owners, now: later });
    assert.deepEqual(events.map((e) => [e.brand, e.kind, e.planFile, e.postId]).sort(), [['bb-one', 'batch', 'week-01.json', undefined], ['bb-one', 'poster', 'week-01.json', 'w01-d1']].sort());
    assert.equal(mine.stage.get('week-01.json').closedBy, EXPIRY_BY);
    const expired = mine.store.get(waiting.versionId);
    assert.equal(expired.status, 'rejected');
    assert.equal(expired.decision?.reason, 'expired');
    assert.equal(expired.decision?.by, EXPIRY_BY);
    assert.equal(mine.store.get(approved.versionId).status, 'approved', 'a decided poster is left alone');
    assert.equal(ours.store.get(ourWaiting.versionId).status, 'pending', 'our own brands are never touched');
    assert.equal(ours.stage.get('week-01.json').closedAt, undefined);

    assert.deepEqual(sweepExpired({ brandsRoot: s.brandsRoot, owners: s.owners, now: later }), [], 'a second pass changes nothing');
    assert.equal(readExpiry(s.brandsRoot, { brand: 'bb-one' }).length, 2);
    assert.equal(readExpiry(s.brandsRoot, { brand: 'bb-two' }).length, 0);
  } finally {
    s.done();
  }
});

test('a drawn batch is not closed, and a poster newer than the limit stays', () => {
  const s = setup();
  try {
    const mine = s.brand('bb-one', true);
    mine.stage.open('week-01.json', [{ postId: 'w01-d1', headline: 'H', caption: 'C' }]);
    mine.stage.decide('week-01.json', 'w01-d1', 'kept', 'u');
    mine.stage.markDrawn('week-01.json');
    mine.version();
    const events = sweepExpired({ brandsRoot: s.brandsRoot, owners: s.owners, now: new Date(Date.now() + 15 * DAY) });
    assert.deepEqual(events.map((e) => e.kind), ['poster'], 'the picture expires, the already-drawn batch has nothing left to close');
    const fresh = mine.version({ postId: 'w01-d3' });
    assert.equal(mine.store.get(fresh.versionId).status, 'pending');
    assert.deepEqual(sweepExpired({ brandsRoot: s.brandsRoot, owners: s.owners, now: new Date(Date.now() + DAY) }), [], 'a day later nothing else is due');
  } finally {
    s.done();
  }
});

test('a product reads what expired for its own brand only, and nobody can reject with the reason "expired" by hand', async () => {
  const s = setup();
  const BB = 'brandbasket-secret-0123456789';
  const server = createReviewServer({ brandsRoot: s.brandsRoot, secret: 'staff-secret-0123456789', jobsRoot: join(s.root, 'jobs'), products: [{ id: 'brandbasket', secret: BB }], expiryDays: 0 });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, brand: string, body?: unknown): Promise<Response> => fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${BB}`, 'X-Brand': brand, 'X-Actor': 'brandbasket:u1', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  try {
    const one = s.brand('bb-one', true);
    const two = s.brand('bb-two', true);
    const v = one.version();
    two.version();
    sweepExpired({ brandsRoot: s.brandsRoot, owners: s.owners, now: new Date(Date.now() + 15 * DAY) });
    const mine = (await (await call('/review/expiry', 'bb-one')).json()) as { expired: Array<{ brand: string; kind: string }> };
    assert.deepEqual(mine.expired.map((e) => [e.brand, e.kind]), [['bb-one', 'poster']]);
    const since = (await (await call(`/review/expiry?since=${encodeURIComponent(new Date(Date.now() + 16 * DAY).toISOString())}`, 'bb-one')).json()) as { expired: unknown[] };
    assert.equal(since.expired.length, 0);
    const fresh = one.version({ postId: 'w01-d9' });
    assert.equal((await call(`/review/posts/${fresh.versionId}/reject`, 'bb-one', { reason: 'expired' })).status, 400);
    assert.equal((await call(`/review/posts/${v.versionId}`, 'bb-one')).status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    s.done();
  }
});
