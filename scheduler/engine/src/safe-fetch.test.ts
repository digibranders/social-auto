import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertPublicUrl, isPublicAddress, parseRobots, robotsAllows, safeFetch, UserAgentName } from './safe-fetch.ts';

const PUBLIC_IP = '93.184.216.34';
const resolvesTo = (map: Record<string, string[]>) => async (host: string): Promise<string[]> => {
  const found = map[host];
  if (!found) throw new Error(`ENOTFOUND ${host}`);
  return found;
};
const dns = resolvesTo({ 'example.com': [PUBLIC_IP], 'www.example.com': [PUBLIC_IP], 'evil.net': ['10.0.0.5'], 'mixed.net': [PUBLIC_IP, '127.0.0.1'], 'ok.net': [PUBLIC_IP] });

test('only public internet addresses are allowed', () => {
  for (const ok of ['93.184.216.34', '8.8.8.8', '2606:2800:220:1:248:1893:25c8:1946']) assert.equal(isPublicAddress(ok), true, ok);
  for (const bad of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', 'not-an-ip']) {
    assert.equal(isPublicAddress(bad), false, bad);
  }
});

test('a page address must be a normal public https/http one, and every address its name resolves to must be public', async () => {
  await assertPublicUrl(new URL('https://example.com/about'), dns);
  const refuse = async (url: string, pattern: RegExp) => assert.rejects(assertPublicUrl(new URL(url), dns), pattern, url);
  await refuse('ftp://example.com', /http/);
  await refuse('https://user:pw@example.com', /login/);
  await refuse('https://example.com:8443', /port/);
  await refuse('http://127.0.0.1/', /public/);
  await refuse('http://localhost/', /public/);
  await refuse('https://evil.net/', /public/);
  await refuse('https://mixed.net/', /public/);
  await refuse('https://nosuchhost.org/', /ENOTFOUND|find/);
});

const reply = (status: number, headers: Record<string, string> = {}, body = ''): Response => new Response(body, { status, headers });
function scripted(answers: Record<string, () => Response>) {
  const seen: Array<{ url: string; agent: string | null }> = [];
  const fetchFn = (async (input: URL | RequestInfo, init: RequestInit = {}) => {
    const url = String(input);
    seen.push({ url, agent: new Headers(init.headers).get('user-agent') });
    const answer = answers[url];
    if (!answer) return reply(404);
    return answer();
  }) as typeof fetch;
  return { fetchFn, seen };
}

test('safeFetch names itself honestly and follows redirects only between public hosts', async () => {
  const { fetchFn, seen } = scripted({
    'https://example.com/': () => reply(301, { location: 'https://www.example.com/home' }),
    'https://www.example.com/home': () => reply(200, { 'content-type': 'text/html' }, '<p>hello</p>'),
  });
  const result = await safeFetch('https://example.com/', { fetchFn, resolve: dns });
  assert.equal(result.finalUrl, 'https://www.example.com/home');
  assert.equal(result.body, '<p>hello</p>');
  assert.ok(seen.every((s) => s.agent === UserAgentName));
});

test('safeFetch refuses a redirect to a private host, too many redirects, and an oversized answer', async () => {
  const toPrivate = scripted({ 'https://example.com/': () => reply(302, { location: 'http://evil.net/admin' }) });
  await assert.rejects(safeFetch('https://example.com/', { fetchFn: toPrivate.fetchFn, resolve: dns }), /public/);
  assert.equal(toPrivate.seen.length, 1, 'the private address was never requested');

  const loop = scripted({ 'https://example.com/': () => reply(302, { location: 'https://example.com/' }) });
  await assert.rejects(safeFetch('https://example.com/', { fetchFn: loop.fetchFn, resolve: dns, maxRedirects: 3 }), /redirect/i);

  const big = scripted({ 'https://example.com/': () => reply(200, { 'content-type': 'text/html' }, 'x'.repeat(5000)) });
  await assert.rejects(safeFetch('https://example.com/', { fetchFn: big.fetchFn, resolve: dns, maxBytes: 1000 }), /too large/i);
});

test('safeFetch reports a failed answer instead of returning it as a page', async () => {
  const missing = scripted({});
  await assert.rejects(safeFetch('https://example.com/nope', { fetchFn: missing.fetchFn, resolve: dns }), /404/);
});

const robots = parseRobots(`
User-agent: *
Disallow: /private
Disallow: /tmp/
Allow: /private/open

User-agent: SocialAutoBot
Disallow: /no-bots

User-agent: BadBot
Disallow: /
`);

test('robots.txt: our own group wins over *, the longest matching rule wins, and an empty Disallow allows everything', () => {
  assert.equal(robotsAllows(robots, '/no-bots/page'), false);
  assert.equal(robotsAllows(robots, '/private/x'), true, 'our group has no rule for /private, so * does not apply');
  assert.equal(robotsAllows(robots, '/about'), true);

  const star = parseRobots('User-agent: *\nDisallow: /private\nAllow: /private/open\n');
  assert.equal(robotsAllows(star, '/private/x'), false);
  assert.equal(robotsAllows(star, '/private/open/page'), true);
  assert.equal(robotsAllows(star, '/public'), true);

  assert.equal(robotsAllows(parseRobots('User-agent: *\nDisallow:\n'), '/anything'), true);
  assert.equal(robotsAllows(parseRobots('User-agent: *\nDisallow: /\n'), '/anything'), false);
  assert.equal(robotsAllows(parseRobots(''), '/anything'), true);
  assert.equal(robotsAllows(parseRobots('# only a comment\n'), '/x'), true);
});
