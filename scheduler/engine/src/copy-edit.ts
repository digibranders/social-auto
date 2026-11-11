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
import { splitTrailingHashtags } from './caption-text.ts';
import { composeVariant, isNetwork, NETWORK_RULES, type Network } from './networks.ts';
import { displayFact, type EvidenceFact } from './evidence.ts';

export const MAX_HEADLINE_CHARS = 60;
export const MAX_BRAND_NAME_CHARS = 40;
export const MAX_ADDRESS_CHARS = 60;
export const MAX_CAPTION_CHARS = 1500;

interface RawVariant { caption?: unknown; hashtags?: unknown; fallback?: unknown }
interface RawPost { id?: unknown; signoff?: unknown; headline?: unknown; subline?: unknown; caption?: unknown; hashtags?: unknown; factIds?: unknown; variants?: Record<string, RawVariant> }

/** What a poster's sign-off says when the owner has not changed it: the brand's name and the website's address. */
export interface SignoffDefaults {
  brandName: string;
  domain: string;
}

export interface Signoff {
  brandName?: string;
  domain?: string;
}

const signoffOf = (value: unknown): Signoff => {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  return { ...(typeof v['brandName'] === 'string' ? { brandName: v['brandName'] } : {}), ...(typeof v['domain'] === 'string' ? { domain: v['domain'] } : {}) };
};

/**
 * The sign-off the owner asked for. A piece left out (undefined) stays as it was; an empty one means the poster leaves that line off; the default wording typed
 * again goes back to the default. A name must be short plain text; an address must be a web address on the client's own website (the website itself, a page of
 * it or a subdomain), never someone else's. Returns only what differs from the defaults (an empty string is "left off"), or null when nothing does.
 */
export function checkSignoff(wanted: { brandName?: string; domain?: string }, defaults: SignoffDefaults, current: Signoff): Signoff | null {
  const next: Signoff = { ...current };
  if (wanted.brandName !== undefined) {
    const name = wanted.brandName.replace(/\s+/g, ' ').trim();
    if (name === defaults.brandName) delete next.brandName;
    else if (name === '') next.brandName = '';
    else {
      if (name.length > MAX_BRAND_NAME_CHARS) throw new CopyStageError('REJECTED', `the brand name is ${name.length} characters; a poster can carry at most ${MAX_BRAND_NAME_CHARS}`);
      if (/["\\|\u0000-\u001f]/.test(name)) throw new CopyStageError('REJECTED', 'the brand name cannot contain quotation marks, | or a backslash');
      next.brandName = name;
    }
  }
  if (wanted.domain !== undefined) {
    const raw = wanted.domain.trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '');
    const slash = raw.indexOf('/');
    const host = (slash === -1 ? raw : raw.slice(0, slash)).toLowerCase();
    const address = slash === -1 ? host : `${host}${raw.slice(slash)}`;
    if (address === defaults.domain) delete next.domain;
    else if (raw === '') next.domain = '';
    else {
      if (address.length > MAX_ADDRESS_CHARS) throw new CopyStageError('REJECTED', `the web address is ${address.length} characters; a poster can carry at most ${MAX_ADDRESS_CHARS}`);
      if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/[A-Za-z0-9._~\-/]*)?$/.test(address)) throw new CopyStageError('REJECTED', 'that does not look like a web address, such as acme.com or acme.com/pricing');
      const own = defaults.domain.toLowerCase();
      if (host !== own && !host.endsWith(`.${own}`)) throw new CopyStageError('REJECTED', `the web address must be on the client's own website (${own}), not another one`);
      next.domain = address;
    }
  }
  return next.brandName === undefined && next.domain === undefined ? null : next;
}

/**
 * The checks every change of words goes through, whether it is made on a written post (before drawing) or as a new caption for a picture that was already
 * drawn: not empty, short enough for the poster and the network, writing quality, and the claim gate against the facts the post was written from. Only the
 * words being changed are judged; what the writer already wrote was checked when it was written. Throws CopyStageError REJECTED with the reason.
 * Returns the headline as it will be kept (a headline left alone keeps the writer's emphasis marks), its plain form, and the caption's own words.
 */
export function checkNewWords(input: {
  headline?: string;
  caption?: string;
  wasHeadline: string;
  wasCaption: string;
  network?: Network;
  factIds: readonly string[];
  facts: readonly EvidenceFact[];
}): { plainHeadline: string; headline: string; caption: string } {
  // Emphasis marks (|) are the writer's way of picking words to stress; the owner types plain words, and the marks of the old headline do not carry over.
  const plainHeadline = (input.headline ?? input.wasHeadline).replaceAll('|', '').replace(/\s+/g, ' ').trim();
  // Only a headline the owner typed loses the writer's emphasis marks; when it is not being changed it stays exactly as it was.
  const headline = input.headline === undefined ? input.wasHeadline : plainHeadline;
  // The caption's own words: a closing run of #tags in what was typed is the hashtags again, which stay as the writer made them (they are not added twice).
  const caption = splitTrailingHashtags((input.caption ?? input.wasCaption).trim()).body;
  if (plainHeadline === '') throw new CopyStageError('REJECTED', 'the headline cannot be empty');
  if (plainHeadline.length > MAX_HEADLINE_CHARS) throw new CopyStageError('REJECTED', `the headline is ${plainHeadline.length} characters; a poster can carry at most ${MAX_HEADLINE_CHARS}`);
  if (caption === '') throw new CopyStageError('REJECTED', 'the caption cannot be empty');
  // The length limit applies to a caption the owner is changing, not to one that was already there (the limits were tightened after older batches were written).
  const wasBody = splitTrailingHashtags(input.wasCaption.trim()).body;
  const maxCaption = input.network ? NETWORK_RULES[input.network].maxCaption : MAX_CAPTION_CHARS;
  if (caption !== wasBody && caption.length > maxCaption) throw new CopyStageError('REJECTED', `the caption is ${caption.length} characters; at most ${maxCaption} are allowed`);
  const weak = checkCopyQuality({ headline: plainHeadline, caption });
  if (weak) throw new CopyStageError('REJECTED', weak);

  // The claim gate: every checkable statement must be one of the facts this post was written from. It always runs: a post that names no facts supports no number,
  // price, superlative or guarantee at all, so such a claim in new words is refused rather than passed unchecked.
  const evidence = input.factIds.flatMap((id) => { const fact = input.facts.find((f) => f.id === id); return fact ? [displayFact(fact)] : []; });
  // Only the words being changed are checked: what the writer already wrote was checked when it was written.
  const violations = checkCopy({ headline: input.headline === undefined ? '' : plainHeadline, subline: '', caption: input.caption === undefined ? '' : caption }, evidence);
  if (violations.length > 0) throw new CopyStageError('REJECTED', `the words say something the website does not support: ${violations.map((v) => `${v.field} "${v.sentence.slice(0, 80)}" ${v.reason}`).join('; ')}`);
  return { plainHeadline, headline, caption };
}

/** Runs the same checks as an edit on words that have not been saved, changing nothing: the answer is that it returns, or the reason it throws. */
export function checkCopyWords(input: { brandDir: string; planFile: string; postId: string; headline?: string; caption?: string; network?: string; facts: readonly EvidenceFact[] }): void {
  if (!PLAN_FILE.test(input.planFile)) throw new CopyStageError('INVALID', 'that is not a plan file name');
  if (input.headline === undefined && input.caption === undefined) throw new CopyStageError('INVALID', 'give a headline or a caption');
  let raw: { posts?: RawPost[] };
  try {
    raw = JSON.parse(readFileSync(join(input.brandDir, input.planFile), 'utf8')) as { posts?: RawPost[] };
  } catch {
    throw new CopyStageError('NOT_FOUND', 'no plan for that batch');
  }
  const post = raw.posts?.find((p) => p.id === input.postId);
  if (!post || typeof post.headline !== 'string' || typeof post.caption !== 'string') throw new CopyStageError('NOT_FOUND', 'no such post in this plan');
  if (input.network !== undefined && !isNetwork(input.network)) throw new CopyStageError('INVALID', 'that is not a network');
  const network: Network | undefined = input.network as Network | undefined;
  const variant = network && network !== 'instagram' ? post.variants?.[network] : undefined;
  if (network && network !== 'instagram' && (!variant || typeof variant.caption !== 'string')) throw new CopyStageError('NOT_FOUND', `this post has no caption for ${network}`);
  checkNewWords({
    ...(input.headline !== undefined ? { headline: input.headline } : {}),
    ...(input.caption !== undefined ? { caption: input.caption } : {}),
    wasHeadline: post.headline,
    wasCaption: (variant ? (variant.caption as string) : post.caption) ?? '',
    ...(network ? { network } : {}),
    factIds: Array.isArray(post.factIds) ? (post.factIds as unknown[]).filter((v): v is string => typeof v === 'string') : [],
    facts: input.facts,
  });
}

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
  /** The brand name and the web address as the poster should show them; an empty one leaves that line off the poster. */
  brandName?: string;
  domain?: string;
  /** What the sign-off says when not changed (the brand's name and the website's address); needed to change the sign-off. */
  signoffDefaults?: SignoffDefaults;
  by: string;
  /** The facts the brand has, to check the new words against the ones this post was written from. */
  facts: readonly EvidenceFact[];
}): CopyBatch {
  if (!PLAN_FILE.test(input.planFile)) throw new CopyStageError('INVALID', 'that is not a plan file name');
  const changesSignoff = input.brandName !== undefined || input.domain !== undefined;
  if (input.headline === undefined && input.caption === undefined && !changesSignoff) throw new CopyStageError('INVALID', 'give a headline, a caption, a brand name or a web address');
  if (changesSignoff && !input.signoffDefaults) throw new CopyStageError('REJECTED', 'this brand has no name or website saved, so the sign-off cannot be changed');
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
  const ids = Array.isArray(post.factIds) ? (post.factIds as unknown[]).filter((v): v is string => typeof v === 'string') : [];
  const { plainHeadline, headline, caption } = checkNewWords({
    ...(input.headline !== undefined ? { headline: input.headline } : {}),
    ...(input.caption !== undefined ? { caption: input.caption } : {}),
    wasHeadline: post.headline,
    wasCaption: (variant ? (variant.caption as string) : post.caption) ?? '',
    ...(network ? { network } : {}),
    factIds: ids,
    facts: input.facts,
  });

  const signoff = changesSignoff && input.signoffDefaults
    ? checkSignoff({ ...(input.brandName !== undefined ? { brandName: input.brandName } : {}), ...(input.domain !== undefined ? { domain: input.domain } : {}) }, input.signoffDefaults, signoffOf(post.signoff))
    : undefined;

  const hashtags = (post.hashtags as unknown[]).filter((h): h is string => typeof h === 'string');
  // What the list shows for the main caption stays the main caption when only another network's caption changes.
  const mainCaption = variant ? (post.caption as string).trim() : caption;
  const composed = composeCaption({ caption: mainCaption, hashtags });
  const networkText = variant ? composeVariant({ caption, hashtags: (variant.hashtags as unknown[]).filter((h): h is string => typeof h === 'string') })
    : network === 'instagram' && post.variants?.['instagram'] ? composed : undefined;
  return new CopyStage(input.brandDir, input.brand).edit(input.planFile, input.postId, { headline, caption: composed, ...(network && networkText !== undefined ? { network, networkCaption: networkText } : {}), ...(signoff !== undefined ? { signoff } : {}) }, input.by, () => {
    post.headline = headline;
    if (signoff !== undefined) {
      if (signoff === null) delete post.signoff;
      else post.signoff = signoff;
    }
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
