import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AUTO_POST_BY, AutoPostingError, isAutomatic, readAutoPosting, runAutoPosting, writeAutoPosting } from './auto-posting.ts';
import { writeConnected } from './connected-networks.ts';
import { CopyStage } from './copy-stage.ts';
import { JobStore } from './job-store.ts';
import { ProductBrands } from './product-brands.ts';
import { createReviewServer } from './review-server.ts';
import { ReviewStore } from './review-store.ts';
import { runWeeklyDraws, type WeeklyDeps } from './weekly-draw.ts';

const caps = (network: string, id: string): { text: string } => ({ text: `${network} ${id}` });
const post = (id: string, date: string, extra: { advice?: string } = {}) => ({ postId: id, date, headline: `H ${id}`, caption: 'C', captions: { instagram: caps('instagram', id), linkedin: caps('linkedin', id) }, ...extra });
// Friday 20 November 2026, 12:00 India time.
const NOW = '2026-11-20T06:30:00Z';

function setup(channels: string[] = ['instagram']) {
  const root = mkdtempSync(join(tmpdir(), 'auto-posting-'));
  const brandsRoot = join(root, 'brands');
  const dir = join(brandsRoot, 'bb-acme');
  mkdirSync(dir, { recursive: true });
  const owners = new ProductBrands(brandsRoot);
  owners.claim('bb-acme', 'brandbasket', () => false);
  writeConnected(dir, ['instagram', 'linkedin']);
  // d1: tomorrow 10:00 (22 hours ahead), d2: Tuesday (4 days ahead), d3: yesterday, d4: tomorrow but the checks left a warning on the words.
  const times: Record<string, string> = { 'w1-d1': '2026-11-21T10:00:00+05:30', 'w1-d2': '2026-11-24T10:00:00+05:30', 'w1-d3': '2026-11-19T10:00:00+05:30', 'w1-d4': '2026-11-22T10:00:00+05:30' };
  writeFileSync(join(dir, 'week-01.json'), JSON.stringify({ posts: Object.entries(times).map(([id, date]) => ({ id, date })) }));
  const stage = new CopyStage(dir, 'bb-acme');
  stage.open('week-01.json', [post('w1-d1', '2026-11-21'), post('w1-d2', '2026-11-24'), post('w1-d3', '2026-11-19'), post('w1-d4', '2026-11-22', { advice: 'weak headline' })]);
  const picture = join(root, 'p.jpg');
  writeFileSync(picture, 'a picture');
  const store = new ReviewStore(dir, 'bb-acme', () => new Date(NOW));
  const add = (postId: string, network: string, accepted = true): string => store.addVersion({ postId, planFile: 'week-01.json', network, headline: `H ${postId}`, caption: `${network} caption`, ctaUrl: 'https://acme.example', factIds: [], evidence: [], imagePath: picture, validation: { accepted, readings: 2, defects: [], reportFile: 'r.json' }, attempts: 1, costUsd: 0.02 }).versionId;
  if (channels.length > 0) writeAutoPosting(dir, { channels, safetyHours: 24, by: 'brandbasket:u1' }, new Date(NOW));
  const told: Array<[string, number]> = [];
  const run = (now: string) => runAutoPosting({ brandsRoot, owners, now: new Date(now), approved: (b, n) => told.push([b, n]) });
  const statusOf = (id: string): string => store.get(id).status;
  return { root, dir, brandsRoot, owners, stage, store, add, run, told, statusOf, done: () => rmSync(root, { recursive: true, force: true }) };
}

test('the setting is a list of channels with who agreed and when: a channel added is recorded again, one that stays keeps its first consent, empty is off, and bad values are refused', () => {
  const root = mkdtempSync(join(tmpdir(), 'auto-setting-'));
  try {
    assert.equal(readAutoPosting(root), null);
    assert.equal(isAutomatic(null), false);
    const first = writeAutoPosting(root, { channels: ['linkedin', 'instagram', 'instagram'], by: 'brandbasket:u1' }, new Date('2026-11-20T00:00:00Z'));
    assert.deepEqual([first.channels, first.safetyHours, first.consent], [['instagram', 'linkedin'], 24, { by: 'brandbasket:u1', at: '2026-11-20T00:00:00.000Z' }]);
    assert.deepEqual(readAutoPosting(root), first);
    const same = writeAutoPosting(root, { channels: ['instagram'], safetyHours: 12, by: 'brandbasket:u2' }, new Date('2026-11-21T00:00:00Z'));
    assert.deepEqual([same.channels, same.safetyHours, same.consent.by], [['instagram'], 12, 'brandbasket:u1'], 'taking a channel off keeps the first consent');
    const wider = writeAutoPosting(root, { channels: ['instagram', 'facebook'], safetyHours: 12, by: 'brandbasket:u2' }, new Date('2026-11-22T00:00:00Z'));
    assert.deepEqual(wider.consent, { by: 'brandbasket:u2', at: '2026-11-22T00:00:00.000Z' }, 'a channel added is a new consent');
    const off = writeAutoPosting(root, { channels: [], by: 'brandbasket:u2' }, new Date('2026-11-23T00:00:00Z'));
    assert.equal(isAutomatic(off), false);
    for (const bad of [{ channels: ['tiktok'], by: 'u' }, { channels: ['instagram'], by: '  ' }, { channels: ['instagram'], safetyHours: -1, by: 'u' }, { channels: ['instagram'], safetyHours: 73, by: 'u' }, { channels: ['instagram'], safetyHours: 1.5, by: 'u' }]) {
      assert.throws(() => writeAutoPosting(root, bad as never), AutoPostingError, JSON.stringify(bad));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('automatic posting keeps the topics that carry no warning and approves only checked pictures of the chosen channels once their time is inside the safety window', () => {
  const s = setup(['instagram']);
  try {
    const ig = { d1: s.add('w1-d1', 'instagram'), d2: s.add('w1-d2', 'instagram'), d3: s.add('w1-d3', 'instagram'), d4: s.add('w1-d4', 'instagram') };
    const li1 = s.add('w1-d1', 'linkedin');
    const blocked = s.add('w1-d2', 'linkedin', false);
    const first = s.run(NOW);
    assert.deepEqual(first, [{ brand: 'bb-acme', kept: 2, approved: 1 }]);
    assert.deepEqual(s.stage.get('week-01.json').posts.map((p) => [p.postId, p.state]), [['w1-d1', 'kept'], ['w1-d2', 'kept'], ['w1-d3', 'pending'], ['w1-d4', 'pending']], 'a past day and a topic with a warning are left to her');
    assert.equal(s.stage.get('week-01.json').posts[0]?.decidedBy, AUTO_POST_BY);
    assert.equal(s.statusOf(ig.d1), 'approved', 'inside the 24 hour window');
    assert.equal(s.store.get(ig.d1).decision?.by, AUTO_POST_BY, 'recorded as the system, not as a person');
    assert.equal(s.statusOf(ig.d2), 'pending', 'four days ahead: still hers to look at');
    assert.equal(s.statusOf(ig.d3), 'pending', 'its time has passed');
    assert.equal(s.statusOf(ig.d4), 'pending', 'two days ahead, outside the window');
    assert.equal(s.statusOf(li1), 'pending', 'LinkedIn was not chosen');
    assert.equal(s.statusOf(blocked), 'blocked', 'a picture the checks blocked is never approved');
    assert.deepEqual(s.told, [['bb-acme', 1]]);

    assert.deepEqual(s.run(NOW), [], 'asking again changes nothing');
    const later = s.run('2026-11-23T06:30:00Z');
    assert.deepEqual(later, [{ brand: 'bb-acme', kept: 0, approved: 1 }], 'Tuesday 10:00 is inside the window on Monday 12:00');
    assert.equal(s.statusOf(ig.d2), 'approved');
  } finally {
    s.done();
  }
});

test('a customer\'s own topic request is never kept or approved by the system, even when its picture passed the checks', () => {
  const s = setup(['instagram']);
  try {
    const picture = s.add('w1-d1', 'instagram');
    const runner = (now: string) => runAutoPosting({ brandsRoot: s.brandsRoot, owners: s.owners, now: new Date(now), isTopicPlan: (_brand, planFile) => planFile === 'week-01.json' });
    assert.deepEqual(runner(NOW), []);
    assert.equal(s.stage.get('week-01.json').posts[0]?.state, 'pending', 'her words wait for her');
    assert.equal(s.statusOf(picture), 'pending');
  } finally {
    s.done();
  }
});

test('a window of 0 approves at once, a brand without the setting or with it off is never touched, and a network that is not connected is left alone', () => {
  const s = setup(['instagram']);
  try {
    const far = s.add('w1-d2', 'instagram');
    assert.deepEqual(s.run(NOW).map((a) => a.approved), [0]);
    writeAutoPosting(s.dir, { channels: ['instagram'], safetyHours: 0, by: 'brandbasket:u1' }, new Date(NOW));
    assert.deepEqual(s.run(NOW).map((a) => a.approved), [1]);
    assert.equal(s.statusOf(far), 'approved', 'no window: approved as soon as it passed the checks');
    writeConnected(s.dir, ['linkedin']);
    const later = s.add('w1-d1', 'instagram');
    assert.deepEqual(s.run(NOW), [], 'Instagram is no longer connected');
    assert.equal(s.statusOf(later), 'pending');
    writeAutoPosting(s.dir, { channels: [], by: 'brandbasket:u1' }, new Date(NOW));
    writeConnected(s.dir, ['instagram', 'linkedin']);
    assert.deepEqual(s.run(NOW), [], 'switched off');
    assert.equal(s.statusOf(later), 'pending');
  } finally {
    s.done();
  }
  const none = setup([]);
  try {
    none.add('w1-d1', 'instagram');
    assert.deepEqual(none.run(NOW), [], 'a customer who never chose it');
    assert.equal(none.stage.get('week-01.json').posts[0]?.state, 'pending');
  } finally {
    none.done();
  }
});

test('the weekly draw draws the first week at once only for a customer who chose automatic posting', () => {
  const s = setup(['instagram']);
  try {
    s.run(NOW);
    const jobs = new JobStore(join(s.root, 'jobs'));
    const deps = (automatic: boolean): WeeklyDeps => ({ brandsRoot: s.brandsRoot, jobs, owners: s.owners, now: new Date('2026-11-17T06:30:00Z'), made: () => new Set(), room: () => null, siteOf: () => 'https://acme.example', register: () => undefined, automatic: () => automatic });
    assert.deepEqual(runWeeklyDraws(deps(false)), [], 'she asks for the first week herself (the second week is not due until Thursday)');
    const drawn = runWeeklyDraws(deps(true));
    assert.deepEqual(drawn.map((a) => [a.week, a.action]), [['2026-11-16', 'drawing']]);
    assert.equal(jobs.list({ brand: 'bb-acme' }).filter((j) => j.kind === 'draw').length, 1);
    assert.deepEqual(runWeeklyDraws(deps(true)), [], 'only once');
  } finally {
    s.done();
  }
});

test('a product sets and reads automatic posting for its own brand only, the staff cannot, and bad values are refused', async () => {
  const root = mkdtempSync(join(tmpdir(), 'auto-route-'));
  const brands = join(root, 'brands');
  mkdirSync(join(brands, 'bb-acme'), { recursive: true });
  new ProductBrands(brands).claim('bb-acme', 'brandbasket', () => false);
  const BB = 'brandbasket-secret-0123456789';
  const server = createReviewServer({ brandsRoot: brands, secret: 'staff-secret-0123456789', jobsRoot: join(root, 'jobs'), products: [{ id: 'brandbasket', secret: BB }], expiryDays: 0 });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (method: string, body?: unknown, token = BB): Promise<Response> => fetch(`${base}/review/auto-posting`, { method, headers: { Authorization: `Bearer ${token}`, 'X-Brand': 'bb-acme', 'X-Actor': 'brandbasket:u1', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  try {
    assert.deepEqual(await (await call('GET')).json(), { autoPosting: null });
    const saved = await call('PUT', { channels: ['instagram', 'linkedin'], safetyHours: 12 });
    assert.equal(saved.status, 200);
    const body = (await saved.json()) as { autoPosting: { channels: string[]; safetyHours: number; consent: { by: string } } };
    assert.deepEqual([body.autoPosting.channels, body.autoPosting.safetyHours, body.autoPosting.consent.by], [['instagram', 'linkedin'], 12, 'brandbasket:u1']);
    assert.equal(JSON.parse(readFileSync(join(brands, 'bb-acme', 'auto-posting.json'), 'utf8')).channels.length, 2);
    for (const bad of [{ channels: 'instagram' }, { channels: ['tiktok'] }, { channels: ['instagram'], safetyHours: 100 }, {}]) assert.equal((await call('PUT', bad)).status, 400, JSON.stringify(bad));
    assert.equal((await call('PUT', { channels: [] })).status, 200, 'switched off');
    assert.equal((await call('GET', undefined, 'staff-secret-0123456789')).status, 404, 'not a staff route');
    assert.equal((await call('DELETE')).status, 405);
    // Before her first batch the brand does not exist yet: it is claimed for the product, and another product cannot take it.
    const fresh = await fetch(`${base}/review/auto-posting`, { method: 'PUT', headers: { Authorization: `Bearer ${BB}`, 'X-Brand': 'bb-new', 'X-Actor': 'brandbasket:u1', 'Content-Type': 'application/json' }, body: JSON.stringify({ channels: ['instagram'] }) });
    assert.equal(fresh.status, 200, 'a brand with no batch yet');
    assert.equal(new ProductBrands(brands).get('bb-new')?.productId, 'brandbasket');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
