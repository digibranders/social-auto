import { test } from 'node:test';
import assert from 'node:assert/strict';
import { carouselRoom, type CarouselMade } from './carousel-limit.ts';

// 2026-11-16 is a Monday; the week runs to Sunday 2026-11-22.
const made = (date: string, rejected = false): CarouselMade => ({ id: `car-${date.slice(0, 10)}`, date: `${date}T10:00:00+05:30`, rejected });

test('a week with no carousel has room, and a wanted one fills it', () => {
  assert.equal(carouselRoom([], '2026-11-18T10:00:00+05:30').ok, true);
  const full = carouselRoom([made('2026-11-17')], '2026-11-20T10:00:00+05:30');
  assert.equal(full.ok, false);
  assert.equal(full.restart, '2026-11-23');
  assert.match(full.message ?? '', /week of 2026-11-16/);
});

test('a carousel in another week does not count', () => {
  assert.equal(carouselRoom([made('2026-11-15'), made('2026-11-23')], '2026-11-18T10:00:00+05:30').ok, true);
});

test('a rejected carousel frees the week once, and a second one is the last', () => {
  assert.equal(carouselRoom([made('2026-11-17', true)], '2026-11-18T10:00:00+05:30').ok, true);
  const twice = carouselRoom([made('2026-11-17', true), made('2026-11-18', true)], '2026-11-19T10:00:00+05:30');
  assert.equal(twice.ok, false);
  assert.match(twice.message ?? '', /Two carousels/);
});
