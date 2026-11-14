/**
 * The product API's way into the content engine (its review service, listening on this machine only).
 *
 * The engine knows each product by its own secret and acts only for the one brand named in X-Brand, as the person named in X-Actor. The same separation is
 * made here too, so nothing else may talk to the engine for a product:
 *   - a WorkspaceEngine is made for ONE product and ONE brand (the customer's workspace); both are fixed when it is made and no method takes a brand;
 *   - every path is built here from fixed pieces and validated ids, never from what a product sent;
 *   - everything the engine answers is checked to belong to that brand again before it is passed on, and only a short list of safe fields is kept;
 *   - the engine's own error words never leave: an error says only what a product may act on.
 * The secret is only ever sent as a header; it is not in any address or error.
 */
import type { ErrorCode } from './api-error.js';

export interface EngineConfig {
  url: string;
  /** Each product's own secret with the engine, by product id. */
  productSecrets: Readonly<Record<string, string>>;
  /** How long one call may take; 25 seconds when left out. */
  timeoutMs?: number;
  /** For tests. */
  fetch?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 25_000;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const VERSION_ID = /^[a-z0-9][a-z0-9-]{0,62}\.[a-f0-9]{16}$/;
const FACT_ID = /^[a-f0-9]{12}$/;
const PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BRAND = /^[a-z0-9][a-z0-9-]{0,62}$/;
const CAROUSEL_ID = /^[A-Za-z0-9._-]{1,80}$/;
const JOB_ID = /^job-[a-z0-9]{4,12}-[a-f0-9]{8}$/;

const PRODUCT_ID = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * The engine's address and each product's secret from the environment (REVIEW_URL, and REVIEW_PRODUCT_SECRETS as "brandbasket:<secret>,other:<secret>", each
 * secret at least 16 characters), or null when it is not set up. The staff secret is never used here.
 */
export function engineFromEnv(env: Record<string, string | undefined> = process.env): EngineConfig | null {
  const url = env['REVIEW_URL'];
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  } catch {
    return null;
  }
  const productSecrets: Record<string, string> = {};
  for (const entry of (env['REVIEW_PRODUCT_SECRETS'] ?? '').split(',').map((e) => e.trim()).filter((e) => e !== '')) {
    const at = entry.indexOf(':');
    const id = entry.slice(0, at);
    const secret = entry.slice(at + 1);
    if (at < 1 || !PRODUCT_ID.test(id) || secret.length < 16) return null;
    productSecrets[id] = secret;
  }
  if (Object.keys(productSecrets).length === 0) return null;
  return { url: url.replace(/\/+$/, ''), productSecrets };
}

/** What went wrong, in words that are safe to show a product. `reason` names the few refusals a product can act on. */
export class EngineError extends Error {
  readonly status: number;
  readonly reason: string | undefined;
  /** The engine's own stable code (HELD, ALREADY_DRAWN, ...), used only to choose the product API's code; never shown. */
  readonly engineCode: string | undefined;
  /** For a channel that has used its pictures for the week: which channel and the day (YYYY-MM-DD) it starts again. */
  readonly pictureLimit: { channel: string; restart: string } | undefined;
  /** For a customer who has made her carousel for the week: the day (YYYY-MM-DD) she can make another. */
  readonly restart: string | undefined;
  /** For a topic text that cannot be used: why, as a fixed code (TOO_SHORT, TOO_LONG, LINK_NOT_ALLOWED, NEEDS_PROOF, NOT_TEXT). */
  readonly textReason: string | undefined;
  constructor(status: number, message: string, reason?: string, engineCode?: string, pictureLimit?: { channel: string; restart: string }, restart?: string, textReason?: string) {
    super(message);
    this.name = 'EngineError';
    this.status = status;
    this.reason = reason;
    this.engineCode = engineCode;
    this.pictureLimit = pictureLimit;
    this.restart = restart;
    this.textReason = textReason;
  }

  /** The code the product API answers with. */
  get code(): ErrorCode {
    switch (this.status) {
      case 429:
        return this.engineCode === 'CAROUSEL_LIMIT_REACHED' ? 'CAROUSEL_LIMIT_REACHED' : this.engineCode === 'TOPIC_LIMIT_REACHED' ? 'TOPIC_LIMIT_REACHED' : this.engineCode === 'REPLACE_LIMIT_REACHED' ? 'REPLACE_LIMIT_REACHED' : 'PICTURE_LIMIT_REACHED';
      case 404:
        return 'NOT_FOUND';
      case 400:
        if (this.textReason === 'LINK_NOT_ALLOWED') return 'LINK_NOT_ALLOWED';
        if (this.engineCode === 'DAY_PASSED') return 'DAY_PASSED';
        if (this.engineCode === 'OUTSIDE_WEEK') return 'INVALID_DAY';
        return this.textReason !== undefined ? 'TEXT_REFUSED' : 'INVALID_REQUEST';
      case 422:
        return this.engineCode === 'NOTHING_KEPT' ? 'NOTHING_KEPT' : 'WORDS_NOT_ACCEPTED';
      case 403:
        return 'CONFLICT';
      case 409:
        if (this.engineCode === 'DAY_PASSED') return 'DAY_PASSED';
        if (this.engineCode === 'HELD') return 'FACT_HELD';
        if (this.engineCode === 'ALREADY_DRAWN' || this.engineCode === 'CLOSED') return 'BATCH_LOCKED';
        if (this.engineCode === 'LIMIT') return 'REDRAW_LIMIT_REACHED';
        if (this.engineCode === 'STALE') return 'POSTER_SUPERSEDED';
        if (this.engineCode === 'BLOCKED') return 'POSTER_BLOCKED';
        if (this.engineCode === 'ALREADY_DECIDED') return 'POSTER_ALREADY_DECIDED';
        return 'CONFLICT';
      default:
        return 'ENGINE_UNAVAILABLE';
    }
  }
}

/** What a product is told about a refusal, by the engine's code and never by the engine's own words. */
function refusalMessage(status: number, engineCode: string | undefined): string {
  if (engineCode === 'NOTHING_KEPT') return 'keep at least one post before asking for pictures';
  if (engineCode === 'DAY_PASSED') return 'that day is today or has passed';
  if (engineCode === 'OUTSIDE_WEEK') return 'a post can only move to another day of its own week';
  if (engineCode === 'LIMIT') return 'this picture was already drawn again as often as is allowed';
  if (engineCode === 'STALE') return 'a newer picture replaced this one';
  if (engineCode === 'BLOCKED') return 'this picture did not pass the checks, so it cannot be approved';
  if (engineCode === 'ALREADY_DECIDED') return 'this picture was already decided differently';
  if (status === 422) return 'these words were not accepted: they must agree with the facts found on the website, and fit the network';
  if (engineCode === 'HELD') return 'this fact is held back, so it cannot be confirmed';
  if (engineCode === 'ALREADY_DRAWN' || engineCode === 'CLOSED') return 'this batch is final: its pictures were already asked for, or it was put away';
  return 'the request was not accepted';
}

/** Why a topic text cannot be used, in our own words (the engine's sentence is never passed on). */
const TEXT_REASONS: Record<string, string> = {
  NOT_TEXT: 'Write what the post is about.',
  TOO_SHORT: 'Write a little more: what is it, and when or for how long.',
  TOO_LONG: 'Keep it under 1000 characters.',
  LINK_NOT_ALLOWED: 'Links are not read in this box. Write the details in words.',
  NEEDS_PROOF: 'The text has a claim that needs proof, such as a guarantee, a "best", a certificate or a result. Say it in plain words instead.',
};

const unavailable = (): EngineError => new EngineError(503, 'the poster service is not available just now. Try again shortly.');

/** A job as a product sees it: no secrets, no paths, no log lines, no name of who asked. */
export interface JobView {
  id: string;
  /** `write`: a batch of written posts; `draw`: pictures (a first draw, a redraw, or the picture of a newly added network); `network`: the words for a network added later. */
  kind: 'write' | 'draw' | 'network' | 'carousel' | 'topic' | 'replace';
  /** The written batch a draw or an added network is for. */
  batchId?: string;
  /** For a `replace` job: the dropped post a new topic is being written for. */
  postId?: string;
  /** For a draw of one week of a batch: the Monday of that week (YYYY-MM-DD). */
  week?: string;
  /** True for a draw the system started by itself (the weekly draw); it is not one of the customer's own asks. */
  auto?: boolean;
  state: 'queued' | 'running' | 'done' | 'failed';
  step?: number;
  /** For a failed job: a fixed code (for example NOTHING_WRITTEN), never the engine's own words. */
  failure?: string;
  /** For a finished `network` job: what happened to each topic. */
  result?: { network: string; topics: Array<{ postId: string; outcome: 'written' | 'skipped'; /** The words are the main caption adapted, because the network's own words could not be written. */ fallback?: true; reasonCode?: string; posterIds?: string[]; /** The picture of this topic is being drawn (a job of kind draw), because no picture of its shape existed. */ drawJobId?: string }> };
  createdAt: string;
  finishedAt?: string;
}

const JOB_KIND: Record<string, JobView['kind']> = { copy: 'write', draw: 'draw', redraw: 'draw', newnet: 'draw', network: 'network', carousel: 'carousel', topic: 'topic', replace: 'replace' };
const CODE = /^[A-Z][A-Z_]{1,40}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A time of day, HH:MM (24 hour). */
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

const STATE: Record<string, JobView['state']> = { queued: 'queued', running: 'running', succeeded: 'done', failed: 'failed' };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The safe view of a job the engine sent, or null when it is not a well formed job. */
function jobView(raw: unknown): { view: JobView; brand: string } | null {
  if (!isObject(raw)) return null;
  const { id, kind, state, brand, createdAt, step, finishedAt } = raw;
  if (typeof id !== 'string' || !JOB_ID.test(id) || typeof brand !== 'string' || typeof createdAt !== 'string') return null;
  if (typeof kind !== 'string' || JOB_KIND[kind] === undefined || typeof state !== 'string' || STATE[state] === undefined) return null;
  const view: JobView = { id, kind: JOB_KIND[kind] as JobView['kind'], state: STATE[state] as JobView['state'], createdAt };
  if (typeof step === 'number' && Number.isInteger(step) && step >= 1 && step <= 4) view.step = step;
  if (typeof finishedAt === 'string') view.finishedAt = finishedAt;
  if ((JOB_KIND[kind] === 'draw' || JOB_KIND[kind] === 'network' || JOB_KIND[kind] === 'replace') && typeof raw['planFile'] === 'string' && PART.test(raw['planFile'])) view.batchId = raw['planFile'];
  if (JOB_KIND[kind] === 'draw' && typeof raw['week'] === 'string' && DAY.test(raw['week'])) view.week = raw['week'];
  if (JOB_KIND[kind] === 'replace' && typeof raw['postId'] === 'string' && PART.test(raw['postId'])) view.postId = raw['postId'];
  if (raw['auto'] === true) view.auto = true;
  const error = raw['error'];
  if (view.state === 'failed' && isObject(error) && typeof error['code'] === 'string' && CODE.test(error['code'])) view.failure = error['code'];
  const result = raw['result'];
  if (view.kind === 'network' && view.state === 'done' && isObject(result) && typeof result['network'] === 'string' && Array.isArray(result['topics'])) {
    const topics = result['topics'].flatMap((t): NonNullable<JobView['result']>['topics'] => {
      if (!isObject(t) || typeof t['postId'] !== 'string' || !PART.test(t['postId']) || (t['outcome'] !== 'written' && t['outcome'] !== 'skipped')) return [];
      const ids = (Array.isArray(t['versionIds']) ? t['versionIds'] : []).filter((v): v is string => typeof v === 'string' && VERSION_ID.test(v) && v.startsWith(`${brand}.`));
      return [{ postId: t['postId'], outcome: t['outcome'], ...(t['fallback'] === true ? { fallback: true as const } : {}), ...(typeof t['reasonCode'] === 'string' && CODE.test(t['reasonCode']) ? { reasonCode: t['reasonCode'] } : {}), ...(ids.length > 0 ? { posterIds: ids } : {}), ...(typeof t['drawJobId'] === 'string' && JOB_ID.test(t['drawJobId']) ? { drawJobId: t['drawJobId'] } : {}) }];
    });
    view.result = { network: result['network'].slice(0, 20), topics };
  }
  return { view, brand };
}

export interface FactView {
  id: string;
  text: string;
  sourceUrl: string;
  sourceQuote: string;
  state: string;
  held: boolean;
}

export interface FactsView {
  builtAt: string;
  profile: { name?: string; website?: string; tone?: string; audience?: string; offer?: string };
  facts: FactView[];
  counts: { suggested: number; confirmed: number; removed: number; held: number };
}

export type NetworkCaption = { text: string; edited?: boolean; fallback?: boolean };

export interface WrittenPostView {
  id: string;
  /** The day the post goes out (YYYY-MM-DD, India time), when the batch records it, and its time (HH:MM, India time) when the plan says. */
  date?: string;
  time?: string;
  /** Set when the post was kept but got no picture in its week's draw. */
  notDrawn?: { code: NotDrawnCode; message: string };
  headline: string;
  caption: string;
  captions: Record<string, NetworkCaption>;
  state: string;
  edited?: boolean;
  signoff?: { brandName?: string; domain?: string };
  advice?: string;
  /** Whether the post was sent to be drawn (its pictures are made or being made), and whether its choice, words and day are final. */
  drawn?: boolean;
  locked?: boolean;
  /** On a post written to take a dropped one's place: that post's id; on a dropped post that was given a new topic: the new post's id. */
  replaces?: string;
  replacedBy?: string;
}

/** One week of a batch written for several weeks: its first and last day, and whether its pictures wait, are being drawn, are drawn, or were given up. */
export interface BatchWeekView {
  from: string;
  to: string;
  state: 'waiting' | 'drawing' | 'partly_drawn' | 'drawn' | 'not_drawn' | 'lapsed' | 'empty';
  postIds: string[];
  /** The posts of the week that are still open: not sent to be drawn, and their day is tomorrow or later. They can still be kept, dropped, edited, moved or replaced. */
  openPostIds?: string[];
  /** Days of this week the plan was asked to write a post for and has none (a week with none at all is `empty`). */
  missingDays?: string[];
  /** Kept topics of the week that got no picture: why, in a fixed code and plain words (`message`). They stay open to change or drop; a retry of the week draws only them. */
  notDrawn?: Array<{ postId: string; code: NotDrawnCode; message: string }>;
  /** How many dropped topics of this week may still be given a new one. */
  replacementsLeft?: number;
}

export type NotDrawnCode = 'HEADLINE_TOO_WEAK' | 'NO_PICTURE' | 'PICTURE_LIMIT_REACHED' | 'FACT_OUT_OF_DATE';
const NOT_DRAWN_CODES: readonly string[] = ['HEADLINE_TOO_WEAK', 'NO_PICTURE', 'PICTURE_LIMIT_REACHED', 'FACT_OUT_OF_DATE'];
/** The fixed sentence for each code: the product is told these words, never anything the poster service wrote. */
export const NOT_DRAWN_REASON: Record<NotDrawnCode, string> = {
  HEADLINE_TOO_WEAK: 'This headline is too weak to draw. Change it or drop it.',
  NO_PICTURE: 'No picture passed our checks this time. Try again, or change the words.',
  PICTURE_LIMIT_REACHED: 'There were no pictures left this week for one of the channels. It can be tried again later.',
  FACT_OUT_OF_DATE: 'A fact this post is built on is out of date or was taken out, so no picture was drawn. Drop this topic, or put the fact back.',
};

export interface BatchView {
  id: string;
  createdAt: string;
  networks: string[];
  /** Present for a batch written for several weeks; each week is drawn on its own. */
  weeks?: BatchWeekView[];
  signoffDefault?: { brandName?: string; domain?: string };
  posts: WrittenPostView[];
}

/** The pictures a customer may still draw this week, for each channel. The week runs Monday to Sunday in India time. */
export interface LimitsView {
  week: { from: string; to: string; restart: string };
  limit: number;
  channels: Array<{ network: string; limit: number; used: number; left: number }>;
}

export interface BatchesView {
  batches: BatchView[];
  networkRules: Record<string, { maxCaption: number; recommendedMin: number; recommendedMax: number; visibleChars: number; maxHashtags: number }>;
}

const str = (value: unknown, max = 5000): string | undefined => (typeof value === 'string' ? value.slice(0, max) : undefined);
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

function signoffOf(raw: unknown): { brandName?: string; domain?: string } | undefined {
  if (!isObject(raw)) return undefined;
  const brandName = str(raw['brandName'], 200);
  const domain = str(raw['domain'], 200);
  if (brandName === undefined && domain === undefined) return undefined;
  return { ...(brandName !== undefined ? { brandName } : {}), ...(domain !== undefined ? { domain } : {}) };
}

function factsViewOf(raw: unknown): FactsView {
  if (!isObject(raw) || !Array.isArray(raw['facts'])) throw unavailable();
  const profileRaw = isObject(raw['profile']) ? raw['profile'] : {};
  const profile: FactsView['profile'] = {};
  for (const key of ['name', 'website', 'tone', 'audience', 'offer'] as const) {
    const value = str(profileRaw[key], 500);
    if (value !== undefined) profile[key] = value;
  }
  const facts = raw['facts'].flatMap((f): FactView[] => {
    if (!isObject(f) || typeof f['factId'] !== 'string' || !FACT_ID.test(f['factId'])) return [];
    return [{ id: f['factId'], text: str(f['text']) ?? '', sourceUrl: str(f['sourceUrl'], 2000) ?? '', sourceQuote: str(f['sourceQuote']) ?? '', state: str(f['state'], 20) ?? 'suggested', held: f['held'] === true }];
  });
  const counts = isObject(raw['counts']) ? raw['counts'] : {};
  return { builtAt: str(raw['builtAt'], 40) ?? '', profile, facts, counts: { suggested: num(counts['suggested']), confirmed: num(counts['confirmed']), removed: num(counts['removed']), held: num(counts['held']) } };
}

function batchViewOf(raw: unknown, brand: string): BatchView | null {
  if (!isObject(raw) || raw['brand'] !== brand || typeof raw['planFile'] !== 'string' || !PART.test(raw['planFile']) || !Array.isArray(raw['posts'])) return null;
  const replacedBy = isObject(raw['replacedBy']) ? raw['replacedBy'] : {};
  const posts = raw['posts'].flatMap((p): WrittenPostView[] => {
    if (!isObject(p) || typeof p['postId'] !== 'string' || !PART.test(p['postId'])) return [];
    const captions: Record<string, NetworkCaption> = {};
    if (isObject(p['captions'])) {
      for (const [network, c] of Object.entries(p['captions'])) {
        if (!isObject(c) || typeof c['text'] !== 'string') continue;
        captions[network] = { text: c['text'].slice(0, 3000), ...(c['edited'] === true ? { edited: true } : {}), ...(c['fallback'] === true ? { fallback: true } : {}) };
      }
    }
    const signoff = signoffOf(p['signoff']);
    const advice = str(p['advice'], 300);
    const date = typeof p['date'] === 'string' && DAY.test(p['date']) ? p['date'] : undefined;
    const nd = isObject(p['notDrawn']) && typeof p['notDrawn']['code'] === 'string' && NOT_DRAWN_CODES.includes(p['notDrawn']['code']) ? (p['notDrawn']['code'] as NotDrawnCode) : undefined;
    const time = typeof p['time'] === 'string' && CLOCK.test(p['time']) ? p['time'] : undefined;
    return [{ id: p['postId'], ...(date ? { date } : {}), ...(time ? { time } : {}), ...(nd ? { notDrawn: { code: nd, message: NOT_DRAWN_REASON[nd] } } : {}), headline: str(p['headline'], 300) ?? '', caption: str(p['caption'], 3000) ?? '', captions, state: str(p['state'], 20) ?? 'pending', ...(p['edited'] === true ? { edited: true } : {}), ...(signoff ? { signoff } : {}), ...(advice ? { advice } : {}), ...(typeof p['drawn'] === 'boolean' ? { drawn: p['drawn'] } : {}), ...(typeof p['locked'] === 'boolean' ? { locked: p['locked'] } : {}), ...(typeof p['replaces'] === 'string' && PART.test(p['replaces']) ? { replaces: p['replaces'] } : {}), ...(typeof replacedBy[p['postId']] === 'string' && PART.test(replacedBy[p['postId']] as string) ? { replacedBy: replacedBy[p['postId']] as string } : {}) }];
  });
  // The list names the networks; an answer to a decision does not, so they are read from the captions then.
  const named = Array.isArray(raw['networks']) ? raw['networks'].filter((n): n is string => typeof n === 'string').slice(0, 10) : [];
  const networks = named.length > 0 ? named : [...new Set(posts.flatMap((p) => Object.keys(p.captions)))].sort();
  const signoffDefault = signoffOf(raw['signoffDefault']);
  const left = isObject(raw['replacementsLeft']) ? raw['replacementsLeft'] : {};
  const weeks = Array.isArray(raw['weeks']) ? raw['weeks'].flatMap((w): BatchWeekView[] => {
    if (!isObject(w) || typeof w['from'] !== 'string' || !DAY.test(w['from']) || typeof w['to'] !== 'string' || !DAY.test(w['to']) || !Array.isArray(w['postIds'])) return [];
    const state = w['state'];
    if (state !== 'waiting' && state !== 'drawing' && state !== 'partly_drawn' && state !== 'drawn' && state !== 'not_drawn' && state !== 'lapsed' && state !== 'empty') return [];
    const openPostIds = Array.isArray(w['openPostIds']) ? w['openPostIds'].filter((id): id is string => typeof id === 'string' && PART.test(id)).slice(0, 40) : [];
    const missingDays = Array.isArray(w['missingDays']) ? w['missingDays'].filter((d): d is string => typeof d === 'string' && DAY.test(d)).slice(0, 7) : [];
    const notDrawn = Array.isArray(w['notDrawn']) ? w['notDrawn'].flatMap((n): Array<{ postId: string; code: NotDrawnCode; message: string }> => (isObject(n) && typeof n['postId'] === 'string' && PART.test(n['postId']) && typeof n['code'] === 'string' && NOT_DRAWN_CODES.includes(n['code']) ? [{ postId: n['postId'], code: n['code'] as NotDrawnCode, message: NOT_DRAWN_REASON[n['code'] as NotDrawnCode] }] : [])).slice(0, 40) : [];
    return [{ from: w['from'], to: w['to'], state, postIds: w['postIds'].filter((id): id is string => typeof id === 'string' && PART.test(id)).slice(0, 40), ...(openPostIds.length > 0 ? { openPostIds } : {}), ...(missingDays.length > 0 ? { missingDays } : {}), ...(notDrawn.length > 0 ? { notDrawn } : {}), ...(typeof left[w['from']] === 'number' ? { replacementsLeft: Math.max(0, Math.min(10, Math.trunc(left[w['from']] as number))) } : {}) }];
  }).slice(0, 8) : [];
  return { id: raw['planFile'], createdAt: str(raw['createdAt'], 40) ?? '', networks, ...(weeks.length > 0 ? { weeks } : {}), ...(signoffDefault ? { signoffDefault } : {}), posts };
}

function rulesOf(raw: unknown): BatchesView['networkRules'] {
  const rules: BatchesView['networkRules'] = {};
  if (!isObject(raw)) return rules;
  for (const [network, r] of Object.entries(raw)) {
    if (!isObject(r)) continue;
    rules[network] = { maxCaption: num(r['maxCaption']), recommendedMin: num(r['recommendedMin']), recommendedMax: num(r['recommendedMax']), visibleChars: num(r['visibleChars']), maxHashtags: num(r['maxHashtags']) };
  }
  return rules;
}

export const REJECTION_REASONS = ['weak_copy', 'irrelevant_image', 'poor_design', 'incorrect_branding', 'factual_issue', 'repetitive', 'style', 'other'] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];
export const POSTER_STATUSES = ['pending', 'approved', 'rejected', 'blocked', 'superseded', 'held', 'expired', 'open', 'all'] as const;
export type PosterStatusFilter = (typeof POSTER_STATUSES)[number];

export interface PosterView {
  id: string;
  batchId: string;
  postId: string;
  network: string;
  shape: string;
  width: number;
  height: number;
  headline: string;
  caption: string;
  versionNumber: number;
  status: string;
  /** Plain words for the customer when the picture needs something from them (blocked or held); the engine's own text is never used. */
  notice?: string;
  /** Whether one more picture can be drawn for this one, and how many tries are left. */
  canRedraw: boolean;
  redrawsLeft: number;
  createdAt: string;
  /** The day (YYYY-MM-DD) and time (HH:MM), India time, the post is planned for. Left out when the plan does not say. */
  date?: string;
  time?: string;
  /** True when the system approved this picture (the customer chose automatic posting for its channel), not a person. */
  autoApproved?: true;
  /** The OTHER networks whose current picture of this post is the very same drawing (for example Facebook and Google share Instagram's square). Left out when none. */
  sharedWith?: string[];
}

/** Where a carousel stands as a whole. `incomplete`: not every slide is ready; `pending`: waiting for the customer. */
export type CarouselStatus = 'incomplete' | 'blocked' | 'rejected' | 'approved' | 'pending';
const CAROUSEL_STATUSES: readonly string[] = ['incomplete', 'blocked', 'rejected', 'approved', 'pending'];
const carouselStatus = (value: unknown): CarouselStatus => (typeof value === 'string' && CAROUSEL_STATUSES.includes(value) ? (value as CarouselStatus) : 'incomplete');

export type TopicState = 'writing' | 'waiting_for_words' | 'drawing' | 'drawn' | 'not_made';
const TOPIC_STATES: readonly string[] = ['writing', 'waiting_for_words', 'drawing', 'drawn', 'not_made'];
const TOPIC_REASONS: readonly string[] = ['NOT_WRITTEN', 'TEXT_REFUSED', 'DROPPED', 'PUT_AWAY', 'WEEK_PASSED', 'DRAW_FAILED', 'NO_PICTURE_ROOM', 'NO_PICTURE', 'HEADLINE_TOO_WEAK', 'FACT_OUT_OF_DATE'];

/** A topic the customer asked for in her own words, and where it stands. */
export interface TopicRequestView {
  id: string;
  /** The job that writes it; used to find the request just made, and not part of what a product is shown. */
  jobId: string;
  week: { from: string; to: string };
  /** The day (YYYY-MM-DD) and time (HH:MM), India time, the post goes out. */
  goesOutOn: string;
  goesOutAt: string;
  state: TopicState;
  /** For `not_made`: why, as a fixed code. */
  reason?: string;
  createdAt: string;
  /** Once written: the batch and post to keep, edit and draw through the written-posts calls, and the words. */
  batchId?: string;
  postId?: string;
  words?: { headline: string; captions: Record<string, string> };
  /** The pictures drawing it would make now, one for each connected channel it is written for. */
  picturesToDraw: number;
}

export interface CarouselSummary {
  id: string;
  topic: string;
  /** The day it is meant for, ISO 8601 with the offset. */
  date: string;
  /** How many slides it has. */
  count: number;
  status: CarouselStatus;
}

export interface CarouselDetail {
  id: string;
  count: number;
  status: CarouselStatus;
  slides: Array<{ position: number; status: string; /** Only for the engine client's own use: which picture the slide is. */ versionId?: string }>;
  captions: Array<{ network: string; caption: string; status: string }>;
}

export interface PosterDetail extends PosterView {
  ctaUrl?: string;
  /** Where each fact the poster states was found on the website. */
  evidence: Array<{ text: string; quote: string; url: string }>;
  decidedAt?: string;
  history: Array<{ id: string; versionNumber: number; status: string; createdAt: string }>;
}

/** Something put away because nobody decided in time. */
export interface ExpiredView {
  at: string;
  kind: 'batch' | 'poster' | 'week';
  batchId: string;
  /** For a `week` given up undrawn: its Monday (YYYY-MM-DD). */
  week?: string;
  postId?: string;
  network?: string;
  posterId?: string;
}

/** How long a written batch or a picture waits for the customer before it is put away (the engine's own rule, kept here to warn before it happens). */
export const EXPIRY_DAYS = 14;

export interface DecisionView {
  id: string;
  status: string;
  decidedAt: string;
}

const STATUS_NOTICE: Record<string, string> = {
  blocked: 'This picture did not pass our checks, so it cannot be used. Draw a new one, or drop this post.',
  held: 'Please confirm again that this picture is right before it goes out.',
};

/** The hash of each picture's image, kept off the views so it never reaches a product; it is only used to tell which pictures are the same drawing. */
const IMAGE_HASH = new WeakMap<PosterView, string>();
const NETWORK_ORDER = ['instagram', 'facebook', 'linkedin', 'google'];
/** The sentence the engine writes when a channel has no pictures left, in exactly this shape. */
const CAROUSEL_LIMIT_SENTENCE = /^(?:A carousel is already made for the week of \d{4}-\d{2}-\d{2}\. You can make another from \d{4}-\d{2}-\d{2}, or reject this week's and make one again|Two carousels were already made for the week of \d{4}-\d{2}-\d{2}\. You can make another from \d{4}-\d{2}-\d{2})\.$/;
const PICTURE_LIMIT_SENTENCE = /^You have (?:used your \d{1,2}|\d{1,2} of your \d{1,2}) (?:Instagram|Facebook|LinkedIn|Google) pictures (?:for|left) this week[^<>]{0,120}\.$/;

/**
 * Marks, on every current picture, the other networks that share its drawing. "Current" is the newest version of a network of a post that has not been
 * replaced (superseded). A redrawn picture is a different image, so it stops being shared; a picture added for a new network that reuses another's image shares it.
 */
function markShared(posters: readonly PosterView[]): void {
  const newest = new Map<string, PosterView>();
  for (const p of posters) {
    if (p.status === 'superseded') continue;
    const key = `${p.batchId}|${p.postId}|${p.network}`;
    const seen = newest.get(key);
    if (!seen || p.versionNumber > seen.versionNumber) newest.set(key, p);
  }
  for (const p of newest.values()) {
    const hash = IMAGE_HASH.get(p);
    if (hash === undefined) continue;
    const others = [...newest.values()].filter((o) => o !== p && o.batchId === p.batchId && o.postId === p.postId && o.network !== p.network && IMAGE_HASH.get(o) === hash).map((o) => o.network);
    if (others.length > 0) p.sharedWith = [...new Set(others)].sort((a, b) => NETWORK_ORDER.indexOf(a) - NETWORK_ORDER.indexOf(b));
  }
}

function posterOf(raw: unknown, brand: string): PosterView | null {
  if (!isObject(raw) || raw['brand'] !== brand || typeof raw['versionId'] !== 'string' || !VERSION_ID.test(raw['versionId']) || !raw['versionId'].startsWith(`${brand}.`)) return null;
  // A slide or a caption of a carousel is shown with its carousel, never as a picture of its own.
  if (isObject(raw['carousel'])) return null;
  if (typeof raw['planFile'] !== 'string' || !PART.test(raw['planFile']) || typeof raw['postId'] !== 'string' || !PART.test(raw['postId'])) return null;
  const status = str(raw['status'], 20) ?? 'pending';
  const view: PosterView = {
    id: raw['versionId'],
    batchId: raw['planFile'],
    postId: raw['postId'],
    network: str(raw['network'], 20) ?? '',
    shape: str(raw['shape'], 20) ?? '',
    width: num(raw['width']),
    height: num(raw['height']),
    headline: str(raw['headline'], 300) ?? '',
    caption: str(raw['caption'], 3000) ?? '',
    versionNumber: num(raw['versionNumber']),
    status,
    ...(STATUS_NOTICE[status] ? { notice: STATUS_NOTICE[status] } : {}),
    canRedraw: raw['canRedraw'] === true,
    redrawsLeft: Math.max(0, Math.floor(num(raw['redrawsLeft']))),
    createdAt: str(raw['createdAt'], 40) ?? '',
    ...(typeof raw['date'] === 'string' && DAY.test(raw['date']) ? { date: raw['date'] } : {}),
    ...(typeof raw['time'] === 'string' && CLOCK.test(raw['time']) ? { time: raw['time'] } : {}),
    ...(status === 'approved' && raw['decidedBy'] === 'system:auto-posting' ? { autoApproved: true as const } : {}),
  };
  if (typeof raw['imageSha256'] === 'string' && /^[a-f0-9]{64}$/.test(raw['imageSha256'])) IMAGE_HASH.set(view, raw['imageSha256']);
  return view;
}

function decisionOf(raw: unknown, brand: string): DecisionView {
  const decision = isObject(raw) && isObject(raw['decision']) ? raw['decision'] : null;
  const id = decision && typeof decision['versionId'] === 'string' ? decision['versionId'] : '';
  if (!VERSION_ID.test(id) || !id.startsWith(`${brand}.`) || !isObject(raw)) throw unavailable();
  return { id, status: str(raw['status'], 20) ?? '', decidedAt: str(decision?.['at'], 40) ?? '' };
}

/** The safe view of a topic request the engine sent, or null when it is not a well formed one. Only fixed codes and the customer's own words pass. */
function topicRequestOf(raw: unknown): TopicRequestView | null {
  if (!isObject(raw)) return null;
  const week = raw['week'];
  const { id, state, createdAt, goesOutOn, goesOutAt } = raw;
  if (typeof id !== 'string' || !/^t-[A-Za-z0-9-]{1,40}$/.test(id)) return null;
  if (typeof state !== 'string' || !TOPIC_STATES.includes(state) || typeof createdAt !== 'string') return null;
  if (!isObject(week) || typeof week['from'] !== 'string' || !DAY.test(week['from']) || typeof week['to'] !== 'string' || !DAY.test(week['to'])) return null;
  if (typeof goesOutOn !== 'string' || !DAY.test(goesOutOn) || typeof goesOutAt !== 'string' || !/^\d{2}:\d{2}$/.test(goesOutAt)) return null;
  if (typeof raw['jobId'] !== 'string' || !JOB_ID.test(raw['jobId'])) return null;
  const view: TopicRequestView = { id, jobId: raw['jobId'], week: { from: week['from'], to: week['to'] }, goesOutOn, goesOutAt, state: state as TopicState, createdAt, picturesToDraw: Math.max(0, Math.min(10, Math.trunc(num(raw['picturesToDraw'])))) };
  if (typeof raw['reason'] === 'string' && TOPIC_REASONS.includes(raw['reason'])) view.reason = raw['reason'];
  if (typeof raw['batchId'] === 'string' && PART.test(raw['batchId'])) view.batchId = raw['batchId'];
  if (typeof raw['postId'] === 'string' && PART.test(raw['postId'])) view.postId = raw['postId'];
  const words = raw['words'];
  if (isObject(words) && typeof words['headline'] === 'string' && isObject(words['captions'])) {
    const captions = Object.fromEntries(Object.entries(words['captions']).flatMap(([network, text]) => (NETWORK_ORDER.includes(network) && typeof text === 'string' ? [[network, text.slice(0, 5000)]] : [])));
    view.words = { headline: words['headline'].slice(0, 300), captions };
  }
  return view;
}

export class WorkspaceEngine {
  readonly brand: string;
  readonly productId: string;
  private readonly config: EngineConfig;
  private readonly secret: string;

  constructor(config: EngineConfig, productId: string, brand: string) {
    if (!BRAND.test(brand)) throw new Error('the brand must be lower-case letters, digits and hyphens, at most 63 characters');
    const secret = config.productSecrets[productId];
    if (secret === undefined) throw new Error(`the engine has no secret for the product "${productId}"`);
    this.config = config;
    this.secret = secret;
    this.productId = productId;
    this.brand = brand;
  }

  /** Starts reading a website and writing posts for it, under this workspace's brand. Asking twice for the same brand is one job (`created: false`). */
  async startSiteJob(input: { site: string; networks: readonly string[]; page: boolean; weeks?: number; postsPerWeek?: number; weekdays?: readonly string[]; startDate?: string; actor: string }): Promise<{ job: JobView; created: boolean }> {
    const answer = await this.call('POST', '/review/jobs', input.actor, {
      kind: 'copy',
      site: input.site,
      networks: input.networks,
      brand: this.brand,
      ...(input.page ? { page: true } : {}),
      ...(input.weeks !== undefined ? { weeks: input.weeks } : {}),
      ...(input.postsPerWeek !== undefined ? { postsPerWeek: input.postsPerWeek } : {}),
      ...(input.weekdays !== undefined ? { weekdays: input.weekdays } : {}),
      ...(input.startDate !== undefined ? { startDate: input.startDate } : {}),
    });
    const made = this.own(isObject(answer) ? answer['job'] : undefined);
    if (!made) throw unavailable();
    return { job: made, created: isObject(answer) && answer['created'] === true };
  }

  /** This workspace's jobs, newest first (the engine lists only the brand named in X-Brand). */
  async listJobs(actor: string): Promise<JobView[]> {
    const answer = await this.call('GET', '/review/jobs', actor);
    const jobs = isObject(answer) && Array.isArray(answer['jobs']) ? answer['jobs'] : [];
    return jobs.flatMap((raw) => {
      const own = this.own(raw);
      return own ? [own] : [];
    });
  }

  /** One of this workspace's jobs. A job of another brand, or an id that is not a job id, is "no such job". */
  async getJob(id: string, actor: string): Promise<JobView> {
    if (!JOB_ID.test(id)) throw new EngineError(404, 'no such job');
    const answer = await this.call('GET', `/review/jobs/${id}`, actor);
    const own = this.own(isObject(answer) ? answer['job'] : undefined);
    if (!own) throw new EngineError(404, 'no such job');
    return own;
  }

  /** The facts found on the customer's website. */
  async getFacts(actor: string): Promise<FactsView> {
    return factsViewOf(await this.call('GET', `/review/brands/${this.brand}/facts`, actor));
  }

  /** Confirms, removes or restores one fact; answers the facts as they are now. */
  async decideFact(factId: string, verb: 'confirm' | 'remove' | 'restore', actor: string): Promise<FactsView> {
    if (!FACT_ID.test(factId)) throw new EngineError(404, 'not found');
    return factsViewOf(await this.call('POST', `/review/brands/${this.brand}/facts/${factId}/${verb}`, actor, {}));
  }

  /** The first and last post day of the customer's plan (batches not put away, drawn ones included); null when she has none. */
  async plan(actor: string): Promise<{ startsOn: string | null; endsOn: string | null }> {
    const answer = await this.call('GET', '/review/plan', actor);
    const day = (v: unknown): string | null => (typeof v === 'string' && DAY.test(v) ? v : null);
    if (!isObject(answer)) throw unavailable();
    return { startsOn: day(answer['startsOn']), endsOn: day(answer['endsOn']) };
  }

  /** Tells the poster service which channels the customer chose automatic posting for (an empty list switches it off). Answers what it saved, with who agreed and when. */
  async setAutoPosting(input: { channels: readonly string[]; safetyHours: number }, actor: string): Promise<{ channels: string[]; safetyHours: number; consentBy: string; consentAt: string }> {
    const answer = await this.call('PUT', '/review/auto-posting', actor, { channels: [...input.channels], safetyHours: input.safetyHours, by: actor });
    const saved = isObject(answer) && isObject(answer['autoPosting']) ? answer['autoPosting'] : null;
    const consent = saved !== null && isObject(saved['consent']) ? saved['consent'] : null;
    if (saved === null || consent === null || !Array.isArray(saved['channels']) || typeof saved['safetyHours'] !== 'number' || typeof consent['by'] !== 'string' || typeof consent['at'] !== 'string') throw unavailable();
    return { channels: saved['channels'].filter((c): c is string => typeof c === 'string'), safetyHours: saved['safetyHours'], consentBy: consent['by'], consentAt: consent['at'] };
  }

  /** Tells the poster service which networks the customer has connected accounts for, so no picture is bought for any other. Answers whether it was told; never throws. */
  async setConnected(networks: readonly string[], actor: string): Promise<boolean> {
    try {
      await this.call('PUT', '/review/connected', actor, { networks: [...networks] });
      return true;
    } catch (error) {
      // Said, never silent: without the list the poster service buys no picture for this customer.
      console.error(`could not tell the poster service which networks are connected: ${error instanceof EngineError ? `${error.status} ${error.message}` : 'it was not reachable'}`);
      return false;
    }
  }

  /** What the customer has drawn this week for each channel and what is left. */
  async limits(actor: string): Promise<LimitsView> {
    const answer = await this.call('GET', '/review/limits', actor);
    const week = isObject(answer) && isObject(answer['week']) ? answer['week'] : null;
    const date = (v: unknown): string | null => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
    const from = week ? date(week['from']) : null;
    const to = week ? date(week['to']) : null;
    const restart = week ? date(week['restart']) : null;
    const count = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1000 ? v : null);
    const limit = isObject(answer) ? count(answer['limit']) : null;
    const rows = isObject(answer) && Array.isArray(answer['channels']) ? answer['channels'] : [];
    const channels = rows.flatMap((row) => {
      if (!isObject(row) || typeof row['network'] !== 'string' || !NETWORK_ORDER.includes(row['network'])) return [];
      const chLimit = count(row['limit']);
      const used = count(row['used']);
      const left = count(row['left']);
      return chLimit === null || used === null || left === null ? [] : [{ network: row['network'], limit: chLimit, used, left }];
    });
    if (!from || !to || !restart || limit === null || channels.length === 0) throw unavailable();
    return { week: { from, to, restart }, limit, channels };
  }

  /** The written batches waiting for this customer's decision. */
  async listBatches(actor: string): Promise<BatchesView> {
    const answer = await this.call('GET', '/review/copy', actor);
    const raw = isObject(answer) && Array.isArray(answer['batches']) ? answer['batches'] : [];
    const batches = raw.flatMap((b) => {
      const view = batchViewOf(b, this.brand);
      return view ? [view] : [];
    });
    return { batches, networkRules: rulesOf(isObject(answer) ? answer['networkRules'] : undefined) };
  }

  /** Asks for the words of one more network for every topic of a batch, from the same topics (no website read). A job: the answer is followed in the jobs. */
  async addNetwork(batchId: string, network: string, actor: string): Promise<{ job: JobView; created: boolean }> {
    if (!PART.test(batchId)) throw new EngineError(404, 'not found');
    const answer = await this.call('POST', `/review/copy/${this.brand}/${batchId}/networks`, actor, { network });
    const job = this.own(isObject(answer) ? answer['job'] : undefined);
    if (!job) throw unavailable();
    return { job, created: isObject(answer) && answer['created'] === true };
  }

  /** Asks for a new topic for a dropped post: a job that writes one post for the same day. The same ask while one is running is the same job. */
  async replaceWrittenPost(batchId: string, postId: string, actor: string): Promise<{ job: JobView; created: boolean }> {
    if (!PART.test(batchId) || !PART.test(postId)) throw new EngineError(404, 'not found');
    const answer = await this.call('POST', `/review/copy/${this.brand}/${batchId}/${postId}/replace`, actor, {});
    const job = this.own(isObject(answer) ? answer['job'] : undefined);
    if (!job) throw unavailable();
    return { job, created: isObject(answer) && answer['created'] === true };
  }

  /** Moves a written post to another day of its own week, before its week is drawn. Answers the batch as it is now and whether its words name a day (they are not rewritten). */
  async moveWrittenPost(batchId: string, postId: string, day: string, actor: string): Promise<{ batch: BatchView; warnings: string[] }> {
    if (!PART.test(batchId) || !PART.test(postId)) throw new EngineError(404, 'not found');
    const answer = await this.call('POST', `/review/copy/${this.brand}/${batchId}/${postId}/move`, actor, { day });
    const batch = batchViewOf(isObject(answer) ? answer['batch'] : undefined, this.brand);
    if (!batch) throw unavailable();
    const warnings = isObject(answer) && Array.isArray(answer['warnings']) ? answer['warnings'].filter((w): w is string => w === 'WORDS_NAME_A_DAY') : [];
    return { batch, warnings };
  }

  /** Keeps or drops one written post. */
  async decideWrittenPost(batchId: string, postId: string, verb: 'keep' | 'drop', actor: string): Promise<BatchView> {
    return this.oneBatch(await this.call('POST', `${this.copyPath(batchId, postId)}/${verb}`, actor, {}));
  }

  /** Changes the words (and sign-off) of one written post. */
  async editWrittenPost(batchId: string, postId: string, change: { headline?: string; caption?: string; network?: string; brandName?: string; domain?: string }, actor: string): Promise<BatchView> {
    return this.oneBatch(await this.call('PUT', `${this.copyPath(batchId, postId)}/edit`, actor, { ...change }));
  }

  /** Puts a whole written batch away. */
  async closeBatch(batchId: string, actor: string): Promise<BatchView> {
    if (!PART.test(batchId)) throw new EngineError(404, 'not found');
    return this.oneBatch(await this.call('POST', `/review/copy/${this.brand}/${batchId}/close`, actor, {}));
  }

  private copyPath(batchId: string, postId: string): string {
    if (!PART.test(batchId) || !PART.test(postId)) throw new EngineError(404, 'not found');
    return `/review/copy/${this.brand}/${batchId}/${postId}`;
  }

  private oneBatch(answer: unknown): BatchView {
    const view = batchViewOf(isObject(answer) ? answer['batch'] : undefined, this.brand);
    if (!view) throw unavailable();
    return view;
  }

  /** Asks for pictures for the kept posts of a batch. Asking twice answers the same job; the engine allows one draw per batch (and one more after a failed one). */
  async startDraw(batchId: string, retry: boolean, actor: string, week?: string): Promise<{ job: JobView; created: boolean }> {
    if (!PART.test(batchId)) throw new EngineError(404, 'not found');
    try {
      const answer = await this.call('POST', `/review/copy/${this.brand}/${batchId}/draw`, actor, { ...(retry ? { retry: true } : {}), ...(week ? { week } : {}) });
      const job = this.own(isObject(answer) ? answer['job'] : undefined);
      if (!job) throw unavailable();
      return { job, created: isObject(answer) && answer['created'] === true };
    } catch (error) {
      // Of the engine's refusals to draw, only "nothing kept" is the customer's to fix; any other means the poster service is not ready for this customer.
      if (error instanceof EngineError && error.status === 422 && error.engineCode !== 'NOTHING_KEPT') throw unavailable();
      throw error;
    }
  }

  /**
   * The pictures of this customer's posts, by status. A picture put away because nobody decided in time is "expired" (the engine keeps it as rejected with the
   * reason "expired"); it is told apart here by the engine's own expiry record.
   */
  async listPosters(status: PosterStatusFilter, actor: string): Promise<PosterView[]> {
    // Every picture is read once, so that which ones share a drawing is known whatever status was asked for.
    const everyone = await this.allPosters(actor);
    const pick = (list: PosterView[]): PosterView[] => (status === 'open' ? list.filter((p) => p.status === 'pending' || p.status === 'held') : status === 'all' ? list : status === 'rejected' ? list.filter((p) => p.status === 'rejected' || p.status === 'expired') : list.filter((p) => p.status === status));
    if (status !== 'expired' && status !== 'rejected' && status !== 'all') return pick(everyone);
    const expired = new Set((await this.listExpired(new Date(Date.now() - (EXPIRY_DAYS * 2 + 30) * 86_400_000).toISOString(), actor)).flatMap((e) => (e.posterId ? [e.posterId] : [])));
    for (const p of everyone) if (p.status === 'rejected' && expired.has(p.id)) p.status = 'expired';
    return pick(everyone);
  }

  /** Every picture of this customer, with the sharing of drawings worked out. */
  private async allPosters(actor: string): Promise<PosterView[]> {
    const answer = await this.call('GET', '/review/posts?status=all', actor);
    const raw = isObject(answer) && Array.isArray(answer['posts']) ? answer['posts'] : [];
    const posters = raw.flatMap((p) => {
      const poster = posterOf(p, this.brand);
      return poster ? [poster] : [];
    });
    markShared(posters);
    return posters;
  }

  /** One picture with where its facts come from and its earlier versions. */
  async getPoster(id: string, actor: string): Promise<PosterDetail> {
    const answer = await this.call('GET', `/review/posts/${this.versionPath(id)}`, actor);
    const version = isObject(answer) ? answer['version'] : undefined;
    const poster = posterOf({ ...(isObject(version) ? version : {}), brand: isObject(version) ? version['brand'] : undefined, status: isObject(answer) ? answer['status'] : undefined }, this.brand);
    if (!poster || !isObject(answer) || !isObject(version)) throw new EngineError(404, 'not found');
    const evidence = (Array.isArray(version['evidence']) ? version['evidence'] : []).flatMap((e): PosterDetail['evidence'] => (isObject(e) ? [{ text: str(e['text'], 1000) ?? '', quote: str(e['quote'], 1000) ?? '', url: str(e['url'], 2000) ?? '' }] : []));
    const history = (Array.isArray(answer['history']) ? answer['history'] : []).flatMap((h): PosterDetail['history'] => {
      const entry = posterOf(h, this.brand);
      return entry ? [{ id: entry.id, versionNumber: entry.versionNumber, status: entry.status, createdAt: entry.createdAt }] : [];
    });
    const decidedAt = isObject(answer['decision']) ? str(answer['decision']['at'], 40) : undefined;
    const shared = (await this.allPosters(actor)).find((p) => p.id === poster.id)?.sharedWith;
    if (shared) poster.sharedWith = shared;
    // A picture nobody decided on in time was put away by the engine with the reason "expired": the customer sees that as its own state.
    if (poster.status === 'rejected' && isObject(answer['decision']) && answer['decision']['reason'] === 'expired') poster.status = 'expired';
    return { ...poster, ...(str(version['ctaUrl'], 2000) ? { ctaUrl: str(version['ctaUrl'], 2000) as string } : {}), evidence, ...(decidedAt ? { decidedAt } : {}), history };
  }

  /** Asks for this week's carousel: made from the website's verified facts for the channels given (the engine keeps only the connected ones). One a week; a second ask is the same job. */
  async startCarousel(input: { site: string; networks: readonly string[]; startDate?: string; actor: string }): Promise<{ job: JobView; created: boolean }> {
    const answer = await this.call('POST', '/review/jobs', input.actor, { kind: 'carousel', site: input.site, networks: input.networks, brand: this.brand, ...(input.startDate !== undefined ? { startDate: input.startDate } : {}) });
    const made = this.own(isObject(answer) ? answer['job'] : undefined);
    if (!made) throw unavailable();
    return { job: made, created: isObject(answer) && answer['created'] === true };
  }

  /** Starts one post written from the customer's own words for a day. A second ask with the same words for the same week is the same job (`created: false`). */
  async startTopic(input: { site: string; networks: readonly string[]; text: unknown; startDate: string; actor: string }): Promise<{ job: JobView; created: boolean }> {
    const answer = await this.call('POST', '/review/jobs', input.actor, { kind: 'topic', site: input.site, networks: input.networks, brand: this.brand, text: input.text, startDate: input.startDate });
    const made = this.own(isObject(answer) ? answer['job'] : undefined);
    if (!made) throw unavailable();
    return { job: made, created: isObject(answer) && answer['created'] === true };
  }

  /** The topics this customer asked for, newest first (the last ten). */
  async listTopicRequests(actor: string): Promise<TopicRequestView[]> {
    const answer = await this.call('GET', '/review/topic-requests', actor);
    const raw = isObject(answer) && Array.isArray(answer['requests']) ? answer['requests'] : [];
    return raw.flatMap((r) => {
      const view = topicRequestOf(r);
      return view ? [view] : [];
    });
  }

  /** Whether the weekly carousel is switched on for this customer. */
  async carouselWeekly(actor: string): Promise<boolean> {
    const answer = await this.call('GET', '/review/carousel-weekly', actor);
    return isObject(answer) && answer['enabled'] === true;
  }

  /** Switches the weekly carousel on or off: when on, one is made for her each week for her to approve. Answers the new state. */
  async setCarouselWeekly(enabled: boolean, actor: string): Promise<boolean> {
    const answer = await this.call('PUT', '/review/carousel-weekly', actor, { enabled });
    return isObject(answer) && answer['enabled'] === true;
  }

  /** The carousels made for this customer, newest first. */
  async listCarousels(actor: string): Promise<CarouselSummary[]> {
    const answer = await this.call('GET', '/review/carousels', actor);
    const raw = isObject(answer) && Array.isArray(answer['carousels']) ? answer['carousels'] : [];
    return raw.flatMap((c): CarouselSummary[] => {
      if (!isObject(c) || typeof c['id'] !== 'string' || !CAROUSEL_ID.test(c['id'])) return [];
      return [{ id: c['id'], topic: str(c['topic'], 200) ?? '', date: str(c['date'], 40) ?? '', count: Math.max(0, Math.floor(num(c['count']))), status: carouselStatus(c['status']) }];
    });
  }

  /** One carousel with its slides and the words it will go out with for each channel. */
  async getCarousel(id: string, actor: string): Promise<CarouselDetail> {
    if (!CAROUSEL_ID.test(id)) throw new EngineError(404, 'not found');
    const answer = await this.call('GET', `/review/carousels/${this.brand}/${id}`, actor);
    if (!isObject(answer) || answer['id'] !== id) throw new EngineError(404, 'not found');
    const slides = (Array.isArray(answer['slides']) ? answer['slides'] : []).flatMap((s): CarouselDetail['slides'] => {
      if (!isObject(s)) return [];
      const position = Math.floor(num(s['position']));
      if (position < 1 || position > 10) return [];
      const versionId = typeof s['versionId'] === 'string' && VERSION_ID.test(s['versionId']) && s['versionId'].startsWith(`${this.brand}.`) ? s['versionId'] : null;
      return [{ position, status: versionId ? (str(s['status'], 20) ?? 'pending') : 'missing', ...(versionId ? { versionId } : {}) }];
    });
    const captions = (Array.isArray(answer['captions']) ? answer['captions'] : []).flatMap((c): CarouselDetail['captions'] => (isObject(c) && typeof c['network'] === 'string' && NETWORK_ORDER.includes(c['network']) ? [{ network: c['network'], caption: str(c['caption'], 3000) ?? '', status: str(c['status'], 20) ?? 'pending' }] : []));
    return { id, count: Math.max(0, Math.floor(num(answer['count']))), status: carouselStatus(answer['status']), slides, captions };
  }

  /** Approves the whole carousel: every slide and every channel's words, exactly as they are now. */
  async approveCarousel(id: string, actor: string): Promise<CarouselSummary['status']> {
    if (!CAROUSEL_ID.test(id)) throw new EngineError(404, 'not found');
    const answer = await this.call('POST', `/review/carousels/${this.brand}/${id}/approve`, actor, {});
    return carouselStatus(isObject(answer) ? answer['status'] : undefined);
  }

  /** Rejects the whole carousel, with a reason. */
  async rejectCarousel(id: string, reason: RejectionReason, comment: string | undefined, actor: string): Promise<CarouselSummary['status']> {
    if (!CAROUSEL_ID.test(id)) throw new EngineError(404, 'not found');
    const answer = await this.call('POST', `/review/carousels/${this.brand}/${id}/reject`, actor, { reason, ...(comment ? { comment } : {}) });
    return carouselStatus(isObject(answer) ? answer['status'] : undefined);
  }

  /** The picture itself, as a JPEG. */
  async getPosterImage(id: string, actor: string): Promise<Buffer> {
    return this.callImage(`/review/posts/${this.versionPath(id)}/image`, actor);
  }

  /** Draws one more picture for one network of a post (one redraw per poster); the new one arrives as a new waiting picture. */
  async redrawPoster(id: string, actor: string): Promise<{ job: JobView; created: boolean }> {
    const answer = await this.call('POST', `/review/posts/${this.versionPath(id)}/redraw`, actor, {});
    const job = this.own(isObject(answer) ? answer['job'] : undefined);
    if (!job) throw unavailable();
    return { job, created: isObject(answer) && answer['created'] === true };
  }

  /** What was put away since `since` because nobody decided in time (only brands a product owns are swept). */
  async listExpired(since: string, actor: string): Promise<ExpiredView[]> {
    const answer = await this.call('GET', `/review/expiry?since=${encodeURIComponent(since)}`, actor);
    const raw = isObject(answer) && Array.isArray(answer['expired']) ? answer['expired'] : [];
    return raw.flatMap((e): ExpiredView[] => {
      if (!isObject(e) || e['brand'] !== this.brand || (e['kind'] !== 'batch' && e['kind'] !== 'poster' && e['kind'] !== 'week') || typeof e['at'] !== 'string' || typeof e['planFile'] !== 'string' || !PART.test(e['planFile'])) return [];
      const posterId = typeof e['versionId'] === 'string' && VERSION_ID.test(e['versionId']) && e['versionId'].startsWith(`${this.brand}.`) ? e['versionId'] : undefined;
      const postId = typeof e['postId'] === 'string' && PART.test(e['postId']) ? e['postId'] : undefined;
      const network = str(e['network'], 20);
      const week = typeof e['week'] === 'string' && DAY.test(e['week']) ? e['week'] : undefined;
      if (e['kind'] === 'week' && !week) return [];
      return [{ at: e['at'].slice(0, 40), kind: e['kind'], batchId: e['planFile'], ...(week ? { week } : {}), ...(postId ? { postId } : {}), ...(network ? { network } : {}), ...(posterId ? { posterId } : {}) }];
    });
  }

  /** New words for one picture's network: a new waiting version of the same picture (no draw, no cost) that replaces the older one and needs approving again. */
  async changePosterWords(id: string, caption: string, actor: string): Promise<PosterView> {
    const answer = await this.call('POST', `/review/posts/${this.versionPath(id)}/words`, actor, { caption });
    const poster = posterOf(isObject(answer) ? answer['version'] : undefined, this.brand);
    if (!poster) throw unavailable();
    return poster;
  }

  /** Approves one picture. */
  async approvePoster(id: string, actor: string): Promise<DecisionView> {
    return decisionOf(await this.call('POST', `/review/posts/${this.versionPath(id)}/approve`, actor, {}), this.brand);
  }

  /** Rejects one picture (this also takes back an approval). */
  async rejectPoster(id: string, reason: RejectionReason, comment: string | undefined, actor: string): Promise<DecisionView> {
    return decisionOf(await this.call('POST', `/review/posts/${this.versionPath(id)}/reject`, actor, { reason, ...(comment ? { comment } : {}) }), this.brand);
  }

  /** Approves every network's waiting picture of one topic. */
  async approveTopic(batchId: string, postId: string, actor: string): Promise<DecisionView[]> {
    if (!PART.test(batchId) || !PART.test(postId)) throw new EngineError(404, 'not found');
    const answer = await this.call('POST', `/review/topics/${this.brand}/${batchId}/${postId}/approve`, actor, {});
    const raw = isObject(answer) && Array.isArray(answer['decisions']) ? answer['decisions'] : [];
    return raw.flatMap((d): DecisionView[] => (isObject(d) && typeof d['versionId'] === 'string' && VERSION_ID.test(d['versionId']) && d['versionId'].startsWith(`${this.brand}.`) ? [{ id: d['versionId'], status: str(d['status'], 20) ?? '', decidedAt: '' }] : []));
  }

  private versionPath(id: string): string {
    if (!VERSION_ID.test(id) || !id.startsWith(`${this.brand}.`)) throw new EngineError(404, 'not found');
    return id;
  }

  /** The job as a product may see it, only when it is this brand's. */
  private own(raw: unknown): JobView | null {
    const parsed = jobView(raw);
    return parsed && parsed.brand === this.brand ? parsed.view : null;
  }

  private async call(method: 'GET' | 'POST' | 'PUT', path: string, actor: string, body?: Record<string, unknown>): Promise<unknown> {
    const response = await this.request(method, path, actor, body);
    const answer: unknown = await response.json().catch(() => null);
    if (answer === null) throw unavailable();
    return answer;
  }

  /** The bytes of a picture the engine answers with, only when it says it is a JPEG and it is not larger than a poster can be. */
  private async callImage(path: string, actor: string): Promise<Buffer> {
    const response = await this.request('GET', path, actor);
    if (!(response.headers.get('content-type') ?? '').startsWith('image/jpeg')) throw unavailable();
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) throw unavailable();
    return bytes;
  }

  /** One call to the engine; an answer that is not a success is turned into an error that is safe to show. */
  private async request(method: 'GET' | 'POST' | 'PUT', path: string, actor: string, body?: Record<string, unknown>): Promise<Response> {
    const send = this.config.fetch ?? fetch;
    let response: Response;
    try {
      response = await send(`${this.config.url}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.secret}`, 'X-Brand': this.brand, 'X-Actor': actor, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch {
      throw unavailable();
    }
    if (response.ok) return response;
    const answer: unknown = await response.json().catch(() => null);
    if (response.status === 404) throw new EngineError(404, 'not found');
    // A channel with no pictures left this week: the engine's sentence is shown only when it has exactly the fixed shape the engine writes; anything else is replaced.
    if (response.status === 429 && isObject(answer) && answer['code'] === 'PICTURE_LIMIT_REACHED') {
      const channel = typeof answer['channel'] === 'string' && NETWORK_ORDER.includes(answer['channel']) ? answer['channel'] : undefined;
      const restart = typeof answer['restart'] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(answer['restart']) ? answer['restart'] : undefined;
      const sentence = typeof answer['error'] === 'string' && PICTURE_LIMIT_SENTENCE.test(answer['error']) ? answer['error'] : 'You have used the pictures you can draw for this channel this week. Try again next week.';
      throw new EngineError(429, sentence, 'refused', 'PICTURE_LIMIT_REACHED', channel && restart ? { channel, restart } : undefined);
    }
    // A customer who has made her carousel for the week: only the two fixed sentences the engine writes are shown, and the day she can make another.
    if (response.status === 429 && isObject(answer) && answer['code'] === 'CAROUSEL_LIMIT_REACHED') {
      const restart = typeof answer['restart'] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(answer['restart']) ? answer['restart'] : undefined;
      const sentence = typeof answer['error'] === 'string' && CAROUSEL_LIMIT_SENTENCE.test(answer['error']) ? answer['error'] : 'You have already made your carousel for this week. You can make another next week.';
      throw new EngineError(429, sentence, 'refused', 'CAROUSEL_LIMIT_REACHED', undefined, restart);
    }
    // A customer who has her topic for the week: the day she can add another.
    if (response.status === 429 && isObject(answer) && answer['code'] === 'TOPIC_LIMIT_REACHED') {
      const restart = typeof answer['restart'] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(answer['restart']) ? answer['restart'] : undefined;
      throw new EngineError(429, restart ? `You have already added a topic for this week. You can add another from ${restart}.` : 'You have already added a topic for this week. You can add another next week.', 'refused', 'TOPIC_LIMIT_REACHED', undefined, restart);
    }
    // A week that has its new topics: the day she can ask again.
    if (response.status === 429 && isObject(answer) && answer['code'] === 'REPLACE_LIMIT_REACHED') {
      const restart = typeof answer['restart'] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(answer['restart']) ? answer['restart'] : undefined;
      throw new EngineError(429, restart ? `A week may have 3 new topics written. You can ask again from ${restart}.` : 'A week may have 3 new topics written. You can ask again next week.', 'refused', 'REPLACE_LIMIT_REACHED', undefined, restart);
    }
    // A topic text that cannot be used: a fixed code and our own fixed sentence for it, never the engine's words.
    if (response.status === 400 && isObject(answer) && typeof answer['reason'] === 'string' && TEXT_REASONS[answer['reason']] !== undefined) {
      throw new EngineError(400, TEXT_REASONS[answer['reason']] as string, 'refused', 'INVALID', undefined, undefined, answer['reason']);
    }
    if (response.status === 400 || response.status === 403 || response.status === 409 || response.status === 422) {
      let engineCode = isObject(answer) && typeof answer['code'] === 'string' ? answer['code'] : undefined;
      // The engine answers REJECTED for several things; only the sentence tells "nothing kept" apart. It is read here and never passed on.
      if (response.status === 422 && isObject(answer) && typeof answer['error'] === 'string' && /keep at least one/i.test(answer['error'])) engineCode = 'NOTHING_KEPT';
      throw new EngineError(response.status, refusalMessage(response.status, engineCode), 'refused', engineCode);
    }
    throw unavailable();
  }
}
