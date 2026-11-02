/**
 * A pretend LinkedIn for local testing: it answers the way LinkedIn's "Share on LinkedIn" documentation says,
 * and refuses requests that are malformed. It proves OUR side works; it cannot prove LinkedIn accepts it.
 *
 *   node --import ./dev/resolver.ts dev/fake-linkedin.ts      (listens on 127.0.0.1:4040)
 *   GET /__state    what it has received (uploads and posts)
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

const PORT = 4040;
const BASE = `http://127.0.0.1:${PORT}`;
const CODE = 'fake-code';
const TOKEN = 'fake-access-token';
const MEMBER = 'fake123';

const uploads = new Map<string, number>();
const assets = new Set<string>();
const posts = new Map<string, { author: string; text: string; visibility: string; asset: string }>();
let counter = 0;

async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function send(res: ServerResponse, status: number, data?: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(data === undefined ? undefined : JSON.stringify(data));
}

const authorized = (req: IncomingMessage): boolean => req.headers.authorization === `Bearer ${TOKEN}`;

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', BASE);
  const route = `${req.method} ${url.pathname}`;
  try {
    if (route === 'GET /oauth/v2/authorization') {
      const redirect = url.searchParams.get('redirect_uri');
      const wanted = (url.searchParams.get('scope') ?? '').split(' ');
      if (!redirect || !url.searchParams.get('state') || !url.searchParams.get('client_id')) return send(res, 400, { error: 'invalid_request' });
      if (!wanted.includes('w_member_social')) return send(res, 400, { error: 'invalid_scope' });
      const back = new URL(redirect);
      back.searchParams.set('code', CODE);
      back.searchParams.set('state', url.searchParams.get('state') as string);
      res.writeHead(302, { location: back.toString() });
      return void res.end();
    }
    if (route === 'POST /oauth/v2/accessToken') {
      const form = new URLSearchParams((await body(req)).toString());
      if (form.get('grant_type') !== 'authorization_code' || form.get('code') !== CODE || !form.get('client_secret') || !form.get('redirect_uri')) {
        return send(res, 400, { error: 'invalid_request', error_description: 'bad token request' });
      }
      return send(res, 200, { access_token: TOKEN, expires_in: 5_184_000, scope: 'openid,profile,w_member_social' });
    }
    if (route === 'GET /v2/userinfo') {
      return authorized(req) ? send(res, 200, { sub: MEMBER, name: 'Test Member' }) : send(res, 401, { message: 'unauthorized' });
    }
    if (route === 'POST /v2/assets' && url.searchParams.get('action') === 'registerUpload') {
      if (!authorized(req)) return send(res, 401, { message: 'unauthorized' });
      const sent = JSON.parse((await body(req)).toString()).registerUploadRequest;
      if (sent?.owner !== `urn:li:person:${MEMBER}` || !sent.recipes?.includes('urn:li:digitalmediaRecipe:feedshare-image')) return send(res, 400, { message: 'bad registerUpload' });
      const id = `A${(counter += 1)}`;
      assets.add(`urn:li:digitalmediaAsset:${id}`);
      return send(res, 200, {
        value: {
          asset: `urn:li:digitalmediaAsset:${id}`,
          uploadMechanism: { 'com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest': { uploadUrl: `${BASE}/upload/${id}` } },
        },
      });
    }
    if (req.method === 'PUT' && url.pathname.startsWith('/upload/')) {
      if (!authorized(req)) return send(res, 401, { message: 'unauthorized' });
      const bytes = await body(req);
      if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return send(res, 400, { message: 'not a jpeg' });
      uploads.set(url.pathname.slice(8), bytes.length);
      return send(res, 201);
    }
    if (route === 'POST /v2/ugcPosts') {
      if (!authorized(req)) return send(res, 401, { message: 'unauthorized' });
      if (req.headers['x-restli-protocol-version'] !== '2.0.0') return send(res, 400, { message: 'missing protocol version' });
      const post = JSON.parse((await body(req)).toString());
      const content = post.specificContent?.['com.linkedin.ugc.ShareContent'];
      const asset: string | undefined = content?.media?.[0]?.media;
      const visibility = post.visibility?.['com.linkedin.ugc.MemberNetworkVisibility'];
      if (post.author !== `urn:li:person:${MEMBER}` || post.lifecycleState !== 'PUBLISHED' || content?.shareMediaCategory !== 'IMAGE' || !asset || !assets.has(asset) || !uploads.has(asset.split(':').pop() as string) || !['PUBLIC', 'CONNECTIONS'].includes(visibility)) {
        return send(res, 422, { message: 'invalid post' });
      }
      const urn = `urn:li:share:${1000 + (counter += 1)}`;
      posts.set(urn, { author: post.author, text: content.shareCommentary.text, visibility, asset });
      return send(res, 201, {}, { 'x-restli-id': urn });
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/v2/ugcPosts/')) {
      if (!authorized(req)) return send(res, 401, { message: 'unauthorized' });
      return posts.delete(decodeURIComponent(url.pathname.slice('/v2/ugcPosts/'.length))) ? send(res, 204) : send(res, 404, { message: 'no such post' });
    }
    if (route === 'GET /__state') return send(res, 200, { uploads: [...uploads.values()], posts: [...posts.entries()].map(([urn, p]) => ({ urn, ...p })) });
    return send(res, 404, { message: `no route ${route}` });
  } catch (error) {
    return send(res, 500, { message: error instanceof Error ? error.message : String(error) });
  }
}).listen(PORT, '127.0.0.1', () => console.log(`pretend LinkedIn on ${BASE}`));
