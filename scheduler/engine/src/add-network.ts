/**
 * Adds a network to a written batch after the fact, from the same topics and with no new website read. Text only: for each topic a caption is written for the
 * network (the same writer, claim gate and length limit as the original), stored in the plan and in the copy list, and the batch's release record gains the
 * network. For a batch that was already drawn, every topic with a picture is reported as needing a picture of its own for the new network (each network gets
 * its own, even when it shares a shape with another), which the job runner queues as a draw; nothing is copied from another network's picture.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CopyStage, CopyStageError } from './copy-stage.ts';
import { displayFact, type EvidenceFact } from './evidence.ts';
import type { NetworkResult } from './job-store.ts';
import { addPlatformToRelease } from './manual-release.ts';
import type { CaptionPost, CaptionReport } from './network-captions.ts';
import { composeVariant, NETWORK_RULES, type Network, type PostVariant, type PostVariants } from './networks.ts';
import type { PlanPlatform } from './posting-plan.ts';
import { ReviewStore } from './review-store.ts';

interface RawPost { id?: unknown; headline?: unknown; caption?: unknown; hashtags?: unknown; factIds?: unknown; variants?: Record<string, PostVariant> }

/** Why a fresh caption could not be used, as a fixed code (the writer's own sentence is for the log, not for the result). */
function reasonCodeOf(reason: string, hasFacts: boolean): NonNullable<NetworkResult['topics'][number]['reasonCode']> {
  if (/too long/i.test(reason)) return 'TOO_LONG';
  if (/no caption was written|is empty/i.test(reason)) return 'NO_CAPTION';
  return hasFacts ? 'WORDS_REFUSED' : 'NO_FACTS';
}

export type NetworkWriter = (posts: CaptionPost[], networks: Network[]) => Promise<{ variants: Record<string, PostVariants>; report: CaptionReport }>;

export async function addNetworkToBatch(input: { brandDir: string; brand: string; planFile: string; network: Network; facts: readonly EvidenceFact[]; write: NetworkWriter; /** Today in India time (YYYY-MM-DD); a topic whose day has passed gets no picture. Defaults to the real day. */ today?: string }): Promise<NetworkResult> {
  const { brandDir, brand, planFile, network } = input;
  const today = input.today ?? new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
  const copy = new CopyStage(brandDir, brand);
  const batch = copy.get(planFile);
  if (batch.closedAt) throw new CopyStageError('CLOSED', 'this batch was put away, so it cannot be changed');
  const planPath = join(brandDir, planFile);
  const readPlan = (): { posts?: RawPost[] } => JSON.parse(readFileSync(planPath, 'utf8')) as { posts?: RawPost[] };
  const plan = readPlan();
  const rawPosts = plan.posts ?? [];
  if (batch.posts.some((p) => p.captions?.[network] !== undefined) || rawPosts.some((p) => p.variants?.[network] !== undefined)) throw new CopyStageError('CONFLICT', 'the batch already has that network');

  // The topics: the kept ones once the batch was drawn, every one not dropped while it is still waiting.
  const store = new ReviewStore(brandDir, brand);
  const versions = store.list().filter((i) => i.version.planFile === planFile);
  const drawn = batch.drawnAt !== undefined || versions.length > 0;
  const topicIds = batch.posts.filter((p) => (drawn ? p.state === 'kept' : p.state !== 'dropped')).map((p) => p.postId);
  const topics = rawPosts.filter((p): p is RawPost & { id: string; headline: string; caption: string; hashtags: string[] } => typeof p.id === 'string' && topicIds.includes(p.id) && typeof p.headline === 'string' && typeof p.caption === 'string' && Array.isArray(p.hashtags));
  if (topics.length === 0) throw new CopyStageError('REJECTED', 'this batch has no topics to write a caption for');

  const factText = (id: string): string | undefined => { const fact = input.facts.find((f) => f.id === id); return fact ? displayFact(fact) : undefined; };
  const captionPosts: CaptionPost[] = topics.map((p) => ({ id: p.id, headline: p.headline.replaceAll('|', ''), caption: p.caption, hashtags: p.hashtags.filter((h): h is string => typeof h === 'string'), facts: (Array.isArray(p.factIds) ? p.factIds : []).map((id) => (typeof id === 'string' ? factText(id) : undefined)).filter((t): t is string => t !== undefined) }));
  const written = await input.write(captionPosts, [network]);

  // What each topic gains: the new network's caption, and the main caption as Instagram's own when the post had no per-network captions at all (so Instagram stays among its networks).
  const gained = new Map<string, PostVariants>();
  for (const post of topics) {
    const variant = written.variants[post.id]?.[network];
    if (!variant) continue;
    const own: PostVariants = { [network]: variant };
    if (!post.variants && network !== 'instagram') own.instagram = { caption: post.caption.trim(), hashtags: captionPosts.find((c) => c.id === post.id)?.hashtags.slice(0, NETWORK_RULES.instagram.maxHashtags) ?? [] };
    gained.set(post.id, own);
  }
  const captionsByPost = Object.fromEntries([...gained].map(([id, own]) => [id, Object.fromEntries(Object.entries(own).map(([n, v]) => [n, { text: composeVariant(v as PostVariant), ...((v as PostVariant).fallback ? { fallback: true } : {}) }]))]));
  copy.addNetwork(planFile, network, captionsByPost, () => {
    const fresh = readPlan();
    for (const post of fresh.posts ?? []) {
      const own = typeof post.id === 'string' ? gained.get(post.id) : undefined;
      if (own) post.variants = { ...(post.variants ?? {}), ...(own as Record<string, PostVariant>) };
    }
    const temp = `${planPath}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(fresh, null, 2)}\n`);
    renameSync(temp, planPath);
  });
  addPlatformToRelease(brandDir, planFile, network as PlanPlatform);

  const result: NetworkResult = { network, topics: [] };
  for (const post of topics) {
    const variant = written.variants[post.id]?.[network];
    if (!variant) continue;
    const topic: NetworkResult['topics'][number] = { postId: post.id, outcome: 'written', ...(variant.fallback ? { fallback: true as const, reasonCode: reasonCodeOf(written.report.fallback.find((f) => f.postId === post.id)?.reason ?? '', (captionPosts.find((c) => c.id === post.id)?.facts.length ?? 0) > 0) } : {}) };
    // Each network gets a picture of its own: a topic already drawn needs one drawn for the new network, never a copy of another network's picture. A topic of a week
    // not drawn yet has no pictures to match (the network is drawn with the rest of its week), and one whose day has passed can no longer be posted.
    const day = batch.posts.find((p) => p.postId === post.id)?.date;
    if (drawn && versions.some((i) => i.version.postId === post.id) && (day === undefined || day >= today)) topic.needsDraw = true;
    result.topics.push(topic);
  }
  return result;
}

