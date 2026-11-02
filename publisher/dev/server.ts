/**
 * Runs the publisher's API handlers locally on 127.0.0.1:4020, for testing with the dashboard's dev server and the
 * pretend LinkedIn (dev/fake-linkedin.ts). Data goes to LOCAL_STORE_DIR, never to the real Blob store.
 *
 *   LOCAL_STORE_DIR=/some/folder CHANNEL_KEY=<64 hex> EDIT_SECRET=... node --import ./dev/resolver.ts dev/server.ts
 */
import { createServer, type IncomingMessage } from 'node:http';

const PORT = 4020;

if (!process.env['LOCAL_STORE_DIR']) {
  console.error('Set LOCAL_STORE_DIR so test data never reaches the real store.');
  process.exit(1);
}
if (process.env['BLOB_READ_WRITE_TOKEN']) {
  console.error('Refusing to start with BLOB_READ_WRITE_TOKEN set: this server is for local testing only.');
  process.exit(1);
}

type Handler = (request: Request) => Response | Promise<Response>;
const routes: Record<string, { method: string; load: () => Promise<Handler> } | undefined> = {
  '/api/cron': { method: 'GET', load: () => import('../api/cron.ts').then((m) => m.GET) },
  '/api/status': { method: 'GET', load: () => import('../api/status.ts').then((m) => m.GET) },
  '/api/channels': { method: 'POST', load: () => import('../api/channels.ts').then((m) => m.POST) },
  '/api/clients': { method: 'POST', load: () => import('../api/clients.ts').then((m) => m.POST) },
  '/api/manual': { method: 'POST', load: () => import('../api/manual.ts').then((m) => m.POST) },
  '/api/edit': { method: 'POST', load: () => import('../api/edit.ts').then((m) => m.POST) },
  '/api/edited-image': { method: 'GET', load: () => import('../api/edited-image.ts').then((m) => m.GET) },
  '/api/linkedin-connect': { method: 'POST', load: () => import('../api/linkedin-connect.ts').then((m) => m.POST) },
};

async function toRequest(req: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers, body: hasBody ? Buffer.concat(chunks) : undefined });
}

createServer(async (req, res) => {
  const route = routes[new URL(req.url ?? '/', `http://${req.headers.host}`).pathname];
  if (!route || req.method !== route.method) {
    res.statusCode = route ? 405 : 404;
    return void res.end();
  }
  const response = await (await route.load())(await toRequest(req));
  res.statusCode = response.status;
  response.headers.forEach((value, name) => res.setHeader(name, value));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(PORT, '127.0.0.1', () => console.log(`publisher (dev) on http://127.0.0.1:${PORT}, data in ${process.env['LOCAL_STORE_DIR']}`));
