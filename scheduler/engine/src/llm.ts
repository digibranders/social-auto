import { redact, textCandidates, type AiConfig, type TextCandidate } from './ai.ts';
import { costOf, RATES, type FallbackFrom } from './usage.ts';
import { BudgetError } from './paid-ledger.ts';

const REQUEST_TIMEOUT_MS = 180_000;

export class LlmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmError';
  }
}

export interface ChatJsonOptions<T> {
  ai: AiConfig;
  system: string;
  user: string;
  /** Validates and narrows the parsed JSON; throw to trigger a corrective retry. */
  parse: (value: unknown) => T;
  /** Pictures shown to the model with the user message, as data URLs. Only OpenAI is asked then: the backup provider's models are not trusted to see them. */
  images?: readonly string[];
  /** For tests: replaces the network call. */
  fetchFn?: typeof fetch;
}

type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
}

/** The most a text or vision call may cost: the longest answer allowed, and the question at three characters a token plus a flat share per picture. A model with no known price is counted at the dearest known rate. */
export function maxTextCallUsd(model: string, messages: readonly ChatMessage[]): number {
  const rate = RATES[model] ?? Object.values(RATES).reduce((dearest, r) => (r.out > dearest.out ? r : dearest));
  let chars = 0;
  let pictures = 0;
  for (const message of messages) {
    if (typeof message.content === 'string') chars += message.content.length;
    else for (const part of message.content) {
      if (part.type === 'text') chars += part.text.length;
      else pictures += 1;
    }
  }
  const inputTokens = Math.ceil(chars / 3) + pictures * 1_500;
  return Math.round(((inputTokens * rate.in + MAX_OUTPUT_TOKENS * rate.out) / 1_000_000) * 1e8) / 1e8;
}

const MAX_OUTPUT_TOKENS = 6_000;

async function complete(candidate: TextCandidate, messages: ChatMessage[], fetchFn: typeof fetch, ai: AiConfig, fallbackFrom?: FallbackFrom): Promise<string> {
  // Only OpenAI calls are paid for here; a backup provider is not on the ledger.
  const ledger = candidate.label === 'OpenAI' ? ai.ledger : undefined;
  const pictures = messages.some((m) => typeof m.content !== 'string' && m.content.some((p) => p.type === 'image_url'));
  const callId = ledger?.reserve({ operation: pictures ? 'vision' : 'text', model: candidate.model, ...(ai.usage.post !== null ? { postId: ai.usage.post } : {}), requestKey: JSON.stringify(messages), maxCostUsd: maxTextCallUsd(candidate.model, messages) });
  if (ledger && callId) ledger.markInFlight(callId);
  let response: Response;
  let text: string;
  try {
    response = await fetchFn(candidate.endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${candidate.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: candidate.model, messages, response_format: { type: 'json_object' } }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    text = await response.text();
  } catch (error) {
    // Sent, but no answer was read: it may have been accepted, so it is never sent again on its own.
    if (ledger && callId) ledger.markUnknown(callId, error instanceof Error ? error.message : String(error));
    throw error;
  }
  const who = `${candidate.label} ${candidate.model}`;
  if (!response.ok) {
    if (ledger && callId) ledger.fail(callId, `status ${response.status}`);
    throw new LlmError(`${who} returned ${response.status}: ${redact(text).slice(0, 300)}`);
  }
  const answer = JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
  if (ledger && callId) {
    const inputTokens = answer.usage?.prompt_tokens ?? 0;
    const outputTokens = answer.usage?.completion_tokens ?? 0;
    ledger.complete(callId, { actualCostUsd: costOf({ kind: 'text', model: candidate.model, inputTokens, outputTokens }), inputTokens, outputTokens });
  }
  const content = answer.choices?.[0]?.message?.content;
  if (!content) throw new LlmError(`${who} returned an empty response`);
  ai.usage.add({
    kind: 'text',
    model: candidate.label === 'OpenAI' ? candidate.model : `pollinations/${candidate.model}`,
    inputTokens: answer.usage?.prompt_tokens ?? 0,
    outputTokens: answer.usage?.completion_tokens ?? 0,
    ...(fallbackFrom ? { fallbackFrom } : {}),
  });
  if (fallbackFrom) ai.warn(`WARNING: ${fallbackFrom.requested} failed (${fallbackFrom.reason}); ${candidate.label} ${candidate.model} wrote this instead (AI_FALLBACK=on).`);
  return content;
}

function extractJson(content: string): unknown {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start === -1 || end <= start) throw new LlmError('response contained no JSON object');
  return JSON.parse(content.slice(start, end + 1)) as unknown;
}

/**
 * Asks for a JSON object and validates it. On invalid output the model gets one
 * corrective retry with the validation error; on API failure the next model (the backup provider) is tried.
 */
export async function chatJson<T>(options: ChatJsonOptions<T>): Promise<T> {
  const failures: string[] = [];
  const fetchFn = options.fetchFn ?? fetch;
  const images = options.images ?? [];
  const candidates = textCandidates(options.ai).filter((candidate) => images.length === 0 || candidate.label === 'OpenAI');
  const first = candidates[0];
  if (!first) throw new LlmError(images.length > 0 ? 'Reading pictures needs OpenAI, which is not configured' : 'No text model is configured');
  for (const candidate of candidates) {
    // A different provider than the one asked for: only reached when the main one failed and a backup is allowed.
    const standingIn = candidate.label !== first.label;
    const lastFailure = failures.at(-1);
    const messages: ChatMessage[] = [
      { role: 'system', content: options.system },
      { role: 'user', content: images.length === 0 ? options.user : [{ type: 'text', text: options.user }, ...images.map((url): ContentPart => ({ type: 'image_url', image_url: { url } }))] },
    ];
    for (let attempt = 0; attempt < 2; attempt++) {
      let content: string;
      try {
        content = await complete(candidate, messages, fetchFn, options.ai, standingIn ? { requested: `${first.label} ${first.model}`, reason: lastFailure ?? 'unknown' } : undefined);
      } catch (error) {
        // A spending refusal ends the call: no retry and no backup provider may be used to get around a cap.
        if (error instanceof BudgetError) throw error;
        failures.push(error instanceof Error ? error.message : String(error));
        break;
      }
      try {
        return options.parse(extractJson(content));
      } catch (error) {
        const problem = error instanceof Error ? error.message : String(error);
        failures.push(`${candidate.label} ${candidate.model}: ${problem}`);
        messages.push(
          { role: 'assistant', content },
          { role: 'user', content: `That JSON was invalid: ${problem}. Return the corrected full JSON object only.` },
        );
      }
    }
  }
  throw new LlmError(`No valid response. ${failures.join(' | ')}`);
}
