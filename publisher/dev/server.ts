/**
 * Runs the publisher's API handlers locally on 127.0.0.1:4020, for testing with the dashboard's dev server and the
 * pretend LinkedIn (dev/fake-linkedin.ts). Data goes to LOCAL_STORE_DIR, never to the real Blob store.
 *
 *   LOCAL_STORE_DIR=/some/folder CHANNEL_KEY=<64 hex> EDIT_SECRET=... node --import ./dev/resolver.ts dev/server.ts
 */
import { createServer, type IncomingMessage } from 'node:http';

const PORT = Number(process.env['PORT'] ?? 4020);

if (!process.env['LOCAL_STORE_DIR']) {
  console.error('Set LOCAL_STORE_DIR so test data never reaches the real store.');
  process.exit(1);
}
if (process.env['BLOB_READ_WRITE_TOKEN']) {
  console.error('Refusing to start with BLOB_READ_WRITE_TOKEN set: this server is for local testing only.');
  process.exit(1);
}

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { publicFile } from '../server/files.ts';
import { matchRoute } from '../server/routes.ts';

/** Where released poster pictures are served from, as in the real server (PUBLIC_DIR, else the publisher's own public folder). */
const PUBLIC_DIR = process.env['PUBLIC_DIR'] ?? join(import.meta.dirname, '..', 'public');

async function toRequest(req: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers, body: hasBody ? Buffer.concat(chunks) : undefined });
}

createServer(async (req, res) => {
  if (req.method === 'GET' || req.method === 'HEAD') {
    const file = publicFile(PUBLIC_DIR, new URL(req.url ?? '/', `http://${req.headers.host}`).pathname);
    const bytes = file ? await readFile(file).catch(() => null) : null;
    if (file && bytes) {
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': bytes.length, 'Cache-Control': 'no-store' });
      return void res.end(req.method === 'HEAD' ? undefined : bytes);
    }
  }
  const match = matchRoute(req.method ?? 'GET', new URL(req.url ?? '/', `http://${req.headers.host}`).pathname);
  if (match.kind !== 'ok') {
    res.statusCode = match.kind === 'not-found' ? 404 : 405;
    return void res.end();
  }
  const response = await (await match.route.load())(await toRequest(req));
  res.statusCode = response.status;
  response.headers.forEach((value, name) => res.setHeader(name, value));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(PORT, '127.0.0.1', () => console.log(`publisher (dev) on http://127.0.0.1:${PORT}, data in ${process.env['LOCAL_STORE_DIR']}`));
