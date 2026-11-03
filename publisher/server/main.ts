/**
 * The publisher as a normal long-running server, for the VPS: the same handlers Vercel ran as functions, plus the
 * poster pictures. It listens on the local address only; nginx puts HTTPS in front.
 *
 *   node --import ./dev/resolver.ts server/main.ts
 *
 * Settings come from the environment (see deploy/). PORT defaults to 4021, HOST to 127.0.0.1.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { contentTypeFor, publicFile } from './files.js';
import { matchRoute } from './routes.js';

const PORT = Number(process.env['PORT'] ?? 4021);
const HOST = process.env['HOST'] ?? '127.0.0.1';
const PUBLIC_DIR = process.env['PUBLIC_DIR'] ?? join(import.meta.dirname, '..', 'public');
/** The biggest request accepted: a 4 MB picture plus its wrapper. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

async function toRequest(req: IncomingMessage): Promise<Request | 'too-large'> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return 'too-large';
    chunks.push(chunk as Buffer);
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(`http://${req.headers.host ?? 'localhost'}${req.url}`, { method: req.method, headers, body: hasBody ? Buffer.concat(chunks) : undefined });
}

function end(res: ServerResponse, status: number, body?: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'X-Robots-Tag': 'noindex, nofollow, noarchive, noimageindex', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

async function sendResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, name) => {
    if (name !== 'set-cookie') res.setHeader(name, value);
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) res.setHeader('set-cookie', cookies);
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, noimageindex');
  res.end(Buffer.from(await response.arrayBuffer()));
}

async function sendFile(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) return end(res, 404);
  res.writeHead(200, {
    'Content-Type': contentTypeFor(path),
    'Content-Length': info.size,
    'Cache-Control': 'public, max-age=300',
    'X-Robots-Tag': 'noindex, nofollow, noarchive, noimageindex',
  });
  if (req.method === 'HEAD') return void res.end();
  createReadStream(path).pipe(res);
}

createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/healthz') return end(res, 200, 'ok', { 'Content-Type': 'text/plain; charset=utf-8' });

    if (req.method === 'GET' || req.method === 'HEAD') {
      const file = publicFile(PUBLIC_DIR, pathname);
      if (file) return await sendFile(req, res, file);
    }

    const match = matchRoute(req.method ?? 'GET', pathname);
    if (match.kind !== 'ok') return end(res, match.kind === 'not-found' ? 404 : 405);

    const request = await toRequest(req);
    if (request === 'too-large') return end(res, 413, '{"error":"request too large"}', { 'Content-Type': 'application/json' });
    await sendResponse(res, await (await match.route.load())(request));
  } catch (error) {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    if (!res.headersSent) end(res, 500, '{"error":"internal error"}', { 'Content-Type': 'application/json' });
    else res.end();
  }
}).listen(PORT, HOST, () => console.log(`publisher listening on http://${HOST}:${PORT}`));
