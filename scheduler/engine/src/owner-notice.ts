/**
 * A short message to the owner's phone through ntfy.sh, the same channel the publisher uses for its alerts (publisher/lib/notify.ts). The topic name is the
 * secret, so it comes from the environment (ALERT_NTFY_TOPIC) and is never written to a log. Sending never throws: a notice that cannot be sent must not
 * stop the work that raised it, and the caller is told whether it arrived so it can try again at its next run.
 */

const NTFY_BASE = 'https://ntfy.sh';
const MAX_MESSAGE_CHARS = 1_000;
const TIMEOUT_MS = 10_000;

export interface OwnerNotice {
  title: string;
  message: string;
  priority?: 'default' | 'high';
}

export type NoticeSender = (notice: OwnerNotice) => Promise<boolean>;

/** HTTP header values must be plain ASCII. */
const asciiHeader = (value: string): string => value.replace(/[^\x20-\x7E]/g, '?');

/** A sender bound to the environment's topic. Without a topic it sends nothing and says so, once per call. */
export function ntfySender(env: Record<string, string | undefined> = process.env, fetchImpl: typeof fetch = fetch): NoticeSender {
  return async (notice) => {
    const topic = env['ALERT_NTFY_TOPIC'];
    if (!topic) return false;
    try {
      const response = await fetchImpl(`${NTFY_BASE}/${encodeURIComponent(topic)}`, {
        method: 'POST',
        headers: { Title: asciiHeader(notice.title), Priority: notice.priority ?? 'default', Tags: 'warning' },
        body: notice.message.slice(0, MAX_MESSAGE_CHARS),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      return response.ok;
    } catch {
      return false;
    }
  };
}
