import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crawlMaxPages, crawlSite, CrawlError, DEFAULT_MAX_PAGES, TooLittleContentError, type CrawlDeps } from './crawl.ts';
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

test('a client\'s own page vocabulary can be passed to the crawler as configuration', async () => {
  const body = html(`<h1>Acme Dental</h1><p>${prose(6)}</p><main><a href="/donate">Give</a></main>`);
  const give = html(`<p>${'Every gift pays for wells in rural schools and we publish how each donation is spent. '.repeat(5)}</p>`);
  const pages = { 'https://acme.com/': body, 'https://acme.com/donate': give };
  const plain = await crawlSite('acme.com', site(pages).deps);
  assert.ok(!plain.pages.some((p) => p.url.endsWith('/donate')));
  const configured = await crawlSite('acme.com', { ...site(pages).deps, ranking: { weights: { donate: 5 } } });
  assert.ok(configured.pages.some((p) => p.url.endsWith('/donate')));
});

test('the page budget is a setting: a default, an environment override, and refusal of nonsense', () => {
  assert.equal(crawlMaxPages({}), DEFAULT_MAX_PAGES);
  assert.ok(DEFAULT_MAX_PAGES > 8);
  assert.equal(crawlMaxPages({ CRAWL_MAX_PAGES: '25' }), 25);
  assert.equal(crawlMaxPages({ CRAWL_MAX_PAGES: '' }), DEFAULT_MAX_PAGES);
  for (const bad of ['1', '0', '-3', '2.5', 'many', '500']) assert.throws(() => crawlMaxPages({ CRAWL_MAX_PAGES: bad }), /CRAWL_MAX_PAGES/, bad);
});

test('the budget caps how many pages are fetched, the homepage counts, and the best-ranked pages are the ones read', async () => {
  const links = ['services', 'about', 'pricing', 'faqs', 'contact'].map((p) => `<a href="/${p}">${p}</a>`).join('');
  const home = html(`<header><nav>${links}</nav></header><h1>Acme</h1><p>${prose(6)}</p>`);
  const body = (n: number) => html(`<p>${`Distinct page ${n} wording about the business and what it offers to customers. `.repeat(8)}</p>`);
  const pages: Record<string, string> = { 'https://acme.com/': home };
  ['services', 'about', 'pricing', 'faqs', 'contact'].forEach((p, i) => { pages[`https://acme.com/${p}`] = body(i); });
  const small = site(pages);
  const snapshot = await crawlSite('acme.com', { ...small.deps, maxPages: 3 });
  assert.equal(snapshot.pages.length, 3);
  assert.equal(small.fetched.filter((u) => !u.endsWith('robots.txt') && u !== 'https://acme.com/').length, 2);
  assert.ok(snapshot.pages.some((p) => p.url.endsWith('/services')) && snapshot.pages.some((p) => p.url.endsWith('/pricing')));
});

const distinct = (n: number): string => html(`<p>${`Wording number ${n} about what the business really does for its customers each day. `.repeat(8)}</p>`);
const navHome = (paths: string[]): string => html(`<header><nav>${paths.map((p) => `<a href="/${p}">${p}</a>`).join('')}</nav></header><h1>Acme</h1><p>${prose(6)}</p>`);

test('a page that cannot be loaded gives its place to the next best page', async () => {
  const paths = ['services', 'about', 'pricing', 'faqs'];
  const pages: Record<string, string> = { 'https://acme.com/': navHome(paths), 'https://acme.com/about': distinct(1), 'https://acme.com/pricing': distinct(2), 'https://acme.com/faqs': distinct(3) };
  const snapshot = await crawlSite('acme.com', { ...site(pages).deps, maxPages: 4 });
  assert.equal(snapshot.pages.length, 4, 'the broken /services page is replaced, not just lost');
  const broken = snapshot.pageDecisions.find((d) => d.url.endsWith('/services'));
  assert.ok(!broken?.selected && broken?.reasons.some((r) => /could not be loaded/.test(r)));
});

test('a page with almost no text gives its place to the next best page', async () => {
  const paths = ['services', 'about', 'pricing', 'faqs'];
  const thin = '<!doctype html><html><head><title>Services</title></head><body><p>Soon.</p></body></html>';
  const pages: Record<string, string> = { 'https://acme.com/': navHome(paths), 'https://acme.com/services': thin, 'https://acme.com/about': distinct(1), 'https://acme.com/pricing': distinct(2), 'https://acme.com/faqs': distinct(3) };
  const snapshot = await crawlSite('acme.com', { ...site(pages).deps, maxPages: 4 });
  assert.equal(snapshot.pages.length, 4);
  assert.ok(!snapshot.pages.some((p) => p.url.endsWith('/services')));
  assert.ok(snapshot.pageDecisions.find((d) => d.url.endsWith('/services'))?.reasons.some((r) => /too little text/.test(r)));
});

test('a duplicate page gives its place to the next best page, and pages beyond the budget say the budget was full', async () => {
  const paths = ['services', 'about', 'pricing', 'faqs', 'contact'];
  const same = distinct(9);
  const pages: Record<string, string> = { 'https://acme.com/': navHome(paths), 'https://acme.com/services': same, 'https://acme.com/about': same, 'https://acme.com/pricing': distinct(2), 'https://acme.com/faqs': distinct(3), 'https://acme.com/contact': distinct(4) };
  const snapshot = await crawlSite('acme.com', { ...site(pages).deps, maxPages: 4 });
  assert.equal(snapshot.pages.length, 4);
  assert.equal(snapshot.pages.filter((p) => p.url.endsWith('/services') || p.url.endsWith('/about')).length, 1);
  const unread = snapshot.pageDecisions.filter((d) => !d.selected && /budget/.test(d.reasons.join(' ')));
  assert.ok(unread.length >= 1);
});

test('every page read carries when it was fetched, so claims about it can be dated', async () => {
  const snapshot = await crawlSite('acme.com', site({ 'https://acme.com/': home, 'https://acme.com/about': about, 'https://acme.com/pricing': pricing }).deps);
  for (const page of snapshot.pages) assert.ok(page.fetchedAt && !Number.isNaN(Date.parse(page.fetchedAt)), page.url);
});

test('the snapshot keeps the homepage links with their text and where they sit, so the poster can offer a real action', async () => {
  const withNav = html(`<nav><a href="/book">Book a visit</a></nav><h1>Acme Dental</h1><p>${prose(6)}</p><a href="/about">About</a><footer><a href="/privacy">Privacy</a></footer>`);
  const { deps } = site({ 'https://acme.com/': withNav, 'https://acme.com/about': about, 'https://acme.com/book': pricing });
  const snapshot = await crawlSite('acme.com', deps);
  const book = snapshot.links?.find((l) => l.url === 'https://acme.com/book');
  assert.deepEqual(book, { url: 'https://acme.com/book', text: 'Book a visit', region: 'nav' });
  assert.equal(snapshot.links?.find((l) => l.url === 'https://acme.com/privacy')?.region, 'footer');
});

test('a site that cannot be read fails with a code a caller can act on', async () => {
  const { FetchRefusedError } = await import('./safe-fetch.ts');
  const { crawlSite, CrawlError, crawlMaxSeconds } = await import('./crawl.ts');
  const code = async (fetchPage: (url: string) => Promise<{ finalUrl: string; body: string; type: string }>): Promise<string> => {
    try {
      await crawlSite('https://acme.example.com', { fetchPage, render: async () => '' });
    } catch (error) {
      assert.ok(error instanceof CrawlError);
      return error.code;
    }
    return 'no error';
  };
  const page = (body: string) => async (url: string) => ({ finalUrl: url, body, type: 'text/html' });
  assert.equal(await code(async (url) => { if (url.endsWith('/robots.txt')) return { finalUrl: url, body: 'User-agent: *\nDisallow: /', type: 'text/plain' }; return page('<html></html>')(url); }), 'SITE_ACCESS_BLOCKED');
  assert.equal(await code(async (url) => { if (url.endsWith('/robots.txt')) throw new Error('none'); throw new FetchRefusedError('https://acme.example.com/ answered 403'); }), 'SITE_ACCESS_BLOCKED');
  assert.equal(await code(async (url) => { if (url.endsWith('/robots.txt')) throw new Error('none'); throw new FetchRefusedError('127.0.0.1 is not a public website address'); }), 'URL_REFUSED');
  assert.equal(await code(async (url) => { if (url.endsWith('/robots.txt')) throw new Error('none'); throw new Error('The operation was aborted due to timeout'); }), 'CRAWL_TIMEOUT');
  assert.equal(await code(async (url) => { if (url.endsWith('/robots.txt')) throw new Error('none'); throw new Error('getaddrinfo ENOTFOUND'); }), 'SITE_UNREACHABLE');
  assert.equal(await code(async (url) => { if (url.endsWith('/robots.txt')) throw new Error('none'); return { finalUrl: url, body: '%PDF', type: 'application/pdf' }; }), 'NOT_A_WEB_PAGE');
  assert.equal(await code(page('<html><body><p>Hi</p></body></html>')), 'INSUFFICIENT_EVIDENCE');
  assert.equal(crawlMaxSeconds({}), 120);
  assert.equal(crawlMaxSeconds({ CRAWL_MAX_SECONDS: '30' }), 30);
  assert.throws(() => crawlMaxSeconds({ CRAWL_MAX_SECONDS: '5' }), /CRAWL_MAX_SECONDS/);
});

test('a logo is taken only when its placement and its own words say it is the business logo, and why is recorded', async () => {
  const { logoCandidatesWithEvidence } = await import('./crawl.ts');
  const base = new URL('https://www.acme.com/');
  const html = `
    <header><a href="/"><img src="https://cdn.shopify.example/files/acme-logo.svg" alt="Acme"></a>
      <img src="/img/badge-3.png" alt="">
      <img src="/img/header-promo-icon.png" alt="a gift"></header>
    <section class="trusted"><img src="/img/globex-logo.svg" alt="Globex logo"></section>
    <nav><img src="/assets/mark.png" alt="logo"></nav>`;
  const found = logoCandidatesWithEvidence(html, base);
  const urls = found.map((c) => c.url);
  assert.ok(urls.includes('https://cdn.shopify.example/files/acme-logo.svg'));
  assert.ok(!urls.some((u) => u.includes('badge-3') || u.includes('header-promo')), 'a header picture that says nothing about being a logo is not one');
  assert.ok(!urls.some((u) => u.includes('globex')), 'a logo in the body belongs to someone else');
  const cdn = found.find((c) => c.url.includes('cdn.shopify'))?.evidence;
  assert.equal(cdn?.hostRelation, 'third_party');
  assert.equal(cdn?.placement, 'home_link');
  assert.deepEqual(cdn?.signals, ['says logo', 'names the business']);
  assert.equal(found.find((c) => c.url.endsWith('/assets/mark.png'))?.evidence.hostRelation, 'same_site');
});
