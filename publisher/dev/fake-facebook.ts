/**
 * A pretend Facebook for local testing: it answers the way the Graph API documentation says and refuses
 * malformed requests. It proves OUR side works; it cannot prove Facebook accepts it.
 *
 *   node --import ./dev/resolver.ts dev/fake-facebook.ts      (listens on 127.0.0.1:4041)
 *   GET /__state    the posts it has received
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

const PORT = 4041;
const BASE = `http://127.0.0.1:${PORT}`;
const CODE = 'fake-fb-code';
const SHORT_TOKEN = 'fake-short-user-token';
const LONG_TOKEN = 'fake-long-user-token';
const PAGE = { id: '111222333', name: 'Test Page', access_token: 'fake-page-token' };

const posts: Array<{ page: string; url: string; caption: string }> = [];

async function form(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString());
}

function send(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

const refused = (res: ServerResponse, message: string): void => send(res, 400, { error: { message, type: 'OAuthException' } });

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', BASE);
  const route = `${req.method} ${url.pathname}`;
  try {
    if (route === 'GET /dialog/oauth') {
      const redirect = url.searchParams.get('redirect_uri');
      const state = url.searchParams.get('state');
      if (!redirect || !state || !url.searchParams.get('client_id')) return refused(res, 'missing client_id, redirect_uri or state');
      if (!url.searchParams.get('scope')?.includes('pages_manage_posts') && !url.searchParams.get('config_id')) return refused(res, 'missing scope');
      const back = new URL(redirect);
      back.searchParams.set('code', CODE);
      back.searchParams.set('state', state);
      res.writeHead(302, { location: back.toString() });
      return void res.end();
    }
    if (route === 'POST /oauth/access_token') {
      const body = await form(req);
      if (!body.get('client_id') || !body.get('client_secret')) return refused(res, 'missing app credentials');
      if (body.get('grant_type') === 'fb_exchange_token') {
        return body.get('fb_exchange_token') === SHORT_TOKEN ? send(res, 200, { access_token: LONG_TOKEN }) : refused(res, 'bad user token');
      }
      if (body.get('code') === CODE && body.get('redirect_uri')) return send(res, 200, { access_token: SHORT_TOKEN });
      return refused(res, 'bad code');
    }
    if (route === 'GET /me/accounts') {
      return url.searchParams.get('access_token') === LONG_TOKEN ? send(res, 200, { data: [PAGE] }) : refused(res, 'bad user token');
    }
    if (route === 'GET /__state') return send(res, 200, { posts });
    const photos = /^\/(\d+)\/photos$/.exec(url.pathname);
    if (req.method === 'POST' && photos) {
      const body = await form(req);
      if (body.get('access_token') !== PAGE.access_token) return refused(res, 'bad page token');
      if (!body.get('url') || !body.get('caption')) return refused(res, 'url and caption are required');
      posts.push({ page: photos[1] as string, url: body.get('url') as string, caption: body.get('caption') as string });
      return send(res, 200, { id: `photo${posts.length}`, post_id: `${photos[1]}_${posts.length}` });
    }
    const object = /^\/([\w]+)$/.exec(url.pathname);
    if (req.method === 'GET' && object) {
      if (url.searchParams.get('access_token') !== PAGE.access_token) return refused(res, 'bad page token');
      return send(res, 200, url.searchParams.get('fields') === 'permalink_url' ? { permalink_url: `https://www.facebook.com/${object[1]}` } : { id: object[1] });
    }
    return send(res, 404, { error: { message: `no such route ${route}` } });
  } catch (error) {
    return send(res, 500, { error: { message: error instanceof Error ? error.message : String(error) } });
  }
}).listen(PORT, '127.0.0.1', () => console.log(`fake Facebook on ${BASE}`));
