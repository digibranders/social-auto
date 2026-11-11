import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { EngineError, engineFromEnv, WorkspaceEngine, type EngineConfig } from './engine-client.ts';

const SECRET = 'engine-secret-0123456789';

interface Seen {
  method: string;
  url: string;
  authorization: string | undefined;
  brand: string | undefined;
  actor: string | undefined;
  body: Record<string, unknown> | null;
}

/** A pretend review service. `answer` decides what it says; every request it gets is kept in `seen`. */
async function fakeEngine(answer: (seen: Seen) => { status: number; body: unknown; delayMs?: number }): Promise<{ config: EngineConfig; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const server: Server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const entry: Seen = { method: req.method ?? '', url: req.url ?? '', authorization: req.headers['authorization'], brand: req.headers['x-brand'] as string | undefined, actor: req.headers['x-actor'] as string | undefined, body: text ? (JSON.parse(text) as Record<string, unknown>) : null };
      seen.push(entry);
      const reply = answer(entry);
      setTimeout(() => {
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply.body));
      }, reply.delayMs ?? 0);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { config: { url: `http://127.0.0.1:${port}`, productSecrets: { brandbasket: SECRET, otherapp: 'other-secret-0123456789' }, timeoutMs: 400 }, seen, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

const job = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'job-abc123-0123abcd', key: 'copy:shop-one-aaaaaa', kind: 'copy', brand: 'shop-one-aaaaaa', site: 'https://acme.example.com', by: 'product:brandbasket:u1', networks: ['instagram'], days: 3,
  state: 'running', step: 2, createdAt: '2026-11-11T08:00:00.000Z', startedAt: '2026-11-11T08:00:05.000Z', runnerPid: 4242, logTail: ['AI: OpenAI (key sk-secret...)', '/home/social/x'], ...over,
});

test('the settings of the engine come from the environment, and a missing or weak one means "not set up"', () => {
  assert.equal(engineFromEnv({}), null);
  assert.equal(engineFromEnv({ REVIEW_URL: 'http://127.0.0.1:4012' }), null);
  assert.equal(engineFromEnv({ REVIEW_URL: 'http://127.0.0.1:4012', REVIEW_PRODUCT_SECRETS: 'brandbasket:short' }), null);
  assert.equal(engineFromEnv({ REVIEW_URL: 'http://127.0.0.1:4012', REVIEW_PRODUCT_SECRETS: `:${SECRET}` }), null);
  assert.equal(engineFromEnv({ REVIEW_URL: 'not a url', REVIEW_PRODUCT_SECRETS: `brandbasket:${SECRET}` }), null);
  assert.equal(engineFromEnv({ REVIEW_URL: 'http://127.0.0.1:4012', REVIEW_SECRET: SECRET }), null, 'the staff secret is never used for a product');
  assert.deepEqual(engineFromEnv({ REVIEW_URL: 'http://127.0.0.1:4012/', REVIEW_PRODUCT_SECRETS: `brandbasket:${SECRET}, other:other-secret-0123456789` }), { url: 'http://127.0.0.1:4012', productSecrets: { brandbasket: SECRET, other: 'other-secret-0123456789' } });
});

test('a site job is started with the product\'s own secret, under the workspace\'s own brand and as the person named, and only safe fields come back', async () => {
  const engine = await fakeEngine(() => ({ status: 202, body: { job: job({ state: 'queued', step: undefined }), created: true } }));
  try {
    const shop = new WorkspaceEngine(engine.config, 'brandbasket', 'shop-one-aaaaaa');
    const made = await shop.startSiteJob({ site: 'https://acme.example.com', networks: ['instagram', 'linkedin'], page: false, actor: 'brandbasket:u1' });
    assert.equal(engine.seen.length, 1);
    const sent = engine.seen[0] as Seen;
    assert.deepEqual([sent.method, sent.url, sent.authorization], ['POST', '/review/jobs', `Bearer ${SECRET}`]);
    assert.deepEqual([sent.brand, sent.actor], ['shop-one-aaaaaa', 'brandbasket:u1']);
    assert.deepEqual(sent.body, { kind: 'copy', site: 'https://acme.example.com', networks: ['instagram', 'linkedin'], brand: 'shop-one-aaaaaa' });
    assert.deepEqual(made, { job: { id: 'job-abc123-0123abcd', kind: 'write', state: 'queued', createdAt: '2026-11-11T08:00:00.000Z' }, created: true });
    assert.doesNotMatch(JSON.stringify(made), /runnerPid|logTail|sk-secret|home\/social|product:brandbasket|key/);
  } finally {
    await engine.close();
  }
});

test('two customers with the same website go to the engine under two different brands', async () => {
  const engine = await fakeEngine((seen) => ({ status: 202, body: { job: job({ brand: String(seen.body?.['brand']), id: `job-abc${String(seen.body?.['brand']).length}-0123abcd` }), created: true } }));
  try {
    await new WorkspaceEngine(engine.config, 'brandbasket', 'shop-one-aaaaaa').startSiteJob({ site: 'https://acme.example.com', networks: ['instagram'], page: false, actor: 'brandbasket:u1' });
    await new WorkspaceEngine(engine.config, 'brandbasket', 'shop-two-bbbbbb').startSiteJob({ site: 'https://acme.example.com', networks: ['instagram'], page: false, actor: 'brandbasket:u2' });
    assert.deepEqual(engine.seen.map((s) => s.body?.['brand']), ['shop-one-aaaaaa', 'shop-two-bbbbbb']);
    assert.deepEqual(engine.seen.map((s) => s.brand), ['shop-one-aaaaaa', 'shop-two-bbbbbb'], 'X-Brand names the same brand');
  } finally {
    await engine.close();
  }
});

test('the jobs of a workspace are asked for under its brand header, and a job of another brand is never passed on even if the engine sends it', async () => {
  const engine = await fakeEngine(() => ({ status: 200, body: { jobs: [job({ id: 'job-abc123-0123abcd' }), job({ id: 'job-def456-0123abcd', brand: 'shop-two-bbbbbb' }), job({ id: 'job-fff000-0123abcd', state: 'succeeded', finishedAt: '2026-11-11T08:03:00.000Z', planFileMade: 'week-02.json' })] } }));
  try {
    const listed = await new WorkspaceEngine(engine.config, 'brandbasket', 'shop-one-aaaaaa').listJobs('brandbasket:service');
    assert.deepEqual([engine.seen[0]?.url, engine.seen[0]?.brand, engine.seen[0]?.actor, engine.seen[0]?.authorization], ['/review/jobs', 'shop-one-aaaaaa', 'brandbasket:service', `Bearer ${SECRET}`]);
    assert.deepEqual(listed.map((j) => j.id), ['job-abc123-0123abcd', 'job-fff000-0123abcd']);
    assert.deepEqual(listed.map((j) => j.state), ['running', 'done']);
    assert.equal(listed[0]?.step, 2);
    assert.equal(listed[1]?.finishedAt, '2026-11-11T08:03:00.000Z');
  } finally {
    await engine.close();
  }
});

test('one job is read only when it belongs to the workspace; another workspace\'s job looks like one that does not exist', async () => {
  const engine = await fakeEngine((seen) => (seen.url.endsWith('job-def456-0123abcd') ? { status: 200, body: { job: job({ id: 'job-def456-0123abcd', brand: 'shop-two-bbbbbb' }) } } : { status: 200, body: { job: job() } }));
  try {
    const shop = new WorkspaceEngine(engine.config, 'brandbasket', 'shop-one-aaaaaa');
    assert.equal((await shop.getJob('job-abc123-0123abcd', 'brandbasket:u1')).id, 'job-abc123-0123abcd');
    await assert.rejects(shop.getJob('job-def456-0123abcd', 'brandbasket:u1'), (e: unknown) => e instanceof EngineError && e.status === 404);
    const before = engine.seen.length;
    for (const bad of ['../x', 'job-abc', 'JOB-ABC123-0123ABCD', 'job-abc123-0123abcd/../../x', '']) await assert.rejects(shop.getJob(bad, 'brandbasket:u1'), (e: unknown) => e instanceof EngineError && e.status === 404, bad);
    assert.equal(engine.seen.length, before, 'a malformed id never reaches the engine');
  } finally {
    await engine.close();
  }
});

test('an engine that is down, slow or broken is "not available", and nothing it said reaches the caller', async () => {
  const slow = await fakeEngine(() => ({ status: 200, body: { jobs: [] }, delayMs: 1500 }));
  try {
    await assert.rejects(new WorkspaceEngine(slow.config, 'brandbasket', 'shop-one-aaaaaa').listJobs('brandbasket:u1'), (e: unknown) => e instanceof EngineError && e.status === 503);
  } finally {
    await slow.close();
  }
  const broken = await fakeEngine(() => ({ status: 500, body: { error: 'ENOENT: /home/social/social-auto/scheduler/engine/brands/x token=abc' } }));
  try {
    await assert.rejects(new WorkspaceEngine(broken.config, 'brandbasket', 'shop-one-aaaaaa').listJobs('brandbasket:u1'), (e: unknown) => e instanceof EngineError && e.status === 503 && !/ENOENT|home\/social|token/.test(e.message));
  } finally {
    await broken.close();
  }
  const refusing = await fakeEngine(() => ({ status: 409, body: { error: 'that brand name is not available' } }));
  try {
    await assert.rejects(new WorkspaceEngine(refusing.config, 'brandbasket', 'shop-one-aaaaaa').startSiteJob({ site: 'https://other.example.net', networks: ['instagram'], page: false, actor: 'brandbasket:u1' }), (e: unknown) => e instanceof EngineError && e.status === 409 && e.code === 'CONFLICT' && !/brand name/.test(e.message));
  } finally {
    await refusing.close();
  }
  const down = await fakeEngine(() => ({ status: 200, body: {} }));
  await down.close();
  await assert.rejects(new WorkspaceEngine(down.config, 'brandbasket', 'shop-one-aaaaaa').listJobs('brandbasket:u1'), (e: unknown) => e instanceof EngineError && e.status === 503 && !e.message.includes(SECRET));
});

test('a brand that is not a safe name, or a product with no secret, is refused when the client is made', () => {
  const config: EngineConfig = { url: 'http://127.0.0.1:1', productSecrets: { brandbasket: SECRET } };
  for (const bad of ['', 'Shop One', '../x', 'a'.repeat(64), '-x']) assert.throws(() => new WorkspaceEngine(config, 'brandbasket', bad), /brand/, JSON.stringify(bad));
  assert.throws(() => new WorkspaceEngine(config, 'otherapp', 'shop-one-aaaaaa'), /no secret/);
});
