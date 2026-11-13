import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addInstagramAccount } from './channels.ts';
import { parseKey } from './crypto.ts';
import { overallState, scheduledView } from './post-view.ts';

const KEY = parseKey('11'.repeat(32));
const T0 = Date.parse('2026-10-30T09:00:00Z');
const channels = addInstagramAccount({ channels: [] }, 'brandbasket-biz-1', { userId: '17841400000000001', username: 'acme_foods' }, 'tok', 60 * 24 * 60 * 60, KEY, T0);
const planned = { id: 'w1-d1', brand: 'brandbasket-biz-1', date: '2026-11-04T10:00:00+05:30', caption: 'Hello', image: '/posts/w1-d1.jpg' };

test('a planned post is shown with its picture address, where it goes and where it stands', () => {
  const view = scheduledView(planned, channels, {}, Date.parse('2026-11-02T05:00:00Z'), 'https://pub.example');
  assert.equal(view['imageUrl'], 'https://pub.example/posts/w1-d1.jpg');
  assert.equal(view['manual'], false);
  assert.equal(view['state'], 'scheduled');
  assert.deepEqual(view['channels'], [{ id: 'instagram:17841400000000001', platform: 'instagram', account: 'acme_foods', state: 'scheduled', permalink: null }]);
});

test('a hand-made post says so, and a post with no picture or no origin has no picture address', () => {
  assert.equal(scheduledView({ ...planned, manual: true }, channels, {}, T0, 'https://pub.example')['manual'], true);
  assert.equal('imageUrl' in scheduledView({ ...planned, image: null }, channels, {}, T0, 'https://pub.example'), false);
  assert.equal('imageUrl' in scheduledView(planned, channels, {}, T0), false);
});

test('one overall state: published only when every channel has it', () => {
  assert.equal(overallState([{ state: 'published' }, { state: 'published' }], 1, 2), 'published');
  assert.equal(overallState([{ state: 'published' }, { state: 'missed' }], 1, 2), 'missed');
  assert.equal(overallState([], 5, 2), 'scheduled');
});

test('a carousel is shown with the address of every picture, in order', () => {
  const carousel = { ...planned, images: ['/posts/c/1.jpg', '/posts/c/2.jpg'] };
  const view = scheduledView({ ...carousel, image: '/posts/c/1.jpg' }, channels, {}, Date.parse('2026-11-02T05:00:00Z'), 'https://pub.example');
  assert.deepEqual(view['imageUrls'], ['https://pub.example/posts/c/1.jpg', 'https://pub.example/posts/c/2.jpg']);
  assert.equal(scheduledView(planned, channels, {}, Date.parse('2026-11-02T05:00:00Z'), 'https://pub.example')['imageUrls'], undefined);
});

test('a post that already went out to an account which later moved to another workspace stays published, and one that never went out there is missed', () => {
  const after = Date.parse('2026-11-05T05:00:00Z');
  const aimed = { ...planned, channels: ['instagram:17841499999999999'], fromPlan: true as const };
  // The account the post was aimed at is no longer connected to this workspace.
  const sent = { 'w1-d1|instagram:17841499999999999': { remoteId: 'r1', permalink: 'https://instagram.example/p/1', postedAt: '2026-11-04T04:30:00Z' } };
  const done = scheduledView(aimed, channels, sent, after, 'https://pub.example');
  assert.equal(done['state'], 'published');
  assert.deepEqual((done['targets'] as Array<Record<string, unknown>>).map((t) => [t['id'], t['state'], t['permalink']]), [['instagram:17841499999999999', 'published', 'https://instagram.example/p/1']]);
  const never = scheduledView(aimed, channels, {}, after, 'https://pub.example');
  assert.equal(never['state'], 'missed');
  assert.deepEqual((never['targets'] as Array<Record<string, unknown>>).map((t) => [t['id'], t['state'], t['code']]), [['instagram:17841499999999999', 'missed', 'ACCOUNT_DISCONNECTED']]);
});
