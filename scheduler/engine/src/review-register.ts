/**
 * Puts the posters the system accepted into the owner's review queue as pending versions. A poster the system rejected is not offered for review:
 * it has no picture that passed. Registering the same result twice makes nothing new (see ReviewStore.addVersion).
 */
import { basename } from 'node:path';
import type { BrandingDecision, LogoPlacementRecord } from './branding.ts';
import type { CreativeReport } from './ai-creative-pipeline.ts';
import { composeCaption, type Brand, type PlannedPost } from './content.ts';
import type { EvidenceFact } from './evidence.ts';
import { ReviewStore, type EvidenceSnapshot, type PostVersion } from './review-store.ts';

export function registerForReview(input: {
  brandDir: string;
  brandSlug: string;
  planFile: string;
  report: CreativeReport;
  posts: readonly PlannedPost[];
  brand: Pick<Brand, 'website' | 'cta'>;
  facts: readonly EvidenceFact[];
  /** The report file as saved, for the version's record. */
  reportFile: string;
  /** How the posters were branded (frozen before anything was bought), recorded with each version. */
  branding?: BrandingDecision;
}): PostVersion[] {
  const store = new ReviewStore(input.brandDir, input.brandSlug);
  const versions: PostVersion[] = [];
  for (const result of input.report.results) {
    if (result.status !== 'accepted' || !result.file) continue;
    const post = input.posts.find((p) => p.id === result.postId);
    if (!post) continue;
    const evidence: EvidenceSnapshot[] = (post.factIds ?? []).flatMap((id) => {
      const fact = input.facts.find((f) => f.id === id);
      return fact ? [{ factId: fact.id, text: fact.text, quote: fact.source.quote, url: fact.source.url, context: fact.source.context }] : [];
    });
    const last = result.attempts.at(-1);
    versions.push(store.addVersion({
      postId: post.id,
      planFile: input.planFile,
      headline: result.manifest.headline,
      caption: composeCaption(post),
      ctaUrl: post.cta?.evidence?.url ?? input.brand.cta?.evidence?.url ?? input.brand.website,
      factIds: post.factIds ?? [],
      evidence,
      imagePath: result.file,
      validation: { accepted: true, readings: last?.readings.length ?? 0, defects: [], reportFile: basename(input.reportFile) },
      attempts: result.attempts.length,
      costUsd: result.costUsd,
      ...(input.branding ? { branding: brandingFor(input.branding, result.logo) } : {}),
    }));
  }
  return versions;
}

/**
 * What a poster's record says about its branding. The real logo is said to be on a poster only when the poster's own result shows where it was put: a
 * decision that said it would be applied, for a poster that came back without it, is recorded as text-only, with the reason.
 */
export function brandingFor(decision: BrandingDecision, placement: LogoPlacementRecord | undefined): BrandingDecision {
  if (placement) return { ...decision, placement };
  if (decision.status !== 'applied') return decision;
  return { ...decision, appliedMode: 'text_only', status: 'awaiting_compositor', reasonCode: 'LOGO_COMPOSITOR_UNAVAILABLE', reason: 'The real logo was meant to go on this poster but was not placed, so it carries the brand name and web address as text.' };
}
