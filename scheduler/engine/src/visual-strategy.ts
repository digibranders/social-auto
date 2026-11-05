/**
 * Whether a post may have an AI picture at all. A picture is paid for and can mislead, so it is allowed only when the accepted concept names a
 * concrete subject and a depictable action, and the subject has something to do with what the post says: at least one of its content words
 * (stemmed) is also in the post's own copy or concept. This is a cheap deterministic guard, not a judgement of relevance: it stops the clearly
 * unrelated picture (a clock for a post about routing buyers) and sends such posts to a typography-led or structured treatment with no
 * image call. The planner wrote the concept fields, so they are never proof; a missing or vague concept is simply not eligible.
 */
import type { Concept } from './concepts.ts';
import { normalizeForQuote } from './claims.ts';

export interface PictureGate { eligible: boolean; reasons: string[] }

export interface GateConfig {
  /** Words that name no concrete thing. */
  vagueWords: readonly string[];
  stopWords: readonly string[];
  minWordLength: number;
  /**
   * Requires the picture's words to appear in what the post says. A cheap guard for when no model judges the picture idea; it rejects every
   * metaphor, because a good metaphor is not named in the headline, so a model judge replaces it when one is available.
   */
  requireWordOverlap: boolean;
}

export const defaultGateConfig: GateConfig = {
  vagueWords: ['concept', 'idea', 'abstract', 'metaphor', 'symbol', 'feeling', 'essence', 'something', 'thing', 'object'],
  stopWords: ['the', 'and', 'for', 'with', 'your', 'that', 'this', 'from', 'into', 'over', 'then', 'them', 'their', 'while', 'about', 'a', 'an', 'of', 'in', 'on', 'to', 'is', 'are', 'it', 'its', 'one', 'close', 'slowly', 'gently'],
  minWordLength: 4,
  requireWordOverlap: true,
};

const stemOf = (word: string): string => (word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word).slice(0, 5);

function stems(text: string, config: GateConfig): Set<string> {
  const stop = new Set(config.stopWords);
  return new Set(normalizeForQuote(text.replaceAll('|', '')).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= config.minWordLength && !stop.has(w)).map(stemOf));
}

export function pictureEligibility(post: { headline: string; subline: string; caption?: string; concept?: Pick<Concept, 'subject' | 'angle' | 'message' | 'visualSubject' | 'visualAction'> }, options: Partial<GateConfig> = {}): PictureGate {
  const config = { ...defaultGateConfig, ...options };
  const concept = post.concept;
  if (!concept) return { eligible: false, reasons: ['the post has no accepted concept, so no picture subject is known'] };
  const subject = concept.visualSubject.trim();
  const action = concept.visualAction.trim();
  if (subject === '' || action === '') return { eligible: false, reasons: ['the concept names no picture subject and action'] };
  const vague = new Set(config.vagueWords);
  const subjectWords = [...stems(subject, { ...config, minWordLength: 3 })];
  const concrete = normalizeForQuote(subject).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !vague.has(w));
  if (concrete.length === 0) return { eligible: false, reasons: [`the picture subject "${subject}" names nothing concrete`] };
  if (!config.requireWordOverlap) return { eligible: true, reasons: [] };
  const message = stems([post.headline, post.subline, post.caption ?? '', concept.subject, concept.angle, concept.message].join(' '), config);
  const picture = new Set([...subjectWords, ...stems(action, config)]);
  const shared = [...picture].filter((s) => message.has(s));
  if (shared.length === 0) return { eligible: false, reasons: [`nothing in the picture ("${subject}", "${action}") is mentioned in what the post says`] };
  return { eligible: true, reasons: [] };
}

export interface PictureCheckInput {
  id: string;
  headline: string;
  subline: string;
  concept?: Pick<Concept, 'visualSubject' | 'visualAction' | 'moveId' | 'visualRelationship'>;
}

type JudgeFn = (items: Array<{ key: string; claim: string; quote: string; context: string }>) => Promise<Array<{ key: string; answer: 'supported' | 'unsupported' | 'unclear'; reason?: string }>>;

/**
 * Asks an injected judge, once for the whole batch and before any picture is paid for, whether each post's picture idea, drawn literally,
 * explains the post's message. Only "unsupported" (unrelated, a loosely related symbol, or misleading) takes the picture away from that post, which then
 * goes to a picture-free treatment; "unclear" and a judge that fails leave it, because an optional check must not turn every feed into plain type.
 * Posts already without a picture are not asked about.
 */
export async function judgePictures<T extends { picture?: { eligible: boolean; reasons: readonly string[] } }>(posts: readonly PictureCheckInput[], facts: readonly T[], judge: JudgeFn): Promise<T[]> {
  const asked = posts.flatMap((post, i) => (post.concept && facts[i]?.picture?.eligible !== false ? [{ post, i }] : []));
  if (asked.length === 0) return [...facts];
  const answers = new Map<string, { answer: string; reason?: string }>();
  let failure: string | undefined;
  try {
    const items = asked.map(({ post }) => ({ key: post.id, claim: `${post.headline.replaceAll('|', '')}\n${post.subline}`, quote: `Picture: ${post.concept?.visualSubject}; ${post.concept?.visualAction}${post.concept?.visualRelationship ? `. It must visibly show: ${post.concept.visualRelationship}` : ''}`, context: post.concept?.moveId ? `poster message and picture idea; creative move: ${post.concept.moveId}` : 'poster message and picture idea' }));
    for (const v of await judge(items)) answers.set(v.key, { answer: v.answer, ...(v.reason ? { reason: v.reason } : {}) });
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  return facts.map((fact, i) => {
    const hit = asked.find((a) => a.i === i);
    if (!hit || failure !== undefined) return fact;
    const verdict = answers.get(hit.post.id);
    if (verdict?.answer !== 'unsupported') return fact;
    return { ...fact, picture: { eligible: false, reasons: [`a model judged the picture idea does not suit the message${verdict.reason ? `: ${verdict.reason}` : ''}`] } };
  });
}
