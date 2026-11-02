import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildManualPost, isManualId, parseManualFile, postDateFor, toScheduled } from './manual.ts';
import { applyOverrides } from './overrides.ts';
import { buildStatus, dueManualPosts, isWantedOn, postsLeftByBrand, type ScheduledPost } from './schedule.ts';

const NOW = Date.parse('2026-11-02T08:00:00Z');
const KEY = 'a'.repeat(32);
const input = { brand: 'brandbasket', day: '2026-11-05', caption: 'Hello there', imageKey: KEY, channels: ['linkedin:abc'] };
const allowed = ['instagram', 'facebook:77', 'linkedin:abc'];

test('a hand-made post is set for the daily run on the chosen day and keeps only the chosen channels', () => {
  const post = buildManualPost({ ...input, channels: ['linkedin:abc', 'linkedin:abc', 'instagram'] }, allowed, NOW);
  assert.match(post.id, /^manual-[0-9a-f]{12}$/);
  assert.equal(post.date, '2026-11-05T10:00:00+05:30');
  assert.deepEqual(post.channels, ['linkedin:abc', 'instagram']);
  assert.deepEqual(parseManualFile({ posts: [post] }).posts[0], post);
  const scheduled = toScheduled(post);
  assert.equal(scheduled.manual, true);
  assert.equal(scheduled.image, `/api/edited-image?k=${KEY}`);
});

test('a post with no channel, an unconnected channel, a bad day, picture or caption is refused', () => {
  assert.throws(() => buildManualPost({ ...input, channels: [] }, allowed, NOW), /at least one channel/);
  assert.throws(() => buildManualPost({ ...input, channels: 'instagram' }, allowed, NOW), /where to post/);
  assert.throws(() => buildManualPost({ ...input, channels: ['facebook:99'] }, allowed, NOW), /not connected/);
  assert.throws(() => buildManualPost({ ...input, imageKey: 'x' }, allowed, NOW), /picture/);
  assert.throws(() => buildManualPost({ ...input, caption: '   ' }, allowed, NOW), /empty/);
  assert.throws(() => postDateFor('soon', NOW), /choose a day/);
  assert.throws(() => postDateFor('2026-02-31', NOW), /does not exist/);
  assert.throws(() => postDateFor('2026-11-02', NOW), /already passed/);
  assert.throws(() => postDateFor('2027-03-01', NOW), /within the next 90 days/);
  assert.equal(postDateFor('2026-11-03', NOW), '2026-11-03T10:00:00+05:30');
  assert.equal(isManualId('manual-0123456789ab'), true);
  assert.equal(isManualId('../x'), false);
});

test('malformed manual files are rejected', () => {
  assert.throws(() => parseManualFile({}), /posts/);
  assert.throws(() => parseManualFile({ posts: [{ id: 'manual-0123456789ab' }] }), /non-empty string/);
});

const planned: ScheduledPost = { id: 'p1', brand: 'brandbasket', date: '2026-11-02T10:00:00+05:30', caption: 'Planned', image: '/posts/a.jpg' };
const extra = (id: string, date: string, channels?: string[]): ScheduledPost => ({ id, brand: 'brandbasket', date, caption: id, image: '/posts/b.jpg', manual: true, ...(channels ? { channels } : {}) });

test('several hand-made posts can be due together; they are oldest first, only inside the window, and planned ones are excluded', () => {
  const now = Date.parse('2026-11-03T05:00:00Z');
  const posts = [planned, extra('b', '2026-11-03T10:00:00+05:30'), extra('a', '2026-11-03T09:00:00+05:30'), extra('late', '2026-11-04T10:00:00+05:30'), extra('old', '2026-11-01T10:00:00+05:30')];
  assert.deepEqual(dueManualPosts(posts, now).map((p) => p.id), ['a', 'b']);
});

test('extra posts do not count towards the planned runway', () => {
  const left = postsLeftByBrand([{ ...planned, date: '2026-11-09T10:00:00+05:30' }, extra('x', '2026-11-10T10:00:00+05:30')], NOW);
  assert.equal(left.get('brandbasket'), 1);
});

test('a post without a channel list goes everywhere; one with a list only to those channels', () => {
  assert.equal(isWantedOn(planned, 'instagram'), true);
  assert.equal(isWantedOn(extra('x', planned.date, ['linkedin:abc']), 'instagram'), false);
  assert.equal(isWantedOn(extra('x', planned.date, ['linkedin:abc']), 'linkedin:abc'), true);
});

test('a post that skips Instagram is not matched to an Instagram post and shows its list of channels', () => {
  const media = [{ id: 'm1', caption: 'x', timestamp: 't', permalink: 'p', mediaUrl: null }];
  const { posts } = buildStatus([extra('x', '2026-11-05T10:00:00+05:30', ['linkedin:abc']), { ...planned, caption: 'x' }], media, NOW, 'https://o');
  const skip = posts.find((p) => p.id === 'x')!;
  assert.equal(skip.state, 'scheduled');
  assert.equal(skip.manual, true);
  assert.deepEqual(skip.channels, ['linkedin:abc']);
  assert.equal(posts.find((p) => p.id === 'p1')!.state, 'published');
  assert.equal(posts.find((p) => p.id === 'p1')!.channels, null);
});

test('edits apply to hand-made posts like any other', () => {
  const [edited] = applyOverrides([extra('manual-0123456789ab', planned.date)], { 'manual-0123456789ab': { caption: 'New words', updatedAt: 'x' } });
  assert.equal(edited?.caption, 'New words');
  assert.equal(edited?.manual, true);
});
