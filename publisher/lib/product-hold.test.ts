import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GET as workspacesGet, POST as workspacesPost } from '../api/_v1/workspaces.ts';
import { addLinkedInMember, type ChannelFile } from './channels.ts';
import { addPlan, clientFeedDetails, setApprovalMode, type ClientsFile } from './clients.ts';
import { EditError } from './overrides.ts';
import { NO_PAUSES } from './pauses.ts';
import { scheduledView } from './post-view.ts';
import { problemEvents } from './product-watch.ts';
import type { ScheduledPost } from './schedule.ts';
import { disconnectedNotices, noticesFor } from './workspace-notices.ts';
import { call, withProducts, CHANNEL_KEY } from '../dev/product-test-kit.ts';
import { parseKey } from './crypto.ts';
import { loadChannels, saveChannels } from './store.ts';

const NOW = Date.parse('2026-11-20T10:00:00Z');
const HOUR = 3_600_000;
const BRAND = 'brandbasket-shop-1-abc123';
const clients: ClientsFile = { clients: [{ brand: BRAND, createdAt: 'x', product: 'brandbasket', externalId: 'shop-1', website: 'https://acme.example.com' }, { brand: 'mine', createdAt: 'x', website: 'https://mine.example.com' }] };

describe_lock();

function describe_lock(): void {
  test('a product\'s customer can never be switched to automatic approval, and no posting plan can be added for them; our own clients are unchanged', () => {
    assert.throws(() => setApprovalMode(clients, BRAND, 'auto'), (e: unknown) => e instanceof EditError && e.status === 409 && e.code === 'CONFLICT');
    assert.equal(setApprovalMode(clients, BRAND, 'manual').clients[0]?.approvalMode, undefined, 'manual is fine and is not stored');
    assert.equal(setApprovalMode(clients, 'mine', 'auto').clients[1]?.approvalMode, 'auto');
    assert.throws(() => addPlan(clients, BRAND, { platforms: ['instagram'] }, NOW), (e: unknown) => e instanceof EditError && e.status === 409);
    // Even one that was set to automatic before the lock existed is manual for everything that reads the status feed.
    const old: ClientsFile = { clients: [{ ...(clients.clients[0] as object), approvalMode: 'auto' } as ClientsFile['clients'][number]] };
    assert.equal(clientFeedDetails(old.clients[0] as ClientsFile['clients'][number]).approvalMode, 'manual');
    assert.equal(clientFeedDetails({ brand: 'x', createdAt: 'x', approvalMode: 'auto' }).approvalMode, 'auto');
  });
}

function channelsWith(expiresInMs: number, connectedAt: number = NOW - 30 * 24 * HOUR): ChannelFile {
  return addLinkedInMember({ channels: [] }, BRAND, { urn: 'urn:li:person:abcdefabc', name: 'Asha' }, 'token', Math.round((NOW - connectedAt + expiresInMs) / 1000), parseKey(CHANNEL_KEY), connectedAt);
}

test('notices say in plain words what the customer should know, and nothing else', () => {
  const channels = (file: ChannelFile) => file.channels;
  assert.deepEqual(noticesFor(channels(channelsWith(30 * 24 * HOUR)), false, NOW), []);
  const expiring = noticesFor(channels(channelsWith(3 * 24 * HOUR)), false, NOW);
  assert.deepEqual(expiring.map((n) => n.code), ['CONNECTION_EXPIRING']);
  assert.match(expiring[0]?.message ?? '', /LinkedIn.*Asha.*3 days/);
  const expired = noticesFor(channels(channelsWith(-1000)), true, NOW);
  assert.deepEqual(expired.map((n) => n.code), ['PAUSED', 'CONNECTION_EXPIRED']);
  assert.doesNotMatch(JSON.stringify(expired), /token|urn:li/);
});

test('a workspace read says its approval is manual and carries its notices', async () => {
  await withProducts(async () => {
    const made = await call(workspacesPost, '/api/v1/workspaces', { json: { externalId: 'shop-1', name: 'Shop' } });
    const brand = String((made.body['workspace'] as { id: string }).id);
    const { file, etag } = await loadChannels();
    await saveChannels(addLinkedInMember(file, brand, { urn: 'urn:li:person:abcdefabc', name: 'Asha' }, 'token', 2 * 24 * 3600, parseKey(CHANNEL_KEY), Date.now() - 24 * HOUR), etag);
    const read = (await call(workspacesGet, '/api/v1/workspaces?externalId=shop-1')).body['workspace'] as Record<string, unknown>;
    assert.equal(read['approvalMode'], 'manual');
    assert.equal(read['website'], null);
    assert.deepEqual((read['notices'] as Array<{ code: string }>).map((n) => n.code), ['CONNECTION_EXPIRING']);
  });
});

const post = (over: Partial<ScheduledPost> = {}): ScheduledPost => ({ brand: BRAND, id: `${BRAND}-w01-d1`, date: new Date(NOW - 10 * 60_000).toISOString(), caption: 'c', image: null, manual: true, channels: ['linkedin:gone'], ...over });

test('a post aimed at an account that was disconnected is held while its window is open, missed after, and the others are unaffected', () => {
  const channels = channelsWith(30 * 24 * HOUR);
  const connected = channels.channels[0] as { id: string };
  const view = (p: ScheduledPost, at: number): { state: unknown; targets: Array<Record<string, unknown>> } => scheduledView(p, channels, {}, at, undefined, NO_PAUSES) as never;
  const held = view(post(), NOW);
  assert.equal(held.state, 'held');
  assert.deepEqual(held.targets.map((t) => [t.id, t.state, t.account, t.code]), [['linkedin:gone', 'held', null, 'ACCOUNT_DISCONNECTED']]);
  assert.equal(view(post(), NOW + 3 * 24 * HOUR).state, 'missed', 'after its window it is missed');
  assert.equal(view(post({ date: new Date(NOW + HOUR).toISOString() }), NOW).state, 'held', 'a future post waits for the account too');
  assert.equal(view(post({ skipped: true }), NOW).targets[0]?.state, 'skipped');
  const both = view(post({ channels: [connected.id, 'linkedin:gone'] }), NOW);
  assert.deepEqual(both.targets.map((t) => t.state), ['due', 'held']);
  const plain = view(post({ channels: undefined }), NOW);
  assert.deepEqual(plain.targets.map((t) => t.id), [connected.id], 'a post for every connected account has only those targets');
  assert.equal(plain.targets[0]?.code, undefined);
});

test('the product hears once that a post is held, and once that it was missed when the account never came back', () => {
  const channels = channelsWith(30 * 24 * HOUR);
  const first = problemEvents([post()], channels, {}, NO_PAUSES, clients, { announced: [] }, NOW);
  assert.deepEqual(first.items.map((i) => i.event.type), ['post.held']);
  assert.deepEqual(first.items[0]?.event.data, { externalId: 'shop-1', postId: `${BRAND}-w01-d1`, channel: 'linkedin:gone', platform: 'linkedin', date: post().date, code: 'ACCOUNT_DISCONNECTED' });
  assert.deepEqual(problemEvents([post()], channels, {}, NO_PAUSES, clients, { announced: first.announced }, NOW).items, [], 'not twice');
  const later = problemEvents([post()], channels, {}, NO_PAUSES, clients, { announced: first.announced }, NOW + 30 * HOUR);
  assert.deepEqual(later.items.map((i) => i.event.type), ['post.missed']);
  assert.equal(later.items[0]?.event.data['channel'], 'linkedin:gone');
  assert.deepEqual(problemEvents([post()], channels, {}, NO_PAUSES, clients, { announced: [...first.announced, ...later.announced] }, NOW + 30 * HOUR).items, []);
});

test('nothing is announced for our own clients, skipped posts, or a paused customer; a missed post on a connected account is announced to its product', () => {
  const channels = channelsWith(30 * 24 * HOUR);
  const connected = channels.channels[0] as { id: string };
  assert.deepEqual(problemEvents([post({ brand: 'mine' })], channels, {}, NO_PAUSES, clients, { announced: [] }, NOW).items, []);
  assert.deepEqual(problemEvents([post({ skipped: true })], channels, {}, NO_PAUSES, clients, { announced: [] }, NOW).items, []);
  assert.deepEqual(problemEvents([post()], channels, {}, { all: false, brands: [BRAND], channels: [] }, clients, { announced: [] }, NOW).items, []);
  const missed = problemEvents([post({ channels: [connected.id], date: new Date(NOW - 5 * HOUR).toISOString() })], channels, {}, NO_PAUSES, clients, { announced: [] }, NOW);
  assert.deepEqual(missed.items.map((i) => i.event.type), ['post.missed']);
  assert.equal(missed.items[0]?.event.data['externalId'], 'shop-1');
  assert.deepEqual(missed.announced, [`missed:${BRAND}-w01-d1|${connected.id}`]);
});

test('a post aimed at a whole platform with no connected account on it is held, then missed, and she is told in plain words', async () => {
  const channels = channelsWith(30 * 24 * HOUR);
  const bare = (over: Partial<ScheduledPost> = {}): ScheduledPost => post({ channels: ['linkedin', 'facebook'], fromPlan: true, ...over });
  const connected = channels.channels[0] as { id: string };
  const view = (p: ScheduledPost, at: number): { state: unknown; targets: Array<Record<string, unknown>> } => scheduledView(p, channels, {}, at, undefined, NO_PAUSES) as never;
  const held = view(bare(), NOW);
  assert.deepEqual(held.targets.map((t) => [t.id, t.state, t.account, t.code]), [[connected.id, 'due', 'Asha', undefined], ['facebook', 'held', null, 'ACCOUNT_DISCONNECTED']]);
  assert.equal(held.state, 'due', 'the account that is connected is still being sent; the missing one is listed in the targets');
  assert.equal(view(bare({ channels: ['facebook'] }), NOW).state, 'held', 'with only the missing platform the whole post is held');
  const ahead = (channelsAimed: string[]): string => view(bare({ channels: channelsAimed, date: new Date(NOW + HOUR).toISOString() }), NOW).state as string;
  assert.equal(ahead(['linkedin', 'facebook']), 'scheduled', 'one network still to be sent: the post is not on hold');
  assert.equal(ahead(['facebook', 'google']), 'held', 'every target missing: on hold');
  assert.equal(view(bare(), NOW + 3 * 24 * HOUR).targets.find((t) => t.id === 'facebook')?.state, 'missed');
  assert.deepEqual(view(bare({ channels: ['linkedin'] }), NOW).targets.map((t) => t.code), [undefined], 'nothing is missing when every platform is connected');
  assert.deepEqual(view(bare({ channels: ['instagram'], fromPlan: false }), NOW).targets, [], 'the team\'s own Instagram is not a customer\'s account');
  assert.ok(connected.id);

  const first = problemEvents([bare()], channels, {}, NO_PAUSES, clients, { announced: [] }, NOW);
  assert.deepEqual(first.items.map((i) => [i.event.type, i.event.data['channel'], i.event.data['platform']]), [['post.held', 'facebook', 'facebook']]);
  assert.deepEqual(problemEvents([bare()], channels, {}, NO_PAUSES, clients, { announced: first.announced }, NOW).items, []);

  const notices = disconnectedNotices([bare({ date: new Date(NOW + HOUR).toISOString() }), bare({ id: 'x2', date: new Date(NOW + 2 * HOUR).toISOString() }), bare({ id: 'x3', skipped: true, date: new Date(NOW + 3 * HOUR).toISOString() }), bare({ id: 'x4', date: new Date(NOW - HOUR).toISOString() })], channels.channels, NOW);
  assert.deepEqual(notices.map((n) => [n.code, n.platform]), [['ACCOUNT_DISCONNECTED', 'facebook']]);
  assert.match(notices[0]?.message ?? '', /Facebook account is not connected, so 2 scheduled posts are for it on hold/);
});
