import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeConnected } from './connected-networks.ts';
import { CopyStage } from './copy-stage.ts';
import { JobStore } from './job-store.ts';
import { ProductBrands } from './product-brands.ts';
import { readCarouselWeekly, runWeeklyCarousels, WEEKLY_CAROUSEL_BY, writeCarouselWeekly } from './weekly-carousel.ts';
import type { CarouselMade } from './carousel-limit.ts';

// Thursday 2026-11-12 10:00 India time is the moment the week of Monday 2026-11-16 is due; Monday 2026-11-09's Friday is 2026-11-13.
const THU = new Date('2026-11-12T04:30:00Z');

function setup(over: { enabled?: boolean; connected?: string[] | null; batch?: boolean; brandJson?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'weekly-carousel-'));
  const brandsRoot = join(root, 'brands');
  const dir = join(brandsRoot, 'bb-one');
  mkdirSync(dir, { recursive: true });
  if (over.brandJson !== false) writeFileSync(join(dir, 'brand.json'), '{}');
  if (over.connected !== null) writeConnected(dir, over.connected ?? ['instagram', 'linkedin']);
  if (over.batch !== false) new CopyStage(dir, 'bb-one').open('week-01.json', [{ postId: 'a', date: '2026-11-16', headline: 'H', caption: 'C', captions: {} }]);
  if (over.enabled !== false) writeCarouselWeekly(dir, true);
  const owners = new ProductBrands(brandsRoot);
  owners.claim('bb-one', 'brandbasket', () => false);
  const jobs = new JobStore(join(root, 'jobs'));
  let made: CarouselMade[] = [];
  const run = (now: Date, site: string | null = 'https://acme.example') => runWeeklyCarousels({ brandsRoot, jobs, owners, now, made: () => made, siteOf: () => site });
  return { run, jobs, dir, setMade: (m: CarouselMade[]) => { made = m; }, done: () => rmSync(root, { recursive: true, force: true }) };
}

test('it is off until the customer switches it on, and the switch is kept', () => {
  const s = setup({ enabled: false });
  try {
    assert.equal(readCarouselWeekly(s.dir), false);
    assert.deepEqual(s.run(THU), []);
    assert.deepEqual(writeCarouselWeekly(s.dir, true), { changed: true });
    assert.deepEqual(writeCarouselWeekly(s.dir, true), { changed: false });
    assert.equal(readCarouselWeekly(s.dir), true);
    assert.deepEqual(writeCarouselWeekly(s.dir, false), { changed: true });
    assert.equal(readCarouselWeekly(s.dir), false);
  } finally {
    s.done();
  }
});

test('on the Thursday it makes the week\'s carousel for the Friday, by the system, for her connected channels, and asks only once', () => {
  const s = setup();
  try {
    const first = s.run(THU);
    assert.deepEqual(first, [{ brand: 'bb-one', week: '2026-11-09', date: '2026-11-13' }], 'the current week still has its Friday ahead');
    const job = s.jobs.list({ brand: 'bb-one' })[0];
    assert.deepEqual([job?.kind, job?.by, job?.auto, job?.startDate, job?.time, [...(job?.networks ?? [])].sort()], ['carousel', WEEKLY_CAROUSEL_BY, true, '2026-11-13', '10:00', ['instagram', 'linkedin']]);
    assert.deepEqual(s.run(THU), [], 'the same carousel is never asked for twice');
  } finally {
    s.done();
  }
});

test('once that one is done the next week\'s is made, and a week that already has a wanted carousel gets none', () => {
  const s = setup();
  try {
    s.run(THU);
    const job = s.jobs.list({ brand: 'bb-one' })[0];
    assert.ok(job);
    // The first job is finished: the next pass makes the week of 2026-11-16 (its Thursday is now).
    for (const j of s.jobs.list({ brand: 'bb-one' })) s.jobs.update(j.id, { state: 'succeeded' });
    s.setMade([{ id: 'car-x', date: '2026-11-13T10:00:00+05:30', rejected: false }]);
    const next = s.run(new Date('2026-11-12T05:00:00Z'));
    assert.deepEqual(next, [{ brand: 'bb-one', week: '2026-11-16', date: '2026-11-20' }]);
    s.setMade([{ id: 'car-x', date: '2026-11-13T10:00:00+05:30', rejected: false }, { id: 'car-y', date: '2026-11-20T10:00:00+05:30', rejected: false }]);
    for (const j of s.jobs.list({ brand: 'bb-one' })) if (j.state === 'queued' || j.state === 'running') s.jobs.update(j.id, { state: 'succeeded' });
    assert.deepEqual(s.run(new Date('2026-11-12T06:00:00Z')), []);
  } finally {
    s.done();
  }
});

test('nothing is made for a customer who is not set up: no connected channels known, none connected, no batch, no website read, no website saved, or the Friday has passed', () => {
  for (const over of [{ connected: null }, { connected: [] as string[] }, { batch: false }, { brandJson: false }]) {
    const s = setup(over);
    try {
      assert.deepEqual(s.run(THU), [], JSON.stringify(over));
    } finally {
      s.done();
    }
  }
  const s = setup();
  try {
    assert.deepEqual(s.run(THU, null), [], 'no website saved');
    assert.deepEqual(s.run(new Date('2026-11-13T05:00:00Z')), [{ brand: 'bb-one', week: '2026-11-16', date: '2026-11-20' }], 'on the Friday itself the day has passed, so only the next week is made');
  } finally {
    s.done();
  }
});

test('the next week is not made before its own Thursday 10:00 India time', () => {
  const s = setup();
  try {
    assert.deepEqual(s.run(new Date('2026-11-05T04:29:00Z')), [{ brand: 'bb-one', week: '2026-11-02', date: '2026-11-06' }], 'only the current week, whose Friday is still ahead');
    for (const j of s.jobs.list({ brand: 'bb-one' })) s.jobs.update(j.id, { state: 'succeeded' });
    assert.deepEqual(s.run(new Date('2026-11-05T04:29:30Z')), [], 'the week of 2026-11-09 is not due for another half minute');
    assert.deepEqual(s.run(new Date('2026-11-05T04:30:00Z')), [{ brand: 'bb-one', week: '2026-11-09', date: '2026-11-13' }]);
  } finally {
    s.done();
  }
});
