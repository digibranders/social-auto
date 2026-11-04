/**
 * From a crawled site to saved evidence facts, and back. Each page's structure is read in headless Chrome (with the homepage's stylesheets
 * applied); a page Chrome cannot read falls back to flat text, where every fact is held for review. Conflicts between pages are applied,
 * and the result is written to `facts.json` next to the brand profile. Reading applies freshness, so an old commercial fact is held rather
 * than used as current. None of this may stop a profile run: failures are reported and the brand stays on legacy coverage.
 */
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from './art-pipeline.ts';
import { applyConflicts, applyFreshness, type TermConflict } from './commercial.ts';
import type { SiteSnapshot } from './crawl.ts';
import { buildEvidence, flatTextEvidence, type EvidenceFact, type EvidenceSet, type PageSnapshot } from './evidence.ts';
import { extractStructure, type PageStructure } from './evidence-extract.ts';

export const FACTS_FILE = 'facts.json';
export const FACTS_VERSION = 1;
export const DEFAULT_FACT_MAX_AGE_DAYS = 30;

export interface FactsFile {
  version: number;
  builtAt: string;
  site: string;
  facts: EvidenceFact[];
  conflicts: TermConflict[];
  snapshots: PageSnapshot[];
  coverage: { pages: number; structured: number; flatText: number; usable: number; needsReview: number; excluded: number; notes: string[] };
}

export interface BuildDeps {
  extract?: (html: string, url: string, styles: readonly string[]) => Promise<PageStructure>;
  now?: Date;
}

export async function buildSiteFacts(snapshot: SiteSnapshot, deps: BuildDeps = {}): Promise<FactsFile> {
  const now = deps.now ?? new Date();
  const extract = deps.extract ?? ((html, url, styles) => extractStructure(html, url, { styles }));
  const structures: PageStructure[] = [];
  const flat: EvidenceSet[] = [];
  const notes: string[] = [];
  const styles = snapshot.stylesheets ?? [];
  const textOf = new Map(snapshot.pages.map((p) => [p.url, p.text]));
  for (const source of snapshot.sources ?? []) {
    try {
      structures.push(await extract(source.html, source.url, styles));
    } catch (error) {
      notes.push(`${source.url}: structure could not be read (${error instanceof Error ? error.message : String(error)}); its facts are held for review`);
      flat.push(flatTextEvidence(source.url, textOf.get(source.url) ?? '', now));
    }
  }
  const structured = buildEvidence(structures, now);
  const all = { facts: [...structured.facts, ...flat.flatMap((s) => s.facts)], excluded: [...structured.excluded, ...flat.flatMap((s) => s.excluded)], snapshots: [...structured.snapshots, ...flat.flatMap((s) => s.snapshots)] };
  for (const s of structures) if (s.unstyled) notes.push(`${s.url}: its stylesheets were not available, so hidden content may have been read; its facts are held for review`);
  const { facts, conflicts } = applyConflicts(all.facts);
  return {
    version: FACTS_VERSION, builtAt: now.toISOString(), site: snapshot.origin, facts, conflicts, snapshots: all.snapshots,
    coverage: { pages: (snapshot.sources ?? []).length, structured: structures.length, flatText: flat.length, usable: facts.filter((f) => f.status === 'usable').length, needsReview: facts.filter((f) => f.status === 'needs_review').length, excluded: all.excluded.length, notes },
  };
}

export async function writeFacts(brandDir: string, file: FactsFile): Promise<string> {
  await mkdir(brandDir, { recursive: true });
  const path = join(brandDir, FACTS_FILE);
  await writeFileAtomic(path, `${JSON.stringify(file, null, 2)}\n`);
  return path;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function validFact(raw: unknown): raw is EvidenceFact {
  if (!isRecord(raw) || !isRecord(raw['source']) || !isRecord(raw['values'])) return false;
  return typeof raw['id'] === 'string' && typeof raw['text'] === 'string' && typeof raw['category'] === 'string' && (raw['status'] === 'usable' || raw['status'] === 'needs_review')
    && Array.isArray(raw['reasonCodes']) && Array.isArray(raw['qualifiers']) && typeof raw['capturedAt'] === 'string' && typeof raw['intent'] === 'string' && typeof raw['attribution'] === 'string'
    && typeof raw['source']['url'] === 'string' && typeof raw['source']['quote'] === 'string' && typeof raw['source']['contentHash'] === 'string';
}

/** The saved facts of a brand with freshness applied, or null when the brand has none (legacy coverage). A damaged file is an error, never silently legacy. */
export async function loadFacts(brandDir: string, options: { now?: Date; maxAgeDays?: number } = {}): Promise<{ facts: EvidenceFact[]; file: FactsFile } | null> {
  let text: string;
  try {
    text = await readFile(join(brandDir, FACTS_FILE), 'utf8');
  } catch {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`${join(brandDir, FACTS_FILE)} is not valid JSON; rebuild it or remove it`);
  }
  if (!isRecord(raw) || raw['version'] !== FACTS_VERSION || !Array.isArray(raw['facts']) || !raw['facts'].every(validFact)) {
    throw new Error(`${join(brandDir, FACTS_FILE)} has the wrong shape or version; rebuild it or remove it`);
  }
  const file = raw as unknown as FactsFile;
  return { facts: applyFreshness(file.facts, options.now ?? new Date(), options.maxAgeDays ?? DEFAULT_FACT_MAX_AGE_DAYS), file };
}
