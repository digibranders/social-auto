/**
 * Reads a business website: page text, logo candidates, colours and fonts.
 *
 * Every address goes through safe-fetch.ts (public addresses only, checked at every redirect, an honest name, robots.txt
 * respected). A page that arrives nearly empty because the site builds itself in the browser is rendered in Chrome.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { chromeDumpArgs, chromePath } from './platform.ts';
import { canonicalOf, duplicateOf, rankPages, type PageDecision, type RankingConfig } from './pages.ts';
import { assertPublicUrl, parseRobots, robotsAllows, safeFetch, type FetchedPage } from './safe-fetch.ts';

const run = promisify(execFile);
/** A page with less text than this probably builds itself in the browser. */
const THIN_CHARS = 300;
/** Less text than this over the whole site, even after rendering, is not enough to write posts from. */
const MIN_TOTAL_CHARS = 400;
const MAX_RENDERS = 4;
const RENDER_TIMEOUT_MS = 45_000;
const MAX_PAGES = 8;
const MAX_CHARS_PER_PAGE = 3_000;
const MAX_STYLESHEETS = 4;

export class CrawlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CrawlError';
  }
}

/** The site was read, but it holds too little text to plan posts from. The dashboard shows this message to the person. */
export class TooLittleContentError extends CrawlError {
  constructor(site: string) {
    super(`${site} gave too little to read (almost no text on its pages). Add a few sentences about the business to the site, or write the brand details by hand.`);
    this.name = 'TooLittleContentError';
  }
}

/** What the crawler uses to reach the outside; tests replace it. */
export interface CrawlDeps {
  fetchPage?: (url: string) => Promise<FetchedPage>;
  /** The page's text after its scripts have run (the HTML Chrome ends up with). */
  render?: (url: string) => Promise<string>;
  /** A client's own page vocabulary and thresholds for ranking pages; see `RankingConfig`. */
  ranking?: Partial<RankingConfig>;
}

/** Opens a public page in headless Chrome and returns the page as it looks after its scripts ran. */
export async function renderWithChrome(url: string, env: Record<string, string | undefined> = process.env): Promise<string> {
  await assertPublicUrl(new URL(url));
  const profile = await mkdtemp(join(tmpdir(), 'engine-crawl-'));
  try {
    const { stdout } = await run(chromePath(env, process.platform), chromeDumpArgs(profile, url, env), { timeout: RENDER_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
}

export interface CrawledPage {
  url: string;
  title: string;
  description: string;
  text: string;
}

export interface SiteSnapshot {
  origin: string;
  pages: CrawledPage[];
  /** Absolute URLs, most likely logo first. */
  logoCandidates: string[];
  /** The site's own browser/app icons, best first; a second choice when no logo picture is found. */
  iconCandidates: string[];
  /** #RRGGBB colours, most frequent first. */
  colors: string[];
  fonts: string[];
  /** Every internal link of the homepage with its score and the reason it was or was not read, for review. */
  pageDecisions: PageDecision[];
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>');
}

function metaContent(html: string, key: string): string {
  const pattern = new RegExp(`<meta[^>]+(?:name|property)=["']${key}["'][^>]*content=["']([^"']*)["']`, 'i');
  const reversed = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${key}["']`, 'i');
  return decodeEntities(html.match(pattern)?.[1] ?? html.match(reversed)?.[1] ?? '');
}

export function htmlToText(html: string): string {
  const stripped = html
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(nav|footer)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(stripped).replace(/\s+/g, ' ').trim();
}

/** Words in an address or alt text that mean a picture shows somebody else's logo: a client, partner, customer or press logo. */
const OTHER_COMPANY = /(^|[\/_.\- ])(clients?|customers?|partners?|testimonials?|portfolio|case-?stud(y|ies)|trusted|press|featured|brands?-?wall|sponsors?)([\/_.\- ]|$)/i;
/** The score a picture needs to count as the business's own logo. */
const LOGO_THRESHOLD = 6;

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** Words in an address that mean a promo, product photo or page banner, never the business's own logo. */
const NOT_A_LOGO = /(^|[\/_.\-=,])(promo|hero|banner|product|screenshot|background|cover|feature|splash|collection)([\/_.\-=,]|$)/i;
/** A picture this wide (in pixels) is a photo, not a logo. */
const BIG_PICTURE_WIDTH = 500;

/** The width a picture is shown or fetched at, from its width attribute or a width/w parameter in its address; 0 when unknown. */
function pictureWidth(tag: string, src: string): number {
  const attribute = tag.match(/\swidth=["']?(\d+)/i)?.[1];
  const parameter = src.match(/[?&,/](?:width|w)=(\d+)/i)?.[1];
  return Math.max(Number(attribute ?? 0), Number(parameter ?? 0));
}

function logoScore(src: string, alt: string, siteName: string, tag: string, inLogoPlace: boolean): number {
  const haystack = `${safeDecode(src)} ${alt}`.toLowerCase();
  // A promo, product photo or banner, or a picture this wide, is never a logo, wherever it sits.
  if (NOT_A_LOGO.test(safeDecode(src)) || pictureWidth(tag, src) >= BIG_PICTURE_WIDTH) return -Infinity;
  let score = 0;
  if (haystack.includes('logo')) score += 4;
  if (siteName.length >= 3 && haystack.includes(siteName)) score += 6;
  if (/\.svg(\?|$)/i.test(src)) score += 2;
  if (/horizontal|wordmark|full/i.test(src)) score += 1;
  if (/white|inverse|negative|footer/i.test(src)) score -= 3;
  if (/icon|favicon|apple-touch/i.test(src)) score -= 1;
  if (OTHER_COMPANY.test(haystack)) score -= 10;
  // Where it sits matters most: the header, the navigation and the link to the home page hold the business's own logo;
  // a "logo" in the body is nearly always a customer's, a partner's or a promo.
  score += inLogoPlace ? 6 : -3;
  return score;
}

/** The stretches of the page where a business puts its own logo: the header, the navigation and any link to the home page. */
function logoPlaces(html: string, base: URL): Array<[number, number]> {
  const places: Array<[number, number]> = [];
  for (const match of html.matchAll(/<(header|nav)\b[\s\S]*?<\/\1>/gi)) places.push([match.index, match.index + match[0].length]);
  for (const match of html.matchAll(/<a\b[^>]*\shref=["']([^"']*)["'][^>]*>[\s\S]*?<\/a>/gi)) {
    try {
      const target = new URL(decodeEntities(match[1] ?? ''), base);
      if (target.origin === base.origin && target.pathname.replace(/\/+$/, '') === '' && !target.search && !target.hash) places.push([match.index, match.index + match[0].length]);
    } catch {
      continue;
    }
  }
  return places;
}

/**
 * Pictures that could be the business's own logo, best first. Only a picture in the header, the navigation or the link to the
 * home page whose name or alt text carries the business's name or plainly says "logo", and that is not a customer's, a partner's,
 * a promo or a big photo, counts. Other companies' logos and the small browser icons never do: with no candidate the site's
 * own icon is used, and without one the brand's name is drawn.
 */
export function findLogoCandidates(html: string, base: URL): string[] {
  const siteName = base.hostname.replace(/^www\./, '').split('.')[0] ?? '';
  const places = logoPlaces(html, base);
  const scored = new Map<string, number>();
  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0];
    const src = tag.match(/\ssrc=["']([^"']+)["']/i)?.[1];
    if (!src || src.startsWith('data:')) continue;
    const alt = tag.match(/\salt=["']([^"']*)["']/i)?.[1] ?? '';
    const inLogoPlace = places.some(([from, to]) => match.index >= from && match.index < to);
    const score = logoScore(src, alt, siteName.toLowerCase(), tag, inLogoPlace);
    if (score < LOGO_THRESHOLD) continue;
    let url: string;
    try {
      url = new URL(decodeEntities(src), base).href;
    } catch {
      continue;
    }
    scored.set(url, Math.max(score, scored.get(url) ?? -Infinity));
  }
  return [...scored.entries()].sort((a, b) => b[1] - a[1]).map(([url]) => url);
}

/** The size an icon link declares ("512x512" -> 512), or 0 when it declares none. */
function declaredSize(tag: string): number {
  const sizes = tag.match(/\ssizes=["'](\d+)x\d+/i);
  return sizes?.[1] ? Number(sizes[1]) : 0;
}

/**
 * The site's own icons (the page head's icon and apple-touch-icon links): the biggest first, and the old .ico
 * format after everything else. A second choice for the logo, since nearly every site has one.
 */
export function findIconCandidates(html: string, base: URL): string[] {
  const found = new Map<string, { size: number; ico: boolean }>();
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    if (!/\srel=["'][^"']*\bicon\b[^"']*["']/i.test(tag) && !/\srel=["'][^"']*apple-touch-icon[^"']*["']/i.test(tag)) continue;
    const href = tag.match(/\shref=["']([^"']+)["']/i)?.[1];
    if (!href || href.startsWith('data:')) continue;
    let url: URL;
    try {
      url = new URL(decodeEntities(href), base);
    } catch {
      continue;
    }
    found.set(url.href, { size: declaredSize(tag), ico: /\.ico$/i.test(url.pathname) });
  }
  return [...found.entries()]
    .sort(([, a], [, b]) => Number(a.ico) - Number(b.ico) || b.size - a.size)
    .map(([url]) => url);
}

function expandHex(hex: string): string {
  const h = hex.slice(1);
  return `#${(h.length === 3 ? [...h].map((c) => c + c).join('') : h.slice(0, 6)).toUpperCase()}`;
}

export function collectColors(sources: string[]): string[] {
  const counts = new Map<string, number>();
  for (const source of sources) {
    for (const match of source.matchAll(/#(?:[0-9a-f]{6}|[0-9a-f]{3})\b/gi)) {
      const hex = expandHex(match[0]);
      counts.set(hex, (counts.get(hex) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([hex]) => hex).slice(0, 16);
}

function collectFonts(sources: string[]): string[] {
  const fonts = new Set<string>();
  for (const source of sources) {
    for (const match of source.matchAll(/fonts\.googleapis\.com\/css2?\?family=([^&"':]+)/gi)) {
      if (match[1]) fonts.add(decodeURIComponent(match[1]).replaceAll('+', ' '));
    }
    for (const match of source.matchAll(/@font-face\s*{[^}]*font-family:\s*["']?([^;"'}]+)/gi)) {
      const name = match[1]?.replace(/^_+/, '').replace(/_[0-9a-f]{4,}$/i, '').replace(/_Fallback.*$/i, '').replaceAll('_', ' ').trim();
      if (name && !/fallback|icon|awesome/i.test(name)) fonts.add(name);
    }
  }
  return [...fonts].slice(0, 6);
}

export async function crawlSite(siteUrl: string, deps: CrawlDeps = {}): Promise<SiteSnapshot> {
  const fetchPage = deps.fetchPage ?? ((url: string) => safeFetch(url));
  const render = deps.render ?? ((url: string) => renderWithChrome(url));
  const start = new URL(/^https?:\/\//i.test(siteUrl) ? siteUrl : `https://${siteUrl}`);

  // What the site asks of automated readers. No robots.txt (or none we can read) means no restrictions.
  const robots = await fetchPage(new URL('/robots.txt', start).href).then((page) => parseRobots(page.body)).catch(() => []);
  if (!robotsAllows(robots, start.pathname || '/')) {
    throw new CrawlError(`${start.hostname} asks automated readers not to read it (robots.txt), so it was not read.`);
  }

  const get = (url: string): Promise<FetchedPage | null> => fetchPage(url).catch(() => null);
  const home = await fetchPage(start.href).catch((error: unknown) => {
    throw new CrawlError(`Could not load ${start.href}: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (!home.type.includes('html')) throw new CrawlError(`Could not load ${start.href}: it is not a web page`);
  const base = new URL(home.finalUrl);

  // A page with almost no text probably builds itself in the browser: look at it the way a browser does.
  let renders = 0;
  const readable = async (url: string, body: string): Promise<string> => {
    if (htmlToText(body).length >= THIN_CHARS || renders >= MAX_RENDERS) return body;
    renders += 1;
    try {
      const rendered = await render(url);
      return htmlToText(rendered).length > htmlToText(body).length ? rendered : body;
    } catch {
      return body;
    }
  };

  const homeBody = await readable(base.href, home.body);
  const pages: CrawledPage[] = [];
  const addPage = (url: string, html: string): void => {
    pages.push({
      url,
      title: decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? ''),
      description: metaContent(html, 'description') || metaContent(html, 'og:description'),
      text: htmlToText(html).slice(0, MAX_CHARS_PER_PAGE),
    });
  };
  addPage(base.href, homeBody);

  const decisions = rankPages(homeBody, base, MAX_PAGES - 1, { allowed: (path) => robotsAllows(robots, path), ...(deps.ranking ? { config: deps.ranking } : {}) });
  for (const decision of decisions.filter((d) => d.selected)) {
    const page = await get(decision.url);
    if (!page?.type.includes('html')) {
      decision.selected = false;
      decision.reasons.push(page ? 'not read: it is not a web page' : 'not read: it could not be loaded');
      continue;
    }
    const html = await readable(decision.url, page.body);
    const text = htmlToText(html).slice(0, MAX_CHARS_PER_PAGE);
    const repeats = duplicateOf({ url: decision.url, canonical: canonicalOf(html, new URL(decision.url)), text }, pages);
    if (repeats) {
      decision.selected = false;
      decision.reasons.push(`not read: duplicate of ${repeats} (same canonical address or the same text)`);
      continue;
    }
    addPage(decision.url, html);
  }
  if (pages.reduce((sum, page) => sum + page.text.length, 0) < MIN_TOTAL_CHARS) throw new TooLittleContentError(base.hostname);

  const stylesheetUrls = [...homeBody.matchAll(/<link[^>]+href=["']([^"']+\.css[^"']*)["']/gi)]
    .map((m) => (m[1] ? new URL(decodeEntities(m[1]), base).href : ''))
    .filter(Boolean)
    .slice(0, MAX_STYLESHEETS);
  const stylesheets = (await Promise.all(stylesheetUrls.map(get))).map((sheet) => sheet?.body ?? '');

  const logoCandidates = findLogoCandidates(homeBody, base);
  const logoSvgs = await Promise.all(
    logoCandidates.filter((u) => /\.svg(\?|$)/i.test(u)).slice(0, 2).map(async (u) => (await get(u))?.body ?? ''),
  );
  const themeColor = metaContent(homeBody, 'theme-color');

  return {
    origin: base.origin,
    pages,
    logoCandidates,
    iconCandidates: findIconCandidates(homeBody, base),
    // Logo colours count double: they are the most reliable brand signal.
    colors: collectColors([...logoSvgs, ...logoSvgs, themeColor, homeBody, ...stylesheets]),
    fonts: collectFonts([homeBody, ...stylesheets]),
    pageDecisions: decisions,
  };
}
