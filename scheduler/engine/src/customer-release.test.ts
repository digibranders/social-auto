import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releaseCampaigns } from './campaign-runner.ts';
import { CopyStage } from './copy-stage.ts';
import { exportToPublisher, parseScheduleModule } from './export-publisher.ts';
import { ProductBrands } from './product-brands.ts';
import { createReviewServer } from './review-server.ts';
import { ReviewStore } from './review-store.ts';

process.env['SOCIAL_PUBLISHING_ENABLED'] = 'true';
const BB = 'brandbasket-secret-0123456789';

test('a customer\'s approved pictures are released under their own brand, one per network, and a withdrawn one leaves the schedule at the next pass', async () => {
  const root = mkdtempSync(join(tmpdir(), 'customer-release-'));
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
  const scheduled = (): Array<{ brand: string; channels?: string[] }> => parseScheduleModule(readFileSync(join(publisher, 'data', 'schedule.ts'), 'utf8'));
  const release = (): Promise<unknown> => releaseCampaigns(brands, { exec: async () => ({ code: 0, tail: '' }), release: async (d: string, o: { brand: string; weekFiles: string[] }) => (await exportToPublisher(d, publisher, Date.now(), o)).length, publishingEnabled: () => true });
  try {
    // Drawing is asked for as the customer; "client" in the body is ignored, so the posters can only ever belong to the customer's own brand.
    assert.equal((await call('/review/copy/bb-acme/week-01.json/draw', { client: 'someone-else' })).status, 202);
    const record = JSON.parse(readFileSync(join(dir, 'campaigns', 'manual-week-01.json'), 'utf8')) as { brand: string; plan: { platforms: string[] } };
    assert.deepEqual([record.brand, record.plan.platforms], ['bb-acme', ['instagram', 'linkedin']]);

    // The engine's pictures arrive, one per network.
    const picture = join(root, 'p.jpg');
    writeFileSync(picture, 'a picture');
    const store = new ReviewStore(dir, 'bb-acme');
    for (const network of ['instagram', 'linkedin']) store.addVersion({ postId: 'w01-d1', planFile: 'week-01.json', network, headline: 'Answers from your own docs', caption: `${network} caption`, ctaUrl: 'https://acme.example', factIds: [], evidence: [], imagePath: picture, validation: { accepted: true, readings: 2, defects: [], reportFile: 'r.json' }, attempts: 1, costUsd: 0.02 });

    await release();
    assert.deepEqual(scheduled(), [], 'nothing is released before the customer approves');
    assert.equal((await call('/review/topics/bb-acme/week-01.json/w01-d1/approve', {})).status, 200);
    await release();
    assert.deepEqual(scheduled().map((p) => [p.brand, [...(p.channels ?? [])].sort()]), [['bb-acme', ['instagram', 'linkedin']]]);

    // The customer withdraws the LinkedIn poster before the next pass: it leaves the schedule, Instagram stays.
    const linkedin = (await (await call('/review/posts?status=approved')).json()) as { posts: Array<{ versionId: string; network: string }> };
    const id = linkedin.posts.find((p) => p.network === 'linkedin')?.versionId ?? '';
    assert.equal((await call(`/review/posts/${id}/reject`, { reason: 'other' })).status, 200);
    await release();
    assert.deepEqual(scheduled().map((p) => [...(p.channels ?? [])]), [['instagram']]);
    const rest = linkedin.posts.find((p) => p.network === 'instagram')?.versionId ?? '';
    assert.equal((await call(`/review/posts/${rest}/reject`, { reason: 'other' })).status, 200);
    await release();
    assert.deepEqual(scheduled(), [], 'nothing approved, nothing scheduled');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test('new words for an approved picture take that network out of the schedule until approved again, and the other network stays', async () => {
  const root = mkdtempSync(join(tmpdir(), 'customer-words-'));
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
  const scheduled = (): Array<{ caption: string; channels?: string[] }> => parseScheduleModule(readFileSync(join(publisher, 'data', 'schedule.ts'), 'utf8'));
  const release = (): Promise<unknown> => releaseCampaigns(brands, { exec: async () => ({ code: 0, tail: '' }), release: async (d: string, o: { brand: string; weekFiles: string[] }) => (await exportToPublisher(d, publisher, Date.now(), o)).length, publishingEnabled: () => true });
  try {
    assert.equal((await call('/review/copy/bb-acme/week-01.json/draw', {})).status, 202);
    const picture = join(root, 'p.jpg');
    writeFileSync(picture, 'a picture');
    const store = new ReviewStore(dir, 'bb-acme');
    const made = Object.fromEntries(['instagram', 'linkedin'].map((network) => [network, store.addVersion({ postId: 'w01-d1', planFile: 'week-01.json', network, headline: 'Answers from your own docs', caption: `${network} caption`, ctaUrl: 'https://acme.example', factIds: [], evidence: [], imagePath: picture, validation: { accepted: true, readings: 2, defects: [], reportFile: 'r.json' }, attempts: 1, costUsd: 0.02 })]));
    assert.equal((await call('/review/topics/bb-acme/week-01.json/w01-d1/approve', {})).status, 200);
    await release();
    assert.deepEqual(scheduled().map((p) => [...(p.channels ?? [])].sort()), [['instagram', 'linkedin']]);

    const changed = await call(`/review/posts/${made['instagram']?.versionId}/words`, { caption: 'Come and taste our laddoos, made fresh every morning.' });
    assert.equal(changed.status, 200);
    await release();
    assert.deepEqual(scheduled().map((p) => [...(p.channels ?? [])]), [['linkedin']], 'only the network that is still approved goes out');

    const fresh = ((await changed.json()) as { version: { versionId: string } }).version.versionId;
    assert.equal((await call(`/review/posts/${fresh}/approve`, {})).status, 200);
    await release();
    const [post] = scheduled();
    assert.deepEqual([...(post?.channels ?? [])].sort(), ['instagram', 'linkedin']);
    assert.match(post?.caption ?? '', /laddoos, made fresh/, 'the new words are what goes out');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
