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

export type CopyState = 'pending' | 'kept' | 'dropped';

export class CopyStageError extends Error {
  readonly code: 'NOT_FOUND' | 'INVALID' | 'ALREADY_DRAWN' | 'CLOSED' | 'REJECTED' | 'LOCKED';
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
  /** True once the owner has changed the writer's words. */
  edited?: boolean;
  /** A note for the owner, such as "weak headline: it tells the reader nothing specific". Advice only: the owner can still keep the post. */
  advice?: string;
  state: CopyState;
  decidedBy?: string;
  decidedAt?: string;
}

export interface CopyBatch {
  brand: string;
  planFile: string;
  createdAt: string;
  posts: CopyPost[];
  /** Set when the kept posts have been sent to be drawn: from then on the choices are final. */
  drawnAt?: string;
  /** Set when the owner put the whole batch away without drawing it: it is no longer listed and its posts cannot be drawn. */
  closedAt?: string;
  closedBy?: string;
}

export const PLAN_FILE = /^week-\d{2,4}\.json$/;
const POST_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/;

export const copyHash = (headline: string, caption: string): string => createHash('sha256').update(JSON.stringify({ headline, caption })).digest('hex');

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
  open(planFile: string, posts: ReadonlyArray<{ postId: string; headline: string; caption: string; advice?: string }>): CopyBatch {
    return this.change(planFile, (existing) => {
      if (existing) return { batch: existing, result: existing };
      const batch: CopyBatch = {
        brand: this.brand,
        planFile,
        createdAt: this.now().toISOString(),
        posts: posts.map((p) => ({ postId: p.postId, headline: p.headline, caption: p.caption, contentHash: copyHash(p.headline, p.caption), ...(p.advice ? { advice: p.advice.slice(0, 300) } : {}), state: 'pending' })),
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
      if (batch.drawnAt) throw new CopyStageError('ALREADY_DRAWN', 'this batch was already sent to be drawn, so its choices are final');
      if (batch.closedAt) throw new CopyStageError('CLOSED', 'this batch was put away, so its choices are final');
      const post = batch.posts.find((p) => p.postId === postId);
      if (!post) throw new CopyStageError('NOT_FOUND', 'no such post in this batch');
      post.state = state;
      post.decidedBy = by.trim().slice(0, 80);
      post.decidedAt = this.now().toISOString();
      return { batch, result: batch };
    });
  }

  /**
   * The posts to draw: kept, and still exactly the words that were kept. `current` is the plan as it is now; a post whose words changed
   * since the choice is left out and named in `changed`.
   */
  toDraw(planFile: string, current: ReadonlyArray<{ postId: string; headline: string; caption: string }>): { postIds: string[]; changed: string[] } {
    const batch = this.read(planFile);
    const postIds: string[] = [];
    const changed: string[] = [];
    for (const post of batch.posts.filter((p) => p.state === 'kept')) {
      const now = current.find((c) => c.postId === post.postId);
      if (now && copyHash(now.headline, now.caption) === post.contentHash) postIds.push(post.postId);
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
   * Replaces the words of one post before it is drawn. `applyToPlan` writes the same words into the plan file and runs inside the lock, ahead of this file's own
   * write, so the plan and the list can never disagree; if it throws, nothing changes. The post keeps its choice: a kept post stays kept, with the new words.
   */
  edit(planFile: string, postId: string, words: { headline: string; caption: string }, by: string, applyToPlan: () => void): CopyBatch {
    if (!POST_ID.test(postId)) throw new CopyStageError('INVALID', 'that is not a post id');
    if (by.trim() === '') throw new CopyStageError('INVALID', 'who is editing must be given');
    return this.change(planFile, (batch) => {
      if (!batch) throw new CopyStageError('NOT_FOUND', 'no copy batch for that plan');
      if (batch.drawnAt) throw new CopyStageError('ALREADY_DRAWN', 'this batch was already sent to be drawn, so its words are final');
      if (batch.closedAt) throw new CopyStageError('CLOSED', 'this batch was put away, so its words are final');
      const post = batch.posts.find((p) => p.postId === postId);
      if (!post) throw new CopyStageError('NOT_FOUND', 'no such post in this batch');
      applyToPlan();
      post.headline = words.headline;
      post.caption = words.caption;
      post.contentHash = copyHash(words.headline, words.caption);
      post.edited = true;
      delete post.advice;
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
