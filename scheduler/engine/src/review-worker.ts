/**
 * A worker process for the approval regression tests: it makes review decisions the way a real writer would, in a process of its own, so that races
 * and crashes can be tested for real. Not used by the engine.
 *   node src/review-worker.ts approve|reject <brand dir> <version id> <go file>   wait until <go file> exists, then decide; print RESULT <OK|code>
 *   node src/review-worker.ts churn <brand dir> <pictures dir>                    register versions and decide on them without stopping (to be killed)
 */
import { existsSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ReviewError, ReviewStore } from './review-store.ts';

const [mode, brandDir, a, b] = process.argv.slice(2);
if (!mode || !brandDir) throw new Error('usage: review-worker <mode> <brand dir> ...');
const store = new ReviewStore(brandDir, basename(brandDir), undefined, 5000);

if (mode === 'approve' || mode === 'reject') {
  const [versionId, goFile] = [a as string, b as string];
  while (!existsSync(goFile)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
  try {
    if (mode === 'approve') store.approve(versionId, 'owner');
    else store.reject(versionId, 'owner', 'other', 'race');
    console.log('RESULT OK');
  } catch (error) {
    console.log(`RESULT ${error instanceof ReviewError ? error.code : 'ERROR'}`);
  }
} else if (mode === 'churn') {
  console.log('STARTED');
  for (let i = 0; ; i++) {
    const picture = join(a as string, `p${process.pid}-${i}.jpg`);
    writeFileSync(picture, `picture ${process.pid} ${i} ${'x'.repeat(2000)}`);
    const version = store.addVersion({
      postId: `w01-d${i}`, planFile: 'week-01.json', headline: `Headline ${i}`, caption: `Caption ${i}`, ctaUrl: 'https://acme.example', factIds: ['f1'],
      evidence: [{ factId: 'f1', text: 't', quote: 'q', url: 'https://acme.example/', context: 'c' }], imagePath: picture,
      validation: { accepted: true, readings: 2, defects: [], reportFile: 'r.json' }, attempts: 1, costUsd: 0.016,
    });
    store.approve(version.versionId, 'owner');
    if (i % 2 === 0) store.reject(version.versionId, 'owner', 'other', 'withdrawn');
  }
} else {
  throw new Error(`unknown mode ${mode}`);
}
