import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GET, POST } from '../api/google/[step].ts';
import { POST as invite } from '../api/_connect/linkedin-invite.ts';
import { createInvite } from './linkedin-flow.ts';
import { pickCookie } from './google-flow.ts';
import { createSession } from './security.ts';

const SECRET = 'a-long-test-secret-a-long-test-secret';
const call = (path: string, init?: RequestInit): Request => new Request(`http://localhost:4010${path}`, init);
const cookieOf = (response: Response, name: string): string | undefined =>
  response.headers.getSetCookie().find((c) => c.startsWith(`${name}=`))?.split(';')[0]?.slice(name.length + 1);

function setup(): void {
  process.env['SESSION_SECRET'] = SECRET;
  process.env['GOOGLE_CLIENT_ID'] = 'client-id';
  delete process.env['INVITE_SECRET'];
  process.env['COOKIE_INSECURE'] = '1';
}

test('an unknown step is a 404, and Google is not offered until it is configured', async () => {
  setup();
  assert.equal((await GET(call('/api/google/nope'))).status, 404);
  assert.equal((await POST(call('/api/google/nope', { method: 'POST' }))).status, 404);
  delete process.env['GOOGLE_CLIENT_ID'];
  assert.equal((await GET(call('/api/google/start'))).status, 503);
});

test('a client with a valid invite is sent to Google with no login, and a forged or expired one is refused', async () => {
  setup();
  const ok = await GET(call(`/api/google/start?invite=${encodeURIComponent(createInvite(SECRET, 'brandbasket', Date.now()))}`));
  assert.equal(ok.status, 302);
  const to = new URL(ok.headers.get('location') as string);
  assert.equal(to.origin, 'https://accounts.google.com');
  assert.equal(to.searchParams.get('access_type'), 'offline');
  assert.equal(to.searchParams.get('redirect_uri'), 'http://localhost:4010/api/google/callback');
  assert.match(cookieOf(ok, 'g_connect') ?? '', /^[0-9a-f]{32}\.brandbasket$/);

  assert.equal((await GET(call('/api/google/start?invite=forged.token'))).status, 410);
  assert.equal((await GET(call(`/api/google/start?invite=${encodeURIComponent(createInvite(SECRET, 'brandbasket', Date.now() - 8 * 86_400_000))}`))).status, 410);
  assert.equal((await GET(call('/api/google/start?brand=brandbasket'))).headers.get('location'), 'http://localhost:4010/login');
});

test('a signed-in team member can start without an invite, but only for a valid client name', async () => {
  setup();
  const headers = { cookie: `cal_session=${createSession(SECRET, Date.now())}` };
  assert.equal((await GET(call('/api/google/start?brand=brandbasket', { headers }))).status, 302);
  assert.equal((await GET(call('/api/google/start?brand=../x', { headers }))).status, 400);
});

test('a callback with no saved state, or a client with nothing waiting to choose, is turned away', async () => {
  setup();
  const lost = await GET(call('/api/google/callback?code=x&state=y'));
  assert.equal(lost.status, 400);
  assert.match(await lost.text(), /That did not work/);
  const gone = await GET(call('/api/google/choose'));
  assert.equal(gone.status, 400);
  assert.match(await gone.text(), /run out of time/);
});

test('the chooser form only accepts same-site posts for a valid location while something is waiting', async () => {
  setup();
  const waiting = { cookie: pickCookie('brandbasket', 'v1.AbC_-1.dEf_-2.gHi_-3', null, false).split(';')[0] as string };
  const form = (headers: Record<string, string>, body: string): Request => call('/api/google/choose', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body });
  assert.equal((await POST(form({ ...waiting }, 'location=1'))).status, 403);
  const same = { ...waiting, origin: 'http://localhost:4010' };
  assert.equal((await POST(form({ origin: 'http://localhost:4010' }, 'location=1'))).status, 400);
  assert.equal((await POST(form(same, 'location=abc'))).status, 400);
});

test('the invite endpoint makes a Google link only when Google is configured, and only for a signed-in person', async () => {
  setup();
  const signedIn = { cookie: `cal_session=${createSession(SECRET, Date.now())}`, origin: 'http://localhost:4010' };
  const post = (headers: Record<string, string>): Request => call('/api/linkedin-invite?brand=brandbasket&channel=google', { method: 'POST', headers });
  assert.equal(invite(post({ origin: 'http://localhost:4010' })).status, 401);
  const made = invite(post(signedIn));
  assert.equal(made.status, 200);
  const { link } = (await made.json()) as { link: string };
  assert.match(link, /^http:\/\/localhost:4010\/api\/google\/start\?invite=/);
  delete process.env['GOOGLE_CLIENT_ID'];
  assert.equal(invite(post(signedIn)).status, 503);
});

test('a product\'s customer who denies Google comes back to the product with the result, and a bad return address is never followed', async () => {
  setup();
  process.env['INVITE_SECRET'] = 'i'.repeat(40);
  const back = 'https://app.brandbasket.in/social';
  const link = createInvite(process.env['INVITE_SECRET'], 'brandbasket', Date.now(), undefined, back);
  const start = await GET(call(`/api/google/start?invite=${encodeURIComponent(link)}`));
  assert.equal(start.status, 302);
  const saved = cookieOf(start, 'g_connect') as string;
  assert.match(saved, /^[0-9a-f]{32}\.brandbasket\.[A-Za-z0-9_-]+$/);

  const denied = await GET(call('/api/google/callback?error=access_denied', { headers: { cookie: `g_connect=${saved}` } }));
  assert.equal(denied.status, 302);
  assert.equal(denied.headers.get('location'), `${back}?social=denied&channel=google`);

  // Nothing saved, nowhere to return: the plain page.
  const plain = await GET(call('/api/google/callback?error=access_denied'));
  assert.equal(plain.status, 200);
});
