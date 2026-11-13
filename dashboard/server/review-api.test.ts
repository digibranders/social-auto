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

test('the written posts are listed and kept or dropped through the service, with only checked names', async () => {
  upstream(200, { batches: [] });
  assert.equal((await GET(get('view=copy'))).status, 200);
  assert.equal(calls[0]?.url, 'http://127.0.0.1:4012/review/copy');
  const copy = { brand: 'acme', planFile: 'week-01.json', postId: 'p1', action: 'keep' };
  upstream(200, { batch: {} });
  calls = [];
  assert.equal((await POST(post({ copy }))).status, 200);
  assert.equal(calls[0]?.url, 'http://127.0.0.1:4012/review/copy/acme/week-01.json/p1/keep');
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { by: 'owner' });
  calls = [];
  for (const bad of [{ ...copy, brand: '../x' }, { ...copy, planFile: '../week-01.json' }, { ...copy, postId: 'a/b' }, { ...copy, action: 'approve' }]) assert.equal((await POST(post({ copy: bad }))).status, 400);
  assert.equal((await POST(post({ copy }, { signedIn: false }))).status, 401);
  assert.equal((await POST(post({ copy }, { origin: 'https://evil.example' }))).status, 403);
  assert.equal(calls.length, 0);
});
test('the list of what is being made is passed on read only, with the secret added on the server and never shown', async () => {
  upstream(200, { campaigns: [{ id: 'c1' }] });
  const before = calls.length;
  const answer = await GET(get('view=campaigns'));
  assert.equal(answer.status, 200);
  assert.equal(calls.length, before + 1);
  assert.equal(calls.at(-1)?.url, 'http://127.0.0.1:4012/review/campaigns');
  assert.equal(calls.at(-1)?.init.method, 'GET');
  assert.equal((calls.at(-1)?.init.headers as Record<string, string>)['Authorization'], 'Bearer review-secret-0123456789');
  assert.doesNotMatch(await answer.text(), /review-secret/);
});


test('writing posts for a website, editing, drawing and putting a batch away are passed on with the reviewer named, and only well-formed asks go through', async () => {
  upstream(202, { job: { id: 'job-abc123-0123abcd' } });
  const ok = await POST(post({ job: { site: 'https://acme.example.com/pricing', page: true, networks: ['instagram', 'linkedin'], weeks: 2, postsPerWeek: 2 } }));
  assert.equal(ok.status, 200, 'the relay answers with the job');
  assert.equal(calls[0]?.url, 'http://127.0.0.1:4012/review/jobs');
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { by: 'owner', kind: 'copy', site: 'https://acme.example.com/pricing', networks: ['instagram', 'linkedin'], page: true, weeks: 2, postsPerWeek: 2 });
  for (const bad of [{ job: { site: '', networks: ['instagram'] } }, { job: { site: 'acme.example.com', networks: ['tiktok'] } }, { job: { site: 'acme.example.com', networks: ['instagram'], weeks: '2' } }, { job: { site: 'acme.example.com', networks: 'instagram' } }]) {
    assert.equal((await POST(post(bad))).status, 400, JSON.stringify(bad));
  }
  calls = [];
  upstream(200, { ok: true });
  assert.equal((await POST(post({ edit: { brand: 'acme', planFile: 'week-01.json', postId: 'w01-d1', headline: 'New words', caption: 'Better caption', network: 'linkedin' } }))).status, 200);
  assert.equal(calls[0]?.init.method, 'PUT');
  assert.equal(calls[0]?.url, 'http://127.0.0.1:4012/review/copy/acme/week-01.json/w01-d1/edit');
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { by: 'owner', headline: 'New words', caption: 'Better caption', network: 'linkedin' });
  // The day of the first post and the time of day go through; a malformed one does not.
  calls = [];
  upstream(202, { job: { id: 'job-abc123-0123abcd' } });
  assert.equal((await POST(post({ job: { site: 'acme.example.com', networks: ['linkedin'], weeks: 1, postsPerWeek: 2, startDate: '2026-12-14', time: '09:30' } }))).status, 200);
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { by: 'owner', kind: 'copy', site: 'acme.example.com', networks: ['linkedin'], weeks: 1, postsPerWeek: 2, startDate: '2026-12-14', time: '09:30' });
  for (const bad of [{ startDate: '14/12/2026' }, { startDate: 20261214 }, { time: '9:30' }, { time: 930 }]) {
    assert.equal((await POST(post({ job: { site: 'acme.example.com', networks: ['linkedin'], ...bad } }))).status, 400, JSON.stringify(bad));
  }
  calls = [];
  upstream(200, { ok: true });
  assert.equal((await POST(post({ edit: { brand: 'acme', planFile: 'week-01.json', postId: 'w01-d1', headline: 'x', caption: '  ' } }))).status, 400);
  // The sign-off pieces go through as given (empty means the default), and must be text.
  calls = [];
  upstream(200, { ok: true });
  assert.equal((await POST(post({ edit: { brand: 'acme', planFile: 'week-01.json', postId: 'w01-d1', headline: 'New words', caption: 'Better caption', brandName: 'Acme Labs', domain: '' } }))).status, 200);
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { by: 'owner', headline: 'New words', caption: 'Better caption', brandName: 'Acme Labs', domain: '' });
  assert.equal((await POST(post({ edit: { brand: 'acme', planFile: 'week-01.json', postId: 'w01-d1', headline: 'x', caption: 'y', brandName: 5 } }))).status, 400);
  assert.equal((await POST(post({ edit: { brand: 'acme', planFile: 'week-01.json', postId: 'w01-d1', headline: 'x', caption: 'y', domain: 'a'.repeat(201) } }))).status, 400);
  assert.equal((await POST(post({ edit: { brand: 'acme', planFile: 'week-01.json', postId: 'w01-d1', headline: 'x', caption: 'y', network: 'tiktok' } }))).status, 400);
  calls = [];
  assert.equal((await POST(post({ draw: { brand: 'acme', planFile: 'week-01.json', client: 'acme-foods' } }))).status, 200);
  assert.equal(calls[0]?.url, 'http://127.0.0.1:4012/review/copy/acme/week-01.json/draw');
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { by: 'owner', client: 'acme-foods' });
  assert.equal((await POST(post({ draw: { brand: 'acme', planFile: '../week-01.json' } }))).status, 400);
  assert.equal((await POST(post({ draw: { brand: 'acme', planFile: 'week-01.json', client: 'Bad Name' } }))).status, 400);
  calls = [];
  assert.equal((await POST(post({ close: { brand: 'acme', planFile: 'week-01.json' } }))).status, 200);
  assert.equal(calls[0]?.url, 'http://127.0.0.1:4012/review/copy/acme/week-01.json/close');
  calls = [];
  assert.equal((await GET(get('view=jobs'))).status, 200);
  assert.equal(calls[0]?.url, 'http://127.0.0.1:4012/review/jobs');
  assert.equal((await GET(get('view=job&id=job-abc123-0123abcd'))).status, 200);
  assert.equal((await GET(get('view=job&id=../x'))).status, 400);
  assert.equal((await POST(post({ draw: { brand: 'acme', planFile: 'week-01.json' } }, { origin: 'https://evil.example' }))).status, 403);
});

test('a carousel is read whole, and approved or rejected in one step, with the reviewer added here and only listed fields', async () => {
  upstream(200, { id: 'car1', status: 'pending', slides: [], captions: [] });
  assert.equal((await GET(get('view=carousel&brand=acme&id=car1'))).status, 200);
  assert.equal(calls[0]?.url, 'http://127.0.0.1:4012/review/carousels/acme/car1');
  for (const bad of ['view=carousel&brand=ACME&id=car1', 'view=carousel&brand=acme&id=../x', 'view=carousel&brand=acme', 'view=carousel&id=car1']) assert.equal((await GET(get(bad))).status, 400, bad);
  assert.equal(calls.length, 1);

  upstream(200, { status: 'approved' });
  assert.equal((await POST(post({ carousel: { brand: 'acme', id: 'car1', action: 'approve', by: 'someone else' } }))).status, 200);
  assert.equal(calls.at(-1)?.url, 'http://127.0.0.1:4012/review/carousels/acme/car1/approve');
  assert.deepEqual(JSON.parse(String(calls.at(-1)?.init.body)), { by: 'owner' });
  assert.equal((await POST(post({ carousel: { brand: 'acme', id: 'car1', action: 'reject', reason: 'style', comment: 'not our look' } }))).status, 200);
  assert.deepEqual(JSON.parse(String(calls.at(-1)?.init.body)), { by: 'owner', reason: 'style', comment: 'not our look' });
  const before = calls.length;
  for (const bad of [{ brand: 'acme', id: 'car1', action: 'delete' }, { brand: 'Acme', id: 'car1', action: 'approve' }, { brand: 'acme', id: 'a/b', action: 'approve' }, { brand: 'acme', action: 'approve' }]) assert.equal((await POST(post({ carousel: bad }))).status, 400, JSON.stringify(bad));
  assert.equal((await POST(post({ carousel: { brand: 'acme', id: 'car1', action: 'approve' } }, { signedIn: false }))).status, 401);
  assert.equal((await POST(post({ carousel: { brand: 'acme', id: 'car1', action: 'approve' } }, { origin: 'https://evil.example' }))).status, 403);
  assert.equal(calls.length, before);
});

test('a topic in the client\'s own words is asked for through the proxy, with only listed fields, from this site\'s own signed-in pages', async () => {
  upstream(202, { job: { id: 'job-abc123-12345678' }, created: true });
  const topic = 'Diwali special: 20% off all thalis until 2 Nov.';
  assert.equal((await POST(post({ topic_job: { site: 'acme.com', text: topic, networks: ['instagram', 'linkedin'], startDate: '2026-11-25', time: '11:30', kind: 'copy', by: 'someone else' } }))).status, 200);
  assert.equal(calls[0]?.url, 'http://127.0.0.1:4012/review/jobs');
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { by: 'owner', kind: 'topic', site: 'acme.com', text: topic, networks: ['instagram', 'linkedin'], startDate: '2026-11-25', time: '11:30' });
  const before = calls.length;
  const ok = { site: 'acme.com', text: topic, networks: ['instagram'] };
  for (const bad of [{ ...ok, text: '' }, { ...ok, text: '  ' }, { ...ok, text: 'x'.repeat(1001) }, { ...ok, networks: [] }, { ...ok, networks: ['tiktok'] }, { text: topic, networks: ['instagram'] }, { ...ok, startDate: 'tomorrow' }, { ...ok, time: '9' }]) {
    assert.equal((await POST(post({ topic_job: bad }))).status, 400, JSON.stringify(bad).slice(0, 80));
  }
  assert.equal((await POST(post({ topic_job: ok }, { signedIn: false }))).status, 401);
  assert.equal((await POST(post({ topic_job: ok }, { origin: 'https://evil.example' }))).status, 403);
  assert.equal(calls.length, before);
});

test('a carousel for a client is asked for through the proxy, with only listed fields, from this site\'s own signed-in pages', async () => {
  upstream(202, { job: { id: 'job-abc123-12345678' }, created: true });
  assert.equal((await POST(post({ carousel_job: { site: 'acme.com', networks: ['instagram', 'linkedin'], startDate: '2026-11-25', time: '11:30', kind: 'copy', by: 'someone else' } }))).status, 200);
  assert.equal(calls[0]?.url, 'http://127.0.0.1:4012/review/jobs');
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { by: 'owner', kind: 'carousel', site: 'acme.com', networks: ['instagram', 'linkedin'], startDate: '2026-11-25', time: '11:30' });
  const before = calls.length;
  for (const bad of [{ site: 'acme.com', networks: [] }, { site: 'acme.com', networks: ['tiktok'] }, { networks: ['instagram'] }, { site: 'acme.com', networks: ['instagram'], startDate: 'tomorrow' }, { site: 'acme.com', networks: ['instagram'], time: '9' }]) {
    assert.equal((await POST(post({ carousel_job: bad }))).status, 400, JSON.stringify(bad));
  }
  assert.equal((await POST(post({ carousel_job: { site: 'acme.com', networks: ['instagram'] } }, { signedIn: false }))).status, 401);
  assert.equal((await POST(post({ carousel_job: { site: 'acme.com', networks: ['instagram'] } }, { origin: 'https://evil.example' }))).status, 403);
  assert.equal(calls.length, before);
});
