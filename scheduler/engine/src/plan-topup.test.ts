import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repeatsOne, topUpPlan } from './plan-topup.ts';
import type { PlannedPost } from './content.ts';

const post = (id: string, day: string, headline: string, message = `message of ${headline}`): PlannedPost => ({ id, date: `${day}T10:00:00+05:30`, headline, painPoint: 'p', concept: { message } }) as unknown as PlannedPost;
const dateOf = (day: string): string => `${day}T10:00:00+05:30`;
const idOf = (i: number): string => `w01-d${i + 1}`;
const days = ['2026-12-07', '2026-12-08', '2026-12-09'];

test('a draft repeats a post when it has the same headline or the same message, not otherwise', () => {
  const have = [post('a', '2026-12-07', 'Chat with your documents', 'answers from your own docs')];
  assert.equal(repeatsOne(post('x', '2026-12-08', 'chat with YOUR documents!'), have), true, 'the same headline, spelled differently');
  assert.equal(repeatsOne(post('x', '2026-12-08', 'A new headline', 'answers from your own docs'), have), true, 'the same message');
  assert.equal(repeatsOne(post('x', '2026-12-08', 'A new headline', 'something else'), have), false);
});

test('empty days are filled from the reserve first, then by writing the day once more, and a day nobody could write stays empty; the plan is renumbered in day order', async () => {
  const written: string[] = [];
  const logs: string[] = [];
  const result = await topUpPlan({
    posts: [post('p1', '2026-12-07', 'First idea')],
    requestedDays: days,
    reserve: [post('r1', '2026-11-01', 'Reserve idea'), post('r2', '2026-11-01', 'First idea')],
    writeDay: async (day) => { written.push(day); return day === '2026-12-09' ? null : post('w', day, `Written for ${day}`); },
    dateOf, idOf, log: (m) => logs.push(m),
  });
  assert.deepEqual(result.fromReserve, ['2026-12-08'], 'the reserve draft that is not a repeat');
  assert.deepEqual(written, ['2026-12-09'], 'a second reserve draft repeats the first idea, so the last day is written once more');
  assert.deepEqual(result.written, []);
  assert.deepEqual(result.stillEmpty, ['2026-12-09']);
  assert.deepEqual(result.posts.map((p) => [p.id, p.date.slice(0, 10), p.headline]), [['w01-d1', '2026-12-07', 'First idea'], ['w01-d2', '2026-12-08', 'Reserve idea']]);
  assert.ok(logs.some((l) => /no post could be written, the day stays empty/.test(l)));
});

test('a day written once more is used, unless it repeats a post the plan already has; a writer that throws leaves the day empty; nothing missing changes nothing', async () => {
  const dup = await topUpPlan({ posts: [post('p1', '2026-12-07', 'Same')], requestedDays: ['2026-12-07', '2026-12-08'], reserve: [], writeDay: async (day) => post('w', day, 'same'), dateOf, idOf });
  assert.deepEqual([dup.written, dup.stillEmpty], [[], ['2026-12-08']]);
  const ok = await topUpPlan({ posts: [post('p1', '2026-12-07', 'One')], requestedDays: ['2026-12-07', '2026-12-08'], reserve: [], writeDay: async (day) => post('w', day, 'Two'), dateOf, idOf });
  assert.deepEqual([ok.written, ok.stillEmpty, ok.posts.length], [['2026-12-08'], [], 2]);
  const boom = await topUpPlan({ posts: [], requestedDays: ['2026-12-07'], reserve: [], writeDay: async () => { throw new Error('no valid answer'); }, dateOf, idOf });
  assert.deepEqual([boom.stillEmpty, boom.posts.length], [['2026-12-07'], 0]);
  const same = await topUpPlan({ posts: [post('p1', '2026-12-07', 'One')], requestedDays: ['2026-12-07'], reserve: [post('r', '2026-11-01', 'Spare')], writeDay: async () => null, dateOf, idOf });
  assert.deepEqual([same.fromReserve, same.written, same.stillEmpty, same.posts.map((p) => p.id)], [[], [], [], ['w01-d1']]);
});
