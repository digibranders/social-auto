import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GET as postsGet, PATCH as postsPatch } from '../api/_v1/posts.ts';
import { POST as workspacesPost } from '../api/_v1/workspaces.ts';
import { call, CHANNEL_KEY, withProducts, type Answer } from '../dev/product-test-kit.ts';
import { ERROR_CODES, type ErrorCode } from './api-error.ts';
import { addLinkedInMember } from './channels.ts';
import { releasedSchedule } from './customer-skip.ts';
import { parseKey } from './crypto.ts';
import type { ScheduledPost } from './schedule.ts';
import { loadChannels, saveChannels } from './store.ts';

const DAY = 86_400_000;
/** The day (India time) this many days from now, as YYYY-MM-DD. */
const dayIn = (days: number): string => new Date(Date.now() + days * DAY + 5.5 * 3_600_000).toISOString().slice(0, 10);

function expectError(answer: Answer, status: number, code: ErrorCode, label: string): void {
  assert.equal(answer.status, status, `${label}: status (${JSON.stringify(answer.body)})`);
  assert.equal(answer.body['code'], code, `${label}: code (${JSON.stringify(answer.body)})`);
  assert.ok(ERROR_CODES.includes(code));
}

async function workspace(externalId: string): Promise<string> {
  const made = await call(workspacesPost, '/api/v1/workspaces', { json: { externalId, name: externalId } });
  return String((made.body['workspace'] as { id: string }).id);
}

const planned = (brand: string, postId: string, daysAhead: number, time = '10:00'): ScheduledPost => ({ brand, id: `${brand}-${postId}`, date: `${dayIn(daysAhead)}T${time}:00+05:30`, caption: 'Fresh laddoos', image: '/posts/x/a.jpg', fromPlan: true, channels: ['instagram', 'linkedin'], variants: { linkedin: { caption: 'LinkedIn words' } } });
const move = (brand: string, postId: string, json: Record<string, unknown>, ext = 'shop-1'): Promise<Answer> => call(postsPatch, `/api/v1/posts?externalId=${ext}&postId=${encodeURIComponent(`${brand}-${postId}`)}`, { method: 'PATCH', json });

test('a scheduled post written for the customer can be moved to another day and time; words and pictures stay, every network moves together', async () => {
  await withProducts(async () => {
    const brand = await workspace('shop-1');
    const { file, etag } = await loadChannels();
    await saveChannels(addLinkedInMember(file, brand, { urn: 'urn:li:person:abcdefabc', name: 'T' }, 'token', 5_000_000, parseKey(CHANNEL_KEY), Date.now() - 3_600_000), etag);
    releasedSchedule.read = () => [planned(brand, 'w01-d1', 2), planned(brand, 'w01-d2', 4)];

    const moved = await move(brand, 'w01-d1', { day: dayIn(3), time: '14:30' });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    const post = moved.body['post'] as Record<string, unknown>;
    assert.equal(post['date'], `${dayIn(3)}T14:30:00+05:30`);
    assert.equal(post['caption'], 'Fresh laddoos');
    assert.deepEqual(Object.keys(post['variants'] as object), ['linkedin']);
    // Instagram is not connected in this test, so its part is on hold; LinkedIn is scheduled, so the post as a whole is still scheduled.
    assert.equal(post['state'], 'scheduled');
    assert.deepEqual((post['targets'] as Array<Record<string, unknown>>).map((t) => [t['platform'], t['state']]), [['linkedin', 'scheduled'], ['instagram', 'held']]);

    // The calendar shows the move, and a release pass that writes the same schedule again does not put it back.
    for (let pass = 0; pass < 2; pass += 1) {
      const list = (await call(postsGet, '/api/v1/posts?externalId=shop-1')).body['posts'] as Array<Record<string, unknown>>;
      assert.equal(list.find((p) => p['id'] === `${brand}-w01-d1`)?.['date'], `${dayIn(3)}T14:30:00+05:30`);
      releasedSchedule.read = () => [planned(brand, 'w01-d1', 2), planned(brand, 'w01-d2', 4)];
    }

    // Only a time: the post stays on its (moved) day.
    const later = await move(brand, 'w01-d1', { time: '18:00' });
    assert.equal((later.body['post'] as Record<string, unknown>)['date'], `${dayIn(3)}T18:00:00+05:30`);
    // Back to its planned day and time: the move is undone.
    const back = await move(brand, 'w01-d1', { day: dayIn(2), time: '10:00' });
    assert.equal((back.body['post'] as Record<string, unknown>)['date'], `${dayIn(2)}T10:00:00+05:30`);
  });
});

test('moving a scheduled post: what is refused, and why', async () => {
  await withProducts(async () => {
    const brand = await workspace('shop-1');
    const other = await workspace('shop-2');
    releasedSchedule.read = () => [planned(brand, 'w01-d1', 2), planned(brand, 'w01-d2', 4), planned(other, 'w01-d1', 2), planned(brand, 'w00-d1', -1, '09:00')];
    expectError(await move(brand, 'w01-d1', { caption: 'new words' }), 400, 'INVALID_REQUEST', 'only a move is allowed');
    expectError(await move(brand, 'w01-d1', { day: dayIn(3), pictureId: 'x' }), 400, 'INVALID_REQUEST', 'pictures stay');
    expectError(await move(brand, 'w01-d1', {}), 400, 'NOTHING_TO_CHANGE', 'nothing said');
    expectError(await move(brand, 'w01-d1', { day: dayIn(4) }), 409, 'CONFLICT', 'another post is planned that day');
    expectError(await move(brand, 'w01-d1', { day: dayIn(-2) }), 400, 'TIME_PASSED', 'a day that has passed');
    expectError(await move(brand, 'w01-d1', { day: dayIn(3), time: '25:99' }), 400, 'INVALID_TIME', 'a bad time');
    expectError(await move(brand, 'w01-d1', { day: 'tomorrow' }), 400, 'INVALID_DAY', 'a bad day');
    expectError(await move(brand, 'w00-d1', { day: dayIn(3) }), 409, 'POST_NOT_EDITABLE', 'already due');
    expectError(await move(brand, 'w99-d9', { day: dayIn(3) }), 404, 'POST_NOT_FOUND', 'no such post');
    // Another customer's post looks like one that does not exist, in both directions.
    expectError(await call(postsPatch, `/api/v1/posts?externalId=shop-1&postId=${encodeURIComponent(`${other}-w01-d1`)}`, { method: 'PATCH', json: { day: dayIn(3) } }), 404, 'POST_NOT_FOUND', 'another customer\'s post');
  });
});
