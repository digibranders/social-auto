import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autopilotArgsFor, parsePostingPlan, planBatches, planCost, planDates, planId, planPostCount, planSummary, PlanError, tomorrowAt, todayAt, type PostingPlan } from './posting-plan.ts';

const NOW = new Date('2026-11-05T12:00:00Z'); // 17:30 on 5 Nov in India
const plan = (over: Record<string, unknown> = {}): PostingPlan => parsePostingPlan({ platforms: ['instagram'], startDate: '2026-11-06', durationDays: 1, ...over }, { now: NOW });

test('tomorrow is worked out at the owner\'s offset, not the server\'s', () => {
  assert.equal(tomorrowAt('+05:30', NOW), '2026-11-06');
  assert.equal(todayAt('+05:30', new Date('2026-11-05T20:00:00Z')), '2026-11-06', 'after 18:30 UTC it is already tomorrow in India');
  assert.equal(tomorrowAt('-08:00', new Date('2026-11-05T05:00:00Z')), '2026-11-05');
});

test('a single day is exactly that day, whatever its weekday and whatever pattern was left in the form', () => {
  assert.deepEqual(planDates(plan()), ['2026-11-06']);
  assert.deepEqual(planDates(plan({ startDate: '2026-11-07', postsPerWeek: 3 })), ['2026-11-07'], '7 Nov is a Saturday, not in Mon/Wed/Fri, and it still posts');
  assert.equal(planPostCount(plan()), 1);
});

test('three times a week for a month is Monday, Wednesday and Friday across the window', () => {
  const month = plan({ startDate: '2026-11-06', durationDays: 31, postsPerWeek: 3 });
  const dates = planDates(month);
  assert.equal(dates.length, 13);
  assert.equal(dates[0], '2026-11-06'); // a Friday
  assert.deepEqual(dates.slice(0, 4), ['2026-11-06', '2026-11-09', '2026-11-11', '2026-11-13']);
  assert.equal(dates.at(-1), '2026-12-04');
  assert.ok(dates.every((d) => ['Mon', 'Wed', 'Fri'].includes(new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }))));
  assert.equal(planPostCount(plan({ durationDays: 31 })), 31, 'with no pattern it posts every day');
});

test('exact weekdays win over a posts-per-week number, and a week is a week', () => {
  const p = plan({ startDate: '2026-11-09', durationDays: 14, weekdays: ['tue', 'sat'], postsPerWeek: 5 });
  assert.deepEqual(planDates(p), ['2026-11-10', '2026-11-14', '2026-11-17', '2026-11-21']);
  assert.equal(p.postsPerWeek, undefined);
});

test('the same dates as the dashboard form shows (mirrored in dashboard/shared/posting-plan.test.ts)', () => {
  assert.deepEqual(planDates(plan({ startDate: '2026-11-09', durationDays: 14, postsPerWeek: 2 })), ['2026-11-09', '2026-11-12', '2026-11-16', '2026-11-19']);
  assert.equal(planDates(plan({ startDate: '2026-11-06', durationDays: 31 })).length, 31);
});

test('a plan that is not complete or not sensible is refused, with a plain reason', () => {
  const refuse = (over: Record<string, unknown>, pattern: RegExp): void => assert.throws(() => plan(over), (e: unknown) => e instanceof PlanError && pattern.test(e.message), JSON.stringify(over));
  refuse({ platforms: [] }, /at least one platform/);
  refuse({ platforms: ['tiktok'] }, /not a platform/);
  refuse({ startDate: '2026-11-04' }, /in the past/);
  refuse({ startDate: '2026-02-30' }, /real date/);
  refuse({ startDate: 'tomorrow' }, /real date/);
  refuse({ durationDays: 0 }, /from 1 to 31/);
  refuse({ durationDays: 32 }, /from 1 to 31/);
  refuse({ durationDays: 2.5 }, /whole number/);
  refuse({ postsPerWeek: 0, durationDays: 7 }, /1 to 7/);
  refuse({ weekdays: ['funday'], durationDays: 7 }, /not a weekday/);
  refuse({ time: '25:00' }, /HH:MM/);
  refuse({ utcOffset: 'IST' }, /UTC offset/);
  assert.throws(() => parsePostingPlan('nope'), PlanError);
});

test('platforms are kept once each, in a fixed order', () => {
  assert.deepEqual(plan({ platforms: ['facebook', 'instagram', 'facebook'] }).platforms, ['instagram', 'facebook']);
});

test('the cost shown is a range for the whole plan, never zero for a post', () => {
  assert.deepEqual(planCost(plan()), { low: 0.02, high: 0.08 });
  const month = planCost(plan({ durationDays: 31, postsPerWeek: 3 }));
  assert.ok(month.low > 0.2 && month.high > month.low);
});

test('a plan for the same site is the same campaign, and any change makes a different one', () => {
  const a = plan();
  assert.equal(planId('https://www.oyechats.com/', a), planId('oyechats.com', plan()));
  assert.notEqual(planId('oyechats.com', a), planId('oyechats.com', plan({ startDate: '2026-11-07' })));
  assert.notEqual(planId('oyechats.com', a), planId('oyechats.com', plan({ platforms: ['instagram', 'facebook'] })));
  assert.equal(planId('oyechats.com', plan({ platforms: ['facebook', 'instagram'] })), planId('oyechats.com', plan({ platforms: ['instagram', 'facebook'] })));
});

test('a long plan is made in runs of at most eight posters, and each run asks the autopilot for exactly its own days', () => {
  const month = plan({ startDate: '2026-11-06', durationDays: 31, postsPerWeek: 3 });
  const batches = planBatches(month);
  assert.deepEqual(batches.map((b) => b.dates.length), [8, 5]);
  assert.deepEqual(batches.flatMap((b) => b.dates), planDates(month));
  const args = autopilotArgsFor(month, 'https://oyechats.com', batches[1] as never);
  assert.deepEqual(args.slice(0, 11), ['src/autopilot.ts', '--site', 'https://oyechats.com', '--route', 'ai', '--days', '5', '--start', batches[1]?.dates[0], '--time', '10:00']);
  assert.match(args.join(' '), /--weekdays (mon|wed|fri)(,(mon|wed|fri))*/);
  const single = autopilotArgsFor(plan(), 'https://oyechats.com', planBatches(plan())[0] as never);
  assert.ok(!single.includes('--weekdays'), 'a single day needs no weekday pattern');
  assert.deepEqual(single.slice(5, 9), ['--days', '1', '--start', '2026-11-06']);
});

test('the autopilot args never schedule or publish: the route is ai, which only fills the review queue', () => {
  const args = autopilotArgsFor(plan(), 'https://oyechats.com', planBatches(plan())[0] as never);
  assert.equal(args[args.indexOf('--route') + 1], 'ai');
  assert.ok(!args.includes('--channel') && !args.includes('--target'));
});

test('the summary reads like a sentence', () => {
  assert.equal(planSummary(plan()), '1 post on Instagram, 2026-11-06');
  assert.match(planSummary(plan({ platforms: ['instagram', 'facebook', 'linkedin'], durationDays: 14, postsPerWeek: 3 })), /^6 posts on Instagram, Facebook and LinkedIn, 2026-11-06 to 2026-11-18$/);
});
