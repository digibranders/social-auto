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
 *   GET  /review/copy                                                              the written posts waiting to be kept or dropped, before any picture is bought
 *   POST /review/copy/<brand>/<week-NN.json>/<postId>/keep|drop   {"by":"..."}
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

const BRAND = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MAX_BODY_BYTES = 8 * 1024;
const STATUSES: readonly (ReviewStatus | 'all' | 'open')[] = ['pending', 'approved', 'rejected', 'blocked', 'superseded', 'held', 'all', 'open'];

export interface ReviewServerOptions {
  brandsRoot: string;
  secret: string;
  /** How long a change waits for another process's lock before the request is answered "busy" (tests shorten it). */
  lockTimeoutMs?: number;
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(text);
}

const HTTP_STATUS: Record<ReviewError['code'], number> = { NOT_FOUND: 404, INVALID: 400, BLOCKED: 409, STALE: 409, ALREADY_DECIDED: 409, NOT_APPROVED: 409, TAMPERED: 500, LOCKED: 503 };

function fail(res: ServerResponse, error: unknown): void {
  if (error instanceof CopyStageError) return send(res, COPY_STATUS[error.code], { error: error.message, code: error.code });
  if (error instanceof ReviewError) {
    // An integrity failure is reported without its details: the file names are for the operator's log, not the browser.
    if (error.code === 'TAMPERED') console.error(`review integrity: ${error.message}`);
    return send(res, HTTP_STATUS[error.code], { error: error.code === 'TAMPERED' ? 'The integrity check failed for this poster, so it was not released.' : error.message, code: error.code });
  }
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  send(res, 500, { error: 'Internal error' });
}

const COPY_STATUS: Record<CopyStageError['code'], number> = { NOT_FOUND: 404, INVALID: 400, ALREADY_DRAWN: 409, LOCKED: 503 };

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
  const storeOf = (versionId: string): ReviewStore => storeFor(versionId.split('.')[0] ?? '');
  const brands = (): string[] => readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && BRAND.test(d.name)).map((d) => d.name);

  const summary = (item: ReviewItem) => ({
    versionId: item.version.versionId, brand: item.version.brand, postId: item.version.postId, planFile: item.version.planFile, versionNumber: item.version.versionNumber, status: item.status,
    headline: item.version.headline, caption: item.version.caption, createdAt: item.version.createdAt, costUsd: item.version.costUsd,
    ...(item.decision ? { decidedBy: item.decision.by, decidedAt: item.decision.at, reason: item.decision.reason } : {}),
  });

  return createServer(async (req, res) => {
    try {
      if (!authorised(req, options.secret)) return send(res, 401, { error: 'Not allowed' });
      const url = new URL(req.url ?? '/', 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] === 'review' && parts[1] === 'copy') {
        if (parts.length === 2 && req.method === 'GET') {
          const batches = brands().flatMap((brand) => new CopyStage(join(root, brand), brand).list()).filter((b) => !b.drawnAt);
          return send(res, 200, { batches: batches.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
        }
        const [, , brand = '', planFile = '', postId = '', verb = ''] = parts.map(decodeURIComponent);
        if (parts.length === 6 && req.method === 'POST' && (verb === 'keep' || verb === 'drop')) {
          if (!BRAND.test(brand) || !brands().includes(brand)) throw new ReviewError('NOT_FOUND', 'no such brand');
          const by = text((await readJson(req))['by'], 80);
          const batch = new CopyStage(join(root, brand), brand).decide(planFile, postId, verb === 'keep' ? 'kept' : 'dropped', by);
          return send(res, 200, { batch });
        }
        return send(res, 404, { error: 'Not found' });
      }
      // What is being made for each client's plans, for the dashboard's status panel. Read only.
      if (parts[0] === 'review' && parts[1] === 'campaigns' && parts.length === 2) {
        if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
        return send(res, 200, { campaigns: await listCampaigns(options.brandsRoot) });
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
        return send(res, 200, { ...item, history: store.history(item.version.postId).map(summary) });
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
