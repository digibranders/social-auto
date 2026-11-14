/**
 * Moving a customer's carousel to another day of its own Monday-to-Sunday week. Only the day changes: the time and offset stay as written. The day lives in the carousel's own plan
 * file (what the pictures, the approval, the release and the posting read) and in its history entry (what the list shows); both are rewritten, the plan first, so a crash between the two
 * leaves the day the plan says, which is the one that is posted. An approved carousel stays approved: the approval is of its pictures and words, not of its day.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { changeHistory, readHistory } from './carousel-run.ts';
import { mondayOf } from './picture-limit.ts';

export class CarouselMoveError extends Error {
  readonly code: 'NOT_FOUND' | 'DAY_PASSED' | 'OUTSIDE_WEEK' | 'CONFLICT';
  constructor(code: CarouselMoveError['code'], message: string) {
    super(message);
    this.name = 'CarouselMoveError';
    this.code = code;
  }
}

const isRealDay = (day: string): boolean => {
  const at = Date.parse(`${day}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === day;
};

function writeJson(file: string, value: unknown): void {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, file);
}

/**
 * Moves the carousel `id` to `day` (YYYY-MM-DD). `today` is the day in India time; the carousel's current day and the new one must both be tomorrow or later. `status` is the
 * carousel's status now: only a waiting or an approved one can move. Moving to the day it already has changes nothing.
 */
export function moveCarousel(input: { brandDir: string; id: string; day: string; today: string; status: string }): { date: string; moved: boolean } {
  const entry = readHistory(input.brandDir).find((h) => h.id === input.id);
  if (!entry) throw new CarouselMoveError('NOT_FOUND', 'no such carousel');
  // A carousel whose slides are not drawn yet has its day only in its history entry; a drawn one also in its plan file, which is what is posted.
  const planPath = entry.planFile !== undefined ? join(input.brandDir, entry.planFile) : undefined;
  const plan = planPath ? (JSON.parse(readFileSync(planPath, 'utf8')) as { posts?: Array<{ id?: string; date?: string }> }) : undefined;
  const post = plan?.posts?.find((p) => p.id === input.id);
  const currentDate = post?.date ?? entry.date;
  if (plan && !post) throw new CarouselMoveError('NOT_FOUND', 'the plan file has no such carousel');
  if (typeof currentDate !== 'string') throw new CarouselMoveError('NOT_FOUND', 'this carousel has no day');
  const current = currentDate.slice(0, 10);
  if (!isRealDay(input.day)) throw new CarouselMoveError('OUTSIDE_WEEK', 'day must be a real day like 2026-11-25');
  if (!['topic', 'kept', 'pending', 'approved'].includes(input.status)) throw new CarouselMoveError('CONFLICT', 'only a carousel that is waiting, kept or approved can be moved');
  if (input.day === current) return { date: currentDate, moved: false };
  if (current <= input.today) throw new CarouselMoveError('DAY_PASSED', 'the day of this carousel is today or has passed, so it cannot be moved');
  if (mondayOf(input.day) !== mondayOf(current)) throw new CarouselMoveError('OUTSIDE_WEEK', 'a carousel can only move to another day of its own week');
  if (input.day <= input.today) throw new CarouselMoveError('DAY_PASSED', 'that day is today or has passed');
  const date = `${input.day}${currentDate.slice(10)}`;
  if (post && planPath && plan) {
    post.date = date;
    writeJson(planPath, plan);
  }
  changeHistory(input.brandDir, (entries) => entries.map((h) => (h.id === input.id ? { ...h, date } : h)));
  return { date, moved: true };
}
