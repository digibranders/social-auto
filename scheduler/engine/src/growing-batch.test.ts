import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CopyStage, CopyStageError, weeksOf } from './copy-stage.ts';
import { JobStore, type JobSpec } from './job-store.ts';
import { readLine, runJob, type Exec } from './job-runner.ts';

const word = (id: string, date: string): { postId: string; date: string; headline: string; caption: string } => ({ postId: id, date, headline: `Headline ${id}`, caption: `Caption ${id}` });
const week1 = [word('w01-d1', '2026-11-16'), word('w01-d2', '2026-11-17')];
const week2 = [word('w01-d3', '2026-11-23'), word('w01-d4', '2026-11-24')];
const fresh = (): { stage: CopyStage; done: () => void } => {
  const dir = mkdtempSync(join(tmpdir(), 'growing-'));
  return { stage: new CopyStage(dir, 'acme', () => new Date('2026-11-14T10:00:00Z')), done: () => rmSync(dir, { recursive: true, force: true }) };
};

test('a batch grows week by week: the same batch, new posts appended, earlier choices untouched, the plan file hook runs under the lock', () => {
  const { stage, done } = fresh();
  try {
    stage.open('week-01.json', week1, ['2026-11-16', '2026-11-17'], { weeksDone: 1, weeksTotal: 2 });
    stage.decide('week-01.json', 'w01-d1', 'kept', 'owner');
    let planned = 0;
    const grown = stage.appendWeek('week-01.json', week2, ['2026-11-23', '2026-11-24'], { weeksDone: 2, weeksTotal: 2 }, () => { planned += 1; });
    assert.equal(planned, 1);
    assert.deepEqual(grown.posts.map((p) => [p.postId, p.state]), [['w01-d1', 'kept'], ['w01-d2', 'pending'], ['w01-d3', 'pending'], ['w01-d4', 'pending']]);
    assert.deepEqual(weeksOf(grown), ['2026-11-16', '2026-11-23']);
    assert.deepEqual(grown.requestedDays, ['2026-11-16', '2026-11-17', '2026-11-23', '2026-11-24']);
    assert.deepEqual(grown.writing, { weeksDone: 2, weeksTotal: 2 });
    assert.equal(stage.get('week-01.json').createdAt, '2026-11-14T10:00:00.000Z', 'same batch');
  } finally {
    done();
  }
});

test('a week that fails to save the plan file leaves the batch as it was, a duplicate id and a batch put away are refused', () => {
  const { stage, done } = fresh();
  try {
    stage.open('week-01.json', week1, undefined, { weeksDone: 1, weeksTotal: 2 });
    assert.throws(() => stage.appendWeek('week-01.json', week2, [], { weeksDone: 2, weeksTotal: 2 }, () => { throw new Error('disk full'); }), /disk full/);
    assert.equal(stage.get('week-01.json').posts.length, 2);
    assert.throws(() => stage.appendWeek('week-01.json', week1, [], { weeksDone: 2, weeksTotal: 2 }, () => undefined), (e: unknown) => e instanceof CopyStageError && e.code === 'CONFLICT');
    stage.close('week-01.json', 'owner');
    assert.throws(() => stage.appendWeek('week-01.json', week2, [], { weeksDone: 2, weeksTotal: 2 }, () => undefined), (e: unknown) => e instanceof CopyStageError && e.code === 'CLOSED');
  } finally {
    done();
  }
});

test('while the batch is growing it does not count as drawn, even when every week so far is; finishing the writing settles it', () => {
  const { stage, done } = fresh();
  try {
    stage.open('week-01.json', week1, undefined, { weeksDone: 1, weeksTotal: 2 });
    stage.decide('week-01.json', 'w01-d1', 'kept', 'owner');
    stage.markWeekDrawn('week-01.json', '2026-11-16');
    assert.equal(stage.get('week-01.json').drawnAt, undefined, 'week 2 is still to come');
    stage.appendWeek('week-01.json', week2, [], { weeksDone: 2, weeksTotal: 2 }, () => undefined);
    stage.finishWriting('week-01.json');
    const batch = stage.get('week-01.json');
    assert.equal(batch.writing, undefined);
    assert.equal(batch.drawnAt, undefined, 'week 2 is not drawn yet');
    stage.markWeekLapsed('week-01.json', '2026-11-23');
    assert.notEqual(stage.get('week-01.json').drawnAt, undefined, 'every week drawn or lapsed, writing over');
    stage.finishWriting('week-01.json');
  } finally {
    done();
  }
});

test('finishing the writing of a batch that stopped halfway keeps the weeks that were saved', () => {
  const { stage, done } = fresh();
  try {
    stage.open('week-01.json', week1, undefined, { weeksDone: 1, weeksTotal: 3 });
    stage.finishWriting('week-01.json');
    const batch = stage.get('week-01.json');
    assert.equal(batch.writing, undefined);
    assert.equal(batch.posts.length, 2);
  } finally {
    done();
  }
});

test('the runner reads the weeks lines, keeps them on the job even when the engine fails later, and closes the batch afterwards', async () => {
  assert.deepEqual(readLine('WEEKS 2/5', 'out'), { weeks: { done: 2, total: 5 } });
  assert.deepEqual(readLine('    WEEKS 2/5', 'out'), {});
  const dir = mkdtempSync(join(tmpdir(), 'growing-jobs-'));
  try {
    const store = new JobStore(dir);
    const spec: JobSpec = { kind: 'copy', brand: 'acme', site: 'https://acme.example.com', by: 'owner', networks: ['instagram'], days: 19 };
    const job = store.enqueue(spec).job;
    store.claim(1, 1);
    const exec: Exec = async (_args, onLine) => {
      onLine('2/4 Writing 19 new pain-point posts from 2026-11-16 (week-07.json)…', 'out');
      onLine('WEEKS 0/4', 'out');
      onLine('WEEKS 1/4', 'out');
      onLine('WEEKS 2/4', 'out');
      onLine('BUDGET_EXHAUSTED (daily_cap): the day is spent.', 'err');
      return { code: 1, timedOut: false };
    };
    const closed: string[] = [];
    const ended = await runJob(store, store.get(job.id), exec, { finished: (j) => closed.push(`${j.planFileMade}`) });
    assert.equal(ended.state, 'failed');
    assert.deepEqual([ended.weeksDone, ended.weeksTotal, ended.error?.code], [2, 4, 'BUDGET_EXHAUSTED']);
    assert.deepEqual(closed, ['week-07.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
