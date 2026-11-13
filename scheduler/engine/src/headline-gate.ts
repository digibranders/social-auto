/**
 * The editorial gate before any picture is bought. A headline can be true and still be worth nothing: "Services for businesses of all sizes" states a fact
 * and tells a reader nothing; "Unique website, made together" reads like copy nobody would write. One model request judges the whole batch (a few hundred
 * tokens), and code decides: a post whose headline gives the reader nothing specific, or does not read as natural copy on its own, is dropped before a
 * picture is paid for, and the batch is smaller rather than padded. The judge reads only the headline and the fact it was written from; it does not
 * choose headlines, rewrite them or add claims. The verdict is model-assisted editorial evidence, never proof, and both thresholds are settings.
 */
import type { AiConfig } from './ai.ts';
import { chatJson } from './llm.ts';

export interface HeadlineItem {
  id: string;
  headline: string;
  /** The verified fact the post is about. */
  fact: string;
}

export interface HeadlineScore {
  id: string;
  /** 0 the reader learns nothing from the headline, 1 something general, 2 something specific and useful. */
  informative: number;
  /** 0 reads like machine or filler copy, 1 acceptable, 2 reads like natural copy that stands on its own. */
  natural: number;
  reason: string;
}

export interface HeadlineGateConfig {
  /** Both scores together must reach this, and neither may be 0. */
  minTotal: number;
}

export const defaultHeadlineGate: HeadlineGateConfig = { minTotal: 3 };

const SYSTEM = `You are a strict advertising editor. For each item you get a poster headline and the fact it was written from. Judge only the headline as a stranger would meet it in a social feed, without the fact beside it.
informative (0 to 2): what does a reader learn from the headline alone? 0 nothing: filler, a vague promise, or a list of nouns ("services for businesses of all sizes", "everything you need"). 1 something true but general. 2 something specific and useful: a concrete capability, number, condition or answer.
natural (0 to 2): does it read like copy a person would write? 0 stilted, awkward or ungrammatical ("unique website, made together"), 1 acceptable, 2 natural and clear on its own.
Do not judge whether it is true, do not rewrite it, do not suggest other headlines, and do not penalise a question headline that sets up a specific answer. Give one short reason. Return JSON only: {"scores":[{"id":"...","informative":0,"natural":0,"reason":"..."}]}`;

function parseScores(value: unknown, ids: readonly string[]): HeadlineScore[] {
  const list = (value as { scores?: unknown }).scores;
  if (!Array.isArray(list)) throw new Error('"scores" must be a list');
  const scores = list.flatMap((entry): HeadlineScore[] => {
    const e = entry as { id?: unknown; informative?: unknown; natural?: unknown; reason?: unknown };
    const ok = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 2;
    return typeof e.id === 'string' && ids.includes(e.id) && ok(e.informative) && ok(e.natural)
      ? [{ id: e.id, informative: e.informative, natural: e.natural, reason: typeof e.reason === 'string' ? e.reason.trim().slice(0, 200) : '' }]
      : [];
  });
  const missing = ids.filter((id) => !scores.some((s) => s.id === id));
  if (missing.length > 0) throw new Error(`no score was given for ${missing.join(', ')}`);
  return scores;
}

/** One request for the whole batch. */
export async function scoreHeadlines(ai: AiConfig, items: readonly HeadlineItem[], fetchFn?: typeof fetch): Promise<HeadlineScore[]> {
  if (items.length === 0) return [];
  const ids = items.map((i) => i.id);
  return chatJson({
    ai,
    ...(fetchFn ? { fetchFn } : {}),
    system: SYSTEM,
    user: `Items:\n${JSON.stringify(items.map((i) => ({ id: i.id, headline: i.headline, fact: i.fact })), null, 2)}`,
    parse: (value) => parseScores(value, ids),
  });
}

export interface HeadlineVerdict {
  id: string;
  keep: boolean;
  score: HeadlineScore;
  /** Why it is dropped, when it is. */
  reason?: string;
}

/** The decision, in code: both scores must be at least 1 and together reach the threshold. */
export function judgeHeadlines(scores: readonly HeadlineScore[], config: HeadlineGateConfig = defaultHeadlineGate): HeadlineVerdict[] {
  return scores.map((score): HeadlineVerdict => {
    const keep = score.informative >= 1 && score.natural >= 1 && score.informative + score.natural >= config.minTotal;
    const why = score.informative < 1 ? 'it tells the reader nothing specific' : score.natural < 1 ? 'it does not read as natural copy' : 'it is too weak to be worth a picture';
    return { id: score.id, keep, score, ...(keep ? {} : { reason: `weak headline: ${why}${score.reason ? ` (${score.reason})` : ''}` }) };
  });
}

/** Settings: HEADLINE_GATE_ENABLED=false switches the gate off; HEADLINE_GATE_MIN_TOTAL (1 to 4) sets the threshold. */
export function headlineGateFromEnv(env: Readonly<Record<string, string | undefined>>): { enabled: boolean; config: HeadlineGateConfig } {
  const raw = env['HEADLINE_GATE_MIN_TOTAL'];
  const minTotal = raw === undefined || raw === '' ? defaultHeadlineGate.minTotal : Number(raw);
  if (!Number.isInteger(minTotal) || minTotal < 1 || minTotal > 4) throw new Error('HEADLINE_GATE_MIN_TOTAL must be a whole number from 1 to 4');
  return { enabled: env['HEADLINE_GATE_ENABLED'] !== 'false', config: { minTotal } };
}
