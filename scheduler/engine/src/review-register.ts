/**
 * Puts the posters the system accepted into the owner's review queue as pending versions. A poster the system rejected is not offered for review:
 * it has no picture that passed. Registering the same result twice makes nothing new (see ReviewStore.addVersion).
 */
import { basename } from 'node:path';
import type { BrandingDecision, LogoPlacementRecord } from './branding.ts';
import type { CreativeReport } from './ai-creative-pipeline.ts';
import { composeCaption, type Brand, type PlannedPost } from './content.ts';
import { composeVariant, NETWORKS, type PostVariant } from './networks.ts';
import { inspectLogoFile } from './branding.ts';
import type { EvidenceFact } from './evidence.ts';
import { ReviewStore, type EvidenceSnapshot, type PostVersion } from './review-store.ts';
import type { CarouselDraft } from './carousel.ts';
import type { CarouselSlides } from './carousel-make.ts';

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
  /** Only these networks' versions are registered (the networks this report's pictures are for); a post written for other networks is skipped. */
  networks?: readonly string[];
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
    const size = (() => { try { return inspectLogoFile(result.file as string); } catch { return { width: 1024, height: 1024 }; } })();
    const base = {
      postId: post.id,
      planFile: input.planFile,
      headline: result.manifest.headline,
      ctaUrl: post.cta?.evidence?.url ?? input.brand.cta?.evidence?.url ?? input.brand.website,
      factIds: post.factIds ?? [],
      evidence,
      imagePath: result.file,
      validation: { accepted: true, readings: last?.readings.length ?? 0, defects: [], reportFile: basename(input.reportFile) },
      attempts: result.attempts.length,
      costUsd: result.costUsd,
      ...(input.branding ? { branding: brandingFor(input.branding, result.logo) } : {}),
    };
    // A post written for networks gets one version per network, each with its own caption, all showing this picture (networks of the same shape share one picture);
    // a post written without networks is one version, as before.
    const written = NETWORKS.filter((n) => post.variants?.[n] !== undefined);
    const networks = input.networks ? written.filter((n) => input.networks?.includes(n)) : written;
    if (written.length > 0 && networks.length === 0) continue;
    if (networks.length === 0) versions.push(store.addVersion({ ...base, caption: composeCaption(post) }));
    else for (const network of networks) versions.push(store.addVersion({ ...base, network, width: size.width, height: size.height, caption: composeVariant(post.variants?.[network] as PostVariant) }));
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

export interface RegisterCarouselInput {
  brandDir: string;
  brandSlug: string;
  planFile: string;
  /** The carousel's own id; its slides are "<id>-s1" and so on, and its captions are versions of this id. */
  carouselId: string;
  draft: CarouselDraft;
  /** The drawn slides; a carousel that is not ready registers nothing. */
  slides: CarouselSlides;
  facts: readonly EvidenceFact[];
  /** One caption per network, written for that network. At least one is needed: a carousel with no caption cannot be posted. */
  captions: Partial<Record<string, string>>;
  ctaUrl: string;
  reportFile: string;
}

/** Puts a ready carousel into the review queue as pending versions: each slide, and each network's caption showing the cover. Nothing is registered unless the carousel is complete and has a caption. */
export function registerCarousel(input: RegisterCarouselInput): PostVersion[] {
  if (!input.slides.ready) return [];
  const captions = Object.entries(input.captions).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim() !== '');
  if (captions.length === 0) throw new Error(`carousel ${input.carouselId} has no caption, so it was not put up for review`);
  const files = input.slides.slides.map((s) => s.file);
  if (files.length !== input.draft.slides.length || files.some((f) => f === undefined)) throw new Error(`carousel ${input.carouselId} is missing a slide picture, so it was not put up for review`);
  const store = new ReviewStore(input.brandDir, input.brandSlug);
  const evidenceOf = (ids: readonly string[]): EvidenceSnapshot[] => ids.flatMap((id) => {
    const fact = input.facts.find((f) => f.id === id);
    return fact ? [{ factId: fact.id, text: fact.text, quote: fact.source.quote, url: fact.source.url, context: fact.source.context }] : [];
  });
  const count = input.draft.slides.length;
  const validation = (n: number): PostVersion['validation'] => ({ accepted: true, readings: input.slides.slides[n]?.attempts.at(-1)?.readings.length ?? 0, defects: [], reportFile: basename(input.reportFile) });
  const versions: PostVersion[] = [];
  input.draft.slides.forEach((slide, index) => {
    const result = input.slides.slides[index];
    versions.push(store.addVersion({
      postId: `${input.carouselId}-s${index + 1}`, planFile: input.planFile, headline: result?.manifest.headline ?? slide.headline, caption: '', ctaUrl: input.ctaUrl,
      factIds: slide.factIds, evidence: evidenceOf(slide.factIds), imagePath: files[index] as string, validation: validation(index),
      attempts: result?.attempts.length ?? 1, costUsd: result?.costUsd ?? 0, carousel: { id: input.carouselId, position: index + 1, count },
    }));
  });
  const factIds = [...new Set(input.draft.slides.flatMap((s) => s.factIds))];
  const size = (() => { try { return inspectLogoFile(files[0] as string); } catch { return { width: 1024, height: 1024 }; } })();
  for (const [network, caption] of captions) {
    versions.push(store.addVersion({
      postId: input.carouselId, planFile: input.planFile, network, width: size.width, height: size.height, headline: input.draft.topic, caption, ctaUrl: input.ctaUrl,
      factIds, evidence: evidenceOf(factIds), imagePath: files[0] as string, validation: validation(0), attempts: 1, costUsd: 0, carousel: { id: input.carouselId, position: 0, count },
    }));
  }
  return versions;
}
