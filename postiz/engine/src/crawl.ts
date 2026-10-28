/** Reads a business website: page text, logo candidates, colours and fonts. */

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_PAGES = 8;
const MAX_CHARS_PER_PAGE = 3_000;
const MAX_STYLESHEETS = 4;
const PRIORITY_PATH = /about|service|pricing|price|plan|product|feature|solution|faq|for\/|why|how|industr|work/i;
const SKIP_PATH = /privacy|terms|refund|shipping|cookie|login|signin|signup|cart|checkout|account|wp-admin|\.(pdf|jpg|png|svg|xml)$/i;

export class CrawlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CrawlError';
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
  /** #RRGGBB colours, most frequent first. */
  colors: string[];
  fonts: string[];
}

async function fetchText(url: string): Promise<{ finalUrl: string; body: string; type: string } | null> {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,text/css,*/*' },
      redirect: 'follow',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return { finalUrl: response.url, body: await response.text(), type: response.headers.get('content-type') ?? '' };
  } catch {
    return null;
  }
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

function internalLinks(html: string, base: URL): string[] {
  const links = new Set<string>();
  for (const match of html.matchAll(/href=["']([^"'#?]+)["']/gi)) {
    const href = match[1];
    if (!href) continue;
    let url: URL;
    try {
      url = new URL(href, base);
    } catch {
      continue;
    }
    if (url.hostname !== base.hostname || SKIP_PATH.test(url.pathname) || url.pathname === '/') continue;
    links.add(url.origin + url.pathname.replace(/\/$/, ''));
  }
  return [...links].sort((a, b) => Number(PRIORITY_PATH.test(b)) - Number(PRIORITY_PATH.test(a)));
}

function logoScore(src: string, alt: string, siteName: string): number {
  const haystack = `${src} ${alt}`.toLowerCase();
  let score = 0;
  if (haystack.includes('logo')) score += 4;
  if (siteName && haystack.includes(siteName)) score += 2;
  if (/\.svg(\?|$)/i.test(src)) score += 2;
  if (/horizontal|wordmark|full/i.test(src)) score += 1;
  if (/white|inverse|negative|footer/i.test(src)) score -= 3;
  if (/icon|favicon|apple-touch/i.test(src)) score -= 1;
  return score;
}

function findLogoCandidates(html: string, base: URL): string[] {
  const siteName = base.hostname.replace(/^www\./, '').split('.')[0] ?? '';
  const scored: Array<{ url: string; score: number }> = [];
  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0];
    const src = tag.match(/\ssrc=["']([^"']+)["']/i)?.[1];
    if (!src || src.startsWith('data:')) continue;
    const alt = tag.match(/\salt=["']([^"']*)["']/i)?.[1] ?? '';
    const score = logoScore(src, alt, siteName);
    if (score > 0) scored.push({ url: new URL(decodeEntities(src), base).href, score });
  }
  for (const match of html.matchAll(/<link[^>]+rel=["'](?:icon|apple-touch-icon)["'][^>]*href=["']([^"']+)["']/gi)) {
    if (match[1]) scored.push({ url: new URL(decodeEntities(match[1]), base).href, score: 0 });
  }
  const unique = new Map<string, number>();
  for (const { url, score } of scored) unique.set(url, Math.max(score, unique.get(url) ?? -Infinity));
  return [...unique.entries()].sort((a, b) => b[1] - a[1]).map(([url]) => url);
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

export async function crawlSite(siteUrl: string): Promise<SiteSnapshot> {
  const start = new URL(/^https?:\/\//i.test(siteUrl) ? siteUrl : `https://${siteUrl}`);
  const home = await fetchText(start.href);
  if (!home || !home.type.includes('html')) throw new CrawlError(`Could not load ${start.href}`);
  const base = new URL(home.finalUrl);

  const pages: CrawledPage[] = [];
  const addPage = (url: string, html: string): void => {
    pages.push({
      url,
      title: decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? ''),
      description: metaContent(html, 'description') || metaContent(html, 'og:description'),
      text: htmlToText(html).slice(0, MAX_CHARS_PER_PAGE),
    });
  };
  addPage(base.href, home.body);

  for (const link of internalLinks(home.body, base).slice(0, MAX_PAGES - 1)) {
    const page = await fetchText(link);
    if (page?.type.includes('html')) addPage(link, page.body);
  }

  const stylesheetUrls = [...home.body.matchAll(/<link[^>]+href=["']([^"']+\.css[^"']*)["']/gi)]
    .map((m) => (m[1] ? new URL(decodeEntities(m[1]), base).href : ''))
    .filter(Boolean)
    .slice(0, MAX_STYLESHEETS);
  const stylesheets = (await Promise.all(stylesheetUrls.map(fetchText))).map((s) => s?.body ?? '');

  const logoCandidates = findLogoCandidates(home.body, base);
  const logoSvgs = await Promise.all(
    logoCandidates.filter((u) => /\.svg(\?|$)/i.test(u)).slice(0, 2).map(async (u) => (await fetchText(u))?.body ?? ''),
  );
  const themeColor = metaContent(home.body, 'theme-color');

  return {
    origin: base.origin,
    pages,
    logoCandidates,
    // Logo colours count double: they are the most reliable brand signal.
    colors: collectColors([...logoSvgs, ...logoSvgs, themeColor, home.body, ...stylesheets]),
    fonts: collectFonts([home.body, ...stylesheets]),
  };
}
