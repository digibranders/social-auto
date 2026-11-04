const TIMEOUT_MS = 25_000;

export interface PublisherAnswer {
  status: number;
  body: Record<string, unknown> | null;
}

/**
 * Asks the publisher about a Google sign-in that is waiting for a location to be chosen: "locations" lists the choices,
 * "save" stores the chosen one. The sealed token goes only to the publisher; the browser never reads it.
 */
export async function askPublisher(action: 'locations' | 'save', payload: Record<string, unknown>): Promise<PublisherAnswer> {
  const target = process.env['EDIT_URL'];
  const secret = process.env['EDIT_SECRET'];
  if (!target || !secret) return { status: 503, body: { error: 'Editing is not configured' } };
  const response = await fetch(new URL(`/api/google-connect?action=${action}`, target), {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return { status: response.status, body: (await response.json().catch(() => null)) as Record<string, unknown> | null };
}

export interface LocationChoice {
  id: string;
  title: string;
}

/** The choices in a "locations" answer, or null when it is not that shape. */
export function parseChoices(body: Record<string, unknown> | null): LocationChoice[] | null {
  const list = body?.['locations'];
  if (!Array.isArray(list)) return null;
  const found: LocationChoice[] = [];
  for (const item of list) {
    const { id, title } = (item ?? {}) as { id?: unknown; title?: unknown };
    if (typeof id !== 'string' || !/^\d{1,25}$/.test(id) || typeof title !== 'string') return null;
    found.push({ id, title });
  }
  return found;
}
