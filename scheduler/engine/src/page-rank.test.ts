import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractLinkInfo, rankPages, type LinkInfo } from './page-rank.ts';

const base = new URL('https://acme.com/');
const open = (): boolean => true;
const link = (path: string, text = '', region: LinkInfo['region'] = 'nav'): LinkInfo => ({ url: `https://acme.com${path}`, text, region });
const rank = (links: LinkInfo[], extra: { alternates?: Array<{ lang: string; url: string }>; htmlLang?: string | null; allowed?: (path: string) => boolean; limit?: number } = {}) =>
  rankPages({ links, alternates: extra.alternates ?? [], htmlLang: extra.htmlLang ?? 'en', canonical: null }, base, { limit: extra.limit ?? 6, robotsAllows: extra.allowed ?? open });
const chosen = (links: LinkInfo[], extra?: Parameters<typeof rank>[1]): string[] => rank(links, extra).filter((d) => d.selected).map((d) => new URL(d.url).pathname);
const decision = (links: LinkInfo[], path: string, extra?: Parameters<typeof rank>[1]) => rank(links, extra).find((d) => new URL(d.url).pathname === path);

test('links are read with where they sit (navigation, footer, body), their words, and the page\'s language, canonical and hreflang alternates', () => {
  const html = `<html lang="en-GB"><head><link rel="canonical" href="https://acme.com/"><link rel="alternate" hreflang="fr" href="https://acme.com/fr/"><link rel="alternate" hreflang="x-default" href="https://acme.com/"></head>
    <body><header><nav><a href="/services/">Our  <b>services</b></a><a href="/pricing?ref=nav#top">Pricing</a></nav></header>
    <main><a href="https://acme.com/about-us/">About</a><a href="https://other.com/x">Elsewhere</a><a href="mailto:hi@acme.com">Mail</a><a href="/brochure.pdf">PDF</a><a href="javascript:void(0)">x</a></main>
    <footer><a href="/privacy">Privacy</a><a href="/services">Services again</a></footer></body></html>`;
  const info = extractLinkInfo(html, base);
  assert.equal(info.htmlLang, 'en-GB');
  assert.equal(info.canonical, 'https://acme.com/');
  assert.deepEqual(info.alternates, [{ lang: 'fr', url: 'https://acme.com/fr' }, { lang: 'x-default', url: 'https://acme.com/' }]);
  const byUrl = new Map(info.links.map((l) => [l.url, l]));
  assert.deepEqual(byUrl.get('https://acme.com/services'), { url: 'https://acme.com/services', text: 'Our services', region: 'nav' });
  assert.equal(byUrl.get('https://acme.com/pricing')?.region, 'nav');
  assert.equal(byUrl.get('https://acme.com/about-us')?.region, 'body');
  assert.equal(byUrl.get('https://acme.com/privacy')?.region, 'footer');
  assert.ok(!byUrl.has('https://other.com/x') && !info.links.some((l) => /mailto|pdf|javascript/.test(l.url)));
  assert.equal(info.links.filter((l) => l.url === 'https://acme.com/services').length, 1);
});

test('homepage relevance: the home page itself is never a candidate, and url variants of it collapse', () => {
  const picked = chosen([link('/'), link('/index.html'), link('/services', 'Services'), link('/pricing', 'Pricing')]);
  assert.ok(!picked.includes('/') && !picked.includes('/index.html'));
  assert.deepEqual(picked.slice().sort(), ['/pricing', '/services']);
});

test('product and service pages beat everything else, whether found by their address or by their link words', () => {
  const links = [link('/p/7731', 'Our solutions'), link('/misc', 'Random'), link('/services/web-design', 'Web design'), link('/pricing', 'Plans and pricing'), link('/blog/2019/05/a-long-story', 'A story', 'body'), link('/about', 'About us')];
  const picked = chosen(links, { limit: 4 });
  assert.deepEqual(picked.slice().sort(), ['/about', '/p/7731', '/pricing', '/services/web-design']);
  assert.ok(!picked.includes('/blog/2019/05/a-long-story'));
});

test('legal, account and utility pages are rejected, each with its reason', () => {
  const links = [link('/privacy-policy', 'Privacy', 'footer'), link('/terms', 'Terms', 'footer'), link('/login', 'Log in'), link('/cart', 'Cart'), link('/careers', 'Careers', 'footer'), link('/sitemap', 'Sitemap', 'footer'), link('/services', 'Services')];
  assert.deepEqual(chosen(links), ['/services']);
  for (const path of ['/privacy-policy', '/terms', '/login', '/cart', '/careers', '/sitemap']) {
    const d = decision(links, path);
    assert.equal(d?.selected, false, path);
    assert.ok((d?.reasons.length ?? 0) > 0, path);
  }
  assert.match(decision(links, '/privacy-policy')?.reasons.join(' ') ?? '', /legal/i);
  assert.match(decision(links, '/login')?.reasons.join(' ') ?? '', /account/i);
});

test('regional copies of the same pages collapse to one, and the home-language version is the one kept', () => {
  const regions = ['ae', 'am', 'at', 'au'].flatMap((cc) => [link(`/${cc}`, cc, 'footer'), link(`/${cc}/services`, 'Services', 'footer')]);
  const links = [link('/services', 'Services'), ...regions];
  assert.deepEqual(chosen(links), ['/services']);
  const copy = decision(links, '/ae/services');
  assert.equal(copy?.selected, false);
  assert.match(copy?.reasons.join(' ') ?? '', /regional.*duplicate.*\/services/i);
  assert.match(decision(links, '/ae')?.reasons.join(' ') ?? '', /regional.*duplicate/i);
});

test('a regional page with no other version stays eligible, so a country-only business is not emptied out', () => {
  const links = [link('/in/services', 'Services'), link('/in/pricing', 'Pricing'), link('/in/about', 'About')];
  const picked = chosen(links, { alternates: [{ lang: 'en-in', url: 'https://acme.com/in/' }] });
  assert.deepEqual(picked.slice().sort(), ['/in/about', '/in/pricing', '/in/services']);
  assert.match(decision(links, '/in/services', { alternates: [{ lang: 'en-in', url: 'https://acme.com/in/' }] })?.reasons.join(' ') ?? '', /regional/i);
});

test('a real two-letter path is not mistaken for a locale unless the page shows a locale switcher', () => {
  const links = [link('/us/services', 'Services'), link('/in/pricing', 'Pricing'), link('/about', 'About')];
  assert.deepEqual(chosen(links).slice().sort(), ['/about', '/in/pricing', '/us/services']);
});

test('the same page reached through url variants is counted once', () => {
  const links = [link('/services', 'Services'), link('/services/', 'Services'), link('/services/index.html', 'Services')];
  assert.equal(rank(links).filter((d) => new URL(d.url).pathname.startsWith('/services')).length, 1);
});

test('pages the site\'s robots.txt closes to readers are rejected with that reason and use none of the budget', () => {
  const links = [link('/services', 'Services'), link('/private/pricing', 'Pricing'), link('/about', 'About')];
  const allowed = (path: string): boolean => !path.startsWith('/private');
  assert.deepEqual(chosen(links, { allowed, limit: 2 }).slice().sort(), ['/about', '/services']);
  assert.match(decision(links, '/private/pricing', { allowed })?.reasons.join(' ') ?? '', /robots\.txt/);
});

test('the number of pages chosen never goes past the limit, best first', () => {
  const links = Array.from({ length: 30 }, (_, i) => link(`/services/s${i}`, 'Service'));
  assert.equal(chosen(links, { limit: 5 }).length, 5);
  const ranked = rank([link('/services', 'Services'), link('/zzz', 'zzz'), link('/pricing', 'Pricing')]);
  assert.ok((ranked[0]?.score ?? 0) >= (ranked[1]?.score ?? 0));
});

test('every candidate, chosen or not, comes back with a score and at least one recorded reason', () => {
  const links = [link('/services', 'Services'), link('/privacy', 'Privacy', 'footer'), link('/ae/services', 'Services', 'footer'), link('/ae', 'ae', 'footer'), link('/blog/page/2', 'More', 'body'), link('/x', 'x', 'body')];
  const decisions = rank(links, { alternates: [{ lang: 'ar-ae', url: 'https://acme.com/ae' }] });
  assert.ok(decisions.length >= links.length - 1);
  for (const d of decisions) {
    assert.equal(typeof d.score, 'number');
    assert.ok(d.reasons.length > 0, d.url);
  }
});
