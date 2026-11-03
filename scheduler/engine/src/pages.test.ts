import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { canonicalOf, defaultRankingConfig, duplicateOf, rankPages, siteVocabulary, type PageDecision } from './pages.ts';

const SITES = new URL('./fixtures/sites/', import.meta.url).pathname;
const LIMIT = 7;

interface Expectation {
  base: string;
  mustSelect: string[];
  mustReject: string[];
  maxSelected: number;
  /** At least `count` of these pages must be chosen: for a family of similar pages where any few will do. */
  atLeast?: Array<{ from: string[]; count: number }>;
}

const pathOf = (decision: PageDecision): string => new URL(decision.url).pathname;
const selectedPaths = (decisions: PageDecision[]): string[] => decisions.filter((d) => d.selected).map(pathOf);

const fixtures = readdirSync(SITES, { withFileTypes: true }).filter((entry) => entry.isDirectory());

test('there are fixtures to rank, so the data-driven test below cannot pass by checking nothing', () => {
  assert.ok(fixtures.length >= 11);
});

for (const folder of fixtures) {
  test(`fixture ${folder.name}: the pages that describe the business are chosen, the utility pages are not, and the cap holds`, () => {
    const html = readFileSync(join(SITES, folder.name, 'home.html'), 'utf8');
    const expectation = JSON.parse(readFileSync(join(SITES, folder.name, 'expect.json'), 'utf8')) as Expectation;
    const decisions = rankPages(html, new URL(expectation.base), LIMIT);
    const chosen = selectedPaths(decisions);
    for (const path of expectation.mustSelect) assert.ok(chosen.includes(path), `${folder.name}: ${path} should be selected, got ${chosen.join(', ')}`);
    for (const path of expectation.mustReject) assert.ok(!chosen.includes(path), `${folder.name}: ${path} should be rejected`);
    for (const group of expectation.atLeast ?? []) {
      const found = group.from.filter((path) => chosen.includes(path));
      assert.ok(found.length >= group.count, `${folder.name}: wanted at least ${group.count} of ${group.from.join(', ')}; got ${found.length} (${chosen.join(', ')})`);
    }
    assert.ok(chosen.length <= Math.min(LIMIT, expectation.maxSelected), `${folder.name}: ${chosen.length} selected`);
  });
}

test('every link gets one decision with at least one recorded reason, and a selected page says why it was chosen', () => {
  const html = readFileSync(join(SITES, 'saas', 'home.html'), 'utf8');
  const decisions = rankPages(html, new URL('https://flowdesk.example'), LIMIT);
  const urls = decisions.map((d) => d.url);
  assert.equal(new Set(urls).size, urls.length);
  assert.ok(urls.includes('https://flowdesk.example/pricing') && urls.includes('https://flowdesk.example/privacy'));
  for (const decision of decisions) assert.ok(decision.reasons.length >= 1, decision.url);
  const pricing = decisions.find((d) => d.url.endsWith('/pricing'));
  assert.ok(pricing?.selected && pricing.reasons.some((r) => /navigation/.test(r)) && pricing.reasons.some((r) => /pricing/i.test(r)));
  const privacy = decisions.find((d) => d.url.endsWith('/privacy'));
  assert.ok(!privacy?.selected && privacy?.reasons.some((r) => /legal|utility/i.test(r)));
});

test('a region switcher is consolidated, not blindly dropped: regional copies of the homepage are rejected with that reason', () => {
  const html = readFileSync(join(SITES, 'ecommerce-regions', 'home.html'), 'utf8');
  const decisions = rankPages(html, new URL('https://orchard.example'), LIMIT);
  for (const path of ['/ae', '/ae-ar', '/jp', '/uk']) {
    const decision = decisions.find((d) => pathOf(d) === path);
    assert.ok(decision && !decision.selected, path);
    assert.ok(decision?.reasons.some((r) => /regional copy of the home ?page/i.test(r)), `${path}: ${decision?.reasons.join(' / ')}`);
  }
});

test('a regional page that is the only version in the site\'s own language stays eligible; other regions and languages are rejected with reasons', () => {
  const html = readFileSync(join(SITES, 'regional-business', 'home.html'), 'utf8');
  const decisions = rankPages(html, new URL('https://brightline.example'), LIMIT);
  const byPath = (path: string): PageDecision | undefined => decisions.find((d) => pathOf(d) === path);
  assert.ok(byPath('/in/pricing')?.selected);
  assert.ok(byPath('/in/about')?.selected);
  assert.ok(byPath('/us/pricing')?.reasons.some((r) => /region|regional/i.test(r)));
  assert.ok(byPath('/de/impressum')?.reasons.some((r) => /language/i.test(r)));
});

test('when the same page exists with and without a region prefix, the plain one wins and the regional one is a recorded duplicate', () => {
  const html = `<html lang="en"><body><nav><a href="/pricing">Pricing</a><a href="/in/pricing">Pricing</a><a href="/us/pricing">Pricing</a><a href="/uk/pricing">Pricing</a><a href="/de/pricing">Pricing</a></nav></body></html>`;
  const decisions = rankPages(html, new URL('https://acme.example'), LIMIT);
  assert.deepEqual(selectedPaths(decisions), ['/pricing']);
  for (const path of ['/in/pricing', '/us/pricing', '/uk/pricing', '/de/pricing']) {
    assert.ok(decisions.find((d) => pathOf(d) === path)?.reasons.some((r) => /duplicate of \/pricing/i.test(r)), path);
  }
});

test('two-letter paths are only taken for regions when the site really has a region switcher', () => {
  const html = `<html lang="en"><body><nav><a href="/ai">AI assistant</a><a href="/us">US team</a><a href="/pricing">Pricing</a></nav></body></html>`;
  const decisions = rankPages(html, new URL('https://acme.example'), LIMIT);
  assert.ok(selectedPaths(decisions).includes('/ai'));
  assert.ok(!decisions.some((d) => d.reasons.some((r) => /regional/i.test(r))));
});

test('query strings and fragments do not make a second page, and the link text counts as a signal', () => {
  const html = `<html lang="en"><body><main><a href="/pricing?ref=nav">x</a><a href="/pricing#plans">x</a><a href="/aaa">Pricing</a><a href="/bbb">Stuff</a></main></body></html>`;
  const decisions = rankPages(html, new URL('https://acme.example'), LIMIT);
  assert.equal(decisions.filter((d) => d.url.endsWith('/pricing')).length, 1);
  const score = (path: string): number => decisions.find((d) => pathOf(d) === path)?.score ?? -99;
  assert.ok(score('/aaa') > score('/bbb'));
});

test('the cap is respected, the best-scored pages win, and the homepage itself is never a candidate', () => {
  const html = readFileSync(join(SITES, 'mega-menu', 'home.html'), 'utf8');
  const decisions = rankPages(html, new URL('https://megacorp.example'), 3);
  assert.equal(decisions.filter((d) => d.selected).length, 3);
  assert.ok(!decisions.some((d) => pathOf(d) === '/'));
  const chosen = decisions.filter((d) => d.selected).map((d) => d.score);
  const rejectedAboveThreshold = decisions.filter((d) => !d.selected && d.score >= Math.min(...chosen));
  assert.ok(rejectedAboveThreshold.every((d) => d.reasons.some((r) => /cap|limit/i.test(r))));
});

test('links to other sites, files and mail are never candidates', () => {
  const html = `<html><body><nav><a href="https://other.example/pricing">x</a><a href="/brochure.pdf">x</a><a href="mailto:a@b.c">x</a><a href="tel:123">x</a><a href="javascript:void(0)">x</a><a href="/about">About</a></nav></body></html>`;
  const decisions = rankPages(html, new URL('https://acme.example'), LIMIT);
  assert.deepEqual(decisions.map((d) => new URL(d.url).pathname), ['/about']);
});

test('a page that names another address as canonical, or repeats a kept page\'s text, is a duplicate; a different page is not', () => {
  const kept = [{ url: 'https://acme.example/pricing', text: 'Plans and pricing for teams. '.repeat(30) }];
  assert.equal(duplicateOf({ url: 'https://acme.example/in/pricing', canonical: 'https://acme.example/pricing', text: 'x' }, kept), 'https://acme.example/pricing');
  assert.equal(duplicateOf({ url: 'https://acme.example/plans', canonical: null, text: 'Plans and pricing for teams. '.repeat(30) }, kept), 'https://acme.example/pricing');
  assert.equal(duplicateOf({ url: 'https://acme.example/about', canonical: 'https://acme.example/about', text: 'We are a small team in Pune. '.repeat(30) }, kept), null);
  assert.equal(duplicateOf({ url: 'https://acme.example/short', canonical: null, text: 'Hi' }, kept), null);
});

test('the canonical address is read from the page and resolved against its own address', () => {
  assert.equal(canonicalOf('<head><link rel="canonical" href="/pricing"></head>', new URL('https://acme.example/in/pricing')), 'https://acme.example/pricing');
  assert.equal(canonicalOf('<link href="https://acme.example/x" rel="canonical">', new URL('https://acme.example/y')), 'https://acme.example/x');
  assert.equal(canonicalOf('<head></head>', new URL('https://acme.example/')), null);
});

const GENERIC_PAGE_TYPES = new Set([
  'pricing', 'price', 'prices', 'plans', 'product', 'products', 'service', 'services', 'solution', 'solutions', 'features', 'platform',
  'about', 'company', 'story', 'mission', 'team', 'how', 'works', 'process', 'approach', 'industries', 'industry', 'case', 'studies',
  'faq', 'contact', 'why', 'work', 'portfolio', 'customers', 'testimonials', 'reviews',
]);

test('the built-in vocabulary holds only generic page types: no industry, product or trade is built in', () => {
  for (const word of Object.keys(defaultRankingConfig.weights)) assert.ok(GENERIC_PAGE_TYPES.has(word), `"${word}" is not a generic page type`);
  for (const word of ['treatments', 'doctors', 'hipaa', 'insurance', 'appointment', 'menu', 'store', 'shop', 'enterprise', 'booking', 'donate', 'programs']) {
    assert.ok(!(word in defaultRankingConfig.weights) && !defaultRankingConfig.utility.includes(word) && !defaultRankingConfig.utilityWhenShort.includes(word), word);
  }
});

test('a client\'s own vocabulary can be configured without touching the code', () => {
  const html = '<html lang="en"><body><main><a href="/donate">Give</a><a href="/gallery">Photos</a></main></body></html>';
  const base = new URL('https://acme.example');
  assert.ok(!selectedPaths(rankPages(html, base, LIMIT)).includes('/donate'));
  const configured = rankPages(html, base, LIMIT, { config: { weights: { donate: 5 } } });
  assert.deepEqual(selectedPaths(configured), ['/donate']);
  assert.ok(configured.find((d) => d.url.endsWith('/donate'))?.reasons.some((r) => /\+5 "donate" page/.test(r)));
  assert.ok(selectedPaths(rankPages(html, base, LIMIT, { config: { minScore: 6, weights: { donate: 5 } } })).length === 0);
});

test('words the site itself uses on its homepage lift matching pages, whatever the industry, with no word list', () => {
  const html = `<html lang="en"><head><title>Maple Table</title><meta name="description" content="A seasonal tasting menu"></head><body><h1>Our tasting menu</h1><main><p>Menu menu menu.</p><a href="/menu">See it</a><a href="/gallery">Photos</a></main></body></html>`;
  const decisions = rankPages(html, new URL('https://acme.example'), LIMIT);
  assert.deepEqual(selectedPaths(decisions), ['/menu']);
  assert.ok(decisions.find((d) => d.url.endsWith('/menu'))?.reasons.some((r) => /homepage's own wording \("menu"\)/.test(r)));
  assert.ok(!decisions.find((d) => d.url.endsWith('/gallery'))?.selected);
});

test('the site\'s own words work in any language, and legal pages are never lifted by them', () => {
  const html = `<html lang="de"><head><title>Praxis Lindenhof</title></head><body><h1>Zahnbehandlung ohne Angst</h1><main><a href="/zahnbehandlung">Mehr</a><a href="/datenschutz-zahnbehandlung">x</a><a href="/privacy-zahnbehandlung">x</a></main></body></html>`;
  const decisions = rankPages(html, new URL('https://praxis.example'), LIMIT);
  assert.ok(decisions.find((d) => d.url.endsWith('/zahnbehandlung'))?.selected);
  assert.ok(!decisions.find((d) => d.url.endsWith('/privacy-zahnbehandlung'))?.selected);
});

test('the site vocabulary comes from its title, description, headings and repeated words, and ignores its menus', () => {
  const vocab = siteVocabulary('<html><head><title>Blue Harbor Sailing</title><meta name="description" content="Learn to sail"></head><body><nav><a href="/x">Navigation</a></nav><h1>Sailing lessons</h1><p>harbor harbor harbor tides</p><footer>Copyright footer</footer></body></html>');
  for (const word of ['harbor', 'sailing', 'sail', 'lessons', 'learn']) assert.ok(vocab.has(word), word);
  assert.ok(!vocab.has('navigation') && !vocab.has('footer') && !vocab.has('copyright') && !vocab.has('tides'));
});

test('a business with no prices, no products and no offers is ranked on what it does have, and a one-page site yields no candidates', () => {
  const nonprofit = rankPages(readFileSync(join(SITES, 'nonprofit', 'home.html'), 'utf8'), new URL('https://clearwater.example'), LIMIT);
  assert.ok(selectedPaths(nonprofit).includes('/donate') && selectedPaths(nonprofit).includes('/programs'));
  assert.deepEqual(rankPages(readFileSync(join(SITES, 'one-page', 'home.html'), 'utf8'), new URL('https://studionine.example'), LIMIT), []);
});

test('singular and plural forms of a page type score the same, so "/faqs" is "/faq" and "/case-study" is "/case-studies"', () => {
  const html = '<html lang="en"><body><main><a href="/faqs">x</a><a href="/faq">x</a><a href="/service">x</a><a href="/services">x</a><a href="/case-study">x</a><a href="/feature">x</a></main></body></html>';
  const decisions = rankPages(html, new URL('https://acme.example'), LIMIT);
  const score = (path: string): number => decisions.find((d) => pathOf(d) === path)?.score ?? -99;
  assert.equal(score('/faqs'), score('/faq'));
  assert.equal(score('/service'), score('/services'));
  assert.ok(score('/feature') > 0 && score('/case-study') > 0);
});

test('with room for one more page, an FAQ page, which holds facts about the offer, beats a bare contact page', () => {
  const html = '<html lang="en"><body><header><nav><a href="/about">About</a><a href="/services">Services</a><a href="/contact">Contact</a></nav></header><footer><a href="/faqs">FAQs</a></footer></body></html>';
  const chosen = selectedPaths(rankPages(html, new URL('https://acme.example'), 3));
  assert.deepEqual(chosen.sort(), ['/about', '/faqs', '/services']);
});

test('an ambiguous word is a utility page only when it is the page itself: "/my-account" yes, "/services/linkedin-account-management" no', () => {
  const html = `<html lang="en"><body><nav>
    <a href="/services/linkedin-account-management">LinkedIn account management</a><a href="/services/admin-support">Admin support</a><a href="/jobs-board-software">Jobs board software</a>
    <a href="/account">Account</a><a href="/my-account/orders">Orders</a><a href="/patient-portal">Portal</a><a href="/client-dashboard">Dashboard</a><a href="/register">Register</a><a href="/jobs">Jobs</a>
  </nav></body></html>`;
  const decisions = rankPages(html, new URL('https://acme.example'), 20);
  const decision = (path: string): PageDecision | undefined => decisions.find((d) => pathOf(d) === path);
  for (const path of ['/services/linkedin-account-management', '/services/admin-support', '/jobs-board-software']) {
    assert.ok(decision(path)?.selected, `${path} is a page about the offer`);
    assert.ok(!decision(path)?.reasons.some((r) => /legal or utility/.test(r)), path);
  }
  for (const path of ['/account', '/my-account/orders', '/patient-portal', '/client-dashboard', '/register', '/jobs']) {
    assert.ok(!decision(path)?.selected && decision(path)?.reasons.some((r) => /legal or utility/.test(r)), `${path} is housekeeping`);
  }
});

test('words that are always housekeeping flag a page wherever they sit in the address', () => {
  const html = `<html lang="en"><body><nav><a href="/company/privacy-policy">x</a><a href="/about/terms-of-service">x</a><a href="/help/cookies">x</a><a href="/store/checkout">x</a></nav></body></html>`;
  const decisions = rankPages(html, new URL('https://acme.example'), 20);
  assert.equal(decisions.filter((d) => d.selected).length, 0);
  assert.ok(decisions.every((d) => d.reasons.some((r) => /legal or utility/.test(r))));
});
