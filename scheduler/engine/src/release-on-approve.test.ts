import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLease, releaseCampaigns, withReleaseLock } from './campaign-runner.ts';
import { CopyStage } from './copy-stage.ts';
import { exportToPublisher, parseScheduleModule } from './export-publisher.ts';
import { ProductBrands } from './product-brands.ts';
import { RELEASE_REQUEST_FILE, requestRelease } from './release-request.ts';
import { createReviewServer } from './review-server.ts';
import { ReviewStore } from './review-store.ts';

process.env['SOCIAL_PUBLISHING_ENABLED'] = 'true';
const BB = 'brandbasket-secret-0123456789';

test('asking for a release writes the marker and never fails a decision when it cannot', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-request-'));
  try {
    requestRelease(root, new Date('2026-11-14T08:00:00Z'));
    assert.equal(readFileSync(join(root, RELEASE_REQUEST_FILE), 'utf8'), '2026-11-14T08:00:00.000Z\n');
    assert.doesNotThrow(() => requestRelease(join(root, 'no', 'such', 'folder')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the release lock is held for the work, taken in turns, and given back even when the work fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-lock-'));
  const path = join(root, '.release.lock');
  try {
    const order: string[] = [];
    const first = withReleaseLock(path, 5_000, async () => { order.push('first starts'); await new Promise((done) => setTimeout(done, 150)); order.push('first ends'); }, 20);
    await new Promise((done) => setTimeout(done, 30));
    const second = withReleaseLock(path, 5_000, async () => { order.push('second'); }, 20);
    assert.deepEqual(await Promise.all([first, second]), [true, true]);
    assert.deepEqual(order, ['first starts', 'first ends', 'second'], 'one at a time, in turn');

    const held = await acquireLease(path);
    assert.ok(held);
    assert.equal(await withReleaseLock(path, 100, async () => { order.push('never'); }, 20), false, 'gives up after the wait while someone else holds it');
    assert.ok(!order.includes('never'));
    await held?.();

    await assert.rejects(withReleaseLock(path, 100, async () => { throw new Error('boom'); }), /boom/);
    assert.ok(!existsSync(path), 'the lock is gone after a failed run');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('approving or taking back a customer\'s poster asks for a release; a repeated approve does not; a read-only pass releases without touching the campaign record', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-on-approve-'));
  const brands = join(root, 'brands');
  const dir = join(brands, 'bb-acme');
  const publisher = join(root, 'publisher');
  mkdirSync(dir, { recursive: true });
  const variants = { instagram: { caption: 'ig caption', hashtags: [] }, linkedin: { caption: 'li caption', hashtags: [] } };
  writeFileSync(join(dir, 'week-01.json'), JSON.stringify({ brand: 'bb-acme', timezone: '+05:30', renderMode: 'ai_v1', posts: [{ id: 'w01-d1', date: '2099-11-10T10:00:00+05:30', painPoint: 'p', mode: 'ai', headline: 'Answers from your own docs', subline: '', caption: 'Hook.', hashtags: ['#a'], imagePrompt: 'a picture', variants }] }));
  writeFileSync(join(dir, 'brand.json'), JSON.stringify({ name: 'Acme', website: 'https://acme.example' }));
  new ProductBrands(brands).claim('bb-acme', 'brandbasket', () => false);
  const stage = new CopyStage(dir, 'bb-acme');
  stage.open('week-01.json', [{ postId: 'w01-d1', headline: 'Answers from your own docs', caption: 'Hook.' }]);
  stage.decide('week-01.json', 'w01-d1', 'kept', 'brandbasket:u1');
  const server = createReviewServer({ brandsRoot: brands, secret: 'staff-secret-0123456789', jobsRoot: join(root, 'jobs'), products: [{ id: 'brandbasket', secret: BB }], expiryDays: 0 });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, body?: unknown): Promise<Response> => fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${BB}`, 'X-Brand': 'bb-acme', 'X-Actor': 'brandbasket:u1', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const marker = join(brands, RELEASE_REQUEST_FILE);
  const scheduled = (): Array<{ brand: string; channels?: string[] }> => parseScheduleModule(readFileSync(join(publisher, 'data', 'schedule.ts'), 'utf8'));
  const deps = { exec: async () => ({ code: 0, tail: '' }), release: async (d: string, o: { brand: string; weekFiles: string[] }) => (await exportToPublisher(d, publisher, Date.now(), o)).length, publishingEnabled: () => true };
  try {
    assert.equal((await call('/review/copy/bb-acme/week-01.json/draw', {})).status, 202);
    const picture = join(root, 'p.jpg');
    writeFileSync(picture, 'a picture');
    const store = new ReviewStore(dir, 'bb-acme');
    for (const network of ['instagram', 'linkedin']) store.addVersion({ postId: 'w01-d1', planFile: 'week-01.json', network, headline: 'Answers from your own docs', caption: `${network} caption`, ctaUrl: 'https://acme.example', factIds: [], evidence: [], imagePath: picture, validation: { accepted: true, readings: 2, defects: [], reportFile: 'r.json' }, attempts: 1, costUsd: 0.02 });
    assert.ok(!existsSync(marker), 'drawing alone asks for nothing');

    assert.equal((await call('/review/topics/bb-acme/week-01.json/w01-d1/approve', {})).status, 200);
    assert.ok(existsSync(marker), 'approving asks for a release');
    unlinkSync(marker);
    const again = await call('/review/topics/bb-acme/week-01.json/w01-d1/approve', {});
    assert.equal(again.status, 200);
    assert.ok(!existsSync(marker), 'a repeated approve decides nothing, so it asks for nothing');

    // The pass the marker starts: it hands the approved posters over, and leaves the campaign record exactly as the batch's own run wrote it.
    const record = join(dir, 'campaigns', 'manual-week-01.json');
    const before = readFileSync(record, 'utf8');
    await releaseCampaigns(brands, { ...deps, readOnlyState: true });
    assert.deepEqual(scheduled().map((p) => [p.brand, [...(p.channels ?? [])].sort()]), [['bb-acme', ['instagram', 'linkedin']]], 'in the calendar at once');
    assert.equal(readFileSync(record, 'utf8'), before, 'the record was not written');
    await releaseCampaigns(brands, deps);
    assert.notEqual(readFileSync(record, 'utf8'), before, 'the timer\'s pass still records what it released');

    // Taking a poster back asks again.
    const approved = (await (await call('/review/posts?status=approved')).json()) as { posts: Array<{ versionId: string; network: string }> };
    const id = approved.posts.find((p) => p.network === 'linkedin')?.versionId ?? '';
    assert.equal((await call(`/review/posts/${id}/reject`, { reason: 'other' })).status, 200);
    assert.ok(existsSync(marker), 'rejecting asks for a release');
    await releaseCampaigns(brands, { ...deps, readOnlyState: true });
    assert.deepEqual(scheduled().map((p) => [...(p.channels ?? [])]), [['instagram']]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
