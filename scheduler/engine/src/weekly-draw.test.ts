import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CopyStage, weeksOf } from './copy-stage.ts';
import { JobStore } from './job-store.ts';
import { ProductBrands } from './product-brands.ts';
import { readConnected, writeConnected } from './connected-networks.ts';
import { drawDueMs, neededPictures, runWeeklyDraws, weekEndMs, weekStartMs, WEEKLY_DRAW_BY, type WeeklyDeps } from './weekly-draw.ts';

const W1 = '2026-11-16';
const W2 = '2026-11-23';
const W3 = '2026-11-30';
const post = (id: string, date: string, networks: string[] = ['instagram', 'facebook']) => ({ postId: id, date, headline: `H ${id}`, caption: 'C', captions: Object.fromEntries(networks.map((n) => [n, { text: `${n} ${id}` }])) });
const posts = [post('w1-d1', '2026-11-16'), post('w2-d1', '2026-11-23'), post('w2-d2', '2026-11-24'), post('w3-d1', '2026-11-30')];

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'weekly-draw-'));
  const brandsRoot = join(root, 'brands');
  const dir = join(brandsRoot, 'bb-acme');
  mkdirSync(dir, { recursive: true });
  const owners = new ProductBrands(brandsRoot);
  owners.claim('bb-acme', 'brandbasket', () => false);
  const stage = new CopyStage(dir, 'bb-acme');
  stage.open('week-01.json', posts);
  const jobs = new JobStore(join(root, 'jobs'));
  const registered: string[] = [];
  const deps = (now: string, over: Partial<WeeklyDeps> = {}): WeeklyDeps => ({
    brandsRoot, jobs, owners, now: new Date(now), made: () => new Set(), room: () => null, siteOf: () => 'https://acme.example', register: (b, p) => { registered.push(`${b}/${p}`); }, ...over,
  });
  return { root, dir, stage, jobs, registered, deps, done: () => rmSync(root, { recursive: true, force: true }) };
}

test('the system draws a later week on the Thursday before it begins at 10:00 India time, and not before', () => {
  assert.equal(new Date(weekStartMs(W2)).toISOString(), '2026-11-22T18:30:00.000Z');
  assert.equal(new Date(drawDueMs(W2)).toISOString(), '2026-11-19T04:30:00.000Z', 'Thursday 19 November 10:00 India time');
  assert.equal(new Date(weekEndMs(W2)).toISOString(), '2026-11-29T18:30:00.000Z');
  const s = setup();
  try {
    for (const id of ['w1-d1', 'w2-d1', 'w3-d1']) s.stage.decide('week-01.json', id, 'kept', 'u');
    assert.deepEqual(runWeeklyDraws(s.deps('2026-11-19T04:29:00Z')), [], 'a minute before Thursday 10:00');
    const at = runWeeklyDraws(s.deps('2026-11-19T04:31:00Z'));
    assert.deepEqual(at.map((a) => [a.week, a.action]), [[W2, 'drawing']]);
    const [job] = s.jobs.list({ brand: 'bb-acme' });
    assert.deepEqual([job?.kind, job?.week, job?.planFile, job?.by, job?.auto], ['draw', W2, 'week-01.json', WEEKLY_DRAW_BY, true]);
    assert.deepEqual(s.registered, ['bb-acme/week-01.json']);
    // Run again, even much later in the week: the same week is never asked for twice.
    assert.deepEqual(runWeeklyDraws(s.deps('2026-11-19T05:30:00Z')), []);
    assert.equal(s.jobs.list({ brand: 'bb-acme' }).length, 1);
  } finally {
    s.done();
  }
});

test('the first week is the customer\'s to ask for, never drawn by the system; and a week with nothing kept waits instead of being drawn or given up', () => {
  const s = setup();
  try {
    s.stage.decide('week-01.json', 'w1-d1', 'kept', 'u');
    assert.deepEqual(runWeeklyDraws(s.deps('2026-11-13T05:00:00Z')), [], 'week 1 is due before week 2 but is the customer\'s');
    assert.equal(s.jobs.list({ brand: 'bb-acme' }).length, 0);
    assert.deepEqual(runWeeklyDraws(s.deps('2026-11-26T05:00:00Z')).filter((a) => a.week === W2), [], 'nothing kept in week 2 yet: nothing is drawn');
    // She keeps one on Friday 20 November: it is drawn at once, though the due time passed days ago.
    s.stage.decide('week-01.json', 'w2-d2', 'kept', 'u');
    assert.deepEqual(runWeeklyDraws(s.deps('2026-11-20T05:00:00Z')).map((a) => [a.week, a.action]), [[W2, 'drawing']]);
  } finally {
    s.done();
  }
});

test('a week that ended without a draw is given up, and the batch counts as drawn once every week is settled', () => {
  const s = setup();
  try {
    s.stage.markWeekDrawn('week-01.json', W1);
    s.stage.decide('week-01.json', 'w3-d1', 'kept', 'u');
    const afterW2 = runWeeklyDraws(s.deps('2026-11-29T19:00:00Z'));
    assert.deepEqual(afterW2.map((a) => [a.week, a.action]), [[W2, 'lapsed'], [W3, 'drawing']], 'week 2 ended undrawn; week 3 was due and has a kept post');
    const batch = s.stage.get('week-01.json');
    assert.ok(batch.weekLapsed?.[W2]);
    assert.equal(batch.drawnAt, undefined, 'week 3 is still open');
    // Week 3's draw was asked for: even after its week ended it is the draw's to settle, never given up from under it.
    assert.deepEqual(runWeeklyDraws(s.deps('2026-12-06T19:00:00Z')), []);
    s.stage.markWeekDrawn('week-01.json', W3);
    assert.ok(s.stage.get('week-01.json').drawnAt, 'every week is settled');
    assert.deepEqual(runWeeklyDraws(s.deps('2026-12-20T00:00:00Z')), [], 'a settled batch is left alone');
  } finally {
    s.done();
  }
});

test('a week with no room for its pictures is not drawn and says why, then is drawn once there is room; brands that are not a product\'s are never touched', () => {
  const s = setup();
  try {
    for (const id of ['w2-d1', 'w2-d2']) s.stage.decide('week-01.json', id, 'kept', 'u');
    const full = runWeeklyDraws(s.deps('2026-11-19T05:00:00Z', { room: () => 'You have used your 7 Instagram pictures for this week.' }));
    assert.deepEqual(full.map((a) => [a.action, a.reason]), [['no_room', 'You have used your 7 Instagram pictures for this week.']]);
    assert.equal(s.jobs.list({ brand: 'bb-acme' }).length, 0);
    assert.deepEqual(runWeeklyDraws(s.deps('2026-11-19T05:10:00Z')).map((a) => a.action), ['drawing']);
    const staffDir = join(s.root, 'brands', 'staffco');
    mkdirSync(staffDir, { recursive: true });
    new CopyStage(staffDir, 'staffco').open('week-01.json', posts);
    new CopyStage(staffDir, 'staffco').decide('week-01.json', 'w2-d1', 'kept', 'u');
    assert.equal(s.jobs.list({ brand: 'staffco' }).length, 0, 'our own clients have no automatic draw');
  } finally {
    s.done();
  }
});

test('pictures are counted for the networks the customer has connected only, and not for ones that already exist', () => {
  const s = setup();
  try {
    for (const id of ['w2-d1', 'w2-d2']) s.stage.decide('week-01.json', id, 'kept', 'u');
    const batch = s.stage.get('week-01.json');
    assert.deepEqual(neededPictures(batch, W2, new Set(), null), { instagram: 2, facebook: 2 }, 'never recorded: every network the posts were written for');
    assert.deepEqual(neededPictures(batch, W2, new Set(), new Set(['instagram'])), { instagram: 2 });
    assert.deepEqual(neededPictures(batch, W2, new Set(['w2-d1|instagram']), new Set(['instagram', 'facebook'])), { instagram: 1, facebook: 2 });
    assert.deepEqual(neededPictures(batch, W1, new Set(), null), {}, 'nothing kept in week 1');
    assert.deepEqual(weeksOf(batch), [W1, W2, W3]);
  } finally {
    s.done();
  }
});

test('the connected networks are kept beside the brand, only the four networks are accepted, and an unchanged list writes nothing', () => {
  const s = setup();
  try {
    assert.equal(readConnected(s.dir), null);
    assert.deepEqual(writeConnected(s.dir, ['facebook', 'instagram', 'myspace', 'facebook', 7]), { changed: true });
    assert.deepEqual([...(readConnected(s.dir) as Set<string>)].sort(), ['facebook', 'instagram']);
    assert.deepEqual(writeConnected(s.dir, ['instagram', 'facebook']), { changed: false });
    assert.deepEqual(writeConnected(s.dir, []), { changed: true });
    assert.equal((readConnected(s.dir) as Set<string>).size, 0, 'no network connected: nothing is drawn');
  } finally {
    s.done();
  }
});
