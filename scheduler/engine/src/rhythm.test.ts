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
