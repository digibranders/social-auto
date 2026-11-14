import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GET as channelsGet, POST as channelsPost } from '../api/_v1/channels.ts';
import { GET as postsGet, POST as postsPost } from '../api/_v1/posts.ts';
import { POST as picturesPost } from '../api/_v1/pictures.ts';
import { GET as workspacesGet, POST as workspacesPost } from '../api/_v1/workspaces.ts';
import { ERROR_CODES, type ErrorCode } from './api-error.ts';
import { addFacebookPages, addGoogleLocation, addInstagramAccount, addLinkedInMember, channelToken, type Channel } from './channels.ts';
import { revokeAtNetwork, disconnectPreview, type RevokeEnv } from './channel-disconnect.ts';
import { forgetConnected } from './connected-sync.ts';
import { parseKey } from './crypto.ts';
import { call, CHANNEL_KEY, fakeEngine, KEY, OTHER_KEY, withProducts, type Answer, type FakeEngine, type FakeJob } from '../dev/product-test-kit.ts';
import { loadChannels, saveChannels } from './store.ts';

function expectError(answer: Answer, status: number, code: ErrorCode, label: string): void {
  assert.equal(answer.status, status, `${label}: status (${JSON.stringify(answer.body)})`);
  assert.equal(answer.body['code'], code, `${label}: code (${JSON.stringify(answer.body)})`);
  assert.ok(ERROR_CODES.includes(code));
  assert.deepEqual(Object.keys(answer.body).sort(), ['code', 'error']);
}

function jpeg(width: number, height: number): Uint8Array {
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);
}

async function withEngine(run: (engine: FakeEngine) => Promise<void>): Promise<void> {
  await withProducts(async () => {
    const engine = await fakeEngine();
    try {
      forgetConnected();
      await run(engine);
    } finally {
      await engine.close();
    }
  });
}

const IG = 'instagram:1784140000001';
const FB = 'facebook:1000000000001';
const act = { 'x-social-actor': 'user_42' };
const istDay = (ahead: number): string => new Date(Date.now() + 5.5 * 3_600_000 + ahead * 86_400_000).toISOString().slice(0, 10);

async function setup(networks: Array<'instagram' | 'facebook'>): Promise<{ brand: string; pictureId: string }> {
  const made = await call(workspacesPost, '/api/v1/workspaces', { json: { externalId: 'shop-1', name: 'shop-1' } });
  const brand = String((made.body['workspace'] as { id: string }).id);
  const key = parseKey(CHANNEL_KEY);
  const at = Date.now() - 3_600_000;
  const { file, etag } = await loadChannels();
  let next = file;
  if (networks.includes('instagram')) next = addInstagramAccount(next, brand, { userId: '1784140000001', username: 'shop' }, 'token', 5_000_000, key, at);
  if (networks.includes('facebook')) next = addFacebookPages(next, brand, [{ id: '1000000000001', name: 'Shop Page', accessToken: 'token' }], key, at);
  await saveChannels(next, etag);
  const uploaded = await picturesPost(new Request('https://social.example.test/api/v1/pictures', { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'image/jpeg' }, body: new Uint8Array(jpeg(1080, 1080)) }));
  const picture = (await uploaded.json()) as { pictureId: string };
  assert.equal(uploaded.status, 201, JSON.stringify(picture));
  return { brand, pictureId: picture.pictureId };
}

const preview = (channelId: string, key?: string): Promise<Answer> => call(channelsGet, `/api/v1/channels?externalId=shop-1&channelId=${encodeURIComponent(channelId)}`, key ? { key } : {});
const disconnect = (json: Record<string, unknown>, headers: Record<string, string> = act, key?: string): Promise<Answer> => call(channelsPost, '/api/v1/channels', { headers, ...(key ? { key } : {}), json: { externalId: 'shop-1', action: 'disconnect', ...json } });
const channelIds = (answer: Answer): string[] => ((answer.body['workspace'] as { channels: Array<{ id: string }> }).channels).map((c) => c.id).sort();

test('the preview says how many posts would stop on the channel and on which days, and nothing about another channel', async () => {
  await withEngine(async () => {
    const { pictureId } = await setup(['instagram', 'facebook']);
    for (const day of [istDay(2), istDay(2), istDay(4)]) assert.equal((await call(postsPost, '/api/v1/posts', { json: { externalId: 'shop-1', day, caption: 'Words', pictureId } })).status, 201);
    assert.equal((await call(postsPost, '/api/v1/posts', { json: { externalId: 'shop-1', day: istDay(5), caption: 'Only Facebook', pictureId, channels: [FB] } })).status, 201);
    const ig = await preview(IG);
    assert.equal(ig.status, 200, JSON.stringify(ig.body));
    assert.deepEqual(ig.body, { scheduled: 3, days: [istDay(2), istDay(4)], approved: 0, running: [], onlyChannel: false });
    const fb = await preview(FB);
    assert.deepEqual([fb.body['scheduled'], (fb.body['days'] as string[]).length], [4, 3]);
    expectError(await preview('instagram:1999999999999'), 404, 'NOT_FOUND', 'not her channel');
    expectError(await preview('instagram'), 400, 'INVALID_REQUEST', 'not a channel id');
    expectError(await preview(IG, OTHER_KEY), 404, 'WORKSPACE_NOT_FOUND', 'another product');
  });
});

test('disconnecting removes the channel, tells the poster service, keeps the posts held for it, and doing it again is a plain 200', async () => {
  await withEngine(async (engine) => {
    const { pictureId } = await setup(['instagram', 'facebook']);
    await call(postsPost, '/api/v1/posts', { json: { externalId: 'shop-1', day: istDay(3), caption: 'Words', pictureId } });
    const done = await disconnect({ channelId: IG });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.deepEqual(channelIds(done), [FB]);
    assert.deepEqual(engine.connected, ['facebook'], 'the poster service no longer draws for Instagram');
    assert.deepEqual(channelIds(await call(workspacesGet, '/api/v1/workspaces?externalId=shop-1')), [FB]);
    // The post is still there, held for the channel that is gone, and still goes to the other one.
    const posts = ((await call(postsGet, '/api/v1/posts?externalId=shop-1')).body['posts'] as Array<{ targets: Array<{ id: string; code?: string }> }>);
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0]?.targets.map((t) => [t.id, t.code]).sort(), [[FB, undefined], [IG, 'ACCOUNT_DISCONNECTED']]);
    assert.equal((await disconnect({ channelId: IG })).status, 200, 'already gone');
    assert.deepEqual(channelIds(await disconnect({ channelId: IG })), [FB], 'and nothing else changed');
    expectError(await preview(IG), 404, 'NOT_FOUND', 'gone');
  });
});

test('refusals: work in progress for the channel, her only channel without confirmOnly, no person, a bad id or action, another product', async () => {
  await withEngine(async (engine) => {
    await setup(['instagram']);
    const job = (kind: FakeJob['kind'], networks: string[], state: FakeJob['state'] = 'running'): FakeJob => ({ id: `job-b00001-0123abcd`, key: kind, kind, brand: engine.jobs[0]?.brand ?? 'x', site: 'https://acme.example', by: 'x', networks, state, createdAt: new Date().toISOString() });
    const { file } = await loadChannels();
    const brand = file.channels[0]?.brand ?? '';
    engine.jobs.push({ ...job('copy', ['instagram']), brand });
    const busy = await disconnect({ channelId: IG });
    expectError(busy, 409, 'CONFLICT', 'a batch is being written for it');
    assert.match(String(busy.body['error']), /being made for this channel/);
    engine.jobs.length = 0;
    engine.jobs.push({ ...job('copy', ['facebook']), brand });
    expectError(await disconnect({ channelId: IG }), 409, 'ONLY_CHANNEL', 'a batch for another channel does not block, but it is her only channel');
    engine.jobs.length = 0;
    engine.jobs.push({ ...job('draw', []), brand });
    expectError(await disconnect({ channelId: IG, confirmOnly: true }), 409, 'CONFLICT', 'pictures are being drawn');
    engine.jobs.length = 0;
    engine.jobs.push({ ...job('copy', ['instagram'], 'succeeded'), brand });
    expectError(await disconnect({ channelId: IG }), 409, 'ONLY_CHANNEL', 'a finished job blocks nothing');
    expectError(await disconnect({ channelId: IG }, {}), 400, 'ACTOR_REQUIRED', 'no person named');
    expectError(await disconnect({ channelId: 'instagram' }), 400, 'INVALID_REQUEST', 'not a channel id');
    expectError(await disconnect({ channelId: IG, action: 'remove' }), 400, 'INVALID_REQUEST', 'unknown action');
    expectError(await disconnect({ channelId: IG, confirmOnly: 'yes' }), 400, 'INVALID_REQUEST', 'confirmOnly not true or false');
    expectError(await disconnect({ channelId: IG }, act, OTHER_KEY), 404, 'WORKSPACE_NOT_FOUND', 'another product');
    assert.deepEqual((await loadChannels()).file.channels.map((c) => c.id), [IG], 'nothing was removed by the refusals');
    const only = await disconnect({ channelId: IG, confirmOnly: true });
    assert.equal(only.status, 200, JSON.stringify(only.body));
    assert.deepEqual(channelIds(only), [], 'her only channel, confirmed');
  });
});

test('the revoke at the network is best effort: Google and LinkedIn (when our app\'s credentials are set) are asked, Instagram and Facebook are not, and a failure never throws', async () => {
  const key = parseKey(CHANNEL_KEY);
  const at = Date.now();
  const google = addGoogleLocation({ channels: [] }, 'b', { account: 'accounts/1', location: 'locations/123', title: 'Shop' }, 'refresh-token-abc', key, at).channels[0] as Channel;
  const linkedin = addLinkedInMember({ channels: [] }, 'b', { urn: 'urn:li:person:abc12345', name: 'M' }, 'li-token-xyz', 5_000_000, key, at).channels[0] as Channel;
  const instagram = addInstagramAccount({ channels: [] }, 'b', { userId: '1784140000001', username: 'shop' }, 'ig', 5_000_000, key, at).channels[0] as Channel;
  const facebook = addFacebookPages({ channels: [] }, 'b', [{ id: '1000000000001', name: 'P', accessToken: 'fb' }], key, at).channels[0] as Channel;
  const env: RevokeEnv = { googleUrl: 'https://google.example/revoke', linkedin: { clientId: 'cid', clientSecret: 'csecret', url: 'https://linkedin.example/revoke' } };
  const calls: Array<{ url: string; body: string }> = [];
  const ok: typeof fetch = async (url, init) => { calls.push({ url: String(url), body: String(init?.body) }); return new Response('', { status: 200 }); };

  assert.equal(await revokeAtNetwork(google, key, env, ok), true);
  assert.equal(await revokeAtNetwork(linkedin, key, env, ok), true);
  assert.deepEqual(calls.map((c) => c.url), ['https://google.example/revoke', 'https://linkedin.example/revoke']);
  assert.match(calls[0]?.body ?? '', /token=refresh-token-abc/);
  assert.match(calls[1]?.body ?? '', /client_id=cid.*client_secret=csecret.*token=li-token-xyz/);
  assert.equal(channelToken(google, key), 'refresh-token-abc');
  assert.equal(await revokeAtNetwork(instagram, key, env, ok), false, 'Instagram: nothing to call');
  assert.equal(await revokeAtNetwork(facebook, key, env, ok), false, 'Facebook: nothing to call');
  assert.equal(calls.length, 2);
  assert.equal(await revokeAtNetwork(linkedin, key, { googleUrl: env.googleUrl }, ok), false, 'LinkedIn without our app\'s credentials: nothing to call');
  const refused: typeof fetch = async () => new Response('no', { status: 400 });
  const down: typeof fetch = async () => { throw new Error('network down'); };
  const logged = console.error;
  console.error = (): void => undefined;
  try {
    assert.equal(await revokeAtNetwork(google, key, env, refused), false, 'refused');
    assert.equal(await revokeAtNetwork(google, key, env, down), false, 'unreachable: no throw');
  } finally {
    console.error = logged;
  }
});

test('the preview counts a post for a channel only while it can still go out there, never a skipped one or one already sent to it', () => {
  const key = parseKey(CHANNEL_KEY);
  const ig = addInstagramAccount({ channels: [] }, 'b', { userId: '1784140000001', username: 'shop' }, 'ig', 5_000_000, key, Date.now()).channels[0] as Channel;
  const now = Date.parse('2026-11-18T06:30:00Z');
  const post = (id: string, date: string, extra: Record<string, unknown> = {}) => ({ brand: 'b', id, date, caption: 'c', image: null, channels: ['instagram'], ...extra });
  const posts = [post('future', '2026-11-20T10:00:00+05:30'), post('skipped', '2026-11-21T10:00:00+05:30', { skipped: true }), post('sent', '2026-11-22T10:00:00+05:30'), post('old', '2026-11-10T10:00:00+05:30'), post('other', '2026-11-23T10:00:00+05:30', { channels: ['facebook:1'] }), post('byName', '2026-11-24T10:00:00+05:30', { channels: [IG] })];
  const result = disconnectPreview({ channel: ig, channels: [ig], posts: posts as never, posted: { [`sent|${IG}`]: { remoteId: 'r', postedAt: 'x' } } as never, approvedDays: ['2026-11-17', '2026-11-20', '2026-11-22'], jobs: [], now });
  assert.deepEqual(result, { scheduled: 2, days: ['2026-11-20', '2026-11-24'], approved: 2, running: [], onlyChannel: true });
});
