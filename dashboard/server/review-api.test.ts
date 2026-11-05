import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { createSession, SESSION_COOKIE } from '../lib/security.ts';
import { GET, POST } from '../api/review.ts';

const ID = 'acme.0123456789abcdef';
const originalFetch = globalThis.fetch;
let calls: Array<{ url: string; init: RequestInit }> = [];

beforeEach(() => {
  process.env['SESSION_SECRET'] = 'session-secret';
  process.env['REVIEW_URL'] = 'http://127.0.0.1:4012';
  process.env['REVIEW_SECRET'] = 'review-secret-0123456789';
  calls = [];
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const cookie = (): string => `${SESSION_COOKIE}=${createSession('session-secret', Date.now())}`;
const get = (query: string, signedIn = true): Request => new Request(`https://dash.example/api/review?${query}`, { headers: signedIn ? { cookie: cookie() } : {} });
const post = (body: unknown, over: { signedIn?: boolean; origin?: string | null } = {}): Request => new Request('https://dash.example/api/review', {
  method: 'POST',
  headers: { 'content-type': 'application/json', host: 'dash.example', ...(over.signedIn === false ? {} : { cookie: cookie() }), ...(over.origin === null ? {} : { origin: over.origin ?? 'https://dash.example' }) },
  body: JSON.stringify(body),
});

function upstream(status: number, body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }): void {
  globalThis.fetch = (async (url: URL | string, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
  }) as typeof fetch;
}

test('nobody who is not signed in reads or decides anything', async () => {
  upstream(200, {});
  assert.equal((await GET(get('view=list', false))).status, 401);
  assert.equal((await POST(post({ id: ID, action: 'approve' }, { signedIn: false }))).status, 401);
  assert.equal(calls.length, 0);
});

test('a decision must come from this site\'s own pages', async () => {
  upstream(200, {});
  assert.equal((await POST(post({ id: ID, action: 'approve' }, { origin: 'https://evil.example' }))).status, 403);
  assert.equal((await POST(post({ id: ID, action: 'approve' }, { origin: null }))).status, 403);
  assert.equal(calls.length, 0);
});

test('requests are checked before anything is passed on, and the secret is added on the server only', async () => {
  upstream(200, { posts: [] });
  for (const bad of ['view=list&status=%27x', 'view=detail&id=../x', 'view=nonsense', 'view=image', 'view=download&id=ACME.1']) assert.equal((await GET(get(bad))).status, 400, bad);
  assert.equal(calls.length, 0);
  const ok = await GET(get('view=list&status=pending'));
  assert.equal(ok.status, 200);
  assert.equal(calls[0]?.url, 'http://127.0.0.1:4012/review/posts?status=pending');
  assert.equal((calls[0]?.init.headers as Record<string, string>)['Authorization'], 'Bearer review-secret-0123456789');
  assert.doesNotMatch(await ok.text(), /review-secret/);
});

test('a picture and a download pass through as pictures, with their file name', async () => {
  upstream(200, 'JPEGBYTES', { 'content-type': 'image/jpeg', 'content-disposition': 'attachment; filename="w01-d1-v1.jpg"' });
  const image = await GET(get(`view=download&id=${ID}`));
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/jpeg');
  assert.match(image.headers.get('content-disposition') ?? '', /w01-d1-v1\.jpg/);
  assert.equal(image.headers.get('cache-control'), 'private, no-store');
  assert.equal(await image.text(), 'JPEGBYTES');
  assert.equal(calls[0]?.url, `http://127.0.0.1:4012/review/posts/${ID}/download`);
});

test('approve and reject are sent with the reviewer, and only listed fields', async () => {
  upstream(200, { status: 'approved' });
  assert.equal((await POST(post({ id: ID, action: 'approve', by: 'someone else' }))).status, 200);
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { by: 'owner' });
  assert.equal(calls[0]?.url, `http://127.0.0.1:4012/review/posts/${ID}/approve`);
  await POST(post({ id: ID, action: 'reject', reason: 'weak_copy', comment: '  ', extra: 'x' }));
  assert.deepEqual(JSON.parse(String(calls[1]?.init.body)), { by: 'owner', reason: 'weak_copy' });
  assert.equal((await POST(post({ id: ID, action: 'delete' }))).status, 400);
  assert.equal((await POST(post({ id: 'nope', action: 'approve' }))).status, 400);
});

test('the service\'s refusals are passed on in its own words; its failures are not', async () => {
  upstream(409, { error: 'this version was rejected; a new version has to be made' });
  const refused = await POST(post({ id: ID, action: 'approve' }));
  assert.equal(refused.status, 409);
  assert.match(((await refused.json()) as { error: string }).error, /was rejected/);
  upstream(500, { error: 'Error: ENOENT /srv/brands/acme/versions/x.jpg' });
  const broken = await GET(get(`view=detail&id=${ID}`));
  assert.equal(broken.status, 502);
  assert.doesNotMatch(JSON.stringify(await broken.json()), /srv\/brands/);
});

test('without its settings the queue says so and calls nothing', async () => {
  upstream(200, {});
  delete process.env['REVIEW_SECRET'];
  assert.equal((await GET(get('view=list'))).status, 503);
  assert.equal((await POST(post({ id: ID, action: 'approve' }))).status, 503);
  assert.equal(calls.length, 0);
});

test('the queue can be asked for what is open and what is held', async () => {
  upstream(200, { posts: [] });
  for (const status of ['open', 'held']) assert.equal((await GET(get(`view=list&status=${status}`))).status, 200, status);
  assert.equal(calls[0]?.url, 'http://127.0.0.1:4012/review/posts?status=open');
});
