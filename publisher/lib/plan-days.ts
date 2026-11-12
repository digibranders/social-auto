/** Days of a customer's plan, in India time. */

/** The next Monday after today, India time (YYYY-MM-DD): tomorrow at the earliest. */
export function nextMonday(now: number): string {
  const india = new Date(now + 5.5 * 3_600_000);
  const ahead = ((8 - india.getUTCDay()) % 7) || 7;
  return new Date(Date.UTC(india.getUTCFullYear(), india.getUTCMonth(), india.getUTCDate() + ahead)).toISOString().slice(0, 10);
}

