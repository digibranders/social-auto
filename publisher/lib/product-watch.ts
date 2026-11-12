/**
 * Noticing what the AI side has finished for a product's customers, and telling the product:
 *   job.finished  a batch of written posts or a draw ended (done or failed)
 *   poster.ready  a picture is waiting for the customer's decision
 *   poster.expiring / poster.expired  a waiting picture or written batch will be put away in 2 days / was put away because nobody decided in 14 days
 * The engine does not call us, so the cron asks it (as the product's own service actor). What was already announced is kept in the event log, so each
 * thing is announced once, and a failed look at one customer never stops the others.
 */
import { engineActor } from './actor.js';
import { releaseMatches, releasedPostOf, unskipForCustomer } from './customer-skip.js';
import { channelsFor, type ChannelFile, type PostedLog } from './channels.js';
import type { ClientsFile } from './clients.js';
import { engineFromEnv, EXPIRY_DAYS, WorkspaceEngine, type BatchView, type EngineConfig, type ExpiredView, type PosterView } from './engine-client.js';
import { describeError } from './http.js';
import { publishEvents } from './events.js';
import { findMissed, MISSED_REPORT_HOURS } from './missed.js';
import { goneAims } from './post-view.js';
import { isAnnounced, type Outbox } from './outbox.js';
import { brandIsPaused, type PauseFile } from './pauses.js';
import { dueWindowFor, type ScheduledPost } from './schedule.js';
import type { Product } from './products.js';
import { loadChannels, loadClients, loadOutbox, loadOverrides, loadPauses, loadPosted, storeConfigured } from './store.js';
import { eventsForHeld, eventsForMissed, newEvent, type Addressed } from './webhooks.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** How long before a waiting picture or batch is put away the customer is warned. */
export const WARN_DAYS_BEFORE = 2;

export interface Expiring {
  kind: 'batch' | 'poster';
  batchId: string;
  postId?: string;
  network?: string;
  posterId?: string;
  expiresAt: string;
}

/** What will be put away within the warning time: waiting pictures and unfinished written batches, by when they were made. */
export function expiringSoon(posters: readonly PosterView[], batches: readonly BatchView[], now: number): Expiring[] {
  const soon = (createdAt: string): string | null => {
    const at = Date.parse(createdAt) + EXPIRY_DAYS * DAY_MS;
    return Number.isNaN(at) || at <= now || at - now > WARN_DAYS_BEFORE * DAY_MS ? null : new Date(at).toISOString();
  };
  return [
    ...posters.flatMap((p): Expiring[] => {
      const expiresAt = p.status === 'pending' ? soon(p.createdAt) : null;
      return expiresAt ? [{ kind: 'poster', batchId: p.batchId, postId: p.postId, network: p.network, posterId: p.id, expiresAt }] : [];
    }),
    ...batches.flatMap((b): Expiring[] => {
      const expiresAt = soon(b.createdAt);
      return expiresAt ? [{ kind: 'batch', batchId: b.id, expiresAt }] : [];
    }),
  ];
}

/** What there is to announce for one customer, given what was announced before. Pure: the engine calls are made by the caller. */
export function eventsForProgress(
  owner: { product: string; externalId: string },
  progress: { jobs: ReadonlyArray<{ id: string; kind: string; state: string; batchId?: string; week?: string }>; posters: ReadonlyArray<{ id: string; batchId: string; postId: string; network: string }>; expiring?: readonly Expiring[]; expired?: readonly ExpiredView[] },
  outbox: Pick<Outbox, 'announced'>,
  now: number,
): { items: Addressed[]; announced: string[] } {
  const items: Addressed[] = [];
  const announced: string[] = [];
  for (const job of progress.jobs) {
    // A week of a batch is being drawn: told once, when the draw is first seen waiting or running.
    const drawing = `week-drawing:${job.id}`;
    if (job.kind === 'draw' && job.week && job.batchId && (job.state === 'queued' || job.state === 'running' || job.state === 'done' || job.state === 'failed') && !isAnnounced(outbox, drawing) && !announced.includes(drawing)) {
      announced.push(drawing);
      items.push({ product: owner.product, event: newEvent('week.drawing', { externalId: owner.externalId, batchId: job.batchId, week: job.week, jobId: job.id }, now) });
    }
    const key = `job:${job.id}`;
    if ((job.state !== 'done' && job.state !== 'failed') || isAnnounced(outbox, key)) continue;
    announced.push(key);
    if (job.kind === 'draw' && job.week && job.batchId && job.state === 'done') items.push({ product: owner.product, event: newEvent('week.drawn', { externalId: owner.externalId, batchId: job.batchId, week: job.week, jobId: job.id }, now) });
    items.push({ product: owner.product, event: newEvent('job.finished', { externalId: owner.externalId, jobId: job.id, kind: job.kind, state: job.state, ...(job.batchId ? { batchId: job.batchId } : {}) }, now) });
  }
  for (const poster of progress.posters) {
    const key = `poster:${poster.id}`;
    if (isAnnounced(outbox, key)) continue;
    announced.push(key);
    items.push({ product: owner.product, event: newEvent('poster.ready', { externalId: owner.externalId, posterId: poster.id, batchId: poster.batchId, postId: poster.postId, network: poster.network }, now) });
  }
  for (const e of progress.expiring ?? []) {
    const key = `expiring:${e.kind}:${e.posterId ?? e.batchId}`;
    if (isAnnounced(outbox, key)) continue;
    announced.push(key);
    items.push({ product: owner.product, event: newEvent('poster.expiring', { externalId: owner.externalId, ...place(e), expiresAt: e.expiresAt }, now) });
  }
  for (const e of progress.expired ?? []) {
    const key = `expired:${e.kind}:${e.posterId ?? `${e.batchId}${e.week ? `:${e.week}` : ''}`}:${e.at}`;
    if (isAnnounced(outbox, key)) continue;
    announced.push(key);
    if (e.kind === 'week') {
      if (e.week) items.push({ product: owner.product, event: newEvent('week.lapsed', { externalId: owner.externalId, batchId: e.batchId, week: e.week, lapsedAt: e.at }, now) });
      continue;
    }
    items.push({ product: owner.product, event: newEvent('poster.expired', { externalId: owner.externalId, ...place(e), expiredAt: e.at }, now) });
  }
  return { items, announced };
}

const place = (e: { kind: string; batchId: string; postId?: string; network?: string; posterId?: string }): Record<string, unknown> => ({
  kind: e.kind,
  batchId: e.batchId,
  ...(e.postId ? { postId: e.postId } : {}),
  ...(e.network ? { network: e.network } : {}),
  ...(e.posterId ? { posterId: e.posterId } : {}),
});

/**
 * Lets go ahead a post the customer stopped (withdrew or changed the words of) and approved again, once the release pass has put what she approved into the
 * schedule. Approving normally does this at once when the schedule is already right; this catches the rest at the next run.
 */
export async function reconcileCustomerSkips(brand: string, engine: Pick<WorkspaceEngine, 'listPosters'>, by: string, now: number): Promise<number> {
  const { overrides } = await loadOverrides();
  const stopped = Object.entries(overrides).filter(([id, o]) => o.skippedBy === 'customer' && id.startsWith(`${brand}-`)).map(([id]) => id.slice(brand.length + 1));
  if (stopped.length === 0) return 0;
  const approved = await engine.listPosters('approved', by);
  let lifted = 0;
  for (const postId of stopped) {
    const released = releasedPostOf(brand, postId);
    const mine = approved.filter((p) => p.postId === postId);
    if (released && releaseMatches(released, mine) && (await unskipForCustomer(`${brand}-${postId}`, now))) lifted += 1;
  }
  return lifted;
}

/** The customers of products that have used the AI side (they have a website saved). */
const watched = (clients: ClientsFile, products: readonly Product[]): Array<{ brand: string; product: string; externalId: string }> =>
  clients.clients.flatMap((c) => (c.product && c.externalId && c.website && products.some((p) => p.id === c.product) ? [{ brand: c.brand, product: c.product, externalId: c.externalId }] : []));

/** Looks at every watched customer and announces what is new. Never throws. */
export async function announceEngineProgress(products: readonly Product[], now: number = Date.now(), config: EngineConfig | null = engineFromEnv(), send: typeof fetch = fetch): Promise<void> {
  if (!config || !storeConfigured() || products.length === 0) return;
  try {
    const { file } = await loadClients();
    const { outbox } = await loadOutbox();
    const items: Addressed[] = [];
    const announced: string[] = [];
    for (const owner of watched(file, products)) {
      if (config.productSecrets[owner.product] === undefined) continue;
      try {
        const engine = new WorkspaceEngine(config, owner.product, owner.brand);
        const by = engineActor(owner.product, null);
        const [jobs, posters, batches, expired] = await Promise.all([
          engine.listJobs(by),
          engine.listPosters('pending', by),
          engine.listBatches(by),
          engine.listExpired(new Date(now - (EXPIRY_DAYS + 1) * DAY_MS).toISOString(), by),
        ]);
        await reconcileCustomerSkips(owner.brand, engine, by, now);
        const found = eventsForProgress(owner, { jobs, posters, expiring: expiringSoon(posters, batches.batches, now), expired }, { announced: [...outbox.announced, ...announced] }, now);
        items.push(...found.items);
        announced.push(...found.announced);
      } catch (error) {
        console.error(`watching ${owner.brand}: ${describeError(error)}`);
      }
    }
    await publishEvents(items, products, { now, send, announced });
  } catch (error) {
    console.error(describeError(error));
  }
}

/**
 * Posts of a product's customers that went wrong, for the product to hear about once each:
 *   post.held    the post is due, but an account it was aimed at is no longer connected, so it waits (it goes out if the account is connected again in time)
 *   post.missed  the post's time window passed without it going out on a connected account
 * Pure: the caller sends them and writes down the keys.
 */
export function problemEvents(
  posts: readonly ScheduledPost[],
  channels: ChannelFile,
  log: PostedLog,
  pauses: PauseFile,
  clients: ClientsFile,
  outbox: Pick<Outbox, 'announced'>,
  now: number,
): { items: Addressed[]; announced: string[] } {
  const owned = (brand: string): boolean => clients.clients.some((c) => c.brand === brand && c.product !== undefined);
  const missed = findMissed(posts, channels, log, pauses, now).filter((m) => owned(m.brand) && !isAnnounced(outbox, `missed:${m.key}`));
  const held = posts.flatMap((post) => {
    const at = Date.parse(post.date);
    const brand = post.brand ?? 'default';
    if (!owned(brand) || post.skipped === true || at > now || now - at >= dueWindowFor(post) || brandIsPaused(pauses, brand)) return [];
    const ours = channelsFor(channels, brand);
    return goneAims(post, new Set(ours.map((c) => c.id)), new Set<string>(ours.map((c) => c.platform)))
      .filter((id) => !isAnnounced(outbox, `held:${post.id}|${id}`))
      .map((channelId) => ({ brand, postId: post.id, channelId, platform: channelId.includes(':') ? channelId.slice(0, channelId.indexOf(':')) : channelId, date: post.date }));
  });
  // A post held for an account that was never connected again is missed once its window has passed.
  const heldTooLong = posts.flatMap((post) => {
    const at = Date.parse(post.date);
    const brand = post.brand ?? 'default';
    if (!owned(brand) || post.skipped === true || now - at < dueWindowFor(post) || now - at >= MISSED_REPORT_HOURS * 3_600_000 || brandIsPaused(pauses, brand)) return [];
    const ours = channelsFor(channels, brand);
    return goneAims(post, new Set(ours.map((c) => c.id)), new Set<string>(ours.map((c) => c.platform)))
      .filter((id) => !isAnnounced(outbox, `missed:${post.id}|${id}`))
      .map((channelId) => ({ key: `${post.id}|${channelId}`, brand, postId: post.id, channelId, account: channelId, date: post.date }));
  });
  return {
    items: [...eventsForMissed([...missed, ...heldTooLong], clients, now), ...eventsForHeld(held, clients, now)],
    announced: [...missed.map((m) => `missed:${m.key}`), ...heldTooLong.map((m) => `missed:${m.key}`), ...held.map((h) => `held:${h.postId}|${h.channelId}`)],
  };
}

/** Looks at every post and tells the products what went wrong with their customers'. Never throws. */
export async function announcePostProblems(posts: readonly ScheduledPost[], products: readonly Product[], now: number = Date.now(), send: typeof fetch = fetch): Promise<void> {
  if (!storeConfigured() || products.length === 0) return;
  try {
    const [{ file: clients }, { file: channels }, { log }, { file: pauses }, { outbox }] = await Promise.all([loadClients(), loadChannels(), loadPosted(), loadPauses(), loadOutbox()]);
    const found = problemEvents(posts, channels, log, pauses, clients, outbox, now);
    await publishEvents(found.items, products, { now, send, announced: found.announced });
  } catch (error) {
    console.error(describeError(error));
  }
}
