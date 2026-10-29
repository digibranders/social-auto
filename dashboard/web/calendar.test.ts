import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addDays,
  addMonths,
  brandHue,
  brandLabel,
  dayKeyOf,
  formatDateTime,
  formatDayHeader,
  formatHourLabel,
  formatTime,
  groupByDay,
  hourOf,
  minuteOf,
  monthGrid,
  safeHttpsUrl,
  weekDays,
  weekStart,
  weekdayName,
  captionProblem,
  captionStats,
} from './calendar.ts';
import type { StatusPost } from '../shared/status.ts';

const post = (id: string, date: string): StatusPost => ({
  id,
  brand: 'b',
  platform: 'instagram',
  date,
  caption: id,
  image: null,
  state: 'scheduled',
  permalink: null,
  publishedAt: null,
  mediaUrl: null,
  edited: false,
  editable: true,
});

test('dayKeyOf uses the display time zone, not UTC', () => {
  // 20:00 UTC on 31 Dec is already 01:30 on 1 Jan in India.
  assert.equal(dayKeyOf('2026-12-31T20:00:00Z'), '2027-01-01');
  assert.equal(dayKeyOf('2026-10-29T10:00:00+05:30'), '2026-10-29');
  assert.equal(dayKeyOf('2026-10-28T23:59:00+05:30'), '2026-10-28');
});

test('addDays and addMonths cross month and year ends', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(addMonths('2026-12-15', 1), '2027-01-01');
  assert.equal(addMonths('2026-01-31', -1), '2025-12-01');
});

test('weeks start on Monday', () => {
  assert.equal(weekStart('2026-10-28'), '2026-10-26'); // Wednesday -> Monday
  assert.equal(weekStart('2026-11-01'), '2026-10-26'); // Sunday belongs to the week before
  assert.deepEqual(weekDays('2026-10-28'), [
    '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01',
  ]);
});

test('monthGrid covers the whole month in whole Monday-first weeks', () => {
  const grid = monthGrid('2026-11-15');
  assert.ok(grid.every((week) => week.length === 7));
  assert.equal(grid[0]?.[0], '2026-10-26');
  assert.equal(grid.at(-1)?.[6], '2026-12-06');
  assert.ok(grid.flat().includes('2026-11-30'));
  assert.equal(monthGrid('2027-02-10').length, 4); // 1 Feb 2027 is a Monday and the month has 28 days
  assert.equal(monthGrid('2026-02-10').length, 5); // 1 Feb 2026 is a Sunday, so it starts in the previous week
});

test('groupByDay groups by display day and orders each day by time', () => {
  const groups = groupByDay([
    post('late', '2026-10-29T18:00:00+05:30'),
    post('early', '2026-10-29T10:00:00+05:30'),
    post('next', '2026-10-30T10:00:00+05:30'),
  ]);
  assert.deepEqual(groups.get('2026-10-29')?.map((p) => p.id), ['early', 'late']);
  assert.deepEqual([...groups.keys()], ['2026-10-29', '2026-10-30']);
});

test('labels: client names, stable colours and times', () => {
  assert.equal(brandLabel('brandbasket'), 'Brandbasket');
  assert.equal(brandLabel('cafe-moon_two'), 'Cafe Moon Two');
  assert.equal(brandHue('brandbasket'), brandHue('brandbasket'));
  assert.notEqual(brandHue('brandbasket'), brandHue('currycook'));
  assert.match(formatTime('2026-10-29T10:00:00+05:30'), /^10:00\s?am$/i);
  assert.match(formatDateTime('2026-10-29T10:00:00+05:30'), /29 Oct.*2026.*10:00/);
});

test('hours and minutes are read in the display time zone', () => {
  assert.equal(hourOf('2026-10-29T10:00:00+05:30'), 10);
  assert.equal(minuteOf('2026-10-29T10:45:00+05:30'), 45);
  assert.equal(hourOf('2026-12-31T20:00:00Z'), 1); // 01:30 the next day in India
  assert.equal(minuteOf('2026-12-31T20:00:00Z'), 30);
  assert.equal(hourOf('2026-10-28T18:30:00Z'), 0); // midnight in India reads as 0, never 24
});

test('grid labels match the layout of the hourly calendar', () => {
  assert.equal(formatHourLabel(0), '12:00 AM');
  assert.equal(formatHourLabel(10), '10:00 AM');
  assert.equal(formatHourLabel(13), '1:00 PM');
  assert.equal(weekdayName('2026-10-26'), 'Monday');
  assert.equal(formatDayHeader('2026-10-26'), '10/26/2026');
});

test('safeHttpsUrl only lets https links through', () => {
  assert.equal(safeHttpsUrl('https://www.instagram.com/p/abc/'), 'https://www.instagram.com/p/abc/');
  assert.equal(safeHttpsUrl('http://example.com/x'), null);
  assert.equal(safeHttpsUrl('javascript:alert(1)'), null);
  assert.equal(safeHttpsUrl('not a url'), null);
  assert.equal(safeHttpsUrl(null), null);
  assert.equal(safeHttpsUrl('http://localhost:4010/p.jpg', 'http://localhost:4010'), 'http://localhost:4010/p.jpg');
  assert.equal(safeHttpsUrl('http://evil.example/p.jpg', 'http://localhost:4010'), null);
});

test('captionStats counts characters and hashtags, and captionProblem names the limit that is broken', () => {
  assert.deepEqual(captionStats('  Hello #one #दो_two world '), { length: 24, hashtags: 2 });
  assert.equal(captionProblem('fine #one'), null);
  assert.match(captionProblem('   ') ?? '', /empty/);
  assert.match(captionProblem('x'.repeat(2205)) ?? '', /5 characters too long/);
  assert.match(captionProblem(Array.from({ length: 31 }, (_, i) => `#t${i}`).join(' ')) ?? '', /31/);
});
