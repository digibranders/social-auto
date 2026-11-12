/**
 * The customer's topics: each written-and-drawn post idea, with the networks it already has and the connected networks it lacks, so a product can offer
 * "add Facebook to this topic". Pure: built from what the posters, the waiting written batches and her connected accounts already say.
 */
import type { BatchView, PosterView } from './engine-client.js';

export const NETWORKS = ['instagram', 'facebook', 'linkedin', 'google'] as const;
export type Network = (typeof NETWORKS)[number];
const isNetwork = (value: string): value is Network => (NETWORKS as readonly string[]).includes(value);

/** What a channel's picture of a topic is doing, in a fixed vocabulary for a screen to show. */
export type PictureState = 'ready' | 'approved' | 'rejected' | 'blocked' | 'held' | 'expired' | 'needs_connection' | 'drawing' | 'limit_reached' | 'not_drawn' | 'waiting';

export interface TopicNetwork {
  network: string;
  /** "written" for words that are not drawn yet; otherwise the status of the newest picture of that network. */
  status: string;
  /**
   * What this channel's picture is doing: `ready` (waiting for her decision), `approved`, `rejected`, `blocked`, `held`, `expired`; or, with no picture yet:
   * `needs_connection` (the account is not connected, so nothing is drawn for it), `drawing` (its week is being drawn), `limit_reached` (no pictures left this week for
   * the channel), `not_drawn` (its week was drawn and this topic got none; see `notDrawn`), or `waiting` (its week is not drawn yet; `drawsOn` says when, when the system draws it).
   */
  pictureState: PictureState;
  /** For `waiting` in a week the system draws by itself: the day it is drawn (YYYY-MM-DD, India time). */
  drawsOn?: string;
  /** For `not_drawn`: the fixed code and the sentence to show. */
  notDrawn?: { code: string; message: string };
}

export interface Topic {
  batchId: string;
  postId: string;
  headline: string;
  networks: TopicNetwork[];
  /** Connected networks this topic does not have yet. Empty for a topic that was put away (expired) or taken back everywhere. */
  missing: Network[];
}

/** A network counts as "there" for any picture except one put away unanswered; a taken-back or sent-back picture is still her decision about that network. */
const livePictures = (status: string): boolean => status !== 'expired';

const STATE_OF_STATUS: Record<string, PictureState> = { pending: 'ready', approved: 'approved', rejected: 'rejected', blocked: 'blocked', held: 'held', expired: 'expired', superseded: 'rejected' };

/** The day the system draws a week by itself: the Thursday before its Monday (YYYY-MM-DD). */
const drawsOnFor = (monday: string): string => new Date(Date.parse(`${monday}T00:00:00Z`) - 4 * 86_400_000).toISOString().slice(0, 10);

export function topicsOf(posters: readonly PosterView[], batches: readonly BatchView[], connected: readonly string[], extras: { limits?: ReadonlyArray<{ network: string; left: number }> | null } = {}): Topic[] {
  const topics = new Map<string, Topic>();
  const topic = (batchId: string, postId: string, headline: string): Topic => {
    const key = `${batchId}|${postId}`;
    const found = topics.get(key);
    if (found) return found;
    const made: Topic = { batchId, postId, headline, networks: [], missing: [] };
    topics.set(key, made);
    return made;
  };
  const wantedNow = new Set(connected.filter(isNetwork));
  const leftFor = new Map((extras.limits ?? []).map((l) => [l.network, l.left]));
  /** What the words of a post, with no picture yet, are waiting for in one network. */
  const stateOfWords = (batch: BatchView, post: BatchView['posts'][number], network: string): PictureState => {
    if (!wantedNow.has(network as Network)) return 'needs_connection';
    if (post.notDrawn) return 'not_drawn';
    const week = batch.weeks?.find((w) => w.postIds.includes(post.id));
    if (week?.state === 'drawing') return 'drawing';
    if (leftFor.get(network) === 0) return 'limit_reached';
    return 'waiting';
  };
  // Written words that are still waiting: every network they were written for.
  for (const batch of batches) {
    for (const post of batch.posts) {
      const t = topic(batch.id, post.id, post.headline);
      for (const network of Object.keys(post.captions)) if (!t.networks.some((n) => n.network === network)) t.networks.push({ network, status: 'written', pictureState: stateOfWords(batch, post, network) });
    }
  }
  for (const batch of batches) {
    for (const post of batch.posts) {
      const t = topics.get(`${batch.id}|${post.id}`);
      const weekIndex = batch.weeks?.findIndex((w) => w.postIds.includes(post.id)) ?? -1;
      for (const n of t?.networks ?? []) {
        if (n.pictureState === 'waiting' && weekIndex > 0) n.drawsOn = drawsOnFor((batch.weeks as NonNullable<BatchView['weeks']>)[weekIndex]?.from as string);
        if (n.pictureState === 'not_drawn' && post.notDrawn) n.notDrawn = { code: post.notDrawn.code, message: post.notDrawn.message };
      }
    }
  }
  // Pictures: the newest of each network (older versions are history).
  const newest = new Map<string, PosterView>();
  for (const p of posters) {
    const key = `${p.batchId}|${p.postId}|${p.network}`;
    const seen = newest.get(key);
    if (!seen || p.versionNumber > seen.versionNumber) newest.set(key, p);
  }
  for (const p of newest.values()) {
    const t = topic(p.batchId, p.postId, p.headline);
    const existing = t.networks.find((n) => n.network === p.network);
    const state = STATE_OF_STATUS[p.status] ?? 'ready';
    if (existing) {
      existing.status = p.status;
      existing.pictureState = state;
      delete existing.drawsOn;
      delete existing.notDrawn;
    } else t.networks.push({ network: p.network, status: p.status, pictureState: state });
  }
  const wanted = [...new Set(connected)].filter(isNetwork);
  for (const t of topics.values()) {
    t.networks.sort((a, b) => NETWORKS.indexOf(a.network as Network) - NETWORKS.indexOf(b.network as Network));
    const alive = t.networks.some((n) => livePictures(n.status));
    t.missing = alive ? wanted.filter((w) => !t.networks.some((n) => n.network === w)) : [];
  }
  return [...topics.values()].sort((a, b) => a.batchId.localeCompare(b.batchId) || a.postId.localeCompare(b.postId));
}
