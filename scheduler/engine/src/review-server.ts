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
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { join, resolve } from 'node:path';
import { acquireLock, LockError } from './file-lock.ts';
import { listCampaigns } from './campaign-runner.ts';
import { REJECTION_REASONS, ReviewError, ReviewStore, type ReviewItem, type ReviewStatus } from './review-store.ts';
import { CopyStage, CopyStageError } from './copy-stage.ts';
import { editCopy, type SignoffDefaults } from './copy-edit.ts';
import { displayDomain } from './ai-creative.ts';
import { loadFacts } from './evidence-pipeline.ts';
import { decideFact, FactsError, factsView } from './facts-view.ts';
import { JobError, JobStore, type JobState } from './job-store.ts';
import { CLIENT_NAME, registerManualRelease } from './manual-release.ts';
import { slugFromSite } from './analyze.ts';
import { isNetwork, NETWORKS } from './networks.ts';
import { checkStartDate, checkTime, RhythmError, weeklyRhythm } from './rhythm.ts';

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
const HTTP_STATUS: Record<ReviewError['code'], number> = { NOT_FOUND: 404, INVALID: 400, BLOCKED: 409, STALE: 409, ALREADY_DECIDED: 409, NOT_APPROVED: 409, TAMPERED: 500, LOCKED: 503 };

function fail(res: ServerResponse, error: unknown): void {
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
const COPY_STATUS: Record<CopyStageError['code'], number> = { NOT_FOUND: 404, INVALID: 400, ALREADY_DRAWN: 409, CLOSED: 409, REJECTED: 422, LOCKED: 503 };

const authorised = (req: IncomingMessage, secret: string): boolean => {
  const given = Buffer.from(String(req.headers['authorization'] ?? '').replace(/^Bearer\s+/i, ''));
  const wanted = Buffer.from(secret);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
};

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
  /** Once drawing has been asked for, the batch's choices and words are final: the runner may start at any moment, and a change in between would be lost or fail the draw. */
  const refuseIfDrawAsked = (brand: string, planFile: string): void => {
    if (jobs.list({ brand }).some((j) => j.kind === 'draw' && j.planFile === planFile)) throw new CopyStageError('ALREADY_DRAWN', 'drawing was already asked for, so this batch\'s choices and words are final');
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
      const saved = JSON.parse(readFileSync(join(root, brand, 'brand.json'), 'utf8')) as { name?: unknown; website?: unknown };
      return typeof saved.name === 'string' && saved.name.trim() !== '' ? { brandName: saved.name, domain: displayDomain(cleanSite(saved.website)) } : null;
    } catch {
      return null;
    }
  };
  const storeOf = (versionId: string): ReviewStore => storeFor(versionId.split('.')[0] ?? '');
  const brands = (): string[] => readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && BRAND.test(d.name)).map((d) => d.name);

  const summary = (item: ReviewItem) => ({
    versionId: item.version.versionId, brand: item.version.brand, postId: item.version.postId, planFile: item.version.planFile, versionNumber: item.version.versionNumber, status: item.status,
    headline: item.version.headline, caption: item.version.caption, createdAt: item.version.createdAt, costUsd: item.version.costUsd,
    ...(item.version.network ? { network: item.version.network } : {}),
    ...(item.version.width && item.version.height ? { width: item.version.width, height: item.version.height, shape: item.version.width / item.version.height >= 1.2 ? 'wide' : item.version.width / item.version.height <= 0.83 ? 'tall' : 'square' } : {}),
    ...(item.decision ? { decidedBy: item.decision.by, decidedAt: item.decision.at, reason: item.decision.reason } : {}),
  });

  return createServer(async (req, res) => {
    try {
      if (!authorised(req, options.secret)) return send(res, 401, { error: 'Not allowed' });
      const url = new URL(req.url ?? '/', 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);
      // The facts found on a brand's site: read them, and remove, confirm or put back one.
      if (parts[0] === 'review' && parts[1] === 'brands' && parts[3] === 'facts') {
        const factsBrand = decodeURIComponent(parts[2] ?? '');
        if (!BRAND.test(factsBrand) || !brands().includes(factsBrand)) throw new ReviewError('NOT_FOUND', 'no such brand');
        const factsDir = join(root, factsBrand);
        if (parts.length === 4 && req.method === 'GET') return send(res, 200, await factsView(factsDir, factsBrand));
        const verb = parts[5];
        if (parts.length === 6 && req.method === 'POST' && (verb === 'confirm' || verb === 'remove' || verb === 'restore')) {
          text((await readJson(req))['by'], 80);
          await decideFact(factsDir, decodeURIComponent(parts[4] ?? ''), verb);
          return send(res, 200, await factsView(factsDir, factsBrand));
        }
        return send(res, 404, { error: 'Not found' });
      }
      if (parts[0] === 'review' && parts[1] === 'jobs') {
        if (parts.length === 2 && req.method === 'GET') {
          const state = url.searchParams.get('state') ?? undefined;
          const brand = url.searchParams.get('brand') ?? undefined;
          if (state !== undefined && !(JOB_STATES as readonly string[]).includes(state)) return send(res, 400, { error: `state must be one of ${JOB_STATES.join(', ')}` });
          if (brand !== undefined && !BRAND.test(brand)) return send(res, 400, { error: 'brand is not a brand name' });
          return send(res, 200, { jobs: jobs.list({ ...(brand ? { brand } : {}), ...(state ? { state: state as JobState } : {}) }) });
        }
        if (parts.length === 3 && req.method === 'GET') return send(res, 200, { job: jobs.get(decodeURIComponent(parts[2] ?? '')) });
        if (parts.length === 2 && req.method === 'POST') {
          const body = await readJson(req);
          if (body['kind'] !== 'copy') throw new ReviewError('INVALID', 'kind must be "copy" (drawing is asked for on the written batch)');
          if (body['page'] !== undefined && typeof body['page'] !== 'boolean') throw new ReviewError('INVALID', 'page must be true or false');
          const page = body['page'] === true;
          const site = cleanSite(body['site'], { keepPath: page });
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
          const { job, created } = jobs.enqueue({ kind: 'copy', brand: slugFromSite(site), site, by: text(body['by'], 80), networks: [...new Set(networks as string[])], days: spread.days, ...(page ? { page } : {}), ...(spread.weekdays ? { weekdays: spread.weekdays } : {}), ...(startDate ? { startDate } : {}), ...(time ? { time } : {}) });
          return send(res, created ? 202 : 200, { job, created });
        }
        return send(res, 404, { error: 'Not found' });
      }
      if (parts[0] === 'review' && parts[1] === 'copy') {
        if (parts.length === 2 && req.method === 'GET') {
          // A batch that was drawn is no longer waiting for choices, unless its draw stopped before it finished: it stays listed so the draw can be asked for again.
          const stopped = (brand: string, planFile: string): boolean => jobs.list({ brand }).find((j) => j.kind === 'draw' && j.planFile === planFile)?.state === 'failed';
          const batches = brands().flatMap((brand) => new CopyStage(join(root, brand), brand).list().map((b) => ({ brand, b }))).filter(({ brand, b }) => !b.closedAt && (!b.drawnAt || stopped(brand, b.planFile))).map(({ b }) => b);
          // The writer marks the words to emphasise with | on the poster; the owner reads plain words.
          const plain = batches.map((b) => ({ ...b, ...(signoffDefaultsOf(b.brand) ? { signoffDefault: signoffDefaultsOf(b.brand) } : {}), posts: b.posts.map((p) => ({ ...p, headline: p.headline.replaceAll('|', '') })) }));
          return send(res, 200, { batches: plain.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
        }
        const [, , brand = '', planFile = '', postId = '', verb = ''] = parts.map(decodeURIComponent);
        if (parts.length === 6 && req.method === 'POST' && (verb === 'keep' || verb === 'drop')) {
          if (!BRAND.test(brand) || !brands().includes(brand)) throw new ReviewError('NOT_FOUND', 'no such brand');
          const by = text((await readJson(req))['by'], 80);
          refuseIfDrawAsked(brand, planFile);
          const batch = new CopyStage(join(root, brand), brand).decide(planFile, postId, verb === 'keep' ? 'kept' : 'dropped', by);
          return send(res, 200, { batch });
        }
        // Put a whole batch away (POST .../<brand>/<planFile>/close) or change the words of one post before it is drawn (PUT .../<brand>/<planFile>/<postId>/edit).
        if (parts.length === 5 && req.method === 'POST' && parts[4] === 'close') {
          const [, , closeBrand = '', closePlan = ''] = parts.map(decodeURIComponent);
          if (!BRAND.test(closeBrand) || !brands().includes(closeBrand)) throw new ReviewError('NOT_FOUND', 'no such brand');
          const by = text((await readJson(req))['by'], 80);
          refuseIfDrawAsked(closeBrand, closePlan);
          return send(res, 200, { batch: new CopyStage(join(root, closeBrand), closeBrand).close(closePlan, by) });
        }
        if (parts.length === 5 && req.method === 'POST' && parts[4] === 'draw') {
          const [, , drawBrand = '', drawPlan = ''] = parts.map(decodeURIComponent);
          if (!BRAND.test(drawBrand) || !brands().includes(drawBrand)) throw new ReviewError('NOT_FOUND', 'no such brand');
          const drawBody = await readJson(req);
          const by = text(drawBody['by'], 80);
          // The client the posters belong to (the name its channels are connected under); the website's own name when none is given.
          const client = drawBody['client'] === undefined ? drawBrand : text(drawBody['client'], 63);
          if (!CLIENT_NAME.test(client)) throw new ReviewError('INVALID', 'client must be lowercase letters, digits and dashes');
          const batch = new CopyStage(join(root, drawBrand), drawBrand).get(drawPlan);
          if (batch.closedAt) throw new CopyStageError('CLOSED', 'this batch was put away, so it cannot be drawn');
          // A batch already asked for (or drawn) answers with its job; a draw buys pictures, so it is only ever started once. After a draw has failed,
          // "retry" asks for one more that draws only the kept posts that still have no picture.
          const latest = jobs.list({ brand: drawBrand }).find((j) => j.kind === 'draw' && j.planFile === drawPlan);
          const retry = drawBody['retry'] === true && latest?.state === 'failed';
          if (latest && !retry) return send(res, 200, { job: latest, created: false });
          if (!latest && batch.drawnAt) throw new CopyStageError('ALREADY_DRAWN', 'this batch was already drawn');
          if (!batch.posts.some((p) => p.state === 'kept')) throw new CopyStageError('REJECTED', 'keep at least one post before drawing');
          const drawSite = siteOf(drawBrand);
          // Approved posters of this batch reach the calendar through the campaign runner's release pass, for this client and only the networks written for.
          // The record is made first: a draw that is queued without it would buy pictures that could never be released.
          registerManualRelease({ brandDir: join(root, drawBrand), siteBrand: drawBrand, client, site: drawSite, planFile: drawPlan });
          const { job, created } = jobs.enqueue({ kind: 'draw', brand: drawBrand, site: drawSite, by, planFile: drawPlan, ...(retry ? { retry: true } : {}) });
          return send(res, created ? 202 : 200, { job, created });
        }
        if (parts.length === 6 && req.method === 'PUT' && verb === 'edit') {
          if (!BRAND.test(brand) || !brands().includes(brand)) throw new ReviewError('NOT_FOUND', 'no such brand');
          const body = await readJson(req);
          refuseIfDrawAsked(brand, planFile);
          const brandDir = join(root, brand);
          const facts = (await loadFacts(brandDir))?.facts ?? [];
          const headline = typeof body['headline'] === 'string' ? body['headline'] : undefined;
          const caption = typeof body['caption'] === 'string' ? body['caption'] : undefined;
          const network = typeof body['network'] === 'string' ? body['network'] : undefined;
          const brandName = typeof body['brandName'] === 'string' ? body['brandName'] : undefined;
          const domain = typeof body['domain'] === 'string' ? body['domain'] : undefined;
          const signoffDefaults = signoffDefaultsOf(brand);
          return send(res, 200, { batch: editCopy({ brandDir, brand, planFile, postId, ...(headline !== undefined ? { headline } : {}), ...(caption !== undefined ? { caption } : {}), ...(network !== undefined ? { network } : {}), ...(brandName !== undefined ? { brandName } : {}), ...(domain !== undefined ? { domain } : {}), ...(signoffDefaults ? { signoffDefaults } : {}), by: text(body['by'], 80), facts }) });
        }
        return send(res, 404, { error: 'Not found' });
      }
      // What is being made for each client's plans, for the dashboard's status panel. Read only.
      if (parts[0] === 'review' && parts[1] === 'campaigns' && parts.length === 2) {
        if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
        return send(res, 200, { campaigns: await listCampaigns(options.brandsRoot) });
      }
      // Approve a whole topic in one step: every network's picture of it that is waiting. Each is still its own decision, on its own exact version.
      if (parts[0] === 'review' && parts[1] === 'topics' && parts.length === 6 && parts[5] === 'approve' && req.method === 'POST') {
        const [, , topicBrand = '', topicPlan = '', topicPost = ''] = parts.map(decodeURIComponent);
        if (!BRAND.test(topicBrand) || !brands().includes(topicBrand)) throw new ReviewError('NOT_FOUND', 'no such brand');
        const by = text((await readJson(req))['by'], 80);
        const topicStore = storeFor(topicBrand);
        const waiting = topicStore.list().filter((i) => i.status === 'pending' && i.version.postId === topicPost && i.version.planFile === topicPlan);
        if (waiting.length === 0) throw new ReviewError('NOT_FOUND', 'nothing is waiting for approval for that topic');
        const decisions = waiting.map((i) => { topicStore.approve(i.version.versionId, by); return { versionId: i.version.versionId, network: i.version.network ?? null, status: topicStore.get(i.version.versionId).status }; });
        return send(res, 200, { decisions });
      }
      if (parts[0] !== 'review' || parts[1] !== 'posts') return send(res, 404, { error: 'Not found' });

      if (parts.length === 2) {
        if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
        const status = url.searchParams.get('status') ?? 'pending';
        if (!(STATUSES as readonly string[]).includes(status)) return send(res, 400, { error: `status must be one of ${STATUSES.join(', ')}` });
        // A brand whose log is damaged is reported, never silently left out: an owner must not be told "nothing is waiting" when the record is broken.
        const problems: Array<{ brand: string; message: string }> = [];
        const items = brands().flatMap((brand) => {
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
        return send(res, 200, { posts: items.sort((a, b) => b.version.createdAt.localeCompare(a.version.createdAt)).map(summary), problems, reasons: REJECTION_REASONS });
      }

      const versionId = decodeURIComponent(parts[2] ?? '');
      const action = parts[3];
      const store = storeOf(versionId);
      if (parts.length === 3 && req.method === 'GET') {
        const item = store.get(versionId);
        return send(res, 200, { ...item, history: store.history(item.version.postId, item.version.network ?? '').map(summary) });
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
      if (parts.length === 4 && (action === 'approve' || action === 'reject') && req.method === 'POST') {
        const body = await readJson(req);
        const by = text(body['by'], 80);
        const decision = action === 'approve' ? store.approve(versionId, by) : store.reject(versionId, by, text(body['reason'], 40) as never, text(body['comment'], 500) || undefined);
        return send(res, 200, { decision, status: store.get(versionId).status });
      }
      return send(res, 404, { error: 'Not found' });
    } catch (error) {
      fail(res, error);
    }
  });
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
  const server = createReviewServer({ brandsRoot, secret });
  const port = Number(process.env['PORT'] ?? 4012);
  const host = process.env['HOST'] ?? '127.0.0.1';
  server.listen(port, host, () => console.log(`review service listening on http://${host}:${port}`));
}
