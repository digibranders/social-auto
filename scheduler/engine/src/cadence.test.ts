import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseWeekdays, postDates, weekdayOf, weekdaysForPostsPerWeek } from './cadence.ts';
import { scheduleDates } from './planner.ts';
import { autopilotArgs, cadenceOf, parseClients } from './run-clients.ts';

const base = { site: 'a.com', time: '10:00', utcOffset: '+05:30', target: 'publisher' } as const;

test('weekdayOf names the day of a calendar date', () => {
  assert.equal(weekdayOf('2026-10-29'), 'thu');
  assert.equal(weekdayOf('2026-11-01'), 'sun');
  assert.equal(weekdayOf('2026-11-02'), 'mon');
});

test('every postsPerWeek from 1 to 7 gives that many distinct days, and 0 or 8 are refused', () => {
  for (let n = 1; n <= 7; n++) assert.equal(new Set(weekdaysForPostsPerWeek(n)).size, n);
  assert.deepEqual(weekdaysForPostsPerWeek(3), ['mon', 'wed', 'fri']);
  assert.deepEqual(weekdaysForPostsPerWeek(5), ['mon', 'tue', 'wed', 'thu', 'fri']);
  assert.throws(() => weekdaysForPostsPerWeek(0), /1 to 7/);
  assert.throws(() => weekdaysForPostsPerWeek(8), /1 to 7/);
});

test('parseWeekdays accepts names in any case, orders them and rejects nonsense', () => {
  assert.deepEqual(parseWeekdays(['Sat', 'tuesday', 'sat']), ['tue', 'sat']);
  assert.throws(() => parseWeekdays(['funday']), /not a weekday/);
  assert.throws(() => parseWeekdays([]), /non-empty/);
  assert.throws(() => parseWeekdays('mon'), /non-empty/);
});

test('postDates picks only the chosen days, starting on or after the start date', () => {
  // 2026-11-03 is a Tuesday.
  assert.deepEqual(postDates('2026-11-03', 4, ['mon', 'wed', 'fri']), ['2026-11-04', '2026-11-06', '2026-11-09', '2026-11-11']);
  assert.deepEqual(postDates('2026-11-04', 1, ['wed']), ['2026-11-04']);
  assert.deepEqual(postDates('2026-11-01', 7, weekdaysForPostsPerWeek(7)).length, 7);
});

test('a later weekly batch continues the pattern: the day after the last post is a valid start', () => {
  const days = weekdaysForPostsPerWeek(3);
  const first = postDates('2026-11-02', 3, days);
  assert.deepEqual(first, ['2026-11-02', '2026-11-04', '2026-11-06']);
  // The next run starts the day after the last planned post (chooseStartDate), here a Saturday.
  assert.deepEqual(postDates('2026-11-07', 3, days), ['2026-11-09', '2026-11-11', '2026-11-13']);
});

test('scheduleDates stays consecutive without weekdays and honours them when given', () => {
  assert.deepEqual(scheduleDates({ startDate: '2026-11-02', time: '10:00', utcOffset: '+05:30', count: 3 }), [
    '2026-11-02T10:00:00+05:30',
    '2026-11-03T10:00:00+05:30',
    '2026-11-04T10:00:00+05:30',
  ]);
  assert.deepEqual(scheduleDates({ startDate: '2026-11-02', time: '09:30', utcOffset: '-05:00', count: 2, weekdays: ['tue', 'sat'] }), [
    '2026-11-03T09:30:00-05:00',
    '2026-11-07T09:30:00-05:00',
  ]);
});

test('a client can use postsPerWeek, weekdays (which wins), or the older days setting', () => {
  const [perWeek, exact, legacy] = parseClients({
    clients: [
      { ...base, postsPerWeek: 5 },
      { ...base, postsPerWeek: 5, weekdays: ['Tue', 'sat'] },
      { ...base, days: 7 },
    ],
  });
  assert.deepEqual(cadenceOf(perWeek!), { count: 5, weekdays: ['mon', 'tue', 'wed', 'thu', 'fri'] });
  assert.deepEqual(cadenceOf(exact!), { count: 2, weekdays: ['tue', 'sat'] });
  assert.deepEqual(cadenceOf(legacy!), { count: 7 });
});

test('parseClients rejects a client with no frequency and an out-of-range postsPerWeek', () => {
  assert.throws(() => parseClients({ clients: [{ ...base }] }), /postsPerWeek/);
  assert.throws(() => parseClients({ clients: [{ ...base, postsPerWeek: 9 }] }), /1 to 7/);
  assert.throws(() => parseClients({ clients: [{ ...base, postsPerWeek: 2.5 }] }), /1 to 7/);
  assert.throws(() => parseClients({ clients: [{ ...base, weekdays: ['nope'] }] }), /not a weekday/);
});

test('autopilotArgs passes the batch size and the days', () => {
  const [client] = parseClients({ clients: [{ ...base, postsPerWeek: 3 }] });
  const args = autopilotArgs(client!);
  assert.equal(args[args.indexOf('--days') + 1], '3');
  assert.equal(args[args.indexOf('--weekdays') + 1], 'mon,wed,fri');
  const [old] = parseClients({ clients: [{ ...base, days: 7 }] });
  assert.ok(!autopilotArgs(old!).includes('--weekdays'));
});

test('weekdaysFrom puts the first post on the chosen day and spreads the rest through the week', async () => {
  const { weekdaysFrom } = await import('./cadence.ts');
  assert.deepEqual(weekdaysFrom('2026-12-14', 1), ['mon']);
  assert.deepEqual(weekdaysFrom('2026-12-16', 2), ['wed', 'sat'], '16 December 2026 is a Wednesday');
  assert.deepEqual(weekdaysFrom('2026-12-14', 3), ['mon', 'wed', 'fri']);
  assert.deepEqual(weekdaysFrom('2026-12-17', 7), ['thu', 'fri', 'sat', 'sun', 'mon', 'tue', 'wed']);
  // The first post of a written run is on the day asked for.
  assert.equal(postDates('2026-12-16', 4, weekdaysFrom('2026-12-16', 2))[0], '2026-12-16');
  assert.deepEqual(postDates('2026-12-16', 4, weekdaysFrom('2026-12-16', 2)), ['2026-12-16', '2026-12-19', '2026-12-23', '2026-12-26']);
  assert.throws(() => weekdaysFrom('2026-12-16', 0), /whole number from 1 to 7/);
  assert.throws(() => weekdaysFrom('2026-12-16', 8), /whole number from 1 to 7/);
});
