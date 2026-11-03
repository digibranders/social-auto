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
const about = html(`<p>${'Our dentists have looked after families in this town for twenty years and we love meeting new patients. '.repeat(5)}</p>`);
const pricing = html(`<p>${'A check-up costs less than most people expect and we explain every price before any treatment begins. '.repeat(5)}</p>`);

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

const withLogos = (imgs: string): string =>
  html(`<header>${imgs}</header><h1>Acme Dental</h1><p>${prose(7)}</p>`, '<link rel="icon" href="/favicon.ico"><link rel="apple-touch-icon" href="/apple-touch-icon.png">');

test('the logo is the business\'s own: a client\'s or partner\'s logo is never taken for it', async () => {
  const clientLogo = '<img src="/_next/image?url=%2Fclients%2Fphoton.webp&w=384&q=75" alt="Photon Matters logo">';
  const partnerLogo = '<img src="/partners/globex-logo.svg" alt="Globex logo">';
  const ownLogo = '<img src="/assets/acme-logo.svg" alt="Acme Dental">';

  const mixed = await crawlSite('acme.com', site({ 'https://acme.com/': withLogos(`${clientLogo}${partnerLogo}${ownLogo}`) }).deps);
  assert.deepEqual(mixed.logoCandidates, ['https://acme.com/assets/acme-logo.svg']);

  const plainlyNamed = await crawlSite('acme.com', site({ 'https://acme.com/': withLogos('<img src="/img/logo.svg" alt="Home">') }).deps);
  assert.deepEqual(plainlyNamed.logoCandidates, ['https://acme.com/img/logo.svg']);
});

test('with only other companies\' logos or icons, there is no logo candidate, so the brand\'s name is used', async () => {
  const onlyClients = '<img src="/clients/one-logo.png" alt="One logo"><img src="/_next/image?url=%2Fclients%2Ftwo.webp&w=384" alt="Two logo"><img src="/customers/three.svg" alt="Three">';
  const snapshot = await crawlSite('acme.com', site({ 'https://acme.com/': withLogos(onlyClients) }).deps);
  assert.deepEqual(snapshot.logoCandidates, []);
});

test('the site\'s own icons are kept as a second choice, biggest first, with the old .ico last', async () => {
  const icons = '<link rel="icon" href="/favicon.ico" sizes="48x48" type="image/x-icon"><link rel="icon" href="/icon.png?v=3" sizes="512x512"><link rel="apple-touch-icon" href="/apple-icon.png" sizes="180x180"><link rel="icon" href="data:image/png;base64,AAAA">';
  const snapshot = await crawlSite('acme.com', site({ 'https://acme.com/': html(`<h1>Acme Dental</h1><p>${prose(7)}</p>`, icons) }).deps);
  assert.deepEqual(snapshot.iconCandidates, ['https://acme.com/icon.png?v=3', 'https://acme.com/apple-icon.png', 'https://acme.com/favicon.ico']);
  assert.deepEqual(snapshot.logoCandidates, []);
});

const page = (body: string): string => html(`${body}<main><p>${prose(7)}</p></main>`);

test('a customer\'s logo in the page body is not the business\'s own, even with "logo" and .svg in its name, but the logo in the header is', async () => {
  const carousel = '<section><img src="/logos/full-logo--black.svg" alt="Lovable logo" width="160"><img src="/logos/cursor-logo-mono.svg" alt="Cursor logo" width="160"></section>';
  const header = '<header><a href="/"><img src="/brand/wordmark.svg" alt="Acme Dental logo"></a></header>';
  const both = await crawlSite('acme.com', site({ 'https://acme.com/': page(`${header}${carousel}`) }).deps);
  assert.deepEqual(both.logoCandidates, ['https://acme.com/brand/wordmark.svg']);
  const onlyCarousel = await crawlSite('acme.com', site({ 'https://acme.com/': page(carousel) }).deps);
  assert.deepEqual(onlyCarousel.logoCandidates, []);
});

test('a logo inside the link to the home page counts, in or out of a header', async () => {
  const snapshot = await crawlSite('acme.com', site({ 'https://acme.com/': page('<div class="bar"><a class="brand" href="https://acme.com/"><img src="/img/logo.png" alt="Home"></a></div>') }).deps);
  assert.deepEqual(snapshot.logoCandidates, ['https://acme.com/img/logo.png']);
});

test('product photos and promos are never taken for the logo, even with the business\'s name or "logo" in the address', async () => {
  const promos = [
    '<img src="/v/homepage/images/acme-pro/promo_acme_pro_large.jpg" alt="Acme Pro">',
    '<img src="/v/homepage/images/logos/acme-watch/promo_logo_acme_watch_large.png" alt="">',
    '<img src="/cdn-cgi/imagedelivery/abc/6600ca/f=auto,fit=scale-down,width=2560" alt="Acme logo">',
    '<img src="/img/hero-banner-acme-logo.png" alt="Acme" width="1200">',
  ].join('');
  const inBody = await crawlSite('acme.com', site({ 'https://acme.com/': page(`<section>${promos}</section>`) }).deps);
  assert.deepEqual(inBody.logoCandidates, []);
  const inHeader = await crawlSite('acme.com', site({ 'https://acme.com/': page(`<header>${promos}</header>`) }).deps);
  assert.deepEqual(inHeader.logoCandidates, []);
});

test('a logo in the navigation bar counts', async () => {
  const snapshot = await crawlSite('acme.com', site({ 'https://acme.com/': page('<nav><img src="/assets/logo-dark.svg" alt="Acme"></nav>') }).deps);
  assert.deepEqual(snapshot.logoCandidates, ['https://acme.com/assets/logo-dark.svg']);
});

test('every link is decided and explained in the snapshot, including pages that were not read and why', async () => {
  const snapshot = await crawlSite('acme.com', site({ 'https://acme.com/': home, 'https://acme.com/about': about, 'https://acme.com/pricing': pricing }).deps);
  const byPath = new Map(snapshot.pageDecisions.map((d) => [new URL(d.url).pathname, d]));
  assert.ok(byPath.get('/about')?.selected && byPath.get('/pricing')?.selected);
  assert.ok(!byPath.get('/privacy')?.selected && byPath.get('/privacy')?.reasons.some((r) => /legal|utility/i.test(r)));
  assert.ok(snapshot.pageDecisions.every((d) => d.reasons.length >= 1));
});

test('a page that repeats another page\'s text is not read twice, and says which page it repeats', async () => {
  const same = html(`<p>${'Identical words about our friendly dental practice and the care we give to every family. '.repeat(6)}</p>`);
  const snapshot = await crawlSite('acme.com', site({ 'https://acme.com/': home, 'https://acme.com/about': same, 'https://acme.com/pricing': same }).deps);
  assert.equal(snapshot.pages.length, 2);
  const dropped = snapshot.pageDecisions.find((d) => !d.selected && d.reasons.some((r) => /duplicate of/.test(r)));
  assert.ok(dropped && /duplicate of https:\/\/acme\.com\/(about|pricing)/.test(dropped.reasons.join(' ')));
});

test('a link that is blocked by robots.txt is recorded as blocked and the next best page is read instead', async () => {
  const snapshot = await crawlSite('acme.com', site({ 'https://acme.com/robots.txt': 'User-agent: *\nDisallow: /pricing\n', 'https://acme.com/': home, 'https://acme.com/about': about, 'https://acme.com/pricing': pricing }).deps);
  const pricingDecision = snapshot.pageDecisions.find((d) => d.url.endsWith('/pricing'));
  assert.ok(!pricingDecision?.selected && pricingDecision?.reasons.some((r) => /robots/.test(r)));
});

test('links that only exist after the page builds itself in the browser are ranked too', async () => {
  const thin = '<!doctype html><html lang="en"><head><title>Acme Dental</title></head><body><div id="app"></div></body></html>';
  const built = html(`<header><nav><a href="/services">Services</a><a href="/about">About</a></nav></header><h1>Acme Dental</h1><p>${prose(7)}</p>`);
  const { deps } = site({ 'https://acme.com/': thin, 'https://acme.com/services': about, 'https://acme.com/about': pricing }, { 'https://acme.com/': built });
  const snapshot = await crawlSite('acme.com', deps);
  assert.ok(snapshot.pages.some((p) => p.url.endsWith('/services')) && snapshot.pages.some((p) => p.url.endsWith('/about')));
});
