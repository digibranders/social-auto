import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scheduleDates, type PlanSchedule } from './planner.ts';
import { weekChunks } from './week-chunks.ts';

const base = { time: '10:00', utcOffset: '+05:30' } as const;
const daysOf = (s: PlanSchedule): string[] => scheduleDates(s).map((d) => d.slice(0, 10));

test('a schedule inside one week is one chunk, the schedule itself', () => {
  const schedule: PlanSchedule = { ...base, startDate: '2026-11-16', count: 5, weekdays: ['mon', 'tue', 'wed', 'thu', 'fri'] };
  assert.deepEqual(weekChunks(schedule), [schedule]);
});

test('the chunks of weekday posts are one per calendar week and together have exactly the original days', () => {
  const schedule: PlanSchedule = { ...base, startDate: '2026-11-18', count: 19, weekdays: ['mon', 'tue', 'wed', 'thu', 'fri'] };
  const chunks = weekChunks(schedule);
  assert.equal(chunks.length, 5, 'Wed-Fri, three full weeks, then the rest');
  assert.deepEqual(chunks.flatMap(daysOf), daysOf(schedule));
  assert.deepEqual(chunks.map((c) => c.count), [3, 5, 5, 5, 1]);
  assert.deepEqual(chunks[0]?.weekdays, ['wed', 'thu', 'fri']);
});

test('posts on consecutive days (no weekday list) split at Monday and keep their days', () => {
  const schedule: PlanSchedule = { ...base, startDate: '2026-11-19', count: 12 };
  const chunks = weekChunks(schedule);
  assert.deepEqual(chunks.flatMap(daysOf), daysOf(schedule));
  assert.ok(chunks.every((c) => c.weekdays === undefined));
  assert.deepEqual(chunks.map((c) => c.count), [4, 7, 1]);
});

test('three days a week on Monday, Wednesday and Friday', () => {
  const schedule: PlanSchedule = { ...base, startDate: '2026-11-16', count: 9, weekdays: ['mon', 'wed', 'fri'] };
  const chunks = weekChunks(schedule);
  assert.deepEqual(chunks.map((c) => c.count), [3, 3, 3]);
  assert.deepEqual(chunks.flatMap(daysOf), daysOf(schedule));
});
