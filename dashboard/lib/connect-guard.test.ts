import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { guardFor, INVITE_COOKIE, refusal } from './connect-guard.ts';
import { finishConnect } from './connect-result.ts';
import { createInvite } from './linkedin-flow.ts';

const SESSION = 'session-secret-session-secret-1234567';
const INVITE = 'invite-secret-invite-secret-1234567890';
const NOW = Date.now();
let saved: Array<string | undefined> = [];
beforeEach(() => {
  saved = [process.env['SESSION_SECRET'], process.env['INVITE_SECRET']];
  process.env['SESSION_SECRET'] = SESSION;
  process.env['INVITE_SECRET'] = INVITE;
});
afterEach(() => {
  ['SESSION_SECRET', 'INVITE_SECRET'].forEach((n, i) => (saved[i] === undefined ? delete process.env[n] : (process.env[n] = saved[i])));
});
const withCookie = (token?: string): Request => new Request('https://d.example.test/api/x', { headers: token ? { cookie: `${INVITE_COOKIE}=${token}` } : {} });

test('a customer link keeps the guard on, and carries the one brand she agreed to move from', () => {
  assert.deepEqual(guardFor(withCookie(createInvite(INVITE, 'bb-2', NOW, 3600))), { guard: true });
  assert.deepEqual(guardFor(withCookie(createInvite(INVITE, 'bb-2', NOW, 3600, undefined, 'c1'))), { guard: true, moveFrom: 'c1' });
});

test('only a link the team made turns the guard off; no cookie, a forged or an expired one never do', () => {
  assert.deepEqual(guardFor(withCookie(createInvite(SESSION, 'mine', NOW))), { guard: false });
  assert.deepEqual(guardFor(withCookie()), { guard: true });
  assert.deepEqual(guardFor(withCookie('abc.def')), { guard: true });
  assert.deepEqual(guardFor(withCookie(createInvite(INVITE, 'bb-2', NOW - 7200_000, 3600, undefined, 'c1'))), { guard: true });
  assert.deepEqual(guardFor(withCookie(createInvite('x'.repeat(40), 'mine', NOW))), { guard: true });
});

test('the publisher\'s refusal is read only when it is the account-in-use answer', async () => {
  const answer = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status });
  assert.deepEqual(await refusal(answer(409, { code: 'ACCOUNT_IN_USE', heldBy: 'c1' })), { heldBy: 'c1' });
  assert.deepEqual(await refusal(answer(409, { code: 'ACCOUNT_IN_USE' })), {});
  assert.equal(await refusal(answer(409, { code: 'OTHER' })), null);
  assert.equal(await refusal(answer(200, {})), null);
});

test('the customer comes back to the product with the reason, and the plain page says it in words', async () => {
  const request = new Request('https://d.example.test/api/instagram-callback');
  const back = finishConnect({ request, platform: 'instagram', outcome: 'inuse', clearCookie: 'c=; Max-Age=0', returnUrl: 'https://app.example.test/social', heldBy: 'c1' });
  const url = new URL(back.headers.get('location') as string);
  assert.deepEqual([url.searchParams.get('social'), url.searchParams.get('channel'), url.searchParams.get('reason'), url.searchParams.get('heldBy')], ['failed', 'instagram', 'ACCOUNT_IN_USE', 'c1']);
  const other = new URL(finishConnect({ request, platform: 'instagram', outcome: 'inuse', clearCookie: 'c=; Max-Age=0', returnUrl: 'https://app.example.test/social' }).headers.get('location') as string);
  assert.equal(other.searchParams.get('heldBy'), null, 'someone else\'s holder is never named');
  const page = finishConnect({ request, platform: 'instagram', outcome: 'inuse', clearCookie: 'c=; Max-Age=0' });
  assert.equal(page.status, 400);
  assert.match(await page.text(), /already connected somewhere else/);
});
