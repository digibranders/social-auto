/**
 * The owner changes the writer's headline or caption before anything is drawn. The new words go through the same checks as the writer's own: the claim gate
 * against the facts the post was written from, the writing check, and the length limits the poster can carry. They are then written into the plan file (which
 * is what gets drawn) and into the copy list together, under the list's lock. Nothing is bought here.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkCopy } from './copy-gate.ts';
import { checkCopyQuality } from './copy-quality.ts';
import { CopyStage, CopyStageError, PLAN_FILE, type CopyBatch } from './copy-stage.ts';
import { composeCaption } from './content.ts';
import { composeVariant, isNetwork, NETWORK_RULES, type Network } from './networks.ts';
import { displayFact, type EvidenceFact } from './evidence.ts';

export const MAX_HEADLINE_CHARS = 60;
export const MAX_CAPTION_CHARS = 1500;

interface RawVariant { caption?: unknown; hashtags?: unknown; fallback?: unknown }
interface RawPost { id?: unknown; headline?: unknown; subline?: unknown; caption?: unknown; hashtags?: unknown; factIds?: unknown; variants?: Record<string, RawVariant> }

export function editCopy(input: {
  brandDir: string;
  brand: string;
  planFile: string;
  postId: string;
  headline?: string;
  /** The caption's own words; the hashtags stay as the writer made them. */
  caption?: string;
  /** The network whose caption is being changed. Without one, or for Instagram, it is the main caption. */
  network?: string;
  by: string;
  /** The facts the brand has, to check the new words against the ones this post was written from. */
  facts: readonly EvidenceFact[];
}): CopyBatch {
  if (!PLAN_FILE.test(input.planFile)) throw new CopyStageError('INVALID', 'that is not a plan file name');
  if (input.headline === undefined && input.caption === undefined) throw new CopyStageError('INVALID', 'give a headline, a caption or both');
  const planPath = join(input.brandDir, input.planFile);
  let raw: { posts?: RawPost[] };
  try {
    raw = JSON.parse(readFileSync(planPath, 'utf8')) as { posts?: RawPost[] };
  } catch {
    throw new CopyStageError('NOT_FOUND', 'no plan for that batch');
  }
  const post = raw.posts?.find((p) => p.id === input.postId);
  if (!post || typeof post.headline !== 'string' || typeof post.caption !== 'string' || !Array.isArray(post.hashtags)) throw new CopyStageError('NOT_FOUND', 'no such post in this plan');

  // Emphasis marks (|) are the writer's way of picking words to stress; the owner types plain words, and the marks of the old headline do not carry over.
  if (input.network !== undefined && !isNetwork(input.network)) throw new CopyStageError('INVALID', 'that is not a network');
  const network: Network | undefined = input.network as Network | undefined;
  // A caption for another network is that network's own version; Instagram's is the main caption.
  const variant = network && network !== 'instagram' ? post.variants?.[network] : undefined;
  if (network && network !== 'instagram' && (!variant || typeof variant.caption !== 'string' || !Array.isArray(variant.hashtags))) throw new CopyStageError('NOT_FOUND', `this post has no caption for ${network}`);
  const headline = (input.headline ?? post.headline).replaceAll('|', '').replace(/\s+/g, ' ').trim();
  const caption = (input.caption ?? (variant ? (variant.caption as string) : post.caption)).trim();
  if (headline === '') throw new CopyStageError('REJECTED', 'the headline cannot be empty');
  if (headline.length > MAX_HEADLINE_CHARS) throw new CopyStageError('REJECTED', `the headline is ${headline.length} characters; a poster can carry at most ${MAX_HEADLINE_CHARS}`);
  if (caption === '') throw new CopyStageError('REJECTED', 'the caption cannot be empty');
  if (caption.length > (network ? NETWORK_RULES[network].maxCaption : MAX_CAPTION_CHARS)) throw new CopyStageError('REJECTED', `the caption is ${caption.length} characters; at most ${network ? NETWORK_RULES[network].maxCaption : MAX_CAPTION_CHARS} are allowed`);
  const weak = checkCopyQuality({ headline, caption });
  if (weak) throw new CopyStageError('REJECTED', weak);

  // The claim gate: every checkable statement must be one of the facts this post was written from.
  const ids = Array.isArray(post.factIds) ? (post.factIds as unknown[]).filter((v): v is string => typeof v === 'string') : [];
  if (ids.length > 0) {
    const evidence = ids.flatMap((id) => { const fact = input.facts.find((f) => f.id === id); return fact ? [displayFact(fact)] : []; });
    const violations = checkCopy({ headline, subline: typeof post.subline === 'string' ? post.subline : '', caption }, evidence);
    if (violations.length > 0) throw new CopyStageError('REJECTED', `the words say something the website does not support: ${violations.map((v) => `${v.field} "${v.sentence.slice(0, 80)}" ${v.reason}`).join('; ')}`);
  }

  const hashtags = (post.hashtags as unknown[]).filter((h): h is string => typeof h === 'string');
  // What the list shows for the main caption stays the main caption when only another network's caption changes.
  const mainCaption = variant ? (post.caption as string).trim() : caption;
  const composed = composeCaption({ caption: mainCaption, hashtags });
  const networkText = variant ? composeVariant({ caption, hashtags: (variant.hashtags as unknown[]).filter((h): h is string => typeof h === 'string') })
    : network === 'instagram' && post.variants?.['instagram'] ? composed : undefined;
  return new CopyStage(input.brandDir, input.brand).edit(input.planFile, input.postId, { headline, caption: composed, ...(network && networkText !== undefined ? { network, networkCaption: networkText } : {}) }, input.by, () => {
    post.headline = headline;
    if (variant) {
      variant.caption = caption;
      delete variant.fallback;
    } else {
      post.caption = caption;
      if (post.variants?.['instagram']) post.variants['instagram'].caption = caption;
    }
    const temp = `${planPath}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(raw, null, 2)}\n`);
    renameSync(temp, planPath);
  });
}
