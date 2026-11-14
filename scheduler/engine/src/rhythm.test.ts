import assert from 'node:assert/strict';
import { test } from 'node:test';
import { weeklyRhythm, RhythmError } from './rhythm.ts';

test('with nothing said a client gets two posts for one week, spread through the week', () => {
  const r = weeklyRhythm({});
  assert.equal(r.days, 2);
  assert.equal(r.weekdays.length, 2);
});

test('weeks multiply the posts per week; the batch never exceeds a month of daily posts', () => {
  assert.equal(weeklyRhythm({ weeks: 4, postsPerWeek: 3 }).days, 12);
  assert.equal(weeklyRhythm({ weeks: 4, postsPerWeek: 7 }).days, 28);
});

test('values outside the limits are refused in plain words', () => {
  assert.throws(() => weeklyRhythm({ weeks: 0 }), RhythmError);
  assert.throws(() => weeklyRhythm({ weeks: 5 }), /weeks must be a whole number from 1 to 4/);
  assert.throws(() => weeklyRhythm({ postsPerWeek: 8 }), /postsPerWeek/);
  assert.throws(() => weeklyRhythm({ postsPerWeek: '2' }), RhythmError);
});

test('a start day makes the first post fall on it, and the day and time are checked', async () => {
  const { checkStartDate, checkTime, MAX_START_DAYS_AHEAD } = await import('./rhythm.ts');
  assert.deepEqual(weeklyRhythm({ weeks: 2, postsPerWeek: 2, startDate: '2026-12-16' }), { days: 4, weekdays: ['wed', 'sat'] });
  assert.deepEqual(weeklyRhythm({ postsPerWeek: 2 }).weekdays, ['mon', 'thu'], 'without one the usual spread is kept');

  // 11 November 2026, 12:25 India time.
  const now = Date.parse('2026-11-11T06:55:00Z');
  assert.equal(checkStartDate('2026-11-12', now), '2026-11-12');
  assert.equal(checkStartDate('2026-12-14', now), '2026-12-14');
  for (const bad of ['2026-11-11', '2026-11-10', '2026-02-30', '2026-13-01', '14/12/2026', '', 5, null]) assert.throws(() => checkStartDate(bad, now), RhythmError, String(bad));
  assert.throws(() => checkStartDate('2026-11-11', now), /tomorrow or later/);
  // Just after midnight in India it is already the next day there, though still the day before in UTC.
  assert.throws(() => checkStartDate('2026-11-12', Date.parse('2026-11-11T19:00:00Z')), /tomorrow or later/);
  assert.equal(checkStartDate('2026-11-13', Date.parse('2026-11-11T19:00:00Z')), '2026-11-13');
  assert.equal(checkStartDate(new Date(Date.parse('2026-11-11T00:00:00Z') + MAX_START_DAYS_AHEAD * 86_400_000).toISOString().slice(0, 10), now), '2027-05-10');
  assert.throws(() => checkStartDate('2027-05-12', now), /within 180 days/);

  assert.equal(checkTime('10:00'), '10:00');
  assert.equal(checkTime('00:05'), '00:05');
  assert.equal(checkTime('23:59'), '23:59');
  for (const bad of ['24:00', '9:30', '10:60', '10.30', '', 10, undefined]) assert.throws(() => checkTime(bad), RhythmError, String(bad));
});

test('a monthly plan starting on a Monday posts Monday to Friday, as approved; other start days keep the first post on that day', () => {
  const monday = '2026-11-16';
  assert.deepEqual([...weeklyRhythm({ weeks: 4, postsPerWeek: 5, startDate: monday }).weekdays], ['mon', 'tue', 'wed', 'thu', 'fri']);
  assert.equal(weeklyRhythm({ weeks: 4, postsPerWeek: 5, startDate: monday }).days, 20);
  assert.deepEqual([...weeklyRhythm({ postsPerWeek: 2, startDate: monday }).weekdays], ['mon', 'thu'], 'two a week from a Monday is unchanged');
  assert.deepEqual([...weeklyRhythm({ postsPerWeek: 3, startDate: monday }).weekdays], ['mon', 'wed', 'fri']);
  assert.deepEqual([...weeklyRhythm({ postsPerWeek: 4, startDate: monday }).weekdays], ['mon', 'tue', 'thu', 'fri'], 'four from a Monday no longer reaches into Saturday');
  assert.deepEqual([...weeklyRhythm({ postsPerWeek: 5 }).weekdays], ['mon', 'tue', 'wed', 'thu', 'fri'], 'with no start day, as before');
  // Not a Monday: the first post is on the start day and the rest are spread from it.
  assert.equal(weeklyRhythm({ postsPerWeek: 2, startDate: '2026-11-18' }).weekdays[0], 'wed');
  assert.deepEqual([...weeklyRhythm({ postsPerWeek: 2, startDate: '2026-11-18' }).weekdays], ['wed', 'sat']);
});

test('exact weekdays give a post on each of them every week, in week order, and win over postsPerWeek', async () => {
  const { postDates } = await import('./cadence.ts');
  const r = weeklyRhythm({ weeks: 2, weekdays: ['sat', 'MON', 'tue'], postsPerWeek: 5, startDate: '2026-12-07' });
  assert.deepEqual(r, { days: 6, weekdays: ['mon', 'tue', 'sat'] });
  // The dates the planner makes from it fall only on those days, from the start day.
  assert.deepEqual(postDates('2026-12-07', r.days, r.weekdays), ['2026-12-07', '2026-12-08', '2026-12-12', '2026-12-14', '2026-12-15', '2026-12-19']);
  assert.equal(weeklyRhythm({ weeks: 4, weekdays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] }).days, 28);
});

test('bad exact weekdays are refused in plain words', () => {
  for (const bad of [[], 'mon', ['funday'], [3], null]) assert.throws(() => weeklyRhythm({ weekdays: bad }), RhythmError, JSON.stringify(bad));
});

test('a plan that stops on an end day has a post on each chosen day from the start to the end, so the last week is short and nothing falls after it', async () => {
  const { postDates } = await import('./cadence.ts');
  // A billing month: starts Wednesday 18 November, renews Wednesday 16 December, so the last post may fall on Tuesday 15 December.
  const r = weeklyRhythm({ weeks: 4, postsPerWeek: 5, startDate: '2026-11-18', endDate: '2026-12-15' });
  assert.deepEqual(r.weekdays, ['mon', 'tue', 'wed', 'thu', 'fri'], 'the usual Monday-to-Friday spread, whatever day it starts on');
  assert.equal(r.days, 20, 'Wed to Fri, then three full weeks, then Mon and Tue');
  const dates = postDates('2026-11-18', r.days, r.weekdays);
  assert.deepEqual([dates[0], dates.at(-1)], ['2026-11-18', '2026-12-15'], 'the first post is on the start day and the last on the end day');
  assert.ok(dates.every((d) => d <= '2026-12-15'));
  // Days chosen by the customer: the same range with only Monday and Thursday.
  const own = weeklyRhythm({ weekdays: ['thu', 'mon'], startDate: '2026-11-18', endDate: '2026-12-15' });
  assert.deepEqual([own.weekdays, own.days], [['mon', 'thu'], 8], 'Thu 19, Mon 23, Thu 26, Mon 30, Thu 3, Mon 7, Thu 10, Mon 14');
  assert.equal(weeklyRhythm({ postsPerWeek: 5, startDate: '2026-11-18', endDate: '2026-11-18' }).days, 1, 'a one-day plan');
});

test('an end day is refused in plain words: no start, not a day, before the start, more than four weeks, or no post in the range', () => {
  const ok = { postsPerWeek: 5, startDate: '2026-11-18' };
  assert.throws(() => weeklyRhythm({ postsPerWeek: 5, endDate: '2026-12-15' }), /needs a startDate/);
  for (const bad of ['tomorrow', '2026-13-40', '', '2026-12-5']) assert.throws(() => weeklyRhythm({ ...ok, endDate: bad }), /real day/, `"${bad}"`);
  assert.throws(() => weeklyRhythm({ ...ok, endDate: '2026-11-17' }), /before startDate/);
  assert.doesNotThrow(() => weeklyRhythm({ ...ok, endDate: '2026-12-15' }), 'exactly four weeks counting the start day');
  assert.throws(() => weeklyRhythm({ ...ok, endDate: '2026-12-16' }), /four weeks/);
  assert.throws(() => weeklyRhythm({ postsPerWeek: 5, startDate: '2026-11-21', endDate: '2026-11-22' }), /no post falls/, 'a weekend holds no Monday-to-Friday post');
});
