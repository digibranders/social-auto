/**
 * What happens in the publisher when a customer takes back a picture that has already been released into the schedule.
 *
 * The engine puts an approved picture into the publisher's schedule as a planned post named `<workspace brand>-<post id>`, and its next release pass removes
 * the post again when nothing is approved. Until that pass runs the post could still go out, so the publisher stops it at once with a skip that is marked as
 * the customer's. Approving again undoes that skip; a skip made by the team (the emergency stop) is never undone by a customer.
 */
import { crosspostStatusFor } from './crosspost.js';
import type { ChannelFile, PostedLog } from './channels.js';
import { EditError, type OverrideMap } from './overrides.js';
import { loadOverrides, saveOverrides } from './store.js';
import { parseSchedule, type ScheduledPost } from './schedule.js';
import { scheduleData } from './schedule-source.js';

/** Where the released posts are read from; tests put their own in. */
export const releasedSchedule = { read: (): ScheduledPost[] => parseSchedule(scheduleData) };

export const plannedIdOf = (brand: string, postId: string): string => `${brand}-${postId}`;

export const releasedPostOf = (brand: string, postId: string): ScheduledPost | null => releasedSchedule.read().find((p) => p.id === plannedIdOf(brand, postId)) ?? null;

/** Whether the post has already gone out: on the given network when one is named, on any channel otherwise. */
export function hasGoneOut(post: ScheduledPost, channels: ChannelFile, log: PostedLog, now: number, network?: string): boolean {
  return crosspostStatusFor(post, channels, log, now).some((s) => s.state === 'published' && (network === undefined || s.platform === network));
}

/** The words the schedule will send to a network for a released post: that network's own version, else the main words (Instagram's). */
export function wordsSentTo(post: ScheduledPost, network: string): string {
  return network === 'instagram' ? post.caption : (post.variants?.[network as 'linkedin']?.caption ?? post.caption);
}

/**
 * Whether the release pass has caught up with what the customer approved: every approved picture's words are what the schedule will send. Until it has, a
 * post the customer stopped must stay stopped, or it could go out with the old words.
 */
export function releaseMatches(post: ScheduledPost, approved: ReadonlyArray<{ network: string; caption: string }>): boolean {
  return approved.length > 0 && approved.every((p) => wordsSentTo(post, p.network).trim() === p.caption.trim());
}

/** The overrides with the post skipped for the customer. A post the team already skipped stays the team's. */
export function withCustomerSkip(overrides: OverrideMap, id: string, now: number): OverrideMap {
  const current = overrides[id];
  if (current?.skipped === true) return overrides;
  return { ...overrides, [id]: { ...current, skipped: true, skippedBy: 'customer', updatedAt: new Date(now).toISOString() } };
}

/** The overrides with the customer's skip taken away (and the entry dropped when nothing else is left in it). Anything else is left as it is. */
export function withoutCustomerSkip(overrides: OverrideMap, id: string, now: number): OverrideMap {
  const current = overrides[id];
  if (current?.skippedBy !== 'customer') return overrides;
  const next = { ...current, updatedAt: new Date(now).toISOString() };
  delete next.skipped;
  delete next.skippedBy;
  const rest = { ...overrides };
  if (next.caption !== undefined || next.imageKey !== undefined || next.variants !== undefined || next.date !== undefined) rest[id] = next;
  else delete rest[id];
  return rest;
}

async function changeOverrides(update: (overrides: OverrideMap) => OverrideMap): Promise<boolean> {
  for (let attempt = 1; ; attempt += 1) {
    const { overrides, etag } = await loadOverrides();
    const next = update(overrides);
    if (next === overrides) return false;
    try {
      await saveOverrides(next, etag);
      return true;
    } catch (error) {
      if (!(error instanceof EditError && error.status === 409) || attempt >= 4) throw error;
    }
  }
}

/** Stops a released post for the customer. Answers whether anything was changed. */
export const skipForCustomer = (id: string, now: number): Promise<boolean> => changeOverrides((o) => withCustomerSkip(o, id, now));

/** Lets a released post go ahead again after the customer approved again. Answers whether anything was changed. */
export const unskipForCustomer = (id: string, now: number): Promise<boolean> => changeOverrides((o) => withoutCustomerSkip(o, id, now));
