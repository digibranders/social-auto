/**
 * The dashboard's review API against the real review service (the engine's, running on a local port), not a stand-in: the whole chain from a request
 * in the browser to a decision in the log. Signed-out and foreign-origin requests change nothing; a good one makes exactly one decision; fields the
 * caller should not control are not passed on; a held picture is not downloadable.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReviewServer } from '../../scheduler/engine/src/review-server.ts';
import { ReviewStore } from '../../scheduler/engine/src/review-store.ts';
import { createSession, SESSION_COOKIE } from '../lib/security.ts';
import { GET, POST } from '../api/review.ts';

let root: string;
let store: ReviewStore;
let versionId: string;
let close: () => Promise<void>;

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'dash-review-'));
  const brandDir = join(root, 'brands', 'acme');
  mkdirSync(brandDir, { recursive: true });
  store = new ReviewStore(brandDir, 'acme', undefined, 400);
  writeFileSync(join(root, 'p.jpg'), 'picture bytes');
  versionId = store.addVersion({
    postId: 'w01-d1', planFile: 'week-01.json', headline: 'Answers from your own docs', caption: 'Caption.', ctaUrl: 'https://acme.example', factIds: ['f1'],
    evidence: [{ factId: 'f1', text: 't', quote: 'q', url: 'https://acme.example/', context: 'c' }], imagePath: join(root, 'p.jpg'),
    validation: { accepted: true, readings: 2, defects: [], reportFile: 'r.json' }, attempts: 1, costUsd: 0.016,
  }).versionId;
  const server = createReviewServer({ brandsRoot: join(root, 'brands'), secret: 'integration-secret-0123456789', lockTimeoutMs: 400 });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env['REVIEW_URL'] = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env['REVIEW_SECRET'] = 'integration-secret-0123456789';
  process.env['SESSION_SECRET'] = 'session-secret';
  close = () => new Promise((resolve) => server.close(() => resolve()));
});
after(async () => {
  await close();
  rmSync(root, { recursive: true, force: true });
});

const cookie = (): string => `${SESSION_COOKIE}=${createSession('session-secret', Date.now())}`;
const get = (query: string, signedIn = true): Request => new Request(`https://dash.example/api/review?${query}`, { headers: signedIn ? { cookie: cookie() } : {} });
const write = (body: unknown, over: { signedIn?: boolean; origin?: string | null } = {}): Request => new Request('https://dash.example/api/review', {
  method: 'POST',
  headers: { 'content-type': 'application/json', host: 'dash.example', ...(over.signedIn === false ? {} : { cookie: cookie() }), ...(over.origin === null ? {} : { origin: over.origin ?? 'https://dash.example' }) },
  body: JSON.stringify(body),
});
const decisions = (): number => readFileSync(join(root, 'brands', 'acme', 'reviews.jsonl'), 'utf8').split('\n').filter((l) => l.includes('"type":"decision"')).length;

test('signed out, foreign origin, null origin and no origin change nothing, and read nothing', async () => {
  assert.equal((await GET(get('view=list', false))).status, 401);
  assert.equal((await GET(get(`view=image&id=${versionId}`, false))).status, 401);
  assert.equal((await POST(write({ id: versionId, action: 'approve' }, { signedIn: false }))).status, 401);
  for (const origin of ['https://evil.example', 'null', null]) assert.equal((await POST(write({ id: versionId, action: 'approve' }, { origin }))).status, 403, String(origin));
  assert.equal(decisions(), 0);
  assert.equal(store.get(versionId).status, 'pending');
});

test('a download is refused until approved; a good approval makes one decision, repeats make none, and extra fields change nothing', async () => {
  assert.equal((await GET(get(`view=download&id=${versionId}`))).status, 409);
  const approved = await POST(write({ id: versionId, action: 'approve', by: 'someone else', status: 'approved', imageSha256: 'f'.repeat(64), headline: 'Hijacked' }));
  assert.equal(approved.status, 200);
  assert.equal((await POST(write({ id: versionId, action: 'approve' }))).status, 200);
  assert.equal(decisions(), 1);
  const decision = store.get(versionId).decision;
  assert.equal(decision?.by, 'owner', 'the reviewer is the signed-in owner, not what the caller wrote');
  const download = await GET(get(`view=download&id=${versionId}`));
  assert.equal(download.status, 200);
  assert.equal(await download.text(), 'picture bytes');
});

test('a withdrawn approval is no longer downloadable through the dashboard', async () => {
  const rejected = await POST(write({ id: versionId, action: 'reject', reason: 'factual_issue', comment: 'wrong date' }));
  assert.equal(rejected.status, 200);
  assert.equal((await GET(get(`view=download&id=${versionId}`))).status, 409);
  assert.equal(store.get(versionId).status, 'rejected');
});
