import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { accessTokenFor, authorizeUrl, createPost, exchangeCode, GoogleApiError, googleSummary, listLocations } from './google.ts';

const app = { clientId: 'cid', clientSecret: 'shh' };

type Call = { url: string; method: string; body: string; auth: string | null };

/** Stubs fetch with a queue of answers and records what was asked. */
function stubFetch(...answers: Array<Response | (() => Response)>): { calls: Call[]; restore: () => void } {
  const calls: Call[] = [];
  const queue = [...answers];
  const stub = mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? 'GET', body: String(init?.body ?? ''), auth: new Headers(init?.headers).get('authorization') });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected request to ${String(input)}`);
    return typeof next === 'function' ? next() : next;
  });
  return { calls, restore: () => stub.mock.restore() };
}

test('authorizeUrl asks for offline access so Google hands back a refresh token', () => {
  const url = new URL(authorizeUrl({ clientId: 'cid', redirectUri: 'https://x/cb', state: 's1' }));
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/business.manage');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.equal(url.searchParams.get('state'), 's1');
});

test('exchangeCode keeps the secret in the body and returns the refresh token', async () => {
  const fetched = stubFetch(Response.json({ access_token: 'acc', refresh_token: 'ref', expires_in: 3599 }));
  try {
    assert.deepEqual(await exchangeCode(app, 'https://x/cb', 'CODE'), { accessToken: 'acc', refreshToken: 'ref' });
  } finally {
    fetched.restore();
  }
  const call = fetched.calls[0]!;
  assert.ok(!call.url.includes('shh'));
  assert.ok(call.body.includes('client_secret=shh') && call.body.includes('code=CODE') && call.body.includes('grant_type=authorization_code'));
});

test('exchangeCode explains a missing refresh token, and a refused code names Google’s reason', async () => {
  const none = stubFetch(Response.json({ access_token: 'acc' }));
  try {
    await assert.rejects(exchangeCode(app, 'https://x/cb', 'c'), /no refresh token.*connect again/i);
  } finally {
    none.restore();
  }
  const refused = stubFetch(Response.json({ error: 'invalid_grant', error_description: 'Bad Request' }, { status: 400 }));
  try {
    await assert.rejects(exchangeCode(app, 'https://x/cb', 'c'), (e: unknown) => e instanceof GoogleApiError && /code exchange failed.*invalid_grant/.test(e.message));
  } finally {
    refused.restore();
  }
});

test('accessTokenFor swaps the refresh token for a short-lived one, and says when access was withdrawn', async () => {
  const ok = stubFetch(Response.json({ access_token: 'fresh', expires_in: 3599 }));
  try {
    assert.equal(await accessTokenFor(app, 'ref'), 'fresh');
  } finally {
    ok.restore();
  }
  assert.ok(ok.calls[0]!.body.includes('grant_type=refresh_token') && ok.calls[0]!.body.includes('refresh_token=ref'));
  const gone = stubFetch(Response.json({ error: 'invalid_grant' }, { status: 400 }));
  try {
    await assert.rejects(accessTokenFor(app, 'ref'), /access was withdrawn or expired.*connect Google again/i);
  } finally {
    gone.restore();
  }
});

test('listLocations walks every account and returns each location with its account', async () => {
  const fetched = stubFetch(
    Response.json({ accounts: [{ name: 'accounts/1' }, { name: 'accounts/2' }] }),
    Response.json({ locations: [{ name: 'locations/10', title: 'Cafe One' }, { name: 'locations/11', title: 'Cafe Two' }] }),
    Response.json({}),
  );
  try {
    assert.deepEqual(await listLocations('acc'), [
      { account: 'accounts/1', location: 'locations/10', title: 'Cafe One' },
      { account: 'accounts/1', location: 'locations/11', title: 'Cafe Two' },
    ]);
  } finally {
    fetched.restore();
  }
  assert.ok(fetched.calls.every((c) => c.auth === 'Bearer acc'));
  assert.match(fetched.calls[1]!.url, /accounts\/1\/locations\?.*readMask=name%2Ctitle/);
});

test('createPost sends a standard update with the picture address and returns where it lives', async () => {
  const fetched = stubFetch(Response.json({ name: 'accounts/1/locations/10/localPosts/99', searchUrl: 'https://google.com/search?q=x' }));
  let post;
  try {
    post = await createPost('acc', 'accounts/1', 'locations/10', { summary: 'Hello', imageUrl: 'https://pub/x.jpg' });
  } finally {
    fetched.restore();
  }
  assert.deepEqual(post, { name: 'accounts/1/locations/10/localPosts/99', url: 'https://google.com/search?q=x' });
  const call = fetched.calls[0]!;
  assert.equal(call.method, 'POST');
  assert.match(call.url, /\/v4\/accounts\/1\/locations\/10\/localPosts$/);
  assert.deepEqual(JSON.parse(call.body), {
    languageCode: 'en',
    summary: 'Hello',
    topicType: 'STANDARD',
    media: [{ mediaFormat: 'PHOTO', sourceUrl: 'https://pub/x.jpg' }],
  });
});

test('createPost reports Google’s reason when it refuses', async () => {
  const fetched = stubFetch(Response.json({ error: { message: 'Phone numbers are not allowed' } }, { status: 400 }));
  try {
    await assert.rejects(createPost('acc', 'accounts/1', 'locations/10', { summary: 's', imageUrl: 'u' }), (e: unknown) => e instanceof GoogleApiError && /post failed.*Phone numbers/.test(e.message));
  } finally {
    fetched.restore();
  }
});

test('googleSummary drops hashtags, tidies spacing, and fits Google’s 1,500 characters', () => {
  assert.equal(googleSummary('Line one.\n\nWe build sites.\n\n#Cafe #India #Business'), 'Line one.\n\nWe build sites.');
  assert.equal(googleSummary('Great #coffee in town  today'), 'Great in town today');
  const long = googleSummary(`${'word '.repeat(400)}`);
  assert.ok(long.length <= 1500);
  assert.ok(long.endsWith('…'));
  assert.equal(googleSummary('Short'), 'Short');
});
