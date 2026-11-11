/**
 * Makes one carousel for a client, from start to the owner's review queue: plans it from the verified facts, writes a caption for each channel, draws the slides,
 * puts the finished carousel up for review, and writes the plan file the export reads. Nothing is scheduled or published here, and nothing is bought when the
 * client has fewer than three verified facts or no channel to write for. A carousel whose slides were not all accepted is not registered and writes nothing.
 */
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AiConfig } from './ai.ts';
import { displayDomain } from './ai-creative.ts';
import type { CreativeDeps, CreativeRunInput } from './ai-creative-pipeline.ts';
import { writeFileAtomic } from './art-pipeline.ts';
import { makeCarouselSlides } from './carousel-make.ts';
import { writeCarouselCaptions, type CarouselCaptions } from './carousel-copy.ts';
import { MIN_FACTS, planCarousel, type CarouselDraft, type CarouselFact } from './carousel.ts';
import type { Brand, WeekPlan } from './content.ts';
import { displayFact, type EvidenceFact } from './evidence.ts';
import type { Network } from './networks.ts';
import { registerCarousel } from './review-register.ts';

const HISTORY_FILE = 'carousels.json';
/** How many earlier topics a new carousel is told to stay away from. */
const AVOID_TOPICS = 8;
const WEEK_FILE = /^week-(\d+)\.json$/;

interface HistoryEntry { id: string; topic: string; createdAt: string; planFile: string }

export interface CarouselRunInput {
  ai: AiConfig;
  brand: Brand;
  brandSlug: string;
  brandDir: string;
  /** The brand's usable verified facts. */
  facts: readonly EvidenceFact[];
  /** The channels to write a caption for (and so the channels the carousel may go to). */
  networks: readonly Network[];
  /** The day and time it is meant for, ISO 8601 with the offset. */
  date: string;
  /** Where pictures and reports are written while the carousel is made. */
  outRoot: string;
  /** The brand's real logo, which goes on the last slide only. */
  logo?: CreativeRunInput['logo'];
  log?: (message: string) => void;
  deps?: {
    /** For tests: replaces the plan the model makes. */
    plan?: (request: { facts: readonly CarouselFact[]; avoidTopics: readonly string[] }) => Promise<CarouselDraft>;
    /** For tests: replaces the caption writer. */
    captions?: (draft: CarouselDraft, factTexts: readonly string[]) => Promise<CarouselCaptions>;
    /** For tests: the poster pipeline's own stand-ins. */
    slides?: CreativeDeps;
    now?: () => Date;
  };
}

export interface CarouselRunResult {
  status: 'queued' | 'not_ready' | 'skipped';
  carouselId: string;
  planFile?: string;
  topic?: string;
  reason?: string;
  /** Captions that were replaced by a plain one, so the owner can look at them. */
  fallback?: CarouselCaptions['fallback'];
}

function readHistory(brandDir: string): HistoryEntry[] {
  try {
    const raw = JSON.parse(readFileSync(join(brandDir, HISTORY_FILE), 'utf8')) as { carousels?: unknown };
    return Array.isArray(raw.carousels) ? (raw.carousels as HistoryEntry[]).filter((c) => typeof c?.id === 'string' && typeof c.topic === 'string') : [];
  } catch {
    return [];
  }
}

const offsetOf = (date: string): string => /(Z|[+-]\d{2}:\d{2})$/.exec(date)?.[1] ?? '+05:30';

export async function runCarousel(input: CarouselRunInput): Promise<CarouselRunResult> {
  const log = input.log ?? ((): void => undefined);
  const now = input.deps?.now ?? ((): Date => new Date());
  const history = readHistory(input.brandDir);
  const day = input.date.slice(0, 10).replace(/-/g, '');
  const sameDay = history.filter((c) => c.id.startsWith(`car-${day}`)).length;
  const carouselId = `car-${day}${sameDay > 0 ? `-${sameDay + 1}` : ''}`;
  const skip = (reason: string): CarouselRunResult => ({ status: 'skipped', carouselId, reason });

  const carouselFacts: CarouselFact[] = input.facts.map((f) => ({ id: f.id, text: displayFact(f) }));
  if (carouselFacts.length < MIN_FACTS) return skip(`a carousel needs at least three verified facts, ${input.brand.name} has ${carouselFacts.length}`);
  if (input.networks.length === 0) return skip('a carousel needs at least one channel to write for');

  log(`Planning a carousel from ${carouselFacts.length} verified facts…`);
  const avoidTopics = history.slice(-AVOID_TOPICS).map((c) => c.topic);
  const draft = await (input.deps?.plan ?? ((request) => planCarousel({ ai: input.ai, brandName: input.brand.name, ...request })))({ facts: carouselFacts, avoidTopics });
  log(`    Topic: ${draft.topic} (${draft.slides.length} slides)`);

  const factTexts = [...new Set(draft.slides.flatMap((s) => s.factIds))].map((id) => carouselFacts.find((f) => f.id === id)?.text ?? '').filter((t) => t !== '');
  log(`Writing a caption for each of ${input.networks.join(', ')}…`);
  const closingLine = input.brand.cta?.text ?? `Visit ${displayDomain(input.brand.website)} (link in bio)`;
  const captions = await (input.deps?.captions ?? ((d, texts) => writeCarouselCaptions({ ai: input.ai, topic: d.topic, headlines: d.slides.map((s) => s.headline), facts: texts, closingLine, networks: input.networks })))(draft, factTexts);

  const outDir = join(input.outRoot, input.brandSlug, carouselId);
  mkdirSync(outDir, { recursive: true });
  log('Drawing the slides…');
  const slides = await makeCarouselSlides({
    ai: input.ai, brand: input.brand, brandSlug: input.brandSlug, facts: carouselFacts, draft, idPrefix: carouselId, date: input.date, outDir,
    ...(input.logo ? { logo: input.logo } : {}), log: (m) => log(`    ${m}`), ...(input.deps?.slides ? { deps: input.deps.slides } : {}),
  });
  const reportFile = join(outDir, 'carousel-report.json');
  await writeFileAtomic(reportFile, `${JSON.stringify({ carouselId, topic: draft.topic, ready: slides.ready, reason: slides.reason, slides: slides.slides, fallbackCaptions: captions.fallback }, null, 2)}\n`);
  if (!slides.ready) return { status: 'not_ready', carouselId, topic: draft.topic, reason: slides.reason ?? 'a slide was not accepted' };

  const weekNumber = Math.max(0, ...readdirSync(input.brandDir).map((f) => Number(WEEK_FILE.exec(f)?.[1] ?? 0))) + 1;
  const planFile = `week-${String(weekNumber).padStart(2, '0')}.json`;
  registerCarousel({
    brandDir: input.brandDir, brandSlug: input.brandSlug, planFile, carouselId, draft, slides, facts: input.facts, captions: captions.captions,
    ctaUrl: input.brand.cta?.evidence?.url ?? input.brand.website, reportFile,
  });
  // The plan file is what the export reads: one post, the carousel, which can only go out as the exact slides and captions the owner approves in review.
  const main = captions.captions['instagram'] ?? Object.values(captions.captions)[0] ?? draft.topic;
  const plan: WeekPlan = {
    brand: input.brandSlug, timezone: offsetOf(input.date), renderMode: 'ai_v1',
    posts: [{ id: carouselId, date: input.date, painPoint: draft.topic, mode: 'ai', headline: draft.topic, subline: '', caption: main, hashtags: [], imagePrompt: draft.topic, pillar: 'carousel', factIds: [...new Set(draft.slides.flatMap((s) => s.factIds))] }],
  };
  await writeFileAtomic(join(input.brandDir, planFile), `${JSON.stringify(plan, null, 2)}\n`);
  await writeFileAtomic(join(input.brandDir, HISTORY_FILE), `${JSON.stringify({ carousels: [...history, { id: carouselId, topic: draft.topic, createdAt: now().toISOString(), planFile }] }, null, 2)}\n`);
  log(`The carousel is in the owner's review queue (${planFile}); nothing was scheduled or published.`);
  return { status: 'queued', carouselId, planFile, topic: draft.topic, ...(captions.fallback.length > 0 ? { fallback: captions.fallback } : {}) };
}
