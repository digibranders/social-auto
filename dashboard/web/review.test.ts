import assert from 'node:assert/strict';
import { test } from 'node:test';
import { costText, failureText, imageUrl, parseQueue, queryStatus, REASON_LABELS } from './review.ts';
import { parseRoute, routeHash } from './route.ts';

const good = { versionId: 'acme.0123456789abcdef', brand: 'acme', postId: 'w01-d1', versionNumber: 2, status: 'pending', headline: 'H', caption: 'C', createdAt: '2026-11-05T10:00:00Z', costUsd: 0.016 };

test('the queue keeps well formed entries and drops anything else', () => {
  const parsed = parseQueue({ posts: [good, { ...good, status: 'weird' }, { ...good, versionId: 5 }, null, 'x'], reasons: ['weak_copy', 'made_up'] });
  assert.equal(parsed.posts.length, 1);
  assert.deepEqual(parsed.reasons, ['weak_copy']);
  assert.deepEqual(parseQueue(null), { posts: [], reasons: Object.keys(REASON_LABELS), problems: [] });
  assert.deepEqual(parseQueue({ posts: [], problems: [{ brand: 'acme', message: 'The review record needs administrator recovery.' }, { brand: 5 }] }).problems, ['acme: The review record needs administrator recovery.']);
});

test('pictures are asked for by version, as a preview or a download, with the id escaped', () => {
  assert.equal(imageUrl('acme.0123456789abcdef'), '/api/review?view=image&id=acme.0123456789abcdef');
  assert.equal(imageUrl('acme.0123456789abcdef', 'download'), '/api/review?view=download&id=acme.0123456789abcdef');
  assert.equal(imageUrl('a b&c'), '/api/review?view=image&id=a%20b%26c');
});

test('failures use the service\'s own words, or say what failed', () => {
  assert.equal(failureText({ error: 'a newer version of this post exists; approve that one' }, 409), 'a newer version of this post exists; approve that one');
  assert.equal(failureText(null, 502), 'That did not work (502).');
  assert.equal(costText(0.0161), '$0.016');
  assert.equal(costText(0), 'free');
});

test('the review page has its own address', () => {
  assert.deepEqual(parseRoute('#/review'), { page: 'review' });
  assert.equal(routeHash({ page: 'review' }), '#/review');
});

test('the "To review" tab asks for what waits and what must be confirmed again; a held poster is a valid entry', () => {
  assert.equal(queryStatus('pending'), 'open');
  assert.equal(queryStatus('approved'), 'approved');
  const parsed = parseQueue({ posts: [{ versionId: 'acme.0123456789abcdef', brand: 'acme', postId: 'p', versionNumber: 1, status: 'held', headline: 'H', caption: 'C', createdAt: '', costUsd: 0 }] });
  assert.equal(parsed.posts[0]?.status, 'held');
});
