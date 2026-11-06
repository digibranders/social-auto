import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReviewServer } from './review-server.ts';
import { ReviewStore, type NewVersion } from './review-store.ts';
import { CopyStage } from './copy-stage.ts';

const SECRET = 'test-secret-0123456789';

async function start(): Promise<{ root: string; base: string; stores: { acme: ReviewStore; globex: ReviewStore }; pictures: (name: string, text: string) => string; call: (path: string, init?: RequestInit & { auth?: boolean }) => Promise<Response>; done: () => Promise<void> }> {
  const root = mkdtempSync(join(tmpdir(), 'review-server-'));
  for (const brand of ['acme', 'globex']) mkdirSync(join(root, 'brands', brand), { recursive: true });
  const stores = { acme: new ReviewStore(join(root, 'brands', 'acme'), 'acme'), globex: new ReviewStore(join(root, 'brands', 'globex'), 'globex') };
  const server = createReviewServer({ brandsRoot: join(root, 'brands'), secret: SECRET });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    root, base, stores,
    pictures: (name, text) => { const p = join(root, name); writeFileSync(p, text); return p; },
    call: (path, init = {}) => fetch(`${base}${path}`, { ...init, headers: { ...(init.auth === false ? {} : { Authorization: `Bearer ${SECRET}` }), 'Content-Type': 'application/json', ...(init.headers as Record<string, string> | undefined) } }),
    done: async () => { await new Promise((resolve) => server.close(resolve)); rmSync(root, { recursive: true, force: true }); },
  };
}

const version = (imagePath: string, over: Partial<NewVersion> = {}): NewVersion => ({
  postId: 'w01-d1', planFile: 'week-01.json', headline: 'Answers from your own docs', caption: 'Caption.', ctaUrl: 'https://acme.example', factIds: ['f1'],
  evidence: [{ factId: 'f1', text: 't', quote: 'q', url: 'https://acme.example/', context: 'c' }], imagePath,
  validation: { accepted: true, readings: 2, defects: [], reportFile: 'r.json' }, attempts: 1, costUsd: 0.016, ...over,
});

test('nothing is answered without the secret', async () => {
  const s = await start();
  try {
    assert.equal((await s.call('/review/posts', { auth: false })).status, 401);
    assert.equal((await s.call('/review/posts', { headers: { Authorization: 'Bearer wrong' }, auth: false })).status, 401);
    assert.equal((await s.call('/review/posts')).status, 200);
  } finally {
    await s.done();
  }
});

test('the queue lists pending posters of every brand, with filters, and nothing unapproved can be downloaded', async () => {
  const s = await start();
  try {
    const a = s.stores.acme.addVersion(version(s.pictures('a.jpg', 'acme picture')));
    const g = s.stores.globex.addVersion(version(s.pictures('g.jpg', 'globex picture'), { postId: 'w01-d2' }));
    const list = (await (await s.call('/review/posts')).json()) as { posts: Array<{ versionId: string; status: string; planFile: string }> };
    assert.ok(list.posts.every((p) => p.planFile === 'week-01.json'), 'each poster names its plan, so a batch can be shown together');
    assert.deepEqual(list.posts.map((p) => p.versionId).sort(), [a.versionId, g.versionId].sort());
    assert.equal((await s.call(`/review/posts/${a.versionId}/download`)).status, 409, 'a pending poster is not a download');
    assert.equal((await s.call('/review/posts?status=nonsense')).status, 400);
    const image = await s.call(`/review/posts/${a.versionId}/image`);
    assert.equal(image.status, 200);
    assert.equal(await image.text(), 'acme picture');
    const detail = (await (await s.call(`/review/posts/${a.versionId}`)).json()) as { version: { evidence: unknown[] }; history: unknown[] };
    assert.equal(detail.version.evidence.length, 1);
    assert.equal(detail.history.length, 1);
  } finally {
    await s.done();
  }
});

test('approve, repeat, download; the approval is the same twice and the download is the exact picture', async () => {
  const s = await start();
  try {
    const v = s.stores.acme.addVersion(version(s.pictures('a.jpg', 'acme picture')));
    const first = await s.call(`/review/posts/${v.versionId}/approve`, { method: 'POST', body: JSON.stringify({ by: 'owner' }) });
    assert.equal(first.status, 200);
    const again = await s.call(`/review/posts/${v.versionId}/approve`, { method: 'POST', body: JSON.stringify({ by: 'owner' }) });
    assert.deepEqual(await again.json(), await first.clone().json());
    const download = await s.call(`/review/posts/${v.versionId}/download`);
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-disposition') ?? '', /attachment; filename="w01-d1-v1\.jpg"/);
    assert.equal(await download.text(), 'acme picture');
    assert.equal((await s.call('/review/posts?status=approved')).status, 200);
  } finally {
    await s.done();
  }
});

test('a rejection needs a listed reason; an approval needs a name; blocked and unknown versions are refused', async () => {
  const s = await start();
  try {
    const v = s.stores.acme.addVersion(version(s.pictures('a.jpg', 'x')));
    assert.equal((await s.call(`/review/posts/${v.versionId}/reject`, { method: 'POST', body: JSON.stringify({ by: 'owner', reason: 'because' }) })).status, 400);
    assert.equal((await s.call(`/review/posts/${v.versionId}/approve`, { method: 'POST', body: JSON.stringify({}) })).status, 400);
    const rejected = await s.call(`/review/posts/${v.versionId}/reject`, { method: 'POST', body: JSON.stringify({ by: 'owner', reason: 'irrelevant_image', comment: 'laptop again' }) });
    assert.equal(rejected.status, 200);
    assert.equal(((await rejected.json()) as { status: string }).status, 'rejected');
    assert.equal((await s.call(`/review/posts/${v.versionId}/approve`, { method: 'POST', body: JSON.stringify({ by: 'owner' }) })).status, 409);
    const blocked = s.stores.acme.addVersion(version(s.pictures('b.jpg', 'y'), { postId: 'w01-d3', validation: { accepted: false, readings: 2, defects: ['extra_text'], reportFile: 'r.json' } }));
    assert.equal((await s.call(`/review/posts/${blocked.versionId}/approve`, { method: 'POST', body: JSON.stringify({ by: 'owner' }) })).status, 409);
    assert.equal((await s.call('/review/posts/acme.doesnotexist')).status, 404);
  } finally {
    await s.done();
  }
});

test('a version id cannot reach outside the brands folder or into another brand', async () => {
  const s = await start();
  try {
    const v = s.stores.acme.addVersion(version(s.pictures('a.jpg', 'x')));
    for (const id of ['..%2F..%2Fetc.passwd', '.hidden.x', '%2E%2E.x', 'ACME.x', 'acme%2F..%2Fglobex.x']) assert.equal((await s.call(`/review/posts/${id}`)).status, 404, id);
    assert.equal((await s.call(`/review/posts/globex.${v.versionId.split('.')[1]}`)).status, 404, 'a hash from one brand under another brand\'s name is not found');
  } finally {
    await s.done();
  }
});

test('a picture changed on disk is not released, and the answer does not say where it is', async () => {
  const s = await start();
  try {
    const v = s.stores.acme.addVersion(version(s.pictures('a.jpg', 'x')));
    s.stores.acme.approve(v.versionId, 'owner');
    writeFileSync(join(s.root, 'brands', 'acme', v.imageFile), 'swapped');
    const download = await s.call(`/review/posts/${v.versionId}/download`);
    assert.equal(download.status, 500);
    const body = (await download.json()) as { error: string };
    assert.match(body.error, /integrity check failed/);
    assert.doesNotMatch(JSON.stringify(body), /versions\/|brands\//);
    assert.equal((await s.call(`/review/posts/${v.versionId}/image`)).status, 500);
  } finally {
    await s.done();
  }
});

test('oversized or malformed bodies are refused', async () => {
  const s = await start();
  try {
    const v = s.stores.acme.addVersion(version(s.pictures('a.jpg', 'x')));
    assert.equal((await s.call(`/review/posts/${v.versionId}/approve`, { method: 'POST', body: 'not json' })).status, 400);
    assert.equal((await s.call(`/review/posts/${v.versionId}/approve`, { method: 'POST', body: JSON.stringify({ by: 'x'.repeat(20_000) }) })).status, 400);
    assert.equal((await s.call('/elsewhere')).status, 404);
  } finally {
    await s.done();
  }
});

test('only one review service may run on a brands folder: the second refuses to start', async () => {
  const { spawn } = await import('node:child_process');
  const s = await start();
  const env = { ...process.env, REVIEW_SECRET: SECRET, BRANDS_ROOT: join(s.root, 'brands'), HOST: '127.0.0.1' };
  const first = spawn(process.execPath, [new URL('./review-server.ts', import.meta.url).pathname], { env: { ...env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise<void>((resolve) => first.stdout?.on('data', (d: Buffer) => d.toString().includes('listening') && resolve()));
    const second = spawn(process.execPath, [new URL('./review-server.ts', import.meta.url).pathname], { env: { ...env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let errors = '';
    second.stderr?.on('data', (d: Buffer) => (errors += d.toString()));
    const code = await new Promise<number | null>((resolve) => second.on('close', resolve));
    assert.notEqual(code, 0);
    assert.match(errors, /another review service is already running/);
  } finally {
    first.kill('SIGTERM');
    await new Promise((resolve) => first.on('close', resolve));
    await s.done();
  }
});

test('the kept logo is shown beside the poster, as a locked-down picture, only when it is still the file that was recorded', async () => {
  const s = await start();
  try {
    const brandDir = join(s.root, 'brands', 'acme');
    mkdirSync(join(brandDir, 'branding'), { recursive: true });
    const logo = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 100"><rect width="400" height="100"/></svg>';
    const sha = createHash('sha256').update(logo).digest('hex');
    writeFileSync(join(brandDir, 'branding', `${sha}.svg`), logo);
    const branded = s.stores.acme.addVersion(version(s.pictures('a.jpg', 'acme picture'), { branding: { intendedMode: 'authentic_logo', appliedMode: 'text_only', status: 'awaiting_compositor', logoKind: 'wordmark', logoAssetSha256: sha, logoFile: `branding/${sha}.svg` } }));
    const shown = await s.call(`/review/posts/${branded.versionId}/logo`);
    assert.equal(shown.status, 200);
    assert.equal(shown.headers.get('content-type'), 'image/svg+xml');
    assert.match(shown.headers.get('content-security-policy') ?? '', /sandbox/);
    assert.equal(shown.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(await shown.text(), logo);
    // A poster with no kept logo has none to show.
    const plain = s.stores.acme.addVersion(version(s.pictures('b.jpg', 'other picture'), { postId: 'w01-d2' }));
    assert.equal((await s.call(`/review/posts/${plain.versionId}/logo`)).status, 404);
    // A kept file that no longer matches its recorded hash is not served.
    writeFileSync(join(brandDir, 'branding', `${sha}.svg`), '<svg onload="x()"/>');
    assert.equal((await s.call(`/review/posts/${branded.versionId}/logo`)).status, 500);
    // A record that points outside the brand's folder is not followed.
    const escaped = s.stores.acme.addVersion(version(s.pictures('c.jpg', 'third picture'), { postId: 'w01-d3', branding: { intendedMode: 'authentic_logo', appliedMode: 'text_only', status: 'awaiting_compositor', logoAssetSha256: sha, logoFile: '../../outside.svg' } }));
    assert.equal((await s.call(`/review/posts/${escaped.versionId}/logo`)).status, 404);
    assert.equal((await s.call(`/review/posts/${branded.versionId}/logo`, { auth: false })).status, 401);
  } finally {
    await s.done();
  }
});

test('written posts are listed, kept or dropped through the service, and a batch that was drawn disappears from the list', async () => {
  const s = await start();
  try {
    const stage = new CopyStage(join(s.root, 'brands', 'acme'), 'acme');
    stage.open('week-01.json', [{ postId: 'p1', headline: 'Answers from your own docs', caption: 'Caption one.' }, { postId: 'p2', headline: 'Find it fast', caption: 'Caption two.' }]);
    stage.open('week-02.json', [{ postId: 'q1', headline: 'Facing |B2B challenges|?', caption: 'Caption.' }]);
    const marked = (await (await s.call('/review/copy')).json()) as { batches: Array<{ planFile: string; posts: Array<{ headline: string }> }> };
    assert.equal(marked.batches.find((b) => b.planFile === 'week-02.json')?.posts[0]?.headline, 'Facing B2B challenges?', 'emphasis markers are not shown to the owner');
    const list = (await (await s.call('/review/copy')).json()) as { batches: Array<{ brand: string; posts: Array<{ state: string }> }> };
    assert.equal(list.batches.find((b) => b.brand === 'acme' && (b as { planFile?: string }).planFile === 'week-01.json')?.posts.length, 2);
    assert.deepEqual(list.batches.find((b) => (b as { planFile?: string }).planFile === 'week-01.json')?.posts.map((p) => p.state), ['pending', 'pending']);
    const kept = await s.call('/review/copy/acme/week-01.json/p1/keep', { method: 'POST', body: JSON.stringify({ by: 'owner' }) });
    assert.equal(kept.status, 200);
    assert.equal(stage.get('week-01.json').posts[0]?.state, 'kept');
    assert.equal((await s.call('/review/copy/acme/week-01.json/p2/drop', { method: 'POST', body: JSON.stringify({}) })).status, 400, 'who decided must be given');
    assert.equal((await s.call('/review/copy/acme/week-01.json/zz/keep', { method: 'POST', body: JSON.stringify({ by: 'owner' }) })).status, 404);
    assert.equal((await s.call('/review/copy/nope/week-01.json/p1/keep', { method: 'POST', body: JSON.stringify({ by: 'owner' }) })).status, 404);
    assert.equal((await s.call('/review/copy', { auth: false })).status, 401);
    stage.markDrawn('week-01.json');
    stage.markDrawn('week-02.json');
    assert.equal((await s.call('/review/copy/acme/week-01.json/p2/keep', { method: 'POST', body: JSON.stringify({ by: 'owner' }) })).status, 409);
    assert.deepEqual(((await (await s.call('/review/copy')).json()) as { batches: unknown[] }).batches, []);
  } finally {
    await s.done();
  }
});

test('the campaign list is for signed-in callers only, is read only, and shows what is being made', async () => {
  const s = await start();
  try {
    mkdirSync(join(s.root, 'brands', 'acme', 'campaigns'), { recursive: true });
    writeFileSync(join(s.root, 'brands', 'acme', 'campaigns', 'abc.json'), JSON.stringify({ id: 'abc', brand: 'acme-client', siteBrand: 'acme', site: 'https://acme.test', plan: { platforms: ['instagram'], startDate: '2026-11-07', durationDays: 1, time: '10:00', utcOffset: '+05:30' }, status: 'running', createdAt: 'a', updatedAt: 'b', batches: [{ index: 0, dates: ['2026-11-07'], status: 'running', stage: 'drawing', detail: 'w01-d1: attempt 1, drawing the poster…', tail: 'SECRET RAW OUTPUT' }] }));
    assert.equal((await s.call('/review/campaigns', { auth: false })).status, 401);
    assert.equal((await s.call('/review/campaigns', { method: 'POST', body: '{}' })).status, 405);
    const answer = (await (await s.call('/review/campaigns')).json()) as { campaigns: Array<{ brand: string; batches: Array<{ stage?: string; tail?: string }> }> };
    assert.equal(answer.campaigns[0]?.brand, 'acme-client');
    assert.equal(answer.campaigns[0]?.batches[0]?.stage, 'drawing');
    assert.equal(answer.campaigns[0]?.batches[0]?.tail, undefined, 'the raw output stays on the server');
  } finally {
    await s.done();
  }
});

