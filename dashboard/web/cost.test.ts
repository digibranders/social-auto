import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CostEntry, StatusPost } from '../shared/status.ts';
import { costView, formatUsd, pageOf } from './cost.ts';

const entry = (post: string | null, purpose: CostEntry['purpose'], usd: number, at = '2026-11-04T05:00:00.000Z', brand = 'fynix'): CostEntry => ({ brand, post, purpose, usd, at });
const post = (id: string, date: string): StatusPost => ({ id, brand: 'fynix', date }) as StatusPost;

const costs: CostEntry[] = [
  entry(null, 'profile', 0.002),
  entry('fynix-w01-d1', 'picture', 0.0138),
  entry('fynix-w01-d1', 'writing', 0.0004),
  entry('fynix-w01-d2', 'picture', 0.0142),
  entry('fynix-w01-d2', 'writing', 0.0004),
  entry('fynix-w00-d1', 'picture', 0.5, '2026-10-02T05:00:00.000Z'),
  entry('other-w01-d1', 'picture', 9, '2026-11-04T05:00:00.000Z', 'other'),
];
const posts = [post('fynix-w01-d1', '2026-11-05T10:00:00+05:30'), post('fynix-w01-d2', '2026-11-06T10:00:00+05:30'), post('fynix-w00-d1', '2026-10-05T10:00:00+05:30')];

test('the view adds up one client\'s month: totals, where the money went, and posts newest first', () => {
  const view = costView(costs, posts, 'fynix', null);
  assert.equal(view.month, '2026-11');
  assert.deepEqual(view.months, ['2026-11', '2026-10']);
  assert.deepEqual(view.split, { pictureUsd: 0.028, writingUsd: 0.0008, profileUsd: 0.002 });
  assert.equal(view.monthUsd, 0.0308);
  assert.equal(view.postsMade, 2);
  assert.equal(view.averageUsd, 0.0144);
  assert.equal(view.allTimeUsd, 0.5308);
  assert.deepEqual(view.rows.map((r) => [r.id, r.pictureUsd, r.writingUsd, r.totalUsd]), [
    ['fynix-w01-d2', 0.0142, 0.0004, 0.0146],
    ['fynix-w01-d1', 0.0138, 0.0004, 0.0142],
  ]);
  assert.equal(view.rows[0]?.post?.id, 'fynix-w01-d2');
});

test('another month can be chosen, and a client with no spend gets an empty view', () => {
  const october = costView(costs, posts, 'fynix', '2026-10');
  assert.deepEqual(october.rows.map((r) => r.id), ['fynix-w00-d1']);
  assert.equal(october.monthUsd, 0.5);
  const none = costView(costs, posts, 'nobody', null);
  assert.deepEqual([none.month, none.months, none.rows, none.monthUsd, none.averageUsd, none.allTimeUsd], [null, [], [], 0, null, 0]);
});

test('a post whose plan is gone is still listed from its cost alone', () => {
  const view = costView([entry('fynix-w09-d1', 'picture', 0.01)], [], 'fynix', null);
  assert.equal(view.rows[0]?.post, null);
  assert.equal(view.rows[0]?.id, 'fynix-w09-d1');
});

test('money is shown to the tenth of a cent for small amounts and to the cent for large ones', () => {
  assert.equal(formatUsd(0.0138), '$0.0138');
  assert.equal(formatUsd(0), '$0.00');
  assert.equal(formatUsd(0.4), '$0.40');
  assert.equal(formatUsd(12.3456), '$12.35');
});

test('pages hold ten at a time and a page past the end is pulled back', () => {
  const items = Array.from({ length: 28 }, (_, i) => i);
  assert.deepEqual(pageOf(items, 1, 10), { items: items.slice(0, 10), page: 1, pages: 3, from: 1, to: 10 });
  assert.deepEqual(pageOf(items, 3, 10), { items: items.slice(20), page: 3, pages: 3, from: 21, to: 28 });
  assert.equal(pageOf(items, 9, 10).page, 3);
  assert.equal(pageOf(items, 0, 10).page, 1);
  assert.deepEqual(pageOf([], 1, 10), { items: [], page: 1, pages: 1, from: 0, to: 0 });
});
