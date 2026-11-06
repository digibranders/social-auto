import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildStatus, duePost, lowQueueWarnings, parseSchedule, sameCaption, ScheduleError, usesTeamInstagram, type ScheduledPost } from './schedule.ts';

const hour = 60 * 60 * 1000;
const NOW = Date.parse('2026-12-10T12:00:00+05:30');
const at = (offsetHours: number): string => new Date(NOW + offsetHours * hour).toISOString();
const scheduled = (id: string, offsetHours: number, caption: string, image: string | null = `/posts/b/${id}.jpg`) => ({
  brand: 'b',
  id,
  date: at(offsetHours),
  caption,
  image,
});
const media = (id: string, caption: string) => ({
  id,
  caption,
  timestamp: '2026-12-09T04:40:00+0000',
  permalink: `https://instagram.com/p/${id}/`,
  mediaUrl: `https://cdn.example/${id}.jpg`,
});

test('buildStatus tells published, due, missed and scheduled posts apart', () => {
  const posts = [
    scheduled('old-live', -50, 'Live  caption', null),
    scheduled('old-lost', -48, 'Lost caption', null),
    scheduled('today', -2, 'Today caption'),
    scheduled('soon', 22, 'Soon caption'),
  ];
  const { posts: result, runway } = buildStatus(posts, [media('m1', 'Live caption')], NOW, 'https://pub.example');
  const state = Object.fromEntries(result.map((p) => [p.id, p.state]));
  assert.deepEqual(state, { 'old-live': 'published', 'old-lost': 'missed', today: 'due', soon: 'scheduled' });
  const live = result.find((p) => p.id === 'old-live');
  assert.equal(live?.permalink, 'https://instagram.com/p/m1/');
  assert.equal(live?.mediaUrl, 'https://cdn.example/m1.jpg');
  assert.equal(live?.image, null);
  assert.equal(result.find((p) => p.id === 'soon')?.image, 'https://pub.example/posts/b/soon.jpg');
  assert.deepEqual(runway, [{ brand: 'b', postsLeft: 1 }]);
});

test('buildStatus does not guess about the past when Instagram cannot be reached', () => {
  const posts = [scheduled('past', -48, 'P', null), scheduled('future', 5, 'F')];
  const { posts: result } = buildStatus(posts, null, NOW, 'https://pub.example');
  assert.deepEqual(result.map((p) => p.state), ['unknown', 'scheduled']);
});

test('buildStatus matches each Instagram post to at most one scheduled post and sorts by date', () => {
  const posts = [scheduled('b', 5, 'Same'), scheduled('a', -3, 'Same')];
  const { posts: result } = buildStatus(posts, [media('m1', 'Same')], NOW, 'https://pub.example');
  assert.deepEqual(result.map((p) => [p.id, p.state]), [['a', 'published'], ['b', 'scheduled']]);
});

test('parseSchedule accepts a null poster and duePost never picks a post without one', () => {
  const parsed = parseSchedule({ posts: [{ id: 'x', date: at(-1), caption: 'c', image: null }] });
  assert.equal(parsed[0]?.image, null);
  assert.equal(duePost(parsed, NOW), null);
  assert.throws(() => parseSchedule({ posts: [{ id: 'x', date: at(-1), caption: 'c', image: '' }] }), ScheduleError);
});

test('lowQueueWarnings reports clients whose schedule is about to run out', () => {
  const day = (brand: string, date: string) => ({ brand, id: `${brand}-${date}`, date: `${date}T10:00:00+05:30`, caption: 'c', image: '/i' });
  const now = Date.parse('2026-12-04T10:30:00+05:30');
  const posts = [
    day('a', '2026-12-04'), day('a', '2026-12-05'), day('a', '2026-12-06'),
    day('b', '2026-12-04'),
    day('c', '2026-12-05'), day('c', '2026-12-06'), day('c', '2026-12-07'),
  ];
  // a: 2 left (no warning), b: 0 left (warn), c: 3 left (warn)
  assert.deepEqual(lowQueueWarnings(posts, now), [
    { brand: 'b', postsLeft: 0 },
    { brand: 'c', postsLeft: 3 },
  ]);
});

test('lowQueueWarnings treats posts without a brand as one default client', () => {
  const now = Date.parse('2026-12-04T10:30:00+05:30');
  assert.deepEqual(lowQueueWarnings([{ id: 'x', date: '2026-12-05T10:00:00+05:30', caption: 'c', image: '/i' }], now), [
    { brand: 'default', postsLeft: 1 },
  ]);
});

const posts = parseSchedule({
  posts: [
    { id: 'a', date: '2026-10-29T10:00:00+05:30', caption: 'A', image: '/posts/a.jpg' },
    { id: 'b', date: '2026-10-30T10:00:00+05:30', caption: 'B', image: '/posts/b.jpg' },
  ],
});

test('duePost picks the post whose time has just passed', () => {
  assert.equal(duePost(posts, Date.parse('2026-10-29T10:20:00+05:30'))?.id, 'a');
  assert.equal(duePost(posts, Date.parse('2026-10-30T10:59:00+05:30'))?.id, 'b');
});

test('duePost returns nothing before the time or long after it', () => {
  assert.equal(duePost(posts, Date.parse('2026-10-29T09:59:00+05:30')), null);
  assert.equal(duePost(posts, Date.parse('2026-11-02T10:00:00+05:30')), null);
});

test('parseSchedule rejects incomplete posts', () => {
  assert.throws(() => parseSchedule({ posts: [{ id: 'x', date: 'nope', caption: 'c', image: '/i' }] }), ScheduleError);
  assert.throws(() => parseSchedule({}), ScheduleError);
});

test('sameCaption ignores whitespace differences', () => {
  assert.ok(sameCaption('Hello\n\nworld ', 'Hello world'));
  assert.ok(!sameCaption('Hello', 'Hello there'));
});

test('the team\'s shared Instagram is a target of a post unless the post was made from a client\'s plan', () => {
  assert.equal(usesTeamInstagram({}), true, 'a post with no channels goes everywhere, as before');
  assert.equal(usesTeamInstagram({ channels: ['instagram'] }), true, 'a hand-made post that names the account still uses it');
  assert.equal(usesTeamInstagram({ channels: ['linkedin:abc'] }), false);
  assert.equal(usesTeamInstagram({ channels: ['instagram'], fromPlan: true }), false, 'a plan that says Instagram means the client\'s own account');
  assert.equal(usesTeamInstagram({ fromPlan: true }), false);
  assert.equal(usesTeamInstagram({ channels: ['instagram'], fromPlan: false }), true);
});

test('a post made from a plan is never matched to the shared Instagram account\'s pictures, and is not reported unknown when that account cannot be reached', () => {
  const plan = { ...scheduled('p1', -30, 'Same caption'), channels: ['instagram'], fromPlan: true };
  const plain = { ...scheduled('p2', -30, 'Same caption'), channels: ['instagram'] };
  const matched = buildStatus([plan], [media('m1', 'Same caption')], NOW, 'https://pub.example').posts[0];
  assert.notEqual(matched?.state, 'published', 'the caption on the shared account is not this client\'s post');
  assert.equal(matched?.permalink, null);
  assert.equal(buildStatus([plain], [media('m1', 'Same caption')], NOW, 'https://pub.example').posts[0]?.state, 'published', 'a post that does use the shared account is matched as before');
  assert.notEqual(buildStatus([plan], null, NOW, 'https://pub.example').posts[0]?.state, 'unknown');
  assert.equal(buildStatus([plain], null, NOW, 'https://pub.example').posts[0]?.state, 'unknown');
});


test('a post with its own time that was never sent is missed after half an hour, and a plain planned post keeps the day', () => {
  const at = '2026-11-06T14:00:00+05:30';
  const post = (extra: Partial<ScheduledPost>): ScheduledPost => ({ id: 'x', brand: 'acme', date: at, caption: 'c', image: '/x.jpg', ...extra });
  const stateAt = (p: ScheduledPost, minutes: number) => buildStatus([p], [], Date.parse(at) + minutes * 60_000, 'https://example.test').posts[0]?.state;
  assert.equal(stateAt(post({ ownTime: true, channels: ['linkedin'] }), 10), 'due');
  assert.equal(stateAt(post({ ownTime: true, channels: ['linkedin'] }), 31), 'missed');
  assert.equal(stateAt(post({ manual: true, channels: ['linkedin'] }), 31), 'missed');
  assert.equal(stateAt(post({ channels: ['linkedin'] }), 31), 'due', 'a plain planned post is sent by the daily run, which may come hours later');
});
