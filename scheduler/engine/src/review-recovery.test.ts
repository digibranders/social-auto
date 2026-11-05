import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { main } from './review-admin.ts';
import { inspectLog, recoverLog, RecoveryRefused } from './review-recovery.ts';
import { ReviewError, ReviewStore, type NewVersion } from './review-store.ts';

function setup(): { root: string; brandsRoot: string; brandDir: string; store: ReviewStore; picture: (name: string, text: string) => string; log: () => string; done: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'recovery-'));
  const brandsRoot = join(root, 'brands');
  const brandDir = join(brandsRoot, 'acme');
  mkdirSync(brandDir, { recursive: true });
  return {
    root, brandsRoot, brandDir, store: new ReviewStore(brandDir, 'acme'),
    picture: (name, text) => { const p = join(root, name); writeFileSync(p, text); return p; },
    log: () => readFileSync(join(brandDir, 'reviews.jsonl'), 'utf8'),
    done: () => rmSync(root, { recursive: true, force: true }),
  };
}

const version = (imagePath: string, over: Partial<NewVersion> = {}): NewVersion => ({
  postId: 'w01-d1', planFile: 'week-01.json', headline: 'Answers from your own docs', caption: 'Caption.', ctaUrl: 'https://acme.example', factIds: ['f1'],
  evidence: [{ factId: 'f1', text: 't', quote: 'q', url: 'https://acme.example/', context: 'c' }], imagePath,
  validation: { accepted: true, readings: 2, defects: [], reportFile: 'r.json' }, attempts: 1, costUsd: 0.016, ...over,
});

const code = (work: () => unknown): string => {
  try {
    work();
  } catch (error) {
    if (error instanceof ReviewError) return error.code;
    if (error instanceof RecoveryRefused) return error.code;
    throw error;
  }
  return 'NO_ERROR';
};

const recover = (s: ReturnType<typeof setup>, over: { actor?: string; reason?: string } = {}) => recoverLog({ brandDir: s.brandDir, brand: 'acme', brandsRoot: s.brandsRoot, actor: over.actor ?? 'admin', reason: over.reason ?? 'Interrupted append', lockTimeoutMs: 300 });

test('a clean log has nothing to recover, and the doctor says so without changing anything', () => {
  const s = setup();
  try {
    const v = s.store.addVersion(version(s.picture('a.jpg', 'x')));
    s.store.approve(v.versionId, 'owner');
    const before = s.log();
    const report = inspectLog(s.brandDir);
    assert.equal(report.status, 'clean');
    assert.deepEqual(report.approvedInForce, [v.versionId]);
    assert.equal(code(() => recover(s)), 'NOTHING_TO_RECOVER');
    assert.equal(s.log(), before);
  } finally {
    s.done();
  }
});

test('a torn approval: reads fail closed first; recovery keeps the valid prefix and the cut-off bytes, authorises nothing, and the poster stays pending', () => {
  const s = setup();
  try {
    const v = s.store.addVersion(version(s.picture('a.jpg', 'x')));
    const prefix = s.log();
    appendFileSync(join(s.brandDir, 'reviews.jsonl'), '{"type":"decision","decision":{"versionId":"' + v.versionId + '","decision":"appro');
    assert.equal(code(() => s.store.get(v.versionId)), 'TAMPERED');
    assert.equal(code(() => s.store.approve(v.versionId, 'owner')), 'TAMPERED');
    const report = inspectLog(s.brandDir);
    assert.equal(report.status, 'recoverable');
    assert.equal(report.kind, 'torn_tail');
    const result = recover(s);
    assert.equal(result.record.kind, 'torn_tail');
    assert.equal(result.record.quarantinedBytes > 0, true);
    assert.equal(readFileSync(join(result.evidenceDir, 'torn-tail.bin'), 'utf8').startsWith('{"type":"decision"'), true);
    assert.equal(readFileSync(join(result.evidenceDir, 'reviews.jsonl.original'), 'utf8').startsWith(prefix), true);
    for (const name of ['reviews.jsonl.original', 'torn-tail.bin', 'report.json']) assert.equal((statSync(join(result.evidenceDir, name)).mode & 0o222), 0, `${name} is read-only`);
    assert.equal(s.store.get(v.versionId).status, 'pending', 'the lost approval did not come back as an approval or a rejection');
    assert.equal(code(() => s.store.approvedFile(v.versionId)), 'NOT_APPROVED');
    assert.match(s.log(), /"type":"recovery"/);
    assert.equal(inspectLog(s.brandDir).status, 'clean');
  } finally {
    s.done();
  }
});

test('a torn WITHDRAWAL must not bring the approval back: the approval is held, nothing is downloadable, and only a new explicit approval releases it', () => {
  const s = setup();
  try {
    const v = s.store.addVersion(version(s.picture('a.jpg', 'picture')));
    s.store.approve(v.versionId, 'owner');
    appendFileSync(join(s.brandDir, 'reviews.jsonl'), '{"type":"decision","decision":{"versionId":"' + v.versionId + '","decision":"reject","by":"owner","at":"2026-11-05T1');
    const result = recover(s);
    assert.deepEqual(result.record.heldVersionIds, [v.versionId]);
    const held = s.store.get(v.versionId);
    assert.equal(held.status, 'held');
    assert.equal(held.decision?.decision, 'approve', 'the earlier approval is still on record');
    assert.equal(code(() => s.store.approvedFile(v.versionId)), 'NOT_APPROVED');
    assert.equal(s.store.approvedFor('w01-d1'), undefined);
    assert.equal(s.store.list({ status: 'approved' }).length, 0);
    // The owner confirms the exact version again.
    s.store.approve(v.versionId, 'owner');
    assert.equal(s.store.get(v.versionId).status, 'approved');
    assert.equal(readFileSync(s.store.approvedFile(v.versionId).path, 'utf8'), 'picture');
  } finally {
    s.done();
  }
});

test('a held approval can also be rejected instead of confirmed', () => {
  const s = setup();
  try {
    const v = s.store.addVersion(version(s.picture('a.jpg', 'x')));
    s.store.approve(v.versionId, 'owner');
    appendFileSync(join(s.brandDir, 'reviews.jsonl'), '{"type":"dec');
    recover(s);
    s.store.reject(v.versionId, 'owner', 'other', 'after the repair');
    assert.equal(s.store.get(v.versionId).status, 'rejected');
  } finally {
    s.done();
  }
});

test('a complete last record that only lacks its line ending is kept as written, with nothing held', () => {
  const s = setup();
  try {
    const v = s.store.addVersion(version(s.picture('a.jpg', 'x')));
    s.store.approve(v.versionId, 'owner');
    writeFileSync(join(s.brandDir, 'reviews.jsonl'), s.log().replace(/\n$/, ''));
    assert.equal(inspectLog(s.brandDir).kind, 'missing_newline');
    const result = recover(s);
    assert.equal(result.record.kind, 'missing_newline');
    assert.deepEqual(result.record.heldVersionIds, []);
    assert.equal(s.store.get(v.versionId).status, 'approved');
  } finally {
    s.done();
  }
});

test('damage in the middle of the log is refused, and the log is left exactly as it was', () => {
  const s = setup();
  try {
    const a = s.store.addVersion(version(s.picture('a.jpg', 'x')));
    s.store.addVersion(version(s.picture('b.jpg', 'y'), { postId: 'w01-d2' }));
    s.store.approve(a.versionId, 'owner');
    const lines = s.log().split('\n');
    lines[1] = 'this is not json';
    writeFileSync(join(s.brandDir, 'reviews.jsonl'), lines.join('\n'));
    const before = s.log();
    const report = inspectLog(s.brandDir);
    assert.equal(report.status, 'unrecoverable');
    assert.equal(code(() => recover(s)), 'UNRECOVERABLE');
    assert.equal(s.log(), before);
    assert.equal(existsRecovery(s.brandDir), false, 'no evidence folder was made for a refused recovery');
    assert.equal(code(() => s.store.list()), 'TAMPERED');
  } finally {
    s.done();
  }
});

const existsRecovery = (brandDir: string): boolean => {
  try {
    return readdirSync(join(brandDir, 'recovery')).length > 0;
  } catch {
    return false;
  }
};

test('a picture or text that no longer matches its hash is refused: that is not a cut-off tail', () => {
  const s = setup();
  try {
    const v = s.store.addVersion(version(s.picture('a.jpg', 'x')));
    appendFileSync(join(s.brandDir, 'reviews.jsonl'), '{"type":"dec');
    writeFileSync(join(s.brandDir, v.imageFile), 'swapped');
    const before = s.log();
    assert.equal(code(() => recover(s)), 'UNRECOVERABLE');
    assert.equal(s.log(), before);
  } finally {
    s.done();
  }
});

test('a record that makes no sense (a decision about a version that is not there, a version twice) is refused', () => {
  const s = setup();
  try {
    s.store.addVersion(version(s.picture('a.jpg', 'x')));
    const stray = { type: 'decision', decision: { versionId: 'acme.ffffffffffffffff', decision: 'approve', by: 'owner', at: 'now', imageSha256: 'a', contentSha256: 'b' } };
    appendFileSync(join(s.brandDir, 'reviews.jsonl'), `${JSON.stringify(stray)}\n{"type":"dec`);
    const report = inspectLog(s.brandDir);
    assert.equal(report.status, 'unrecoverable');
    assert.ok(report.problems.some((p) => /does not exist/.test(p)));
  } finally {
    s.done();
  }
});

test('nothing is repaired while a writer might be active: a live store lock, the running review service, or a damaged lock', async () => {
  const s = setup();
  try {
    const v = s.store.addVersion(version(s.picture('a.jpg', 'x')));
    appendFileSync(join(s.brandDir, 'reviews.jsonl'), '{"type":"dec');
    const before = s.log();
    const worker = new URL('./lock-worker.ts', import.meta.url).pathname;
    // A live process holds the store's lock.
    const holder = spawn(process.execPath, [worker, 'hold', join(s.brandDir, 'reviews.jsonl.lock'), '2000'], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((resolve) => holder.stdout?.on('data', (d: Buffer) => d.toString().includes('HELD') && resolve()));
    assert.equal(code(() => recover(s)), 'WRITER_ACTIVE');
    await new Promise((resolve) => holder.on('close', resolve));
    // The review service is running (its process-lifetime lock is held).
    const service = spawn(process.execPath, [worker, 'hold', join(s.brandsRoot, '.review-service.lock'), '2000'], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((resolve) => service.stdout?.on('data', (d: Buffer) => d.toString().includes('HELD') && resolve()));
    assert.equal(code(() => recover(s)), 'WRITER_ACTIVE');
    await new Promise((resolve) => service.on('close', resolve));
    // A damaged lock is not guessed at.
    writeFileSync(join(s.brandsRoot, '.review-service.lock'), '');
    assert.equal(code(() => recover(s)), 'WRITER_ACTIVE');
    assert.equal(s.log(), before, 'nothing was changed by any refused attempt');
    assert.equal(existsRecovery(s.brandDir), false);
    void v;
  } finally {
    s.done();
  }
});

test('a recovery needs who and why, and a second recovery of an already repaired log has nothing to do', () => {
  const s = setup();
  try {
    s.store.addVersion(version(s.picture('a.jpg', 'x')));
    appendFileSync(join(s.brandDir, 'reviews.jsonl'), '{"type":"dec');
    assert.equal(code(() => recover(s, { actor: ' ' })), 'INVALID');
    assert.equal(code(() => recover(s, { reason: 'x' })), 'INVALID');
    recover(s);
    assert.equal(code(() => recover(s)), 'NOTHING_TO_RECOVER');
    const record = (JSON.parse(s.log().trim().split('\n').at(-1) as string) as { recovery: { actor: string; reason: string; originalSha256: string; repairedSha256: string } }).recovery;
    assert.equal(record.actor, 'admin');
    assert.equal(record.reason, 'Interrupted append');
    assert.notEqual(record.originalSha256, record.repairedSha256);
  } finally {
    s.done();
  }
});

test('the command line: doctor changes nothing; recover asks for confirmation, refuses without it, and holds the approvals', async () => {
  const s = setup();
  try {
    const v = s.store.addVersion(version(s.picture('a.jpg', 'x')));
    s.store.approve(v.versionId, 'owner');
    appendFileSync(join(s.brandDir, 'reviews.jsonl'), '{"type":"decision","decision":{"versionId":"' + v.versionId + '","decision":"rej');
    const before = s.log();
    const out: string[] = [];
    const io = (answer: string) => ({ out: (line: string) => void out.push(line), confirm: async () => answer });
    assert.equal(await main(['doctor', '--brand-dir', s.brandDir], io('')), 2);
    assert.match(out.join('\n'), /recoverable \(torn_tail\)/);
    assert.equal(s.log(), before);
    assert.equal(await main(['recover', '--brand-dir', s.brandDir, '--actor', 'admin'], io('')), 1, 'no reason given');
    assert.equal(await main(['recover', '--brand-dir', s.brandDir, '--actor', 'admin', '--reason', 'crash during append'], io('yes please')), 3, 'wrong confirmation');
    assert.equal(s.log(), before);
    out.length = 0;
    assert.equal(await main(['recover', '--brand-dir', s.brandDir, '--actor', 'admin', '--reason', 'crash during append'], io('RECOVER acme')), 0);
    assert.match(out.join('\n'), /Held until confirmed again: acme\./);
    assert.equal(s.store.get(v.versionId).status, 'held');
    assert.equal(await main(['doctor', '--brand-dir', s.brandDir], io('')), 0);
    assert.equal(await main(['bogus'], io('')), 1);
  } finally {
    s.done();
  }
});

test('the real command: usage without arguments, and a refusal exits non-zero', async () => {
  const s = setup();
  try {
    const script = new URL('./review-admin.ts', import.meta.url).pathname;
    const run = (...args: string[]) => promisify(execFile)(process.execPath, [script, ...args]).then((r) => ({ code: 0, out: String(r.stdout) }), (e: { code: number; stdout: string }) => ({ code: e.code, out: String(e.stdout) }));
    assert.equal((await run()).code, 1);
    s.store.addVersion(version(s.picture('a.jpg', 'x')));
    const refused = await run('recover', '--brand-dir', s.brandDir, '--actor', 'admin', '--reason', 'nothing wrong here', '--yes');
    assert.equal(refused.code, 3);
    assert.match(refused.out, /NOTHING_TO_RECOVER/);
  } finally {
    s.done();
  }
});

test('the held status is part of the review queue the dashboard reads', () => {
  const s = setup();
  try {
    const v = s.store.addVersion(version(s.picture('a.jpg', 'x')));
    s.store.approve(v.versionId, 'owner');
    appendFileSync(join(s.brandDir, 'reviews.jsonl'), '{"type":"dec');
    recover(s);
    assert.deepEqual(s.store.list({ status: 'held' }).map((i) => i.version.versionId), [v.versionId]);
  } finally {
    s.done();
  }
});
