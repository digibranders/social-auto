import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildManualPost, dateOfNow, editManualPost, isManualId, pictureInUse, parseManualFile, postDateFor, toScheduled } from './manual.ts';
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

test('a hand-made post can carry its own time of day, which defaults to the daily 10:00', () => {
  assert.equal(postDateFor('2026-11-05', NOW, '12:05'), '2026-11-05T12:05:00+05:30');
  assert.equal(postDateFor('2026-11-05', NOW, undefined), '2026-11-05T10:00:00+05:30');
  assert.equal(buildManualPost({ ...input, time: '17:30' }, allowed, NOW).date, '2026-11-05T17:30:00+05:30');
  // Today works when the time is still ahead (NOW is 13:30 in India), but not when it has passed or is about to.
  assert.equal(postDateFor('2026-11-02', NOW, '15:00'), '2026-11-02T15:00:00+05:30');
  assert.throws(() => postDateFor('2026-11-02', NOW, '13:00'), /already passed/);
  assert.throws(() => postDateFor('2026-11-02', NOW, '13:30'), /already passed/);
  for (const bad of ['25:00', '12:60', '9:5', 'noon', '12:05:00', 5]) assert.throws(() => postDateFor('2026-11-05', NOW, bad), /time/);
});

test('editing a post can move its time, alone or with the day, and leaves it alone when nothing differs', () => {
  const post = buildManualPost({ ...input, time: '12:05' }, allowed, NOW);
  assert.equal(editManualPost(post, { time: '16:45' }, allowed, NOW).date, '2026-11-05T16:45:00+05:30');
  assert.equal(editManualPost(post, { day: '2026-11-09' }, allowed, NOW).date, '2026-11-09T12:05:00+05:30');
  assert.equal(editManualPost(post, { day: '2026-11-09', time: '08:00' }, allowed, NOW).date, '2026-11-09T08:00:00+05:30');
  assert.equal(editManualPost(post, { time: '12:05' }, allowed, NOW).date, post.date);
  assert.throws(() => editManualPost(post, { time: 'late' }, allowed, NOW), /time/);
});

test('malformed manual files are rejected', () => {
  assert.throws(() => parseManualFile({}), /posts/);
  assert.throws(() => parseManualFile({ posts: [{ id: 'manual-0123456789ab' }] }), /non-empty string/);
});

const planned: ScheduledPost = { id: 'p1', brand: 'brandbasket', date: '2026-11-02T10:00:00+05:30', caption: 'Planned', image: '/posts/a.jpg' };
const extra = (id: string, date: string, channels?: string[]): ScheduledPost => ({ id, brand: 'brandbasket', date, caption: id, image: '/posts/b.jpg', manual: true, ...(channels ? { channels } : {}) });

test('the frequent run only picks up hand-made posts that became due in its short window', () => {
  const now = Date.parse('2026-11-03T06:40:00Z'); // 12:10 in India
  const posts = [planned, extra('fresh', '2026-11-03T12:05:00+05:30'), extra('stale', '2026-11-03T10:00:00+05:30'), extra('later', '2026-11-03T12:30:00+05:30')];
  assert.deepEqual(dueManualPosts(posts, now, 15 * 60 * 1000).map((p) => p.id), ['fresh']);
  assert.deepEqual(dueManualPosts(posts, now).map((p) => p.id), ['fresh'], 'a post two hours late is too late for its own time: it is missed, not posted the next morning');
  assert.deepEqual(dueManualPosts([extra('recent', '2026-11-03T11:50:00+05:30')], now).map((p) => p.id), ['recent'], 'twenty minutes late is still sent');
});

test('several hand-made posts can be due together; they are oldest first, only inside the window, and planned ones are excluded', () => {
  const now = Date.parse('2026-11-03T04:50:00Z'); // 10:20 in India
  const posts = [planned, extra('b', '2026-11-03T10:00:00+05:30'), extra('a', '2026-11-03T09:55:00+05:30'), extra('early', '2026-11-03T09:00:00+05:30'), extra('late', '2026-11-04T10:00:00+05:30'), extra('old', '2026-11-01T10:00:00+05:30')];
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

test('an edit changes only what is sent and checks it like a new post', () => {
  const post = buildManualPost(input, allowed, NOW);
  const other = 'b'.repeat(32);
  const moved = editManualPost(post, { day: '2026-11-09', caption: '  New words ', imageKey: other, channels: ['facebook:77'] }, allowed, NOW);
  assert.equal(moved.date, '2026-11-09T10:00:00+05:30');
  assert.equal(moved.caption, 'New words');
  assert.equal(moved.imageKey, other);
  assert.deepEqual(moved.channels, ['facebook:77']);
  assert.equal(moved.id, post.id);
  const same = editManualPost(post, { caption: 'Only words' }, allowed, NOW);
  assert.equal(same.date, post.date);
  assert.deepEqual(same.channels, post.channels);
  assert.equal(editManualPost(post, { day: '2026-11-05' }, allowed, NOW).date, post.date);
});

test('an edit with nothing to change, or a bad day, picture, caption or channel, is refused', () => {
  const post = buildManualPost(input, allowed, NOW);
  assert.throws(() => editManualPost(post, {}, allowed, NOW), /nothing to change/);
  assert.throws(() => editManualPost(post, { day: '2026-11-02' }, allowed, NOW), /already passed/);
  assert.throws(() => editManualPost(post, { caption: ' ' }, allowed, NOW), /empty/);
  assert.throws(() => editManualPost(post, { imageKey: 'x' }, allowed, NOW), /picture/);
  assert.throws(() => editManualPost(post, { channels: [] }, allowed, NOW), /at least one channel/);
  assert.throws(() => editManualPost(post, { channels: ['facebook:99'] }, allowed, NOW), /not connected/);
});

test('a post sent now is dated now, in India time', () => {
  assert.equal(dateOfNow(Date.parse('2026-11-03T05:56:07Z')), '2026-11-03T11:26:07+05:30');
  assert.equal(dateOfNow(Date.parse('2026-11-03T20:00:00Z')), '2026-11-04T01:30:00+05:30');
  assert.equal(Date.parse(dateOfNow(NOW)), Math.floor(NOW / 1000) * 1000);
});

test('a picture shared by several posts is in use until the last of them lets it go', () => {
  const a = buildManualPost(input, allowed, NOW);
  const b = { ...buildManualPost(input, allowed, NOW), id: 'manual-bbbbbbbbbbbb' };
  const c = { ...buildManualPost({ ...input, imageKey: 'c'.repeat(32) }, allowed, NOW), id: 'manual-cccccccccccc' };
  assert.equal(pictureInUse(KEY, [b, c], {}), true);
  assert.equal(pictureInUse(KEY, [c], {}), false);
  assert.equal(pictureInUse('d'.repeat(32), [a, c], { [a.id]: { imageKey: 'd'.repeat(32), updatedAt: 'x' } }), true);
});
