/**
 * What became of the topics a customer asked for in her own words: one line per ask, newest first, with where it stands and what it would cost to draw.
 *
 * A topic is written as a batch of its own (one post, its own plan file), so it is kept, edited and drawn on its own: drawing it never locks the week's other posts, and
 * a week already drawn never locks it. The state is worked out here from the job that wrote it, the written batch and the draw jobs; nothing is stored twice.
 */
import { CopyStage, weekOfPost, type CopyBatch, type CopyPost } from './copy-stage.ts';
import type { Job } from './job-store.ts';
import type { Network } from './networks.ts';
import { isNetwork } from './networks.ts';
import { mondayOf } from './picture-limit.ts';

export type TopicState = 'writing' | 'waiting_for_words' | 'drawing' | 'drawn' | 'not_made';
/** Why a topic was not made, as a fixed code the product turns into its own words. */
export type TopicReason = 'NOT_WRITTEN' | 'TEXT_REFUSED' | 'DROPPED' | 'PUT_AWAY' | 'WEEK_PASSED' | 'DRAW_FAILED' | 'NO_PICTURE_ROOM' | 'NO_PICTURE' | 'HEADLINE_TOO_WEAK' | 'FACT_OUT_OF_DATE';

export interface TopicRequestView {
  /** The statement the post was written from. */
  id: string;
  /** The job that writes it. */
  jobId: string;
  week: { from: string; to: string };
  /** The day (YYYY-MM-DD) and time (HH:MM), India time, the post goes out. */
  goesOutOn: string;
  goesOutAt: string;
  state: TopicState;
  reason?: TopicReason;
  createdAt: string;
  /** Once written: the batch and post to keep, edit and draw through the written-posts calls, and the words. */
  batchId?: string;
  postId?: string;
  words?: { headline: string; captions: Record<string, string> };
  /** The pictures drawing it would make now (one for each connected channel it is written for), so the cost is known before she confirms. Zero once drawn. */
  picturesToDraw: number;
}

export const LIST_LIMIT = 10;
const DEFAULT_TIME = '10:00';
const DAY_MS = 86_400_000;

const sundayOf = (monday: string): string => new Date(Date.parse(`${monday}T00:00:00Z`) + 6 * DAY_MS).toISOString().slice(0, 10);

/** A failed writing: a text the checks turned back is told apart from one that simply did not come out. */
function failedReason(job: Job): TopicReason {
  const code = job.error?.code ?? '';
  return /CONCEPT|CLAIM|FACT/.test(code) ? 'TEXT_REFUSED' : 'NOT_WRITTEN';
}

export interface TopicRequestInput {
  brandDir: string;
  brand: string;
  /** Every job of the brand. */
  jobs: readonly Job[];
  /** The pictures already made for a plan (`<postId>|<network>`). */
  made: (planFile: string) => ReadonlySet<string>;
  /** The connected networks, or null when they are not known. */
  connected: ReadonlySet<Network> | null;
}

function viewOf(job: Job, input: TopicRequestInput): TopicRequestView | null {
  if (job.kind !== 'topic' || typeof job.topicId !== 'string' || typeof job.startDate !== 'string') return null;
  const from = mondayOf(job.startDate);
  const base = { id: job.topicId, jobId: job.id, week: { from, to: sundayOf(from) }, goesOutOn: job.startDate, goesOutAt: job.time ?? DEFAULT_TIME, createdAt: job.createdAt, picturesToDraw: 0 };
  if (job.state === 'queued' || job.state === 'running') return { ...base, state: 'writing' };
  if (job.state === 'failed') return { ...base, state: 'not_made', reason: failedReason(job) };
  const planFile = job.planFileMade;
  let batch: CopyBatch;
  try {
    if (planFile === undefined) throw new Error('no batch');
    batch = new CopyStage(input.brandDir, input.brand).get(planFile);
  } catch {
    return { ...base, state: 'not_made', reason: 'NOT_WRITTEN' };
  }
  const post: CopyPost | undefined = batch.posts[0];
  if (post === undefined) return { ...base, state: 'not_made', reason: 'NOT_WRITTEN' };
  const day = post.date ?? job.startDate;
  const week = weekOfPost(post) ?? from;
  const written = {
    ...base,
    goesOutOn: day,
    week: { from: week, to: sundayOf(week) },
    batchId: batch.planFile,
    postId: post.postId,
    words: { headline: post.headline.replaceAll('|', ''), captions: Object.fromEntries(Object.entries(post.captions ?? {}).map(([network, c]) => [network, c.text])) },
  };
  if (batch.closedAt) return { ...written, state: 'not_made', reason: 'PUT_AWAY' };
  if (post.state === 'dropped') return { ...written, state: 'not_made', reason: 'DROPPED' };
  if (batch.weekLapsed?.[week] !== undefined) return { ...written, state: 'not_made', reason: 'WEEK_PASSED' };
  const draws = input.jobs.filter((j) => j.kind === 'draw' && j.planFile === batch.planFile);
  if (draws.some((j) => j.state === 'queued' || j.state === 'running')) return { ...written, state: 'drawing' };
  const noPicture = batch.notDrawn?.[post.postId];
  if (noPicture !== undefined) {
    const code = noPicture.code === 'PICTURE_LIMIT_REACHED' ? 'NO_PICTURE_ROOM' : noPicture.code;
    return { ...written, state: 'not_made', reason: code as TopicReason };
  }
  const made = input.made(batch.planFile);
  // Pictures exist: it is drawn, whatever the week's record says (a draw that failed early and was retried leaves the week unmarked).
  if ([...made].some((key) => key.startsWith(`${post.postId}|`))) return { ...written, state: 'drawn' };
  // The week was sent to be drawn and nothing was made.
  if (batch.weekDrawn?.[week] !== undefined || batch.drawnAt !== undefined || post.drawnAt !== undefined) return { ...written, state: 'not_made', reason: 'DRAW_FAILED' };
  // Waiting for her: the words are ready to confirm. What drawing would cost is one picture for each connected channel it is written for.
  const wanted = Object.keys(post.captions ?? {}).filter((n) => isNetwork(n) && (input.connected === null || input.connected.has(n)) && !made.has(`${post.postId}|${n}`)).length;
  return { ...written, state: 'waiting_for_words', picturesToDraw: wanted };
}

/** The topics this brand's customer asked for, newest first, at most the last ten. */
export function topicRequests(input: TopicRequestInput): TopicRequestView[] {
  return input.jobs
    .filter((j) => j.kind === 'topic')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, LIST_LIMIT)
    .flatMap((job) => {
      const view = viewOf(job, input);
      return view ? [view] : [];
    });
}
