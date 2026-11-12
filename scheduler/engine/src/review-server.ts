/**
 * The review queue as a small JSON service for the dashboard (which holds the signed-in session and adds the secret), listening on the local address only:
 *
 *   REVIEW_SECRET=... BRANDS_ROOT=brands node src/review-server.ts        (PORT defaults to 4012, HOST to 127.0.0.1)
 *
 *   GET  /review/posts?status=open|pending|held|approved|rejected|blocked|superseded|all     the queue, every brand (open = pending and held)
 *   GET  /review/posts/<versionId>                                                 one version with its evidence and history
 *   GET  /review/posts/<versionId>/image                                           the picture, for looking at (any status)
 *   GET  /review/posts/<versionId>/download                                        the picture, approved versions only
 *   POST /review/posts/<versionId>/approve   {"by":"..."}
 *   POST /review/posts/<versionId>/reject    {"by":"...","reason":"...","comment":"..."}
 *   POST /review/topics/<brand>/<week-NN.json>/<postId>/approve {"by":"..."}   approve every network's waiting picture of one topic
 *   GET  /review/brands/<brand>/facts      the facts found on the site; POST .../facts/<factId>/confirm|remove|restore {"by":"..."}
 *   GET  /review/copy                                                              the written posts waiting to be kept or dropped, before any picture is bought
 *   POST /review/copy/<brand>/<week-NN.json>/<postId>/keep|drop   {"by":"..."}
 *   PUT  /review/copy/<brand>/<week-NN.json>/<postId>/edit   {"by":"...","headline":"...","caption":"...","network":"linkedin"}   (network optional: the caption of that network; checked like the writer's own words; 422 when refused)
 *   POST /review/copy/<brand>/<week-NN.json>/close   {"by":"..."}   put a batch away without drawing it
 *   POST /review/copy/<brand>/<week-NN.json>/draw   {"by":"...","client":"name its channels are connected under (default: the site's name)"}   ask for the kept posts to be drawn (202 with a job; the same batch is only ever drawn once; after a failed draw, "retry":true draws only the kept posts that still have no picture)
 *   POST /review/jobs   {"kind":"copy","site":"https://...","networks":["instagram","linkedin"],"weeks":1,"postsPerWeek":2,"by":"..."} ("days" instead gives that many posts on consecutive days; optional "startDate":"YYYY-MM-DD" (tomorrow or later, India time) puts the first post on that day and "time":"HH:MM" sets the time of day, India time, 10:00 by default)   read a website and write its posts (202 with a job)
 *   GET  /review/jobs?brand=&state=      the jobs, newest first;  GET /review/jobs/<jobId>   one job: state, step 1-4, the plan file, the error, the last lines
 *
 * Everything is decided here, on the server, by the review store: the browser never says what is approvable. A version id names its brand
 * ("<brand>.<hash>"), and only folders directly under the brands root are ever opened.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { join, resolve } from 'node:path';
import { acquireLock, LockError } from './file-lock.ts';
import { listCampaigns } from './campaign-runner.ts';
import { REJECTION_REASONS, ReviewError, ReviewStore, type ReviewItem, type ReviewStatus } from './review-store.ts';
import { CopyStage, CopyStageError, weekOfPost, weeksOf } from './copy-stage.ts';
import { editCopy, type SignoffDefaults } from './copy-edit.ts';
import { displayDomain } from './ai-creative.ts';
import { loadFacts } from './evidence-pipeline.ts';
import { decideFact, FactsError, factsView } from './facts-view.ts';
import { checkCopyWords, checkNewWords } from './copy-edit.ts';
import { JobError, JobStore, keyOf, type Job, type JobState } from './job-store.ts';
import { CLIENT_NAME, registerManualRelease } from './manual-release.ts';
import { slugFromSite } from './analyze.ts';
import { captionRulesView, composeVariant, isNetwork, NETWORKS, type Network } from './networks.ts';
import { foldLedgerFile } from './paid-ledger.ts';
import { readConnected, writeConnected } from './connected-networks.ts';
import { neededPictures, runWeeklyDraws } from './weekly-draw.ts';
import { channelPicturesUsed, pictureLimitMessage, PictureLimitError, pictureWeek, weeklyLimitFromEnv, type PictureWeek } from './picture-limit.ts';
import { splitTrailingHashtags } from './caption-text.ts';
import { checkStartDate, checkTime, RhythmError, weeklyRhythm } from './rhythm.ts';
import { ProductBrands, PRODUCT_ID } from './product-brands.ts';
import { EXPIRY_DAYS, readExpiry, sweepExpired } from './expiry.ts';

const BRAND = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MAX_BODY_BYTES = 8 * 1024;
const STATUSES: readonly (ReviewStatus | 'all' | 'open')[] = ['pending', 'approved', 'rejected', 'blocked', 'superseded', 'held', 'all', 'open'];

export interface ReviewServerOptions {
  brandsRoot: string;
  secret: string;
  /** How long a change waits for another process's lock before the request is answered "busy" (tests shorten it). */
  lockTimeoutMs?: number;
  /** Where the job files live; the job runner reads the same folder. Defaults to "jobs" beside the brands folder. */
  jobsRoot?: string;
  /**
   * Outside products whose customers decide their own brands' posters. Each has its own secret and is let in only for the one brand it names in the
   * X-Brand header, as the person named in X-Actor. A brand a product owns can no longer be changed with the staff secret.
   */
  products?: Array<{ id: string; secret: string }>;
  /** How many times one poster (one network of one post) may be drawn again; each costs a picture. Default 1. */
  redrawCap?: number;
  /** Days after which an undecided batch or picture of a product-owned brand is put away (14 by default; 0 turns it off). */
  expiryDays?: number;
  /** How often the service looks for such things (an hour by default). */
  sweepEveryMs?: number;
  /** The engine's paid-call ledger, read (never written) to count what a product's customer has drawn this week. PAID_LEDGER_FILE, else beside the brands folder, as the engine does. */
  ledgerFile?: string;
  /** Pictures a product's customer may draw for each channel in a Monday-to-Sunday week (India time); PRODUCT_PICTURES_PER_CHANNEL_WEEK, else 5. */
  weeklyPictureLimit?: number;
  /** The clock (tests set it). */
  now?: () => Date;
  /** How often the weekly draw looks for a week that is due (10 minutes by default; 0 turns it off). AUTO_WEEK_DRAW=false turns it off too. */
  weeklyDrawEveryMs?: number;
}

const JOB_STATES: readonly JobState[] = ['queued', 'running', 'succeeded', 'failed'];

/** A website the engine may be started with: an http(s) address with a real host name (no address in numbers, no credentials, no port tricks). */
export function cleanSite(value: unknown, options: { keepPath?: boolean } = {}): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 200) throw new ReviewError('INVALID', 'site must be a website address');
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`);
  } catch {
    throw new ReviewError('INVALID', 'site must be a website address');
  }
  const host = url.hostname;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(host) || /^\d+(\.\d+)*$/.test(host) || url.username !== '' || url.password !== '' || url.port !== '') {
    throw new ReviewError('INVALID', 'site must be a website address with a real domain name');
  }
  // One page of a site (not the whole site) keeps its path; the query and anchor are never kept.
  return options.keepPath ? `${url.origin}${url.pathname.replace(/\/+$/, '')}` : url.origin;
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(text);
}

const JOB_STATUS: Record<JobError['code'], number> = { NOT_FOUND: 404, INVALID: 400, LOCKED: 503 };
const HTTP_STATUS: Record<ReviewError['code'], number> = { NOT_FOUND: 404, INVALID: 400, BLOCKED: 409, STALE: 409, ALREADY_DECIDED: 409, NOT_APPROVED: 409, TAMPERED: 500, LOCKED: 503, FORBIDDEN: 403, CONFLICT: 409, LIMIT: 409 };

function fail(res: ServerResponse, error: unknown): void {
  if (error instanceof PictureLimitError) return send(res, 429, { error: error.message, code: 'PICTURE_LIMIT_REACHED', channel: error.network, restart: error.restart });
  if (error instanceof JobError) return send(res, JOB_STATUS[error.code], { error: error.message, code: error.code });
  if (error instanceof FactsError) return send(res, FACTS_STATUS[error.code], { error: error.message, code: error.code });
  if (error instanceof CopyStageError) return send(res, COPY_STATUS[error.code], { error: error.message, code: error.code });
  if (error instanceof ReviewError) {
    // An integrity failure is reported without its details: the file names are for the operator's log, not the browser.
    if (error.code === 'TAMPERED') console.error(`review integrity: ${error.message}`);
    return send(res, HTTP_STATUS[error.code], { error: error.code === 'TAMPERED' ? 'The integrity check failed for this poster, so it was not released.' : error.message, code: error.code });
  }
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  send(res, 500, { error: 'Internal error' });
}

const FACTS_STATUS: Record<FactsError['code'], number> = { NOT_FOUND: 404, INVALID: 400, HELD: 409, LOCKED: 503 };
const COPY_STATUS: Record<CopyStageError['code'], number> = { NOT_FOUND: 404, INVALID: 400, ALREADY_DRAWN: 409, CLOSED: 409, REJECTED: 422, LOCKED: 503, CONFLICT: 409 };

const sameSecret = (given: Buffer, secret: string): boolean => {
  const wanted = Buffer.from(secret);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
};

/** Who is asking: our own staff (the dashboard), or a product acting for one customer's brand. */
export type Caller = { role: 'staff' } | { role: 'product'; productId: string; brand: string; actor: string };

const ACTOR = /^[A-Za-z0-9][A-Za-z0-9:_.@-]{0,79}$/;

/** Null when the secret is not known. A product must also say which brand it acts for and who the person is; the headers are checked here, once. */
function identify(req: IncomingMessage, secret: string, products: ReadonlyArray<{ id: string; secret: string }>): Caller | null {
  const given = Buffer.from(String(req.headers['authorization'] ?? '').replace(/^Bearer\s+/i, ''));
  if (sameSecret(given, secret)) return { role: 'staff' };
  const product = products.find((p) => sameSecret(given, p.secret));
  if (!product) return null;
  const brand = String(req.headers['x-brand'] ?? '');
  const actor = String(req.headers['x-actor'] ?? '');
  if (!BRAND.test(brand)) throw new ReviewError('INVALID', 'X-Brand must name the one brand this request is for');
  if (!ACTOR.test(actor)) throw new ReviewError('INVALID', 'X-Actor must name who is deciding');
  return { role: 'product', productId: product.id, brand, actor };
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new ReviewError('INVALID', 'the request is too large');
    chunks.push(chunk as Buffer);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('not an object');
    return value as Record<string, unknown>;
  } catch {
    throw new ReviewError('INVALID', 'the request body must be a JSON object');
  }
}

const text = (value: unknown, max = 200): string => (typeof value === 'string' ? value.trim().slice(0, max) : '');

export function createReviewServer(options: ReviewServerOptions): Server {
  const root = resolve(options.brandsRoot);
  const storeFor = (brand: string): ReviewStore => {
    if (!BRAND.test(brand)) throw new ReviewError('NOT_FOUND', 'no such brand');
    const dir = join(root, brand);
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) throw new ReviewError('NOT_FOUND', 'no such brand');
    return new ReviewStore(dir, brand, undefined, options.lockTimeoutMs);
  };
  const jobs = new JobStore(resolve(options.jobsRoot ?? join(root, '..', 'jobs')));
  const owners = new ProductBrands(root);
  // The weekly picture limit of a product's customer. The engine enforces it when it draws; the service checks it first so a request that cannot be drawn is refused
  // at once, before a job is queued, with the channel and the day the week starts again.
  const ledgerFile = resolve(options.ledgerFile ?? (process.env['PAID_LEDGER_FILE'] || join(root, '..', 'ledger', 'paid-calls.jsonl')));
  const weeklyLimitOf = (brand: string): number | undefined => (owners.has(brand) ? options.weeklyPictureLimit ?? weeklyLimitFromEnv(process.env) : undefined);
  const pictureUsage = (brand: string): { week: PictureWeek; used: Record<Network, number> } => {
    const week = pictureWeek((options.now ?? (() => new Date()))());
    try {
      return { week, used: channelPicturesUsed(foldLedgerFile(ledgerFile).values(), brand, week) };
    } catch {
      throw new ReviewError('LOCKED', 'the pictures used this week could not be counted just now, try again shortly');
    }
  };
  /** The pictures already made for a plan (`<postId>|<network>`), so a draw that finishes what a failed one began is not asked to pay twice. */
  const madeFor = (brand: string, planFile: string): Set<string> => new Set(new ReviewStore(join(root, brand), brand).list().filter((i) => i.version.planFile === planFile).map((i) => `${i.version.postId}|${i.version.network ?? ''}`));
  const assertPictureRoom = (brand: string, needed: Partial<Record<Network, number>>): void => {
    const limit = weeklyLimitOf(brand);
    if (limit === undefined) return;
    const { week, used } = pictureUsage(brand);
    for (const [network, count] of Object.entries(needed) as Array<[Network, number]>) {
      if (count > 0 && used[network] + count > limit) throw new PictureLimitError(network, week.restart, pictureLimitMessage(network, limit, used[network], count, week.restart));
    }
  };
  const products = options.products ?? [];
  for (const p of products) {
    if (!PRODUCT_ID.test(p.id) || p.secret.length < 16 || p.secret === options.secret) throw new Error('each product needs a lowercase id and its own secret of at least 16 characters');
  }
  /** What one caller may see and change. A product sees only its one brand; staff see everything but cannot change a brand a product owns. */
  const scopeFor = (caller: Caller) => ({
    /** Throws unless this caller may look at (or, with `write`, change) the brand. A product is told "no such brand" about any other, so it learns nothing about them. */
    guard(brand: string, write: boolean): void {
      if (!BRAND.test(brand)) throw new ReviewError('NOT_FOUND', 'no such brand');
      if (caller.role === 'product') {
        if (brand !== caller.brand || owners.get(brand)?.productId !== caller.productId) throw new ReviewError('NOT_FOUND', 'no such brand');
      } else if (write && owners.has(brand)) {
        throw new ReviewError('FORBIDDEN', 'this brand is decided by its own customer, so it cannot be changed from here');
      }
    },
    visible: (all: string[]): string[] => (caller.role === 'product' ? all.filter((b) => b === caller.brand && owners.get(b)?.productId === caller.productId) : all),
    by: (given: unknown): string => (caller.role === 'product' ? caller.actor : text(given, 80)),
  });
  /** Once drawing has been asked for, the batch's choices and words are final: the runner may start at any moment, and a change in between would be lost or fail the draw. */
  const refuseIfDrawAsked = (brand: string, planFile: string, postId?: string): void => {
    const asked = jobs.list({ brand }).filter((j) => j.kind === 'draw' && j.planFile === planFile);
    // A draw of one week of a batch locks only that week's posts; a draw with no week (a batch of one piece), or a call about the whole batch, locks everything.
    const week = postId === undefined ? undefined : weekOfPost(new CopyStage(join(root, brand), brand).get(planFile).posts.find((p) => p.postId === postId) ?? {});
    if (asked.some((j) => j.week === undefined || week === undefined || j.week === week)) throw new CopyStageError('ALREADY_DRAWN', 'drawing was already asked for, so this batch\'s choices and words are final');
  };
  const siteOf = (brand: string): string => {
    try {
      const website = (JSON.parse(readFileSync(join(root, brand, 'brand.json'), 'utf8')) as { website?: unknown }).website;
      return cleanSite(website);
    } catch {
      throw new CopyStageError('REJECTED', 'this brand has no website saved, so its pictures cannot be drawn');
    }
  };
  /** What a poster's sign-off says unless the owner changes it: the brand's name and the website's address. Null when the brand has neither saved. */
  const signoffDefaultsOf = (brand: string): SignoffDefaults | null => {
    try {
      const saved = JSON.parse(readFileSync(join(root, brand, 'brand.json'), 'utf8')) as { website?: unknown };
      // Every poster's sign-off is the web address; a name is drawn only when one is typed for that post.
      return { brandName: '', domain: displayDomain(cleanSite(saved.website)) };
    } catch {
      return null;
    }
  };
  const storeOf = (versionId: string): ReviewStore => storeFor(versionId.split('.')[0] ?? '');
  const brands = (): string[] => readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && BRAND.test(d.name)).map((d) => d.name);

  const redrawCap = options.redrawCap ?? 1;
  /** A redraw that bought nothing (no picture passed the checks) does not use up the poster's allowance. */
  const countsAgainstCap = (j: Job): boolean => !(j.state === 'failed' && j.error?.code === 'NOTHING_DRAWN');
  const REDRAWABLE: readonly ReviewStatus[] = ['pending', 'rejected', 'blocked', 'held'];
  /** Whether this picture can be drawn again, and how many more times: only the newest picture of a network that is not approved. */
  const redrawFor = (item: ReviewItem, brandJobs: readonly Job[]): { canRedraw: boolean; redrawsLeft: number } => {
    const v = item.version;
    const key = keyOf({ kind: 'redraw', brand: v.brand, planFile: v.planFile, postId: v.postId, ...(v.network ? { network: v.network } : {}) });
    const left = Math.max(0, redrawCap - brandJobs.filter((j) => j.key === key && countsAgainstCap(j)).length);
    return { canRedraw: REDRAWABLE.includes(item.status) && left > 0, redrawsLeft: left };
  };
  const summary = (item: ReviewItem, redraw?: { canRedraw: boolean; redrawsLeft: number }) => ({
    versionId: item.version.versionId, brand: item.version.brand, postId: item.version.postId, planFile: item.version.planFile, versionNumber: item.version.versionNumber, status: item.status,
    headline: item.version.headline, caption: item.version.caption, createdAt: item.version.createdAt, costUsd: item.version.costUsd, imageSha256: item.version.imageSha256,
    ...(item.version.network ? { network: item.version.network } : {}),
    ...(item.version.carousel ? { carousel: item.version.carousel } : {}),
    ...(item.version.width && item.version.height ? { width: item.version.width, height: item.version.height, shape: item.version.width / item.version.height >= 1.2 ? 'wide' : item.version.width / item.version.height <= 0.83 ? 'tall' : 'square' } : {}),
    ...(item.decision ? { decidedBy: item.decision.by, decidedAt: item.decision.at, reason: item.decision.reason } : {}),
    ...(redraw ?? {}),
  });

  const expiryDays = options.expiryDays ?? EXPIRY_DAYS;
  const server = createServer(async (req, res) => {
    try {
      const caller = identify(req, options.secret, products);
      if (!caller) return send(res, 401, { error: 'Not allowed' });
      const scope = scopeFor(caller);
      const url = new URL(req.url ?? '/', 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);
      // The facts found on a brand's site: read them, and remove, confirm or put back one.
      if (parts[0] === 'review' && parts[1] === 'brands' && parts[3] === 'facts') {
        const factsBrand = decodeURIComponent(parts[2] ?? '');
        scope.guard(factsBrand, req.method !== 'GET');
        if (!brands().includes(factsBrand)) throw new ReviewError('NOT_FOUND', 'no such brand');
        const factsDir = join(root, factsBrand);
        if (parts.length === 4 && req.method === 'GET') return send(res, 200, await factsView(factsDir, factsBrand));
        const verb = parts[5];
        if (parts.length === 6 && req.method === 'POST' && (verb === 'confirm' || verb === 'remove' || verb === 'restore')) {
          await readJson(req);
          await decideFact(factsDir, decodeURIComponent(parts[4] ?? ''), verb);
          return send(res, 200, await factsView(factsDir, factsBrand));
        }
        return send(res, 404, { error: 'Not found' });
      }
      if (parts[0] === 'review' && parts[1] === 'jobs') {
        if (parts.length === 2 && req.method === 'GET') {
          const state = url.searchParams.get('state') ?? undefined;
          const brand = caller.role === 'product' ? caller.brand : url.searchParams.get('brand') ?? undefined;
          if (state !== undefined && !(JOB_STATES as readonly string[]).includes(state)) return send(res, 400, { error: `state must be one of ${JOB_STATES.join(', ')}` });
          if (brand !== undefined && !BRAND.test(brand)) return send(res, 400, { error: 'brand is not a brand name' });
          return send(res, 200, { jobs: jobs.list({ ...(brand ? { brand } : {}), ...(state ? { state: state as JobState } : {}) }) });
        }
        if (parts.length === 3 && req.method === 'GET') {
          const job = jobs.get(decodeURIComponent(parts[2] ?? ''));
          scope.guard(job.brand, false);
          return send(res, 200, { job });
        }
        if (parts.length === 2 && req.method === 'POST') {
          const body = await readJson(req);
          if (body['kind'] === 'carousel') {
            // One carousel for a client whose website was already read (its profile and facts are what the carousel is made from): the day it is for and the time are optional.
            const carouselSite = cleanSite(body['site']);
            const carouselNetworks = Array.isArray(body['networks']) ? body['networks'] : null;
            if (carouselNetworks === null || carouselNetworks.length === 0 || carouselNetworks.some((n) => typeof n !== 'string' || !isNetwork(n))) throw new ReviewError('INVALID', `networks must be a non-empty list of ${NETWORKS.join(', ')}`);
            let carouselDay: string | undefined;
            let carouselTime: string | undefined;
            try {
              if (body['startDate'] !== undefined) carouselDay = checkStartDate(body['startDate'], Date.now());
              if (body['time'] !== undefined) carouselTime = checkTime(body['time']);
            } catch (error) {
              if (error instanceof RhythmError) throw new ReviewError('INVALID', error.message);
              throw error;
            }
            const carouselBrand = slugFromSite(carouselSite);
            if (!BRAND.test(carouselBrand) || !existsSync(join(root, carouselBrand, 'brand.json'))) throw new ReviewError('INVALID', 'that website has not been read yet: write posts for it first, so a carousel can be made from what it states');
            const { job, created } = jobs.enqueue({ kind: 'carousel', brand: carouselBrand, site: carouselSite, by: text(body['by'], 80), networks: [...new Set(carouselNetworks as string[])], ...(carouselDay ? { startDate: carouselDay } : {}), ...(carouselTime ? { time: carouselTime } : {}) });
            return send(res, created ? 202 : 200, { job, created });
          }
          if (body['kind'] !== 'copy') throw new ReviewError('INVALID', 'kind must be "copy" or "carousel" (drawing is asked for on the written batch)');
          if (body['page'] !== undefined && typeof body['page'] !== 'boolean') throw new ReviewError('INVALID', 'page must be true or false');
          const page = body['page'] === true;
          const site = cleanSite(body['site'], { keepPath: page });
          // The brand is named by whoever owns it, never by the website: two customers with the same website are two brands. Our own staff's brands are named after the site.
          let jobBrand: string;
          if (caller.role === 'product') {
            if (body['brand'] !== caller.brand) throw new ReviewError('INVALID', 'brand must be the brand named in X-Brand');
            jobBrand = caller.brand;
            const claimed = owners.claim(jobBrand, caller.productId, () => existsSync(join(root, jobBrand)) || jobs.list({ brand: jobBrand }).length > 0);
            if (claimed === 'taken') throw new ReviewError('CONFLICT', 'that brand name is not available');
          } else {
            jobBrand = slugFromSite(site);
            scope.guard(jobBrand, true);
          }
          const networks = body['networks'] === undefined ? [] : Array.isArray(body['networks']) ? body['networks'] : null;
          if (networks === null || networks.some((n) => typeof n !== 'string' || !isNetwork(n))) throw new ReviewError('INVALID', `networks must be a list of ${NETWORKS.join(', ')}`);
          // When the posts go out: the day of the first post and the time of day (India time). Both are optional; without them the engine chooses the next free day at 10:00.
          let startDate: string | undefined;
          let time: string | undefined;
          try {
            if (body['startDate'] !== undefined) startDate = checkStartDate(body['startDate'], Date.now());
            if (body['time'] !== undefined) time = checkTime(body['time']);
          } catch (error) {
            if (error instanceof RhythmError) throw new ReviewError('INVALID', error.message);
            throw error;
          }
          // How much to write: an exact number of posts ("days", on consecutive days), or a rhythm ("weeks" at "postsPerWeek" a week, two a week by default).
          let spread: { days: number; weekdays?: string[] };
          if (body['days'] !== undefined) {
            const days = Number(body['days']);
            if (!Number.isInteger(days) || days < 1 || days > 31) throw new ReviewError('INVALID', 'days must be a whole number from 1 to 31');
            spread = { days };
          } else {
            try {
              const rhythm = weeklyRhythm({ weeks: body['weeks'], postsPerWeek: body['postsPerWeek'], ...(startDate ? { startDate } : {}) });
              spread = { days: rhythm.days, weekdays: [...rhythm.weekdays] };
            } catch (error) {
              if (error instanceof RhythmError) throw new ReviewError('INVALID', error.message);
              throw error;
            }
          }
          const { job, created } = jobs.enqueue({ kind: 'copy', brand: jobBrand, site, by: scope.by(body['by']), networks: [...new Set(networks as string[])], days: spread.days, ...(page ? { page } : {}), ...(spread.weekdays ? { weekdays: spread.weekdays } : {}), ...(startDate ? { startDate } : {}), ...(time ? { time } : {}) });
          return send(res, created ? 202 : 200, { job, created });
        }
        return send(res, 404, { error: 'Not found' });
      }
      if (parts[0] === 'review' && parts[1] === 'copy') {
        if (parts.length === 2 && req.method === 'GET') {
          // A batch that was drawn is no longer waiting for choices, unless its draw stopped before it finished: it stays listed so the draw can be asked for again.
          const stopped = (brand: string, planFile: string): boolean => jobs.list({ brand }).find((j) => j.kind === 'draw' && j.planFile === planFile)?.state === 'failed';
          const batches = scope.visible(brands()).flatMap((brand) => new CopyStage(join(root, brand), brand).list().map((b) => ({ brand, b }))).filter(({ brand, b }) => !b.closedAt && (!b.drawnAt || stopped(brand, b.planFile))).map(({ b }) => b);
          // The weeks of a batch written for several weeks: when each starts and ends, its posts, and whether its pictures are waiting, being drawn, drawn or given up.
          const weeksView = (b: { brand: string; planFile: string; posts: Array<{ postId: string; date?: string }>; weekDrawn?: Record<string, string>; weekLapsed?: Record<string, string> }): { weeks?: Array<{ from: string; to: string; state: 'waiting' | 'drawing' | 'drawn' | 'lapsed'; postIds: string[] }> } => {
            const mondays = weeksOf(b);
            if (mondays.length === 0) return {};
            const running = jobs.list({ brand: b.brand }).filter((j) => j.kind === 'draw' && j.planFile === b.planFile && (j.state === 'queued' || j.state === 'running'));
            return { weeks: mondays.map((from) => ({ from, to: new Date(Date.parse(`${from}T00:00:00Z`) + 6 * 86_400_000).toISOString().slice(0, 10), state: b.weekLapsed?.[from] !== undefined ? 'lapsed' as const : b.weekDrawn?.[from] !== undefined ? 'drawn' as const : running.some((j) => j.week === from) ? 'drawing' as const : 'waiting' as const, postIds: b.posts.filter((p) => weekOfPost(p) === from).map((p) => p.postId) })) };
          };
          // The writer marks the words to emphasise with | on the poster; the owner reads plain words.
          const plain = batches.map((b) => ({ ...b, networks: [...new Set(b.posts.flatMap((p) => Object.keys(p.captions ?? {})))].sort(), ...(signoffDefaultsOf(b.brand) ? { signoffDefault: signoffDefaultsOf(b.brand) } : {}), posts: b.posts.map((p) => ({ ...p, headline: p.headline.replaceAll('|', '') })), ...weeksView(b) }));
          return send(res, 200, { batches: plain.sort((a, b) => b.createdAt.localeCompare(a.createdAt)), networkRules: captionRulesView() });
        }
        const [, , brand = '', planFile = '', postId = '', verb = ''] = parts.map(decodeURIComponent);
        if (parts.length === 6 && req.method === 'POST' && (verb === 'keep' || verb === 'drop')) {
          scope.guard(brand, true);
          if (!brands().includes(brand)) throw new ReviewError('NOT_FOUND', 'no such brand');
          const by = scope.by((await readJson(req))['by']);
          refuseIfDrawAsked(brand, planFile, postId);
          const batch = new CopyStage(join(root, brand), brand).decide(planFile, postId, verb === 'keep' ? 'kept' : 'dropped', by);
          return send(res, 200, { batch });
        }
        // Put a whole batch away (POST .../<brand>/<planFile>/close) or change the words of one post before it is drawn (PUT .../<brand>/<planFile>/<postId>/edit).
        if (parts.length === 5 && req.method === 'POST' && parts[4] === 'close') {
          const [, , closeBrand = '', closePlan = ''] = parts.map(decodeURIComponent);
          scope.guard(closeBrand, true);
          if (!brands().includes(closeBrand)) throw new ReviewError('NOT_FOUND', 'no such brand');
          const by = scope.by((await readJson(req))['by']);
          refuseIfDrawAsked(closeBrand, closePlan);
          return send(res, 200, { batch: new CopyStage(join(root, closeBrand), closeBrand).close(closePlan, by) });
        }
        // Another network for a batch already written (waiting or drawn): the same topics, no new website read. It is a job, because the captions are written with the AI key, which only
        // the job runner holds. The answer is the job; its result lists each topic.
        if (parts.length === 5 && req.method === 'POST' && parts[4] === 'networks') {
          const [, , netBrand = '', netPlan = ''] = parts.map(decodeURIComponent);
          scope.guard(netBrand, true);
          if (!brands().includes(netBrand)) throw new ReviewError('NOT_FOUND', 'no such brand');
          const body = await readJson(req);
          const network = body['network'];
          if (typeof network !== 'string' || !isNetwork(network)) throw new ReviewError('INVALID', `network must be one of ${NETWORKS.join(', ')}`);
          const batch = new CopyStage(join(root, netBrand), netBrand).get(netPlan);
          if (batch.closedAt) throw new CopyStageError('CLOSED', 'this batch was put away, so it cannot be changed');
          if (batch.posts.some((p) => p.captions?.[network] !== undefined)) throw new CopyStageError('CONFLICT', 'the batch already has that network');
          // On a batch already drawn the new network's picture is drawn for every kept topic: the week must have room for them all.
          if (batch.drawnAt) assertPictureRoom(netBrand, { [network]: batch.posts.filter((p) => p.state === 'kept').length });
          const { job, created } = jobs.enqueue({ kind: 'network', brand: netBrand, site: siteOf(netBrand), by: scope.by(body['by']), planFile: netPlan, network });
          return send(res, created ? 202 : 200, { job, created });
        }
        if (parts.length === 5 && req.method === 'POST' && parts[4] === 'draw') {
          const [, , drawBrand = '', drawPlan = ''] = parts.map(decodeURIComponent);
          scope.guard(drawBrand, true);
          if (!brands().includes(drawBrand)) throw new ReviewError('NOT_FOUND', 'no such brand');
          const drawBody = await readJson(req);
          const by = scope.by(drawBody['by']);
          // The client the posters belong to (the name its channels are connected under); the website's own name when none is given.
          const client = caller.role === 'product' || drawBody['client'] === undefined ? drawBrand : text(drawBody['client'], 63);
          if (!CLIENT_NAME.test(client)) throw new ReviewError('INVALID', 'client must be lowercase letters, digits and dashes');
          const batch = new CopyStage(join(root, drawBrand), drawBrand).get(drawPlan);
          if (batch.closedAt) throw new CopyStageError('CLOSED', 'this batch was put away, so it cannot be drawn');
          // A batch of several weeks is drawn one week at a time: the week asked for (its Monday), else the first one not drawn yet.
          const weeks = weeksOf(batch);
          const askedWeek = drawBody['week'];
          if (askedWeek !== undefined && (typeof askedWeek !== 'string' || !weeks.includes(askedWeek))) throw new ReviewError('INVALID', 'week must be the Monday of one of this batch\'s weeks');
          const week: string | undefined = weeks.length === 0 ? undefined : (askedWeek as string | undefined) ?? weeks.find((w) => batch.weekDrawn?.[w] === undefined && batch.weekLapsed?.[w] === undefined) ?? weeks[0];
          const inWeek = (post: { date?: string }): boolean => week === undefined || weekOfPost(post) === week;
          // A batch (or a week of it) already asked for or drawn answers with its job; a draw buys pictures, so it is only ever started once. After a draw has failed,
          // "retry" asks for one more that draws only the kept posts that still have no picture.
          const latest = jobs.list({ brand: drawBrand }).find((j) => j.kind === 'draw' && j.planFile === drawPlan && j.week === week);
          const retry = drawBody['retry'] === true && latest?.state === 'failed';
          if (latest && !retry) return send(res, 200, { job: latest, created: false });
          const weekDone = week === undefined ? batch.drawnAt !== undefined : batch.weekDrawn?.[week] !== undefined || batch.weekLapsed?.[week] !== undefined || (batch.drawnAt !== undefined && weeks.length === 1);
          if (!latest && weekDone) throw new CopyStageError('ALREADY_DRAWN', week === undefined ? 'this batch was already drawn' : 'this week was already drawn');
          if (!batch.posts.some((p) => p.state === 'kept' && inWeek(p))) throw new CopyStageError('REJECTED', 'keep at least one post before drawing');
          // A product's customer may draw only so many pictures a channel a week: one for every kept post for every network it is written for, less what a failed draw already made.
          const needed = neededPictures(batch, week, madeFor(drawBrand, drawPlan), readConnected(join(root, drawBrand)));
          assertPictureRoom(drawBrand, needed);
          const drawSite = siteOf(drawBrand);
          // Approved posters of this batch reach the calendar through the campaign runner's release pass, for this client and only the networks written for.
          // The record is made first: a draw that is queued without it would buy pictures that could never be released.
          registerManualRelease({ brandDir: join(root, drawBrand), siteBrand: drawBrand, client, site: drawSite, planFile: drawPlan });
          const { job, created } = jobs.enqueue({ kind: 'draw', brand: drawBrand, site: drawSite, by, planFile: drawPlan, ...(week ? { week } : {}), ...(retry ? { retry: true } : {}) });
          return send(res, created ? 202 : 200, { job, created });
        }
        // Runs the checks of an edit on words that are not saved: nothing changes, and it works after a draw too.
        if (parts.length === 6 && req.method === 'POST' && verb === 'check') {
          scope.guard(brand, true);
          if (!brands().includes(brand)) throw new ReviewError('NOT_FOUND', 'no such brand');
          const body = await readJson(req);
          const facts = (await loadFacts(join(root, brand)))?.facts ?? [];
          checkCopyWords({ brandDir: join(root, brand), planFile, postId, ...(typeof body['headline'] === 'string' ? { headline: body['headline'] } : {}), ...(typeof body['caption'] === 'string' ? { caption: body['caption'] } : {}), ...(typeof body['network'] === 'string' ? { network: body['network'] } : {}), facts });
          return send(res, 200, { ok: true });
        }
        if (parts.length === 6 && req.method === 'PUT' && verb === 'edit') {
          scope.guard(brand, true);
          if (!brands().includes(brand)) throw new ReviewError('NOT_FOUND', 'no such brand');
          const body = await readJson(req);
          refuseIfDrawAsked(brand, planFile, postId);
          const brandDir = join(root, brand);
          const facts = (await loadFacts(brandDir))?.facts ?? [];
          const headline = typeof body['headline'] === 'string' ? body['headline'] : undefined;
          const caption = typeof body['caption'] === 'string' ? body['caption'] : undefined;
          const network = typeof body['network'] === 'string' ? body['network'] : undefined;
          const brandName = typeof body['brandName'] === 'string' ? body['brandName'] : undefined;
          const domain = typeof body['domain'] === 'string' ? body['domain'] : undefined;
          const signoffDefaults = signoffDefaultsOf(brand);
          return send(res, 200, { batch: editCopy({ brandDir, brand, planFile, postId, ...(headline !== undefined ? { headline } : {}), ...(caption !== undefined ? { caption } : {}), ...(network !== undefined ? { network } : {}), ...(brandName !== undefined ? { brandName } : {}), ...(domain !== undefined ? { domain } : {}), ...(signoffDefaults ? { signoffDefaults } : {}), by: scope.by(body['by']), facts }) });
        }
        return send(res, 404, { error: 'Not found' });
      }
      // The networks the customer has connected accounts for, written by the product API whenever it looks at her channels: the draw buys no picture for any other.
      if (parts[0] === 'review' && parts[1] === 'connected' && parts.length === 2) {
        if (req.method !== 'PUT') return send(res, 405, { error: 'Method not allowed' });
        if (caller.role !== 'product') return send(res, 404, { error: 'Not found' });
        const body = await readJson(req);
        if (!Array.isArray(body['networks'])) throw new ReviewError('INVALID', 'networks must be a list');
        if (!brands().includes(caller.brand)) throw new ReviewError('NOT_FOUND', 'no such brand');
        return send(res, 200, writeConnected(join(root, caller.brand), body['networks'] as unknown[], (options.now ?? (() => new Date()))()));
      }
      // What a product's customer has drawn this week for each channel and what is left (read only). Staff may read a product brand's with ?brand=.
      if (parts[0] === 'review' && parts[1] === 'limits' && parts.length === 2) {
        if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
        const limitBrand = caller.role === 'product' ? caller.brand : url.searchParams.get('brand') ?? '';
        scope.guard(limitBrand, false);
        const limit = weeklyLimitOf(limitBrand);
        if (limit === undefined) throw new ReviewError('NOT_FOUND', 'no such brand');
        const { week, used } = pictureUsage(limitBrand);
        return send(res, 200, { brand: limitBrand, week: { from: week.from, to: week.to, restart: week.restart }, limit, channels: NETWORKS.map((network) => ({ network, limit, used: used[network], left: Math.max(0, limit - used[network]) })) });
      }
      // What was put away because nobody decided in time (read only): a product sees its own brand's, staff see all.
      if (parts[0] === 'review' && parts[1] === 'expiry' && parts.length === 2 && req.method === 'GET') {
        const since = url.searchParams.get('since') ?? undefined;
        return send(res, 200, { expired: readExpiry(root, { ...(caller.role === 'product' ? { brand: caller.brand } : {}), ...(since ? { since } : {}) }) });
      }
      // What is being made for each client's plans, for the dashboard's status panel. Read only.
      if (parts[0] === 'review' && parts[1] === 'campaigns' && parts.length === 2) {
        if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
        if (caller.role === 'product') return send(res, 404, { error: 'Not found' });
        return send(res, 200, { campaigns: await listCampaigns(options.brandsRoot) });
      }
      // Approve a whole topic in one step: every network's picture of it that is waiting. Each is still its own decision, on its own exact version.
      if (parts[0] === 'review' && parts[1] === 'topics' && parts.length === 6 && parts[5] === 'approve' && req.method === 'POST') {
        const [, , topicBrand = '', topicPlan = '', topicPost = ''] = parts.map(decodeURIComponent);
        scope.guard(topicBrand, true);
        if (!brands().includes(topicBrand)) throw new ReviewError('NOT_FOUND', 'no such brand');
        const by = scope.by((await readJson(req))['by']);
        const topicStore = storeFor(topicBrand);
        const ofTopic = topicStore.list().filter((i) => i.version.postId === topicPost && i.version.planFile === topicPlan);
        const waiting = ofTopic.filter((i) => i.status === 'pending');
        if (waiting.length === 0) {
          // A repeated request (a double click) gets the same answer as the first, never an error and never a second decision.
          const already = ofTopic.filter((i) => i.status === 'approved');
          if (already.length === 0) throw new ReviewError('NOT_FOUND', 'nothing is waiting for approval for that topic');
          return send(res, 200, { decisions: already.map((i) => ({ versionId: i.version.versionId, network: i.version.network ?? null, status: i.status })), already: true });
        }
        const decisions = waiting.map((i) => { topicStore.approve(i.version.versionId, by); return { versionId: i.version.versionId, network: i.version.network ?? null, status: topicStore.get(i.version.versionId).status }; });
        return send(res, 200, { decisions });
      }
      // A carousel: shown whole, and approved or rejected as one step. Its pictures are served by the ordinary picture route, by each slide's version id.
      if (parts[0] === 'review' && parts[1] === 'carousels' && (parts.length === 4 || (parts.length === 5 && req.method === 'POST' && (parts[4] === 'approve' || parts[4] === 'reject')))) {
        const carouselBrand = decodeURIComponent(parts[2] ?? '');
        const carouselId = decodeURIComponent(parts[3] ?? '');
        if (!BRAND.test(carouselBrand) || !brands().includes(carouselBrand) || !/^[A-Za-z0-9._-]{1,80}$/.test(carouselId)) throw new ReviewError('NOT_FOUND', 'no such carousel');
        const carouselStore = storeFor(carouselBrand);
        if (parts.length === 5) {
          const body = await readJson(req);
          const by = text(body['by'], 80);
          if (parts[4] === 'approve') carouselStore.approveCarousel(carouselId, by);
          else carouselStore.rejectCarousel(carouselId, by, text(body['reason'], 40) as never, text(body['comment'], 500) || undefined);
          return send(res, 200, { status: carouselStore.carouselStatus(carouselId) });
        }
        if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
        const { count, slides, captions } = carouselStore.carouselSlides(carouselId);
        return send(res, 200, {
          id: carouselId, count, status: carouselStore.carouselStatus(carouselId),
          slides: slides.map((item, index) => (item ? { position: index + 1, ...summary(item) } : { position: index + 1, versionId: null, status: 'missing' })),
          captions: captions.map((c) => summary(c)),
          reasons: REJECTION_REASONS,
        });
      }
      if (parts[0] !== 'review' || parts[1] !== 'posts') return send(res, 404, { error: 'Not found' });

      if (parts.length === 2) {
        if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
        const status = url.searchParams.get('status') ?? 'pending';
        if (!(STATUSES as readonly string[]).includes(status)) return send(res, 400, { error: `status must be one of ${STATUSES.join(', ')}` });
        // A brand whose log is damaged is reported, never silently left out: an owner must not be told "nothing is waiting" when the record is broken.
        const problems: Array<{ brand: string; message: string }> = [];
        const items = scope.visible(brands()).flatMap((brand) => {
          try {
            const all = storeFor(brand).list();
            return status === 'all' ? all : status === 'open' ? all.filter((i) => i.status === 'pending' || i.status === 'held') : all.filter((i) => i.status === status);
          } catch (error) {
            if (error instanceof ReviewError && (error.code === 'TAMPERED' || error.code === 'LOCKED')) {
              problems.push({ brand, message: error.code === 'TAMPERED' ? 'The review record needs administrator recovery.' : 'The review record is busy or locked.' });
              return [];
            }
            throw error;
          }
        });
        const jobsOf = new Map<string, Job[]>();
        const redrawOf = (i: ReviewItem) => redrawFor(i, jobsOf.get(i.version.brand) ?? (jobsOf.set(i.version.brand, jobs.list({ brand: i.version.brand })), jobsOf.get(i.version.brand) as Job[]));
        return send(res, 200, { posts: items.sort((a, b) => b.version.createdAt.localeCompare(a.version.createdAt)).map((i) => summary(i, redrawOf(i))), problems, reasons: REJECTION_REASONS });
      }

      const versionId = decodeURIComponent(parts[2] ?? '');
      const action = parts[3];
      scope.guard(versionId.split('.')[0] ?? '', action === 'approve' || action === 'reject' || action === 'redraw' || action === 'words');
      const store = storeOf(versionId);
      if (parts.length === 3 && req.method === 'GET') {
        const item = store.get(versionId);
        return send(res, 200, { ...item, ...redrawFor(item, jobs.list({ brand: item.version.brand })), history: store.history(item.version.postId, item.version.network ?? '').map((h) => summary(h)) });
      }
      if (parts.length === 4 && action === 'image' && req.method === 'GET') {
        const bytes = store.previewBytes(versionId);
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': bytes.length, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
        return void res.end(bytes);
      }
      if (parts.length === 4 && action === 'logo' && req.method === 'GET') {
        const { path, ext } = store.logoPath(versionId);
        const bytes = readFileSync(path);
        const type = ({ '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' } as Record<string, string>)[ext] ?? 'application/octet-stream';
        // The logo is a file from a website: it is shown only as a picture, and nothing in it may run.
        res.writeHead(200, { 'Content-Type': type, 'Content-Length': bytes.length, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox" });
        return void res.end(bytes);
      }
      if (parts.length === 4 && action === 'download' && req.method === 'GET') {
        const { bytes, version } = store.approvedFile(versionId);
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': bytes.length, 'Content-Disposition': `attachment; filename="${version.postId}-v${version.versionNumber}.jpg"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
        return void res.end(bytes);
      }
      // New words for a picture that was already drawn: the same picture with a new caption, for its own network, checked like any edit and approved again.
      // The headline is on the picture, so it cannot change here (that is a new picture).
      if (parts.length === 4 && action === 'words' && req.method === 'POST') {
        const body = await readJson(req);
        if (body['headline'] !== undefined) throw new ReviewError('INVALID', 'the headline is printed on the picture; a new headline needs a new picture');
        if (typeof body['caption'] !== 'string') throw new ReviewError('INVALID', 'caption must be text');
        const item = store.get(versionId);
        const v = item.version;
        const facts = (await loadFacts(join(root, v.brand)))?.facts ?? [];
        const { caption } = checkNewWords({ caption: body['caption'], wasHeadline: v.headline, wasCaption: v.caption, ...(v.network && isNetwork(v.network) ? { network: v.network } : {}), factIds: v.factIds, facts });
        // The hashtags the version already carries stay; only the words change.
        const { hashtags } = splitTrailingHashtags(v.caption);
        const created = store.addCaptionVersion(versionId, composeVariant({ caption, hashtags }), scope.by(body['by']));
        const made = store.get(created.versionId);
        return send(res, 200, { version: summary(made, redrawFor(made, jobs.list({ brand: v.brand }))) });
      }
      // Another picture for one network of a post: only the newest, not approved, and only as many times as the allowance says. Every picture still waits for approval.
      if (parts.length === 4 && action === 'redraw' && req.method === 'POST') {
        const body = await readJson(req);
        const item = store.get(versionId);
        const v = item.version;
        if (item.status === 'approved') throw new ReviewError('CONFLICT', 'this poster is approved: withdraw it first, then it can be drawn again');
        if (item.status === 'superseded') throw new ReviewError('STALE', 'a newer picture of this post exists');
        const spec = { kind: 'redraw' as const, brand: v.brand, site: siteOf(v.brand), by: scope.by(body['by']), planFile: v.planFile, postId: v.postId, ...(v.network ? { network: v.network } : {}) };
        const earlier = jobs.list({ brand: v.brand }).filter((j) => j.key === keyOf(spec));
        const active = earlier.find((j) => j.state === 'queued' || j.state === 'running');
        if (active) return send(res, 200, { job: active, created: false });
        if (earlier.filter(countsAgainstCap).length >= redrawCap) throw new ReviewError('LIMIT', 'this poster has already been drawn again as many times as is allowed');
        if (v.network && isNetwork(v.network)) assertPictureRoom(v.brand, { [v.network]: 1 });
        const { job, created } = jobs.enqueue(spec);
        return send(res, created ? 202 : 200, { job, created });
      }
      if (parts.length === 4 && (action === 'approve' || action === 'reject') && req.method === 'POST') {
        const body = await readJson(req);
        const by = scope.by(body['by']);
        if (action === 'reject' && text(body['reason'], 40) === 'expired') throw new ReviewError('INVALID', 'that reason is only recorded by the system');
        const decision = action === 'approve' ? store.approve(versionId, by) : store.reject(versionId, by, text(body['reason'], 40) as never, text(body['comment'], 500) || undefined);
        return send(res, 200, { decision, status: store.get(versionId).status });
      }
      return send(res, 404, { error: 'Not found' });
    } catch (error) {
      fail(res, error);
    }
  });
  // Nobody decided in time: look now and then, with no one acting. Only product-owned brands are ever touched.
  if (expiryDays > 0) {
    const sweep = (): void => {
      try {
        sweepExpired({ brandsRoot: root, owners, now: new Date(), days: expiryDays, ...(options.lockTimeoutMs ? { lockTimeoutMs: options.lockTimeoutMs } : {}) });
      } catch (error) {
        console.error(`expiry sweep failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    const timer = setInterval(sweep, options.sweepEveryMs ?? 3_600_000);
    timer.unref();
    server.on('listening', sweep);
    server.on('close', () => clearInterval(timer));
  }
  // The weekly draw: a later week of a customer's batch is drawn by the system on the Thursday before it begins; a week that passed undrawn is given up.
  const weeklyEvery = options.weeklyDrawEveryMs ?? 600_000;
  if (weeklyEvery > 0 && process.env['AUTO_WEEK_DRAW'] !== 'false') {
    const weekly = (): void => {
      try {
        runWeeklyDraws({
          brandsRoot: root, jobs, owners, now: (options.now ?? (() => new Date()))(), made: madeFor,
          room: (brand, needed) => {
            try {
              assertPictureRoom(brand, needed);
              return null;
            } catch (error) {
              if (error instanceof PictureLimitError) return error.message;
              throw error;
            }
          },
          siteOf: (brand) => {
            try {
              return siteOf(brand);
            } catch {
              return null;
            }
          },
          register: (brand, planFile, site) => { registerManualRelease({ brandDir: join(root, brand), siteBrand: brand, client: brand, site, planFile }); },
        });
      } catch (error) {
        console.error(`weekly draw failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    const weeklyTimer = setInterval(weekly, weeklyEvery);
    weeklyTimer.unref();
    server.on('listening', weekly);
    server.on('close', () => clearInterval(weeklyTimer));
  }
  return server;
}

if (import.meta.main) {
  const secret = process.env['REVIEW_SECRET'];
  if (!secret || secret.length < 16) throw new Error('REVIEW_SECRET must be set to a secret of at least 16 characters');
  const brandsRoot = process.env['BRANDS_ROOT'] ?? resolve('brands');
  // Only one review service may run on a brands folder: a second one refuses to start instead of competing for the same log.
  let releaseService: () => void;
  try {
    releaseService = acquireLock(join(resolve(brandsRoot), '.review-service.lock'), { timeoutMs: 0 });
  } catch (error) {
    if (error instanceof LockError) throw new Error(`another review service is already running for ${brandsRoot} (${error.message})`);
    throw error;
  }
  process.on('exit', releaseService);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => process.exit(0));
  // REVIEW_PRODUCT_SECRETS="brandbasket:<secret>,other:<secret>": each product's own secret (at least 16 characters).
  const products = (process.env['REVIEW_PRODUCT_SECRETS'] ?? '').split(',').map((entry) => entry.trim()).filter((entry) => entry !== '').map((entry) => {
    const at = entry.indexOf(':');
    return { id: entry.slice(0, at), secret: entry.slice(at + 1) };
  });
  const server = createReviewServer({ brandsRoot, secret, products });
  const port = Number(process.env['PORT'] ?? 4012);
  const host = process.env['HOST'] ?? '127.0.0.1';
  server.listen(port, host, () => console.log(`review service listening on http://${host}:${port}`));
}
