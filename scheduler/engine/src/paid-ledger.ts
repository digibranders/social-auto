/**
 * The paid-call ledger. Every call that can cost money is written down BEFORE it is sent, against five independent caps (one poster, one run,
 * one brand's UTC day, one brand's UTC month, the whole deployment's UTC day), and is never repeated by accident:
 *
 *   reserve   the largest cost the call may have is counted against every cap; a call that would break one is refused before it is sent;
 *   in_flight the call is marked as sent;
 *   completed the answer is stored and the reservation is replaced by the real cost;
 *   failed    the provider answered with an error (nothing was bought, but the attempt still counts against the poster's limit);
 *   unknown   the call may have been accepted but its answer was lost (a crash, a timeout). Its reservation stays counted, and it is never
 *             sent again automatically: the owner decides.
 *
 * The file is an append-only JSON-lines log read whole at each reservation, under a lock file, so two processes cannot both spend the last
 * dollar. It is durable: restarting the engine never forgets what was spent or what was in flight. What this cannot do is make a provider
 * charge exactly once after a lost answer; it can only refuse to ask twice.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { appendDurable, LockError, withFileLock } from './file-lock.ts';

export type PaidOperation = 'text' | 'image' | 'vision';
export type PaidStatus = 'reserved' | 'in_flight' | 'completed' | 'failed' | 'unknown';

export interface BudgetLimits {
  /** Posters one job may ask for. */
  maxPostersPerJob: number;
  perPosterUsd: number;
  perRunUsd: number;
  perBrandDayUsd: number;
  /** What one brand may spend in a UTC calendar month. A client can be given its own figure (clients.json `spendCapUsd`); this one holds for every other client. */
  perBrandMonthUsd: number;
  globalDayUsd: number;
  /** Picture purchases (attempts, including failed ones) per poster. There is no automatic regeneration. */
  maxImagesPerPoster: number;
  /** Pictures one brand may buy in a UTC calendar month: pictures bought (an attempt the provider failed is not counted), never topics. Never above MAX_PICTURES_PER_BRAND_MONTH_CEILING. */
  maxPicturesPerBrandMonth: number;
  /** What a picture may cost, counted when it is reserved. */
  imageReserveUsd: number;
}

/** The most pictures a brand may ever buy in a month, whatever a setting says: the settings can lower the limit but cannot raise it past this. */
export const MAX_PICTURES_PER_BRAND_MONTH_CEILING = 200;

/** Starting caps for the owner-operated V1 (provisional: to be checked against real bills). Calls made for one poster count towards its cap; site-wide calls count only towards the run, brand-day and deployment caps. */
export const defaultBudgetLimits: BudgetLimits = {
  maxPostersPerJob: 4,
  perPosterUsd: 0.14,
  perRunUsd: 0.6,
  perBrandDayUsd: 1.2,
  // About 25 posters a month cost $1 to $2 in all; this leaves room for redraws and the website reading, and stops a runaway.
  perBrandMonthUsd: 8,
  globalDayUsd: 2.0,
  // One picture, and one more only when the first was rejected for a defect a new instruction can fix (see ai-creative-pipeline.ts).
  maxImagesPerPoster: 2,
  // Each network of a topic gets its own picture, so this counts pictures (the owner's limit for a customer is 40 a month).
  maxPicturesPerBrandMonth: 40,
  // An upper bound near the published price of a medium picture, not the usual bill (about $0.03): the reservation must never be lower than what the call may cost.
  imageReserveUsd: 0.05,
};

export type BudgetRefusal = 'POSTER_BUDGET' | 'RUN_BUDGET' | 'BRAND_DAY_BUDGET' | 'BRAND_MONTH_BUDGET' | 'BRAND_MONTH_PICTURES' | 'GLOBAL_DAY_BUDGET' | 'IMAGE_LIMIT' | 'REPLAY_BLOCKED' | 'KILL_SWITCH';

export class BudgetError extends Error {
  readonly code: BudgetRefusal;
  constructor(code: BudgetRefusal, message: string) {
    super(message);
    this.name = 'BudgetError';
    this.code = code;
  }
}

export interface PaidCall {
  callId: string;
  jobId: string;
  tenantId: string;
  brandId: string;
  postId?: string;
  operation: PaidOperation;
  model: string;
  requestHash: string;
  status: PaidStatus;
  reservedCostUsd: number;
  actualCostUsd?: number;
  providerRequestId?: string;
  inputTokens?: number;
  outputTokens?: number;
  outputPath?: string;
  note?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

type Event = { type: 'reserve'; call: PaidCall } | { type: 'update'; callId: string; patch: Partial<PaidCall> };

export interface LedgerContext {
  jobId: string;
  tenantId: string;
  brandId: string;
  now?: () => Date;
  /** How long a change waits for another live process's lock before it fails (tests shorten it). */
  lockTimeoutMs?: number;
}

export interface ReserveRequest {
  operation: PaidOperation;
  model: string;
  postId?: string;
  /** What the call would send, so the same request is recognised again. */
  requestKey: string;
  /** The most the call may cost. */
  maxCostUsd: number;
}

const roundUsd = (value: number): number => Math.round(value * 1e8) / 1e8;
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const dayOf = (iso: string): string => iso.slice(0, 10);

/** What a call counts for against a cap: its real cost when it ended, otherwise everything it might still cost. */
function chargeOf(call: PaidCall): number {
  if (call.status === 'completed') return call.actualCostUsd ?? call.reservedCostUsd;
  if (call.status === 'failed') return call.actualCostUsd ?? 0;
  return call.reservedCostUsd;
}

/** Runs `work` while holding the ledger's lock (see file-lock.ts). A lock that cannot be had stops the caller, so nothing is spent. */
export function withLock<T>(lockPath: string, work: () => T, timeoutMs?: number): T {
  try {
    return withFileLock(lockPath, work, timeoutMs === undefined ? {} : { timeoutMs });
  } catch (error) {
    if (error instanceof LockError) throw new BudgetError('KILL_SWITCH', `the paid-call ledger is locked (${error.message}), so nothing is spent`);
    throw error;
  }
}

export class PaidLedger {
  readonly file: string;
  readonly limits: BudgetLimits;
  private readonly context: LedgerContext;
  private readonly lockPath: string;

  constructor(file: string, limits: BudgetLimits, context: LedgerContext) {
    this.file = file;
    this.limits = limits;
    this.context = context;
    mkdirSync(dirname(file), { recursive: true });
    this.lockPath = `${file}.lock`;
    this.markInterruptedUnknown();
  }

  private picturesOff = false;

  /** No picture may be bought for the rest of this ledger's life (a site whose identity could not be confirmed). Everything else goes on. */
  disablePictures(): void {
    this.picturesOff = true;
  }

  private locked<T>(work: () => T): T {
    return withLock(this.lockPath, work, this.context.lockTimeoutMs);
  }

  private now(): Date {
    return this.context.now?.() ?? new Date();
  }

  private load(): Map<string, PaidCall> {
    const calls = new Map<string, PaidCall>();
    let text = '';
    try {
      text = readFileSync(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new BudgetError('KILL_SWITCH', `the paid-call ledger ${this.file} could not be read (${(error as Error).message}), so nothing is spent`);
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      let event: Event;
      try {
        event = JSON.parse(line) as Event;
      } catch {
        // A damaged record in the middle of the log means what was spent can no longer be trusted: nothing is spent until a person looks at the file.
        throw new BudgetError('KILL_SWITCH', `the paid-call ledger ${this.file} has a damaged record, so nothing is spent until it is checked`);
      }
      if (event.type === 'reserve') calls.set(event.call.callId, event.call);
      else {
        const found = calls.get(event.callId);
        if (found) calls.set(event.callId, { ...found, ...event.patch });
      }
    }
    return calls;
  }

  private append(event: Event): void {
    try {
      appendDurable(this.file, JSON.stringify(event));
    } catch (error) {
      throw new BudgetError('KILL_SWITCH', `the paid-call ledger could not be written (${error instanceof Error ? error.message : String(error)}), so nothing is spent`);
    }
  }

  /** A process that died in the middle of a write leaves a last line with no newline. It is moved aside (a half-written reservation was never sent; a half-written result leaves its call in flight, which becomes unknown), so the next record never glues to it. */
  private repairTornTail(): void {
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new BudgetError('KILL_SWITCH', `the paid-call ledger ${this.file} could not be read (${(error as Error).message}), so nothing is spent`);
    }
    if (text === '' || text.endsWith('\n')) return;
    const cut = text.lastIndexOf('\n') + 1;
    appendFileSync(`${this.file}.torn`, `${text.slice(cut)}\n`);
    writeFileSync(this.file, text.slice(0, cut));
  }

  /** A call left reserved or in flight by a process that is gone may have been accepted: it becomes "unknown", keeps its reservation, and is never replayed. */
  private markInterruptedUnknown(): void {
    this.locked(() => {
      this.repairTornTail();
      for (const call of this.load().values()) {
        if (call.status === 'reserved' || call.status === 'in_flight') this.append({ type: 'update', callId: call.callId, patch: { status: 'unknown', note: 'the process ended before the answer was stored' } });
      }
    });
  }

  /**
   * Refuses, before anything is bought, a draw that needs more pictures than the brand has left this month, so a batch is never half drawn because the
   * limit ran out part-way. `needed` is the least number of pictures the draw buys (one per picture asked for; a retry may use more).
   */
  assertPicturesFit(needed: number): void {
    const limit = Math.min(this.limits.maxPicturesPerBrandMonth, MAX_PICTURES_PER_BRAND_MONTH_CEILING);
    const used = this.spend().brandMonthPictures;
    if (used + needed > limit) throw new BudgetError('BRAND_MONTH_PICTURES', `this draw needs ${needed} picture${needed === 1 ? '' : 's'} and this brand has bought ${used} of its ${limit} for this month`);
  }

  /** The calls so far, as the log folds them. */
  calls(): PaidCall[] {
    return [...this.load().values()];
  }

  /** What each cap has used and may still give, as of now. */
  spend(postId?: string): { poster: number; run: number; brandDay: number; brandMonth: number; brandMonthPictures: number; globalDay: number } {
    const today = dayOf(this.now().toISOString());
    return summarize(this.load(), this.context, today, postId);
  }

  /** Counts the call against every cap and writes it down, or refuses before anything is sent. */
  reserve(request: ReserveRequest): string {
    const { limits, context } = this;
    const requestHash = sha256(`${request.operation}|${request.model}|${request.requestKey}`);
    return this.locked(() => {
      const calls = this.load();
      const createdAt = this.now().toISOString();
      const used = summarize(calls, context, dayOf(createdAt), request.postId);
      const cost = roundUsd(request.maxCostUsd);
      const same = [...calls.values()].find((c) => c.jobId === context.jobId && c.requestHash === requestHash && c.status !== 'failed');
      if (same) throw new BudgetError('REPLAY_BLOCKED', `this exact ${request.operation} request was already made in this job (${same.status}, call ${same.callId}); it is not sent again automatically`);
      if (request.operation === 'image' && this.picturesOff) throw new BudgetError('IMAGE_LIMIT', 'no picture is bought for this site: its identity could not be confirmed');
      if (request.operation === 'image') {
        const attempts = [...calls.values()].filter((c) => c.jobId === context.jobId && c.operation === 'image' && c.postId === request.postId).length;
        if (attempts >= limits.maxImagesPerPoster) throw new BudgetError('IMAGE_LIMIT', `this poster has already used its ${limits.maxImagesPerPoster} picture purchase${limits.maxImagesPerPoster === 1 ? '' : 's'}; pictures are never regenerated automatically`);
      }
      if (request.operation === 'image' && used.brandMonthPictures + 1 > Math.min(limits.maxPicturesPerBrandMonth, MAX_PICTURES_PER_BRAND_MONTH_CEILING)) throw new BudgetError('BRAND_MONTH_PICTURES', `this brand has already bought ${used.brandMonthPictures} pictures this month, as many as its limit of ${Math.min(limits.maxPicturesPerBrandMonth, MAX_PICTURES_PER_BRAND_MONTH_CEILING)} allows`);
      if (request.postId !== undefined && used.poster + cost > limits.perPosterUsd + 1e-9) throw new BudgetError('POSTER_BUDGET', `this poster would spend $${(used.poster + cost).toFixed(4)}, over its $${limits.perPosterUsd.toFixed(3)} limit`);
      if (used.run + cost > limits.perRunUsd + 1e-9) throw new BudgetError('RUN_BUDGET', `this run would spend $${(used.run + cost).toFixed(4)}, over its $${limits.perRunUsd.toFixed(3)} limit`);
      if (used.brandDay + cost > limits.perBrandDayUsd + 1e-9) throw new BudgetError('BRAND_DAY_BUDGET', `this brand would spend $${(used.brandDay + cost).toFixed(4)} today, over its $${limits.perBrandDayUsd.toFixed(2)} daily limit`);
      if (used.brandMonth + cost > limits.perBrandMonthUsd + 1e-9) throw new BudgetError('BRAND_MONTH_BUDGET', `this brand would spend $${(used.brandMonth + cost).toFixed(4)} this month, over its $${limits.perBrandMonthUsd.toFixed(2)} monthly limit`);
      if (used.globalDay + cost > limits.globalDayUsd + 1e-9) throw new BudgetError('GLOBAL_DAY_BUDGET', `the deployment would spend $${(used.globalDay + cost).toFixed(4)} today, over its $${limits.globalDayUsd.toFixed(2)} daily limit`);
      const call: PaidCall = {
        callId: randomUUID(), jobId: context.jobId, tenantId: context.tenantId, brandId: context.brandId,
        ...(request.postId !== undefined ? { postId: request.postId } : {}),
        operation: request.operation, model: request.model, requestHash, status: 'reserved', reservedCostUsd: cost, createdAt,
      };
      this.append({ type: 'reserve', call });
      return call.callId;
    });
  }

  private update(callId: string, patch: Partial<PaidCall>): void {
    this.locked(() => this.append({ type: 'update', callId, patch }));
  }

  /** Call just before the request leaves. */
  markInFlight(callId: string): void {
    this.update(callId, { status: 'in_flight', startedAt: this.now().toISOString() });
  }

  /** The answer is stored: the reservation becomes the real cost (or stays the reservation when the price is not known). */
  complete(callId: string, result: { actualCostUsd: number | null; inputTokens?: number; outputTokens?: number; providerRequestId?: string; outputPath?: string }): void {
    this.update(callId, {
      status: 'completed',
      ...(result.actualCostUsd !== null && result.actualCostUsd > this.reservedOf(callId) + 1e-9 ? { note: 'the real cost was higher than the reservation' } : {}),
      completedAt: this.now().toISOString(),
      ...(result.actualCostUsd !== null ? { actualCostUsd: roundUsd(result.actualCostUsd) } : {}),
      ...(result.inputTokens !== undefined ? { inputTokens: result.inputTokens } : {}),
      ...(result.outputTokens !== undefined ? { outputTokens: result.outputTokens } : {}),
      ...(result.providerRequestId !== undefined ? { providerRequestId: result.providerRequestId } : {}),
      ...(result.outputPath !== undefined ? { outputPath: result.outputPath } : {}),
    });
  }

  private reservedOf(callId: string): number {
    return this.load().get(callId)?.reservedCostUsd ?? 0;
  }

  /** The provider answered with an error: nothing was bought. */
  fail(callId: string, note: string): void {
    this.update(callId, { status: 'failed', actualCostUsd: 0, completedAt: this.now().toISOString(), note: note.slice(0, 300) });
  }

  /** The call left but no answer was seen (a timeout, a dropped connection): it may have been accepted, so it keeps its reservation and is never replayed. */
  markUnknown(callId: string, note: string): void {
    this.update(callId, { status: 'unknown', note: note.slice(0, 300) });
  }
}

function summarize(calls: Map<string, PaidCall>, context: LedgerContext, today: string, postId?: string): { poster: number; run: number; brandDay: number; brandMonth: number; brandMonthPictures: number; globalDay: number } {
  let poster = 0;
  let run = 0;
  let brandDay = 0;
  let brandMonth = 0;
  let brandMonthPictures = 0;
  let globalDay = 0;
  for (const call of calls.values()) {
    const charge = chargeOf(call);
    if (call.jobId === context.jobId) {
      run += charge;
      if (postId !== undefined && call.postId === postId) poster += charge;
    }
    if (dayOf(call.createdAt) === today) {
      globalDay += charge;
      if (call.brandId === context.brandId) brandDay += charge;
    }
    if (call.brandId === context.brandId && call.createdAt.slice(0, 7) === today.slice(0, 7)) {
      brandMonth += charge;
      if (call.operation === 'image' && call.status !== 'failed') brandMonthPictures += 1;
    }
  }
  return { poster: roundUsd(poster), run: roundUsd(run), brandDay: roundUsd(brandDay), brandMonth: roundUsd(brandMonth), brandMonthPictures, globalDay: roundUsd(globalDay) };
}

function readPictureLimit(raw: string | undefined): number {
  if (raw === undefined || raw === '') return defaultBudgetLimits.maxPicturesPerBrandMonth;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new BudgetError('KILL_SWITCH', 'BUDGET_BRAND_MONTH_PICTURES must be a whole number of at least 1');
  if (value > MAX_PICTURES_PER_BRAND_MONTH_CEILING) throw new BudgetError('KILL_SWITCH', `BUDGET_BRAND_MONTH_PICTURES cannot be more than ${MAX_PICTURES_PER_BRAND_MONTH_CEILING}`);
  return value;
}

/** Limits from settings (BUDGET_* variables), each falling back to the defaults. A value that is not a positive number is an error, never ignored. */
export function budgetLimitsFromEnv(env: Record<string, string | undefined>): BudgetLimits {
  const read = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) throw new BudgetError('KILL_SWITCH', `${name} must be a positive number`);
    return value;
  };
  return {
    maxPostersPerJob: Math.floor(read('BUDGET_MAX_POSTERS_PER_JOB', defaultBudgetLimits.maxPostersPerJob)),
    perPosterUsd: read('BUDGET_POSTER_USD', defaultBudgetLimits.perPosterUsd),
    perRunUsd: read('BUDGET_RUN_USD', defaultBudgetLimits.perRunUsd),
    perBrandDayUsd: read('BUDGET_BRAND_DAY_USD', defaultBudgetLimits.perBrandDayUsd),
    perBrandMonthUsd: read('BUDGET_BRAND_MONTH_USD', defaultBudgetLimits.perBrandMonthUsd),
    globalDayUsd: read('BUDGET_GLOBAL_DAY_USD', defaultBudgetLimits.globalDayUsd),
    maxImagesPerPoster: Math.floor(read('BUDGET_IMAGES_PER_POSTER', defaultBudgetLimits.maxImagesPerPoster)),
    maxPicturesPerBrandMonth: readPictureLimit(env['BUDGET_BRAND_MONTH_PICTURES']),
    imageReserveUsd: read('BUDGET_IMAGE_RESERVE_USD', defaultBudgetLimits.imageReserveUsd),
  };
}
