/**
 * What a brand needs from its site beyond the profile, gathered on its own so a website link is all a run needs: the evidence facts (what the site states, in
 * its own words) and the site's icon (the brand's symbol alone). One crawl serves both. Facts older than a set age are read again so a changed price or term is
 * never published from a stale copy; the icon is taken once. A failure here never stops a run: the poster pipeline falls back (written from the profile's proof
 * points, or with the whole logo) and says so.
 */
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AiConfig } from './ai.ts';
import { writeFileAtomic } from './art-pipeline.ts';
import { parseBrand, readJson } from './content.ts';
import { crawlSite, type SiteSnapshot } from './crawl.ts';
import { buildSiteFacts, loadFacts, writeFacts, type FactsFile } from './evidence-pipeline.ts';
import { captureBrandIcon } from './logo-assets.ts';
import { safeFetchBytes } from './safe-fetch.ts';
import type { FetchedBytes } from './safe-fetch.ts';

/** Facts read longer ago than this are read again before a run. */
export const FACTS_MAX_AGE_DAYS = 14;
/** A site with no usable icon is looked at again after this long, not on every run. */
export const NO_ICON_RECHECK_DAYS = 30;
const NO_ICON_MARKER = join('assets', '.no-icon.json');
const exists = async (path: string): Promise<boolean> => access(path).then(() => true, () => false);

async function noIconRecently(brandDir: string, now: Date): Promise<boolean> {
  if (!(await exists(join(brandDir, NO_ICON_MARKER)))) return false;
  try {
    const at = Date.parse((JSON.parse(await readFile(join(brandDir, NO_ICON_MARKER), 'utf8')) as { checkedAt?: string }).checkedAt ?? '');
    return Number.isFinite(at) && (now.getTime() - at) / 86_400_000 < NO_ICON_RECHECK_DAYS;
  } catch {
    return false;
  }
}

export interface SiteAssetDeps {
  crawl?: (site: string) => Promise<SiteSnapshot>;
  buildFacts?: (snapshot: SiteSnapshot) => Promise<FactsFile>;
  fetchBytes?: (url: string) => Promise<FetchedBytes>;
  fetchFn?: typeof fetch;
  now?: () => Date;
}

export interface SiteAssetReport {
  crawled: boolean;
  factsBuilt: boolean;
  iconCaptured: boolean;
  notes: string[];
}

/** Builds the facts and the icon the brand lacks (or that have gone stale), from a single crawl. */
export async function ensureSiteAssets(input: { brandDir: string; site: string; ai: AiConfig; log?: (message: string) => void }, deps: SiteAssetDeps = {}): Promise<SiteAssetReport> {
  const log = input.log ?? (() => undefined);
  const now = deps.now?.() ?? new Date();
  const report: SiteAssetReport = { crawled: false, factsBuilt: false, iconCaptured: false, notes: [] };
  const raw = (await readJson(join(input.brandDir, 'brand.json'))) as Record<string, unknown>;
  const brand = parseBrand(raw, 'brand.json');

  const existing = await loadFacts(input.brandDir, { now }).catch(() => null);
  const ageDays = existing ? (now.getTime() - Date.parse(existing.file.builtAt)) / 86_400_000 : Number.POSITIVE_INFINITY;
  const needFacts = !existing || !Number.isFinite(ageDays) || ageDays > FACTS_MAX_AGE_DAYS;
  const needIcon = brand.logoIcon === undefined && !(await noIconRecently(input.brandDir, now));
  if (!needFacts && !needIcon) return report;

  let snapshot: SiteSnapshot;
  try {
    snapshot = await (deps.crawl ?? ((site: string) => crawlSite(site)))(input.site);
    report.crawled = true;
  } catch (error) {
    report.notes.push(`the site could not be read again (${error instanceof Error ? error.message : String(error)}); ${existing ? 'the facts already saved are used' : 'posts are written from the profile'}`);
    log(report.notes.at(-1) as string);
    return report;
  }

  if (needFacts) {
    try {
      const file = await (deps.buildFacts ?? ((s: SiteSnapshot) => buildSiteFacts(s)))(snapshot);
      await writeFacts(input.brandDir, file);
      report.factsBuilt = true;
      log(`Evidence facts ${existing ? 'refreshed' : 'built'}: ${file.coverage.usable} usable, ${file.coverage.needsReview} held for review.`);
    } catch (error) {
      report.notes.push(`the facts could not be built (${error instanceof Error ? error.message : String(error)})`);
      log(report.notes.at(-1) as string);
    }
  }

  if (needIcon) {
    try {
      const icon = await captureBrandIcon({
        brandDir: input.brandDir, brand, iconCandidates: snapshot.iconCandidates, ai: input.ai,
        fetchBytes: deps.fetchBytes ?? ((url: string) => safeFetchBytes(url, { maxBytes: 2_000_000, accept: 'image/*,*/*' })),
        ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}), now: () => now,
      });
      if (icon) {
        await writeFileAtomic(join(input.brandDir, 'brand.json'), `${JSON.stringify({ ...raw, logoIcon: icon }, null, 2)}\n`);
        report.iconCaptured = true;
        log(`Brand icon saved (${icon.matchesLogo ? 'matches the logo' : 'not confirmed as the logo\'s symbol, so the whole logo is used'}).`);
      } else {
        report.notes.push('the site declares no icon that downloads, so the whole logo is used');
        await writeFile(join(input.brandDir, NO_ICON_MARKER), `${JSON.stringify({ checkedAt: now.toISOString() })}\n`).catch(() => undefined);
      }
    } catch (error) {
      report.notes.push(`the icon could not be captured (${error instanceof Error ? error.message : String(error)})`);
      log(report.notes.at(-1) as string);
    }
  }
  return report;
}
