/**
 * A worker process for the file-lock tests: it takes the lock the way a real writer would, in a process of its own, so that waiting, crashes and
 * races can be tested for real. Not used by the engine.
 *   node src/lock-worker.ts hold <lock> <milliseconds>      take the lock, print HELD, keep it that long, release it, print DONE
 *   node src/lock-worker.ts hold-forever <lock>             take the lock, print HELD, and never let go (to be killed)
 *   node src/lock-worker.ts counter <lock> <file> <times>   add one to the number in <file>, <times> times, each time under the lock
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { withFileLock } from './file-lock.ts';

const [mode, lock, a, b] = process.argv.slice(2);
if (!mode || !lock) throw new Error('usage: lock-worker <mode> <lock> ...');
const sleepSync = (ms: number): void => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

if (mode === 'hold' || mode === 'hold-forever') {
  withFileLock(lock, () => {
    console.log('HELD');
    if (mode === 'hold') sleepSync(Number(a));
    else for (;;) sleepSync(1000);
  }, { timeoutMs: 20_000 });
  console.log('DONE');
} else if (mode === 'counter') {
  for (let i = 0; i < Number(b); i++) {
    withFileLock(lock, () => {
      const value = Number(readFileSync(a as string, 'utf8'));
      // A small pause inside the critical section makes a lost update likely if two processes are ever inside at once.
      sleepSync(1);
      writeFileSync(a as string, String(value + 1));
    }, { timeoutMs: 30_000 });
  }
  console.log('DONE');
} else {
  throw new Error(`unknown mode ${mode}`);
}
