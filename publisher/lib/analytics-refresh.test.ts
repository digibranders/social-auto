import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { POST as refreshPost } from '../api/analytics-refresh.ts';

async function withEnv(run: () => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'refresh-'));
  const names = ['LOCAL_STORE_DIR', 'CHANNEL_KEY', 'EDIT_SECRET', 'ANALYTICS_ENABLED', 'BLOB_READ_WRITE_TOKEN', 'INSTAGRAM_TOKEN', 'INSTAGRAM_USER_ID'];
  const before = Object.fromEntries(names.map((k) => [k, process.env[k]]));
  Object.assign(process.env, { LOCAL_STORE_DIR: dir, CHANNEL_KEY: '77'.repeat(32), EDIT_SECRET: 'edit-secret-0123456789' });
  for (const k of ['ANALYTICS_ENABLED', 'BLOB_READ_WRITE_TOKEN', 'INSTAGRAM_TOKEN', 'INSTAGRAM_USER_ID']) delete process.env[k];
  const logged = console.error;
  console.error = (): void => undefined;
  try {
    await run();
  } finally {
    console.error = logged;
    for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await rm(dir, { recursive: true, force: true });
  }
}

const req = (json?: unknown, secret: string | null = 'edit-secret-0123456789'): Request => new Request('https://social.example.test/api/analytics-refresh', { method: 'POST', headers: { ...(secret ? { authorization: `Bearer ${secret}` } : {}), 'content-type': 'application/json' }, body: JSON.stringify(json ?? {}) });

test('the refresh endpoint needs the write secret, a client, and analytics switched on; with nothing connected it reads nothing and says so', async () => {
  await withEnv(async () => {
    assert.equal((await refreshPost(req({ brand: 'acme' }, null))).status, 401);
    assert.equal((await refreshPost(req({ brand: 'acme' }, 'wrong'))).status, 401);
    assert.equal((await refreshPost(req({}))).status, 400);
    assert.equal((await refreshPost(req({ brand: 'a b' }))).status, 400);
    const done = await refreshPost(req({ brand: 'acme' }));
    assert.equal(done.status, 200);
    assert.deepEqual(await done.json(), { posts: 0, accounts: 0, failed: 0 });
    process.env['ANALYTICS_ENABLED'] = 'false';
    assert.equal((await refreshPost(req({ brand: 'acme' }))).status, 503);
  });
});
