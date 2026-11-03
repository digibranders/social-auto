import { redact, textCandidates, type AiConfig, type TextCandidate } from './ai.ts';

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
  /** For tests: replaces the network call. */
  fetchFn?: typeof fetch;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

async function complete(candidate: TextCandidate, messages: ChatMessage[], fetchFn: typeof fetch, ai: AiConfig): Promise<string> {
  const response = await fetchFn(candidate.endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${candidate.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: candidate.model, messages, response_format: { type: 'json_object' } }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  const who = `${candidate.label} ${candidate.model}`;
  if (!response.ok) throw new LlmError(`${who} returned ${response.status}: ${redact(text).slice(0, 300)}`);
  const answer = JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
  const content = answer.choices?.[0]?.message?.content;
  if (!content) throw new LlmError(`${who} returned an empty response`);
  ai.usage.add({
    kind: 'text',
    model: candidate.label === 'OpenAI' ? candidate.model : `pollinations/${candidate.model}`,
    inputTokens: answer.usage?.prompt_tokens ?? 0,
    outputTokens: answer.usage?.completion_tokens ?? 0,
  });
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
  for (const candidate of textCandidates(options.ai)) {
    const messages: ChatMessage[] = [
      { role: 'system', content: options.system },
      { role: 'user', content: options.user },
    ];
    for (let attempt = 0; attempt < 2; attempt++) {
      let content: string;
      try {
        content = await complete(candidate, messages, fetchFn, options.ai);
      } catch (error) {
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
