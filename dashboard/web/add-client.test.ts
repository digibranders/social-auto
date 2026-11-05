import assert from 'node:assert/strict';
import { test } from 'node:test';
import { previewLabel } from './add-client.ts';

test('the label shown matches the one the server will make from the name', () => {
  assert.equal(previewLabel('brand basket'), 'Brand Basket');
  assert.equal(previewLabel('  Café & Co.!! '), 'Cafe Co');
  assert.equal(previewLabel('***'), '');
});

import { describePlan, readPlan } from './add-client.ts';

const NOW = new Date('2026-11-05T12:00:00Z');
const form = (over: Record<string, unknown> = {}) => ({ on: true, platforms: ['instagram'], startDate: '2026-11-06', durationId: 'day', postsPerWeek: 3, ...over }) as Parameters<typeof readPlan>[0];

test('with the plan off, or no website, the client is only added', () => {
  assert.deepEqual(readPlan(form({ on: false }), NOW), { plan: null, problem: null });
});

test('just one day is tomorrow only, whatever frequency was left in the form', () => {
  const { plan, problem } = readPlan(form(), NOW);
  assert.equal(problem, null);
  assert.deepEqual(plan, { platforms: ['instagram'], startDate: '2026-11-06', durationDays: 1, time: '10:00', utcOffset: '+05:30' });
});

test('three times a week for a month keeps the pattern, and a platform is needed', () => {
  const month = readPlan(form({ durationId: 'month', postsPerWeek: 3, platforms: ['facebook', 'instagram'] }), NOW);
  assert.deepEqual([month.plan?.durationDays, month.plan?.postsPerWeek, month.plan?.platforms], [31, 3, ['instagram', 'facebook']]);
  assert.equal(readPlan(form({ platforms: [] }), NOW).problem, 'Choose at least one platform.');
  assert.equal(readPlan(form({ startDate: '2026-11-04' }), NOW).problem, 'The start day has already passed.');
  assert.equal(readPlan(form({ durationId: 'month', postsPerWeek: 0 }), NOW).plan?.postsPerWeek, undefined, 'every day has no pattern');
});

test('what the owner is told: the count, the days, the cost, and that nothing posts before approval', () => {
  const lines = describePlan(readPlan(form({ durationId: 'week', postsPerWeek: 3 }), NOW).plan as never);
  assert.equal(lines[0], '3 posts on Instagram, at 10:00 India time.');
  assert.equal(lines[1], 'Fri 6 Nov · Mon 9 Nov · Wed 11 Nov');
  assert.match(lines[2] ?? '', /about \$0\.06 to \$0\.20 to make\. Nothing is posted until you have looked at each poster and approved it\./);
  const month = describePlan(readPlan(form({ durationId: 'month', postsPerWeek: 3 }), NOW).plan as never);
  assert.equal(month[0], '13 posts on Instagram, at 10:00 India time.');
  assert.equal(month[1]?.split(' · ').length, 13, 'every day is shown when there are not many, so nothing is hidden before the owner confirms');
  const daily = describePlan(readPlan(form({ durationId: 'month', postsPerWeek: 0 }), NOW).plan as never);
  assert.equal(daily[1], 'Fri 6 Nov to Sun 6 Dec', 'with more than 14 days it shows the range');
});
