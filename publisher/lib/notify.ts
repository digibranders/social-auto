/**
 * Push alerts through ntfy.sh. The topic name acts as the secret: only people who know it can
 * read the alerts, so it is kept in an environment variable. Alert text must never contain
 * tokens or other secrets.
 */

const NTFY_BASE = 'https://ntfy.sh';
const MAX_MESSAGE_CHARS = 1_000;
const REQUEST_TIMEOUT_MS = 10_000;

export interface Alert {
  title: string;
  message: string;
  priority?: 'default' | 'high';
  /** ntfy emoji tag, e.g. "warning" or "rotating_light". */
  tags?: string;
}

/** HTTP header values must be plain ASCII. */
export function asciiHeader(value: string): string {
  return value.replace(/[^\x20-\x7E]/g, '?');
}

/** Sends an alert. Never throws and returns whether it was delivered, so alerting cannot break posting. */
export async function notify(alert: Alert, topic = process.env['ALERT_NTFY_TOPIC']): Promise<boolean> {
  if (!topic) {
    console.warn(`ALERT_NTFY_TOPIC is not set; alert not sent: ${alert.title}`);
    return false;
  }
  try {
    const response = await fetch(`${NTFY_BASE}/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers: {
        Title: asciiHeader(alert.title),
        Priority: alert.priority ?? 'default',
        Tags: asciiHeader(alert.tags ?? 'warning'),
      },
      body: alert.message.slice(0, MAX_MESSAGE_CHARS),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) console.warn(`ntfy returned ${response.status}; alert not delivered: ${alert.title}`);
    return response.ok;
  } catch (error) {
    console.warn(`Could not send alert "${alert.title}": ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
