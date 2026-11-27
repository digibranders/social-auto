import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReviewServer } from './review-server.ts';
import { ReviewStore, type NewVersion } from './review-store.ts';
import { JobStore } from './job-store.ts';
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


test('the owner can change the words of a written post before it is drawn, a refused edit says why, and a whole batch can be put away', async () => {
  const s = await start();
  try {
    const brandDir = join(s.root, 'brands', 'acme');
    const plan = { brand: 'acme', timezone: '+05:30', posts: [{ id: 'p1', headline: 'Answers from your own docs', subline: '', caption: 'The assistant answers from your pages.', hashtags: ['#acme'] }] };
    writeFileSync(join(brandDir, 'week-01.json'), JSON.stringify(plan));
    new CopyStage(brandDir, 'acme').open('week-01.json', [{ postId: 'p1', headline: plan.posts[0]?.headline ?? '', caption: 'The assistant answers from your pages.\n\n#acme' }]);
    const put = (path: string, body: unknown) => s.call(path, { method: 'PUT', body: JSON.stringify(body) });
    const ok = await put('/review/copy/acme/week-01.json/p1/edit', { by: 'owner', headline: 'Your docs answer for you' });
    assert.equal(ok.status, 200);
    const batch = ((await ok.json()) as { batch: { posts: Array<{ headline: string; edited?: boolean }> } }).batch;
    assert.equal(batch.posts[0]?.headline, 'Your docs answer for you');
    assert.equal(batch.posts[0]?.edited, true);
    const refused = await put('/review/copy/acme/week-01.json/p1/edit', { by: 'owner', headline: '- JANE DOE -' });
    assert.equal(refused.status, 422);
    assert.match(((await refused.json()) as { error: string }).error, /credit/);
    assert.equal((await put('/review/copy/acme/week-01.json/p1/edit', { headline: 'Another headline for you' })).status, 400, 'who is editing must be given');
    assert.equal((await put('/review/copy/acme/week-01.json/zz/edit', { by: 'owner', headline: 'Another headline for you' })).status, 404);
    assert.equal((await s.call('/review/copy/acme/week-01.json/close', { method: 'POST', body: JSON.stringify({ by: 'owner' }) })).status, 200);
    assert.deepEqual(((await (await s.call('/review/copy')).json()) as { batches: unknown[] }).batches, [], 'a batch put away is not listed');
    assert.equal((await put('/review/copy/acme/week-01.json/p1/edit', { by: 'owner', headline: 'Another headline for you' })).status, 409);
    assert.equal((await put('/review/copy/acme/week-01.json/p1/edit', { by: 'owner', headline: 'Another headline for you' }).then((r) => r.status)), 409);
  } finally {
    await s.done();
  }
});

test('the facts routes answer plainly for a brand with no facts yet, an unknown brand and a bad fact id, and need the secret', async () => {
  const s = await start();
  try {
    assert.equal((await s.call('/review/brands/acme/facts')).status, 404, 'no facts read yet');
    assert.equal((await s.call('/review/brands/nope/facts')).status, 404, 'unknown brand');
    assert.equal((await s.call('/review/brands/acme/facts/abc/remove', { method: 'POST', body: JSON.stringify({ by: 'owner' }) })).status, 404, 'no facts to change');
    assert.equal((await s.call('/review/brands/acme/facts/%2E%2E%2Fx/remove', { method: 'POST', body: JSON.stringify({ by: 'owner' }) })).status, 400, 'a bad fact id');
    assert.equal((await s.call('/review/brands/acme/facts', { auth: false })).status, 401);
  } finally {
    await s.done();
  }
});

test('a topic made for two networks shows each network with its shape, and one step approves every waiting picture of it, each as its own decision', async () => {
  const s = await start();
  try {
    const base = version(s.pictures('ig.jpg', 'square picture'));
    const ig = s.stores.acme.addVersion({ ...base, network: 'instagram', width: 1024, height: 1024 });
    const li = s.stores.acme.addVersion({ ...base, network: 'linkedin', width: 1536, height: 1024, imagePath: s.pictures('li.jpg', 'wide picture') });
    const list = (await (await s.call('/review/posts?status=pending')).json()) as { posts: Array<{ versionId: string; network?: string; shape?: string; width?: number }> };
    const byNetwork = Object.fromEntries(list.posts.map((p) => [p.network, p]));
    assert.equal(byNetwork['instagram']?.shape, 'square');
    assert.equal(byNetwork['linkedin']?.shape, 'wide');
    assert.equal(byNetwork['linkedin']?.width, 1536);
    const detail = (await (await s.call(`/review/posts/${li.versionId}`)).json()) as { history: Array<{ versionId: string }> };
    assert.deepEqual(detail.history.map((h) => h.versionId), [li.versionId], 'history is of this network only');
    const done = await s.call('/review/topics/acme/week-01.json/w01-d1/approve', { method: 'POST', body: JSON.stringify({ by: 'owner' }) });
    assert.equal(done.status, 200);
    const decisions = ((await done.json()) as { decisions: Array<{ network: string; status: string }> }).decisions;
    assert.deepEqual(decisions.map((d) => d.status), ['approved', 'approved']);
    assert.equal(s.stores.acme.get(ig.versionId).status, 'approved');
    assert.equal(s.stores.acme.get(li.versionId).status, 'approved');
    const again = await s.call('/review/topics/acme/week-01.json/w01-d1/approve', { method: 'POST', body: JSON.stringify({ by: 'owner' }) });
    assert.equal(again.status, 200, 'a repeated request gets the same answer');
    assert.deepEqual(((await again.json()) as { decisions: Array<{ versionId: string; status: string }>; already: boolean }).decisions.map((d) => [d.versionId, d.status]).sort(), [[ig.versionId, 'approved'], [li.versionId, 'approved']].sort());
    assert.equal((await s.call('/review/topics/acme/week-01.json/w09-d9/approve', { method: 'POST', body: JSON.stringify({ by: 'owner' }) })).status, 404, 'a topic that has nothing to approve');
  } finally {
    await s.done();
  }
});

test('jobs: a website asked for twice is one job, bad sites and networks are refused, and the job can be followed', async () => {
  const s = await start();
  try {
    const post = (body: unknown) => s.call('/review/jobs', { method: 'POST', body: JSON.stringify(body) });
    for (const bad of [{ kind: 'copy', site: 'http://127.0.0.1' }, { kind: 'copy', site: 'https://user:pw@acme.example.com' }, { kind: 'copy', site: 'localhost' }, { kind: 'copy', site: 'acme.example.com', networks: ['tiktok'] }, { kind: 'copy', site: 'acme.example.com', days: 99 }, { kind: 'draw', site: 'acme.example.com' }]) {
      assert.equal((await post({ ...bad, by: 'owner' })).status, 400, JSON.stringify(bad));
    }
    assert.equal((await post({ kind: 'copy', site: 'acme.example.com', by: ' ' })).status, 400, 'who is asking must be given');
    const first = await post({ kind: 'copy', site: 'https://www.Acme-Foods.example.com/about', networks: ['instagram', 'instagram', 'linkedin'], days: 6, by: 'owner' });
    assert.equal(first.status, 202);
    const { job } = (await first.json()) as { job: { id: string; brand: string; site: string; state: string; networks: string[] } };
    assert.deepEqual([job.brand, job.site, job.state, job.networks], ['acme-foods', 'https://www.acme-foods.example.com', 'queued', ['instagram', 'linkedin']]);
    const again = await post({ kind: 'copy', site: 'www.acme-foods.example.com', by: 'owner' });
    assert.equal(again.status, 200);
    assert.equal(((await again.json()) as { job: { id: string } }).job.id, job.id);
    const one = (await (await s.call(`/review/jobs/${job.id}`)).json()) as { job: { id: string } };
    assert.equal(one.job.id, job.id);
    assert.equal((await s.call('/review/jobs/job-zzzzzz-12345678')).status, 404);
    assert.equal((await s.call('/review/jobs/..%2Fx')).status, 400);
    assert.equal(((await (await s.call('/review/jobs?state=queued')).json()) as { jobs: unknown[] }).jobs.length, 1);
    assert.equal(((await (await s.call('/review/jobs?state=running')).json()) as { jobs: unknown[] }).jobs.length, 0);
    assert.equal((await s.call('/review/jobs?state=nope')).status, 400);
    assert.equal((await s.call('/review/jobs', { auth: false })).status, 401);
  } finally {
    await s.done();
  }
});

test('jobs: with no length given a client is written two posts for a week on two spread days; weeks and posts a week change it, bad values are refused', async () => {
  const s = await start();
  try {
    const post = (body: unknown) => s.call('/review/jobs', { method: 'POST', body: JSON.stringify(body) });
    const made = (await (await post({ kind: 'copy', site: 'rhythm-one.example.com', by: 'owner' })).json()) as { job: { days: number; weekdays: string[] } };
    assert.equal(made.job.days, 2);
    assert.equal(made.job.weekdays.length, 2);
    const month = (await (await post({ kind: 'copy', site: 'rhythm-two.example.com', weeks: 4, postsPerWeek: 3, by: 'owner' })).json()) as { job: { days: number; weekdays: string[] } };
    assert.deepEqual([month.job.days, month.job.weekdays.length], [12, 3]);
    assert.equal((await post({ kind: 'copy', site: 'rhythm-three.example.com', weeks: 9, by: 'owner' })).status, 400);
    assert.equal((await post({ kind: 'copy', site: 'rhythm-three.example.com', postsPerWeek: 0, by: 'owner' })).status, 400);
  } finally {
    await s.done();
  }
});

test('jobs: a failed draw can be retried once, and a draw that is waiting, running or done cannot', async () => {
  const s = await start();
  try {
    new CopyStage(join(s.root, 'brands', 'acme'), 'acme').open('week-01.json', [{ postId: 'p1', headline: 'H one', caption: 'C one' }]);
    writeFileSync(join(s.root, 'brands', 'acme', 'brand.json'), JSON.stringify({ website: 'https://acme.example.com' }));
    const weekPost = { id: 'p1', date: '2099-11-10T10:00:00+05:30', painPoint: 'p', mode: 'ai', headline: 'H', subline: '', caption: 'C', hashtags: [], imagePrompt: 'a picture' };
    writeFileSync(join(s.root, 'brands', 'acme', 'week-01.json'), JSON.stringify({ brand: 'acme', timezone: '+05:30', renderMode: 'ai_v1', posts: [weekPost] }));
    await s.call('/review/copy/acme/week-01.json/p1/keep', { method: 'POST', body: JSON.stringify({ by: 'owner' }) });
    const draw = (body: Record<string, unknown> = {}) => s.call('/review/copy/acme/week-01.json/draw', { method: 'POST', body: JSON.stringify({ by: 'owner', ...body }) });
    const first = (await (await draw()).json()) as { job: { id: string } };
    const early = await draw({ retry: true });
    assert.equal(early.status, 200, 'a retry while the first is waiting answers with the first');
    assert.equal(((await early.json()) as { job: { id: string } }).job.id, first.job.id);
    const store = new JobStore(join(s.root, 'jobs'));
    new CopyStage(join(s.root, 'brands', 'acme'), 'acme').markDrawn('week-01.json');
    const listed = async (): Promise<number> => ((await (await s.call('/review/copy')).json()) as { batches: unknown[] }).batches.length;
    assert.equal(await listed(), 0, 'a drawn batch is no longer waiting for choices');
    store.claim(1, 1);
    store.update(first.job.id, { state: 'failed', error: { code: 'BUDGET_EXHAUSTED', message: 'the day is spent' } });
    assert.equal(await listed(), 1, 'but one whose draw stopped stays listed so the draw can be asked for again');
    assert.equal(((await (await draw()).json()) as { job: { id: string } }).job.id, first.job.id, 'without retry the failed job is what answers');
    const retried = await draw({ retry: true });
    assert.equal(retried.status, 202);
    const second = (await retried.json()) as { job: { id: string; retry?: boolean } };
    assert.notEqual(second.job.id, first.job.id);
    assert.equal(second.job.retry, true);
    assert.equal(((await (await draw({ retry: true })).json()) as { job: { id: string } }).job.id, second.job.id, 'a second retry while that one waits answers with it');
    const change = (path: string, method: string, body: Record<string, unknown>) => s.call(`/review/copy/acme/week-01.json/${path}`, { method, body: JSON.stringify({ by: 'owner', ...body }) });
    assert.equal((await change('p1/drop', 'POST', {})).status, 409, 'once drawing is asked for, the choices are final');
    assert.equal((await change('p1/edit', 'PUT', { headline: 'New words', caption: 'New caption' })).status, 409, 'and so are the words');
    assert.equal((await change('close', 'POST', {})).status, 409, 'and the batch cannot be put away under the runner');
  } finally {
    await s.done();
  }
});

test('jobs: one page of a website is kept as that page, and the whole site without a page flag', async () => {
  const s = await start();
  try {
    const post = (body: unknown) => s.call('/review/jobs', { method: 'POST', body: JSON.stringify(body) });
    const one = (await (await post({ kind: 'copy', site: 'https://pages.example.com/pricing/?utm=x#top', page: true, by: 'owner' })).json()) as { job: { site: string; page?: boolean } };
    assert.deepEqual([one.job.site, one.job.page], ['https://pages.example.com/pricing', true]);
    const whole = (await (await post({ kind: 'copy', site: 'https://whole.example.com/pricing', by: 'owner' })).json()) as { job: { site: string; page?: boolean } };
    assert.deepEqual([whole.job.site, whole.job.page], ['https://whole.example.com', undefined]);
    assert.equal((await post({ kind: 'copy', site: 'pages2.example.com', page: 'yes', by: 'owner' })).status, 400);
  } finally {
    await s.done();
  }
});

test('jobs: drawing needs a written batch with at least one kept post, is asked for once, and answers with the same job after that', async () => {
  const s = await start();
  try {
    const draw = (brand: string, plan: string) => s.call(`/review/copy/${brand}/${plan}/draw`, { method: 'POST', body: JSON.stringify({ by: 'owner' }) });
    assert.equal((await draw('acme', 'week-01.json')).status, 404);
    new CopyStage(join(s.root, 'brands', 'acme'), 'acme').open('week-01.json', [{ postId: 'p1', headline: 'H one', caption: 'C one' }, { postId: 'p2', headline: 'H two', caption: 'C two' }]);
    assert.equal((await draw('acme', 'week-01.json')).status, 422);
    writeFileSync(join(s.root, 'brands', 'acme', 'brand.json'), JSON.stringify({ website: 'https://acme.example.com' }));
    const weekPost = (id: string) => ({ id, date: '2099-11-10T10:00:00+05:30', painPoint: 'p', mode: 'ai', headline: 'H', subline: '', caption: 'C', hashtags: [], imagePrompt: 'a picture' });
    writeFileSync(join(s.root, 'brands', 'acme', 'week-01.json'), JSON.stringify({ brand: 'acme', timezone: '+05:30', renderMode: 'ai_v1', posts: [weekPost('p1'), weekPost('p2')] }));
    assert.equal((await s.call('/review/copy/acme/week-01.json/draw', { method: 'POST', body: JSON.stringify({ by: 'owner', client: '../x' }) })).status, 400, 'a client name must be plain');
    await s.call('/review/copy/acme/week-01.json/p1/keep', { method: 'POST', body: JSON.stringify({ by: 'owner' }) });
    const first = await draw('acme', 'week-01.json');
    assert.equal(first.status, 202);
    const { job } = (await first.json()) as { job: { id: string; kind: string; planFile: string } };
    assert.deepEqual([job.kind, job.planFile], ['draw', 'week-01.json']);
    const record = JSON.parse(readFileSync(join(s.root, 'brands', 'acme', 'campaigns', 'manual-week-01.json'), 'utf8')) as { brand: string; plan: { platforms: string[] } };
    assert.deepEqual([record.brand, record.plan.platforms], ['acme', ['instagram']], 'the batch is recorded for the calendar under the site name when no client is given');
    const second = await draw('acme', 'week-01.json');
    assert.equal(second.status, 200);
    assert.equal(((await second.json()) as { job: { id: string } }).job.id, job.id);
    new CopyStage(join(s.root, 'brands', 'globex'), 'globex').open('week-01.json', [{ postId: 'p1', headline: 'H', caption: 'C' }]);
    await s.call('/review/copy/globex/week-01.json/p1/keep', { method: 'POST', body: JSON.stringify({ by: 'owner' }) });
    assert.equal((await draw('globex', 'week-01.json')).status, 422, 'a brand with no saved website cannot be drawn');
    await s.call('/review/copy/globex/week-01.json/close', { method: 'POST', body: JSON.stringify({ by: 'owner' }) });
    assert.equal((await draw('globex', 'week-01.json')).status, 409);
  } finally {
    await s.done();
  }
});

test('the sign-off of a written post can be changed over the API: the list shows the default and the choice, a foreign address is refused', async () => {
  const s = await start();
  try {
    const brandDir = join(s.root, 'brands', 'acme');
    writeFileSync(join(brandDir, 'brand.json'), JSON.stringify({ name: 'Acme', website: 'https://www.acme.com' }));
    const plan = { brand: 'acme', timezone: '+05:30', posts: [{ id: 'p1', headline: 'Answers from your own docs', subline: '', caption: 'The assistant answers from your pages.', hashtags: ['#acme'] }] };
    writeFileSync(join(brandDir, 'week-01.json'), JSON.stringify(plan));
    new CopyStage(brandDir, 'acme').open('week-01.json', [{ postId: 'p1', headline: plan.posts[0]?.headline ?? '', caption: 'The assistant answers from your pages.\n\n#acme' }]);
    const put = (body: unknown) => s.call('/review/copy/acme/week-01.json/p1/edit', { method: 'PUT', body: JSON.stringify(body) });
    type Listed = { batches: Array<{ signoffDefault?: { brandName: string; domain: string }; posts: Array<{ headline: string; signoff?: { brandName?: string; domain?: string } }> }> };
    const before = (await (await s.call('/review/copy')).json()) as Listed;
    assert.deepEqual(before.batches[0]?.signoffDefault, { brandName: '', domain: '', site: 'acme.com' }, 'a poster carries no name and no web address unless typed for it; site is where a typed address must be');
    assert.equal(before.batches[0]?.posts[0]?.signoff, undefined);

    const ok = await put({ by: 'owner', brandName: 'Acme Labs', domain: 'acme.com/pricing' });
    assert.equal(ok.status, 200);
    const after = (await (await s.call('/review/copy')).json()) as Listed;
    assert.deepEqual(after.batches[0]?.posts[0]?.signoff, { brandName: 'Acme Labs', domain: 'acme.com/pricing' });
    assert.equal(after.batches[0]?.posts[0]?.headline, 'Answers from your own docs');
    assert.deepEqual((JSON.parse(readFileSync(join(brandDir, 'week-01.json'), 'utf8')) as { posts: Array<{ signoff?: unknown }> }).posts[0]?.signoff, { brandName: 'Acme Labs', domain: 'acme.com/pricing' });

    const foreign = await put({ by: 'owner', domain: 'rival.com' });
    assert.equal(foreign.status, 422);
    assert.match(((await foreign.json()) as { error: string }).error, /own website/);
  } finally {
    await s.done();
  }
});

test('jobs: the day of the first post and the time can be chosen, are checked, and set the weekdays the posts fall on', async () => {
  const s = await start();
  try {
    const post = (body: unknown) => s.call('/review/jobs', { method: 'POST', body: JSON.stringify(body) });
    const day = (daysAhead: number): string => new Date(Date.now() + 5.5 * 3600_000 + daysAhead * 86_400_000).toISOString().slice(0, 10);
    const dayOfWeek = (date: string): string => ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date(`${date}T00:00:00Z`).getUTCDay()] as string;
    const first = day(10);
    const ok = await post({ kind: 'copy', site: 'https://acme.example.com', networks: ['linkedin'], weeks: 2, postsPerWeek: 1, startDate: first, time: '09:30', by: 'owner' });
    assert.equal(ok.status, 202);
    const { job } = (await ok.json()) as { job: { days: number; weekdays: string[]; startDate: string; time: string } };
    assert.deepEqual([job.days, job.weekdays, job.startDate, job.time], [2, [dayOfWeek(first)], first, '09:30'], 'the first post is on the chosen day');
    for (const bad of [{ startDate: day(0) }, { startDate: day(-3) }, { startDate: day(400) }, { startDate: '2026-02-30' }, { startDate: 'soon' }, { time: '25:00' }, { time: '9:30' }, { time: 930 }]) {
      assert.equal((await post({ kind: 'copy', site: 'https://beta.example.com', by: 'owner', ...bad })).status, 400, JSON.stringify(bad));
    }
    // With an exact number of posts the day and time still apply.
    const exact = await post({ kind: 'copy', site: 'https://gamma.example.com', days: 3, startDate: day(5), by: 'owner' });
    assert.equal(exact.status, 202);
    assert.equal(((await exact.json()) as { job: { startDate: string; time?: string } }).job.time, undefined, 'no time given: the engine default applies');
  } finally {
    await s.done();
  }
});

test('the written list also tells the page each network\'s caption rules', async () => {
  const s = await start();
  try {
    const answer = (await (await s.call('/review/copy')).json()) as { batches: unknown[]; networkRules: Record<string, { maxCaption: number; recommendedMin: number; recommendedMax: number; wordsMin?: number; wordsMax?: number; visibleChars: number; maxHashtags: number }> };
    assert.deepEqual(answer.batches, []);
    assert.deepEqual(Object.keys(answer.networkRules), ['instagram', 'facebook', 'linkedin', 'google']);
    assert.deepEqual(answer.networkRules['linkedin'], { maxCaption: 2400, recommendedMin: 900, recommendedMax: 2000, wordsMin: 150, wordsMax: 300, visibleChars: 125, maxHashtags: 3 });
  } finally {
    await s.done();
  }
});

function carouselOn(s: Awaited<ReturnType<typeof start>>): void {
  const store = s.stores.acme;
  for (const n of [1, 2, 3]) store.addVersion(version(s.pictures(`s${n}.jpg`, `slide ${n}`), { postId: `car1-s${n}`, headline: `Slide ${n}`, caption: '', carousel: { id: 'car1', position: n, count: 3 } }));
  for (const network of ['instagram', 'linkedin']) store.addVersion(version(s.pictures('cover.jpg', 'slide 1'), { postId: 'car1', network, headline: 'Choosing a curry', caption: `${network} caption`, carousel: { id: 'car1', position: 0, count: 3 } }));
}

test('the queue says which carousel a version belongs to, and a carousel is shown whole with its slides in order and its captions', async () => {
  const s = await start();
  try {
    carouselOn(s);
    const list = (await (await s.call('/review/posts')).json()) as { posts: Array<{ postId: string; carousel?: { id: string; position: number; count: number } }> };
    assert.equal(list.posts.filter((p) => p.carousel?.id === 'car1').length, 5);
    const view = (await (await s.call('/review/carousels/acme/car1')).json()) as { id: string; count: number; status: string; slides: Array<{ position: number; versionId: string; status: string; headline: string }>; captions: Array<{ network: string; caption: string }> };
    assert.equal(view.id, 'car1');
    assert.equal(view.count, 3);
    assert.equal(view.status, 'pending');
    assert.deepEqual(view.slides.map((x) => [x.position, x.headline, x.status]), [[1, 'Slide 1', 'pending'], [2, 'Slide 2', 'pending'], [3, 'Slide 3', 'pending']]);
    assert.deepEqual(view.captions.map((c) => c.network).sort(), ['instagram', 'linkedin']);
    // The slide's picture is served through the ordinary picture route, by version id.
    assert.equal(await (await s.call(`/review/posts/${view.slides[1]?.versionId}/image`)).text(), 'slide 2');
  } finally {
    await s.done();
  }
});

test('one step approves the whole carousel, and then it reads as approved; a rejection withdraws it all', async () => {
  const s = await start();
  try {
    carouselOn(s);
    const approved = await s.call('/review/carousels/acme/car1/approve', { method: 'POST', body: JSON.stringify({ by: 'owner' }) });
    assert.equal(approved.status, 200);
    assert.equal(((await approved.json()) as { status: string }).status, 'approved');
    assert.ok(s.stores.acme.list().every((i) => i.status === 'approved'));
    const rejected = await s.call('/review/carousels/acme/car1/reject', { method: 'POST', body: JSON.stringify({ by: 'owner', reason: 'style', comment: 'not our look' }) });
    assert.equal(rejected.status, 200);
    assert.equal(((await rejected.json()) as { status: string }).status, 'rejected');
  } finally {
    await s.done();
  }
});

test('a carousel that cannot be approved says why, an unknown one is not found, and a name or secret is needed', async () => {
  const s = await start();
  try {
    s.stores.acme.addVersion(version(s.pictures('s1.jpg', 'slide 1'), { postId: 'car1-s1', caption: '', carousel: { id: 'car1', position: 1, count: 3 } }));
    const missing = await s.call('/review/carousels/acme/car1/approve', { method: 'POST', body: JSON.stringify({ by: 'owner' }) });
    assert.equal(missing.status, 400);
    assert.match(((await missing.json()) as { error: string }).error, /slide 2 has no picture yet/);
    assert.equal(((await (await s.call('/review/carousels/acme/car1')).json()) as { status: string }).status, 'incomplete');
    assert.equal((await s.call('/review/carousels/acme/nope')).status, 404);
    assert.equal((await s.call('/review/carousels/nobrand/car1')).status, 404);
    assert.equal((await s.call('/review/carousels/acme/car1/approve', { method: 'POST', body: JSON.stringify({ by: '' }) })).status, 400);
    assert.equal((await s.call('/review/carousels/acme/car1', { auth: false })).status, 401);
    assert.equal((await s.call('/review/carousels/acme/car1/reject', { method: 'POST', body: JSON.stringify({ by: 'owner', reason: 'nonsense' }) })).status, 400);
  } finally {
    await s.done();
  }
});

test('jobs: a carousel can be asked for only for a client whose website was already read, needs a channel, and a second ask is the same job', async () => {
  const s = await start();
  try {
    const post = (body: unknown) => s.call('/review/jobs', { method: 'POST', body: JSON.stringify(body) });
    const ask = { kind: 'carousel', site: 'acme.example.com', networks: ['instagram', 'linkedin'], by: 'owner' };
    const unread = await post(ask);
    assert.equal(unread.status, 400);
    assert.match(((await unread.json()) as { error: string }).error, /not been read yet/);
    writeFileSync(join(s.root, 'brands', 'acme', 'brand.json'), '{}');
    const bad = [{ ...ask, networks: [] }, { ...ask, networks: ['tiktok'] }, { ...ask, startDate: '2020-01-01' }, { ...ask, time: '25:99' }, { ...ask, by: ' ' }];
    for (const body of bad) assert.equal((await post(body)).status, 400, JSON.stringify(body));
    const day = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    const first = await post({ ...ask, startDate: day, time: '11:30' });
    assert.equal(first.status, 202);
    const { job } = (await first.json()) as { job: { id: string; kind: string; brand: string; networks: string[]; startDate: string; time: string } };
    assert.deepEqual([job.kind, job.brand, job.networks, job.startDate, job.time], ['carousel', 'acme', ['instagram', 'linkedin'], day, '11:30']);
    const again = await post(ask);
    assert.equal(again.status, 200);
    assert.equal(((await again.json()) as { job: { id: string } }).job.id, job.id);
  } finally {
    await s.done();
  }
});

test('jobs: a topic is written from the customer\'s own words, for a client whose website was already read; her words are kept as typed and a second ask is the same job', async () => {
  const s = await start();
  try {
    const post = (body: unknown) => s.call('/review/jobs', { method: 'POST', body: JSON.stringify(body) });
    const ask = { kind: 'topic', site: 'acme.example.com', networks: ['instagram', 'linkedin'], by: 'owner', text: 'Diwali special: 20% off all thalis until 2 Nov.' };
    const unread = await post(ask);
    assert.equal(unread.status, 400);
    assert.match(((await unread.json()) as { error: string }).error, /not been read yet/);
    const dir = join(s.root, 'brands', 'acme');
    writeFileSync(join(dir, 'brand.json'), '{}');
    writeFileSync(join(dir, 'facts.json'), JSON.stringify({ version: 1, builtAt: '2026-11-01T00:00:00Z', site: 'https://acme.example.com', facts: [], conflicts: [], snapshots: [], coverage: { pages: 0, structured: 0, flatText: 0, usable: 0, needsReview: 0, excluded: 0, notes: [] } }));
    const bad: Array<[unknown, RegExp]> = [
      [{ ...ask, networks: ['tiktok'] }, /networks must be/],
      [{ ...ask, startDate: '2020-01-01' }, /./],
      [{ ...ask, by: ' ' }, /./],
      [{ ...ask, text: 'hi' }, /a little more/],
      [{ ...ask, text: 'See https://acme.example.com/diwali for the offer' }, /Links are not read/],
      [{ ...ask, text: 'The best thali in town, 20% off' }, /needs proof/],
      [{ ...ask, text: undefined }, /Write what the post is about/],
    ];
    for (const [body, message] of bad) {
      const answer = await post(body);
      assert.equal(answer.status, 400, JSON.stringify(body));
      assert.match(((await answer.json()) as { error: string }).error, message);
    }
    assert.equal(existsSync(join(dir, 'customer-facts.json')) ? readFileSync(join(dir, 'customer-facts.json'), 'utf8') : false, false, 'nothing refused is kept');
    const first = await post(ask);
    assert.equal(first.status, 202, JSON.stringify(await first.clone().json()));
    const { job } = (await first.json()) as { job: { id: string; kind: string; brand: string; networks: string[]; topicId: string } };
    assert.deepEqual([job.kind, job.brand, job.networks], ['topic', 'acme', ['instagram', 'linkedin']]);
    assert.match(job.topicId, /^t-[a-z0-9]+-[a-f0-9]{6}$/);
    assert.ok(readFileSync(join(dir, 'customer-facts.json'), 'utf8').includes('20% off all thalis until 2 Nov'), 'her words are kept as typed');
    assert.doesNotMatch(JSON.stringify(job), /Diwali/, 'the job does not carry her words');
    const again = await post({ ...ask, text: 'A different text that must not replace the first one.' });
    assert.equal(again.status, 200);
    assert.equal(((await again.json()) as { job: { id: string } }).job.id, job.id);
    assert.equal(JSON.parse(readFileSync(join(dir, 'customer-facts.json'), 'utf8')).statements.length, 1, 'the second ask kept nothing');
  } finally {
    await s.done();
  }
});
