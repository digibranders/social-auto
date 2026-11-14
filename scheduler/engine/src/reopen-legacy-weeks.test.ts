import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CopyStage, openPosts, postLocked } from './copy-stage.ts';
import { legacyWeeks, reopenLegacyWeeks } from './reopen-legacy-weeks.ts';

const TODAY = '2026-11-18';
const post = (id: string, date: string) => ({ postId: id, date, headline: `H ${id}`, caption: 'C', captions: { instagram: { text: `ig ${id}` } } });
const W1 = '2026-11-16';
const W2 = '2026-11-23';

/** A batch of two weeks drawn whole under the old rule: a1 kept, a2 and a3 not (a3 dropped), a4 not kept and its day already passed; b1 kept, b2 not. */
function setup(mark: 'weeks' | 'batch' | 'lapsed') {
  const root = mkdtempSync(join(tmpdir(), 'reopen-'));
  const brandsRoot = join(root, 'brands');
  const dir = join(brandsRoot, 'bb-acme');
  const jobsDir = join(root, 'jobs');
  mkdirSync(dir, { recursive: true });
  mkdirSync(jobsDir, { recursive: true });
  const stage = new CopyStage(dir, 'bb-acme', () => new Date('2026-11-15T06:00:00Z'));
  stage.open('week-01.json', [post('a1', '2026-11-16'), post('a2', '2026-11-19'), post('a3', '2026-11-20'), post('a4', '2026-11-17'), post('b1', '2026-11-23'), post('b2', '2026-11-24')]);
  stage.decide('week-01.json', 'a1', 'kept', 'u');
  stage.decide('week-01.json', 'a3', 'dropped', 'u');
  stage.decide('week-01.json', 'b1', 'kept', 'u');
  stage.markWeekDrawn('week-01.json', W1);
  if (mark === 'lapsed') stage.markWeekLapsed('week-01.json', W2);
  else stage.markWeekDrawn('week-01.json', W2);
  if (mark === 'batch') {
    // The oldest batches: one mark for the whole batch and none for its weeks.
    const file = join(dir, 'copy-first', 'week-01.json');
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { weekDrawn?: unknown; drawnAt?: string };
    delete raw.weekDrawn;
    raw.drawnAt = '2026-11-15T06:00:00.000Z';
    writeFileSync(file, JSON.stringify(raw));
  }
  const job = (id: string, state: string, extra: Record<string, unknown> = {}): void => writeFileSync(join(jobsDir, `${id}.json`), JSON.stringify({ id, key: `draw:bb-acme:week-01.json:${W1}`, kind: 'draw', brand: 'bb-acme', planFile: 'week-01.json', week: W1, state, ...extra }));
  return { root, brandsRoot, dir, jobsDir, stage, job, done: () => rmSync(root, { recursive: true, force: true }) };
}

test('a week drawn under the old rule is listed with what stays drawn and what would reopen, and listing changes nothing', () => {
  const s = setup('weeks');
  try {
    const before = JSON.stringify(s.stage.get('week-01.json'));
    const found = legacyWeeks('bb-acme', s.stage.get('week-01.json'), TODAY);
    assert.deepEqual(found.map((w) => [w.week, w.locked, w.open]), [[W1, ['a1', 'a4'], ['a2', 'a3']], [W2, ['b1'], ['b2']]]);
    const listed = reopenLegacyWeeks({ brandsRoot: s.brandsRoot, jobsDir: s.jobsDir, apply: false, today: TODAY });
    assert.equal(listed.length, 2);
    assert.equal(JSON.stringify(s.stage.get('week-01.json')), before, 'a dry run changes nothing');
  } finally {
    s.done();
  }
});

test('applying it makes the kept and the passed posts final on their own and opens the rest, tells the old draw job what it drew, and a second run changes nothing', () => {
  const s = setup('weeks');
  try {
    s.job('job-old-0123abcd', 'succeeded');
    s.job('job-run-0123abcd', 'running', { week: W2, key: `draw:bb-acme:week-01.json:${W2}` });
    const done = reopenLegacyWeeks({ brandsRoot: s.brandsRoot, jobsDir: s.jobsDir, apply: true, today: TODAY });
    assert.equal(done.length, 2);
    const batch = s.stage.get('week-01.json');
    const byId = (id: string) => batch.posts.find((p) => p.postId === id);
    assert.deepEqual(['a1', 'a4', 'b1'].map((id) => postLocked(batch, byId(id) as never)), [true, true, true], 'what was drawn, and a day that passed, stay final');
    assert.deepEqual(['a2', 'a3', 'b2'].map((id) => postLocked(batch, byId(id) as never)), [false, false, false], 'the rest is open again');
    assert.deepEqual(openPosts(batch, W1, TODAY), ['a2', 'a3']);
    assert.deepEqual(openPosts(batch, W2, TODAY), ['b2']);
    assert.equal(batch.weekDrawn, undefined, 'no week is closed as a whole any more');
    assert.equal(batch.drawnAt, undefined, 'and the batch is not closed as a whole');
    assert.deepEqual(['a1', 'a4'].map((id) => byId(id)?.drawnAt !== undefined), [true, true]);
    const old = JSON.parse(readFileSync(join(s.jobsDir, 'job-old-0123abcd.json'), 'utf8')) as { postIds?: string[] };
    assert.deepEqual(old.postIds, ['a1', 'a4'], 'the old draw is now known to have drawn only those');
    assert.equal((JSON.parse(readFileSync(join(s.jobsDir, 'job-run-0123abcd.json'), 'utf8')) as { postIds?: string[] }).postIds, undefined, 'a draw still running is left alone');

    const after = JSON.stringify(batch);
    assert.deepEqual(reopenLegacyWeeks({ brandsRoot: s.brandsRoot, jobsDir: s.jobsDir, apply: true, today: TODAY }), [], 'nothing left to reopen');
    assert.equal(JSON.stringify(s.stage.get('week-01.json')), after);
    // The customer can now decide an open post, as for any week drawn under the new rule.
    s.stage.decide('week-01.json', 'a2', 'kept', 'u');
    assert.equal(s.stage.get('week-01.json').posts.find((p) => p.postId === 'a2')?.state, 'kept');
    assert.throws(() => s.stage.decide('week-01.json', 'a1', 'dropped', 'u'), /already sent to be drawn/, 'a drawn post stays final');
  } finally {
    s.done();
  }
});

test('a week given up is left alone, and reopening one week keeps the others closed, whether the old rule marked each week or the whole batch', () => {
  const lapsed = setup('lapsed');
  try {
    assert.deepEqual(legacyWeeks('bb-acme', lapsed.stage.get('week-01.json'), TODAY).map((w) => w.week), [W1], 'the week given up is not listed');
    assert.deepEqual(lapsed.stage.reopenLegacyWeek('week-01.json', W2, TODAY), { locked: [], opened: [] });
    assert.deepEqual(lapsed.stage.reopenLegacyWeek('week-01.json', W1, TODAY).opened, ['a2', 'a3']);
    const batch = lapsed.stage.get('week-01.json');
    assert.ok(batch.weekLapsed?.[W2] !== undefined, 'it stays given up');
  } finally {
    lapsed.done();
  }
  for (const mark of ['weeks', 'batch'] as const) {
    const s = setup(mark);
    try {
      assert.deepEqual(s.stage.reopenLegacyWeek('week-01.json', W1, TODAY).opened, ['a2', 'a3'], mark);
      const batch = s.stage.get('week-01.json');
      assert.deepEqual(['b1', 'b2'].map((id) => postLocked(batch, batch.posts.find((p) => p.postId === id) as never)), [true, true], `${mark}: the other week is still closed`);
      assert.equal(batch.drawnAt, undefined, mark);
      assert.deepEqual(s.stage.reopenLegacyWeek('week-01.json', W1, TODAY), { locked: [], opened: [] }, `${mark}: asked again, nothing`);
    } finally {
      s.done();
    }
  }
});
