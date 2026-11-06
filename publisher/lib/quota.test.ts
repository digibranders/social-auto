import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, assertWithinLimit, planDays, todayAt, usedPerWeek, weekStart } from './quota.ts';
import type { ClientPlan } from './clients.ts';

const FRI_6_NOV = Date.parse('2026-11-06T06:00:00Z');
const MON_23_NOV = Date.parse('2026-11-23T06:00:00Z');
const plan = (over: Partial<ClientPlan> = {}): ClientPlan => ({ platforms: ['instagram'], startDate: '2026-11-09', durationDays: 21, postsPerWeek: 2, time: '10:00', utcOffset: '+05:30', ...over });

test('weeks run Monday to Sunday and today is read in the plan\'s own time zone', () => {
  assert.equal(weekStart('2026-11-09'), '2026-11-09');
  assert.equal(weekStart('2026-11-15'), '2026-11-09');
  assert.equal(weekStart('2026-11-16'), '2026-11-16');
  assert.equal(addDays('2026-11-30', 1), '2026-12-01');
  // 20:00 UTC on Thursday is already Friday in India.
  assert.equal(todayAt('+05:30', Date.parse('2026-11-05T20:00:00Z')), '2026-11-06');
  assert.equal(todayAt('-05:00', Date.parse('2026-11-06T02:00:00Z')), '2026-11-05');
});

test('a plan posts on a single day, on its weekdays, or spread evenly through the week', () => {
  assert.deepEqual(planDays(plan({ durationDays: 1, startDate: '2026-11-08' })), ['2026-11-08'], 'a single day is that day, even a Sunday');
  assert.deepEqual(planDays(plan({ durationDays: 7, postsPerWeek: 2 })), ['2026-11-09', '2026-11-12']);
  assert.deepEqual(planDays(plan({ durationDays: 7, postsPerWeek: undefined, weekdays: ['tue', 'sat'] })), ['2026-11-10', '2026-11-14']);
  assert.equal(planDays(plan({ durationDays: 7, postsPerWeek: undefined })).length, 7, 'no pattern is every day');
});

test('posts are counted per channel and per week, and a plan on two channels uses a place on both', () => {
  const used = usedPerWeek([plan({ platforms: ['instagram', 'facebook'] }), plan({ platforms: ['linkedin'], postsPerWeek: 1 })]);
  assert.equal(used.get('instagram')?.get('2026-11-09'), 2);
  assert.equal(used.get('facebook')?.get('2026-11-23'), 2);
  assert.equal(used.get('linkedin')?.get('2026-11-16'), 1);
  assert.equal(used.get('google'), undefined);
});

test('the owner\'s example: 2 a week for 3 weeks leaves 1 a week for those weeks and a full week after them', () => {
  const existing = [plan()]; // Mon and Thu of the weeks of 9, 16 and 23 November, on Instagram
  const mondays = (over: Partial<ClientPlan>) => plan({ postsPerWeek: 1, ...over });
  assert.doesNotThrow(() => assertWithinLimit(existing, mondays({}), 3, FRI_6_NOV), '1 a week for the same 3 weeks fits');
  assert.throws(() => assertWithinLimit(existing, plan({ postsPerWeek: 3 }), 3, FRI_6_NOV), /Instagram already has 2 posts planned in the week of Mon 9 Nov, so only 1 more fits that week/);
  assert.doesNotThrow(() => assertWithinLimit(existing, plan({ startDate: '2026-11-30', durationDays: 7, postsPerWeek: 3 }), 3, FRI_6_NOV), 'the untouched week has all 3');
  assert.doesNotThrow(() => assertWithinLimit(existing, plan({ platforms: ['facebook'], postsPerWeek: 3 }), 3, FRI_6_NOV), 'another channel has its own 3');
  assert.throws(() => assertWithinLimit(existing, plan({ platforms: ['facebook', 'instagram'], postsPerWeek: 2 }), 3, FRI_6_NOV), /Instagram already has 2/, 'a plan on two channels is held to the fuller one');
});

test('weeks that have passed no longer matter, and the month ahead moves with the day', () => {
  const existing = [plan()];
  // On Monday 23 November the weeks of 9 and 16 November are over; only the current week still holds 2 of 3.
  assert.doesNotThrow(() => assertWithinLimit(existing, plan({ startDate: '2026-11-23', durationDays: 1, postsPerWeek: undefined }), 3, MON_23_NOV));
  assert.throws(() => assertWithinLimit(existing, plan({ startDate: '2026-11-23', durationDays: 7, postsPerWeek: 3 }), 3, MON_23_NOV), /week of Mon 23 Nov/);
  // A month ahead from the 23rd reaches 24 December, which was out of reach on the 6th.
  const far = plan({ startDate: '2026-12-14', durationDays: 8, postsPerWeek: 3 });
  assert.doesNotThrow(() => assertWithinLimit(existing, far, 3, MON_23_NOV));
  assert.throws(() => assertWithinLimit(existing, far, 3, FRI_6_NOV), /up to 31 days ahead, to Mon 7 Dec; this plan runs to/);
});

test('a plan that has more posts in a week than the limit is refused even when the client has no other plan', () => {
  assert.throws(() => assertWithinLimit([], plan({ postsPerWeek: 5 }), 3, FRI_6_NOV), /Instagram can have 3 posts a week, and this plan has 5 in the week of Mon 9 Nov/);
  assert.throws(() => assertWithinLimit([], plan({ postsPerWeek: undefined, durationDays: 7 }), 3, FRI_6_NOV), /has 7 in the week/);
  assert.doesNotThrow(() => assertWithinLimit([], plan({ postsPerWeek: undefined, durationDays: 7 }), 7, FRI_6_NOV), 'a client allowed 7 can have every day');
  assert.doesNotThrow(() => assertWithinLimit([], plan({ postsPerWeek: 1 }), 1, FRI_6_NOV), 'a limit of 1 allows a plan of 1 a week');
});
