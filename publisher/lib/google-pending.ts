import { decrypt, encrypt } from './crypto.js';

/**
 * A Google sign-in that found several business locations waits for the person to choose one. What waits is
 * the refresh token, sealed with the channel key together with the client and an end time, so the dashboard
 * (and the browser) can carry it without ever being able to read it, and it cannot be reused later or for
 * another client.
 */
export const PENDING_TTL_MS = 15 * 60 * 1000;

interface Pending {
  t: string;
  b: string;
  e: number;
}

export function sealPending(refreshToken: string, brand: string, key: Buffer, now: number): string {
  const pending: Pending = { t: refreshToken, b: brand, e: now + PENDING_TTL_MS };
  return encrypt(JSON.stringify(pending), key);
}

/** The refresh token inside, or an error saying why it cannot be used. */
export function openPending(sealed: string, brand: string, key: Buffer, now: number): string {
  let pending: Partial<Pending>;
  try {
    pending = JSON.parse(decrypt(sealed, key)) as Partial<Pending>;
  } catch {
    throw new Error('the waiting connection is not valid. Connect Google again.');
  }
  if (typeof pending.t !== 'string' || typeof pending.b !== 'string' || typeof pending.e !== 'number') throw new Error('the waiting connection is not valid. Connect Google again.');
  if (pending.b !== brand) throw new Error('the waiting connection belongs to another client. Connect Google again.');
  if (pending.e <= now) throw new Error('the waiting connection has expired. Connect Google again.');
  return pending.t;
}
