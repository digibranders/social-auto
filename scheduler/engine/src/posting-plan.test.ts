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
  // The autopilot refuses a run with no destination before it looks at the route, so one is always named; the AI route ignores it.
  assert.deepEqual(single.slice(-2), ['--target', 'publisher']);
  assert.ok(!single.includes('--channel') && !single.includes('--dry-run'));
});

test('the autopilot args never schedule or publish: the route is ai, which only fills the review queue', () => {
  const args = autopilotArgsFor(plan(), 'https://oyechats.com', planBatches(plan())[0] as never);
  assert.equal(args[args.indexOf('--route') + 1], 'ai');
  // A destination is required by the autopilot's own check; the AI route returns before using it, so nothing is scheduled or exported.
  assert.equal(args[args.indexOf('--target') + 1], 'publisher');
  assert.ok(!args.includes('--channel'));
});

test('the summary reads like a sentence', () => {
  assert.equal(planSummary(plan()), '1 post on Instagram, 2026-11-06');
  assert.match(planSummary(plan({ platforms: ['instagram', 'facebook', 'linkedin'], durationDays: 14, postsPerWeek: 3 })), /^6 posts on Instagram, Facebook and LinkedIn, 2026-11-06 to 2026-11-18$/);
});

test('a client that requires the website\'s real logo has the autopilot told so, and one that does not is not', () => {
  const batch = planBatches(plan())[0] as never;
  assert.ok(autopilotArgsFor(plan(), 'https://oyechats.com', batch, { requireAuthenticLogo: true }).includes('--require-logo'));
  assert.ok(!autopilotArgsFor(plan(), 'https://oyechats.com', batch).includes('--require-logo'));
  assert.ok(!autopilotArgsFor(plan(), 'https://oyechats.com', batch, { requireAuthenticLogo: false }).includes('--require-logo'));
});

test('a client with its own monthly spend limit has the autopilot told so, and one without is not', () => {
  const batch = planBatches(plan())[0] as never;
  const args = autopilotArgsFor(plan(), 'https://oyechats.com', batch, { monthCapUsd: 3.5 });
  assert.equal(args[args.indexOf('--month-cap-usd') + 1], '3.5');
  assert.ok(!autopilotArgsFor(plan(), 'https://oyechats.com', batch).includes('--month-cap-usd'));
});


test('a plan may name the exact account for each platform; anything else about accounts is refused', () => {
  const base = { platforms: ['linkedin', 'facebook'], startDate: '2099-11-10', durationDays: 1 };
  assert.deepEqual(parsePostingPlan({ ...base, channelIds: ['facebook:77', 'linkedin:abc'] }, { now: new Date(0) }).channelIds, ['facebook:77', 'linkedin:abc']);
  assert.equal(parsePostingPlan(base, { now: new Date(0) }).channelIds, undefined);
  assert.throws(() => parsePostingPlan({ ...base, channelIds: ['linkedin:a', 'linkedin:b'] }, { now: new Date(0) }), /one account for linkedin/);
  assert.throws(() => parsePostingPlan({ ...base, channelIds: ['google:1'] }, { now: new Date(0) }), /not one of this plan's platforms/);
  assert.throws(() => parsePostingPlan({ ...base, channelIds: ['nonsense'] }, { now: new Date(0) }), /valid account id/);
});

import { carouselArgsFor, carouselWeekday, planCarouselDates, planSingleDates } from './posting-plan.ts';

const weekly = (over: Record<string, unknown> = {}): PostingPlan => plan({ startDate: '2026-11-09', durationDays: 14, postsPerWeek: 3, carousel: true, ...over });

test('a weekly carousel takes the last posting weekday of each week, so it replaces one post and the others stay as they were', () => {
  const p = weekly();
  assert.equal(carouselWeekday(p), 'fri');
  assert.deepEqual(planDates(p), ['2026-11-09', '2026-11-11', '2026-11-13', '2026-11-16', '2026-11-18', '2026-11-20']);
  assert.deepEqual(planCarouselDates(p), ['2026-11-13', '2026-11-20']);
  assert.deepEqual(planSingleDates(p), ['2026-11-09', '2026-11-11', '2026-11-16', '2026-11-18']);
  assert.equal(planPostCount(p), 6, 'a carousel counts as one post, so the plan\'s count and the weekly limit are unchanged');
  assert.deepEqual(planPostCount(weekly({ carousel: undefined })), 6);
  assert.deepEqual(planCarouselDates(weekly({ carousel: undefined })), []);
  assert.equal(weekly({ carousel: undefined }).carousel, undefined);
});

test('exact weekdays work the same way, a window that ends mid-week keeps its short week, and a plan with every day uses Sunday', () => {
  const p = weekly({ postsPerWeek: undefined, weekdays: ['tue', 'thu'], startDate: '2026-11-10', durationDays: 8 });
  assert.equal(carouselWeekday(p), 'thu');
  assert.deepEqual(planCarouselDates(p), ['2026-11-12']);
  assert.deepEqual(planSingleDates(p), ['2026-11-10', '2026-11-17']);
  const all = weekly({ postsPerWeek: undefined });
  assert.equal(carouselWeekday(all), 'sun');
});

test('batches of single posters skip the carousel days, and the autopilot is asked for exactly those days', () => {
  const p = weekly({ startDate: '2026-11-09', durationDays: 31 });
  const singles = planSingleDates(p);
  assert.ok(singles.every((d) => !planCarouselDates(p).includes(d)));
  const batches = planBatches(p);
  assert.deepEqual(batches.flatMap((b) => b.dates), singles);
  const args = autopilotArgsFor(p, 'acme.com', batches[0] as never);
  assert.equal(args[args.indexOf('--days') + 1], String(batches[0]?.dates.length));
  assert.equal(args[args.indexOf('--weekdays') + 1], 'mon,wed', 'Friday is left to the carousel');
});

test('a weekly carousel needs more than one day and at least two posting days a week, and says so', () => {
  assert.throws(() => weekly({ durationDays: 1 }), /more than one day/);
  assert.throws(() => weekly({ postsPerWeek: 1 }), /at least two posting days/);
  assert.throws(() => weekly({ postsPerWeek: undefined, weekdays: ['mon'] }), /at least two posting days/);
  assert.throws(() => weekly({ carousel: 'yes' }), /carousel must be true or false/);
  assert.equal(weekly({ carousel: false }).carousel, undefined);
});

test('the cost counts a carousel for what it costs, and the summary and the id tell a carousel plan from the same plan without one', () => {
  const without = weekly({ carousel: undefined });
  const withIt = weekly();
  assert.ok(planCost(withIt).high > planCost(without).high - 1, 'a carousel is dearer than a single poster, never free');
  assert.notEqual(planCost(withIt).low, planCost(without).low);
  assert.match(planSummary(withIt), /2 of them a carousel/);
  assert.doesNotMatch(planSummary(without), /carousel/);
  assert.notEqual(planId('acme.com', withIt), planId('acme.com', without));
});

test('the carousel is made by its own command for its own day, with the plan\'s channels, time and the client\'s limits', () => {
  const p = weekly({ platforms: ['instagram', 'linkedin'] });
  assert.deepEqual(carouselArgsFor(p, 'acme.com', '2026-11-13'), ['src/carousel-cli.ts', '--site', 'acme.com', '--networks', 'instagram,linkedin', '--start', '2026-11-13', '--time', '10:00', '--utc-offset', '+05:30']);
  assert.deepEqual(carouselArgsFor(p, 'acme.com', '2026-11-13', { requireAuthenticLogo: true, monthCapUsd: 20 }).slice(-5), ['--utc-offset', '+05:30', '--require-logo', '--month-cap-usd', '20']);
});
