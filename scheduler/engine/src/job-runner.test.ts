import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobStore, type Job, type JobSpec } from './job-store.ts';
import { drain, engineArgs, execEngine, readLine, runJob, type Exec } from './job-runner.ts';

const spec = (over: Partial<JobSpec> = {}): JobSpec => ({ kind: 'copy', brand: 'acme', site: 'https://acme.example.com', by: 'owner', networks: ['instagram', 'linkedin'], days: 4, ...over });
const fresh = (): { s: JobStore; done: () => void } => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-'));
  return { s: new JobStore(dir), done: () => rmSync(dir, { recursive: true, force: true }) };
};
const fake = (lines: Array<[string, 'out' | 'err']>, code: number | null = 0, timedOut = false): Exec => async (_args, onLine) => {
  for (const [l, src] of lines) onLine(l, src);
  return { code, timedOut };
};

test('a copy job stops before any picture is bought, a draw job draws only the kept posts', () => {
  const { s, done } = fresh();
  try {
    const copy = s.enqueue(spec()).job;
    assert.deepEqual(engineArgs(copy), ['src/autopilot.ts', '--site', 'https://acme.example.com', '--brand', 'acme', '--copy-first', '--networks', 'instagram,linkedin', '--days', '4']);
    const rhythm = s.enqueue(spec({ brand: 'beta', site: 'https://beta.example.com', days: 4, weekdays: ['mon', 'thu'] })).job;
    assert.deepEqual(engineArgs(rhythm), ['src/autopilot.ts', '--site', 'https://beta.example.com', '--brand', 'beta', '--copy-first', '--networks', 'instagram,linkedin', '--days', '4', '--weekdays', 'mon,thu']);
    const timed = s.enqueue(spec({ brand: 'omega', site: 'https://omega.example.com', days: 4, weekdays: ['wed', 'sat'], startDate: '2026-12-16', time: '09:30' })).job;
    assert.deepEqual(engineArgs(timed), ['src/autopilot.ts', '--site', 'https://omega.example.com', '--brand', 'omega', '--copy-first', '--networks', 'instagram,linkedin', '--days', '4', '--weekdays', 'wed,sat', '--start', '2026-12-16', '--time', '09:30']);
    const retryDraw = s.enqueue(spec({ kind: 'draw', brand: 'delta', site: 'https://delta.example.com', planFile: 'week-02.json' })).job;
    s.claim(5, 1);
    s.update(retryDraw.id, { state: 'failed' });
    const again = s.enqueue(spec({ kind: 'draw', brand: 'delta', site: 'https://delta.example.com', planFile: 'week-02.json', retry: true })).job;
    assert.deepEqual(engineArgs(again), ['src/autopilot.ts', '--site', 'https://delta.example.com', '--brand', 'delta', '--draw-kept', 'week-02.json', '--redraw-missing']);
    const onePage = s.enqueue(spec({ brand: 'gamma', site: 'https://gamma.example.com/pricing', page: true, networks: [] })).job;
    assert.deepEqual(engineArgs(onePage), ['src/autopilot.ts', '--site', 'https://gamma.example.com/pricing', '--brand', 'gamma', '--copy-first', '--page', '--days', '4']);
    const draw = s.enqueue(spec({ kind: 'draw', planFile: 'week-03.json' })).job;
    assert.deepEqual(engineArgs(draw), ['src/autopilot.ts', '--site', 'https://acme.example.com', '--brand', 'acme', '--draw-kept', 'week-03.json']);
  } finally {
    done();
  }
});

test('lines from the engine tell the step, the plan file and the error', () => {
  assert.deepEqual(readLine('2/4 Writing 4 new pain-point posts from 2026-11-10 (week-09.json)…', 'out'), { step: 2, planFile: 'week-09.json' });
  assert.deepEqual(readLine('BUDGET_EXHAUSTED (daily_cap): the day is spent. Nothing more was bought.', 'err').error?.code, 'BUDGET_EXHAUSTED');
  assert.deepEqual(readLine('PUBLISHING_DISABLED: switched off', 'err').error, { code: 'PUBLISHING_DISABLED', message: 'switched off' });
  assert.deepEqual(readLine('    BUDGET_EXHAUSTED: not an error line', 'out'), {});
});

test('a successful copy job records the plan it wrote and the last step', async () => {
  const { s, done } = fresh();
  try {
    s.enqueue(spec());
    const job = s.claim(1, 1);
    const result = await runJob(s, job as NonNullable<typeof job>, fake([['1/4 Reading the site', 'out'], ['2/4 Writing 4 new posts (week-09.json)…', 'out'], ['3/4 Copy first: 4 posts are waiting', 'out']]));
    assert.equal(result.state, 'succeeded');
    assert.equal(result.step, 3);
    assert.equal(result.planFileMade, 'week-09.json');
    assert.equal(result.logTail.length, 3);
  } finally {
    done();
  }
});

test('a failed run carries the engine\'s error, a stop for time is reported as such', async () => {
  const { s, done } = fresh();
  try {
    s.enqueue(spec());
    const failed = await runJob(s, s.claim(1, 1) as never, fake([['BUDGET_EXHAUSTED (daily_cap): spent', 'err']], 1));
    assert.equal(failed.state, 'failed');
    assert.equal(failed.error?.code, 'BUDGET_EXHAUSTED');
    s.enqueue(spec({ brand: 'globex', site: 'https://globex.example.com' }));
    const slow = await runJob(s, s.claim(1, 1) as never, fake([], null, true));
    assert.equal(slow.error?.code, 'TIMEOUT');
    s.enqueue(spec({ brand: 'initech', site: 'https://initech.example.com' }));
    const quiet = await runJob(s, s.claim(1, 1) as never, fake([], 2));
    assert.equal(quiet.error?.message, 'the engine stopped with exit code 2');
  } finally {
    done();
  }
});

test('draining starts every job that may start and respects the limit per brand', async () => {
  const { s, done } = fresh();
  try {
    s.enqueue(spec());
    s.enqueue(spec({ kind: 'draw', planFile: 'week-01.json' }));
    s.enqueue(spec({ brand: 'globex', site: 'https://globex.example.com' }));
    const started: string[] = [];
    const exec: Exec = async (args) => { started.push(args.slice(3).join(' ')); return { code: 0, timedOut: false }; };
    assert.equal(await drain(s, exec, 2, 99), 2);
    assert.equal(await drain(s, exec, 2, 99), 1);
    assert.deepEqual(s.list().map((j) => j.state), ['succeeded', 'succeeded', 'succeeded']);
  } finally {
    done();
  }
});

test('the real process runner reads both streams, reports the exit code and stops a run that takes too long', async () => {
  const exec = execEngine(tmpdir());
  const seen: string[] = [];
  const ended = await exec(['-e', 'console.log("2/4 Writing (week-01.json)"); console.error("FOO_BAR: boom"); process.exit(3)'], (l, src) => seen.push(`${src}:${l}`), 10_000);
  assert.deepEqual(ended, { code: 3, timedOut: false });
  assert.deepEqual(seen.sort(), ['err:FOO_BAR: boom', 'out:2/4 Writing (week-01.json)']);
  const slow = await exec(['-e', 'setTimeout(() => {}, 60000)'], () => {}, 300);
  assert.equal(slow.timedOut, true);
});

test('an add-a-network job runs the engine with the batch and network, keeps its per-topic result, and queues a draw for each topic that needs its own picture', async () => {
  const { s, done } = fresh();
  try {
    const job = s.enqueue(spec({ kind: 'network', planFile: 'week-01.json', network: 'facebook' })).job;
    assert.deepEqual(engineArgs(job), ['src/autopilot.ts', '--site', 'https://acme.example.com', '--brand', 'acme', '--add-network', 'week-01.json', '--network', 'facebook']);
    const claimed = s.claim(5, 1) as Job;
    const result = { network: 'facebook', topics: [{ postId: 'w01-d1', outcome: 'written', versionIds: ['acme.1111111111111111'] }, { postId: 'w01-d2', outcome: 'written', needsDraw: true }] };
    const done1 = await runJob(s, claimed, fake([['3/4 Writing a caption', 'out'], [`ADD_NETWORK_RESULT ${JSON.stringify(result)}`, 'out']]));
    assert.equal(done1.state, 'succeeded');
    const queued = s.list().find((j) => j.kind === 'newnet');
    assert.ok(queued, 'a draw was queued');
    assert.deepEqual([queued?.planFile, queued?.postId, queued?.network, queued?.state], ['week-01.json', 'w01-d2', 'facebook', 'queued']);
    assert.deepEqual(done1.result?.topics, [{ postId: 'w01-d1', outcome: 'written', versionIds: ['acme.1111111111111111'] }, { postId: 'w01-d2', outcome: 'written', drawJobId: queued?.id }]);
    assert.equal(done1.logTail.some((l) => l.includes('ADD_NETWORK_RESULT')), false, 'the result line is not shown as log');
    assert.deepEqual(engineArgs(queued as Job), ['src/autopilot.ts', '--site', 'https://acme.example.com', '--brand', 'acme', '--draw-kept', 'week-01.json', '--redraw-post', 'w01-d2', '--redraw-network', 'facebook']);
  } finally {
    done();
  }
});

test('a carousel job starts the carousel command with the site, the channels and the day and time, and its plan file is noted when the engine names it', async () => {
  const { s, done } = fresh();
  try {
    const { job } = s.enqueue(spec({ kind: 'carousel', days: undefined, startDate: '2026-11-18', time: '10:00' }));
    assert.deepEqual(engineArgs(job), ['src/carousel-cli.ts', '--site', 'https://acme.example.com', '--networks', 'instagram,linkedin', '--start', '2026-11-18', '--time', '10:00']);
    assert.deepEqual(engineArgs({ ...job, startDate: undefined as never, time: undefined as never }), ['src/carousel-cli.ts', '--site', 'https://acme.example.com', '--networks', 'instagram,linkedin']);
    const exec: Exec = async (_args, onLine) => {
      onLine('1/4 Planning a carousel from 6 verified facts…', 'out');
      onLine("4/4 The carousel is in the owner's review queue (week-03.json); nothing was scheduled or published.", 'out');
      return { code: 0, timedOut: false };
    };
    const claimed = s.claim(2, process.pid);
    assert.ok(claimed);
    const finished = await runJob(s, claimed, exec);
    assert.equal(finished.state, 'succeeded');
    assert.equal(finished.planFileMade, 'week-03.json');
    assert.equal(finished.step, 4);
    const failing: Exec = async (_args, onLine) => { onLine('CAROUSEL_NOT_MADE: slide 2 was rejected', 'err'); return { code: 1, timedOut: false }; };
    s.enqueue(spec({ kind: 'carousel', days: undefined, startDate: '2026-11-19' }));
    const next = s.claim(2, process.pid);
    assert.ok(next);
    const failed = await runJob(s, next, failing);
    assert.deepEqual([failed.state, failed.error?.code], ['failed', 'CAROUSEL_NOT_MADE']);
  } finally {
    done();
  }
});
