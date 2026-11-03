/** Turns a website into brands/<slug>/brand.json plus a downloaded logo. */
import { unsourcedClaim, verifyClaims, type ClaimBatch, type ClaimInput, type VerifiedClaim } from './claims.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { AiConfig } from './ai.ts';
import { escapeHtml, parseBrand, type Brand, type BrandColors } from './content.ts';
import { crawlSite, type SiteSnapshot } from './crawl.ts';
import { chatJson } from './llm.ts';
import { safeFetchBytes, type FetchedBytes } from './safe-fetch.ts';

const LOGO_EXTENSIONS = new Set(['.svg', '.png', '.jpg', '.jpeg', '.webp']);
const DEFAULT_FONT = 'Inter';

export class AnalyzeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalyzeError';
  }
}

/** "https://www.brandbasket.in" -> "brandbasket" */
export function slugFromSite(site: string): string {
  const host = new URL(/^https?:\/\//i.test(site) ? site : `https://${site}`).hostname.replace(/^www\./, '');
  const label = host.split('.')[0] ?? host;
  return label.toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

/** The first of these addresses that downloads as a picture; null when none does. */
async function downloadImage(candidates: string[], fetchBytes: (url: string) => Promise<FetchedBytes>): Promise<{ url: string; bytes: Buffer; type: string } | null> {
  for (const url of candidates) {
    try {
      const { bytes, type } = await fetchBytes(url);
      if (type.startsWith('image/') && bytes.length > 0) return { url, bytes, type };
    } catch {
      continue;
    }
  }
  return null;
}

/** Saves the best logo that downloads; null when none does. */
async function downloadLogo(candidates: string[], assetsDir: string, fetchBytes: (url: string) => Promise<FetchedBytes>): Promise<string | null> {
  const image = await downloadImage(candidates, fetchBytes);
  if (!image) return null;
  const fromType = image.type.includes('svg') ? '.svg' : image.type.includes('png') ? '.png' : image.type.includes('webp') ? '.webp' : '.jpg';
  const fromPath = extname(new URL(image.url).pathname).toLowerCase();
  const ext = LOGO_EXTENSIONS.has(fromPath) ? fromPath : fromType;
  const file = `logo${ext}`;
  await writeFile(join(assetsDir, file), image.bytes);
  return `assets/${file}`;
}

const MAX_LOGO_NAME_CHARS = 24;

/** The site's icon with the brand's name beside it, as one self-contained logo, for sites with an icon but no logo picture. */
export function iconLogoSvg(name: string, icon: { bytes: Buffer; type: string }, colors: Pick<BrandColors, 'ink'>): string {
  const shown = name.trim().slice(0, MAX_LOGO_NAME_CHARS);
  const label = escapeHtml(shown);
  const width = 96 + Math.max(shown.length, 4) * 34;
  const mime = icon.type.split(';')[0]?.trim() || 'image/png';
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${width} 96" role="img" aria-label="${label}"><image x="0" y="8" width="80" height="80" preserveAspectRatio="xMidYMid meet" href="data:${mime};base64,${icon.bytes.toString('base64')}"/><text x="96" y="66" font-family="Inter, Arial, Helvetica, sans-serif" font-size="52" font-weight="800" fill="${colors.ink}">${label}</text></svg>
`;
}

/** A simple logo made of the brand's name, for sites whose own logo could not be downloaded. */
export function textLogoSvg(name: string, colors: Pick<BrandColors, 'ink' | 'accent'>): string {
  const shown = name.trim().slice(0, MAX_LOGO_NAME_CHARS);
  const initial = escapeHtml(shown.charAt(0).toUpperCase() || '?');
  const label = escapeHtml(shown);
  const width = 96 + Math.max(shown.length, 4) * 34;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} 96" role="img" aria-label="${label}"><rect width="80" height="80" y="8" rx="20" fill="${colors.accent}"/><text x="40" y="66" text-anchor="middle" font-family="Inter, Arial, Helvetica, sans-serif" font-size="54" font-weight="800" fill="#fff">${initial}</text><text x="96" y="66" font-family="Inter, Arial, Helvetica, sans-serif" font-size="52" font-weight="800" fill="${colors.ink}">${label}</text></svg>
`;
}

/** The proof points the model proposed: sourced ones with their quote, and plain text, which has no source and cannot be checked. */
function proofProposals(value: unknown): { inputs: ClaimInput[]; unsourced: string[] } {
  const inputs: ClaimInput[] = [];
  const unsourced: string[] = [];
  for (const item of Array.isArray(value) ? value : []) {
    if (typeof item === 'string' && item.trim()) unsourced.push(item.trim());
    else if (typeof item === 'object' && item !== null) {
      const { claim, sourceUrl, quote } = item as Record<string, unknown>;
      if (typeof claim !== 'string' || !claim.trim()) continue;
      if (typeof sourceUrl === 'string' && typeof quote === 'string' && sourceUrl.trim() && quote.trim()) inputs.push({ text: claim.trim(), sourceUrl: sourceUrl.trim(), quote });
      else unsourced.push(claim.trim());
    }
  }
  return { inputs, unsourced };
}

const SYSTEM_PROMPT = `You are a brand strategist. From website content you build a factual brand profile used to write social media posts.
Rules:
- Use only facts stated on the website. Never invent prices, numbers, awards, clients or guarantees.
- Copy prices and offers exactly as written on the site.
- Write in plain English. Return a single JSON object and nothing else.`;

function userPrompt(site: SiteSnapshot): string {
  const pages = site.pages
    .map((p) => `### ${p.url}\nTitle: ${p.title}\nDescription: ${p.description}\n${p.text}`)
    .join('\n\n');
  return `Website: ${site.origin}

Colour candidates found in the logo and CSS (most frequent first): ${site.colors.join(', ') || 'none'}
Font candidates: ${site.fonts.join(', ') || 'none'}

Return JSON with exactly these keys:
{
  "name": "brand name as written on the site",
  "handleUrl": "the domain without https or www, e.g. example.com",
  "offer": "2-3 sentences: what they sell, to whom, key prices/terms exactly as stated",
  "audience": "who the customers are",
  "tone": "how the brand speaks, 1-2 sentences",
  "proofPoints": [{"claim": "one short factual selling point", "sourceUrl": "the exact page address above that it comes from", "quote": "the exact words, copied unchanged, from that page that support it"}],  // 5-8 of them; only points a quote on the site supports, fewer is fine, never invent one
  "callToAction": "short call to action pointing to the website, ending with (link in bio)",
  "rules": ["3-5 content rules, e.g. no invented statistics, prices exactly as on the site, plus industry-specific cautions (medical, legal, financial)"],
  "colors": {"background": "#RRGGBB light page colour", "ink": "#RRGGBB dark text colour", "accent": "#RRGGBB main brand accent", "tile": "#RRGGBB a dark brand shade"},
  "font": "a Google Font family name for headlines, preferably one of the candidates",
  "visualStyle": "one sentence for the people who make the pictures: the colour palette in plain words (for example deep teal, off-white, a touch of gold), the photographic mood and the kind of setting typical for this business, and what to avoid",
  "features": [
    {"icon": "monitor|gear|person|shield", "title": "2-3 words", "detail": "max 26 characters"}
  ]
}
"features" must have exactly 3 items: the three strongest offers (e.g. what is free, the price, a guarantee). Pick colours from the candidates; the accent must be the brand's signature colour, not black or white.

Website content:
${pages}`;
}

/** What the brand reader uses to reach the outside; tests replace it. */
export interface AnalyzeDeps {
  crawl?: (site: string) => Promise<SiteSnapshot>;
  fetchBytes?: (url: string) => Promise<FetchedBytes>;
  chatFetch?: typeof fetch;
}

export async function analyzeSite(site: string, brandsRoot: string, ai: AiConfig, deps: AnalyzeDeps = {}): Promise<{ dir: string; brand: Brand }> {
  const snapshot = await (deps.crawl ?? crawlSite)(site);
  const dir = join(brandsRoot, slugFromSite(snapshot.origin));
  const assetsDir = join(dir, 'assets');
  await mkdir(assetsDir, { recursive: true });
  const fetchBytes = deps.fetchBytes ?? ((url: string) => safeFetchBytes(url, { maxBytes: 5_000_000, accept: 'image/*,*/*' }));
  const logo = await downloadLogo(snapshot.logoCandidates, assetsDir, fetchBytes);
  const logoPath = logo ?? 'assets/logo.svg';

  const pageSources = snapshot.pages.map((p) => ({ url: p.url, text: p.text, ...(p.fetchedAt ? { fetchedAt: p.fetchedAt } : {}) }));
  const { brand, claims } = await chatJson({
    ai,
    ...(deps.chatFetch ? { fetchFn: deps.chatFetch } : {}),
    system: SYSTEM_PROMPT,
    user: userPrompt(snapshot),
    parse: (value) => {
      const answer = value as Record<string, unknown>;
      // Proof points are claims with a source: only those the site really makes, with the quote on a page that was read, are kept.
      const proposed = proofProposals(answer['proofPoints']);
      const checked = verifyClaims(proposed.inputs, pageSources, { now: new Date() });
      const unsourced = proposed.unsourced.map((text) => unsourcedClaim(text));
      const raw = { ...answer, proofPoints: checked.verified.map((c) => c.text), website: snapshot.origin, logo: logoPath, mark: logoPath };
      const parsed = parseBrand(raw, 'brand profile');
      const claims: ClaimBatch = { ...checked, rejected: [...checked.rejected, ...unsourced], all: [...checked.all, ...unsourced] };
      return { brand: { ...parsed, font: parsed.font.trim() || DEFAULT_FONT }, claims };
    },
  });

  if (!logo) {
    // No logo picture: the site's own icon with the name beside it, and only without an icon the name alone, so the run goes on.
    const icon = await downloadImage(snapshot.iconCandidates, fetchBytes);
    if (icon) {
      const iconType = icon.type.includes('svg') ? '.svg' : icon.type.includes('png') ? '.png' : icon.type.includes('webp') ? '.webp' : icon.type.includes('icon') ? '.ico' : '.jpg';
      await writeFile(join(assetsDir, `icon${iconType}`), icon.bytes);
      await writeFile(join(assetsDir, 'logo.svg'), iconLogoSvg(brand.name, icon, brand.colors));
    } else {
      await writeFile(join(assetsDir, 'logo.svg'), textLogoSvg(brand.name, brand.colors));
    }
  }
  await writeFile(join(dir, 'brand.json'), `${JSON.stringify(brand, null, 2)}\n`);
  // Every proof point the model proposed, with its source and the outcome of each check, so nothing in the profile is unexplained.
  const evidence = { checkedAt: new Date().toISOString(), verified: claims.verified, uncertain: claims.uncertain, rejected: claims.rejected };
  await writeFile(join(dir, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  // Which pages the profile was built from and which were left out, with scores and reasons, so a wrong choice can be seen.
  const pages = { read: snapshot.pageDecisions.filter((d) => d.selected), skipped: snapshot.pageDecisions.filter((d) => !d.selected) };
  await writeFile(join(dir, 'pages.json'), `${JSON.stringify(pages, null, 2)}\n`);
  return { dir, brand };
}
