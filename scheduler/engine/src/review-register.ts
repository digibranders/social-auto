/**
 * Puts the posters the system accepted into the owner's review queue as pending versions. A poster the system rejected is not offered for review:
 * it has no picture that passed. Registering the same result twice makes nothing new (see ReviewStore.addVersion).
 */
import { basename } from 'node:path';
import type { BrandingDecision } from './branding.ts';
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
      ...(input.branding ? { branding: input.branding } : {}),
    }));
  }
  return versions;
}
