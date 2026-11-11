/**
 * Draws the slides of a carousel with the poster pipeline and says whether the carousel is ready. A carousel is all or nothing: one slide that is not accepted
 * makes the whole carousel not ready, because a set with a hole in it is never posted.
 */
import { makeCreatives, type CreativeDeps, type CreativeReport, type CreativeResult, type CreativeRunInput } from './ai-creative-pipeline.ts';
import { slideConcepts, slidePosts, type CarouselDraft, type CarouselFact } from './carousel.ts';
import type { Brand } from './content.ts';

export interface MakeCarouselInput {
  ai: CreativeRunInput['ai'];
  brand: Brand;
  brandSlug: string;
  facts: readonly CarouselFact[];
  draft: CarouselDraft;
  idPrefix: string;
  date: string;
  outDir: string;
  /** The brand's real logo: it goes on the last slide only, with the website's address. The business name is never written as text on a slide. */
  logo?: CreativeRunInput['logo'];
  log?: (message: string) => void;
  deps?: CreativeDeps;
}

export interface CarouselSlides {
  ready: boolean;
  /** Why the carousel is not ready: the first slide that failed, and what stopped it. */
  reason?: string;
  /** One result per slide, in order. A slide that was never drawn (an earlier one failed) is reported as such. */
  slides: CreativeResult[];
  reports: CreativeReport[];
}

/**
 * The first slides are drawn in one run without the logo, the last in a run of its own with it, so the logo and the sign-off appear once. When the first run
 * does not accept every slide the last is not drawn: nothing more is bought for a carousel that cannot be posted.
 */
export async function makeCarouselSlides(input: MakeCarouselInput): Promise<CarouselSlides> {
  const posts = slidePosts(input.draft, { idPrefix: input.idPrefix, date: input.date });
  const concepts = slideConcepts(input.draft, posts);
  const factText = new Map(input.facts.map((f) => [f.id, f.text]));
  const factOf = (post: { factIds?: string[] }): string => (post.factIds ?? []).map((id) => factText.get(id) ?? '').filter((t) => t !== '').join(' ');
  const direct: NonNullable<CreativeDeps['direct']> = async (batch) => ({ concepts: concepts.filter((c) => batch.some((b) => b.id === c.postId)), dropped: [], flags: [] });
  const deps: CreativeDeps = { lookAlikes: async () => ({ scenes: [], typography: [] }), ...input.deps, direct };
  const run = (batch: typeof posts, logo?: CreativeRunInput['logo']): Promise<CreativeReport> =>
    makeCreatives({ ai: input.ai, brand: input.brand, brandSlug: input.brandSlug, posts: batch, factOf, outDir: input.outDir, directorEnabled: true, ...(logo ? { logo } : {}), ...(input.log ? { log: input.log } : {}), deps });

  const reports: CreativeReport[] = [];
  const lastIndex = posts.length - 1;
  const first = await run(posts.slice(0, lastIndex));
  reports.push(first);
  const failedAt = first.results.findIndex((r) => r.status !== 'accepted');
  if (failedAt === -1) reports.push(await run(posts.slice(lastIndex), input.logo));
  const results = reports.flatMap((r) => r.results);
  const bad = results.findIndex((r) => r.status !== 'accepted');
  const slides = posts.map((post, i) => results[i] ?? { postId: post.id, manifest: { headline: '', brandName: '', domain: '' }, status: 'dropped' as const, attempts: [], reason: 'not drawn: an earlier slide was not accepted', costUsd: 0 });
  if (bad === -1 && results.length === posts.length) return { ready: true, slides, reports };
  const culprit = results[bad === -1 ? 0 : bad];
  const stopped = reports.find((r) => r.stoppedBy)?.stoppedBy;
  return { ready: false, reason: `slide ${(bad === -1 ? 0 : bad) + 1} was ${culprit?.status ?? 'not drawn'}: ${stopped ?? culprit?.reason ?? 'it was not accepted'}`, slides, reports };
}
