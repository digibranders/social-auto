/**
 * The copy-first stop: after a website is read and the posts are written, the owner sees every headline and caption and keeps or drops each one
 * BEFORE any picture is bought. Only kept posts are drawn (autopilot --draw-kept), and each still goes through the normal poster review afterwards.
 *
 * One small file per batch, brands/<brand>/copy-first/<week-NN.json>, changed only under a lock. A decision belongs to the exact words it was made
 * about (a hash of headline and caption): if the plan file is edited afterwards, that post is no longer kept and must be decided again.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LockError, syncDir, withFileLock } from './file-lock.ts';
import { mondayOf } from './picture-limit.ts';
import type { NotDrawn } from './not-drawn.ts';

export type CopyState = 'pending' | 'kept' | 'dropped';

export class CopyStageError extends Error {
  readonly code: 'NOT_FOUND' | 'INVALID' | 'ALREADY_DRAWN' | 'CLOSED' | 'REJECTED' | 'LOCKED' | 'CONFLICT' | 'LIMIT' | 'DAY_PASSED' | 'OUTSIDE_WEEK';
  constructor(code: CopyStageError['code'], message: string) {
    super(message);
    this.name = 'CopyStageError';
    this.code = code;
  }
}

export interface CopyPost {
  postId: string;
  headline: string;
  caption: string;
  /** Hash of the headline and caption this entry was made from. */
  contentHash: string;
  /** The caption of each network the post is written for (the main caption is Instagram's); `fallback` marks one that is the main caption adapted. */
  captions?: Record<string, { text: string; edited?: boolean; fallback?: boolean }>;
  /** The day the post goes out (YYYY-MM-DD, India time). It decides the post's week; a batch written before this was recorded has none and is drawn as one piece. */
  date?: string;
  /** True once the owner has changed the writer's words. */
  edited?: boolean;
  /** The owner's own sign-off wording for this poster: only what differs from the brand's name and the website's address; an empty string leaves that line off. */
  signoff?: { brandName?: string; domain?: string };
  /** A note for the owner, such as "weak headline: it tells the reader nothing specific". Advice only: the owner can still keep the post. */
  advice?: string;
  state: CopyState;
  /** Set on a post written to take the place of a dropped one: that post's id. */
  replaces?: string;
  /** When this post was sent to be drawn. From then on its choice, words and day are final, while the rest of its week stays open. Batches drawn before this existed lock the whole week instead (`weekDrawn`). */
  drawnAt?: string;
  decidedBy?: string;
  decidedAt?: string;
}

export interface CopyBatch {
  brand: string;
  planFile: string;
  createdAt: string;
  posts: CopyPost[];
  /** Set when the kept posts have been sent to be drawn: from then on the choices are final. A batch of several weeks gets it once every week is drawn or lapsed. */
  drawnAt?: string;
  /** The weeks (their Mondays) whose kept posts were sent to be drawn, with the time. From then on the choices and words of that week's posts are final. */
  weekDrawn?: Record<string, string>;
  /** The days the plan was asked to write posts for (YYYY-MM-DD), so a week or a day that came out empty can be told. Absent on a batch written before this was recorded. */
  requestedDays?: string[];
  /** Kept topics that got no picture in their week's draw, with why. They stay open for keep, drop and edit; a retry of the week draws only them. */
  notDrawn?: Record<string, NotDrawn>;
  /** How many replacements were written for each week (its Monday), and which new post replaced each dropped one. */
  replacements?: Record<string, number>;
  replacedBy?: Record<string, string>;
  /** The weeks (their Mondays) that were left undrawn because their time passed or nothing was kept in them. Nothing of them is drawn any more. */
  weekLapsed?: Record<string, string>;
  /** Set when the owner put the whole batch away without drawing it: it is no longer listed and its posts cannot be drawn. */
  closedAt?: string;
  closedBy?: string;
}

/** The weeks a batch covers (Mondays, in order), from the days of its posts. A batch whose posts have no day is one piece: no weeks. */
export const weeksOf = (batch: { posts: ReadonlyArray<Pick<CopyPost, 'date'>> }): string[] => [...new Set(batch.posts.flatMap((p) => (p.date ? [mondayOf(p.date)] : [])))].sort();

/** The week (Monday) of a post, or undefined when the post has no day. */
export const weekOfPost = (post: Pick<CopyPost, 'date'>): string | undefined => (post.date ? mondayOf(post.date) : undefined);

/** Whether a post's choices and words are final: it was sent to be drawn, or its week was drawn (an older batch) or lapsed, or the whole batch was drawn. */
export const postLocked = (batch: CopyBatch, post: CopyPost): boolean => {
  const week = weekOfPost(post);
  // A topic that got no picture in its week's draw is open again (unless its week was given up): there is nothing drawn to keep final.
  if (batch.notDrawn?.[post.postId] !== undefined && (week === undefined || batch.weekLapsed?.[week] === undefined)) return false;
  // A post that was sent to be drawn is final on its own; the other posts of its week are not locked by it.
  if (post.drawnAt !== undefined) return true;
  return batch.drawnAt !== undefined || (week !== undefined && (batch.weekDrawn?.[week] !== undefined || batch.weekLapsed?.[week] !== undefined));
};

/** The most replacements a batch may have written for one week: a dropped topic gives a new one, up to this many times. */
export const MAX_REPLACEMENTS_PER_WEEK = 3;

/** Why a dropped post cannot be given a new topic now (and the code to answer with), or null when it can. `today` is the day in India time (YYYY-MM-DD). */
export function replaceProblem(batch: CopyBatch, postId: string, today: string, maxPerWeek: number = MAX_REPLACEMENTS_PER_WEEK): { code: CopyStageError['code']; message: string } | null {
  if (batch.closedAt) return { code: 'CLOSED', message: 'this batch was put away, so it cannot be changed' };
  const post = batch.posts.find((p) => p.postId === postId);
  if (!post) return { code: 'NOT_FOUND', message: 'no such post in this batch' };
  if (post.state !== 'dropped') return { code: 'CONFLICT', message: 'only a post that was dropped can be given a new topic' };
  if (batch.replacedBy?.[postId] !== undefined) return { code: 'CONFLICT', message: 'this post was already given a new topic' };
  if (postLocked(batch, post)) return { code: 'ALREADY_DRAWN', message: 'this post was already sent to be drawn, so its week is final' };
  if (post.date === undefined) return { code: 'INVALID', message: 'this post has no day, so a new topic cannot be written for it' };
  if (post.date <= today) return { code: 'DAY_PASSED', message: 'the day of this post is today or has passed' };
  const week = weekOfPost(post) as string;
  if ((batch.replacements?.[week] ?? 0) >= maxPerWeek) return { code: 'LIMIT', message: `a week may have ${MAX_REPLACEMENTS_PER_WEEK} new topics written` };
  return null;
}

/**
 * The kept posts of a week that a draw asked for now would draw: kept, with no picture yet (a kept post that was drawn and got none is drawn again), not locked by an earlier draw,
 * whose day is tomorrow or later (`today` is the day in India time, YYYY-MM-DD), and not part of a draw that is still running (`inFlight`). A batch with no weeks is drawn as one piece and is not asked here.
 */
export function drawCandidates(batch: CopyBatch, week: string, made: ReadonlySet<string>, today: string, inFlight: ReadonlySet<string> = new Set()): string[] {
  return batch.posts
    .filter((p) => p.state === 'kept' && weekOfPost(p) === week && p.date !== undefined && p.date > today && !postLocked(batch, p) && !inFlight.has(p.postId) && ![...made].some((key) => key.startsWith(`${p.postId}|`)))
    .map((p) => p.postId);
}

/** The posts of a week that are still open: not sent to be drawn, and their day is tomorrow or later. They can be kept, dropped, edited, moved or replaced. */
export const openPosts = (batch: CopyBatch, week: string, today: string): string[] =>
  batch.posts.filter((p) => weekOfPost(p) === week && p.date !== undefined && p.date > today && !postLocked(batch, p)).map((p) => p.postId);

export const PLAN_FILE = /^week-\d{2,4}\.json$/;
const POST_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/;

/** The hash of the words a choice was made about: the headline, the main caption and, when the post is written for networks, every network's caption. */
export const copyHash = (headline: string, caption: string, captions?: Record<string, string>): string => {
  const keys = captions ? Object.keys(captions).sort() : [];
  return createHash('sha256').update(JSON.stringify({ headline, caption, ...(keys.length > 0 ? { captions: keys.map((k) => [k, (captions as Record<string, string>)[k]]) } : {}) })).digest('hex');
};

const textsOf = (captions?: Record<string, { text: string }>): Record<string, string> | undefined => (captions ? Object.fromEntries(Object.entries(captions).map(([k, v]) => [k, v.text])) : undefined);

export class CopyStage {
  private readonly dir: string;
  private readonly brand: string;
  private readonly now: () => Date;
  constructor(brandDir: string, brand: string, now: () => Date = () => new Date()) {
    this.brand = brand;
    this.now = now;
    this.dir = join(brandDir, 'copy-first');
  }

  private fileOf(planFile: string): string {
    if (!PLAN_FILE.test(planFile)) throw new CopyStageError('INVALID', 'that is not a plan file name');
    return join(this.dir, planFile);
  }

  private read(planFile: string): CopyBatch {
    const file = this.fileOf(planFile);
    if (!existsSync(file)) throw new CopyStageError('NOT_FOUND', 'no copy batch for that plan');
    return JSON.parse(readFileSync(file, 'utf8')) as CopyBatch;
  }

  private change<T>(planFile: string, work: (batch: CopyBatch | undefined) => { batch: CopyBatch; result: T }): T {
    const file = this.fileOf(planFile);
    mkdirSync(this.dir, { recursive: true });
    try {
      return withFileLock(`${file}.lock`, (owns) => {
        const current = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as CopyBatch) : undefined;
        const { batch, result } = work(current);
        if (!owns()) throw new CopyStageError('LOCKED', 'this process no longer holds the lock, so nothing was written');
        const temp = `${file}.${process.pid}.tmp`;
        writeFileSync(temp, `${JSON.stringify(batch, null, 2)}\n`, { flag: 'w' });
        renameSync(temp, file);
        syncDir(this.dir);
        return result;
      }, { timeoutMs: 5000 });
    } catch (error) {
      if (error instanceof LockError) throw new CopyStageError('LOCKED', 'the copy list is busy, so nothing was changed');
      throw error;
    }
  }

  /** Records a freshly written batch. Opening the same batch again changes nothing (decisions already made stay). */
  open(planFile: string, posts: ReadonlyArray<{ postId: string; date?: string; headline: string; caption: string; captions?: Record<string, { text: string; fallback?: boolean }>; advice?: string }>, requestedDays?: readonly string[]): CopyBatch {
    return this.change(planFile, (existing) => {
      if (existing) return { batch: existing, result: existing };
      const batch: CopyBatch = {
        brand: this.brand,
        planFile,
        createdAt: this.now().toISOString(),
        posts: posts.map((p) => ({ postId: p.postId, ...(p.date && /^\d{4}-\d{2}-\d{2}$/.test(p.date) ? { date: p.date } : {}), headline: p.headline, caption: p.caption, contentHash: copyHash(p.headline, p.caption, textsOf(p.captions)), ...(p.captions && Object.keys(p.captions).length > 0 ? { captions: p.captions } : {}), ...(p.advice ? { advice: p.advice.slice(0, 300) } : {}), state: 'pending' })),
        ...(requestedDays && requestedDays.length > 0 ? { requestedDays: [...new Set(requestedDays)].filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort() } : {}),
      };
      return { batch, result: batch };
    });
  }

  list(): CopyBatch[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir).filter((n) => PLAN_FILE.test(n)).sort().map((n) => this.read(n));
  }

  get(planFile: string): CopyBatch {
    return this.read(planFile);
  }

  /** Keeps or drops one post. A choice can be changed until the batch is sent to be drawn. */
  decide(planFile: string, postId: string, state: 'kept' | 'dropped', by: string): CopyBatch {
    if (!POST_ID.test(postId)) throw new CopyStageError('INVALID', 'that is not a post id');
    if (by.trim() === '') throw new CopyStageError('INVALID', 'who is deciding must be given');
    return this.change(planFile, (batch) => {
      if (!batch) throw new CopyStageError('NOT_FOUND', 'no copy batch for that plan');
      if (batch.closedAt) throw new CopyStageError('CLOSED', 'this batch was put away, so its choices are final');
      const post = batch.posts.find((p) => p.postId === postId);
      if (!post) throw new CopyStageError('NOT_FOUND', 'no such post in this batch');
      if (postLocked(batch, post)) throw new CopyStageError('ALREADY_DRAWN', 'this post was already sent to be drawn, so its choices are final');
      post.state = state;
      // A topic she drops is no longer waiting for a picture.
      if (state === 'dropped' && batch.notDrawn?.[postId] !== undefined) {
        const { [postId]: _gone, ...left } = batch.notDrawn;
        if (Object.keys(left).length > 0) batch.notDrawn = left;
        else delete batch.notDrawn;
      }
      post.decidedBy = by.trim().slice(0, 80);
      post.decidedAt = this.now().toISOString();
      return { batch, result: batch };
    });
  }

  /**
   * The posts to draw: kept, and still exactly the words that were kept. `current` is the plan as it is now; a post whose words changed
   * since the choice is left out and named in `changed`.
   */
  toDraw(planFile: string, current: ReadonlyArray<{ postId: string; headline: string; caption: string; captions?: Record<string, string> }>, week?: string): { postIds: string[]; changed: string[] } {
    const batch = this.read(planFile);
    const postIds: string[] = [];
    const changed: string[] = [];
    for (const post of batch.posts.filter((p) => p.state === 'kept' && (week === undefined || weekOfPost(p) === week))) {
      const now = current.find((c) => c.postId === post.postId);
      if (now && copyHash(now.headline, now.caption, now.captions) === post.contentHash) postIds.push(post.postId);
      else changed.push(post.postId);
    }
    return { postIds, changed };
  }

  /** Makes the choices final once the kept posts are about to be drawn. */
  markDrawn(planFile: string): void {
    this.change(planFile, (batch) => {
      if (!batch) throw new CopyStageError('NOT_FOUND', 'no copy batch for that plan');
      if (batch.drawnAt) throw new CopyStageError('ALREADY_DRAWN', 'this batch was already drawn once; a second run would buy the pictures again');
      if (batch.closedAt) throw new CopyStageError('CLOSED', 'this batch was put away, so it cannot be drawn');
      return { batch: { ...batch, drawnAt: this.now().toISOString() }, result: undefined };
    });
  }

  /**
   * Makes the choices of the given posts final, each on its own, once they are about to be drawn: the rest of their week stays open. Every post must be kept and not locked (a kept
   * post that was drawn and got no picture is open again, so it may be drawn again). Nothing is changed when any of them is refused.
   */
  markPostsDrawn(planFile: string, postIds: readonly string[]): void {
    this.change(planFile, (batch) => {
      if (!batch) throw new CopyStageError('NOT_FOUND', 'no copy batch for that plan');
      if (batch.closedAt) throw new CopyStageError('CLOSED', 'this batch was put away, so it cannot be drawn');
      const at = this.now().toISOString();
      for (const id of postIds) {
        const post = batch.posts.find((p) => p.postId === id);
        if (!post) throw new CopyStageError('NOT_FOUND', 'no such post in this batch');
        if (post.state !== 'kept') throw new CopyStageError('REJECTED', 'only a kept post is drawn');
        if (postLocked(batch, post)) throw new CopyStageError('ALREADY_DRAWN', 'this post was already sent to be drawn once; a second run would buy the pictures again');
      }
      const posts = batch.posts.map((p) => (postIds.includes(p.postId) ? { ...p, drawnAt: at } : p));
      return { batch: { ...batch, posts }, result: undefined };
    });
  }

  /**
   * Makes the choices of one week final once its kept posts are about to be drawn. The whole batch counts as drawn (`drawnAt`) once every week of it is drawn or lapsed.
   * A week drawn twice is refused, so a crash part-way can never make a second run buy the same pictures again.
   */
  markWeekDrawn(planFile: string, week: string): void {
    this.change(planFile, (batch) => {
      if (!batch) throw new CopyStageError('NOT_FOUND', 'no copy batch for that plan');
      if (batch.closedAt) throw new CopyStageError('CLOSED', 'this batch was put away, so it cannot be drawn');
      if (!weeksOf(batch).includes(week)) throw new CopyStageError('NOT_FOUND', 'no such week in this batch');
      if (batch.weekDrawn?.[week] !== undefined || batch.weekLapsed?.[week] !== undefined) throw new CopyStageError('ALREADY_DRAWN', 'this week was already drawn once; a second run would buy the pictures again');
      return { batch: this.settled({ ...batch, weekDrawn: { ...(batch.weekDrawn ?? {}), [week]: this.now().toISOString() } }), result: undefined };
    });
  }

  /** Gives a week up: its time passed, or nothing was kept in it. Nothing of it is drawn any more, and its posts are final. */
  markWeekLapsed(planFile: string, week: string): void {
    this.change(planFile, (batch) => {
      if (!batch) throw new CopyStageError('NOT_FOUND', 'no copy batch for that plan');
      if (!weeksOf(batch).includes(week)) throw new CopyStageError('NOT_FOUND', 'no such week in this batch');
      if (batch.weekDrawn?.[week] !== undefined || batch.weekLapsed?.[week] !== undefined) return { batch, result: undefined };
      return { batch: this.settled({ ...batch, weekLapsed: { ...(batch.weekLapsed ?? {}), [week]: this.now().toISOString() } }), result: undefined };
    });
  }

  /**
   * Adds the new topic written for a dropped post: same day, undecided, with its words for each network. Checked again under the lock (a draw or a second replacement may have
   * come in while it was being written); the replacement is counted only here, so a try that wrote nothing never uses one of the week's.
   */
  addReplacement(planFile: string, droppedId: string, post: { postId: string; date: string; headline: string; caption: string; captions?: Record<string, { text: string; fallback?: boolean }>; advice?: string }, today: string, maxPerWeek: number = MAX_REPLACEMENTS_PER_WEEK): CopyBatch {
    return this.change(planFile, (batch) => {
      if (!batch) throw new CopyStageError('NOT_FOUND', 'no copy batch for that plan');
      const problem = replaceProblem(batch, droppedId, today, maxPerWeek);
      if (problem) throw new CopyStageError(problem.code, problem.message);
      if (batch.posts.some((p) => p.postId === post.postId)) throw new CopyStageError('CONFLICT', 'a post with that id already exists');
      const gone = batch.posts.find((p) => p.postId === droppedId) as CopyPost;
      const week = weekOfPost(gone) as string;
      const added: CopyPost = { postId: post.postId, date: gone.date as string, headline: post.headline, caption: post.caption, contentHash: copyHash(post.headline, post.caption, textsOf(post.captions)), ...(post.captions && Object.keys(post.captions).length > 0 ? { captions: post.captions } : {}), ...(post.advice ? { advice: post.advice.slice(0, 300) } : {}), state: 'pending', replaces: droppedId };
      const next: CopyBatch = { ...batch, posts: [...batch.posts, added], replacements: { ...(batch.replacements ?? {}), [week]: (batch.replacements?.[week] ?? 0) + 1 }, replacedBy: { ...(batch.replacedBy ?? {}), [droppedId]: post.postId } };
      return { batch: next, result: next };
    });
  }

  /**
   * Moves a written post to another day of its own week (Monday to Sunday), before its week is drawn: whatever its state (pending, kept, dropped). `rewritePlan` is called under the
   * same lock with the post's id and the new day, so the plan file the pictures are drawn and released from carries the same day; it runs before the batch is written, and a failure
   * leaves the batch as it was. Moving to the day it already has changes nothing. `today` is the day in India time (YYYY-MM-DD).
   */
  movePost(planFile: string, postId: string, day: string, today: string, rewritePlan: (postId: string, day: string) => void): { batch: CopyBatch; moved: boolean } {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`)) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) throw new CopyStageError('INVALID', 'the day must be a real day like 2026-11-25');
    return this.change<{ batch: CopyBatch; moved: boolean }>(planFile, (batch) => {
      if (!batch) throw new CopyStageError('NOT_FOUND', 'no copy batch for that plan');
      if (batch.closedAt) throw new CopyStageError('CLOSED', 'this batch was put away, so it cannot be changed');
      const post = batch.posts.find((p) => p.postId === postId);
      if (!post) throw new CopyStageError('NOT_FOUND', 'no such post in this batch');
      if (postLocked(batch, post)) throw new CopyStageError('ALREADY_DRAWN', 'this post was already sent to be drawn, so its day is final');
      if (post.date === undefined) throw new CopyStageError('INVALID', 'this post has no day, so it cannot be moved');
      if (post.date === day) return { batch, result: { batch, moved: false } };
      if (mondayOf(day) !== weekOfPost(post)) throw new CopyStageError('OUTSIDE_WEEK', 'a post can only move to another day of its own week');
      if (day <= today) throw new CopyStageError('DAY_PASSED', 'that day is today or has passed');
      rewritePlan(postId, day);
      const from = post.date;
      const posts = batch.posts.map((p) => (p.postId === postId ? { ...p, date: day } : p));
      // A day the plan asked for that this post leaves (and no other post is on) is now the day it was moved to, so it is not reported as a day with no post.
      const left = !posts.some((p) => p.date === from);
      const requestedDays = batch.requestedDays && left && batch.requestedDays.includes(from) ? [...new Set(batch.requestedDays.map((d) => (d === from ? day : d)))].sort() : batch.requestedDays;
      const next: CopyBatch = { ...batch, posts, ...(requestedDays ? { requestedDays } : {}) };
      return { batch: next, result: { batch: next, moved: true } };
    });
  }

  /**
   * Records which kept topics of a draw got no picture, and forgets the ones that now have one. `missing` replaces the entries of the posts it names; `made` lists
   * posts that have pictures now.
   */
  setNotDrawn(planFile: string, missing: Readonly<Record<string, NotDrawn>>, made: readonly string[] = []): void {
    this.change(planFile, (batch) => {
      if (!batch) throw new CopyStageError('NOT_FOUND', 'no copy batch for that plan');
      const next: Record<string, NotDrawn> = { ...(batch.notDrawn ?? {}), ...missing };
      for (const id of made) delete next[id];
      const { notDrawn: _old, ...rest } = batch;
      return { batch: Object.keys(next).length > 0 ? { ...rest, notDrawn: next } : rest, result: undefined };
    });
  }

  /** The batch with `drawnAt` set once every one of its weeks is drawn or lapsed. */
  private settled(batch: CopyBatch): CopyBatch {
    const done = weeksOf(batch).every((w) => batch.weekDrawn?.[w] !== undefined || batch.weekLapsed?.[w] !== undefined);
    return done && batch.drawnAt === undefined ? { ...batch, drawnAt: this.now().toISOString() } : batch;
  }

  /**
   * Replaces the words of one post before it is drawn. `applyToPlan` writes the same words into the plan file and runs inside the lock, ahead of this file's own
   * write, so the plan and the list can never disagree; if it throws, nothing changes. The post keeps its choice: a kept post stays kept, with the new words.
   */
  edit(planFile: string, postId: string, words: { headline: string; caption: string; network?: string; networkCaption?: string; /** undefined leaves it as it is; null goes back to the brand's name and the website's address. */ signoff?: { brandName?: string; domain?: string } | null }, by: string, applyToPlan: () => void): CopyBatch {
    if (!POST_ID.test(postId)) throw new CopyStageError('INVALID', 'that is not a post id');
    if (by.trim() === '') throw new CopyStageError('INVALID', 'who is editing must be given');
    return this.change(planFile, (batch) => {
      if (!batch) throw new CopyStageError('NOT_FOUND', 'no copy batch for that plan');
      if (batch.closedAt) throw new CopyStageError('CLOSED', 'this batch was put away, so its words are final');
      const post = batch.posts.find((p) => p.postId === postId);
      if (!post) throw new CopyStageError('NOT_FOUND', 'no such post in this batch');
      if (postLocked(batch, post)) throw new CopyStageError('ALREADY_DRAWN', 'this post was already sent to be drawn, so its words are final');
      applyToPlan();
      post.headline = words.headline;
      post.caption = words.caption;
      if (words.network && words.networkCaption !== undefined && post.captions?.[words.network]) post.captions[words.network] = { text: words.networkCaption, edited: true };
      post.contentHash = copyHash(words.headline, words.caption, textsOf(post.captions));
      if (words.signoff === null) delete post.signoff;
      else if (words.signoff !== undefined) post.signoff = words.signoff;
      post.edited = true;
      delete post.advice;
      return { batch, result: batch };
    });
  }

  /**
   * Adds a network's caption to posts of the batch (a batch that is waiting or already drawn), under the same lock as the list's own write: `applyToPlan` writes the
   * same captions into the plan file first, so the plan and the list can never disagree, and if it throws nothing changes. A post's choice stays as it was, with
   * the hash of its words now including the new caption. A network the batch already has is refused.
   */
  addNetwork(planFile: string, network: string, captionsByPost: Readonly<Record<string, Readonly<Record<string, { text: string; fallback?: boolean }>>>>, applyToPlan: () => void): CopyBatch {
    return this.change(planFile, (batch) => {
      if (!batch) throw new CopyStageError('NOT_FOUND', 'no copy batch for that plan');
      if (batch.closedAt) throw new CopyStageError('CLOSED', 'this batch was put away, so it cannot be changed');
      if (batch.posts.some((p) => p.captions?.[network] !== undefined)) throw new CopyStageError('CONFLICT', 'the batch already has that network');
      applyToPlan();
      for (const post of batch.posts) {
        const added = captionsByPost[post.postId];
        if (!added) continue;
        post.captions = { ...(post.captions ?? {}), ...Object.fromEntries(Object.entries(added).map(([n, c]) => [n, { text: c.text, ...(c.fallback ? { fallback: true } : {}) }])) };
        post.contentHash = copyHash(post.headline, post.caption, textsOf(post.captions));
      }
      return { batch, result: batch };
    });
  }

  /** Puts a whole batch away without drawing it (for example an old batch written before a fix). It is no longer listed. */
  close(planFile: string, by: string): CopyBatch {
    if (by.trim() === '') throw new CopyStageError('INVALID', 'who is closing must be given');
    return this.change(planFile, (batch) => {
      if (!batch) throw new CopyStageError('NOT_FOUND', 'no copy batch for that plan');
      if (batch.drawnAt) throw new CopyStageError('ALREADY_DRAWN', 'this batch was already drawn');
      const closed = { ...batch, closedAt: batch.closedAt ?? this.now().toISOString(), closedBy: batch.closedBy ?? by.trim().slice(0, 80) };
      return { batch: closed, result: closed };
    });
  }
}
