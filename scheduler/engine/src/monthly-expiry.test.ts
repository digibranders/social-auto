import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeConnected } from './connected-networks.ts';
import { CopyStage } from './copy-stage.ts';
import { dayEndMs, readExpiry, recordExpiry, sweepExpired } from './expiry.ts';
import { JobStore } from './job-store.ts';
import { ProductBrands } from './product-brands.ts';
import { ReviewStore } from './review-store.ts';
import { runWeeklyDraws } from './weekly-draw.ts';

const DAY = 86_400_000;

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'monthly-expiry-'));
  const brandsRoot = join(root, 'brands');
  const dir = join(brandsRoot, 'bb-one');
  mkdirSync(dir, { recursive: true });
  writeConnected(dir, ['instagram', 'facebook', 'linkedin']);
  const owners = new ProductBrands(brandsRoot);
  owners.claim('bb-one', 'brandbasket', () => false);
  const picture = join(root, 'p.jpg');
  writeFileSync(picture, 'picture');
  const store = new ReviewStore(dir, 'bb-one');
  const version = (postId: string) => store.addVersion({
    postId, planFile: 'week-01.json', headline: 'Answers', caption: 'Caption.', ctaUrl: 'https://acme.example', factIds: ['f1'],
    evidence: [{ factId: 'f1', text: 't', quote: 'q', url: 'https://acme.example/', context: 'c' }], imagePath: picture,
    validation: { accepted: true, readings: 2, defects: [], reportFile: 'r.json' }, attempts: 1, costUsd: 0.016,
  });
  return { root, brandsRoot, dir, owners, store, version, stage: new CopyStage(dir, 'bb-one'), done: () => rmSync(root, { recursive: true, force: true }) };
}

test('a batch written for several weeks is not closed by age, but a batch with no days still is', () => {
  const s = setup();
  try {
    s.stage.open('week-01.json', [{ postId: 'a', date: '2026-11-16', headline: 'H', caption: 'C' }, { postId: 'b', date: '2026-11-23', headline: 'H', caption: 'C' }]);
    s.stage.open('week-02.json', [{ postId: 'a', headline: 'H', caption: 'C' }]);
    const events = sweepExpired({ brandsRoot: s.brandsRoot, owners: s.owners, now: new Date(Date.now() + 30 * DAY) });
    assert.deepEqual(events.filter((e) => e.kind === 'batch').map((e) => e.planFile), ['week-02.json']);
    assert.equal(s.stage.get('week-01.json').closedAt, undefined, 'its weeks are given up one by one, not all at once by age');
  } finally {
    s.done();
  }
});

test('a waiting picture expires at the end of its post day (India time) even when it is young, and not before; one with no day keeps the 14 days', () => {
  const s = setup();
  try {
    s.stage.open('week-01.json', [{ postId: 'a', date: '2026-11-16', headline: 'H', caption: 'C' }, { postId: 'z', headline: 'H', caption: 'C' }]);
    const dated = s.version('a');
    const undated = s.version('z');
    assert.equal(new Date(dayEndMs('2026-11-16')).toISOString(), '2026-11-16T18:30:00.000Z');
    const before = sweepExpired({ brandsRoot: s.brandsRoot, owners: s.owners, now: new Date('2026-11-16T18:29:00Z') });
    assert.deepEqual(before.filter((e) => e.kind === 'poster'), [], 'still the 16th in India');
    const after = sweepExpired({ brandsRoot: s.brandsRoot, owners: s.owners, now: new Date('2026-11-16T18:31:00Z') });
    assert.deepEqual(after.filter((e) => e.kind === 'poster').map((e) => e.postId), ['a']);
    assert.equal(s.store.get(dated.versionId).decision?.reason, 'expired');
    assert.equal(s.store.get(undated.versionId).status, 'pending', 'no day: it waits the 14 days');
  } finally {
    s.done();
  }
});

test('a week given up by the weekly draw is written to the expiry log so the product can tell the customer', () => {
  const s = setup();
  try {
    s.stage.open('week-01.json', [{ postId: 'a', date: '2026-11-16', headline: 'H', caption: 'C' }, { postId: 'b', date: '2026-11-23', headline: 'H', caption: 'C' }]);
    const jobs = new JobStore(join(s.root, 'jobs'));
    const now = new Date('2026-11-23T05:00:00Z');
    const actions = runWeeklyDraws({
      brandsRoot: s.brandsRoot, jobs, owners: s.owners, now, made: () => new Set(), room: () => null, siteOf: () => 'https://a.example', register: () => undefined,
      onLapse: (brand, planFile, week) => { recordExpiry(s.brandsRoot, now, { brand, kind: 'week', planFile, week }); },
    });
    assert.deepEqual(actions.map((a) => [a.week, a.action]), [['2026-11-16', 'lapsed']]);
    assert.deepEqual(readExpiry(s.brandsRoot, { brand: 'bb-one' }).map((e) => [e.kind, e.planFile, e.week]), [['week', 'week-01.json', '2026-11-16']]);
  } finally {
    s.done();
  }
});
