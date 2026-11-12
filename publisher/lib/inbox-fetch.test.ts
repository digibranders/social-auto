import assert from 'node:assert/strict';
import { test } from 'node:test';
import { facebookComments, facebookReply, InboxWriteError, instagramComments, instagramReply } from './inbox-fetch.ts';

type Route = [match: RegExp, status: number, body: unknown, method?: string];
function fakeFetch(routes: Route[], seen: Array<{ url: string; method: string; body: string }> = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    seen.push({ url, method, body: String(init?.body ?? '') });
    const route = routes.find(([m, , , meth]) => m.test(url) && (meth ?? 'GET') === method);
    return new Response(JSON.stringify(route ? route[2] : { error: { message: `no route for ${url}` } }), { status: route ? route[1] : 500 });
  }) as typeof fetch;
}
const refusal = { error: { code: 10, message: '(#10) Application does not have permission for this action' } };

test('Instagram comments are read with their author and time, and a missing permission is "reconnect", not a crash', async () => {
  const ok = await instagramComments('m1', 'tok', fakeFetch([[/\/m1\/comments/, 200, { data: [{ id: 'c1', text: 'Nice', username: 'priya', timestamp: '2026-11-11T08:00:00+0000' }, { id: '', text: 'x' }] }]]));
  assert.deepEqual(ok, { needs: null, comments: [{ remoteId: 'c1', author: 'priya', text: 'Nice', at: '2026-11-11T08:00:00.000Z' }] });
  assert.deepEqual(await instagramComments('m1', 'tok', fakeFetch([[/\/m1\/comments/, 400, refusal]])), { needs: 'reconnect', comments: [] });
  await assert.rejects(instagramComments('m1', 'tok', fakeFetch([[/\/m1\/comments/, 500, { error: { code: 2, message: 'Service temporarily unavailable' } }]])), /Instagram comments failed/);
});

test('Facebook comments leave out the Page\'s own comments, which are our replies', async () => {
  const body = { data: [{ id: '7_1', message: 'Lovely', from: { id: '99', name: 'Anita' }, created_time: '2026-11-11T09:00:00+0000' }, { id: '7_2', message: 'Thanks!', from: { id: '7', name: 'Page' }, created_time: '2026-11-11T09:05:00+0000' }] };
  const reading = await facebookComments('7_post', '7', 'tok', fakeFetch([[/\/7_post\/comments/, 200, body]]));
  assert.deepEqual(reading.comments.map((x) => [x.remoteId, x.author]), [['7_1', 'Anita']]);
  assert.deepEqual(await facebookComments('7_post', '7', 'tok', fakeFetch([[/\/7_post\/comments/, 403, refusal]])), { needs: 'reconnect', comments: [] });
});

test('a reply is posted to the comment and its id is returned; a refusal says the permission is missing; the token is only ever sent to the network', async () => {
  const seen: Array<{ url: string; method: string; body: string }> = [];
  const id = await instagramReply('c1', 'tok', 'Thank you!', fakeFetch([[/\/c1\/replies/, 200, { id: 'r1' }, 'POST']], seen));
  assert.equal(id, 'r1');
  assert.equal(seen[0]?.method, 'POST');
  assert.match(seen[0]?.body ?? '', /message=Thank\+you%21/);
  assert.equal(await facebookReply('7_1', 'tok', 'Thanks', fakeFetch([[/\/7_1\/comments/, 200, { id: '7_9' }, 'POST']])), '7_9');
  await assert.rejects(instagramReply('c1', 'tok', 'x', fakeFetch([[/\/c1\/replies/, 400, refusal, 'POST']])), (e: unknown) => e instanceof InboxWriteError && e.kind === 'permission');
  await assert.rejects(facebookReply('7_1', 'tok', 'x', fakeFetch([[/\/7_1\/comments/, 500, { error: { code: 1, message: 'boom' } }, 'POST']])), (e: unknown) => e instanceof InboxWriteError && e.kind === 'failed');
});
