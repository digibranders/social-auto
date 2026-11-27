/**
 * Makes one carousel for a client, from start to the owner's review queue: plans it from the verified facts, writes a caption for each channel, draws the slides,
 * puts the finished carousel up for review, and writes the plan file the export reads. Nothing is scheduled or published here, and nothing is bought when the
 * client has fewer than three verified facts or no channel to write for. A carousel whose slides were not all accepted is not registered and writes nothing.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { withFileLock } from './file-lock.ts';
import { join } from 'node:path';
import type { AiConfig } from './ai.ts';
import { displayDomain } from './ai-creative.ts';
import type { CreativeDeps, CreativeRunInput } from './ai-creative-pipeline.ts';
import { writeFileAtomic } from './art-pipeline.ts';
import { brandCharacter } from './ai-creative-pipeline.ts';
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

/**
 * Where a carousel is: `topic` (its topic, slide headlines and channel words are written, nothing is drawn, the customer has not decided), `kept` (she chose it, still to be drawn), `dropped`
 * (she did not want it: it costs nothing and does not use the week's allowance), `drawn` (the slides exist and are in review). An entry without a stage was made in one go (older ones).
 */
export type CarouselStage = 'topic' | 'kept' | 'dropped' | 'drawn';

/** What the topic stage writes down so the drawing can be done later, from exactly these words. */
export interface StoredPlan { draft: CarouselDraft; captions: Record<string, string>; fallback: CarouselCaptions['fallback']; networks: Network[] }

export interface HistoryEntry {
  id: string;
  topic: string;
  createdAt: string;
  /** The plan file the export reads; made when the slides are drawn, so a carousel not drawn yet has none. */
  planFile?: string;
  /** The day it is for, ISO 8601 with the offset (older entries have none). */
  date?: string;
  stage?: CarouselStage;
  /** The words and slide plan, kept until the slides are drawn. */
  plan?: StoredPlan;
}

/** Changes the carousels' history under a lock, so a decision, a move and a drawing finishing never write over each other. */
export function changeHistory(brandDir: string, change: (entries: HistoryEntry[]) => HistoryEntry[]): void {
  mkdirSync(brandDir, { recursive: true });
  withFileLock(join(brandDir, `${HISTORY_FILE}.lock`), () => {
    const next = change(readHistory(brandDir));
    const temp = join(brandDir, `${HISTORY_FILE}.${process.pid}.tmp`);
    writeFileSync(temp, `${JSON.stringify({ carousels: next }, null, 2)}\n`);
    renameSync(temp, join(brandDir, HISTORY_FILE));
  }, { timeoutMs: 5000 });
}

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
  /** `topic`: only the topic and words were written (nothing drawn); `queued`: the slides are drawn and in review. */
  status: 'topic' | 'queued' | 'not_ready' | 'skipped';
  carouselId: string;
  planFile?: string;
  topic?: string;
  reason?: string;
  /** Captions that were replaced by a plain one, so the owner can look at them. */
  fallback?: CarouselCaptions['fallback'];
}

export function readHistory(brandDir: string): HistoryEntry[] {
  try {
    const raw = JSON.parse(readFileSync(join(brandDir, HISTORY_FILE), 'utf8')) as { carousels?: unknown };
    return Array.isArray(raw.carousels) ? (raw.carousels as HistoryEntry[]).filter((c) => typeof c?.id === 'string' && typeof c.topic === 'string') : [];
  } catch {
    return [];
  }
}

const offsetOf = (date: string): string => /(Z|[+-]\d{2}:\d{2})$/.exec(date)?.[1] ?? '+05:30';

/** The first stage: the topic, the words of every slide and the caption for each channel, with no picture drawn (about a cent). Saved so the drawing can follow. */
export async function planCarouselTopic(input: CarouselRunInput): Promise<CarouselRunResult> {
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

  log(`1/4 Planning a carousel from ${carouselFacts.length} verified facts…`);
  // A topic she dropped is a topic she did not want: it is not avoided less, so the next one is not the same idea.
  const avoidTopics = history.slice(-AVOID_TOPICS).map((c) => c.topic);
  const draft = await (input.deps?.plan ?? ((request) => planCarousel({ ai: input.ai, brandName: input.brand.name, about: brandCharacter(input.brand), ...request })))({ facts: carouselFacts, avoidTopics });
  log(`    Topic: ${draft.topic} (${draft.slides.length} slides)`);

  const factTexts = [...new Set(draft.slides.flatMap((s) => s.factIds))].map((id) => carouselFacts.find((f) => f.id === id)?.text ?? '').filter((t) => t !== '');
  log(`2/4 Writing a caption for each of ${input.networks.join(', ')}…`);
  const closingLine = input.brand.cta?.text ?? `Visit ${displayDomain(input.brand.website)}`;
  const captions = await (input.deps?.captions ?? ((d, texts) => writeCarouselCaptions({ ai: input.ai, topic: d.topic, headlines: d.slides.map((s) => s.headline), facts: texts, closingLine, networks: input.networks })))(draft, factTexts);
  const entry: HistoryEntry = { id: carouselId, topic: draft.topic, createdAt: now().toISOString(), date: input.date, stage: 'topic', plan: { draft, captions: captions.captions, fallback: captions.fallback, networks: [...input.networks] } };
  changeHistory(input.brandDir, (entries) => [...entries, entry]);
  log('3/4 The carousel topic is written; no picture was drawn. It waits for the customer to keep it.');
  log('4/4 Done.');
  return { status: 'topic', carouselId, topic: draft.topic, ...(captions.fallback.length > 0 ? { fallback: captions.fallback } : {}) };
}

/** The second stage: draws the slides of a carousel the customer kept, from the words saved in the first, and puts the finished carousel up for review. */
export async function drawCarousel(input: Omit<CarouselRunInput, 'networks' | 'date'>, carouselId: string, options: { /** For the one-go run: draw a carousel that has not been kept. */ any?: boolean } = {}): Promise<CarouselRunResult> {
  const log = input.log ?? ((): void => undefined);
  const entry = readHistory(input.brandDir).find((h) => h.id === carouselId);
  if (!entry || !entry.plan || entry.date === undefined) return { status: 'skipped', carouselId, reason: 'there is no saved topic for that carousel' };
  if (entry.stage !== 'kept' && !(options.any === true && entry.stage === 'topic')) return { status: 'skipped', carouselId, reason: 'only a carousel the customer kept is drawn' };
  const { draft, captions, fallback } = entry.plan;
  const date = entry.date;
  const carouselFacts: CarouselFact[] = input.facts.map((f) => ({ id: f.id, text: displayFact(f) }));
  const outDir = join(input.outRoot, input.brandSlug, carouselId);
  mkdirSync(outDir, { recursive: true });
  log('3/4 Drawing the slides with the picture model…');
  const slides = await makeCarouselSlides({
    ai: input.ai, brand: input.brand, brandSlug: input.brandSlug, facts: carouselFacts, draft, idPrefix: carouselId, date, outDir,
    ...(input.logo ? { logo: input.logo } : {}), log: (m) => log(`    ${m}`), ...(input.deps?.slides ? { deps: input.deps.slides } : {}),
  });
  const reportFile = join(outDir, 'carousel-report.json');
  await writeFileAtomic(reportFile, `${JSON.stringify({ carouselId, topic: draft.topic, ready: slides.ready, reason: slides.reason, slides: slides.slides, fallbackCaptions: fallback }, null, 2)}\n`);
  if (!slides.ready) return { status: 'not_ready', carouselId, topic: draft.topic, reason: slides.reason ?? 'a slide was not accepted' };

  const weekNumber = Math.max(0, ...readdirSync(input.brandDir).map((f) => Number(WEEK_FILE.exec(f)?.[1] ?? 0))) + 1;
  const planFile = `week-${String(weekNumber).padStart(2, '0')}.json`;
  registerCarousel({
    brandDir: input.brandDir, brandSlug: input.brandSlug, planFile, carouselId, draft, slides, facts: input.facts, captions,
    ctaUrl: input.brand.cta?.evidence?.url ?? input.brand.website, reportFile,
  });
  // The plan file is what the export reads: one post, the carousel, which can only go out as the exact slides and captions the owner approves in review.
  const main = captions['instagram'] ?? Object.values(captions)[0] ?? draft.topic;
  const plan: WeekPlan = {
    brand: input.brandSlug, timezone: offsetOf(date), renderMode: 'ai_v1',
    posts: [{ id: carouselId, date, painPoint: draft.topic, mode: 'ai', headline: draft.topic, subline: '', caption: main, hashtags: [], imagePrompt: draft.topic, pillar: 'carousel', factIds: [...new Set(draft.slides.flatMap((s) => s.factIds))],
      // The channels it may go to: a release record made from this plan (manual-release.ts) reads them from here, so a carousel is never limited to Instagram by default.
      variants: Object.fromEntries(Object.entries(captions).map(([network, caption]) => [network, { caption, hashtags: [] }])) }],
  };
  await writeFileAtomic(join(input.brandDir, planFile), `${JSON.stringify(plan, null, 2)}\n`);
  changeHistory(input.brandDir, (entries) => entries.map((h) => {
    if (h.id !== carouselId) return h;
    const { plan: _saved, ...rest } = h;
    return { ...rest, planFile, stage: 'drawn' as const };
  }));
  log(`4/4 The carousel is in the owner's review queue (${planFile}); nothing was scheduled or published.`);
  return { status: 'queued', carouselId, planFile, topic: draft.topic, ...(fallback.length > 0 ? { fallback } : {}) };
}

/** Both stages in one go (the way a carousel was always made for the owner's own clients): the topic, then the drawing, without waiting for a decision. */
export async function runCarousel(input: CarouselRunInput): Promise<CarouselRunResult> {
  const topic = await planCarouselTopic(input);
  if (topic.status !== 'topic') return topic;
  const drawn = await drawCarousel(input, topic.carouselId, { any: true });
  // Made in one go, a carousel whose slides were not all accepted leaves nothing behind (not even its topic): there is no customer to keep it for a later try.
  if (drawn.status !== 'queued') changeHistory(input.brandDir, (entries) => entries.filter((h) => h.id !== topic.carouselId));
  return drawn;
}
