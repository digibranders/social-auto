/**
 * Which of a site's pages describe the business. Every internal link on the homepage gets a score and a recorded reason, so a
 * page that was read, and one that was not, can always be explained. Two layers: `extractLinkInfo` reads a page into plain data
 * (links with where they sit, language, alternates, canonical, the site's own vocabulary) and `rankLinks` decides from that data
 * alone, so each can be tested on its own.
 *
 * Nothing here is built for an industry. Regional copies of a page are consolidated to one, not dropped wholesale; a page that
 * exists only in the site's own language and region stays eligible. The budget is split between covering the kinds of page a site
 * has and going deeper into what it offers, with diminishing returns instead of exemptions.
 */

export interface PageDecision {
  url: string;
  selected: boolean;
  score: number;
  /** Why it scored as it did and why it was or was not chosen, e.g. `+5 "pricing" page`, `-20 legal, account or utility page`. */
  reasons: string[];
}

/**
 * The ranking rules as settings. Nothing here belongs to an industry: the words are generic page types every kind of
 * organisation has, and a client's own vocabulary comes from its homepage (see `siteVocabulary`) or from a configured override.
 */
export interface RankingConfig {
  /** Path words that name a generic kind of page, by how strongly they mark a page worth reading. Merged with any override. */
  weights: Readonly<Record<string, number>>;
  /** Path words that always mark a legal, account or housekeeping page, wherever they sit in the address. Replaced by an override. */
  utility: readonly string[];
  /** Words that can also be part of what an organisation offers ("LinkedIn account management"): a housekeeping page only when one is the whole first part of the address ("/my-account"). */
  utilityWhenShort: readonly string[];
  /** A page must score at least this to be read. Pages below it are never filler for an unused budget. */
  minScore: number;
  /** After this many pages from one section, further ones lose points. */
  freePerSection: number;
  /** Points lost per page beyond that, for ordinary pages (case studies, articles, listings). */
  sectionPenalty: number;
  /** The same, for offering pages (see `essentialWeight`): diminishing returns, never an exemption. */
  essentialSectionPenalty: number;
  /** A page whose page-type weight is at least this describes what the organisation offers. */
  essentialWeight: number;
  /** A kind of page (by its page-type word) with at least this weight gets a place before any one kind gets several. */
  coverageMinWeight: number;
  /** The most of the budget the first, coverage round may use; the rest goes deeper into the best pages. */
  coverageShare: number;
  /** When one section holds at least this share of the candidates, the section is taken one level deeper ("/en/…", "/products/…")... */
  dominantSectionShare: number;
  /** ...unless it holds more pages than this: that is a catalogue or archive of look-alikes, which stays one crowded section. */
  catalogueSize: number;
  /** A site with at least this many two-letter first path parts has a region switcher; with fewer they are ordinary pages ("/ai"). */
  switcherRoots: number;
  navigationBonus: number;
  footerPenalty: number;
  /** Link text that names a kind of page. */
  linkTextBonus: number;
  /** A word from the site's own homepage wording appears in the link's address or text (only for words that are not a known page type). */
  evidenceBonus: number;
}

export const defaultRankingConfig: RankingConfig = {
  weights: {
    pricing: 5, price: 5, prices: 5, plans: 5, product: 5, products: 5, service: 5, services: 5, solution: 5, solutions: 5, features: 5, platform: 5,
    about: 4, company: 4, story: 4, mission: 4, faq: 4,
    case: 3, studies: 3, how: 3, works: 3, process: 3, approach: 3, industries: 3, industry: 3,
    why: 2, work: 2, portfolio: 2, customers: 2, testimonials: 2, reviews: 2,
    team: 1, contact: 1,
  },
  utility: [
    'privacy', 'terms', 'tos', 'legal', 'cookie', 'cookies', 'login', 'logout', 'signin', 'signup', 'cart', 'checkout',
    'careers', 'sitemap', 'unsubscribe', 'imprint', 'impressum', 'disclaimer', 'policy', 'policies',
  ],
  utilityWhenShort: ['account', 'portal', 'dashboard', 'admin', 'register', 'password', 'jobs'],
  minScore: 2,
  freePerSection: 2,
  sectionPenalty: 2,
  essentialSectionPenalty: 1,
  essentialWeight: 5,
  coverageMinWeight: 2,
  coverageShare: 0.6,
  dominantSectionShare: 0.7,
  catalogueSize: 12,
  switcherRoots: 3,
  navigationBonus: 3,
  footerPenalty: 1,
  linkTextBonus: 2,
  evidenceBonus: 2,
};

/** Archive pages of a blog or catalogue. */
const ARCHIVE = /(^|\/)(tag|tags|category|categories|author|archive|page)(\/|$)/i;
const FILE = /\.(pdf|jpe?g|png|gif|svg|webp|xml|zip|docx?|xlsx?|mp4|mp3|ico|css|js)$/i;
const INDEX_FILE = /\/index\.(?:html?|php|aspx?)$/i;
const LOCALE_ROOT = /^[a-z]{2}(?:-[a-z]{2,4})?$/i;

const tokensOf = (path: string): string[] => path.toLowerCase().split(/[\/\-_.]+/).filter(Boolean);
/** The words of a link's text, in any language. */
const wordsOfText = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

function decodeEntities(text: string): string {
  return text.replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#39;', "'");
}

/** The address with its query and fragment gone, an index file or trailing slash removed, and the homepage as "/". */
function normalizedAddress(url: URL): string {
  const path = url.pathname.replace(INDEX_FILE, '').replace(/\/+$/, '');
  return `${url.origin}${path === '' ? '/' : path}`;
}

export type LinkRegion = 'nav' | 'body' | 'footer';

export interface LinkInfo {
  url: string;
  text: string;
  /** Where the link sits: the navigation or header, the footer, or neither. */
  region: LinkRegion;
}

/** Everything ranking needs from a homepage, as plain data. */
export interface PageInfo {
  links: LinkInfo[];
  /** The page's declared alternates (`hreflang`), e.g. `{ lang: 'fr', url: 'https://acme.com/fr' }`. */
  alternates: Array<{ lang: string; url: string }>;
  /** The page's `<html lang>` as written, e.g. "en-GB". */
  htmlLang: string | null;
  canonical: string | null;
  /** The words the site uses about itself; see `siteVocabulary`. */
  vocabulary?: ReadonlySet<string>;
}

function regions(html: string, tags: string[]): Array<[number, number]> {
  const found: Array<[number, number]> = [];
  for (const tag of tags) for (const match of html.matchAll(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, 'gi'))) found.push([match.index, match.index + match[0].length]);
  return found;
}

const REGION_ORDER: Readonly<Record<LinkRegion, number>> = { nav: 0, body: 1, footer: 2 };
const better = (a: LinkRegion, b: LinkRegion): LinkRegion => (REGION_ORDER[a] <= REGION_ORDER[b] ? a : b);

/** Reads a homepage into links (with where each sits), language, alternates, canonical address and the site's own vocabulary. */
export function extractLinkInfo(html: string, base: URL): PageInfo {
  const navigation = regions(html, ['nav', 'header']);
  const footer = regions(html, ['footer']);
  const within = (places: Array<[number, number]>, at: number): boolean => places.some(([from, to]) => at >= from && at < to);
  const links = new Map<string, LinkInfo>();
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = (match[1] ?? '').match(/\shref=["']([^"']*)["']/i)?.[1];
    if (!href || /^(#|mailto:|tel:|javascript:)/i.test(href.trim())) continue;
    let url: URL;
    try {
      url = new URL(decodeEntities(href.trim()), base);
    } catch {
      continue;
    }
    if (url.hostname !== base.hostname || !/^https?:$/.test(url.protocol) || FILE.test(url.pathname)) continue;
    const key = normalizedAddress(url);
    const text = (match[2] ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const region: LinkRegion = within(navigation, match.index) ? 'nav' : within(footer, match.index) ? 'footer' : 'body';
    const existing = links.get(key);
    if (existing) {
      existing.region = better(existing.region, region);
      if (!existing.text && text) existing.text = text;
    } else {
      links.set(key, { url: key, text, region });
    }
  }

  const alternates: Array<{ lang: string; url: string }> = [];
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    const lang = tag.match(/\shreflang=["']([^"']+)["']/i)?.[1];
    const href = tag.match(/\shref=["']([^"']+)["']/i)?.[1];
    if (!lang || !href || !/rel=["']alternate["']/i.test(tag)) continue;
    try {
      alternates.push({ lang, url: normalizedAddress(new URL(decodeEntities(href), base)) });
    } catch {
      continue;
    }
  }
  return {
    links: [...links.values()],
    alternates,
    htmlLang: html.match(/<html\b[^>]*\slang=["']([^"']+)["']/i)?.[1] ?? null,
    canonical: canonicalOf(html, base),
    vocabulary: siteVocabulary(html),
  };
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

/** A page type's weight whether the word is singular or plural ("faqs" is "faq", "case-study" is "case-studies"). */
function weightOf(word: string, config: RankingConfig): number {
  const direct = config.weights[word];
  if (direct !== undefined) return direct;
  const singular = word.endsWith('s') ? config.weights[word.slice(0, -1)] : undefined;
  const plural = config.weights[`${word}s`];
  const study = word.endsWith('y') ? config.weights[`${word.slice(0, -1)}ies`] : undefined;
  return singular ?? plural ?? study ?? 0;
}

interface Candidate {
  url: string;
  text: string;
  region: LinkRegion;
  order: number;
  path: string;
  /** The path without any region prefix. */
  rest: string;
  root: string | null;
  score: number;
  reasons: string[];
  rejected: boolean;
  /** The page-type word that names what this page is, and its weight; null when the address names none. */
  kind: string | null;
  kindWeight: number;
  /** Set on the regional version that stands for its page; said in the reasons only if the page is then chosen. */
  keptRegional?: string;
  covers?: string;
}

/** Scores a path for what it looks like, from its own words, its place on the page, its link text and the site's own vocabulary. */
function score(candidate: Pick<Candidate, 'region' | 'text'>, rest: string, config: RankingConfig, utility: ReadonlySet<string>, utilityWhenShort: ReadonlySet<string>, vocabulary: ReadonlySet<string>): { score: number; reasons: string[]; kind: string | null; kindWeight: number } {
  const reasons: string[] = [];
  let total = 0;
  const tokens = tokensOf(rest);
  const sectionTokens = tokensOf(rest.split('/').filter(Boolean)[0] ?? '');
  const flagged = tokens.find((t) => utility.has(t)) ?? (sectionTokens.length <= 2 ? sectionTokens.find((t) => utilityWhenShort.has(t)) : undefined);
  if (flagged || ARCHIVE.test(rest)) {
    return { score: -20, reasons: [`-20 legal, account or utility page (${flagged ?? 'archive'})`], kind: null, kindWeight: 0 };
  }
  const best = tokens.map((t) => [t, weightOf(t, config)] as const).sort((a, b) => b[1] - a[1])[0];
  if (best && best[1] > 0) {
    total += best[1];
    reasons.push(`+${best[1]} "${best[0]}" page`);
  }
  if (candidate.region === 'nav') {
    total += config.navigationBonus;
    reasons.push(`+${config.navigationBonus} in the navigation`);
  } else if (candidate.region === 'footer') {
    total -= config.footerPenalty;
    reasons.push(`-${config.footerPenalty} only in the footer`);
  }
  const linkTokens = wordsOfText(candidate.text);
  if (linkTokens.some((t) => weightOf(t, config) >= 3)) {
    total += config.linkTextBonus;
    reasons.push(`+${config.linkTextBonus} link text "${candidate.text}"`);
  }
  // The site's own words lift only a page the page-type list does not know at all (a restaurant's "menu"). A known page type already has its
  // weight, and must not be lifted past a more informative one by a call to action ("Start project") or a word that happens to be on the homepage.
  const shared = best && best[1] > 0 ? undefined : [...tokens, ...linkTokens].find((t) => [...t].length >= 4 && vocabulary.has(t));
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
  return { score: total, reasons, kind: best && best[1] > 0 ? best[0] : null, kindWeight: best?.[1] ?? 0 };
}

export interface RankOptions {
  /** False for an address the site's robots.txt asks readers to skip. */
  allowed?: (pathname: string) => boolean;
  /** Settings that replace the defaults: a client's own vocabulary and thresholds. `weights` are added to the defaults. */
  config?: Partial<RankingConfig>;
}

const bySize = (a: { score: number; order: number }, b: { score: number; order: number }): number => b.score - a.score || a.order - b.order;

/**
 * Decides every internal link: its score, whether it is chosen (at most `limit` pages) and why. The budget is shared out in two
 * rounds: first the best page of each kind of page the site has (an offering, About, FAQ, proof...), up to `coverageShare` of the
 * budget, then the rest by score, where each extra page from one section costs a little more (less for offering pages), so a long
 * list of near-identical pages cannot fill it. A kind the site lacks simply leaves its place free. Links to other sites, files,
 * mail and the homepage itself are not candidates and have no decision. The result is best first.
 */
export function rankLinks(info: PageInfo, base: URL, limit: number, options: RankOptions = {}): PageDecision[] {
  const config: RankingConfig = { ...defaultRankingConfig, ...options.config, weights: { ...defaultRankingConfig.weights, ...options.config?.weights } };
  const utility = new Set(config.utility);
  const utilityWhenShort = new Set(config.utilityWhenShort);
  const vocabulary = info.vocabulary ?? new Set<string>();
  const allowed = options.allowed ?? (() => true);

  // The same page reached through url variants counts once, in the best place it appears.
  const merged = new Map<string, LinkInfo>();
  for (const link of info.links) {
    let url: URL;
    try {
      url = new URL(link.url, base);
    } catch {
      continue;
    }
    if (url.hostname !== base.hostname || !/^https?:$/.test(url.protocol) || FILE.test(url.pathname)) continue;
    const key = normalizedAddress(url);
    if (new URL(key).pathname === '/') continue;
    const existing = merged.get(key);
    if (existing) {
      existing.region = better(existing.region, link.region);
      if (!existing.text && link.text) existing.text = link.text;
    } else {
      merged.set(key, { url: key, text: link.text, region: link.region });
    }
  }
  const links = [...merged.values()];

  // A region switcher: three or more two-letter first path parts, or any the homepage declares as alternates.
  const pathOf = (url: string): string => new URL(url).pathname.replace(/\/+$/, '');
  const firstParts = links.map((l) => pathOf(l.url).split('/')[1]?.toLowerCase() ?? '').filter((p) => LOCALE_ROOT.test(p));
  const declared = new Map<string, string>();
  for (const alternate of info.alternates) {
    const root = pathOf(alternate.url).split('/')[1]?.toLowerCase();
    if (root && LOCALE_ROOT.test(root)) declared.set(root, alternate.lang.toLowerCase());
  }
  const switcher = new Set<string>(new Set(firstParts).size >= config.switcherRoots ? firstParts : []);
  for (const root of declared.keys()) switcher.add(root);
  const [siteLanguage = 'en', siteRegion = null] = (info.htmlLang ?? 'en').toLowerCase().split(/[-_]/);
  // 2: the site's own region, 1: its language, 0: another language or region. A declared alternate says which language a path really is.
  const matchesSite = (root: string): number => {
    const alt = declared.get(root);
    if (alt && alt !== 'x-default') {
      const [language = '', region = null] = alt.split(/[-_]/);
      return language === siteLanguage ? (region !== null && region === siteRegion ? 2 : 1) : 0;
    }
    return root === siteRegion ? 2 : root.slice(0, 2) === siteLanguage ? 1 : 0;
  };

  const candidates: Candidate[] = links.map((link, order) => {
    const path = pathOf(link.url);
    const first = path.split('/')[1]?.toLowerCase() ?? '';
    const root = switcher.has(first) ? first : null;
    const rest = root ? path.slice(root.length + 1).replace(/\/+$/, '') : path;
    const scored = score(link, rest || '/', config, utility, utilityWhenShort, vocabulary);
    return { url: link.url, text: link.text, region: link.region, order, path, rest, root, score: scored.score, reasons: scored.reasons, rejected: false, kind: scored.kind, kindWeight: scored.kindWeight };
  });

  const reject = (candidate: Candidate, reason: string): void => {
    candidate.rejected = true;
    candidate.reasons.push(reason);
  };

  for (const candidate of candidates) {
    if (!allowed(candidate.path)) reject(candidate, 'blocked by robots.txt');
  }

  // Regional copies: consolidate each page to one version, preferring the plain address, then the site's own region.
  const byRest = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    if (candidate.root === null || candidate.rejected) continue;
    if (candidate.rest === '') {
      reject(candidate, `regional copy of the homepage (/${candidate.root}): a duplicate of the homepage`);
      continue;
    }
    byRest.set(candidate.rest, [...(byRest.get(candidate.rest) ?? []), candidate]);
  }
  for (const [rest, group] of byRest) {
    const plain = candidates.find((c) => c.root === null && c.rest === rest && !c.rejected);
    const fit = group.filter((c) => matchesSite(c.root as string) > 0).sort((a, b) => matchesSite(b.root as string) - matchesSite(a.root as string) || a.order - b.order);
    const winner = plain ? null : fit[0];
    for (const candidate of group) {
      if (plain) reject(candidate, `regional copy (/${candidate.root}) of the same page: a duplicate of ${plain.rest}`);
      else if (candidate === winner) candidate.keptRegional = `regional page kept: the version in the site's own language and region (/${candidate.root})`;
      else if (winner) reject(candidate, `regional copy (/${candidate.root}) of the same page: a duplicate of /${winner.root}${rest}`);
      else reject(candidate, `regional page for another language or region (/${candidate.root})`);
    }
  }

  // Sections: normally the first part of the address; when one part holds most pages ("/en/…", "/products/…"), the next one.
  const live = candidates.filter((c) => !c.rejected && c.score >= config.minScore);
  const firstOf = (c: Candidate): string => c.rest.split('/').filter(Boolean)[0] ?? '';
  const counts = new Map<string, number>();
  for (const c of live) counts.set(firstOf(c), (counts.get(firstOf(c)) ?? 0) + 1);
  const dominant = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  const deeper = live.length >= 4 && dominant !== undefined && dominant[1] / live.length >= config.dominantSectionShare && dominant[1] <= config.catalogueSize;
  const sectionOf = (c: Candidate): string => {
    const parts = c.rest.split('/').filter(Boolean);
    return deeper && parts[0] === dominant?.[0] ? (parts[1] ?? parts[0] ?? '') : (parts[0] ?? '');
  };

  const chosen: Candidate[] = [];
  const sizes = new Map<string, number>();
  for (const c of live) sizes.set(sectionOf(c), (sizes.get(sectionOf(c)) ?? 0) + 1);
  const isOffering = (c: Candidate): boolean => c.kindWeight >= config.essentialWeight;
  /** A section with more pages than this is a catalogue or archive of look-alikes, not a modest list of distinct things. */
  const crowded = (c: Candidate): boolean => (sizes.get(sectionOf(c)) ?? 0) > config.catalogueSize;
  /** The pages that describe what is offered, in a section of modest size: ahead of every other kind, never kept out by the section cap. */
  const protectedOffering = (c: Candidate): boolean => isOffering(c) && !crowded(c);
  const penaltyUnit = (c: Candidate): number => (isOffering(c) ? config.essentialSectionPenalty : config.sectionPenalty);
  const effective = (c: Candidate): number => c.score - penaltyUnit(c) * Math.max(0, chosen.filter((p) => sectionOf(p) === sectionOf(c)).length - (config.freePerSection - 1));
  const eligible = (c: Candidate): boolean => protectedOffering(c) || effective(c) >= config.minScore;

  // Round 1: the best page of each kind the site has, best first, up to a share of the budget. A missing kind frees its place.
  const kinds = new Map<string, Candidate>();
  for (const c of [...live].sort(bySize)) {
    if (c.kind !== null && c.kindWeight >= config.coverageMinWeight && !kinds.has(c.kind)) kinds.set(c.kind, c);
  }
  const coverage = Math.min(limit, Math.max(1, Math.floor(limit * config.coverageShare)));
  for (const c of [...kinds.values()].sort(bySize).slice(0, coverage)) {
    c.covers = `covers the "${c.kind}" kind of page`;
    chosen.push(c);
  }
  // Round 2: the rest of the budget. Offering pages first; each extra page from one section costs a little, so the order shifts, and a
  // long list of look-alikes (a catalogue) is cut off, but a modest list of distinct offerings is never kept out by the cap.
  while (chosen.length < limit) {
    const next = live
      .filter((c) => !chosen.includes(c) && eligible(c))
      .sort((a, b) => Number(protectedOffering(b)) - Number(protectedOffering(a)) || effective(b) - effective(a) || a.order - b.order)[0];
    if (!next) break;
    chosen.push(next);
  }

  const decisions = candidates.map((candidate): PageDecision => {
    const selected = chosen.includes(candidate);
    const reasons = [...candidate.reasons];
    if (selected && candidate.keptRegional) reasons.push(candidate.keptRegional);
    if (selected && candidate.covers) reasons.push(candidate.covers);
    if (!selected && !candidate.rejected) {
      if (candidate.score < config.minScore) reasons.push(`not selected: score ${candidate.score} is below the minimum of ${config.minScore}`);
      else if (!eligible(candidate)) reasons.push(`not selected: its section (/${sectionOf(candidate)}) already has ${config.freePerSection} pages and more would add little`);
      else reasons.push(`not selected: the cap of ${limit} pages was reached by higher-ranked pages`);
    }
    return { url: candidate.url, selected, score: candidate.score, reasons };
  });
  const order = new Map(candidates.map((c, i) => [c.url, i]));
  return decisions.sort((a, b) => Number(b.selected) - Number(a.selected) || b.score - a.score || (order.get(a.url) ?? 0) - (order.get(b.url) ?? 0));
}

/** Ranks a homepage's links straight from its HTML: `extractLinkInfo` then `rankLinks`. */
export function rankPages(html: string, base: URL, limit: number, options: RankOptions = {}): PageDecision[] {
  return rankLinks(extractLinkInfo(html, base), base, limit, options);
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
    return parsed.origin + parsed.pathname.replace(/\/+$/, '');
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
