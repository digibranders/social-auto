/**
 * The judge behind the semantic copy check: one model request per batch of posts, asking whether each post's copy says more than the source
 * facts it was written from. Cheap (a few hundred tokens per post) and optional; the answer is model-assisted evidence, never proof.
 */
import type { AiConfig } from './ai.ts';
import { chatJson } from './llm.ts';
import type { Judge, JudgeItem, JudgeVerdict } from './semantic-verifier.ts';

const SYSTEM = `You check marketing copy against the exact source text it must stay within.
For each item, answer "supported" only if everything the copy asserts is stated or directly implied by the source. Answer "unsupported" if the copy claims more than the source says: stronger or broader scope ("every", "always", "automatically", "all plans"), a condition left out, a capability the source does not state, a result presented as a promise, or a different meaning. Answer "unclear" if you cannot tell.
Do not judge style, tone or whether the copy is persuasive. A call to action that invites the reader to visit, try, see, book or contact the business, and hashtags, are not claims: ignore them. Return JSON only: {"verdicts":[{"key":"...","answer":"supported|unsupported|unclear","reason":"empty if supported; otherwise start with one code (unsupported_capability, unsupported_scope, unsupported_outcome, unsupported_condition, missing_context) then one short line quoting the words of the copy that go beyond the source"}]}`;

export function modelJudge(ai: AiConfig, fetchFn?: typeof fetch): Judge {
  return async (items: JudgeItem[]): Promise<JudgeVerdict[]> => {
    const user = `Items:\n${JSON.stringify(items.map((i) => ({ key: i.key, copy: i.claim, source: i.quote, context: i.context })), null, 2)}`;
    return chatJson({
      ai,
      ...(fetchFn ? { fetchFn } : {}),
      system: SYSTEM,
      user,
      parse: (value) => {
        const verdicts = (value as { verdicts?: unknown }).verdicts;
        if (!Array.isArray(verdicts)) throw new Error('"verdicts" must be a list');
        return verdicts.flatMap((v) => {
          const r = v as { key?: unknown; answer?: unknown; reason?: unknown };
          return typeof r.key === 'string' && (r.answer === 'supported' || r.answer === 'unsupported' || r.answer === 'unclear') ? [{ key: r.key, answer: r.answer, ...(typeof r.reason === 'string' && r.reason.trim() ? { reason: r.reason.trim().slice(0, 300) } : {}) }] : [];
        });
      },
    });
  };
}


const PICTURE_SYSTEM = `You check whether a picture idea suits a poster's message when drawn literally.
For each item, "copy" is the poster's headline and subline and "source" describes the picture (its subject and what happens). Answer "supported" when the picture is a reasonable, concrete illustration of the message's own subject, even a simple one (a calendar for a trial, a document for docs, an envelope or arrow for something being sent). Answer "unsupported" only when the picture shows a different idea from the message, is a loosely related object or metaphor that stands for something the message does not say (for example a maze, key, bridge, clock or compass used as a symbol), or could mislead. Answer "unclear" if you cannot tell. Do not judge beauty or originality. Return JSON only: {"verdicts":[{"key":"...","answer":"supported|unsupported|unclear","reason":"one short line"}]}`;

/** The judge behind the pre-spend picture check: one request for the batch, asking whether each picture idea explains its post's message. */
export function modelPictureJudge(ai: AiConfig, fetchFn?: typeof fetch): Judge {
  return async (items: JudgeItem[]): Promise<JudgeVerdict[]> => {
    const user = `Items:\n${JSON.stringify(items.map((i) => ({ key: i.key, copy: i.claim, source: i.quote })), null, 2)}`;
    return chatJson({
      ai,
      ...(fetchFn ? { fetchFn } : {}),
      system: PICTURE_SYSTEM,
      user,
      parse: (value) => {
        const verdicts = (value as { verdicts?: unknown }).verdicts;
        if (!Array.isArray(verdicts)) throw new Error('"verdicts" must be a list');
        return verdicts.flatMap((v) => {
          const r = v as { key?: unknown; answer?: unknown; reason?: unknown };
          return typeof r.key === 'string' && (r.answer === 'supported' || r.answer === 'unsupported' || r.answer === 'unclear') ? [{ key: r.key, answer: r.answer, ...(typeof r.reason === 'string' && r.reason.trim() ? { reason: r.reason.trim().slice(0, 200) } : {}) }] : [];
        });
      },
    });
  };
}
