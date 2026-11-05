import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, appendDurable, LockError, withFileLock } from './file-lock.ts';

const WORKER = new URL('./lock-worker.ts', import.meta.url).pathname;

function dir(): { path: string; done: () => void } {
  const path = mkdtempSync(join(tmpdir(), 'lock-'));
  return { path, done: () => rmSync(path, { recursive: true, force: true }) };
}

const worker = (...args: string[]): ReturnType<typeof spawn> => spawn(process.execPath, [WORKER, ...args], { stdio: ['ignore', 'pipe', 'inherit'] });
const waitFor = (child: ReturnType<typeof spawn>, text: string): Promise<void> => new Promise((resolve) => child.stdout?.on('data', (d: Buffer) => d.toString().includes(text) && resolve()));
const finished = (child: ReturnType<typeof spawn>): Promise<number | null> => new Promise((resolve) => child.on('close', resolve));

test('a lock held by a live process is never taken over, however long it takes: the waiting caller fails and nothing changes', async () => {
  const d = dir();
  try {
    const lock = join(d.path, 'x.lock');
    const holder = worker('hold', lock, '1500');
    await waitFor(holder, 'HELD');
    const before = readFileSync(lock, 'utf8');
    // The old design took a lock over after ten seconds; here even a lock that has been held for a while is left alone while its process lives.
    assert.throws(() => acquireLock(lock, { timeoutMs: 400 }), LockError);
    assert.equal(readFileSync(lock, 'utf8'), before, 'the holder\'s lock was not touched');
    assert.equal(await finished(holder), 0);
    assert.equal(existsSync(lock), false, 'the holder released its own lock');
    // Once the holder is done the lock is free.
    withFileLock(lock, () => undefined, { timeoutMs: 1000 });
  } finally {
    d.done();
  }
});

test('a waiting caller gets the lock when the live holder lets go', async () => {
  const d = dir();
  try {
    const lock = join(d.path, 'x.lock');
    const holder = worker('hold', lock, '600');
    await waitFor(holder, 'HELD');
    let got = false;
    withFileLock(lock, () => { got = true; }, { timeoutMs: 5000 });
    assert.equal(got, true);
    await finished(holder);
  } finally {
    d.done();
  }
});

test('a lock left by a process that was killed is recovered, and the work goes on', async () => {
  const d = dir();
  try {
    const lock = join(d.path, 'x.lock');
    const holder = worker('hold-forever', lock);
    await waitFor(holder, 'HELD');
    holder.kill('SIGKILL');
    await finished(holder);
    assert.equal(existsSync(lock), true, 'a killed process leaves its lock behind');
    let ran = false;
    withFileLock(lock, () => { ran = true; }, { timeoutMs: 3000 });
    assert.equal(ran, true);
  } finally {
    d.done();
  }
});

test('six processes racing over a lock left by a dead one: exactly one gets it at a time and no update is lost', async () => {
  const d = dir();
  try {
    const lock = join(d.path, 'x.lock');
    const counter = join(d.path, 'count');
    writeFileSync(counter, '0');
    // A dead holder's lock to start from.
    const dead = worker('hold-forever', lock);
    await waitFor(dead, 'HELD');
    dead.kill('SIGKILL');
    await finished(dead);
    const runs = Array.from({ length: 6 }, () => worker('counter', lock, counter, '25'));
    const codes = await Promise.all(runs.map(finished));
    assert.deepEqual(codes, [0, 0, 0, 0, 0, 0]);
    assert.equal(readFileSync(counter, 'utf8'), '150', 'every one of the 150 updates counted');
    assert.equal(existsSync(lock), false);
    assert.equal(existsSync(`${lock}.takeover`), false);
  } finally {
    d.done();
  }
});

test('a lock file that is not a lock is waited on, and removed only once it is old enough that no writer could still be filling it in', () => {
  const d = dir();
  try {
    const lock = join(d.path, 'x.lock');
    writeFileSync(lock, '');
    assert.throws(() => acquireLock(lock, { timeoutMs: 200 }), LockError, 'a fresh empty file might be a lock being written');
    assert.equal(existsSync(lock), true);
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    let ran = false;
    withFileLock(lock, () => { ran = true; }, { timeoutMs: 1000 });
    assert.equal(ran, true);
  } finally {
    d.done();
  }
});

test('a lock held by another machine is never taken over', () => {
  const d = dir();
  try {
    const lock = join(d.path, 'x.lock');
    writeFileSync(lock, JSON.stringify({ pid: 99999999, token: 't', host: 'some-other-machine' }));
    assert.throws(() => acquireLock(lock, { timeoutMs: 200 }), /some-other-machine/);
  } finally {
    d.done();
  }
});

test('a lock is released by its own holder only: a changed lock file is not removed by a stale release', () => {
  const d = dir();
  try {
    const lock = join(d.path, 'x.lock');
    const release = acquireLock(lock);
    writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'someone-else', host: 'h' }));
    release();
    assert.equal(existsSync(lock), true, 'a lock that is no longer this holder\'s is left alone');
  } finally {
    d.done();
  }
});

test('an error inside the work still releases the lock', () => {
  const d = dir();
  try {
    const lock = join(d.path, 'x.lock');
    assert.throws(() => withFileLock(lock, () => { throw new Error('boom'); }), /boom/);
    assert.equal(existsSync(lock), false);
  } finally {
    d.done();
  }
});

test('an appended record is written whole, with its newline', () => {
  const d = dir();
  try {
    const file = join(d.path, 'log.jsonl');
    appendDurable(file, '{"a":1}');
    appendDurable(file, '{"b":2}\n');
    assert.equal(readFileSync(file, 'utf8'), '{"a":1}\n{"b":2}\n');
  } finally {
    d.done();
  }
});
