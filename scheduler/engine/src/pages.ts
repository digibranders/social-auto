/**
 * Which of a site's pages describe the business. Every internal link on the homepage gets a score and a recorded reason, so a
 * page that was read, and one that was not, can always be explained. Regional copies of a page are consolidated to one, not
 * dropped wholesale: a page that exists only in the site's own language and region stays eligible.
 */

export interface PageDecision {
  url: string;
  selected: boolean;
  score: number;
  /** Why it scored as it did and why it was or was not chosen, e.g. `+5 "pricing" page`, `-20 legal or utility page`. */
  reasons: string[];
}

/**
 * The ranking rules as settings. Nothing here belongs to an industry: the words are generic page types every kind of
 * organisation has, and a client's own vocabulary comes from its homepage (see `siteVocabulary`) or from a configured override.
 */
export interface RankingConfig {
  /** Path words that name a generic kind of page, by how strongly they mark a page worth reading. Merged with any override. */
  weights: Readonly<Record<string, number>>;
  /** Path words that mark legal, account or housekeeping pages. Replaced by an override. */
  utility: readonly string[];
  /** A page must score at least this to be read. */
  minScore: number;
  /** After this many pages from one section (the first part of the address), further ones lose points. */
  freePerSection: number;
  sectionPenalty: number;
  /** A site with at least this many two-letter first path parts has a region switcher; with fewer they are ordinary pages ("/ai"). */
  switcherRoots: number;
  navigationBonus: number;
  footerPenalty: number;
  /** Link text that names a kind of page. */
  linkTextBonus: number;
  /** A word from the site's own homepage wording appears in the link's address or text. */
  evidenceBonus: number;
}

export const defaultRankingConfig: RankingConfig = {
  weights: {
    pricing: 5, price: 5, prices: 5, plans: 5, product: 5, products: 5, service: 5, services: 5, solution: 5, solutions: 5, features: 5, platform: 5,
    about: 4, company: 4, story: 4, mission: 4, team: 3,
    how: 3, works: 3, process: 3, approach: 3, industries: 3, industry: 3, case: 3, studies: 3,
    faq: 2, contact: 2, why: 2, work: 2, portfolio: 2,
    customers: 1, testimonials: 1, reviews: 1,
  },
  utility: [
    'privacy', 'terms', 'tos', 'legal', 'cookie', 'cookies', 'login', 'logout', 'signin', 'signup', 'register', 'password', 'cart', 'checkout',
    'account', 'careers', 'jobs', 'sitemap', 'unsubscribe', 'portal', 'dashboard', 'admin', 'imprint', 'impressum', 'disclaimer', 'policy', 'policies',
  ],
  minScore: 2,
  freePerSection: 2,
  sectionPenalty: 2,
  switcherRoots: 3,
  navigationBonus: 3,
  footerPenalty: 1,
  linkTextBonus: 2,
  evidenceBonus: 2,
};

/** Archive pages of a blog or catalogue. */
const ARCHIVE = /(^|\/)(tag|tags|category|categories|author|archive|page)(\/|$)/i;
const FILE = /\.(pdf|jpe?g|png|gif|svg|webp|xml|zip|docx?|xlsx?|mp4|mp3|ico|css|js)$/i;
const LOCALE_ROOT = /^[a-z]{2}(?:-[a-z]{2,4})?$/i;

const tokensOf = (path: string): string[] => path.toLowerCase().split(/[\/\-_.]+/).filter(Boolean);
const normalizedPath = (pathname: string): string => pathname.replace(/\/+$/, '');

function decodeEntities(text: string): string {
  return text.replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#39;', "'");
}

interface Link {
  url: string;
  path: string;
  text: string;
  inNavigation: boolean;
  onlyInFooter: boolean;
  order: number;
}

function regions(html: string, tags: string[]): Array<[number, number]> {
  const found: Array<[number, number]> = [];
  for (const tag of tags) for (const match of html.matchAll(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, 'gi'))) found.push([match.index, match.index + match[0].length]);
  return found;
}

function collectLinks(html: string, base: URL): Link[] {
  const navigation = regions(html, ['nav', 'header']);
  const footer = regions(html, ['footer']);
  const within = (places: Array<[number, number]>, at: number): boolean => places.some(([from, to]) => at >= from && at < to);
  const links = new Map<string, Link>();
  let order = 0;
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = (match[1] ?? '').match(/\shref=["']([^"']*)["']/i)?.[1];
    if (!href || /^(#|mailto:|tel:|javascript:)/i.test(href.trim())) continue;
    let url: URL;
    try {
      url = new URL(decodeEntities(href.trim()), base);
    } catch {
      continue;
    }
    const path = normalizedPath(url.pathname);
    if (url.hostname !== base.hostname || !/^https?:$/.test(url.protocol) || path === '' || FILE.test(path)) continue;
    const key = url.origin + path;
    const text = (match[2] ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const inNav = within(navigation, match.index);
    const inFooter = within(footer, match.index);
    const existing = links.get(key);
    if (existing) {
      existing.inNavigation ||= inNav;
      existing.onlyInFooter &&= inFooter && !inNav;
      if (!existing.text && text) existing.text = text;
    } else {
      links.set(key, { url: key, path, text, inNavigation: inNav, onlyInFooter: inFooter && !inNav, order: order++ });
    }
  }
  return [...links.values()];
}

/** The two-letter language or region parts the homepage declares as alternates (`hreflang`). */
function alternateRoots(html: string, base: URL): Set<string> {
  const roots = new Set<string>();
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    if (!/\shreflang=/i.test(tag) || !/rel=["']alternate["']/i.test(tag)) continue;
    const href = tag.match(/\shref=["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    try {
      const root = new URL(decodeEntities(href), base).pathname.split('/').filter(Boolean)[0];
      if (root && LOCALE_ROOT.test(root)) roots.add(root.toLowerCase());
    } catch {
      continue;
    }
  }
  return roots;
}

function siteLocale(html: string): { language: string; region: string | null } {
  const lang = html.match(/<html\b[^>]*\slang=["']([^"']+)["']/i)?.[1]?.toLowerCase() ?? 'en';
  const [language = 'en', region = null] = lang.split(/[-_]/);
  return { language, region };
}

const WORD = /[\p{L}\p{N}]{4,}/gu;
/** A word repeated this often in a homepage's text counts as part of its own vocabulary. */
const REPEATED_WORD = 3;

/**
 * The words a site uses about itself: those in its title, description and headings, and any repeated in its text (menus and footers
 * left out). It is how the engine learns an industry's vocabulary from the client rather than from a built-in list.
 */
export function siteVocabulary(html: string): Set<string> {
  const vocabulary = new Set<string>();
  const wordsOf = (text: string): string[] => decodeEntities(text).toLowerCase().match(WORD) ?? [];
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '';
  const described = [...html.matchAll(/<meta\b[^>]*>/gi)].map((m) => m[0]).filter((tag) => /(?:name|property)=["'](?:description|og:title|og:description)["']/i.test(tag)).map((tag) => tag.match(/\scontent=["']([^"']*)["']/i)?.[1] ?? '');
  const headings = [...html.matchAll(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/gi)].map((m) => (m[1] ?? '').replace(/<[^>]+>/g, ' '));
  for (const text of [title, ...described, ...headings]) for (const word of wordsOf(text)) vocabulary.add(word);
  const body = html.replace(/<(script|style|noscript|svg|template|nav|footer)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ');
  const counts = new Map<string, number>();
  for (const word of wordsOf(body)) counts.set(word, (counts.get(word) ?? 0) + 1);
  for (const [word, count] of counts) if (count >= REPEATED_WORD) vocabulary.add(word);
  return vocabulary;
}

interface Candidate {
  link: Link;
  /** The path without any region prefix. */
  rest: string;
  root: string | null;
  score: number;
  reasons: string[];
  rejected: boolean;
  /** Set on the regional version that stands for its page; said in the reasons only if the page is then chosen. */
  keptRegional?: string;
}

/** Scores a path for what it looks like, from its own words, its place on the page, its link text and the site's own vocabulary. */
function score(link: Link, rest: string, config: RankingConfig, utility: ReadonlySet<string>, vocabulary: ReadonlySet<string>): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let total = 0;
  const tokens = tokensOf(rest);
  const flagged = tokens.find((t) => utility.has(t));
  if (flagged || ARCHIVE.test(rest)) {
    return { score: -20, reasons: [`-20 legal or utility page (${flagged ?? 'archive'})`] };
  }
  const best = tokens.map((t) => [t, config.weights[t] ?? 0] as const).sort((a, b) => b[1] - a[1])[0];
  if (best && best[1] > 0) {
    total += best[1];
    reasons.push(`+${best[1]} "${best[0]}" page`);
  }
  if (link.inNavigation) {
    total += config.navigationBonus;
    reasons.push(`+${config.navigationBonus} in the navigation`);
  } else if (link.onlyInFooter) {
    total -= config.footerPenalty;
    reasons.push(`-${config.footerPenalty} only in the footer`);
  }
  const linkTokens = tokensOf(link.text);
  if (linkTokens.some((t) => (config.weights[t] ?? 0) >= 3)) {
    total += config.linkTextBonus;
    reasons.push(`+${config.linkTextBonus} link text "${link.text}"`);
  }
  const shared = [...tokens, ...linkTokens].find((t) => [...t].length >= 4 && vocabulary.has(t));
  if (shared) {
    total += config.evidenceBonus;
    reasons.push(`+${config.evidenceBonus} appears in the homepage's own wording ("${shared}")`);
  }
  const depth = Math.min(4, Math.max(0, tokens.length > 0 ? rest.split('/').filter(Boolean).length - 1 : 0));
  if (depth > 0) {
    total -= depth;
    reasons.push(`-${depth} deeper in the site`);
  }
  if (reasons.length === 0) reasons.push('0 no sign that it describes the business');
  return { score: total, reasons };
}

export interface RankOptions {
  /** False for an address the site's robots.txt asks readers to skip. */
  allowed?: (pathname: string) => boolean;
  /** Settings that replace the defaults: a client's own vocabulary and thresholds. `weights` are added to the defaults. */
  config?: Partial<RankingConfig>;
}

/**
 * Decides every internal link of a homepage: its score, whether it is chosen (at most `limit` pages), and why.
 * Links to other sites, files, mail and the homepage itself are not candidates and have no decision.
 */
export function rankPages(html: string, base: URL, limit: number, options: RankOptions = {}): PageDecision[] {
  const config: RankingConfig = { ...defaultRankingConfig, ...options.config, weights: { ...defaultRankingConfig.weights, ...options.config?.weights } };
  const utility = new Set(config.utility);
  const vocabulary = siteVocabulary(html);
  const links = collectLinks(html, base);
  const allowed = options.allowed ?? (() => true);

  // A region switcher: three or more two-letter first path parts, or any the homepage declares as alternates.
  const firstParts = links.map((l) => l.path.split('/')[1]?.toLowerCase() ?? '').filter((p) => LOCALE_ROOT.test(p));
  const declared = alternateRoots(html, base);
  const switcher = new Set<string>(new Set(firstParts).size >= config.switcherRoots ? firstParts : []);
  for (const root of declared) switcher.add(root);
  const site = siteLocale(html);

  const candidates: Candidate[] = links.map((link) => {
    const first = link.path.split('/')[1]?.toLowerCase() ?? '';
    const root = switcher.has(first) ? first : null;
    const rest = root ? normalizedPath(link.path.slice(root.length + 1)) : link.path;
    const { score: points, reasons } = score(link, rest || '/', config, utility, vocabulary);
    return { link, rest, root, score: points, reasons, rejected: false };
  });

  const reject = (candidate: Candidate, reason: string): void => {
    candidate.rejected = true;
    candidate.reasons.push(reason);
  };

  for (const candidate of candidates) {
    if (!allowed(candidate.link.path)) reject(candidate, 'blocked by robots.txt');
  }

  // Regional copies: consolidate each page to one version, preferring the plain address, then the site's own region.
  const matchesSite = (root: string): number => (root === site.region ? 2 : root.slice(0, 2) === site.language ? 1 : 0);
  const byRest = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    if (candidate.root === null || candidate.rejected) continue;
    if (candidate.rest === '') {
      reject(candidate, `regional copy of the homepage (/${candidate.root})`);
      continue;
    }
    byRest.set(candidate.rest, [...(byRest.get(candidate.rest) ?? []), candidate]);
  }
  for (const [rest, group] of byRest) {
    const plain = candidates.find((c) => c.root === null && c.rest === rest && !c.rejected);
    const fit = group.filter((c) => matchesSite(c.root as string) > 0).sort((a, b) => matchesSite(b.root as string) - matchesSite(a.root as string) || a.link.order - b.link.order);
    const winner = plain ? null : fit[0];
    for (const candidate of group) {
      if (plain) reject(candidate, `duplicate of ${plain.rest}: regional copy (/${candidate.root}) of the same page`);
      else if (candidate === winner) candidate.keptRegional = `kept as the version in the site's own language and region (/${candidate.root})`;
      else if (winner) reject(candidate, `duplicate of /${winner.root}${rest}: regional copy (/${candidate.root}) of the same page`);
      else reject(candidate, `regional page for another language or region (/${candidate.root})`);
    }
  }

  // Choose the best, a little at a time so one section cannot fill the whole cap.
  const pool = candidates.filter((c) => !c.rejected && c.score >= config.minScore);
  const chosen: Candidate[] = [];
  const sectionOf = (c: Candidate): string => c.rest.split('/')[1] ?? '';
  const effective = (c: Candidate): number => c.score - config.sectionPenalty * Math.max(0, chosen.filter((p) => sectionOf(p) === sectionOf(c)).length - (config.freePerSection - 1));
  while (chosen.length < limit) {
    const next = pool.filter((c) => !chosen.includes(c) && effective(c) >= config.minScore).sort((a, b) => effective(b) - effective(a) || a.link.order - b.link.order)[0];
    if (!next) break;
    chosen.push(next);
  }

  return candidates.map((candidate): PageDecision => {
    const selected = chosen.includes(candidate);
    const reasons = [...candidate.reasons];
    if (selected && candidate.keptRegional) reasons.push(candidate.keptRegional);
    if (!selected && !candidate.rejected) {
      if (candidate.score < config.minScore) reasons.push(`not selected: score ${candidate.score} is below the minimum of ${config.minScore}`);
      else if (effective(candidate) < config.minScore) reasons.push(`not selected: its section (/${sectionOf(candidate)}) already has ${config.freePerSection} pages`);
      else reasons.push(`not selected: the cap of ${limit} pages was reached by higher-ranked pages`);
    }
    return { url: candidate.link.url, selected, score: candidate.score, reasons };
  });
}

/** The address a page names as its canonical one, resolved against the page's own address; null when it names none. */
export function canonicalOf(html: string, page: URL): string | null {
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    if (!/rel=["']canonical["']/i.test(tag)) continue;
    const href = tag.match(/\shref=["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    try {
      return new URL(decodeEntities(href), page).href;
    } catch {
      return null;
    }
  }
  return null;
}

const comparable = (url: string): string => {
  try {
    const parsed = new URL(url);
    return parsed.origin + normalizedPath(parsed.pathname);
  } catch {
    return url;
  }
};

const shingles = (text: string): Set<string> => {
  const words = text.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 2000).split(' ');
  const set = new Set<string>();
  for (let i = 0; i + 4 <= words.length; i++) set.add(words.slice(i, i + 4).join(' '));
  return set;
};

const MIN_DUPLICATE_CHARS = 200;
const DUPLICATE_OVERLAP = 0.9;

/**
 * The kept page this one repeats, or null: a page that names a kept page as its canonical address, or whose text overlaps a kept page's
 * almost completely. A canonical address that is not among the kept pages does not make it a duplicate: it may be the only copy we have.
 */
export function duplicateOf(candidate: { url: string; canonical: string | null; text: string }, kept: Array<{ url: string; text: string }>): string | null {
  if (candidate.canonical && comparable(candidate.canonical) !== comparable(candidate.url)) {
    const target = kept.find((k) => comparable(k.url) === comparable(candidate.canonical as string));
    if (target) return target.url;
  }
  if (candidate.text.length < MIN_DUPLICATE_CHARS) return null;
  const mine = shingles(candidate.text);
  if (mine.size === 0) return null;
  for (const page of kept) {
    if (page.text.length < MIN_DUPLICATE_CHARS) continue;
    const theirs = shingles(page.text);
    let shared = 0;
    for (const s of mine) if (theirs.has(s)) shared += 1;
    if (shared / Math.min(mine.size, theirs.size) >= DUPLICATE_OVERLAP) return page.url;
  }
  return null;
}
