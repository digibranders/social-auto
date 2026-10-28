const CHAT_ENDPOINT = 'https://gen.pollinations.ai/v1/chat/completions';
const REQUEST_TIMEOUT_MS = 180_000;
export const DEFAULT_TEXT_MODELS = ['openai/gpt-6-luna', 'deepseek/deepseek-v4-flash'] as const;

export class LlmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmError';
  }
}

export interface ChatJsonOptions<T> {
  apiKey: string;
  system: string;
  user: string;
  /** Validates and narrows the parsed JSON; throw to trigger a corrective retry. */
  parse: (value: unknown) => T;
  models?: readonly string[];
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

async function complete(apiKey: string, model: string, messages: ChatMessage[]): Promise<string> {
  const response = await fetch(CHAT_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, response_format: { type: 'json_object' } }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) throw new LlmError(`${model} returned ${response.status}: ${text.slice(0, 300)}`);
  const content = (JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message
    ?.content;
  if (!content) throw new LlmError(`${model} returned an empty response`);
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
 * corrective retry with the validation error; on API failure the next model is tried.
 */
export async function chatJson<T>(options: ChatJsonOptions<T>): Promise<T> {
  const failures: string[] = [];
  for (const model of options.models ?? DEFAULT_TEXT_MODELS) {
    const messages: ChatMessage[] = [
      { role: 'system', content: options.system },
      { role: 'user', content: options.user },
    ];
    for (let attempt = 0; attempt < 2; attempt++) {
      let content: string;
      try {
        content = await complete(options.apiKey, model, messages);
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
        break;
      }
      try {
        return options.parse(extractJson(content));
      } catch (error) {
        const problem = error instanceof Error ? error.message : String(error);
        failures.push(`${model}: ${problem}`);
        messages.push(
          { role: 'assistant', content },
          { role: 'user', content: `That JSON was invalid: ${problem}. Return the corrected full JSON object only.` },
        );
      }
    }
  }
  throw new LlmError(`No valid response. ${failures.join(' | ')}`);
}
