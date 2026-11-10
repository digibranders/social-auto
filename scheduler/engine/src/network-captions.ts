/**
 * A caption for each network a post is written for. The main caption was written for Instagram; here one batched request writes the other networks' versions
 * from the same facts, and code checks every one with the checks the writer's own words go through (claim gate against the post's facts, the writing check, the
 * network's length and hashtag limits). The closing call to action line is added by code, never by the model, so a network never gets an invented link line.
 * A version that fails is asked for once more with the reasons; one that still fails is replaced by the main caption adapted to the network and marked `fallback`.
 */
import type { AiConfig } from './ai.ts';
import { checkCopy } from './copy-gate.ts';
import { checkCopyQuality } from './copy-quality.ts';
import { tidyPunctuation } from './content.ts';
import { chatJson } from './llm.ts';
import { NETWORK_RULES, type Network, type PostVariant, type PostVariants } from './networks.ts';

export interface CaptionPost {
  id: string;
  headline: string;
  /** The main caption as the writer made it, with its closing call to action line. */
  caption: string;
  hashtags: string[];
  /** The exact wording of the facts the post was written from. */
  facts: string[];
}

export interface CaptionReport {
  requested: number;
  written: number;
  retried: number;
  fallback: Array<{ postId: string; network: Network; reason: string }>;
}

const SYSTEM = `You write social media captions for a business from verified facts. For each post and each network listed you get the post's headline, the main caption and the exact facts it rests on. Write one caption per post and network.
Rules: use only what the facts state; do not add numbers, prices, guarantees, awards, statistics or comparisons the facts do not state; say the same thing the headline says, in the voice of the network; do not repeat the headline word for word; do not repeat yourself inside the caption; do not write a call to action, a web address or hashtags in the caption text (they are added separately); write plain sentences. For each caption also give hashtags (a list of #tags, each one word) within the network's limit, an empty list when the limit is 0.
Return JSON only: {"captions":[{"postId":"...","network":"...","caption":"...","hashtags":["#..."]}]}`;

/** The closing line of a caption: the last paragraph that is not hashtags. For Instagram it ends "(link in bio)"; other networks can carry the address itself. */
function closingLine(caption: string): string {
  const lines = caption.split(/\n+/).map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'));
  return lines.at(-1) ?? '';
}
const bodyOf = (caption: string): string => caption.split(/\n+/).map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#')).slice(0, -1).join('\n\n');
const withCta = (network: Network, body: string, cta: string): string => {
  const line = NETWORK_RULES[network].linkInBio ? cta : cta.replace(/\s*\(link in bio\)\s*/i, '').trim();
  return [tidyPunctuation(body.trim()), line].filter((p) => p !== '').join('\n\n');
};

function tags(raw: unknown, max: number): string[] | undefined {
  if (!Array.isArray(raw) || !raw.every((h) => typeof h === 'string' && /^#\S+$/.test(h))) return undefined;
  return raw.length <= max ? (raw as string[]) : (raw as string[]).slice(0, max);
}

interface Draft { postId: string; network: Network; caption: string; hashtags: string[] }

function parseDrafts(value: unknown, posts: readonly CaptionPost[], networks: readonly Network[]): Draft[] {
  const list = (value as { captions?: unknown }).captions;
  if (!Array.isArray(list)) throw new Error('"captions" must be a list');
  return list.flatMap((entry): Draft[] => {
    const e = entry as { postId?: unknown; network?: unknown; caption?: unknown; hashtags?: unknown };
    if (typeof e.postId !== 'string' || !posts.some((p) => p.id === e.postId) || typeof e.network !== 'string' || !(networks as readonly string[]).includes(e.network) || typeof e.caption !== 'string') return [];
    const network = e.network as Network;
    const hashtags = tags(e.hashtags, NETWORK_RULES[network].maxHashtags);
    return hashtags ? [{ postId: e.postId, network, caption: e.caption.trim(), hashtags }] : [];
  });
}

/** Why a draft cannot be used, or undefined when it can. */
function problemWith(draft: Draft, post: CaptionPost): string | undefined {
  const rules = NETWORK_RULES[draft.network];
  if (draft.caption === '') return 'the caption is empty';
  if (draft.caption.length > rules.maxCaption - 140) return `the caption is too long for ${draft.network}; keep it under ${rules.maxCaption - 140} characters`;
  const quality = checkCopyQuality({ headline: post.headline, caption: draft.caption });
  if (quality) return quality;
  const violations = checkCopy({ headline: post.headline, subline: '', caption: draft.caption }, post.facts);
  if (violations.length > 0) return `it says something the facts do not support: ${violations.map((v) => `"${v.sentence.slice(0, 80)}" ${v.reason}`).join('; ')}`;
  return undefined;
}

async function ask(ai: AiConfig, posts: readonly CaptionPost[], wanted: ReadonlyArray<{ postId: string; network: Network; note?: string }>, fetchFn?: typeof fetch): Promise<Draft[]> {
  const networks = [...new Set(wanted.map((w) => w.network))];
  const user = `Networks and what each takes:\n${networks.map((n) => `- ${n}: ${NETWORK_RULES[n].voice}. At most ${NETWORK_RULES[n].maxHashtags} hashtags.`).join('\n')}\n\nWrite these captions:\n${JSON.stringify(wanted.map((w) => {
    const post = posts.find((p) => p.id === w.postId) as CaptionPost;
    return { postId: w.postId, network: w.network, headline: post.headline, mainCaption: bodyOf(post.caption), facts: post.facts, ...(w.note ? { fixThis: w.note } : {}) };
  }), null, 2)}`;
  return chatJson({ ai, ...(fetchFn ? { fetchFn } : {}), system: SYSTEM, user, parse: (value) => parseDrafts(value, posts, networks) });
}

export async function writeNetworkCaptions(input: { ai: AiConfig; posts: readonly CaptionPost[]; networks: readonly Network[]; fetchFn?: typeof fetch }): Promise<{ variants: Record<string, PostVariants>; report: CaptionReport }> {
  const { ai, posts, fetchFn } = input;
  const networks = input.networks.filter((n) => n !== 'instagram');
  const variants: Record<string, PostVariants> = {};
  const report: CaptionReport = { requested: posts.length * input.networks.length, written: 0, retried: 0, fallback: [] };
  const ctaOf = (post: CaptionPost): string => closingLine(post.caption);
  // Instagram is the main caption as it stands.
  if (input.networks.includes('instagram')) for (const post of posts) { (variants[post.id] ??= {}).instagram = { caption: post.caption.trim(), hashtags: post.hashtags.slice(0, NETWORK_RULES.instagram.maxHashtags) }; report.written += 1; }
  let wanted = posts.flatMap((p) => networks.map((network) => ({ postId: p.id, network } as { postId: string; network: Network; note?: string })));
  const failed = new Map<string, string>();
  for (let attempt = 0; attempt < 2 && wanted.length > 0; attempt += 1) {
    const drafts = await ask(ai, posts, wanted, fetchFn);
    const next: typeof wanted = [];
    for (const w of wanted) {
      const post = posts.find((p) => p.id === w.postId) as CaptionPost;
      const draft = drafts.find((d) => d.postId === w.postId && d.network === w.network);
      const problem = draft ? problemWith(draft, post) : 'no caption was written';
      if (draft && !problem) {
        (variants[w.postId] ??= {})[w.network] = { caption: withCta(w.network, draft.caption, ctaOf(post)), hashtags: draft.hashtags };
        report.written += 1;
        failed.delete(`${w.postId}|${w.network}`);
      } else {
        failed.set(`${w.postId}|${w.network}`, problem ?? 'no caption was written');
        next.push({ ...w, note: problem ?? 'write this caption' });
      }
    }
    if (attempt === 0 && next.length > 0) report.retried = next.length;
    wanted = next;
  }
  // Whatever still fails is the main caption adapted to the network: marked, so the owner can see it and change it.
  for (const w of wanted) {
    const post = posts.find((p) => p.id === w.postId) as CaptionPost;
    const rules = NETWORK_RULES[w.network];
    const variant: PostVariant = { caption: withCta(w.network, bodyOf(post.caption), ctaOf(post)), hashtags: post.hashtags.slice(0, rules.maxHashtags), fallback: true };
    (variants[w.postId] ??= {})[w.network] = variant;
    report.fallback.push({ postId: w.postId, network: w.network, reason: failed.get(`${w.postId}|${w.network}`) ?? 'no caption was written' });
  }
  return { variants, report };
}
