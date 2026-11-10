import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerManualRelease } from './manual-release.ts';
import { listCampaigns, releaseCampaigns } from './campaign-runner.ts';
import { exportToPublisher } from './export-publisher.ts';
import { ReviewStore } from './review-store.ts';

process.env['SOCIAL_PUBLISHING_ENABLED'] = 'true';

function batch(): { root: string; brands: string; brandDir: string; publisher: string; store: ReviewStore; done: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'manual-release-'));
  const brands = join(root, 'brands');
  const brandDir = join(brands, 'acme');
  mkdirSync(brandDir, { recursive: true });
  const post = (id: string, date: string, variants?: object) => ({ id, date, painPoint: 'p', mode: 'ai', headline: 'Answers from your own docs', subline: '', caption: 'Hook.\n\nFacts.', hashtags: ['#a'], imagePrompt: 'a picture', ...(variants ? { variants } : {}) });
  const variants = { instagram: { caption: 'ig caption', hashtags: [] }, linkedin: { caption: 'li caption', hashtags: [] } };
  writeFileSync(join(brandDir, 'week-03.json'), JSON.stringify({ brand: 'acme', timezone: '+05:30', renderMode: 'ai_v1', posts: [post('w03-d1', '2099-11-10T10:00:00+05:30', variants), post('w03-d2', '2099-11-13T10:00:00+05:30', variants)] }));
  const picture = join(root, 'p.jpg');
  writeFileSync(picture, 'a picture');
  const store = new ReviewStore(brandDir, 'acme');
  for (const postId of ['w03-d1', 'w03-d2']) for (const network of ['instagram', 'linkedin']) {
    store.addVersion({ postId, planFile: 'week-03.json', network, headline: 'Answers from your own docs', caption: `${network} caption of ${postId}`, ctaUrl: 'https://acme.example.com', factIds: [], evidence: [], imagePath: picture, validation: { accepted: true, readings: 2, defects: [], reportFile: 'r.json' }, attempts: 1, costUsd: 0.02 });
  }
  return { root, brands, brandDir, publisher: join(root, 'publisher'), store, done: () => rmSync(root, { recursive: true, force: true }) };
}

const deps = (publisher: string, enabled = true) => ({ exec: async () => ({ code: 0, tail: '' }), release: async (dir: string, options: { brand: string; weekFiles: string[] }) => (await exportToPublisher(dir, publisher, Date.now(), options)).length, publishingEnabled: () => enabled });

test('a batch written and drawn through the owner\'s review is recorded for the calendar with its client and the networks it was written for', () => {
  const b = batch();
  try {
    const made = registerManualRelease({ brandDir: b.brandDir, siteBrand: 'acme', client: 'acme-client', site: 'https://acme.example.com', planFile: 'week-03.json', now: new Date('2099-11-01T00:00:00Z') });
    assert.deepEqual(made.platforms, ['instagram', 'linkedin']);
    assert.equal(made.created, true);
    const record = JSON.parse(readFileSync(made.file, 'utf8')) as { brand: string; plan: { startDate: string; durationDays: number; time: string; utcOffset: string }; batches: Array<{ weekFile: string; status: string }> };
    assert.deepEqual([record.brand, record.plan.startDate, record.plan.durationDays, record.plan.time, record.plan.utcOffset], ['acme-client', '2099-11-10', 4, '10:00', '+05:30']);
    assert.deepEqual(record.batches.map((x) => [x.weekFile, x.status]), [['week-03.json', 'done']]);
    assert.equal(registerManualRelease({ brandDir: b.brandDir, siteBrand: 'acme', client: 'someone-else', site: 'https://acme.example.com', planFile: 'week-03.json' }).created, false, 'the record is made once and never rewritten');
    assert.throws(() => registerManualRelease({ brandDir: b.brandDir, siteBrand: 'acme', client: '../x', site: 's', planFile: 'week-03.json' }), /client name/);
    assert.throws(() => registerManualRelease({ brandDir: b.brandDir, siteBrand: 'acme', client: 'acme-client', site: 's', planFile: '../week-03.json' }), /plan file/);
  } finally {
    b.done();
  }
});

test('nothing is released until the owner approves, then exactly the approved network versions go, under the client\'s name', async () => {
  const b = batch();
  try {
    registerManualRelease({ brandDir: b.brandDir, siteBrand: 'acme', client: 'acme-client', site: 'https://acme.example.com', planFile: 'week-03.json' });
    await releaseCampaigns(b.brands, deps(b.publisher));
    const schedule = join(b.publisher, 'data', 'schedule.ts');
    assert.equal(readFileSync(schedule, 'utf8').includes('"posts": []'), true, 'nothing approved, nothing released');
    const first = b.store.list().filter((i) => i.version.postId === 'w03-d1');
    b.store.approve(first.find((i) => i.version.network === 'instagram')!.version.versionId, 'owner');
    b.store.approve(first.find((i) => i.version.network === 'linkedin')!.version.versionId, 'owner');
    const second = b.store.list().find((i) => i.version.postId === 'w03-d2' && i.version.network === 'linkedin')!;
    b.store.approve(second.version.versionId, 'owner');
    await releaseCampaigns(b.brands, deps(b.publisher));
    const posts = JSON.parse(readFileSync(schedule, 'utf8').replace(/^[^{]*/, '').replace(/;\n$/, '')) as { posts: Array<{ brand: string; id: string; channels: string[]; caption: string; fromPlan: boolean; variants?: Record<string, { caption?: string }> }> };
    assert.deepEqual(posts.posts.map((p) => [p.brand, p.id, p.channels, p.caption]), [['acme-client', 'acme-client-w03-d1', ['instagram', 'linkedin'], 'instagram caption of w03-d1'], ['acme-client', 'acme-client-w03-d2', ['linkedin'], 'linkedin caption of w03-d2']]);
    assert.equal(posts.posts[0]?.variants?.['linkedin']?.caption, 'linkedin caption of w03-d1');
    assert.equal(posts.posts.every((p) => p.fromPlan), true, 'it never goes to the shared account');
    const [summary] = await listCampaigns(b.brands);
    assert.deepEqual(summary?.review, { approved: 3, pending: 1, rejected: 0 });
  } finally {
    b.done();
  }
});

test('while publishing is switched off nothing is released, and the record says why', async () => {
  const b = batch();
  try {
    registerManualRelease({ brandDir: b.brandDir, siteBrand: 'acme', client: 'acme-client', site: 'https://acme.example.com', planFile: 'week-03.json' });
    const v = b.store.list()[0]!;
    b.store.approve(v.version.versionId, 'owner');
    assert.deepEqual(await releaseCampaigns(b.brands, deps(b.publisher, false)), []);
    assert.equal((await listCampaigns(b.brands))[0]?.release?.state, 'off');
  } finally {
    b.done();
  }
});
