/**
 * The lock behind the paid-call ledger and the review store. It protects a read-modify-write of a log file between processes on one machine, and its
 * one rule is that a lock is never taken from a process that is still alive, however long that process takes: waiting too long is an error that
 * stops the caller, never a reason to take over. (A lock that is taken over after a timeout lets two writers believe they own the file when the
 * first is only slow, which would break the guarantee that a decision is made once.)
 *
 *   acquire   the lock file is created exclusively and holds {pid, token, host}; if it exists the caller waits;
 *   crashed   a lock whose holder process is gone (no such process) is removed, by one process at a time, after re-reading it under a second lock;
 *   damaged   a lock file that is not a lock (empty or garbled) is waited on and, only if it is old enough that no live writer could still be
 *             filling it in, removed;
 *   release   the holder removes its own lock, and only if the token is still its own.
 *
 * A holder on another machine, or a process id that has been reused by an unrelated live process, is never taken over: the caller fails closed
 * with a clear message and a person removes the file. Appends are written whole and flushed to disk before they are acknowledged.
 */
import { closeSync, fsyncSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
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
  /** A lock file that is not a valid lock is removed only when it is older than this. */
  garbageAgeMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_GARBAGE_AGE_MS = 60_000;
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

function create(path: string, token: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, token, host: HOST } satisfies Holder));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return true;
}

/** Removes a lock left by a process that no longer exists (or by nothing valid), one remover at a time, after looking again under a second lock. */
function removeDead(path: string, garbageAgeMs: number): void {
  const guard = `${path}.takeover`;
  const token = randomUUID();
  if (!create(guard, token)) {
    // Another process is doing the same; its guard is itself cleaned up if that process died.
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
    if (holder === 'missing') return;
    if (holder === 'garbage') {
      let age = 0;
      try {
        age = Date.now() - statSync(path).mtimeMs;
      } catch {
        return;
      }
      if (age >= garbageAgeMs) unlinkSync(path);
      return;
    }
    if (holder.host === HOST && !alive(holder.pid)) unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  } finally {
    try {
      if (readHolder(guard) !== 'missing') unlinkSync(guard);
    } catch {
      /* already gone */
    }
  }
}

/** Takes the lock, or fails after the timeout without ever taking it from a live process. Returns what releases it. */
export function acquireLock(path: string, options: LockOptions = {}): () => void {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, garbageAgeMs = DEFAULT_GARBAGE_AGE_MS } = options;
  const token = randomUUID();
  const deadline = Date.now() + timeoutMs;
  let wait = 2;
  for (;;) {
    if (create(path, token)) {
      return () => {
        const holder = readHolder(path);
        if (holder !== 'missing' && holder !== 'garbage' && holder.token === token) {
          try {
            unlinkSync(path);
          } catch {
            /* already gone */
          }
        }
      };
    }
    removeDead(path, garbageAgeMs);
    if (Date.now() > deadline) {
      const holder = readHolder(path);
      const who = holder === 'missing' ? 'another process' : holder === 'garbage' ? 'a damaged lock file' : `process ${holder.pid} on ${holder.host}`;
      throw new LockError(path, `${path} is held by ${who}; it was not taken over, so nothing was changed. If that process is gone, remove the file.`);
    }
    sleepSync(wait);
    wait = Math.min(wait * 2, 50);
  }
}

/** Runs `work` while holding the lock. */
export function withFileLock<T>(path: string, work: () => T, options: LockOptions = {}): T {
  const release = acquireLock(path, options);
  try {
    return work();
  } finally {
    release();
  }
}

/** Appends one whole line and flushes it to disk before returning, so an acknowledged record is not lost to a crash. */
export function appendDurable(path: string, line: string): void {
  const fd = openSync(path, 'a');
  try {
    writeSync(fd, line.endsWith('\n') ? line : `${line}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

