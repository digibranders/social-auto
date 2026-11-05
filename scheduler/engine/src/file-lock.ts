/**
 * The lock behind the paid-call ledger and the review store. It protects a read-modify-write of a log file between processes on one machine, and its
 * one rule is that a lock is never taken from a process that is still alive, however long that process takes: waiting too long is an error that
 * stops the caller, never a reason to take over. (A lock that is taken over after a timeout lets two writers believe they own the file when the
 * first is only slow, which would break the guarantee that a decision is made once.)
 *
 *   acquire   the lock file is created exclusively and holds {pid, token, host}; if it exists the caller waits;
 *   crashed   a lock whose holder process is gone (no such process) is removed, by one process at a time, after re-reading it under a second lock;
 *   damaged   a lock file that is not a lock (empty or garbled) is never removed by age or by anyone's guess: file age does not prove its creator
 *             has died. The caller fails with a message and a person recovers it. A lock is created whole (written to a private file, flushed, then
 *             linked into place in one step), so a live writer never leaves a half-written lock behind;
 *   release   the holder removes its own lock, and only if the token is still its own.
 *
 * A holder on another machine, or a process id that has been reused by an unrelated live process, is never taken over: the caller fails closed
 * with a clear message and a person removes the file. Appends are written whole and flushed to disk before they are acknowledged.
 */
import { closeSync, copyFileSync, existsSync, fsyncSync, linkSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

export class LockError extends Error {
  readonly lockPath: string;
  constructor(lockPath: string, message: string) {
    super(message);
    this.name = 'LockError';
    this.lockPath = lockPath;
  }
}

export interface LockOptions {
  /** How long a caller waits for a live holder before failing. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const HOST = hostname();

const sleepSync = (ms: number): void => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

interface Holder {
  pid: number;
  token: string;
  host: string;
}

function readHolder(path: string): Holder | 'missing' | 'garbage' {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
  try {
    const value = JSON.parse(text) as Partial<Holder>;
    return typeof value.pid === 'number' && typeof value.token === 'string' && typeof value.host === 'string' ? { pid: value.pid, token: value.token, host: value.host } : 'garbage';
  } catch {
    return 'garbage';
  }
}

/** True when a process with this id exists (a process we may not signal still exists). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Flushes a folder's entries to disk, so a file created, linked, renamed or removed in it survives a crash of the machine. */
export function syncDir(path: string): void {
  let fd: number;
  try {
    fd = openSync(dirname(path), 'r');
  } catch {
    return;
  }
  try {
    fsyncSync(fd);
  } catch {
    /* some file systems cannot flush a folder; the file itself was flushed */
  } finally {
    closeSync(fd);
  }
}

/** Creates the lock with its holder already written in it, in one step: the contents go to a private file, are flushed, and the file is linked to the lock's name (which fails if the name is taken). */
function create(path: string, token: string): boolean {
  const own = `${path}.${token}.tmp`;
  const fd = openSync(own, 'wx');
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, token, host: HOST } satisfies Holder));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(own, path);
  } catch (error) {
    unlinkSync(own);
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  unlinkSync(own);
  syncDir(path);
  return true;
}

/** Removes a lock left by a process that no longer exists, one remover at a time, after looking again under a second lock. A lock that is not valid is left alone. */
function removeDead(path: string): void {
  const guard = `${path}.takeover`;
  const token = randomUUID();
  if (!create(guard, token)) {
    // Another process is doing the same. Its guard is cleaned up only if that process is provably gone.
    const other = readHolder(guard);
    if (other !== 'missing' && other !== 'garbage' && other.host === HOST && !alive(other.pid)) {
      try {
        unlinkSync(guard);
      } catch {
        /* someone else did */
      }
    }
    return;
  }
  try {
    const holder = readHolder(path);
    if (holder !== 'missing' && holder !== 'garbage' && holder.host === HOST && !alive(holder.pid)) {
      unlinkSync(path);
      syncDir(path);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  } finally {
    const mine = readHolder(guard);
    if (mine !== 'missing' && mine !== 'garbage' && mine.token === token) {
      try {
        unlinkSync(guard);
      } catch {
        /* already gone */
      }
    }
  }
}

export type LockState = { state: 'free' } | { state: 'held'; pid: number; host: string } | { state: 'dead_holder'; pid: number; host: string } | { state: 'foreign_holder'; pid: number; host: string } | { state: 'damaged' };

/** What a lock file says right now, without touching it. */
export function lockState(path: string): LockState {
  const holder = readHolder(path);
  if (holder === 'missing') return { state: 'free' };
  if (holder === 'garbage') return { state: 'damaged' };
  if (holder.host !== HOST) return { state: 'foreign_holder', pid: holder.pid, host: holder.host };
  return alive(holder.pid) ? { state: 'held', pid: holder.pid, host: holder.host } : { state: 'dead_holder', pid: holder.pid, host: holder.host };
}

/** Takes the lock, or fails after the timeout without ever taking it from a live process. Returns what releases it. */
export type Release = (() => void) & {
  /** True while the lock file still names this holder: checked just before a protected change is committed. */
  owns: () => boolean;
};

export function acquireLock(path: string, options: LockOptions = {}): Release {
  const { timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  const token = randomUUID();
  const deadline = Date.now() + timeoutMs;
  let wait = 2;
  const take = (): Release | undefined => {
    if (!create(path, token)) return undefined;
    const release = (() => {
      const holder = readHolder(path);
      if (holder !== 'missing' && holder !== 'garbage' && holder.token === token) {
        try {
          unlinkSync(path);
          syncDir(path);
        } catch {
          /* already gone */
        }
      }
    }) as Release;
    release.owns = () => {
      const holder = readHolder(path);
      return holder !== 'missing' && holder !== 'garbage' && holder.token === token && holder.pid === process.pid;
    };
    return release;
  };
  for (;;) {
    const got = take();
    if (got) return got;
    // A lock left by a process that is gone is cleared, and the lock is tried for again straight away, even with no time to wait.
    removeDead(path);
    const again = take();
    if (again) return again;
    if (Date.now() > deadline) {
      const holder = readHolder(path);
      const who = holder === 'missing' ? 'another process' : holder === 'garbage' ? 'a damaged lock file (needs a person to recover it, see the recovery procedure)' : `process ${holder.pid} on ${holder.host}`;
      throw new LockError(path, `${path} is held by ${who}; it was not taken over, so nothing was changed.`);
    }
    sleepSync(wait);
    wait = Math.min(wait * 2, 50);
  }
}

/** Runs `work` while holding the lock. `work` is given a check that the lock is still this holder's, to be made right before a protected change is committed. */
export function withFileLock<T>(path: string, work: (owns: () => boolean) => T, options: LockOptions = {}): T {
  const release = acquireLock(path, options);
  try {
    return work(release.owns);
  } finally {
    release();
  }
}

/** Appends one whole line and flushes it to disk before returning, so an acknowledged record is not lost to a crash. */
export function appendDurable(path: string, line: string): void {
  const isNew = !existsSync(path);
  const fd = openSync(path, 'a');
  try {
    writeSync(fd, line.endsWith('\n') ? line : `${line}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (isNew) syncDir(path);
}

/** Copies a file so that the copy is complete, flushed and in place under its final name before anything refers to it: written to a private name, flushed, then renamed. */
export function copyDurable(from: string, to: string): void {
  const own = `${to}.${randomUUID()}.tmp`;
  copyFileSync(from, own);
  const fd = openSync(own, 'r+');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(own, to);
  syncDir(to);
}

