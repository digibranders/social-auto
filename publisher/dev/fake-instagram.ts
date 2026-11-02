/**
 * A pretend Instagram (Instagram API with Instagram Login) for local testing: it answers the way Meta's documentation
 * says and refuses malformed requests. It proves OUR side works; it cannot prove Instagram accepts it.
 *
 *   node --import ./dev/resolver.ts dev/fake-instagram.ts      (listens on 127.0.0.1:4042)
 *   GET /__state    the posts it has received and how often tokens were renewed
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

const PORT = 4042;
const BASE = `http://127.0.0.1:${PORT}`;
const CODE = 'fake-ig-code';
const SHORT_TOKEN = 'fake-ig-short-token';
const LONG_TOKEN = 'fake-ig-long-token';
const ACCOUNT = { user_id: '17841400000000001', username: 'acme_foods' };

const containers = new Map<string, { image: string; caption: string }>();
const published: Array<{ account: string; image: string; caption: string }> = [];
let renewals = 0;

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
const known = (token: string | null): boolean => token === LONG_TOKEN;

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', BASE);
  const route = `${req.method} ${url.pathname}`;
  try {
    const body = req.method === 'POST' ? await form(req) : new URLSearchParams();
    if (route === 'GET /oauth/authorize') {
      const redirect = url.searchParams.get('redirect_uri');
      const state = url.searchParams.get('state');
      const scopes = (url.searchParams.get('scope') ?? '').split(/[ ,]/);
      if (!redirect || !state || !url.searchParams.get('client_id')) return refused(res, 'missing client_id, redirect_uri or state');
      if (url.searchParams.get('response_type') !== 'code') return refused(res, 'response_type must be code');
      if (!scopes.includes('instagram_business_basic') || !scopes.includes('instagram_business_content_publish')) return refused(res, 'missing scope');
      const back = new URL(redirect);
      back.searchParams.set('code', CODE);
      back.searchParams.set('state', state);
      res.writeHead(302, { location: back.toString() });
      return void res.end();
    }
    if (route === 'POST /oauth/access_token') {
      if (!body.get('client_id') || !body.get('client_secret') || !body.get('redirect_uri')) return send(res, 400, { error_type: 'OAuthException', error_message: 'missing app credentials' });
      if (body.get('grant_type') !== 'authorization_code' || body.get('code') !== CODE) return send(res, 400, { error_type: 'OAuthException', error_message: 'bad code' });
      return send(res, 200, { access_token: SHORT_TOKEN, user_id: Number(ACCOUNT.user_id), permissions: ['instagram_business_basic', 'instagram_business_content_publish'] });
    }
    if (route === 'GET /access_token') {
      if (url.searchParams.get('grant_type') !== 'ig_exchange_token' || !url.searchParams.get('client_secret')) return refused(res, 'bad exchange request');
      return url.searchParams.get('access_token') === SHORT_TOKEN
        ? send(res, 200, { access_token: LONG_TOKEN, token_type: 'bearer', expires_in: 5_183_944 })
        : refused(res, 'bad short-lived token');
    }
    if (route === 'GET /refresh_access_token') {
      if (url.searchParams.get('grant_type') !== 'ig_refresh_token' || !known(url.searchParams.get('access_token'))) return refused(res, 'bad refresh request');
      renewals += 1;
      return send(res, 200, { access_token: LONG_TOKEN, token_type: 'bearer', expires_in: 5_183_944 });
    }
    if (route === 'GET /__state') return send(res, 200, { published, renewals });

    const path = url.pathname.replace(/^\/v23\.0/, '');
    if (!known(url.searchParams.get('access_token')) && !known(body.get('access_token'))) return refused(res, 'invalid access token');
    if (req.method === 'GET' && path === '/me') return send(res, 200, { user_id: ACCOUNT.user_id, username: ACCOUNT.username });
    if (req.method === 'GET' && /^\/container\d+$/.test(path)) return send(res, 200, { status_code: 'FINISHED', id: path.slice(1) });
    const media = /^\/(\d+)\/media$/.exec(path);
    if (req.method === 'POST' && media) {
      if (media[1] !== ACCOUNT.user_id) return refused(res, 'unknown account');
      if (!body.get('image_url') || !body.get('caption')) return refused(res, 'image_url and caption are required');
      const id = `container${containers.size + 1}`;
      containers.set(id, { image: body.get('image_url') as string, caption: body.get('caption') as string });
      return send(res, 200, { id });
    }
    const publish = /^\/(\d+)\/media_publish$/.exec(path);
    if (req.method === 'POST' && publish) {
      const container = containers.get(body.get('creation_id') ?? '');
      if (!container) return refused(res, 'unknown creation_id');
      published.push({ account: publish[1] as string, ...container });
      return send(res, 200, { id: `media${published.length}` });
    }
    const mediaItem = /^\/media(\d+)$/.exec(path);
    if (req.method === 'GET' && mediaItem) return send(res, 200, { permalink: `https://www.instagram.com/p/fake${mediaItem[1]}/` });
    return send(res, 404, { error: { message: `no such route ${route}` } });
  } catch (error) {
    return send(res, 500, { error: { message: error instanceof Error ? error.message : String(error) } });
  }
}).listen(PORT, '127.0.0.1', () => console.log(`fake Instagram on ${BASE}`));
