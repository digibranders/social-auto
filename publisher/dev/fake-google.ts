/**
 * A pretend Google for local testing: it answers the way Google's Business Profile documentation says, and
 * refuses requests that are malformed. It proves OUR side works; it cannot prove Google accepts it. Like the real
 * one, it downloads the picture from the address it is given.
 *
 *   FAKE_GOOGLE_LOCATIONS=3 node --import ./dev/resolver.ts dev/fake-google.ts    (listens on 127.0.0.1:4050)
 *   GET /__state    what it has received (posts)
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

const PORT = 4050;
const BASE = `http://127.0.0.1:${PORT}`;
const CODE = 'fake-google-code';
const REFRESH = 'fake-refresh-token';
const COUNT = Number(process.env['FAKE_GOOGLE_LOCATIONS'] ?? 1);

const places = Array.from({ length: COUNT }, (_, i) => ({ name: `locations/${100 + i}`, title: COUNT === 1 ? 'Test Cafe' : `Test Cafe ${i + 1}` }));
const posts = new Map<string, { summary: string; picture: string; bytes: number }>();
let counter = 0;

async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function send(res: ServerResponse, status: number, data?: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(data === undefined ? undefined : JSON.stringify(data));
}

const authorized = (req: IncomingMessage): boolean => (req.headers.authorization ?? '').startsWith('Bearer fake-access-');

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', BASE);
  const route = `${req.method} ${url.pathname}`;
  try {
    if (route === 'GET /o/oauth2/v2/auth') {
      const redirect = url.searchParams.get('redirect_uri');
      if (!redirect || !url.searchParams.get('state') || !url.searchParams.get('client_id')) return send(res, 400, { error: 'invalid_request' });
      if (url.searchParams.get('scope') !== 'https://www.googleapis.com/auth/business.manage') return send(res, 400, { error: 'invalid_scope' });
      if (url.searchParams.get('access_type') !== 'offline') return send(res, 400, { error: 'refresh token needs access_type=offline' });
      const back = new URL(redirect);
      back.searchParams.set('code', CODE);
      back.searchParams.set('state', url.searchParams.get('state') as string);
      res.writeHead(302, { location: back.toString() });
      return void res.end();
    }
    if (route === 'POST /token') {
      const form = new URLSearchParams((await body(req)).toString());
      if (!form.get('client_secret') || !form.get('client_id')) return send(res, 401, { error: 'invalid_client' });
      if (form.get('grant_type') === 'authorization_code' && form.get('code') === CODE && form.get('redirect_uri')) {
        return send(res, 200, { access_token: `fake-access-${(counter += 1)}`, refresh_token: REFRESH, expires_in: 3599, scope: 'https://www.googleapis.com/auth/business.manage', token_type: 'Bearer' });
      }
      if (form.get('grant_type') === 'refresh_token' && form.get('refresh_token') === REFRESH) {
        return send(res, 200, { access_token: `fake-access-${(counter += 1)}`, expires_in: 3599, token_type: 'Bearer' });
      }
      return send(res, 400, { error: 'invalid_grant', error_description: 'Bad Request' });
    }
    if (route === 'GET /v1/accounts') return authorized(req) ? send(res, 200, { accounts: [{ name: 'accounts/1', accountName: 'Agency' }] }) : send(res, 401, { error: { message: 'unauthorized' } });
    if (route === 'GET /v1/accounts/1/locations') {
      if (!authorized(req)) return send(res, 401, { error: { message: 'unauthorized' } });
      if (url.searchParams.get('readMask') !== 'name,title') return send(res, 400, { error: { message: 'readMask is required' } });
      return send(res, 200, { locations: places });
    }
    const posting = /^\/v4\/accounts\/1\/(locations\/\d+)\/localPosts$/.exec(url.pathname);
    if (req.method === 'POST' && posting) {
      if (!authorized(req)) return send(res, 401, { error: { message: 'unauthorized' } });
      const post = JSON.parse((await body(req)).toString());
      const source: string | undefined = post.media?.[0]?.sourceUrl;
      if (!places.some((p) => p.name === posting[1])) return send(res, 404, { error: { message: 'no such location' } });
      if (post.topicType !== 'STANDARD' || typeof post.summary !== 'string' || !post.summary || post.summary.length > 1500 || post.media?.[0]?.mediaFormat !== 'PHOTO' || !source) {
        return send(res, 400, { error: { message: 'invalid local post' } });
      }
      if (/#\w/.test(post.summary)) return send(res, 400, { error: { message: 'hashtags are not expected in updates' } });
      const picture = await fetch(source).catch(() => null);
      const bytes = picture?.ok ? Buffer.from(await picture.arrayBuffer()) : null;
      if (!bytes || bytes[0] !== 0xff || bytes[1] !== 0xd8) return send(res, 400, { error: { message: 'could not download a JPEG from sourceUrl' } });
      const name = `accounts/1/${posting[1]}/localPosts/${1000 + (counter += 1)}`;
      posts.set(name, { summary: post.summary, picture: source, bytes: bytes.length });
      return send(res, 200, { name, summary: post.summary, state: 'LIVE', searchUrl: 'https://www.google.com/search?q=test+cafe' });
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/v4/accounts/1/')) {
      if (!authorized(req)) return send(res, 401, { error: { message: 'unauthorized' } });
      return posts.delete(url.pathname.slice(4)) ? send(res, 200, {}) : send(res, 404, { error: { message: 'no such post' } });
    }
    if (route === 'GET /__state') return send(res, 200, { posts: [...posts.entries()].map(([name, p]) => ({ name, ...p })) });
    return send(res, 404, { error: { message: `no route ${route}` } });
  } catch (error) {
    return send(res, 500, { error: { message: error instanceof Error ? error.message : String(error) } });
  }
}).listen(PORT, '127.0.0.1', () => console.log(`pretend Google on ${BASE}`));
