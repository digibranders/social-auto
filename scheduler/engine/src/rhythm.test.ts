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
