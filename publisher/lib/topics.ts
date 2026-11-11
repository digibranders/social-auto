/**
 * The customer's topics: each written-and-drawn post idea, with the networks it already has and the connected networks it lacks, so a product can offer
 * "add Facebook to this topic". Pure: built from what the posters, the waiting written batches and her connected accounts already say.
 */
import type { BatchView, PosterView } from './engine-client.js';

export const NETWORKS = ['instagram', 'facebook', 'linkedin', 'google'] as const;
export type Network = (typeof NETWORKS)[number];
const isNetwork = (value: string): value is Network => (NETWORKS as readonly string[]).includes(value);

export interface TopicNetwork {
  network: string;
  /** "written" for words that are not drawn yet; otherwise the status of the newest picture of that network. */
  status: string;
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

export function topicsOf(posters: readonly PosterView[], batches: readonly BatchView[], connected: readonly string[]): Topic[] {
  const topics = new Map<string, Topic>();
  const topic = (batchId: string, postId: string, headline: string): Topic => {
    const key = `${batchId}|${postId}`;
    const found = topics.get(key);
    if (found) return found;
    const made: Topic = { batchId, postId, headline, networks: [], missing: [] };
    topics.set(key, made);
    return made;
  };
  // Written words that are still waiting: every network they were written for.
  for (const batch of batches) {
    for (const post of batch.posts) {
      const t = topic(batch.id, post.id, post.headline);
      for (const network of Object.keys(post.captions)) if (!t.networks.some((n) => n.network === network)) t.networks.push({ network, status: 'written' });
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
    if (existing) existing.status = p.status;
    else t.networks.push({ network: p.network, status: p.status });
  }
  const wanted = [...new Set(connected)].filter(isNetwork);
  for (const t of topics.values()) {
    t.networks.sort((a, b) => NETWORKS.indexOf(a.network as Network) - NETWORKS.indexOf(b.network as Network));
    const alive = t.networks.some((n) => livePictures(n.status));
    t.missing = alive ? wanted.filter((w) => !t.networks.some((n) => n.network === w)) : [];
  }
  return [...topics.values()].sort((a, b) => a.batchId.localeCompare(b.batchId) || a.postId.localeCompare(b.postId));
}
