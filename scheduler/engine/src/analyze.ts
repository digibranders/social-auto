/** Turns a website into brands/<slug>/brand.json plus a downloaded logo. */
import { mkdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { AiConfig } from './ai.ts';
import { parseBrand, type Brand } from './content.ts';
import { crawlSite, type SiteSnapshot } from './crawl.ts';
import { chatJson } from './llm.ts';

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

async function downloadLogo(candidates: string[], assetsDir: string): Promise<string> {
  for (const url of candidates) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      const type = response.headers.get('content-type') ?? '';
      if (!response.ok || !type.startsWith('image/')) continue;
      const fromType = type.includes('svg') ? '.svg' : type.includes('png') ? '.png' : type.includes('webp') ? '.webp' : '.jpg';
      const fromPath = extname(new URL(url).pathname).toLowerCase();
      const ext = LOGO_EXTENSIONS.has(fromPath) ? fromPath : fromType;
      const file = `logo${ext}`;
      await writeFile(join(assetsDir, file), Buffer.from(await response.arrayBuffer()));
      return `assets/${file}`;
    } catch {
      continue;
    }
  }
  throw new AnalyzeError('No downloadable logo found on the website');
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
  "proofPoints": ["5-8 short factual selling points taken from the site"],
  "callToAction": "short call to action pointing to the website, ending with (link in bio)",
  "rules": ["3-5 content rules, e.g. no invented statistics, prices exactly as on the site, plus industry-specific cautions (medical, legal, financial)"],
  "colors": {"background": "#RRGGBB light page colour", "ink": "#RRGGBB dark text colour", "accent": "#RRGGBB main brand accent", "tile": "#RRGGBB a dark brand shade"},
  "font": "a Google Font family name for headlines, preferably one of the candidates",
  "features": [
    {"icon": "monitor|gear|person|shield", "title": "2-3 words", "detail": "max 26 characters"}
  ]
}
"features" must have exactly 3 items: the three strongest offers (e.g. what is free, the price, a guarantee). Pick colours from the candidates; the accent must be the brand's signature colour, not black or white.

Website content:
${pages}`;
}

export async function analyzeSite(site: string, brandsRoot: string, ai: AiConfig): Promise<{ dir: string; brand: Brand }> {
  const snapshot = await crawlSite(site);
  const dir = join(brandsRoot, slugFromSite(snapshot.origin));
  const assetsDir = join(dir, 'assets');
  await mkdir(assetsDir, { recursive: true });
  const logo = await downloadLogo(snapshot.logoCandidates, assetsDir);

  const brand = await chatJson({
    ai,
    system: SYSTEM_PROMPT,
    user: userPrompt(snapshot),
    parse: (value) => {
      const raw = { ...(value as Record<string, unknown>), website: snapshot.origin, logo, mark: logo };
      const parsed = parseBrand(raw, 'brand profile');
      return { ...parsed, font: parsed.font.trim() || DEFAULT_FONT };
    },
  });

  await writeFile(join(dir, 'brand.json'), `${JSON.stringify(brand, null, 2)}\n`);
  return { dir, brand };
}
