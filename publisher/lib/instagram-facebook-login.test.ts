/**
 * Instagram through Facebook login (Meta's "Unified Login"): the token belongs to a business system user, never expires,
 * and every call goes to graph.facebook.com with the account's own id. The mode is chosen by INSTAGRAM_LOGIN=facebook,
 * set before the code is loaded, so each test file runs in its own process (node --test does that).
 */
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

process.env['INSTAGRAM_LOGIN'] = 'facebook';
delete process.env['INSTAGRAM_GRAPH_URL'];

const { accountProfile, accountsOf, exchangeFacebookCode, facebookLoginLink, InstagramApiError, instagramGraph, tokenHealth, unifiedLogin } = await import('./instagram.ts');
const { addInstagramAccount, channelToken, endsAt, expiringSoon, parseChannels } = await import('./channels.ts');
const { postToInstagram } = await import('./crosspost.ts');
const { parseKey } = await import('./crypto.ts');

const KEY = parseKey('22'.repeat(32));
const T0 = Date.parse('2026-11-18T09:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

test('the mode and the host follow INSTAGRAM_LOGIN', () => {
  assert.equal(unifiedLogin(), true);
  assert.equal(instagramGraph(), 'https://graph.facebook.com/v23.0');
});

test('the login link carries the configuration and no scope', () => {
  const link = new URL(facebookLoginLink({ appId: '111', configId: '222', redirectUri: 'https://social.example/api/instagram-callback', state: 'abc' }));
  assert.equal(link.origin + link.pathname, 'https://www.facebook.com/dialog/oauth');
  assert.equal(link.searchParams.get('client_id'), '111');
  assert.equal(link.searchParams.get('config_id'), '222');
  assert.equal(link.searchParams.get('response_type'), 'code');
  assert.equal(link.searchParams.get('state'), 'abc');
  assert.equal(link.searchParams.get('redirect_uri'), 'https://social.example/api/instagram-callback');
  assert.equal(link.searchParams.has('scope'), false);
});

test('the code is swapped at graph.facebook.com, with the secret in the body and not in the address', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async () => Response.json({ access_token: 'sys-token', token_type: 'bearer' }));
  try {
    assert.equal(await exchangeFacebookCode({ appId: '111', appSecret: 's3cret' }, 'https://social.example/api/instagram-callback', 'the-code'), 'sys-token');
    const [url, init] = fetchMock.mock.calls[0]?.arguments as unknown as [string, RequestInit];
    assert.equal(url, 'https://graph.facebook.com/v23.0/oauth/access_token');
    assert.ok(!url.includes('s3cret'));
    const body = new URLSearchParams(String(init.body));
    assert.equal(body.get('client_secret'), 's3cret');
    assert.equal(body.get('code'), 'the-code');
  } finally {
    fetchMock.mock.restore();
  }
});

test('a refused code exchange throws an error that does not contain the secret', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async () => Response.json({ error: { message: 'Invalid verification code' } }, { status: 400 }));
  try {
    await assert.rejects(exchangeFacebookCode({ appId: '111', appSecret: 's3cret' }, 'https://x/cb', 'bad'), (error: unknown) => {
      assert.ok(error instanceof InstagramApiError);
      assert.ok(!error.message.includes('s3cret'));
      return true;
    });
  } finally {
    fetchMock.mock.restore();
  }
});

test('the accounts handed to the app are listed with their ids and usernames', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async () => Response.json({ data: [{ id: '17841400000000001', username: 'acme_foods' }, { id: '17841400000000002', username: 'acme_cafe' }, { id: '3' }] }));
  try {
    assert.deepEqual(await accountsOf('sys-token'), [
      { userId: '17841400000000001', username: 'acme_foods' },
      { userId: '17841400000000002', username: 'acme_cafe' },
    ]);
    const [url] = fetchMock.mock.calls[0]?.arguments as unknown as [string];
    assert.match(url, /^https:\/\/graph\.facebook\.com\/v23\.0\/me\/assigned_instagram_accounts\?/);
  } finally {
    fetchMock.mock.restore();
  }
});

test('an account is read by its own id, not by /me, which is the system user here', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async () => Response.json({ username: 'acme_foods', profile_picture_url: 'https://cdn.example/a.jpg' }));
  try {
    assert.deepEqual(await accountProfile('sys-token', '17841400000000001'), { username: 'acme_foods', pictureUrl: 'https://cdn.example/a.jpg' });
    const [url] = fetchMock.mock.calls[0]?.arguments as unknown as [string];
    assert.match(url, /^https:\/\/graph\.facebook\.com\/v23\.0\/17841400000000001\?/);
  } finally {
    fetchMock.mock.restore();
  }
});

test('the token check asks for the token owner only', async () => {
  const ok = mock.method(globalThis, 'fetch', async () => Response.json({ id: '99' }));
  try {
    assert.deepEqual(await tokenHealth('sys-token'), { ok: true });
    const [url] = ok.mock.calls[0]?.arguments as unknown as [string];
    assert.match(url, /^https:\/\/graph\.facebook\.com\/v23\.0\/me\?fields=id&/);
  } finally {
    ok.mock.restore();
  }
  const refused = mock.method(globalThis, 'fetch', async () => Response.json({ error: { message: 'The session has been invalidated' } }, { status: 400 }));
  try {
    const health = await tokenHealth('sys-token');
    assert.equal(health.ok, false);
    assert.match(health.error ?? '', /invalidated/);
  } finally {
    refused.mock.restore();
  }
});

const connected = addInstagramAccount({ channels: [] }, 'brandbasket', { userId: '17841400000000001', username: 'acme_foods' }, 'sys-token', null, KEY, T0);
const only = connected.channels[0]!;
if (only.platform !== 'instagram') throw new Error('expected an Instagram channel');

test('a login that never expires is saved without an end date and survives a round trip', () => {
  assert.equal('expiresAt' in only && only.expiresAt !== undefined, false);
  assert.equal(channelToken(only, KEY), 'sys-token');
  assert.deepEqual(parseChannels(JSON.parse(JSON.stringify(connected))), connected);
  assert.equal(endsAt(only), null);
});

test('a login that never expires is not warned about, however long it has been connected', () => {
  assert.deepEqual(expiringSoon(connected, T0 + 400 * DAY), []);
});

test('a saved end date is still honoured and still checked', () => {
  const dated = addInstagramAccount({ channels: [] }, 'brandbasket', { userId: '2', username: 'old' }, 'tok', 60 * 24 * 60 * 60, KEY, T0);
  const first = dated.channels[0]!;
  if (first.platform !== 'instagram') throw new Error('expected an Instagram channel');
  assert.equal(endsAt(first), T0 + 60 * DAY);
  assert.throws(() => parseChannels({ channels: [{ ...dated.channels[0], expiresAt: 'soon' }] }), /not a date/);
});

test('posting works for a login without an end date, long after it was connected', async () => {
  const calls: string[] = [];
  const results = await postToInstagram({
    post: { id: 'p1', brand: 'brandbasket', date: '2027-12-31T10:00:00+05:30', caption: 'Hello', image: '/posts/x.jpg' },
    channels: connected,
    key: KEY,
    origin: 'https://pub.example',
    log: {},
    dryRun: false,
    now: T0 + 400 * DAY,
    record: async () => undefined,
    api: {
      createImageContainer: async (userId, token) => {
        calls.push(`container ${userId} ${token}`);
        return 'c1';
      },
      waitUntilReady: async () => undefined,
      prepareCarousel: async () => {
        throw new Error('a carousel was not expected');
      },
      publishContainer: async () => 'm1',
      permalink: async () => 'https://www.instagram.com/p/abc/',
      tokenHealth: async () => ({ ok: true }),
    },
  });
  assert.equal(results[0]?.status, 'posted');
  assert.deepEqual(calls, ['container 17841400000000001 sys-token']);
});
