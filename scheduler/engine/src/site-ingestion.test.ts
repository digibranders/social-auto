import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { aiConfigFromEnv } from './ai.ts';
import { analyzeSite } from './analyze.ts';
import { crawlSite, type CrawlDeps, type SiteSnapshot } from './crawl.ts';
import { extractLinkInfo } from './pages.ts';
import { FetchRefusedError, type FetchedPage } from './safe-fetch.ts';

/**
 * The whole chain from a real saved homepage to the brand stage: pages are ranked, the chosen ones are fetched (and only those),
 * their text is read, and the brand profile call receives exactly that text. robots.txt and the page budget are respected.
 */
const HOME = readFileSync(new URL('./fixtures/sites/fynix-real/home.html', import.meta.url), 'utf8');
const ORIGIN = 'https://www.fynix.digital';
const base = new URL(`${ORIGIN}/`);

/** A word nobody would write on a real site, unique to each page, to follow its text through the chain. */
const marker = (path: string): string => `zq${path.replace(/[^a-z0-9]/gi, '')}marker`;
const pageFor = (path: string): string =>
  `<!doctype html><html><head><title>${path}</title></head><body><main><h1>${marker(path)}</h1><p>${`Wording on the ${marker(path)} page about what the business does for customers every day. `.repeat(6)}</p></main></body></html>`;

const internalPaths = extractLinkInfo(HOME, base).links.map((l) => new URL(l.url).pathname).filter((p) => p !== '/');

function world(options: { robots?: string; broken?: string[] } = {}) {
  const fetched: string[] = [];
  const deps: CrawlDeps = {
    fetchPage: async (url: string): Promise<FetchedPage> => {
      fetched.push(url);
      const path = new URL(url).pathname;
      if (path === '/robots.txt') return { finalUrl: url, body: options.robots ?? '', type: 'text/plain' };
      if (path === '/') return { finalUrl: `${ORIGIN}/`, body: HOME, type: 'text/html' };
      if (options.broken?.includes(path) || !internalPaths.includes(path)) throw new FetchRefusedError(`${url} answered 404`);
      return { finalUrl: url, body: pageFor(path), type: 'text/html' };
    },
    render: async () => {
      throw new Error('no browser in this test');
    },
  };
  return { deps, fetched };
}

const readPaths = (snapshot: SiteSnapshot): string[] => snapshot.pages.map((p) => new URL(p.url).pathname).filter((p) => p !== '/');
/** The pages (not the stylesheets or logo files the crawler also asks for) that were requested. */
const fetchedPages = (fetched: string[]): string[] => fetched.map((u) => new URL(u).pathname).filter((p) => internalPaths.includes(p));

test('exactly the chosen pages are fetched and read, and each one\'s text reaches the snapshot', async () => {
  const { deps, fetched } = world();
  const snapshot = await crawlSite(`${ORIGIN}/`, { ...deps, maxPages: 8 });
  const chosen = snapshot.pageDecisions.filter((d) => d.selected).map((d) => new URL(d.url).pathname);
  assert.deepEqual(readPaths(snapshot).sort(), chosen.sort());
  assert.deepEqual(fetchedPages(fetched).sort(), chosen.sort(), 'nothing was fetched that was not chosen');
  assert.ok(snapshot.pages.length <= 8 && snapshot.pages.length >= 5);
  for (const page of snapshot.pages.filter((p) => new URL(p.url).pathname !== '/')) {
    assert.ok(page.text.includes(marker(new URL(page.url).pathname)), page.url);
    assert.ok(page.text.length <= 3000);
  }
  for (const decision of snapshot.pageDecisions.filter((d) => !d.selected)) assert.ok(!fetchedPages(fetched).includes(new URL(decision.url).pathname) || decision.reasons.some((r) => /not read/.test(r)), decision.url);
});

test('a page robots.txt closes to readers is never fetched, and its place goes to another page', async () => {
  const open = world();
  const baseline = await crawlSite(`${ORIGIN}/`, { ...open.deps, maxPages: 8 });
  const { deps, fetched } = world({ robots: 'User-agent: *\nDisallow: /faqs\nDisallow: /services/seo\n' });
  const snapshot = await crawlSite(`${ORIGIN}/`, { ...deps, maxPages: 8 });
  assert.ok(!fetchedPages(fetched).some((p) => p === '/faqs' || p === '/services/seo'));
  assert.ok(!readPaths(snapshot).includes('/faqs'));
  assert.ok(snapshot.pageDecisions.find((d) => d.url.endsWith('/faqs'))?.reasons.some((r) => /robots\.txt/.test(r)));
  assert.equal(snapshot.pages.length, baseline.pages.length, 'blocked pages use none of the budget');
});

test('the page budget is a ceiling on fetches, the homepage included', async () => {
  const { deps, fetched } = world();
  const snapshot = await crawlSite(`${ORIGIN}/`, { ...deps, maxPages: 3 });
  assert.equal(snapshot.pages.length, 3);
  assert.equal(fetchedPages(fetched).length, 2);
  const skipped = snapshot.pageDecisions.filter((d) => !d.selected && /budget|cap/.test(d.reasons.join(' ')));
  assert.ok(skipped.length > 0);
});

test('a broken page is replaced by the next best one, and the brand stage sees exactly the pages that were read', async () => {
  const { deps } = world({ broken: ['/about'] });
  const snapshot = await crawlSite(`${ORIGIN}/`, { ...deps, maxPages: 7 });
  assert.ok(!readPaths(snapshot).includes('/about'));
  assert.equal(snapshot.pages.length, 7, 'the broken page did not shrink the budget');

  const dir = await mkdtemp(join(tmpdir(), 'ingestion-test-'));
  try {
    let prompt = '';
    const answer = {
      name: 'Fynix Digital', website: ORIGIN, handleUrl: 'fynix.digital', offer: 'Marketing services', audience: 'B2B teams', tone: 'Direct', proofPoints: ['Six services'],
      callToAction: 'Visit fynix.digital (link in bio)', rules: ['No invented prices'], colors: { background: '#FCFBF9', ink: '#102234', accent: '#E9AF88', tile: '#0C1E2E' }, font: 'Figtree',
      visualStyle: 'Navy and peach', features: [{ icon: 'monitor', title: 'Development', detail: 'Custom websites' }],
    };
    const chatFetch = (async (_url: unknown, init: RequestInit) => {
      const messages = (JSON.parse(String(init.body)) as { messages: Array<{ role: string; content: string }> }).messages;
      prompt = messages.map((m) => m.content).join('\n');
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
    }) as typeof fetch;
    const { dir: brandDir } = await analyzeSite(ORIGIN, dir, aiConfigFromEnv({ OPENAI_API_KEY: 'sk-test-key-1234' }), {
      crawl: async () => snapshot,
      fetchBytes: async () => {
        throw new Error('no logo download in this test');
      },
      chatFetch,
    });
    for (const path of readPaths(snapshot)) assert.ok(prompt.includes(marker(path)), `the brand stage should see ${path}`);
    for (const decision of snapshot.pageDecisions.filter((d) => !d.selected)) assert.ok(!prompt.includes(marker(new URL(decision.url).pathname)), `${decision.url} was not read and must not appear`);
    const saved = JSON.parse(await readFile(join(brandDir, 'pages.json'), 'utf8')) as { read: Array<{ url: string }>; skipped: Array<{ url: string; reasons: string[] }> };
    assert.deepEqual(saved.read.map((d) => new URL(d.url).pathname).sort(), readPaths(snapshot).sort());
    assert.ok(saved.skipped.every((d) => d.reasons.length > 0));
    assert.ok(saved.skipped.find((d) => d.url.endsWith('/about'))?.reasons.some((r) => /could not be loaded/.test(r)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
