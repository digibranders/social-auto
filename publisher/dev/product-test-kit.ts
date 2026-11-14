/** Helpers for tests that call the product API handlers directly: a throwaway store, a product with a known key, and a small fake of the engine's review service. */
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashKey } from '../lib/products.ts';

export const KEY = 'test-product-key-0123456789abcdef';
export const OTHER_KEY = 'other-product-key-0123456789abcd';
export const CHANNEL_KEY = '33'.repeat(32);
export const ENGINE_SECRET = 'engine-secret-0123456789';
export const OTHER_ENGINE_SECRET = 'other-engine-secret-0123456789';
const ENV_NAMES = ['LOCAL_STORE_DIR', 'BLOB_READ_WRITE_TOKEN', 'PRODUCTS', 'INVITE_SECRET', 'DASHBOARD_ORIGIN', 'CHANNEL_KEY', 'PUBLIC_ORIGIN', 'REVIEW_URL', 'REVIEW_PRODUCT_SECRETS'] as const;

/** A throwaway store and two products ("brandbasket" and "otherapp"); the environment is put back afterwards. */
export async function withProducts(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'product-api-'));
  const before = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  process.env['LOCAL_STORE_DIR'] = dir;
  process.env['PRODUCTS'] = JSON.stringify([
    { id: 'brandbasket', keyHash: hashKey(KEY), returnUrls: ['https://app.example.test/social'] },
    { id: 'otherapp', keyHash: hashKey(OTHER_KEY), returnUrls: ['https://other.example.test/social'] },
  ]);
  process.env['CHANNEL_KEY'] = CHANNEL_KEY;
  delete process.env['BLOB_READ_WRITE_TOKEN'];
  const logged = console.error;
  console.error = (): void => undefined;
  try {
    await run(dir);
  } finally {
    console.error = logged;
    for (const name of ENV_NAMES) {
      if (before[name] === undefined) delete process.env[name];
      else process.env[name] = before[name];
    }
    await rm(dir, { recursive: true, force: true });
  }
}

export type Handler = (request: Request) => Promise<Response>;
export interface Answer {
  status: number;
  body: Record<string, unknown>;
}

export async function call(handler: Handler, path: string, init: { method?: string; key?: string | null; json?: unknown; headers?: Record<string, string> } = {}): Promise<Answer> {
  const headers: Record<string, string> = { ...(init.key === null ? {} : { authorization: `Bearer ${init.key ?? KEY}` }), ...init.headers };
  const body = init.json !== undefined ? JSON.stringify(init.json) : undefined;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await handler(new Request(`https://social.example.test${path}`, { method: init.method ?? (body === undefined ? 'GET' : 'POST'), headers, ...(body === undefined ? {} : { body }) }));
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

export interface FakeJob {
  id: string;
  key: string;
  kind: 'copy' | 'draw' | 'redraw' | 'network' | 'newnet' | 'carousel' | 'carouseldraw' | 'topic' | 'replace';
  /** For a carousel drawing job: which carousel. */
  carouselId?: string;
  brand: string;
  site: string;
  by: string;
  networks: string[];
  state: 'queued' | 'running' | 'succeeded' | 'failed';
  createdAt: string;
  step?: number;
  /** A batch written week by week: the file it is saved in, and the weeks saved so far of the weeks it will have. */
  planFileMade?: string;
  weeksDone?: number;
  weeksTotal?: number;
  finishedAt?: string;
  planFile?: string;
  week?: string;
  postId?: string;
  auto?: boolean;
  /** A topic job only: the statement id, the day it goes out and the words (the real engine keeps the words beside the brand, not in the job). */
  topicId?: string;
  startDate?: string;
  text?: string;
  error?: { code: string; message: string };
  result?: unknown;
}

export interface FakeFact {
  factId: string;
  text: string;
  sourceUrl: string;
  sourceQuote: string;
  state: 'suggested' | 'confirmed' | 'removed';
  held: boolean;
  proofHold?: { reason: string };
}

export interface FakeBatch {
  brand: string;
  planFile: string;
  createdAt: string;
  drawnAt?: string;
  closedAt?: string;
  /** Present while the batch is still being written week by week. */
  writing?: { weeksDone: number; weeksTotal: number };
  /** The weeks of a batch written for several weeks (as the review service lists them). */
  weeks?: Array<{ from: string; to: string; state: 'waiting' | 'drawing' | 'partly_drawn' | 'drawn' | 'lapsed'; postIds: string[]; openPostIds?: string[] }>;
  posts: Array<Record<string, unknown> & { postId: string; headline: string; caption: string; state: string }>;
}

export interface FakePoster {
  versionId: string;
  brand: string;
  postId: string;
  planFile: string;
  versionNumber: number;
  network: string;
  status: 'pending' | 'approved' | 'rejected' | 'blocked' | 'superseded' | 'held';
  headline: string;
  caption: string;
  width: number;
  height: number;
  shape: string;
  createdAt: string;
  costUsd: number;
  redrawsLeft?: number;
  /** The hash of the picture's image; pictures with the same hash are the same drawing. */
  imageSha256?: string;
  /** The reason it was rejected, when it was. */
  rejectedFor?: string;
  /** Who decided it, as the engine records it (`system:auto-posting` for the system's own approval). */
  decidedBy?: string;
  /** A slide or a caption of a carousel: shown with the carousel, never as a picture of its own. */
  carousel?: { id: string; position: number; count: number };
  /** The day and time (India time) the post is planned for, as the engine reads them from the plan file. */
  date?: string;
  time?: string;
}

export interface FakeCarousel {
  brand: string;
  id: string;
  topic: string;
  date: string;
  status: 'topic' | 'kept' | 'dropped' | 'drawing' | 'incomplete' | 'blocked' | 'rejected' | 'approved' | 'pending';
  /** The words of each slide while the carousel is only a topic (no picture yet). */
  headlines?: string[];
  /** The version ids of its slides, in order, and the words for each channel. */
  slides: string[];
  captions: Array<{ network: string; caption: string }>;
}

export interface FakeEngine {
  /** What the engine put away because nobody decided in time. */
  expired: Array<Record<string, unknown>>;
  posters: FakePoster[];
  /** The facts found per brand, and the written batches (kept by brand). */
  facts: Record<string, FakeFact[]>;
  batches: FakeBatch[];
  /** What was asked of it, in order. */
  seen: Array<{ method: string; url: string; authorization: string | undefined; brand: string | undefined; actor: string | undefined; body: Record<string, unknown> | null }>;
  jobs: FakeJob[];
  /** What the customer has drawn this week per channel, as the engine would count it. */
  weekly: { limit: number; used: Record<string, number>; week: { from: string; to: string; restart: string } };
  /** When set, a request that draws pictures (draw, redraw, add a network) is refused like a channel with none left. */
  refusePictures: { channel: string; restart: string; error: string } | null;
  /** The carousels made, and (when set) the refusal a customer who has made her week's carousel gets. */
  carousels: FakeCarousel[];
  carouselRefusal: { restart: string; error: string } | null;
  /** The topics asked for in the customer's own words, as the engine lists them (a test sets their state), and (when set) the refusal a customer who has her week's topic gets. */
  topics: Array<Record<string, unknown>>;
  topicRefusal: { restart: string; error: string } | null;
  /** Whether the customer switched the weekly carousel on. */
  carouselWeekly: boolean;
  /** The networks the product API told the engine the customer has connected (null: never told). */
  connected: string[] | null;
  /** How many of the next PUT /review/connected calls are refused (404), as before the brand's first job exists. */
  connectedRefusals: number;
  /** What the engine was told about automatic posting, per brand (the channels, the window, who agreed and when). */
  autoPosting: Record<string, { channels: string[]; safetyHours: number; consent: { by: string; at: string } }>;
  /** When set, the next PUT /review/auto-posting answers 503, as an engine that is down. */
  autoPostingDown: boolean;
  /** Where the customer's plan starts and ends, as the engine's plan read answers. */
  plan: { startsOn: string | null; endsOn: string | null };
  close: () => Promise<void>;
}

/** The Monday of the week a day (YYYY-MM-DD) falls in. */
const mondayOfDay = (day: string): string => new Date(Date.parse(`${day}T00:00:00Z`) - ((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7) * 86_400_000).toISOString().slice(0, 10);

/** A pretend review service: it keeps jobs, runs none, and answers a second ask for a brand with a job already waiting by returning that job (as the real one does). */
export async function fakeEngine(): Promise<FakeEngine> {
  const engine: FakeEngine = { seen: [], jobs: [], facts: {}, batches: [], posters: [], expired: [], weekly: { limit: 5, used: { instagram: 0, facebook: 0, linkedin: 0, google: 0 }, week: { from: '2026-11-09', to: '2026-11-15', restart: '2026-11-16' } }, refusePictures: null, carousels: [], topics: [], topicRefusal: null, carouselRefusal: null, carouselWeekly: false, connected: null, connectedRefusals: 0, autoPosting: {}, autoPostingDown: false, plan: { startsOn: null, endsOn: null }, close: async () => undefined };
  let counter = 0;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
      const header = (name: string): string | undefined => (typeof req.headers[name] === 'string' ? (req.headers[name] as string) : undefined);
      engine.seen.push({ method: req.method ?? '', url: req.url ?? '', authorization: header('authorization'), brand: header('x-brand'), actor: header('x-actor'), body });
      const send = (status: number, answer: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(answer));
      };
      const url = new URL(req.url ?? '/', 'http://engine.test');
      // Like the real service: a product's own secret, the one brand it acts for and the person deciding.
      const secrets = [ENGINE_SECRET, OTHER_ENGINE_SECRET];
      if (!secrets.some((s) => header('authorization') === `Bearer ${s}`)) return send(401, { error: 'Unauthorized' });
      const caller = header('x-brand') ?? '';
      if (!/^[A-Za-z0-9][A-Za-z0-9:_.@-]{0,79}$/.test(header('x-actor') ?? '') || caller === '') return send(400, { error: 'X-Brand and X-Actor are needed' });
      if (req.method === 'GET' && url.pathname === '/review/plan') return send(200, { brand: caller, ...engine.plan });
      if (req.method === 'PUT' && url.pathname === '/review/connected' && body && engine.connectedRefusals > 0) {
        engine.connectedRefusals -= 1;
        return send(404, { error: 'no such brand', code: 'NOT_FOUND' });
      }
      if (req.method === 'PUT' && url.pathname === '/review/auto-posting' && body) {
        if (engine.autoPostingDown) return send(503, { error: 'down' });
        if (!Array.isArray(body['channels']) || body['channels'].some((c) => !['instagram', 'facebook', 'linkedin', 'google'].includes(String(c)))) return send(400, { error: 'channels must be a list', code: 'INVALID' });
        const channels = [...new Set(body['channels'].map(String))].sort();
        const before = engine.autoPosting[caller];
        const widened = channels.some((c) => !before?.channels.includes(c));
        const saved = { channels, safetyHours: Number(body['safetyHours'] ?? 24), consent: widened || !before ? { by: header('x-actor') ?? '', at: new Date().toISOString() } : before.consent };
        engine.autoPosting[caller] = saved;
        return send(200, { autoPosting: { ...saved, updatedAt: new Date().toISOString() } });
      }
      if (req.method === 'PUT' && url.pathname === '/review/connected' && body) {
        engine.connected = Array.isArray(body['networks']) ? body['networks'].map(String) : [];
        return send(200, { changed: true });
      }
      if (req.method === 'GET' && url.pathname === '/review/limits') {
        return send(200, { brand: caller, week: engine.weekly.week, limit: engine.weekly.limit, channels: Object.entries(engine.weekly.used).map(([network, used]) => ({ network, limit: engine.weekly.limit, used, left: Math.max(0, engine.weekly.limit - used) })) });
      }
      if (req.method === 'POST' && engine.refusePictures && /\/redraw$|\/draw$|\/networks$/.test(url.pathname)) {
        return send(429, { error: engine.refusePictures.error, code: 'PICTURE_LIMIT_REACHED', channel: engine.refusePictures.channel, restart: engine.refusePictures.restart });
      }
      if (req.method === 'POST' && url.pathname === '/review/jobs' && body) {
        const brand = String(body['brand']);
        if (brand !== caller) return send(400, { error: 'brand must be the brand named in X-Brand' });
        if (body['kind'] === 'topic') {
          const text = typeof body['text'] === 'string' ? body['text'].trim() : '';
          if (text.length < 10) return send(400, { error: 'Write a little more: what is it, and when or for how long.', code: 'INVALID', reason: text.length === 0 && typeof body['text'] !== 'string' ? 'NOT_TEXT' : 'TOO_SHORT' });
          if (text.length > 1000) return send(400, { error: 'Keep it under 1000 characters.', code: 'INVALID', reason: 'TOO_LONG' });
          if (/https?:\/\/|www\.|[^\s@]+@[^\s@]+\.[a-z]{2,}|\b[a-z0-9-]+\.(com|in|co|org|net|io)\b/i.test(text)) return send(400, { error: 'Links are not read in this box.', code: 'INVALID', reason: 'LINK_NOT_ALLOWED' });
          if (/\bbest\b/i.test(text)) return send(400, { error: 'A claim that needs proof.', code: 'INVALID', reason: 'NEEDS_PROOF' });
          const day = String(body['startDate']);
          const plainly = (t: string): string => t.replace(/\s+/g, ' ').trim().toLowerCase();
          const repeat = engine.jobs.find((j) => j.kind === 'topic' && j.brand === brand && plainly(j.text ?? '') === plainly(text) && j.startDate !== undefined && mondayOfDay(j.startDate) === mondayOfDay(day));
          if (repeat) return send(200, { job: repeat, created: false });
          const week = mondayOfDay(day);
          const restart = new Date(Date.parse(`${week}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
          if (engine.jobs.some((j) => j.kind === 'topic' && j.brand === brand && j.state !== 'failed' && j.startDate !== undefined && mondayOfDay(j.startDate) === week)) return send(429, { error: `You have already added a topic for the week of ${week}. You can add another from ${restart}.`, code: 'TOPIC_LIMIT_REACHED', restart });
          if (engine.topicRefusal) return send(429, { error: engine.topicRefusal.error, code: 'TOPIC_LIMIT_REACHED', restart: engine.topicRefusal.restart });
          counter += 1;
          const topicJob: FakeJob = { id: `job-a${counter.toString(36).padStart(5, '0')}-0123abcd`, key: `topic:${brand}`, kind: 'topic', brand, site: String(body['site']), by: header('x-actor') ?? '', networks: body['networks'] as string[], state: 'queued', createdAt: new Date().toISOString(), topicId: `t-${counter.toString(36)}-abcdef`, startDate: day, text };
          engine.jobs.unshift(topicJob);
          engine.topics.unshift({ brand, id: topicJob.topicId, jobId: topicJob.id, week: { from: mondayOfDay(day), to: new Date(Date.parse(`${mondayOfDay(day)}T00:00:00Z`) + 6 * 86_400_000).toISOString().slice(0, 10) }, goesOutOn: day, goesOutAt: '10:00', state: 'writing', createdAt: topicJob.createdAt, picturesToDraw: 0 });
          return send(202, { job: topicJob, created: true });
        }
        const asked = body['kind'] === 'carousel' ? 'carousel' : 'copy';
        const standing = engine.jobs.find((j) => j.brand === brand && (j.state === 'queued' || j.state === 'running'));
        if (standing) return send(200, { job: standing, created: false });
        if (asked === 'carousel' && engine.carouselRefusal) return send(429, { error: engine.carouselRefusal.error, code: 'CAROUSEL_LIMIT_REACHED', restart: engine.carouselRefusal.restart });
        counter += 1;
        const job: FakeJob = { id: `job-a${counter.toString(36).padStart(5, '0')}-0123abcd`, key: `${asked}:${brand}`, kind: asked, brand, site: String(body['site']), by: header('x-actor') ?? '', networks: body['networks'] as string[], state: 'queued', createdAt: new Date().toISOString() };
        engine.jobs.unshift(job);
        return send(202, { job, created: true });
      }
      if (req.method === 'GET' && url.pathname === '/review/topic-requests') return send(200, { requests: engine.topics.filter((t) => t['brand'] === caller) });
      if (req.method === 'GET' && url.pathname === '/review/jobs') return send(200, { jobs: engine.jobs.filter((j) => j.brand === caller) });
      const one = /^\/review\/jobs\/(job-[a-z0-9]+-[a-f0-9]{8})$/.exec(url.pathname);
      if (req.method === 'GET' && one) {
        const found = engine.jobs.find((j) => j.id === one[1]);
        return found && found.brand === caller ? send(200, { job: found }) : send(404, { error: 'no such brand' });
      }
      // Facts and written posts, with the engine's own codes and the kind of text a product must never see.
      const factsRoute = /^\/review\/brands\/([^/]+)\/facts(?:\/([^/]+)\/(confirm|remove|restore))?$/.exec(url.pathname);
      if (factsRoute) {
        const [, brand = '', factId, verb] = factsRoute;
        const list = engine.facts[brand];
        if (brand !== caller) return send(404, { error: 'no such brand', code: 'NOT_FOUND' });
        if (!list) return send(404, { error: 'no facts have been read for this brand yet', code: 'NOT_FOUND' });
        if (factId && verb) {
          const fact = list.find((f) => f.factId === factId);
          if (!fact) return send(404, { error: 'no such fact for this brand', code: 'NOT_FOUND' });
          if (verb === 'confirm' && fact.proofHold) return send(409, { error: `this fact is held back from the automatic flow: ${fact.proofHold.reason} /home/social/x`, code: 'HELD' });
          fact.state = verb === 'confirm' ? 'confirmed' : verb === 'remove' ? 'removed' : 'suggested';
        }
        const count = (state: string): number => list.filter((f) => f.state === state).length;
        return send(200, { brand, builtAt: '2026-11-06T00:00:00.000Z', mode: 'all_usable', profile: { name: 'Acme', website: 'https://acme.example', tone: 'Warm', audience: 'Shops', offer: 'Chat', secretPath: '/home/social/x' }, facts: list.map((f) => ({ ...f, heldReason: f.proofHold?.reason })), counts: { suggested: count('suggested'), confirmed: count('confirmed'), removed: count('removed'), held: list.filter((f) => f.held).length } });
      }
      if (req.method === 'GET' && url.pathname === '/review/copy') {
        return send(200, { batches: engine.batches.filter((b) => b.brand === caller && !b.closedAt && !b.drawnAt).map((b) => ({ ...b, networks: ['instagram'], costUsd: 0.5 })), networkRules: { instagram: { maxCaption: 600, recommendedMin: 100, recommendedMax: 300, visibleChars: 125, maxHashtags: 5 } } });
      }
      const moveRoute = /^\/review\/copy\/([^/]+)\/([^/]+)\/([^/]+)\/move$/.exec(url.pathname);
      if (moveRoute && req.method === 'POST') {
        const [, brand = '', planFile = '', postId = ''] = moveRoute;
        const batch = engine.batches.find((b) => b.brand === brand && b.planFile === planFile);
        const post = batch?.posts.find((p) => p.postId === postId);
        if (brand !== caller || !batch || !post) return send(404, { error: 'no such post', code: 'NOT_FOUND' });
        if (batch.drawnAt || batch.closedAt) return send(409, { error: 'drawing was already asked for /home/social/x', code: 'ALREADY_DRAWN' });
        const to = String(body?.['day']);
        const week = (d: string): string => mondayOfDay(d);
        if (post['date'] === to) return send(200, { batch, moved: false, warnings: [] });
        if (week(to) !== week(String(post['date']))) return send(400, { error: 'outside the week /home/social/x', code: 'OUTSIDE_WEEK' });
        if (to <= new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10)) return send(400, { error: 'the day has passed /home/social/x', code: 'DAY_PASSED' });
        post['date'] = to;
        return send(200, { batch, moved: true, warnings: /friday/i.test(`${post.headline} ${post.caption}`) ? ['WORDS_NAME_A_DAY'] : [] });
      }
      const replaceRoute = /^\/review\/copy\/([^/]+)\/([^/]+)\/([^/]+)\/replace$/.exec(url.pathname);
      if (replaceRoute && req.method === 'POST') {
        const [, brand = '', planFile = '', postId = ''] = replaceRoute;
        const batch = engine.batches.find((b) => b.brand === brand && b.planFile === planFile);
        const post = batch?.posts.find((p) => p.postId === postId);
        if (brand !== caller || !batch || !post) return send(404, { error: 'no such post', code: 'NOT_FOUND' });
        if (batch.drawnAt) return send(409, { error: 'drawing was already asked for /home/social/x', code: 'ALREADY_DRAWN' });
        const standing = engine.jobs.find((j) => j.brand === brand && j.kind === 'replace' && j.planFile === planFile && j.postId === postId && (j.state === 'queued' || j.state === 'running'));
        if (standing) return send(200, { job: standing, created: false });
        if (post.state !== 'dropped' || batch.posts.some((p) => p['replaces'] === postId)) return send(409, { error: 'only a dropped post /home/social/x', code: 'CONFLICT' });
        if (String(post['date'] ?? '') <= new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10)) return send(409, { error: 'the day has passed /home/social/x', code: 'DAY_PASSED' });
        const used = batch.posts.filter((p) => p['replaces'] !== undefined).length + engine.jobs.filter((j) => j.brand === brand && j.kind === 'replace' && j.planFile === planFile && (j.state === 'queued' || j.state === 'running')).length;
        if (used >= 3) return send(429, { error: 'A week may have 3 new topics written /home/social/x', code: 'REPLACE_LIMIT_REACHED', restart: '2026-11-23' });
        counter += 1;
        const replaceJob: FakeJob = { id: `job-a${counter.toString(36).padStart(5, '0')}-0123abcd`, key: `replace:${brand}:${planFile}:${postId}`, kind: 'replace', brand, site: 'acme.example', by: header('x-actor') ?? '', networks: ['instagram'], planFile, postId, state: 'queued', createdAt: new Date().toISOString() };
        engine.jobs.unshift(replaceJob);
        return send(202, { job: replaceJob, created: true });
      }
      const copyRoute = /^\/review\/copy\/([^/]+)\/([^/]+)(?:\/([^/]+))?\/(keep|drop|reset|edit|close)$/.exec(url.pathname);
      if (copyRoute) {
        const [, brand = '', planFile = '', postId, verb] = copyRoute;
        const batch = engine.batches.find((b) => b.brand === brand && b.planFile === planFile);
        if (brand !== caller || !batch) return send(404, { error: 'no such brand', code: 'NOT_FOUND' });
        if (batch.drawnAt) return send(409, { error: 'drawing was already asked for /home/social/x', code: 'ALREADY_DRAWN' });
        if (verb === 'close') {
          batch.closedAt = new Date().toISOString();
          return send(200, { batch });
        }
        const post = batch.posts.find((p) => p.postId === postId);
        if (!post) return send(404, { error: 'no such post', code: 'NOT_FOUND' });
        if (verb === 'edit') {
          if (String(body?.['caption'] ?? '').includes('BADFACT')) return send(422, { error: 'the caption says something the facts do not: /home/social/x', code: 'REJECTED' });
          if (typeof body?.['headline'] === 'string') post.headline = body['headline'];
          if (typeof body?.['caption'] === 'string') post.caption = body['caption'];
          post['edited'] = true;
        } else {
          if (verb === 'reset' && String(post.date ?? '9999') <= new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10)) return send(400, { error: 'the day of this post is today or has passed', code: 'DAY_PASSED' });
          if (verb === 'reset' && post['replacedBy']) return send(409, { error: 'a new topic was already written for this post', code: 'CONFLICT' });
          post.state = verb === 'keep' ? 'kept' : verb === 'drop' ? 'dropped' : 'pending';
          post['decidedBy'] = verb === 'reset' ? undefined : header('x-actor');
        }
        return send(200, { batch });
      }
      if (req.method === 'GET' && url.pathname === '/review/expiry') {
        const since = Date.parse(url.searchParams.get('since') ?? '');
        return send(200, { expired: engine.expired.filter((e) => e['brand'] === caller && Date.parse(String(e['at'])) >= since) });
      }
      const posterView = (p: FakePoster): Record<string, unknown> => ({ ...p, canRedraw: ['pending', 'rejected', 'blocked', 'held'].includes(p.status) && (p.redrawsLeft ?? 1) > 0, redrawsLeft: p.redrawsLeft ?? 1 });
      const networkRoute = /^\/review\/copy\/([^/]+)\/([^/]+)\/networks$/.exec(url.pathname);
      if (networkRoute && req.method === 'POST') {
        const [, brand = '', planFile = ''] = networkRoute;
        const found = engine.batches.find((b) => b.brand === brand && b.planFile === planFile);
        if (brand !== caller || !found) return send(404, { error: 'no such brand', code: 'NOT_FOUND' });
        const network = String(body?.['network']);
        if (!['instagram', 'facebook', 'linkedin', 'google'].includes(network)) return send(400, { error: 'unknown network /home/social/x', code: 'INVALID' });
        if (found.closedAt) return send(409, { error: 'closed /home/social/x', code: 'CLOSED' });
        if (found.posts.some((p) => Object.keys((p['captions'] as Record<string, unknown> | undefined) ?? {}).includes(network))) return send(409, { error: 'the batch already has that network /home/social/x', code: 'CONFLICT' });
        const standing = engine.jobs.find((j) => j.brand === brand && j.kind === 'network' && j.planFile === planFile && (j.state === 'queued' || j.state === 'running'));
        if (standing) return send(200, { job: standing, created: false });
        counter += 1;
        const job: FakeJob = { id: `job-n${counter.toString(36).padStart(5, '0')}-0123abcd`, key: `network:${brand}:${planFile}:${network}`, kind: 'network', brand, site: 'https://acme.example', by: header('x-actor') ?? '', networks: [network], planFile, state: 'queued', createdAt: new Date().toISOString() };
        engine.jobs.unshift(job);
        return send(202, { job, created: true });
      }
      const drawRoute = /^\/review\/copy\/([^/]+)\/([^/]+)\/draw$/.exec(url.pathname);
      if (drawRoute && req.method === 'POST') {
        const [, brand = '', planFile = ''] = drawRoute;
        const found = engine.batches.find((b) => b.brand === brand && b.planFile === planFile);
        if (brand !== caller || !found) return send(404, { error: 'no such brand', code: 'NOT_FOUND' });
        if (found.closedAt) return send(409, { error: 'this batch was put away', code: 'CLOSED' });
        const week = typeof body?.['week'] === 'string' ? body['week'] : undefined;
        if (week !== undefined && !found.weeks?.some((w) => w.from === week)) return send(400, { error: 'week must be the Monday of one of this batch\'s weeks', code: 'INVALID' });
        const latest = engine.jobs.find((j) => j.brand === brand && j.kind === 'draw' && j.planFile === planFile && j.week === week);
        const retry = body?.['retry'] === true && latest?.state === 'failed';
        // A week that is drawn by the post (partly drawn) takes another round; a draw that is still running is the same ask.
        const another = found.weeks?.find((w) => w.from === week)?.state === 'partly_drawn' && latest?.state !== 'queued' && latest?.state !== 'running';
        if (latest && !retry && !another) return send(200, { job: latest, created: false });
        if (!found.posts.some((p) => p.state === 'kept')) return send(422, { error: 'keep at least one post before drawing /home/social/x', code: 'REJECTED' });
        if (found.posts.some((p) => p.noSite === true)) return send(422, { error: 'this brand has no website saved /home/social/x', code: 'REJECTED' });
        counter += 1;
        const job: FakeJob = { id: `job-d${counter.toString(36).padStart(5, '0')}-0123abcd`, key: `draw:${brand}`, kind: 'draw', brand, site: 'https://acme.example', by: header('x-actor') ?? '', networks: [], planFile, ...(week ? { week } : {}), state: 'queued', createdAt: new Date().toISOString() };
        engine.jobs.unshift(job);
        if (week) {
          const row = found.weeks?.find((w) => w.from === week);
          if (row) row.state = 'drawing';
          if (found.weeks?.every((w) => w.state !== 'waiting')) found.drawnAt = new Date().toISOString();
        } else found.drawnAt = new Date().toISOString();
        return send(202, { job, created: true });
      }
      if (req.method === 'GET' && url.pathname === '/review/posts') {
        const status = url.searchParams.get('status') ?? 'pending';
        const mine = engine.posters.filter((p) => p.brand === caller && !p.carousel && (status === 'all' || (status === 'open' ? p.status === 'pending' || p.status === 'held' : p.status === status)));
        return send(200, { posts: mine.map(posterView), problems: [], reasons: ['weak_copy', 'other'] });
      }
      if (url.pathname === '/review/carousel-weekly') {
        if (req.method === 'PUT' && body) engine.carouselWeekly = body['enabled'] === true;
        return send(200, { enabled: engine.carouselWeekly });
      }
      if (req.method === 'GET' && url.pathname === '/review/carousels') return send(200, { carousels: engine.carousels.filter((c) => c.brand === caller).map((c) => ({ id: c.id, topic: c.topic, date: c.date, createdAt: c.date, planFile: 'week-09.json', count: c.headlines ? c.headlines.length : c.slides.length, status: c.status, headlines: c.headlines ?? c.slides.map((_, i) => `Slide |${i + 1}| words`) })).reverse() });
      const carousel = /^\/review\/carousels\/([^/]+)\/([^/]+)(?:\/(approve|reject|move|keep|drop|reset|draw))?$/.exec(url.pathname);
      if (carousel) {
        const [, carouselBrand = '', carouselId = '', verb] = carousel;
        const found = engine.carousels.find((c) => c.brand === carouselBrand && c.id === carouselId);
        if (carouselBrand !== caller || !found) return send(404, { error: 'no such carousel', code: 'NOT_FOUND' });
        const topicStage = found.status === 'topic' || found.status === 'kept' || found.status === 'dropped' || found.status === 'drawing';
        if (!verb && topicStage) return send(200, { id: found.id, count: (found.headlines ?? []).length, status: found.status, slides: (found.headlines ?? []).map((headline, i) => ({ position: i + 1, versionId: null, status: found.status, headline })), captions: found.captions.map((c) => ({ ...c, status: found.status })), reasons: ['weak_copy', 'other', 'style'] });
        if (verb === 'keep' || verb === 'drop' || verb === 'reset') {
          const today = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
          if (!topicStage || found.status === 'drawing') return send(409, { error: 'this carousel was already drawn', code: 'ALREADY_DRAWN' });
          if (verb !== 'drop' && found.date.slice(0, 10) <= today) return send(400, { error: 'the day of this carousel is today or has passed', code: 'DAY_PASSED' });
          found.status = verb === 'keep' ? 'kept' : verb === 'drop' ? 'dropped' : 'topic';
          return send(200, { id: found.id, status: found.status });
        }
        if (verb === 'draw') {
          const today = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
          const standing = engine.jobs.find((j) => j.kind === 'carouseldraw' && j.carouselId === found.id && (j.state === 'queued' || j.state === 'running'));
          if (standing) return send(200, { job: standing, created: false });
          if (!topicStage) return send(409, { error: 'this carousel was already drawn', code: 'ALREADY_DRAWN' });
          if (found.status !== 'kept') return send(409, { error: 'keep the carousel before drawing it', code: 'CONFLICT' });
          if (found.date.slice(0, 10) <= today) return send(400, { error: 'the day of this carousel is today or has passed', code: 'DAY_PASSED' });
          counter += 1;
          const drawJob: FakeJob = { id: `job-a${counter.toString(36).padStart(5, '0')}-0123abcd`, key: `carouseldraw:${found.id}`, kind: 'carouseldraw', brand: caller, site: 'https://acme.example', by: header('x-actor') ?? '', networks: [], carouselId: found.id, state: 'queued', createdAt: new Date().toISOString() };
          engine.jobs.unshift(drawJob);
          found.status = 'drawing';
          return send(202, { job: drawJob, created: true });
        }
        if (!verb) return send(200, { id: found.id, count: found.slides.length, status: found.status, slides: found.slides.map((versionId, i) => ({ position: i + 1, versionId, status: found.status === 'approved' ? 'approved' : 'pending', headline: `Slide |${i + 1}| words`, caption: '' })), captions: found.captions.map((c) => ({ ...c, versionId: `${caller}.${'c'.repeat(16)}`, status: found.status === 'approved' ? 'approved' : 'pending' })), reasons: ['weak_copy', 'other'] });
        if (verb === 'move') {
          const day = String(body?.['day']);
          const today = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
          if (found.status !== 'pending' && found.status !== 'approved') return send(409, { error: 'only a carousel that is waiting or approved can be moved', code: 'CONFLICT' });
          if (found.date.slice(0, 10) <= today) return send(400, { error: 'the day of this carousel is today or has passed', code: 'DAY_PASSED' });
          if (day === found.date.slice(0, 10)) return send(200, { id: found.id, date: found.date, moved: false });
          const monday = (d: string): string => new Date(Date.parse(`${d}T00:00:00Z`) - ((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7) * 86_400_000).toISOString().slice(0, 10);
          if (monday(day) !== monday(found.date.slice(0, 10))) return send(400, { error: 'a carousel can only move to another day of its own week', code: 'OUTSIDE_WEEK' });
          if (day <= today) return send(400, { error: 'that day is today or has passed', code: 'DAY_PASSED' });
          found.date = `${day}${found.date.slice(10)}`;
          return send(200, { id: found.id, date: found.date, moved: true });
        }
        if (verb === 'reject' && !['weak_copy', 'other', 'style'].includes(String(body?.['reason']))) return send(400, { error: 'the reason must be one of', code: 'INVALID' });
        if (found.status === 'incomplete') return send(400, { error: 'slide 2 has no picture yet', code: 'INVALID' });
        found.status = verb === 'approve' ? 'approved' : 'rejected';
        return send(200, { status: found.status });
      }
      const topic = /^\/review\/topics\/([^/]+)\/([^/]+)\/([^/]+)\/approve$/.exec(url.pathname);
      if (topic && req.method === 'POST') {
        const [, brand = '', planFile = '', postId = ''] = topic;
        if (brand !== caller) return send(404, { error: 'no such brand', code: 'NOT_FOUND' });
        const waiting = engine.posters.filter((p) => p.brand === brand && p.status === 'pending' && p.postId === postId && p.planFile === planFile);
        if (waiting.length === 0) return send(404, { error: 'nothing is waiting for approval for that topic', code: 'NOT_FOUND' });
        return send(200, { decisions: waiting.map((p) => { p.status = 'approved'; return { versionId: p.versionId, network: p.network, status: p.status }; }) });
      }
      const poster = /^\/review\/posts\/([^/]+)(?:\/(image|approve|reject|redraw|words))?$/.exec(url.pathname);
      if (poster) {
        const [, versionId = '', verb] = poster;
        const found = engine.posters.find((p) => p.versionId === versionId);
        if (!found || found.brand !== caller) return send(404, { error: 'no such brand', code: 'NOT_FOUND' });
        if (!verb) return send(200, { version: { ...posterView(found), ctaUrl: 'https://acme.example', evidence: [{ factId: 'f1', text: 'Fact', quote: 'Quote', url: 'https://acme.example/x', context: 'internal' }], imageFile: '/home/social/x.jpg', createdBy: 'engine' }, status: found.status, decision: found.status === 'rejected' && found.rejectedFor ? { versionId, decision: 'reject', reason: found.rejectedFor, at: '2026-11-11T09:00:00.000Z', by: 'system:expiry' } : undefined, history: engine.posters.filter((p) => p.postId === found.postId && p.brand === found.brand).map(posterView) });
        if (verb === 'image') {
          res.writeHead(200, { 'content-type': 'image/jpeg' });
          return void res.end(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
        }
        if (verb === 'words') {
          if (body?.['headline'] !== undefined || typeof body?.['caption'] !== 'string') return send(400, { error: 'headline is on the picture /home/social/x', code: 'INVALID' });
          if (found.status === 'blocked') return send(409, { error: 'blocked /home/social/x', code: 'BLOCKED' });
          if (found.status === 'superseded') return send(409, { error: 'stale /home/social/x', code: 'STALE' });
          if (body['caption'] === found.caption) return send(409, { error: 'same words /home/social/x', code: 'CONFLICT' });
          if (String(body['caption']).includes('BADFACT')) return send(422, { error: 'the caption says something the facts do not: /home/social/x', code: 'REJECTED' });
          found.status = 'superseded';
          const next: FakePoster = { ...found, versionId: `${found.brand}.${(engine.posters.length + 1).toString(16).padStart(16, '0')}`, versionNumber: found.versionNumber + 1, status: 'pending', caption: body['caption'] };
          engine.posters.push(next);
          return send(200, { version: posterView(next) });
        }
        if (verb === 'redraw') {
          const waiting = engine.jobs.find((j) => j.brand === caller && j.kind === 'draw' && j.key === `redraw:${versionId}` && (j.state === 'queued' || j.state === 'running'));
          if (waiting) return send(200, { job: waiting, created: false });
          if (found.status === 'approved') return send(409, { error: 'withdraw first /home/social/x', code: 'CONFLICT' });
          if ((found.redrawsLeft ?? 1) <= 0) return send(409, { error: 'limit /home/social/x', code: 'LIMIT' });
          found.redrawsLeft = (found.redrawsLeft ?? 1) - 1;
          counter += 1;
          const job: FakeJob = { id: `job-r${counter.toString(36).padStart(5, '0')}-0123abcd`, key: `redraw:${versionId}`, kind: 'redraw', brand: caller, site: 'https://acme.example', by: header('x-actor') ?? '', networks: [], planFile: found.planFile, state: 'queued', createdAt: new Date().toISOString() };
          engine.jobs.unshift(job);
          return send(202, { job, created: true });
        }
        if (found.status === 'superseded') return send(409, { error: 'a newer version /home/social/x', code: 'STALE' });
        if (found.status === 'blocked' && verb === 'approve') return send(409, { error: 'blocked: defect at /home/social/x', code: 'BLOCKED' });
        if (verb === 'reject' && !['weak_copy', 'other', 'style'].includes(String(body?.['reason']))) return send(400, { error: 'the reason must be one of', code: 'INVALID' });
        found.status = verb === 'approve' ? 'approved' : 'rejected';
        return send(200, { decision: { versionId, decision: verb, by: header('x-actor'), at: '2026-11-11T09:00:00.000Z', imageSha256: 'a'.repeat(64) }, status: found.status });
      }
      return send(404, { error: 'Not found' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  process.env['REVIEW_URL'] = `http://127.0.0.1:${port}`;
  process.env['REVIEW_PRODUCT_SECRETS'] = `brandbasket:${ENGINE_SECRET},otherapp:${OTHER_ENGINE_SECRET}`;
  engine.close = () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
  return engine;
}
