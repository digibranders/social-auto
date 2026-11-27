/**
 * The whole Instagram connection through Facebook login, against a pretend Meta on a local port: the connect handler swaps the code, lists the
 * accounts, saves them encrypted with no end date; then a post goes out and the account is read, all by the account's own id on the "Facebook" host.
 * It proves OUR side works as Meta documents it; it cannot prove Meta accepts it.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const CODE = 'good-code';
const SYSTEM_TOKEN = 'system-user-token';
const ACCOUNTS = [{ id: '17841400000000001', username: 'acme_foods' }, { id: '17841400000000002', username: 'acme_cafe' }];
const seen: string[] = [];
const published: Array<{ account: string; image: string }> = [];

const meta = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://meta.local');
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const form = new URLSearchParams(Buffer.concat(chunks).toString());
  const path = url.pathname.replace(/^\/v23\.0/, '');
  seen.push(`${req.method} ${path}`);
  const send = (status: number, data: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(data));
  };
  if (req.method === 'POST' && path === '/oauth/access_token') {
    return form.get('code') === CODE && form.get('client_secret') === 'app-secret' && form.get('client_id') === 'app-id'
      ? send(200, { access_token: SYSTEM_TOKEN, token_type: 'bearer' })
      : send(400, { error: { message: 'Invalid verification code' } });
  }
  const token = url.searchParams.get('access_token') ?? form.get('access_token');
  if (token !== SYSTEM_TOKEN) return send(400, { error: { message: 'Invalid OAuth access token' } });
  if (path === '/me/assigned_instagram_accounts') return send(200, { data: ACCOUNTS });
  if (path === '/me') return send(200, { id: '999' });
  const account = ACCOUNTS.find((a) => path === `/${a.id}`);
  if (account) return send(200, { username: account.username, id: account.id });
  const media = /^\/(\d+)\/media$/.exec(path);
  if (req.method === 'POST' && media) return send(200, { id: `container-${media[1]}` });
  if (/^\/container-\d+$/.test(path)) return send(200, { status_code: 'FINISHED' });
  const publish = /^\/(\d+)\/media_publish$/.exec(path);
  if (req.method === 'POST' && publish) {
    published.push({ account: publish[1] as string, image: 'x' });
    return send(200, { id: 'media-1' });
  }
  if (path === '/media-1') return send(200, { permalink: 'https://www.instagram.com/p/fake1/' });
  return send(404, { error: { message: `no such route ${req.method} ${path}` } });
});
await new Promise<void>((resolve) => meta.listen(0, '127.0.0.1', resolve));
const dir = await mkdtemp(join(tmpdir(), 'ig-facebook-login-'));

process.env['INSTAGRAM_LOGIN'] = 'facebook';
process.env['INSTAGRAM_GRAPH_URL'] = `http://127.0.0.1:${(meta.address() as AddressInfo).port}`;
process.env['FACEBOOK_APP_ID'] = 'app-id';
process.env['FACEBOOK_APP_SECRET'] = 'app-secret';
process.env['EDIT_SECRET'] = 'edit-secret';
process.env['CHANNEL_KEY'] = '33'.repeat(32);
process.env['LOCAL_STORE_DIR'] = dir;
delete process.env['BLOB_READ_WRITE_TOKEN'];

const { POST } = await import('../api/_connect/instagram.ts');
const { loadChannels } = await import('./store.ts');
const { channelToken, hasEnded } = await import('./channels.ts');
const { parseKey } = await import('./crypto.ts');
const { postToInstagram } = await import('./crosspost.ts');
const { accountProfile, createImageContainer, permalink, prepareCarousel, publishContainer, tokenHealth, waitUntilReady } = await import('./instagram.ts');
const { allBrands } = await import('./clients.ts');
const { parseSchedule } = await import('./schedule.ts');
const { scheduleData } = await import('./schedule-source.ts');
const { loadClients } = await import('./store.ts');

const brand = [...allBrands(parseSchedule(scheduleData).map((p) => p.brand ?? 'default'), (await loadClients()).file)][0] as string;
const connect = (body: Record<string, unknown>, secret = 'edit-secret'): Promise<Response> =>
  POST(new Request('https://pub.example/api/instagram-connect', { method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));

test.after(async () => {
  meta.close();
  await rm(dir, { recursive: true, force: true });
});

test('a bad code is refused and nothing is saved', async () => {
  const response = await connect({ code: 'wrong', redirectUri: 'https://x/cb', brand });
  assert.equal(response.status, 502);
  assert.deepEqual((await loadChannels()).file.channels, []);
});

test('an approval saves every chosen account, encrypted, with no end date', async () => {
  const response = await connect({ code: CODE, redirectUri: 'https://x/cb', brand });
  assert.equal(response.status, 200);
  const answer = (await response.json()) as { accounts: Array<{ username: string }>; expiresInDays: number | null };
  assert.deepEqual(answer.accounts, [{ username: 'acme_foods' }, { username: 'acme_cafe' }]);
  assert.equal(answer.expiresInDays, null);
  const { file } = await loadChannels();
  assert.equal(file.channels.length, 2);
  const key = parseKey(process.env['CHANNEL_KEY']);
  for (const channel of file.channels) {
    if (channel.platform !== 'instagram') throw new Error('expected an Instagram channel');
    assert.equal(channel.brand, brand);
    assert.equal(channel.expiresAt, undefined);
    assert.ok(!channel.token.includes(SYSTEM_TOKEN));
    assert.equal(channelToken(channel, key), SYSTEM_TOKEN);
    assert.equal(hasEnded(channel, Date.now() + 1000 * 86_400_000), false);
  }
});

test('connecting again replaces the accounts instead of adding copies', async () => {
  assert.equal((await connect({ code: CODE, redirectUri: 'https://x/cb', brand })).status, 200);
  assert.equal((await loadChannels()).file.channels.length, 2);
});

test('a request without the secret is refused', async () => {
  assert.equal((await connect({ code: CODE, redirectUri: 'https://x/cb', brand }, 'nope')).status, 401);
});

test('the connected account is read and posted to by its own id, and every call goes to the Facebook-style host', async () => {
  const key = parseKey(process.env['CHANNEL_KEY']);
  const { file } = await loadChannels();
  const first = file.channels[0];
  if (!first || first.platform !== 'instagram') throw new Error('expected an Instagram channel');
  assert.deepEqual(await accountProfile(SYSTEM_TOKEN, first.userId), { username: first.username, pictureUrl: null });
  assert.deepEqual(await tokenHealth(SYSTEM_TOKEN), { ok: true });
  const results = await postToInstagram({
    post: { id: 'p1', brand, date: '2030-01-01T10:00:00+05:30', caption: 'Hello', image: '/posts/x.jpg' },
    channels: { channels: [first] },
    key,
    origin: 'https://pub.example',
    log: {},
    dryRun: false,
    now: Date.now() + 1000 * 86_400_000,
    record: async () => undefined,
    api: { createImageContainer, waitUntilReady, prepareCarousel, publishContainer, permalink, tokenHealth },
  });
  assert.equal(results[0]?.status, 'posted');
  assert.equal(results[0]?.permalink, 'https://www.instagram.com/p/fake1/');
  assert.deepEqual(published.map((p) => p.account), [first.userId]);
  assert.ok(seen.every((call) => !call.includes('refresh_access_token')));
});
