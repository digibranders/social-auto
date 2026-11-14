import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CarouselMoveError, moveCarousel } from './carousel-move.ts';

// Friday 20 November 2026, 10:00 India time; today is Wednesday 18 November.
const FRIDAY = '2026-11-20T10:00:00+05:30';
const TODAY = '2026-11-18';

function setup(date = FRIDAY) {
  const dir = mkdtempSync(join(tmpdir(), 'carousel-move-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'week-09.json'), JSON.stringify({ brand: 'bb', posts: [{ id: 'car-1', date, headline: 'Why it works' }, { id: 'other', date: '2026-11-19T10:00:00+05:30' }] }));
  writeFileSync(join(dir, 'carousels.json'), JSON.stringify({ carousels: [{ id: 'car-1', topic: 'Why it works', createdAt: '2026-11-17T00:00:00Z', planFile: 'week-09.json', date }] }));
  const plan = (): { posts: Array<{ id: string; date: string }> } => JSON.parse(readFileSync(join(dir, 'week-09.json'), 'utf8')) as never;
  const history = (): { carousels: Array<{ date: string }> } => JSON.parse(readFileSync(join(dir, 'carousels.json'), 'utf8')) as never;
  const move = (day: string, status = 'pending', id = 'car-1') => moveCarousel({ brandDir: dir, id, day, today: TODAY, status });
  return { dir, plan, history, move, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const codeOf = (work: () => unknown): string | undefined => {
  try {
    work();
    return undefined;
  } catch (error) {
    return error instanceof CarouselMoveError ? error.code : `OTHER:${String(error)}`;
  }
};

test('a waiting or approved carousel moves to another day of its own week, keeping its time, in its plan and its history, and nothing else changes', () => {
  const s = setup();
  try {
    assert.deepEqual(s.move('2026-11-19'), { date: '2026-11-19T10:00:00+05:30', moved: true });
    assert.equal(s.plan().posts.find((p) => p.id === 'car-1')?.date, '2026-11-19T10:00:00+05:30');
    assert.equal(s.history().carousels[0]?.date, '2026-11-19T10:00:00+05:30');
    assert.equal(s.plan().posts.find((p) => p.id === 'other')?.date, '2026-11-19T10:00:00+05:30', 'the week\'s other post is untouched');
    assert.deepEqual(s.move('2026-11-21', 'approved'), { date: '2026-11-21T10:00:00+05:30', moved: true }, 'an approved one moves too');
    assert.deepEqual(s.move('2026-11-21'), { date: '2026-11-21T10:00:00+05:30', moved: false }, 'the day it already has changes nothing');
  } finally {
    s.done();
  }
});

test('a carousel does not move to another week, to today or the past, once its own day has come, when it is not waiting or approved, or when the day is not a day', () => {
  const s = setup();
  try {
    assert.equal(codeOf(() => s.move('2026-11-23')), 'OUTSIDE_WEEK', 'next week');
    assert.equal(codeOf(() => s.move('2026-11-15')), 'OUTSIDE_WEEK', 'last week');
    assert.equal(codeOf(() => s.move('2026-11-18')), 'DAY_PASSED', 'today');
    assert.equal(codeOf(() => s.move('2026-11-17')), 'DAY_PASSED', 'a day that passed, in its own week');
    for (const status of ['rejected', 'blocked', 'incomplete']) assert.equal(codeOf(() => s.move('2026-11-19', status)), 'CONFLICT', status);
    for (const bad of ['tomorrow', '2026-13-40', '']) assert.equal(codeOf(() => s.move(bad)), 'OUTSIDE_WEEK', `"${bad}"`);
    assert.equal(codeOf(() => s.move('2026-11-19', 'pending', 'nope')), 'NOT_FOUND');
    assert.equal(s.plan().posts.find((p) => p.id === 'car-1')?.date, FRIDAY, 'nothing changed by the refusals');
  } finally {
    s.done();
  }
  const due = setup('2026-11-18T10:00:00+05:30');
  try {
    assert.equal(codeOf(() => due.move('2026-11-19')), 'DAY_PASSED', 'a carousel whose own day is today is already due');
  } finally {
    due.done();
  }
});
