/**
 * Development server: serves public/ and runs the real API handlers, with a mock status feed.
 *
 *   npm run dev                       (sign in with the password printed below)
 *   MOCK_SCENARIO=missed npm run dev  (also: down)
 */
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mockStatus } from './mock-status.ts';

const PORT = Number(process.env['PORT'] ?? 4010);
const FEED_PORT = 4011;
const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));
const POSTERS_DIR = fileURLToPath(new URL('../../publisher/public', import.meta.url));
const PASSWORD = 'dev-password';
const FEED_SECRET = 'dev-feed-secret';
const scenario = process.env['MOCK_SCENARIO'] ?? 'ok';

/** With STATUS_URL and STATUS_SECRET already set, the dashboard reads that feed instead of the mock. */
const useMock = !process.env['STATUS_URL'];

process.env['DASHBOARD_PASSWORD'] = PASSWORD;
process.env['SESSION_SECRET'] = 'dev-session-secret-dev-session-secret';
if (useMock) {
  process.env['STATUS_URL'] = `http://127.0.0.1:${FEED_PORT}/status`;
  process.env['STATUS_SECRET'] = FEED_SECRET;
}
process.env['COOKIE_INSECURE'] = '1';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

async function toRequest(req: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers, body: hasBody ? Buffer.concat(chunks) : undefined });
}

async function send(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, name) => {
    if (name !== 'set-cookie') res.setHeader(name, value);
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) res.setHeader('set-cookie', cookies);
  res.end(Buffer.from(await response.arrayBuffer()));
}

async function serveFile(res: ServerResponse, root: string, relative: string): Promise<void> {
  const path = normalize(join(root, relative));
  if (!path.startsWith(root)) return void (res.statusCode = 403), void res.end();
  try {
    const body = await readFile(path);
    res.setHeader('content-type', TYPES[extname(path)] ?? 'application/octet-stream');
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end('Not found');
  }
}

import { matchRoute } from '../server/routes.ts';

const app = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const path = url.pathname;
  // Edited pictures normally come from the publisher; when one is configured, relay them for local testing.
  if (path === '/api/edited-image' && process.env['EDIT_URL']) {
    const relayed = await fetch(new URL(`/api/edited-image${url.search}`, process.env['EDIT_URL']));
    return send(res, relayed);
  }
  if (path.startsWith('/api/')) {
    const match = matchRoute(req.method ?? 'GET', path);
    if (match.kind !== 'ok') {
      res.statusCode = match.kind === 'not-found' ? 404 : 405;
      return void res.end();
    }
    const handler = await match.route.load();
    return send(res, await handler(await toRequest(req)));
  }
  if (path.startsWith('/posts/')) return serveFile(res, join(POSTERS_DIR), path.slice(1));
  if (path === '/') return serveFile(res, PUBLIC_DIR, 'index.html');
  if (path === '/login') return serveFile(res, PUBLIC_DIR, 'login.html');
  return serveFile(res, PUBLIC_DIR, path.slice(1));
});

const feed = createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${FEED_SECRET}`) {
    res.statusCode = 401;
    return void res.end();
  }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(mockStatus(scenario, `http://localhost:${PORT}`)));
});

if (useMock) feed.listen(FEED_PORT, '127.0.0.1');
app.listen(PORT, () => {
  const source = useMock ? `mock scenario "${scenario}"` : `feed ${process.env['STATUS_URL']}`;
  console.log(`Dashboard (dev, ${source}): http://localhost:${PORT}   password: ${PASSWORD}`);
});
