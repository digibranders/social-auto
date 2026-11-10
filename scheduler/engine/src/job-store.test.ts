import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobError, JobStore, scrub, type JobSpec } from './job-store.ts';

const copy = (brand = 'acme', over: Partial<JobSpec> = {}): JobSpec => ({ kind: 'copy', brand, site: `https://${brand}.example.com`, by: 'owner', networks: ['instagram'], days: 4, ...over });

function store(): { s: JobStore; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'jobs-'));
  return { s: new JobStore(dir), done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('asking twice for the same website returns the job that is already waiting or running', () => {
  const { s, done } = store();
  try {
    const first = s.enqueue(copy());
    const second = s.enqueue(copy());
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.job.id, first.job.id);
    s.claim(2, 1);
    assert.equal(s.enqueue(copy()).job.id, first.job.id);
    s.update(first.job.id, { state: 'succeeded' });
    assert.equal(s.enqueue(copy()).created, true);
  } finally {
    done();
  }
});

test('a draw is only ever asked for once per batch, even after it failed', () => {
  const { s, done } = store();
  try {
    const draw = (): JobSpec => ({ kind: 'draw', brand: 'acme', site: 'https://acme.example.com', by: 'owner', planFile: 'week-01.json' });
    const first = s.enqueue(draw());
    s.claim(2, 1);
    s.update(first.job.id, { state: 'failed', error: { code: 'X', message: 'x' } });
    const again = s.enqueue(draw());
    assert.equal(again.created, false);
    assert.equal(again.job.state, 'failed');
    assert.equal(s.enqueue({ ...draw(), planFile: 'week-02.json' }).created, true);
  } finally {
    done();
  }
});

test('one job per brand runs at a time, different brands side by side, and never more than the limit', () => {
  const { s, done } = store();
  try {
    s.enqueue(copy('acme'));
    s.enqueue({ kind: 'draw', brand: 'acme', site: 'https://acme.example.com', by: 'o', planFile: 'week-01.json' });
    s.enqueue(copy('globex'));
    s.enqueue(copy('initech'));
    const a = s.claim(2, 1);
    const b = s.claim(2, 1);
    assert.deepEqual([a?.brand, b?.brand], ['acme', 'globex']);
    assert.equal(s.claim(2, 1), null);
    s.update((a as { id: string }).id, { state: 'succeeded' });
    assert.equal(s.claim(2, 1)?.kind, 'draw');
  } finally {
    done();
  }
});

test('a finished job is never changed again, and progress keeps only the last lines without keys', () => {
  const { s, done } = store();
  try {
    const { job } = s.enqueue(copy());
    s.claim(1, 1);
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i} sk-abcdefghijklmnop`);
    const mid = s.update(job.id, { logTail: lines, step: 2 });
    assert.equal(mid.logTail.length, 30);
    assert.equal(mid.logTail[0], 'line 20 [key removed]');
    s.update(job.id, { state: 'failed', error: { code: 'E', message: 'm' } });
    const after = s.update(job.id, { state: 'succeeded' });
    assert.equal(after.state, 'failed');
    assert.ok(after.finishedAt);
  } finally {
    done();
  }
});

test('a job left running by a runner that is gone is failed, not retried', () => {
  const { s, done } = store();
  try {
    const { job } = s.enqueue(copy());
    s.claim(1, 4242);
    assert.deepEqual(s.recover(() => true), []);
    const lost = s.recover(() => false);
    assert.equal(lost[0]?.error?.code, 'INTERRUPTED');
    assert.equal(s.get(job.id).state, 'failed');
  } finally {
    done();
  }
});

test('bad ids and missing people are refused', () => {
  const { s, done } = store();
  try {
    assert.throws(() => s.get('../x'), (e) => e instanceof JobError && e.code === 'INVALID');
    assert.throws(() => s.get('job-abcdef-12345678'), (e) => e instanceof JobError && e.code === 'NOT_FOUND');
    assert.throws(() => s.enqueue(copy('acme', { by: ' ' })), (e) => e instanceof JobError && e.code === 'INVALID');
    assert.equal(scrub('Bearer abcdefghijklmnop123'), 'Bearer [removed]');
  } finally {
    done();
  }
});

test('a draw is asked for once; only after it has failed may what it did not finish be asked for again', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jobs-retry-'));
  try {
    const s = new JobStore(dir);
    const draw = (over: Partial<JobSpec> = {}): JobSpec => ({ kind: 'draw', brand: 'acme', site: 'https://acme.example.com', by: 'owner', planFile: 'week-01.json', ...over });
    const first = s.enqueue(draw()).job;
    assert.equal(s.enqueue(draw({ retry: true })).created, false, 'not while the first is waiting');
    const claimed = s.claim(1, 1) as NonNullable<ReturnType<typeof s.claim>>;
    assert.equal(s.enqueue(draw({ retry: true })).created, false, 'not while it runs');
    s.update(claimed.id, { state: 'succeeded' });
    assert.equal(s.enqueue(draw({ retry: true })).created, false, 'not after it succeeded');
    const dir2 = mkdtempSync(join(tmpdir(), 'jobs-retry2-'));
    try {
      const t = new JobStore(dir2);
      const a = t.enqueue(draw()).job;
      t.claim(1, 1);
      t.update(a.id, { state: 'failed', error: { code: 'BUDGET_EXHAUSTED', message: 'the day is spent' } });
      assert.equal(t.enqueue(draw()).created, false, 'a plain repeat still answers with the failed job');
      const again = t.enqueue(draw({ retry: true }));
      assert.equal(again.created, true);
      assert.equal(again.job.retry, true);
      assert.notEqual(again.job.id, a.id);
      assert.equal(t.enqueue(draw({ retry: true })).created, false, 'and only once for each failure');
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
    assert.equal(first.retry, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
