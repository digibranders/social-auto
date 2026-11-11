import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GET as analyticsGet } from '../api/_v1/analytics.ts';
import { GET as collectGet } from '../api/analytics-collect.ts';
import { POST as workspacesPost } from '../api/_v1/workspaces.ts';
import { call, OTHER_KEY, withProducts } from '../dev/product-test-kit.ts';
import { recordAccount, recordPost, EMPTY_ANALYTICS } from './analytics.ts';
import { loadAnalytics, saveAnalytics } from './store.ts';

async function withAnalytics(on: boolean, run: () => Promise<void>): Promise<void> {
  const before = process.env['ANALYTICS_ENABLED'];
  if (on) delete process.env['ANALYTICS_ENABLED'];
  else process.env['ANALYTICS_ENABLED'] = 'false';
  try {
    await run();
  } finally {
    if (before === undefined) delete process.env['ANALYTICS_ENABLED'];
    else process.env['ANALYTICS_ENABLED'] = before;
  }
}

test('GET /api/v1/analytics gives a customer her own numbers, with a total per post and nothing of anyone else', async () => {
  await withAnalytics(true, async () => {
    await withProducts(async () => {
      const made = await call(workspacesPost, '/api/v1/workspaces', { json: { externalId: 'shop-1', name: 'Shop' } });
      const brand = String((made.body['workspace'] as { id: string }).id);
      const now = Date.now();
      const postedAt = new Date(now - 3 * 86_400_000).toISOString();
      const today = new Date(now).toISOString().slice(0, 10);
      const yesterday = new Date(now - 86_400_000).toISOString().slice(0, 10);
      let file = recordPost(EMPTY_ANALYTICS, 'w1|instagram:1', { brand, channel: 'instagram:1', platform: 'instagram', permalink: 'https://ig/p/1', postedAt, caption: 'Hi #diwali', tags: ['diwali'] }, yesterday, { likes: 3 }, now);
      file = recordPost(file, 'w1|instagram:1', { brand, channel: 'instagram:1', platform: 'instagram', permalink: 'https://ig/p/1', postedAt, caption: 'Hi #diwali', tags: ['diwali'] }, today, { likes: 8, reach: 200 }, now);
      file = recordPost(file, 'x|instagram:2', { brand: 'someone-else', channel: 'instagram:2', platform: 'instagram', permalink: null, postedAt, caption: 'secret', tags: [] }, today, { likes: 1 }, now);
      file = recordAccount(file, 'instagram:1', { brand, channel: 'instagram:1', platform: 'instagram', label: 'shop', needs: ['reconnect'], checkedAt: new Date(now).toISOString() }, { [today]: { followers: 62 } }, now);
      await saveAnalytics({ ...file, checkedAt: new Date(now).toISOString() }, (await loadAnalytics()).etag);

      const answer = await call(analyticsGet, '/api/v1/analytics?externalId=shop-1');
      assert.equal(answer.status, 200, JSON.stringify(answer.body));
      const posts = answer.body['posts'] as Array<{ postId: string; total: Record<string, number>; series: unknown[] }>;
      assert.deepEqual(posts.map((p) => [p.postId, p.total, p.series.length]), [['w1', { likes: 8, reach: 200 }, 2]]);
      assert.deepEqual((answer.body['accounts'] as Array<{ needs: string[] }>)[0]?.needs, ['reconnect']);
      assert.deepEqual(answer.body['channels'], [], 'no account is connected for this workspace');
      assert.deepEqual(answer.body['hashtags'], [{ tag: '#diwali', posts: 1, avgReach: 200 }]);
      assert.doesNotMatch(JSON.stringify(answer.body), /secret|someone-else|token/);

      assert.equal((await call(analyticsGet, '/api/v1/analytics?externalId=shop-1', { key: OTHER_KEY })).status, 404, 'another product cannot read it');
      assert.equal((await call(analyticsGet, '/api/v1/analytics?externalId=nobody')).status, 404);
      assert.equal((await call(analyticsGet, '/api/v1/analytics?externalId=shop-1', { key: null })).status, 401);
      const bad = await call(analyticsGet, '/api/v1/analytics?externalId=shop-1&from=2026-02-30');
      assert.equal(bad.status, 400);
      assert.equal(bad.body['code'], 'INVALID_REQUEST');
    });
  });
});

test('while analytics is switched off, the read and the daily check both refuse to do anything', async () => {
  await withAnalytics(false, async () => {
    await withProducts(async () => {
      await call(workspacesPost, '/api/v1/workspaces', { json: { externalId: 'shop-1', name: 'Shop' } });
      const answer = await call(analyticsGet, '/api/v1/analytics?externalId=shop-1');
      assert.equal(answer.status, 503);
      assert.equal(answer.body['code'], 'SERVICE_NOT_CONFIGURED');
      const before = process.env['CRON_SECRET'];
      process.env['CRON_SECRET'] = 'cron-secret-0123456789';
      try {
        const ran = await collectGet(new Request('https://social.example.test/api/analytics-collect', { headers: { authorization: 'Bearer cron-secret-0123456789' } }));
        assert.equal(ran.status, 200);
        assert.match(String(((await ran.json()) as { skipped: string }).skipped), /switched off/);
        const refused = await collectGet(new Request('https://social.example.test/api/analytics-collect', { headers: { authorization: 'Bearer wrong' } }));
        assert.equal(refused.status, 401);
      } finally {
        if (before === undefined) delete process.env['CRON_SECRET'];
        else process.env['CRON_SECRET'] = before;
      }
    });
  });
});
