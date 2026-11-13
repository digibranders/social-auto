/**
 * Reading a customer's website and writing posts for it (the AI side). Called by a product's server with its own key; a product only reaches the jobs of
 * workspaces it created. The content engine does the work; this handler only starts it, under the workspace's own brand, and tells how it is going.
 *
 * POST /api/v1/site-jobs   {"externalId", "site": "acme.com", "networks"?: ["instagram", "linkedin"], "page"?: true}
 *                          starts a batch of written posts (nothing is drawn or paid for yet). 202 with {"job", "created": true}; 200 with the job that is
 *                          already waiting or running when there is one ("created": false). The rhythm is fixed: 2 posts per network per week.
 * GET  /api/v1/site-jobs?externalId=...[&jobId=...]   the workspace's jobs, newest first, or one of them
 *
 * `X-Social-Actor` (optional here) names the person who asked; it is recorded with the job.
 */
import { actorOf, engineActor } from '../../lib/actor.js';
import { apiError, errorResponse } from '../../lib/api-error.js';
import { channelsFor } from '../../lib/channels.js';
import { normalizePage, normalizeWebsite, setWebsite } from '../../lib/clients.js';
import { EngineError, type JobView } from '../../lib/engine-client.js';
import { json } from '../../lib/http.js';
import { productLimitsOff } from '../../lib/limits-switch.js';
import { EditError } from '../../lib/overrides.js';
import { archivedAnswer, engineFor, workspaceFor } from '../../lib/product-workspace.js';
import { syncConnected } from '../../lib/connected-sync.js';
import { nextMonday } from '../../lib/plan-days.js';
import { loadChannels, loadClients, saveClients } from '../../lib/store.js';

const MAX_BODY_BYTES = 4 * 1024;
const NETWORKS = ['instagram', 'facebook', 'linkedin', 'google'] as const;
type Network = (typeof NETWORKS)[number];
/** The rhythm of a batch: a monthly plan of 4 weeks at 5 posts a week unless the product asks for less. The ceilings are fixed here, never chosen by a product. */
const DEFAULT_WEEKS = 4;
const MAX_WEEKS = 4;
const DEFAULT_POSTS_PER_WEEK = 5;
const MAX_POSTS_PER_WEEK = 5;
/** How many batches one customer may start, so a product cannot spend without limit: a job that is still waiting does not count. */
const MAX_JOBS_PER_DAY = 3;
const MAX_JOBS_PER_MONTH = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

/** A website without its scheme and a leading www., so "www.acme.com" and "acme.com" are the same one. */
const hostOf = (site: string): string => site.replace(/^https?:\/\//, '').replace(/^www\./, '');

const isNetwork = (value: unknown): value is Network => typeof value === 'string' && (NETWORKS as readonly string[]).includes(value);

/** What the engine refused, in the product API's words. */
function engineFailure(error: unknown, what: string): Response {
  return errorResponse(error, what);
}

export async function POST(request: Request): Promise<Response> {
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return apiError(413, 'REQUEST_TOO_LARGE', 'request too large');
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (typeof body !== 'object' || body === null) return apiError(400, 'INVALID_REQUEST', 'send JSON');
  const found = await workspaceFor(request, body['externalId']);
  if (found instanceof Response) return found;
  const { product, workspace } = found;
  const away = archivedAnswer(workspace);
  if (away) return away;
  try {
    const engine = engineFor(product.id, workspace.brand);
    if (engine instanceof Response) return engine;

    let site: string;
    try {
      site = normalizeWebsite(body['site']);
    } catch (error) {
      if (error instanceof EditError) return apiError(400, 'INVALID_SITE', error.message);
      throw error;
    }
    if (workspace.website !== undefined && hostOf(workspace.website) !== hostOf(site)) {
      return apiError(400, 'SITE_MISMATCH', `this customer already uses ${hostOf(workspace.website)}, so a different website cannot be used`);
    }

    const { file: channels } = await loadChannels();
    const connected = [...new Set(channelsFor(channels, workspace.brand).map((c) => c.platform))].filter(isNetwork);
    const asked = body['networks'];
    if (asked !== undefined && (!Array.isArray(asked) || asked.length === 0 || !asked.every(isNetwork))) return apiError(400, 'INVALID_NETWORKS', `networks must be a list of: ${NETWORKS.join(', ')}`);
    const networks = [...new Set((asked as Network[] | undefined) ?? connected)];
    if (networks.length === 0) return apiError(400, 'CHANNEL_NOT_CONNECTED', 'connect at least one account first, or say which networks to write for');
    if (body['page'] !== undefined && typeof body['page'] !== 'boolean') return apiError(400, 'INVALID_REQUEST', 'page must be true or false');
    const whole = (value: unknown, fallback: number, max: number): number | null => (value === undefined ? fallback : typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max ? value : null);
    const weeks = whole(body['weeks'], DEFAULT_WEEKS, MAX_WEEKS);
    if (weeks === null) return apiError(400, 'INVALID_REQUEST', `weeks must be a whole number from 1 to ${MAX_WEEKS}`);
    const postsPerWeek = whole(body['postsPerWeek'], DEFAULT_POSTS_PER_WEEK, MAX_POSTS_PER_WEEK);
    if (postsPerWeek === null) return apiError(400, 'INVALID_REQUEST', `postsPerWeek must be a whole number from 1 to ${MAX_POSTS_PER_WEEK}`);
    const startAsked = body['startDate'];
    if (startAsked !== undefined && (typeof startAsked !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(startAsked))) return apiError(400, 'INVALID_REQUEST', 'startDate must be a day like 2026-12-07');
    // The first post goes out on a Monday unless the product says otherwise: the next Monday (India time) after today.
    const startDate = typeof startAsked === 'string' ? startAsked : nextMonday(Date.now());

    // One page of the website: the poster service reads that page only, so it is given the page's address (the customer's saved website stays the host alone).
    let readFrom = site;
    if (body['page'] === true) {
      try {
        readFrom = normalizePage(body['site']);
      } catch (error) {
        if (error instanceof EditError) return apiError(400, 'INVALID_SITE', error.message);
        throw error;
      }
    }

    const actor = request.headers.has('x-social-actor') ? actorOf(request) : null;
    const by = engineActor(product.id, actor);

    // A batch already waiting or running is returned as it is; otherwise the day and month limits apply.
    const jobs = await engine.listJobs(by);
    const standing = jobs.find((j) => j.kind === 'write' && (j.state === 'queued' || j.state === 'running'));
    // PRODUCT_LIMITS=off lifts the day and month limits (testing only).
    if (!standing && !productLimitsOff()) {
      const now = Date.now();
      const writes = jobs.filter((j) => j.kind === 'write');
      const since = (ms: number): number => writes.filter((j) => now - Date.parse(j.createdAt) < ms).length;
      if (since(DAY_MS) >= MAX_JOBS_PER_DAY) return apiError(429, 'JOB_LIMIT_REACHED', `a customer can start ${MAX_JOBS_PER_DAY} batches a day; try again tomorrow`);
      if (since(30 * DAY_MS) >= MAX_JOBS_PER_MONTH) return apiError(429, 'JOB_LIMIT_REACHED', `a customer can start ${MAX_JOBS_PER_MONTH} batches a month; try again later`);
    }

    // The first website a customer gives is the one they keep. It is saved before the job starts, so two first calls cannot give one customer two websites.
    let bound = false;
    if (workspace.website === undefined) {
      const { file, etag } = await loadClients();
      await saveClients(setWebsite(file, workspace.brand, site), etag);
      bound = true;
    }
    try {
      const made = await engine.startSiteJob({ site: readFrom, networks, page: body['page'] === true, weeks, postsPerWeek, startDate, actor: by });
      // The brand is the product's from its first job on: the poster service is told which networks are connected now, before anything is drawn.
      await syncConnected(engine, workspace.brand, by);
      return json(made.created ? 202 : 200, { job: made.job, created: made.created });
    } catch (error) {
      // A job that never started must not leave the customer tied to this website.
      if (bound) {
        const { file, etag } = await loadClients();
        await saveClients(setWebsite(file, workspace.brand, null), etag).catch(() => undefined);
      }
      throw error;
    }
  } catch (error) {
    return engineFailure(error, 'start the batch');
  }
}

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const found = await workspaceFor(request, params.get('externalId'));
  if (found instanceof Response) return found;
  try {
    const engine = engineFor(found.product.id, found.workspace.brand);
    if (engine instanceof Response) return engine;
    const by = engineActor(found.product.id, request.headers.has('x-social-actor') ? actorOf(request) : null);
    const jobId = params.get('jobId');
    if (jobId !== null) {
      try {
        return json(200, { job: await engine.getJob(jobId, by) });
      } catch (error) {
        if (error instanceof EngineError && error.status === 404) return apiError(404, 'JOB_NOT_FOUND', 'no such job');
        throw error;
      }
    }
    const jobs: JobView[] = await engine.listJobs(by);
    return json(200, { jobs });
  } catch (error) {
    return engineFailure(error, 'read the batches');
  }
}
