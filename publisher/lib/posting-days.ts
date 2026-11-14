/**
 * The days of the week a customer wants her posts on, for each channel (Instagram on Monday, Tuesday and Saturday, Facebook on Wednesday and Friday). It is a
 * setting of the workspace; it is applied when a batch of posts is written, so a week already written or drawn never moves.
 */
import { PLAN_PLATFORMS, type AddedClient, type ClientsFile } from './clients.js';
import { EditError } from './overrides.js';

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];
type Platform = (typeof PLAN_PLATFORMS)[number];
export type PostingDays = Partial<Record<Platform, Weekday[]>>;

const DAY_MS = 24 * 60 * 60 * 1000;

/** A list of day names (mon, tue, wed, thu, fri, sat, sun, any letter case, full names accepted) as the days in week order, each once. */
export function parseDays(raw: unknown): Weekday[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new EditError('days must be a list like ["mon", "wed", "fri"]', 400, 'INVALID_DAYS');
  const chosen = new Set<Weekday>();
  for (const item of raw) {
    const name = typeof item === 'string' ? item.trim().toLowerCase().slice(0, 3) : '';
    const day = WEEKDAYS.find((d) => d === name);
    if (!day) throw new EditError(`"${typeof item === 'string' ? item.slice(0, 20) : String(item)}" is not a day; use mon, tue, wed, thu, fri, sat or sun`, 400, 'INVALID_DAYS');
    chosen.add(day);
  }
  return WEEKDAYS.filter((d) => chosen.has(d));
}

/** The setting as sent: `{ instagram: ["mon", "tue"], facebook: ["wed"] }`. A channel that is not listed has no days of its own. */
export function parsePostingDays(raw: unknown): PostingDays {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new EditError('channels must be an object like {"instagram": ["mon", "wed"]}', 400, 'INVALID_REQUEST');
  const days: PostingDays = {};
  for (const [network, list] of Object.entries(raw)) {
    if (!(PLAN_PLATFORMS as readonly string[]).includes(network)) throw new EditError(`"${network.slice(0, 20)}" is not a channel; use ${PLAN_PLATFORMS.join(', ')}`, 400, 'INVALID_NETWORKS');
    days[network as Platform] = parseDays(list);
  }
  return days;
}

export const postingDaysOf = (client: AddedClient): PostingDays => client.postingDays ?? {};

/** The file with this workspace's days replaced by `days` (an empty setting removes it). Nothing else changes. */
export function setPostingDays(file: ClientsFile, brand: string, days: PostingDays): ClientsFile {
  if (!file.clients.some((c) => c.brand === brand)) throw new EditError('no such workspace', 404, 'WORKSPACE_NOT_FOUND');
  return {
    clients: file.clients.map((c) => {
      if (c.brand !== brand) return c;
      const { postingDays: _old, ...rest } = c;
      return Object.keys(days).length === 0 ? rest : { ...rest, postingDays: days };
    }),
  };
}

/** The dates (YYYY-MM-DD) of the week that starts on this Monday that fall on these days: what a batch starting that week would give for its first week. */
export function weekDatesFrom(days: readonly Weekday[], monday: string): string[] {
  const first = Date.parse(`${monday}T00:00:00Z`);
  return Array.from({ length: 7 }, (_, i) => new Date(first + i * DAY_MS).toISOString().slice(0, 10)).filter((date) => days.includes(WEEKDAYS[(new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7] as Weekday));
}
