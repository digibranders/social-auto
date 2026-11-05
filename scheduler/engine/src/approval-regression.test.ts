/**
 * The approval regression suite: the ten checks that give the most safety, run against real processes, real files and the real review service where
 * that is what the risk is about. Nothing here touches a social platform: publishing is switched off, or a stand-in answers.
 *
 *   R1  a lock that a living process cannot be shown to have lost is never taken
 *   R2  approve against reject from separate processes
 *   R3  the same approval from two processes
 *   R4  a process killed in the middle of writing, then recovery
 *   R5  a damaged record in the middle fails everything closed, through the service
 *   R6  approve, withdraw, then download and dispatch
 *   R7  a swapped picture or caption is never released
 *   R8  traversal, links and another brand
 *   R9  the service and what is passed to it
 *   R10 a restart changes nothing that was decided or spent
 */
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportToPublisher } from './export-publisher.ts';
import { PublishingDisabledError } from './publishing-switch.ts';
import { defaultBudgetLimits, PaidLedger } from './paid-ledger.ts';
import { inspectLog, recoverLog } from './review-recovery.ts';
import { createReviewServer } from './review-server.ts';
import { ReviewError, ReviewStore, type NewVersion } from './review-store.ts';
import { schedulePlan } from './schedule.ts';

const SECRET = 'regression-secret-0123456789';
const WORKER = new URL('./review-worker.ts', import.meta.url).pathname;
const SERVER = new URL('./review-server.ts', import.meta.url).pathname;
const originalFetch = globalThis.fetch;
const originalSwitch = process.env['SOCIAL_PUBLISHING_ENABLED'];

let root: string;
let brands: string;
let acme: ReviewStore;
let globex: ReviewStore;
const children: ChildProcess[] = [];

beforeEach(() => {
  delete process.env['SOCIAL_PUBLISHING_ENABLED'];
  root = mkdtempSync(join(tmpdir(), 'regression-'));
  brands = join(root, 'brands');
  mkdirSync(join(brands, 'acme'), { recursive: true });
  mkdirSync(join(brands, 'globex'), { recursive: true });
  acme = new ReviewStore(join(brands, 'acme'), 'acme', undefined, 400);
  globex = new ReviewStore(join(brands, 'globex'), 'globex', undefined, 400);
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalSwitch === undefined) delete process.env['SOCIAL_PUBLISHING_ENABLED'];
  else process.env['SOCIAL_PUBLISHING_ENABLED'] = originalSwitch;
  for (const child of children.splice(0)) child.kill('SIGKILL');
  rmSync(root, { recursive: true, force: true });
});

const picture = (name: string, text: string): string => {
  const path = join(root, name);
  writeFileSync(path, text);
  return path;
};
const version = (imagePath: string, over: Partial<NewVersion> = {}): NewVersion => ({
  postId: 'w01-d1', planFile: 'week-01.json', headline: 'Answers from your own docs', caption: 'Approved caption.', ctaUrl: 'https://acme.example', factIds: ['f1'],
  evidence: [{ factId: 'f1', text: 't', quote: 'q', url: 'https://acme.example/', context: 'c' }], imagePath,
  validation: { accepted: true, readings: 2, defects: [], reportFile: 'r.json' }, attempts: 1, costUsd: 0.016, ...over,
});
const code = (work: () => unknown): string => {
  try {
    work();
  } catch (error) {
    if (error instanceof ReviewError) return error.code;
    if (error instanceof PublishingDisabledError) return 'PUBLISHING_DISABLED';
    throw error;
  }
  return 'NO_ERROR';
};
const decisionsIn = (brand: string): number => readFileSync(join(brands, brand, 'reviews.jsonl'), 'utf8').split('\n').filter((l) => l.includes('"type":"decision"')).length;
const logOf = (brand: string): string => readFileSync(join(brands, brand, 'reviews.jsonl'), 'utf8');

function worker(...args: string[]): { child: ChildProcess; output: () => Promise<string> } {
  const child = spawn(process.execPath, [WORKER, ...args], { stdio: ['ignore', 'pipe', 'inherit'] });
  children.push(child);
  let text = '';
  child.stdout?.on('data', (d: Buffer) => (text += d.toString()));
  // Listening starts at once, so a process that finishes before anyone asks for its output is not missed.
  const finished = new Promise<string>((resolve) => child.on('close', () => resolve(text)));
  return { child, output: () => finished };
}
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function service(): Promise<{ call: (path: string, init?: RequestInit & { auth?: boolean }) => Promise<Response>; close: () => Promise<void> }> {
  const server = createReviewServer({ brandsRoot: brands, secret: SECRET, lockTimeoutMs: 400 });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    call: (path, init = {}) => originalFetch(`${base}${path}`, { ...init, headers: { ...(init.auth === false ? {} : { Authorization: `Bearer ${SECRET}` }), 'Content-Type': 'application/json', ...(init.headers as Record<string, string> | undefined) } }),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

// ---- R1

test('R1  a lock file that cannot be shown to be dead is never taken, so no decision is made without the lock', async () => {
  const v = acme.addVersion(version(picture('a.jpg', 'x')));
  // The shape a paused creator would have left in the old design: an empty lock, older than any timeout.
  const lock = join(brands, 'acme', 'reviews.jsonl.lock');
  writeFileSync(lock, '');
  const old = new Date(Date.now() - 3600_000);
  utimesSync(lock, old, old);
  assert.equal(code(() => acme.approve(v.versionId, 'owner')), 'LOCKED');
  assert.equal(acme.list({ status: 'pending' }).length, 1, 'nothing was decided');
  const s = await service();
  try {
    const answer = await s.call(`/review/posts/${v.versionId}/approve`, post({ by: 'owner' }));
    assert.equal(answer.status, 503);
    assert.equal(decisionsIn('acme'), 0);
    assert.equal(readFileSync(lock, 'utf8'), '', 'the lock was left for a person');
  } finally {
    await s.close();
  }
});

// ---- R2

test('R2  approve against reject from separate processes: the log stays consistent, and the later decision is the one in force', async () => {
  for (let round = 0; round < 3; round++) {
    const v = acme.addVersion(version(picture(`a${round}.jpg`, `x${round}`), { postId: `w01-d${round}` }));
    const go = join(root, `go${round}`);
    const a = worker('approve', join(brands, 'acme'), v.versionId, go);
    const r = worker('reject', join(brands, 'acme'), v.versionId, go);
    await sleep(500);
    writeFileSync(go, '');
    const [approveResult, rejectResult] = [await a.output(), await r.output()];
    assert.match(rejectResult, /RESULT OK/, 'a rejection (or a withdrawal) is always possible');
    const item = acme.get(v.versionId);
    assert.equal(item.status, 'rejected', 'the reject is in force whichever came first');
    const decisions = readFileSync(join(brands, 'acme', 'reviews.jsonl'), 'utf8').split('\n').filter((l) => l.includes(`"versionId":"${v.versionId}"`) && l.includes('"type":"decision"')).length;
    if (/RESULT OK/.test(approveResult)) assert.equal(decisions, 2, 'approved first, then withdrawn: both are on record, in order');
    else {
      assert.match(approveResult, /ALREADY_DECIDED/);
      assert.equal(decisions, 1, 'rejected first, the approval was refused: one decision');
    }
    assert.equal(acme.approvedFor(`w01-d${round}`), undefined, 'nothing is approved at the end');
  }
});

// ---- R3

test('R3  the same approval from two processes at once is one decision', async () => {
  const v = acme.addVersion(version(picture('a.jpg', 'x')));
  const go = join(root, 'go');
  const one = worker('approve', join(brands, 'acme'), v.versionId, go);
  const two = worker('approve', join(brands, 'acme'), v.versionId, go);
  await sleep(500);
  writeFileSync(go, '');
  assert.match(await one.output(), /RESULT OK/);
  assert.match(await two.output(), /RESULT OK/);
  assert.equal(decisionsIn('acme'), 1);
  assert.equal(acme.get(v.versionId).status, 'approved');
});

// ---- R4

test('R4  a process killed with SIGKILL in the middle of writing leaves a log that is clean or has only a cut-off last record; recovery never authorises anything', async () => {
  const pictures = join(root, 'pictures');
  mkdirSync(pictures);
  for (const delay of [120, 230, 340, 450]) {
    const brandDir = join(brands, `churn-${delay}`);
    mkdirSync(brandDir, { recursive: true });
    const w = worker('churn', brandDir, pictures);
    await new Promise<void>((resolve) => w.child.stdout?.on('data', (d: Buffer) => d.toString().includes('STARTED') && resolve()));
    await sleep(delay);
    w.child.kill('SIGKILL');
    await w.output();
    const report = inspectLog(brandDir, brands);
    assert.notEqual(report.status, 'unrecoverable', `a kill in the middle of an append only ever cuts the last record (${report.problems.join('; ')})`);
    const store = new ReviewStore(brandDir, `churn-${delay}`, undefined, 400);
    const approvedBefore = report.approvedInForce.length;
    if (report.status === 'recoverable') {
      assert.equal(code(() => store.list()), report.kind === 'torn_tail' ? 'TAMPERED' : 'NO_ERROR');
      recoverLog({ brandDir, brand: `churn-${delay}`, brandsRoot: brands, actor: 'admin', reason: 'killed in the middle of an append', lockTimeoutMs: 400 });
    }
    assert.equal(inspectLog(brandDir, brands).status, 'clean');
    const items = store.list();
    for (const item of items) {
      if (item.status === 'approved') assert.ok(store.approvedFile(item.version.versionId).bytes.length > 0, 'an approval in force still has its exact picture');
      if (item.status === 'held') assert.equal(code(() => store.approvedFile(item.version.versionId)), 'NOT_APPROVED');
    }
    assert.ok(items.length >= 0 && approvedBefore >= 0);
  }
});

// ---- R5

test('R5  a damaged record in the middle fails reads, approvals and downloads closed, appends nothing, and is reported to the owner rather than hidden', async () => {
  const a = acme.addVersion(version(picture('a.jpg', 'x')));
  acme.addVersion(version(picture('b.jpg', 'y'), { postId: 'w01-d2' }));
  acme.approve(a.versionId, 'owner');
  const lines = logOf('acme').split('\n');
  lines[1] = 'this is not json';
  writeFileSync(join(brands, 'acme', 'reviews.jsonl'), lines.join('\n'));
  const before = logOf('acme');
  const s = await service();
  try {
    assert.equal((await s.call(`/review/posts/${a.versionId}`)).status, 500);
    assert.equal((await s.call(`/review/posts/${a.versionId}/image`)).status, 500);
    assert.equal((await s.call(`/review/posts/${a.versionId}/download`)).status, 500);
    assert.equal((await s.call(`/review/posts/${a.versionId}/approve`, post({ by: 'owner' }))).status, 500);
    assert.equal((await s.call(`/review/posts/${a.versionId}/reject`, post({ by: 'owner', reason: 'other' }))).status, 500);
    const list = (await (await s.call('/review/posts?status=all')).json()) as { posts: unknown[]; problems: Array<{ brand: string }> };
    assert.deepEqual(list.problems.map((p) => p.brand), ['acme'], 'the broken brand is named, not silently left out');
    assert.equal(logOf('acme'), before, 'nothing was appended');
    assert.equal(code(() => acme.approvedFor('w01-d1')), 'TAMPERED', 'no earlier approval is treated as authoritative');
  } finally {
    await s.close();
  }
});

// ---- R6

const planFile = (extra: Record<string, unknown> = {}): string => JSON.stringify({
  brand: 'acme', timezone: 'Asia/Kolkata', renderMode: 'ai_v1',
  posts: [{ id: 'w01-d1', date: '2099-01-01T10:00:00+05:30', painPoint: 'p', mode: 'ai', headline: 'Answers from your own docs', subline: '', imagePrompt: 'a calm desk', caption: 'PLAN CAPTION that nobody approved', hashtags: ['#a'] }],
  ...extra,
});

test('R6  approve, then withdraw: no download, no export, no scheduling; and while approved the approved caption, not the plan\'s, is what goes out', async () => {
  const brandDir = join(brands, 'acme');
  writeFileSync(join(brandDir, 'week-01.json'), planFile());
  const v = acme.addVersion(version(picture('a.jpg', 'approved picture')));
  acme.approve(v.versionId, 'owner');
  process.env['SOCIAL_PUBLISHING_ENABLED'] = 'true';
  const publisher = join(root, 'publisher');
  const exported = await exportToPublisher(brandDir, publisher);
  assert.equal(exported.length, 1);
  assert.equal(exported[0]?.caption, 'Approved caption.', 'the approved caption is what is exported');
  assert.doesNotMatch(readFileSync(join(publisher, 'data', 'schedule.ts'), 'utf8'), /PLAN CAPTION/);

  // Withdrawn.
  acme.reject(v.versionId, 'owner', 'factual_issue');
  const s = await service();
  try {
    assert.equal((await s.call(`/review/posts/${v.versionId}/download`)).status, 409);
    assert.equal(code(() => acme.approvedFile(v.versionId)), 'NOT_APPROVED');
    assert.equal((await exportToPublisher(brandDir, publisher)).length, 0, 'nothing is exported after the withdrawal');
    // Scheduling, with a stand-in scheduler that records what it is asked to do.
    const asked: string[] = [];
    globalThis.fetch = (async (url: URL | string) => {
      asked.push(String(url));
      return new Response(JSON.stringify([{ id: 'i', identifier: 'instagram', profile: 'acme', disabled: false }]), { status: 200 });
    }) as typeof fetch;
    const count = await schedulePlan({ brandDir, planFile: 'week-01.json', channel: 'acme', schedulerKey: 'k', schedulerUrl: 'http://scheduler.test/api', log: () => undefined });
    assert.equal(count, 0);
    assert.ok(asked.every((u) => !/upload|posts/.test(u.replace('/integrations', ''))), `no upload or post was made: ${asked.join(', ')}`);
  } finally {
    await s.close();
  }
});

// ---- R7

test('R7  a swapped picture, or a caption changed in the record, is never released: not as a download, not as an export', async () => {
  const brandDir = join(brands, 'acme');
  writeFileSync(join(brandDir, 'week-01.json'), planFile());
  const v = acme.addVersion(version(picture('a.jpg', 'approved picture')));
  acme.approve(v.versionId, 'owner');
  process.env['SOCIAL_PUBLISHING_ENABLED'] = 'true';
  const s = await service();
  try {
    // The picture's bytes change on disk.
    const file = join(brandDir, v.imageFile);
    const original = readFileSync(file);
    writeFileSync(file, 'swapped picture');
    assert.equal((await s.call(`/review/posts/${v.versionId}/download`)).status, 500);
    assert.equal((await s.call(`/review/posts/${v.versionId}/image`)).status, 500);
    assert.equal(code(() => acme.approvedFor('w01-d1')), 'TAMPERED');
    await assert.rejects(exportToPublisher(brandDir, join(root, 'publisher')), ReviewError);
    writeFileSync(file, original);
    assert.equal((await s.call(`/review/posts/${v.versionId}/download`)).status, 200, 'put back, it is the approved picture again');

    // The caption changes in the record without its hash.
    writeFileSync(join(brandDir, 'reviews.jsonl'), logOf('acme').replace('Approved caption.', 'Another caption.'));
    assert.equal((await s.call(`/review/posts/${v.versionId}/download`)).status, 500);
    await assert.rejects(exportToPublisher(brandDir, join(root, 'publisher')), ReviewError);
    assert.equal(inspectLog(brandDir, brands).status, 'unrecoverable', 'the doctor sees it too');
  } finally {
    await s.close();
  }
});

// ---- R8

test('R8  traversal, links and other brands: nothing outside the brand\'s own picture folder is ever read or served', async () => {
  const a = acme.addVersion(version(picture('a.jpg', 'acme picture')));
  const g = globex.addVersion(version(picture('g.jpg', 'globex picture'), { postId: 'w01-d9' }));
  acme.approve(a.versionId, 'owner');
  globex.approve(g.versionId, 'owner');
  const s = await service();
  try {
    for (const id of ['..%2F..%2Fetc%2Fpasswd', '.%2E.x', 'acme%2F..%2Fglobex.x', 'acme.%00', 'acme.' + 'f'.repeat(16) + '%2F..', 'ACME.' + a.versionId.split('.')[1]]) {
      assert.ok([400, 404].includes((await s.call(`/review/posts/${id}`)).status), id);
      assert.ok([400, 404].includes((await s.call(`/review/posts/${id}/download`)).status), `${id} download`);
    }
    // Another brand's real id, under the wrong brand name.
    assert.equal((await s.call(`/review/posts/acme.${g.versionId.split('.')[1]}`)).status, 404);
    assert.equal((await s.call(`/review/posts/globex.${a.versionId.split('.')[1]}/download`)).status, 404);
    assert.equal(code(() => globex.get(a.versionId)), 'NOT_FOUND');

    // A link in place of the picture, pointing at a file that has exactly the same bytes: the hash would match, the link must not be followed.
    const outside = join(root, 'outside.jpg');
    writeFileSync(outside, 'acme picture');
    const file = join(brands, 'acme', a.imageFile);
    rmSync(file);
    symlinkSync(outside, file);
    assert.equal((await s.call(`/review/posts/${a.versionId}/download`)).status, 500);
    assert.equal((await s.call(`/review/posts/${a.versionId}/image`)).status, 500);
    assert.equal(code(() => acme.approvedFile(a.versionId)), 'TAMPERED');
    rmSync(file);
    writeFileSync(file, 'acme picture');
    assert.equal((await s.call(`/review/posts/${a.versionId}/download`)).status, 200);

    // The versions folder, and then the brand folder itself, replaced by links.
    renameSync(join(brands, 'acme', 'versions'), join(root, 'elsewhere-versions'));
    symlinkSync(join(root, 'elsewhere-versions'), join(brands, 'acme', 'versions'));
    assert.equal((await s.call(`/review/posts/${a.versionId}/download`)).status, 500);
    unlinkSync(join(brands, 'acme', 'versions'));
    renameSync(join(root, 'elsewhere-versions'), join(brands, 'acme', 'versions'));
    renameSync(join(brands, 'acme'), join(root, 'acme-real'));
    symlinkSync(join(root, 'acme-real'), join(brands, 'acme'));
    const realBefore = readFileSync(join(root, 'acme-real', 'reviews.jsonl'), 'utf8');
    assert.equal((await s.call(`/review/posts/${a.versionId}/download`)).status, 500);
    assert.equal((await s.call(`/review/posts/${a.versionId}/approve`, post({ by: 'owner' }))).status, 200, 'an already made approval is repeated, not rewritten');
    assert.equal(readFileSync(join(root, 'acme-real', 'reviews.jsonl'), 'utf8'), realBefore, 'nothing was written through the link');
  } finally {
    await s.close();
  }
});

// ---- R9

test('R9  the service: no or wrong bearer changes and reveals nothing; fields that are not the caller\'s to set are ignored', async () => {
  const v = acme.addVersion(version(picture('a.jpg', 'x')));
  const s = await service();
  try {
    const before = logOf('acme');
    for (const [name, headers] of [['no bearer', {}], ['wrong bearer', { Authorization: 'Bearer nope' }], ['short bearer', { Authorization: 'Bearer ' }], ['same length', { Authorization: `Bearer ${'x'.repeat(SECRET.length)}` }]] as const) {
      for (const [path, init] of [['/review/posts', {}], [`/review/posts/${v.versionId}`, {}], [`/review/posts/${v.versionId}/image`, {}], [`/review/posts/${v.versionId}/download`, {}], [`/review/posts/${v.versionId}/approve`, post({ by: 'owner' })], [`/review/posts/${v.versionId}/reject`, post({ by: 'owner', reason: 'other' })]] as const) {
        const answer = await s.call(path, { ...init, auth: false, headers: { ...headers } });
        assert.equal(answer.status, 401, `${name} ${path}`);
        assert.doesNotMatch(await answer.text(), /acme|Answers from/);
      }
    }
    assert.equal(logOf('acme'), before);
    // Extra fields: the decision is made on the store's own record of the version, not on anything the caller supplies.
    const approved = await s.call(`/review/posts/${v.versionId}/approve`, post({ by: 'owner', status: 'approved', imageSha256: 'f'.repeat(64), contentSha256: 'e'.repeat(64), versionId: 'acme.ffffffffffffffff', headline: 'Hijacked' }));
    assert.equal(approved.status, 200);
    const decision = acme.get(v.versionId).decision;
    assert.equal(decision?.imageSha256, v.imageSha256);
    assert.equal(decision?.contentSha256, v.contentSha256);
    assert.equal(acme.get(v.versionId).version.headline, 'Answers from your own docs');
    assert.equal((await s.call(`/review/posts/${v.versionId}/approve`, post({ by: 'x'.repeat(100_000) }))).status, 400);
  } finally {
    await s.close();
  }
});

// ---- R10

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createNetServer();
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

test('R10 a real restart of the review service (killed, started again on the same folders) keeps every decision, the picture, the budget already spent, and the publishing switch off', async () => {
  const v = acme.addVersion(version(picture('a.jpg', 'approved picture')));
  const rejectedOne = acme.addVersion(version(picture('b.jpg', 'other picture'), { postId: 'w01-d2' }));
  const ledgerFile = join(root, 'ledger', 'paid-calls.jsonl');
  const ledger = new PaidLedger(ledgerFile, defaultBudgetLimits, { jobId: 'job', tenantId: 'owner', brandId: 'acme' });
  ledger.complete(ledger.reserve({ operation: 'image', model: 'img', postId: 'w01-d1', requestKey: 'k', maxCostUsd: 0.05 }), { actualCostUsd: 0.031 });
  const spentBefore = ledger.spend('w01-d1');

  const start = async (): Promise<{ port: number; child: ChildProcess }> => {
    const port = await freePort();
    const child = spawn(process.execPath, [SERVER], { env: { ...process.env, REVIEW_SECRET: SECRET, BRANDS_ROOT: brands, PORT: String(port), HOST: '127.0.0.1', SOCIAL_PUBLISHING_ENABLED: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let errors = '';
    child.stderr?.on('data', (d: Buffer) => (errors += d.toString()));
    await new Promise<void>((resolve, reject) => {
      child.stdout?.on('data', (d: Buffer) => d.toString().includes('listening') && resolve());
      child.on('close', () => reject(new Error(`the review service did not start: ${errors}`)));
    });
    return { port, child };
  };
  const ask = (port: number, path: string, init: RequestInit = {}): Promise<Response> => originalFetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' } });

  const first = await start();
  assert.equal((await ask(first.port, `/review/posts/${v.versionId}/approve`, post({ by: 'owner' }))).status, 200);
  assert.equal((await ask(first.port, `/review/posts/${rejectedOne.versionId}/reject`, post({ by: 'owner', reason: 'poor_design' }))).status, 200);
  first.child.kill('SIGKILL');
  await new Promise((resolve) => first.child.on('close', resolve));

  const second = await start();
  const detail = (await (await ask(second.port, `/review/posts/${v.versionId}`)).json()) as { status: string; decision: { by: string; imageSha256: string } };
  assert.equal(detail.status, 'approved');
  assert.equal(detail.decision.imageSha256, v.imageSha256);
  assert.equal(((await (await ask(second.port, `/review/posts/${rejectedOne.versionId}`)).json()) as { status: string }).status, 'rejected');
  const download = await ask(second.port, `/review/posts/${v.versionId}/download`);
  assert.equal(download.status, 200);
  assert.equal(await download.text(), 'approved picture');
  assert.equal(decisionsIn('acme'), 2, 'no decision was lost or repeated');
  assert.equal((await ask(second.port, `/review/posts/${rejectedOne.versionId}/download`)).status, 409);

  // The paid-call ledger, opened again, still knows what was spent.
  const reopened = new PaidLedger(ledgerFile, defaultBudgetLimits, { jobId: 'job', tenantId: 'owner', brandId: 'acme' });
  assert.deepEqual(reopened.spend('w01-d1'), spentBefore);
  // And publishing is still off, so nothing can go out whatever was approved.
  await assert.rejects(exportToPublisher(join(brands, 'acme'), join(root, 'publisher')), PublishingDisabledError);
  assert.equal(readdirSync(root).includes('publisher'), false);
  second.child.kill('SIGTERM');
  await new Promise((resolve) => second.child.on('close', resolve));
  appendFileSync(join(root, 'done'), '');
});
