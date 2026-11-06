import { test } from 'node:test';
import assert from 'node:assert/strict';
import { availability, openWeeks, quotaProblem, usedPerWeek, weekLabel, weekStart, type QuotaPlan } from './quota.ts';

const plan = (over: Partial<QuotaPlan> = {}): QuotaPlan => ({ platforms: ['instagram'], startDate: '2026-11-09', durationDays: 21, postsPerWeek: 2, ...over });

test('weeks run Monday to Sunday and are named by their days', () => {
  assert.equal(weekStart('2026-11-15'), '2026-11-09');
  assert.equal(weekLabel('2026-11-09'), '9–15 Nov');
  assert.equal(weekLabel('2026-11-30'), '30 Nov – 6 Dec');
});

test('only the weeks that have not passed are listed, up to the one a month ahead ends in', () => {
  assert.deepEqual(openWeeks('2026-11-06').slice(0, 2), ['2026-11-02', '2026-11-09']);
  assert.equal(openWeeks('2026-11-06').at(-1), '2026-12-07');
  assert.equal(openWeeks('2026-11-23')[0], '2026-11-23', 'the weeks before this one are gone');
});

test('the owner\'s example: what is used and free for each channel in each open week', () => {
  const rows = availability([plan()], ['instagram', 'facebook'], 3, '2026-11-06');
  const week = (monday: string) => rows.find((r) => r.monday === monday)?.channels;
  assert.deepEqual(week('2026-11-09'), { instagram: { used: 2, free: 1 }, facebook: { used: 0, free: 3 } });
  assert.deepEqual(week('2026-11-23'), { instagram: { used: 2, free: 1 }, facebook: { used: 0, free: 3 } });
  assert.deepEqual(week('2026-11-30'), { instagram: { used: 0, free: 3 }, facebook: { used: 0, free: 3 } }, 'the week after the plan is full');
  assert.equal(usedPerWeek([plan({ platforms: ['instagram', 'linkedin'] })]).get('linkedin')?.get('2026-11-16'), 2);
});

test('a plan that does not fit is told in plain words, and one that fits is not', () => {
  const existing = [plan()];
  assert.equal(quotaProblem(existing, plan({ postsPerWeek: 1 }), 3, '2026-11-06'), null);
  assert.equal(quotaProblem(existing, plan({ postsPerWeek: 3 }), 3, '2026-11-06'), 'Instagram already has 2 posts planned in the week of Mon 9 Nov, so only 1 more fits that week.');
  assert.equal(quotaProblem(existing, plan({ platforms: ['facebook'], postsPerWeek: 3 }), 3, '2026-11-06'), null, 'another channel has its own places');
  assert.match(quotaProblem([], plan({ postsPerWeek: undefined, durationDays: 7 }), 3, '2026-11-06') ?? '', /can have 3 posts a week, and this plan has 7/);
  assert.equal(quotaProblem([], plan({ postsPerWeek: undefined, durationDays: 7 }), 7, '2026-11-06'), null, 'a client allowed 7 can have every day');
  assert.match(quotaProblem([], plan({ startDate: '2026-12-14', durationDays: 8, postsPerWeek: 3 }), 3, '2026-11-06') ?? '', /up to 31 days ahead/);
  assert.equal(quotaProblem([], plan({ startDate: '2026-12-14', durationDays: 8, postsPerWeek: 3 }), 3, '2026-11-23'), null, 'the month moves with the day');
});

test('the last week is labelled with how far it can be planned, because it is cut by the month ahead', () => {
  const rows = availability([], ['instagram'], 3, '2026-11-06');
  assert.equal(rows.at(-1)?.label, '7–13 Dec (up to 7 Dec)');
  assert.equal(rows[0]?.label, '2–8 Nov');
});

