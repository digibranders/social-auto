import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectedPlatforms, dayLabel, planCost, planDates, planPayload, planProblem, planSentence, platformNames, tomorrowAt, type PlanInput } from './posting-plan.ts';

const NOW = new Date('2026-11-05T12:00:00Z');
const input = (over: Partial<PlanInput> = {}): PlanInput => ({ platforms: ['instagram'], startDate: '2026-11-06', durationDays: 1, time: '10:00', utcOffset: '+05:30', ...over });

test('tomorrow is the owner\'s tomorrow, at their offset', () => {
  assert.equal(tomorrowAt('+05:30', NOW), '2026-11-06');
  assert.equal(tomorrowAt('+05:30', new Date('2026-11-05T19:00:00Z')), '2026-11-07', 'after 18:30 UTC it is already the 6th in India');
});

test('a single day is that day only; three a week for a month is Monday, Wednesday and Friday; every day is every day', () => {
  assert.deepEqual(planDates(input({ startDate: '2026-11-07', postsPerWeek: 3 })), ['2026-11-07'], 'a Saturday single day still posts');
  const month = planDates({ startDate: '2026-11-06', durationDays: 31, postsPerWeek: 3 });
  assert.equal(month.length, 13);
  assert.deepEqual(month.slice(0, 4), ['2026-11-06', '2026-11-09', '2026-11-11', '2026-11-13']);
  assert.equal(planDates({ startDate: '2026-11-06', durationDays: 31 }).length, 31);
  assert.equal(planDates({ startDate: '2026-11-06', durationDays: 7, postsPerWeek: 7 }).length, 7);
});

test('the same dates as the content engine uses, for the cases that matter', () => {
  // Mirrored by scheduler/engine/src/posting-plan.test.ts: the form and the runner must agree.
  assert.deepEqual(planDates({ startDate: '2026-11-09', durationDays: 14, postsPerWeek: 2 }), ['2026-11-09', '2026-11-12', '2026-11-16', '2026-11-19']);
});

test('the choices are checked in plain words before anything is sent', () => {
  assert.equal(planProblem(input(), NOW), null);
  assert.equal(planProblem(input({ platforms: [] }), NOW), 'Choose at least one platform.');
  assert.equal(planProblem(input({ startDate: '2026-11-04' }), NOW), 'The start day has already passed.');
  assert.equal(planProblem(input({ startDate: '' }), NOW), 'Choose the day to start.');
  assert.match(planProblem(input({ durationDays: 40 }), NOW) ?? '', /1 to 31/);
});

test('the payload carries a pattern only for more than one day', () => {
  assert.deepEqual(planPayload(input({ platforms: ['facebook', 'instagram'], postsPerWeek: 3 })), { platforms: ['instagram', 'facebook'], startDate: '2026-11-06', durationDays: 1, time: '10:00', utcOffset: '+05:30' });
  assert.equal(planPayload(input({ durationDays: 14, postsPerWeek: 3 }))['postsPerWeek'], 3);
});

test('the sentence reads naturally and the cost is a range', () => {
  assert.equal(dayLabel('2026-11-06'), 'Fri 6 Nov');
  assert.equal(platformNames(['facebook', 'instagram', 'linkedin']), 'Instagram, Facebook and LinkedIn');
  assert.equal(planSentence({ platforms: ['instagram'], startDate: '2026-11-06', durationDays: 1 }), '1 post on Instagram: Fri 6 Nov');
  assert.equal(planSentence({ platforms: ['instagram', 'facebook'], startDate: '2026-11-06', durationDays: 7, postsPerWeek: 3 }), '3 posts on Instagram and Facebook: Fri 6 Nov, Mon 9 Nov, Wed 11 Nov');
  assert.match(planSentence({ platforms: ['instagram'], startDate: '2026-11-06', durationDays: 31, postsPerWeek: 3 }), /^13 posts on Instagram: Fri 6 Nov to Fri 4 Dec$/);
  assert.deepEqual(planCost(1), { low: 0.02, high: 0.08 });
  assert.ok(planCost(13).high > planCost(13).low);
});

test('the platforms a client can be planned for are those it has an account of its own on, never the team\'s shared Instagram', () => {
  assert.deepEqual(connectedPlatforms([]), []);
  assert.deepEqual(connectedPlatforms([{ platform: 'instagram', id: null }]), [], 'the shared account has no channel id and does not count');
  assert.deepEqual(connectedPlatforms([{ platform: 'linkedin', id: 'linkedin:a' }, { platform: 'instagram', id: null }]), ['linkedin']);
  assert.deepEqual(connectedPlatforms([{ platform: 'google', id: 'google:1' }, { platform: 'instagram', id: 'instagram:9' }, { platform: 'facebook', id: 'facebook:2' }]), ['instagram', 'facebook', 'google'], 'in the order the form lists them');
  assert.deepEqual(connectedPlatforms([{ platform: 'tiktok', id: 'tiktok:1' }]), [], 'a platform the plans do not offer is ignored');
});

