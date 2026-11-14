import { nextMonday } from './plan-days.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GET as jobsGet, POST as jobsPost } from '../api/_v1/site-jobs.ts';
import { GET as workspacesGet, POST as workspacesPost } from '../api/_v1/workspaces.ts';
import { ERROR_CODES, type ErrorCode } from './api-error.ts';
import { addLinkedInMember } from './channels.ts';
import { parseKey } from './crypto.ts';
import { call, CHANNEL_KEY, ENGINE_SECRET, fakeEngine, KEY, OTHER_KEY, withProducts, type Answer, type FakeJob } from '../dev/product-test-kit.ts';
import { loadClients, saveChannels } from './store.ts';

function expectError(answer: Answer, status: number, code: ErrorCode, label: string): void {
  assert.equal(answer.status, status, `${label}: status (${JSON.stringify(answer.body)})`);
  assert.equal(answer.body['code'], code, `${label}: code (${JSON.stringify(answer.body)})`);
  assert.ok(ERROR_CODES.includes(code), `${label}: a listed code`);
  assert.equal(typeof answer.body['error'], 'string');
  assert.deepEqual(Object.keys(answer.body).sort(), ['code', 'error'], `${label}: only code and error`);
}

/** A workspace of the "brandbasket" product, with a LinkedIn account when asked. */
async function workspace(externalId: string, withAccount: boolean, key = KEY): Promise<string> {
  const made = await call(workspacesPost, '/api/v1/workspaces', { key, json: { externalId, name: externalId } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const brand = String((made.body['workspace'] as { id: string }).id);
  if (withAccount) {
    const { file } = await import('./store.ts').then((m) => m.loadChannels());
    await saveChannels(addLinkedInMember(file, brand, { urn: `urn:li:person:${externalId.replace(/[^a-z0-9]/g, '')}abc`, name: 'Test Member' }, 'token', 5_000_000, parseKey(CHANNEL_KEY), Date.now() - 3600_000), (await import('./store.ts').then((m) => m.loadChannels())).etag);
  }
  return brand;
}

const start = (externalId: string, json: Record<string, unknown> = {}, headers: Record<string, string> = {}, key = KEY): Promise<Answer> =>
  call(jobsPost, '/api/v1/site-jobs', { key, headers, json: { externalId, site: 'https://www.acme.example.com', ...json } });

test('a site job is started under the workspace\'s own brand, with the monthly rhythm (4 weeks of 5 posts from the next Monday), the connected networks and the person recorded', async () => {
  await withProducts(async () => {
    const engine = await fakeEngine();
    try {
      const brand = await workspace('shop-1', true);
      const made = await start('shop-1', {}, { 'x-social-actor': 'user_42' });
      assert.equal(made.status, 202, JSON.stringify(made.body));
      assert.equal(made.body['created'], true);
      const job = made.body['job'] as Record<string, unknown>;
      assert.deepEqual(Object.keys(job).sort(), ['createdAt', 'id', 'kind', 'networks', 'state']);
      assert.deepEqual(job['networks'], ['linkedin'], 'which channels the batch is being written for');
      assert.deepEqual([job['kind'], job['state']], ['write', 'queued']);

      const sent = engine.seen.find((s) => s.method === 'POST' && s.url === '/review/jobs');
      assert.equal(sent?.authorization, `Bearer ${ENGINE_SECRET}`);
      assert.deepEqual([sent?.brand, sent?.actor], [brand, 'brandbasket:user_42']);
      assert.deepEqual(sent?.body, { kind: 'copy', site: 'https://www.acme.example.com', networks: ['linkedin'], brand, weeks: 4, postsPerWeek: 5, startDate: nextMonday(Date.now()) });

      // The workspace is now bound to that website.
      const bound = (await loadClients()).file.clients.find((c) => c.brand === brand);
      assert.equal(bound?.website, 'https://www.acme.example.com');

      // Asking again while it waits is the same job, not a second one.
      const again = await start('shop-1');
      assert.equal(again.status, 200);
      assert.equal(again.body['created'], false);
      assert.equal((again.body['job'] as { id: string }).id, job['id']);
      assert.equal(engine.jobs.length, 1);
      // Without a person the product itself is recorded.
      assert.equal(engine.seen.filter((s) => s.method === 'POST').length, 2);
    } finally {
      await engine.close();
    }
  });
});

test('the networks are the ones asked for, or the connected ones; none connected and none asked for is refused', async () => {
  await withProducts(async () => {
    const engine = await fakeEngine();
    try {
      await workspace('shop-1', true);
      await workspace('shop-2', false);
      expectError(await start('shop-1', { networks: ['tiktok'] }), 400, 'INVALID_NETWORKS', 'unknown network');
      expectError(await start('shop-1', { networks: 'linkedin' }), 400, 'INVALID_NETWORKS', 'networks not a list');
      expectError(await start('shop-1', { networks: [] }), 400, 'INVALID_NETWORKS', 'no network chosen');
      expectError(await start('shop-2'), 400, 'CHANNEL_NOT_CONNECTED', 'nothing connected and nothing asked for');
      assert.equal(engine.jobs.length, 0, 'nothing reached the engine');
      assert.equal((await start('shop-2', { networks: ['instagram', 'linkedin', 'instagram'] })).status, 202, 'a chosen network need not be connected yet');
      assert.deepEqual(engine.jobs[0]?.networks, ['instagram', 'linkedin'], 'repeats are dropped');
    } finally {
      await engine.close();
    }
  });
});

test('a workspace keeps one website, and a bad address is refused before the engine is asked', async () => {
  await withProducts(async () => {
    const engine = await fakeEngine();
    try {
      await workspace('shop-1', true);
      for (const bad of ['not a site', 'localhost', 'http://127.0.0.1', 'ftp://acme.example.com', '']) expectError(await start('shop-1', { site: bad }), 400, 'INVALID_SITE', JSON.stringify(bad));
      expectError(await call(jobsPost, '/api/v1/site-jobs', { json: { externalId: 'shop-1' } }), 400, 'INVALID_SITE', 'no site');
      assert.equal(engine.seen.length, 0);
      assert.equal((await start('shop-1')).status, 202);
      expectError(await start('shop-1', { site: 'https://different.example.net' }), 400, 'SITE_MISMATCH', 'another website');
      assert.equal((await start('shop-1', { site: 'acme.example.com/pricing' })).status, 200, 'the same website written another way is the same');
      assert.equal(engine.jobs.length, 1);
    } finally {
      await engine.close();
    }
  });
});

test('two customers with the same website get two brands, and each sees only its own jobs', async () => {
  await withProducts(async () => {
    const engine = await fakeEngine();
    try {
      const one = await workspace('shop-1', true);
      const two = await workspace('shop-2', true);
      const madeOne = (await start('shop-1')).body['job'] as { id: string };
      const madeTwo = (await start('shop-2')).body['job'] as { id: string };
      assert.notEqual(madeOne.id, madeTwo.id);
      assert.deepEqual(engine.jobs.map((j) => j.brand).sort(), [one, two].sort());
      const listOne = await call(jobsGet, '/api/v1/site-jobs?externalId=shop-1');
      assert.deepEqual((listOne.body['jobs'] as Array<{ id: string }>).map((j) => j.id), [madeOne.id]);
      assert.deepEqual(((await call(jobsGet, '/api/v1/site-jobs?externalId=shop-2')).body['jobs'] as Array<{ id: string }>).map((j) => j.id), [madeTwo.id]);
      // One job, by id: its own is found, another customer's is "no such job", and so is anything that is not a job id.
      assert.equal(((await call(jobsGet, `/api/v1/site-jobs?externalId=shop-1&jobId=${madeOne.id}`)).body['job'] as { id: string }).id, madeOne.id);
      expectError(await call(jobsGet, `/api/v1/site-jobs?externalId=shop-1&jobId=${madeTwo.id}`), 404, 'JOB_NOT_FOUND', 'another customer\'s job');
      expectError(await call(jobsGet, '/api/v1/site-jobs?externalId=shop-1&jobId=../x'), 404, 'JOB_NOT_FOUND', 'not a job id');
    } finally {
      await engine.close();
    }
  });
});

test('another product never reaches a workspace it did not create', async () => {
  await withProducts(async () => {
    const engine = await fakeEngine();
    try {
      await workspace('shop-1', true);
      await start('shop-1');
      expectError(await call(jobsGet, '/api/v1/site-jobs?externalId=shop-1', { key: OTHER_KEY }), 404, 'WORKSPACE_NOT_FOUND', 'list by another product');
      expectError(await start('shop-1', {}, {}, OTHER_KEY), 404, 'WORKSPACE_NOT_FOUND', 'start by another product');
      expectError(await call(jobsGet, '/api/v1/site-jobs?externalId=shop-1', { key: null }), 401, 'UNAUTHORIZED', 'no key');
      expectError(await call(jobsGet, '/api/v1/site-jobs'), 400, 'INVALID_EXTERNAL_ID', 'no externalId');
      expectError(await start('nobody'), 404, 'WORKSPACE_NOT_FOUND', 'unknown workspace');
      assert.equal(engine.jobs.length, 1);
    } finally {
      await engine.close();
    }
  });
});

test('a malformed person is refused, and a missing one is allowed for starting a job', async () => {
  await withProducts(async () => {
    const engine = await fakeEngine();
    try {
      await workspace('shop-1', true);
      expectError(await start('shop-1', {}, { 'x-social-actor': 'has space' }), 400, 'INVALID_ACTOR', 'bad person');
      assert.equal((await start('shop-1')).status, 202);
      assert.equal(engine.jobs[0]?.by, 'brandbasket:service', 'without a person only the product is recorded');
    } finally {
      await engine.close();
    }
  });
});

test('PRODUCT_LIMITS=off lifts the day and month limits on batches, and only exactly "off" does', async () => {
  const before = process.env['PRODUCT_LIMITS'];
  try {
    await withProducts(async () => {
      const engine = await fakeEngine();
      try {
        const brand = await workspace('shop-1', true);
        const done = (hoursAgo: number, n: number): FakeJob => ({ id: `job-b${n.toString(36).padStart(5, '0')}-0123abcd`, key: `copy:${brand}`, kind: 'copy', brand, site: 'https://acme.example.com', by: 'product:brandbasket', networks: ['instagram'], state: 'succeeded', createdAt: new Date(Date.now() - hoursAgo * 3_600_000).toISOString() });
        engine.jobs.push(...Array.from({ length: 10 }, (_, i) => done(i / 4 + 0.5, i + 1)));
        for (const value of [undefined, 'on', 'OFF']) {
          if (value === undefined) delete process.env['PRODUCT_LIMITS'];
          else process.env['PRODUCT_LIMITS'] = value;
          expectError(await start('shop-1'), 429, 'JOB_LIMIT_REACHED', `limits are on (${value})`);
        }
        process.env['PRODUCT_LIMITS'] = 'off';
        assert.equal((await start('shop-1')).status, 202, 'ten in a day and in a month, and another is allowed');
      } finally {
        await engine.close();
      }
    });
  } finally {
    if (before === undefined) delete process.env['PRODUCT_LIMITS'];
    else process.env['PRODUCT_LIMITS'] = before;
  }
});

test('a customer may start only so many batches a day and a month, but a job already waiting is always returned', async () => {
  await withProducts(async () => {
    const engine = await fakeEngine();
    try {
      const brand = await workspace('shop-1', true);
      const done = (hoursAgo: number, n: number): FakeJob => ({ id: `job-b${n.toString(36).padStart(5, '0')}-0123abcd`, key: `copy:${brand}`, kind: 'copy', brand, site: 'https://acme.example.com', by: 'product:brandbasket', networks: ['linkedin'], state: 'succeeded', createdAt: new Date(Date.now() - hoursAgo * 3600_000).toISOString(), finishedAt: new Date(Date.now() - hoursAgo * 3600_000 + 60_000).toISOString() });
      engine.jobs.push(done(1, 1), done(2, 2), done(3, 3));
      expectError(await start('shop-1'), 429, 'JOB_LIMIT_REACHED', 'three today');
      assert.equal(engine.jobs.length, 3, 'nothing new was made');
      // Older jobs count against the month, not the day.
      engine.jobs.length = 0;
      for (let n = 1; n <= 10; n += 1) engine.jobs.push(done(48 + n, n));
      expectError(await start('shop-1'), 429, 'JOB_LIMIT_REACHED', 'ten this month');
      engine.jobs.length = 0;
      for (let n = 1; n <= 9; n += 1) engine.jobs.push(done(48 + n, n));
      assert.equal((await start('shop-1')).status, 202, 'nine this month is still allowed');
      // A job already waiting is returned even at the limit.
      engine.jobs.length = 0;
      engine.jobs.push(done(1, 1), done(2, 2), done(3, 3), { ...done(0.1, 4), state: 'running' });
      const again = await start('shop-1');
      assert.equal(again.status, 200);
      assert.equal(again.body['created'], false);
    } finally {
      await engine.close();
    }
  });
});

test('an engine that is not set up or not running is "not available", and says nothing else', async () => {
  await withProducts(async () => {
    await workspace('shop-1', true);
    delete process.env['REVIEW_URL'];
    delete process.env['REVIEW_PRODUCT_SECRETS'];
    expectError(await start('shop-1'), 503, 'ENGINE_UNAVAILABLE', 'not set up');
    expectError(await call(jobsGet, '/api/v1/site-jobs?externalId=shop-1'), 503, 'ENGINE_UNAVAILABLE', 'not set up, list');
    const engine = await fakeEngine();
    await engine.close();
    const down = await start('shop-1');
    expectError(down, 503, 'ENGINE_UNAVAILABLE', 'not running');
    assert.doesNotMatch(JSON.stringify(down.body), new RegExp(ENGINE_SECRET));
    const brand = String(((await call(workspacesGet, '/api/v1/workspaces?externalId=shop-1')).body['workspace'] as { id: string }).id);
    assert.equal((await loadClients()).file.clients.find((c) => c.brand === brand)?.website, undefined, 'a job that never started leaves no website bound');
  });
});

test('a workspace read shows its channels and, once a job was started, the customer\'s website (read only)', async () => {
  await withProducts(async () => {
    const engine = await fakeEngine();
    try {
      await workspace('shop-1', true);
      await start('shop-1');
      const read = await call(workspacesGet, '/api/v1/workspaces?externalId=shop-1');
      assert.deepEqual(Object.keys(read.body['workspace'] as object).sort(), ['approvalMode', 'archived', 'autoPosting', 'channels', 'externalId', 'group', 'id', 'name', 'notices', 'paused', 'website']);
      assert.equal((read.body['workspace'] as Record<string, unknown>)['website'], 'https://www.acme.example.com');
    } finally {
      await engine.close();
    }
  });
});

test('a customer who gives one page to read gets that page read: the page address goes to the poster service, the saved website stays the host alone', async () => {
  await withProducts(async () => {
    const engine = await fakeEngine();
    try {
      const brand = await workspace('shop-1', true);
      const made = await start('shop-1', { site: 'https://www.acme.example.com/services/?utm=x#top', page: true });
      assert.equal(made.status, 202, JSON.stringify(made.body));
      const sent = engine.seen.find((s) => s.method === 'POST' && s.url === '/review/jobs');
      assert.equal(sent?.body?.['site'], 'https://www.acme.example.com/services', 'the path is kept, the query and the anchor are not');
      assert.equal(sent?.body?.['page'], true);
      assert.equal((await loadClients()).file.clients.find((c) => c.brand === brand)?.website, 'https://www.acme.example.com', 'the workspace keeps the host only');
      // Without page the path is dropped, as before.
      engine.jobs.length = 0;
      engine.seen.length = 0;
      assert.equal((await start('shop-1', { site: 'https://www.acme.example.com/services' })).status, 202);
      assert.equal(engine.seen.find((s) => s.method === 'POST' && s.url === '/review/jobs')?.body?.['site'], 'https://www.acme.example.com');
      // The same checks apply to a page address; another website is still refused.
      engine.jobs.length = 0;
      expectError(await start('shop-1', { site: 'https://different.example.net/page', page: true }), 400, 'SITE_MISMATCH', 'another website');
      expectError(await start('shop-1', { site: 'http://127.0.0.1/page', page: true }), 400, 'INVALID_SITE', 'a local address');
    } finally {
      await engine.close();
    }
  });
});

test('a job says which channels it is for: a write job and a draw job list them, unknown names and empty lists are left out', async () => {
  await withProducts(async () => {
    const engine = await fakeEngine();
    try {
      const brand = await workspace('shop-1', true);
      const make = (n: number, kind: FakeJob['kind'], networks: string[]): FakeJob => ({ id: `job-n${n.toString(36).padStart(5, '0')}-0123abcd`, key: `${kind}:${n}`, kind, brand, site: 'https://acme.example', by: 'x', networks, state: 'succeeded', createdAt: new Date(Date.now() - n * 1000).toISOString() });
      engine.jobs.push(make(1, 'copy', ['instagram']), make(2, 'draw', ['facebook', 'tiktok']), make(3, 'copy', []), make(4, 'topic', ['linkedin']));
      const listed = await call(jobsGet, '/api/v1/site-jobs?externalId=shop-1');
      const jobs = listed.body['jobs'] as Array<{ kind: string; networks?: string[] }>;
      assert.deepEqual(jobs.map((j) => [j.kind, j.networks ?? null]), [['write', ['instagram']], ['draw', ['facebook']], ['write', null], ['topic', null]], 'only write, draw and network jobs say it; nothing invented');
      assert.ok(brand);
    } finally {
      await engine.close();
    }
  });
});

test('with the weekly carousel on a week is 3 single posts (Monday, Tuesday, Thursday) and the carousel; off it stays 5; her saved days and what the call says always win', async () => {
  const { PUT: schedulePut } = await import('../api/_v1/schedule.ts');
  await withProducts(async () => {
    const engine = await fakeEngine();
    try {
      await workspace('shop-1', true);
      const sent = (): Record<string, unknown> => engine.seen.filter((s) => s.method === 'POST' && s.url === '/review/jobs').at(-1)?.body as Record<string, unknown>;
      const again = async (json: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
        engine.jobs.length = 0;
        assert.equal((await start('shop-1', json)).status, 202);
        return sent();
      };

      engine.carouselWeekly = false;
      let body = await again();
      assert.deepEqual([body['postsPerWeek'], body['weekdays']], [5, undefined], 'carousel off: 5 singles as before');

      engine.carouselWeekly = true;
      body = await again();
      assert.deepEqual(body['weekdays'], ['mon', 'tue', 'thu'], 'carousel on: 3 singles, the Friday left for the carousel');
      assert.equal((body['weeks'] as number) * (body['weekdays'] as string[]).length, 12, 'four weeks of 3');

      body = await again({ postsPerWeek: 4 });
      assert.deepEqual([body['postsPerWeek'], body['weekdays']], [4, undefined], 'a number asked for in the call wins');
      body = await again({ weekdays: ['mon', 'wed'] });
      assert.deepEqual(body['weekdays'], ['mon', 'wed'], 'days named in the call win');

      assert.equal((await call(schedulePut, '/api/v1/schedule', { method: 'PUT', json: { externalId: 'shop-1', channels: { linkedin: ['tue', 'fri'] } } })).status, 200);
      body = await again();
      assert.deepEqual(body['weekdays'], ['tue', 'fri'], 'her own saved days win');
    } finally {
      await engine.close();
    }
  });
});
