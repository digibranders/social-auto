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
