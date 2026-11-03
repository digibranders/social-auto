import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crawlSite, CrawlError, TooLittleContentError, type CrawlDeps } from './crawl.ts';
import { FetchRefusedError, type FetchedPage } from './safe-fetch.ts';

const SENTENCE = 'We build friendly websites for local clinics and help them get found by patients every single day. ';
const prose = (times: number): string => SENTENCE.repeat(times);
const html = (body: string, extra = ''): string => `<!doctype html><html><head><title>Acme Dental</title><meta name="description" content="Dental care">${extra}</head><body>${body}</body></html>`;

/** A pretend website: address -> page. Anything else answers 404. */
function site(pages: Record<string, string>, rendered: Record<string, string> = {}) {
  const fetched: string[] = [];
  const rendersAsked: string[] = [];
  const deps: CrawlDeps = {
    fetchPage: async (url: string): Promise<FetchedPage> => {
      fetched.push(url);
      const body = pages[url];
      if (body === undefined) throw new FetchRefusedError(`${url} answered 404`);
      return { finalUrl: url, body, type: url.endsWith('.css') ? 'text/css' : url.endsWith('robots.txt') ? 'text/plain' : 'text/html' };
    },
    render: async (url: string): Promise<string> => {
      rendersAsked.push(url);
      const body = rendered[url];
      if (body === undefined) throw new Error('no rendered page');
      return body;
    },
  };
  return { deps, fetched, rendersAsked };
}

const home = html(`<h1>Acme Dental</h1><p>${prose(6)}</p><a href="/about">About</a> <a href="/pricing">Pricing</a> <a href="/privacy">Privacy</a>`);
const about = html(`<p>${prose(5)}</p>`);
const pricing = html(`<p>${prose(5)}</p>`);

test('an ordinary site is read: its pages, in a useful order, without the skipped ones', async () => {
  const { deps, fetched } = site({ 'https://acme.com/': home, 'https://acme.com/about': about, 'https://acme.com/pricing': pricing, 'https://acme.com/privacy': about });
  const snapshot = await crawlSite('acme.com', deps);
  assert.equal(snapshot.origin, 'https://acme.com');
  assert.deepEqual(snapshot.pages.map((p) => p.url).sort(), ['https://acme.com/', 'https://acme.com/about', 'https://acme.com/pricing']);
  assert.ok(!fetched.includes('https://acme.com/privacy'));
  assert.ok(snapshot.pages.every((p) => p.text.length > 100));
});

test('pages robots.txt disallows are not read, and a robots.txt that cannot be fetched allows everything', async () => {
  const blocked = site({ 'https://acme.com/robots.txt': 'User-agent: *\nDisallow: /pricing\n', 'https://acme.com/': home, 'https://acme.com/about': about, 'https://acme.com/pricing': pricing });
  const snapshot = await crawlSite('acme.com', blocked.deps);
  assert.ok(!blocked.fetched.includes('https://acme.com/pricing'));
  assert.ok(snapshot.pages.some((p) => p.url.endsWith('/about')));

  const noRobots = site({ 'https://acme.com/': home, 'https://acme.com/about': about, 'https://acme.com/pricing': pricing });
  assert.equal((await crawlSite('acme.com', noRobots.deps)).pages.length, 3);
});

test('a site that asks bots not to read it is not read, and the message says why', async () => {
  const { deps, fetched } = site({ 'https://acme.com/robots.txt': 'User-agent: *\nDisallow: /\n', 'https://acme.com/': home });
  await assert.rejects(crawlSite('acme.com', deps), (error: Error) => error instanceof CrawlError && /robots\.txt/.test(error.message));
  assert.ok(!fetched.includes('https://acme.com/'));
});

test('a page that arrives nearly empty is rendered in Chrome, and the rendered text is used', async () => {
  const empty = html('<div id="app"></div><script src="/app.js"></script>');
  const { deps, rendersAsked } = site({ 'https://acme.com/': empty }, { 'https://acme.com/': html(`<h1>Acme Dental</h1><p>${prose(8)}</p>`) });
  const snapshot = await crawlSite('acme.com', deps);
  assert.deepEqual(rendersAsked, ['https://acme.com/']);
  assert.ok((snapshot.pages[0]?.text.length ?? 0) > 400);
});

test('a site with too little to read says so clearly instead of producing weak posts', async () => {
  const empty = html('<div id="app"></div><script src="/app.js"></script>');
  const { deps } = site({ 'https://acme.com/': empty }, { 'https://acme.com/': html('<p>Coming soon</p>') });
  await assert.rejects(crawlSite('acme.com', deps), (error: Error) => error instanceof TooLittleContentError && /too little/i.test(error.message));
  const failing = site({ 'https://acme.com/': empty });
  await assert.rejects(crawlSite('acme.com', failing.deps), TooLittleContentError);
});

test('a home page that cannot be loaded says which address failed', async () => {
  const { deps } = site({});
  await assert.rejects(crawlSite('acme.com', deps), /acme\.com/);
});
