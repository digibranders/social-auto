/**
 * A topic in the customer's own words: she writes what this week's extra post is about (an offer, a new dish, an event) and gets one post for one day. Her words are kept as
 * she typed them and are never called verified: the post may only say what she wrote, and a figure or date she did not write is turned back. It is written as a batch of its own (one
 * post), so she confirms the written words first, then asks for its pictures, with the written-posts calls (`/api/v1/batches`, using `batchId` and `postId` below). Drawing it never
 * locks the week's other posts, and a week she already drew never locks it.
 *
 * POST /api/v1/topic-requests   {"externalId", "text", "week"?: "2026-11-23"}   asks for the post; 202 {"request"} (200 when the same words were already asked for the same week).
 *                               `text` is 10 to 1000 characters, trimmed, no links. `week` is a Monday: the post goes out on its first day she can still use (tomorrow or later, India time);
 *                               without it, the week of tomorrow. Written for her connected channels only. One topic a week: `429 TOPIC_LIMIT_REACHED` with `restart` (the Monday she can ask again).
 *                               A text that cannot be used answers 400 `LINK_NOT_ALLOWED`, or `TEXT_REFUSED` with `reason` (`TOO_SHORT`, `TOO_LONG`, `NEEDS_PROOF`, `NOT_TEXT`).
 * GET  /api/v1/topic-requests?externalId=...[&id=...]   {"requests": [...]} newest first, the last ten; with `id`, {"request"}.
 *
 * A request: {id, week: {from, to}, goesOutOn, goesOutAt, state, reason?, createdAt, batchId?, postId?, words?: {headline, captions: {<network>: text}}, picturesToDraw}.
 * `state`: `writing`, `waiting_for_words` (the words are ready for her to read, edit and keep), `drawing`, `drawn` (its pictures wait for her approval like any other) or `not_made`
 * (`reason`: NOT_WRITTEN, TEXT_REFUSED, DROPPED, PUT_AWAY, WEEK_PASSED, DRAW_FAILED, NO_PICTURE_ROOM, NO_PICTURE, HEADLINE_TOO_WEAK, FACT_OUT_OF_DATE). `picturesToDraw` is how many
 * pictures drawing it would make now (one for each connected channel it is written for; they count against each channel's weekly pictures), so the cost is known before she confirms.
 */
import { actorOf, engineActor } from '../../lib/actor.js';
import { apiError, errorResponse } from '../../lib/api-error.js';
import { channelsFor } from '../../lib/channels.js';
import { syncConnected } from '../../lib/connected-sync.js';
import { json } from '../../lib/http.js';
import { archivedAnswer, engineFor, workspaceFor } from '../../lib/product-workspace.js';
import type { TopicRequestView } from '../../lib/engine-client.js';
import { loadChannels } from '../../lib/store.js';

const MAX_BODY_BYTES = 8 * 1024;
const NETWORKS = ['instagram', 'facebook', 'linkedin', 'google'] as const;
type Network = (typeof NETWORKS)[number];
const isNetwork = (value: unknown): value is Network => typeof value === 'string' && (NETWORKS as readonly string[]).includes(value);
const TOPIC_ID = /^t-[A-Za-z0-9-]{1,40}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const IST_OFFSET_MS = 5.5 * 3_600_000;

/** What a product is shown of a request: without the id of the job behind it. */
const shown = ({ jobId: _job, ...rest }: TopicRequestView): Omit<TopicRequestView, 'jobId'> => rest;

/** A day in India time, `ahead` days from now. */
const istDay = (now: number, ahead: number): string => new Date(now + IST_OFFSET_MS + ahead * DAY_MS).toISOString().slice(0, 10);
const isMonday = (day: string): boolean => DAY.test(day) && new Date(`${day}T00:00:00Z`).getUTCDay() === 1 && new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;

/**
 * The day the post goes out: the first day of the week asked for that is tomorrow or later (India time), or tomorrow when no week is asked for.
 * Null when the week is over (its last day is before tomorrow).
 */
export function topicDay(week: string | undefined, now: number): string | null {
  const tomorrow = istDay(now, 1);
  if (week === undefined) return tomorrow;
  const last = new Date(Date.parse(`${week}T00:00:00Z`) + 6 * DAY_MS).toISOString().slice(0, 10);
  if (last < tomorrow) return null;
  return week > tomorrow ? week : tomorrow;
}

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const found = await workspaceFor(request, params.get('externalId'));
  if (found instanceof Response) return found;
  try {
    const engine = engineFor(found.product.id, found.workspace.brand);
    if (engine instanceof Response) return engine;
    const by = engineActor(found.product.id, request.headers.has('x-social-actor') ? actorOf(request) : null);
    const requests = await engine.listTopicRequests(by);
    const id = params.get('id');
    if (id === null) return json(200, { requests: requests.map(shown) });
    if (!TOPIC_ID.test(id)) return apiError(400, 'INVALID_REQUEST', 'id is not a topic request');
    const one = requests.find((r) => r.id === id);
    return one ? json(200, { request: shown(one) }) : apiError(404, 'NOT_FOUND', 'no such topic request');
  } catch (error) {
    return errorResponse(error, 'read the topic requests');
  }
}

export async function POST(request: Request): Promise<Response> {
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return apiError(413, 'REQUEST_TOO_LARGE', 'request too large');
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (typeof body !== 'object' || body === null) return apiError(400, 'INVALID_REQUEST', 'send JSON');
  const found = await workspaceFor(request, body['externalId']);
  if (found instanceof Response) return found;
  const { workspace } = found;
  const away = archivedAnswer(workspace);
  if (away) return away;
  const weekAsked = body['week'];
  if (weekAsked !== undefined && (typeof weekAsked !== 'string' || !isMonday(weekAsked))) return apiError(400, 'INVALID_REQUEST', 'week must be a Monday like 2026-11-23');
  const day = topicDay(weekAsked as string | undefined, Date.now());
  if (day === null) return apiError(400, 'DAY_PASSED', 'that week is over: choose this week or a later one');

  try {
    const engine = engineFor(found.product.id, workspace.brand);
    if (engine instanceof Response) return engine;
    const by = engineActor(found.product.id, request.headers.has('x-social-actor') ? actorOf(request) : null);
    // The post takes its look from the customer's website, so it must have been read.
    if (workspace.website === undefined) return apiError(409, 'CONFLICT', 'read the customer\'s website first (start a batch), so the post can use its look');
    const { file: channels } = await loadChannels();
    const networks = [...new Set(channelsFor(channels, workspace.brand).map((c) => c.platform))].filter(isNetwork);
    if (networks.length === 0) return apiError(400, 'CHANNEL_NOT_CONNECTED', 'connect at least one account first');
    // The poster service is told which networks are connected before anything is written.
    await syncConnected(engine, workspace.brand, by);
    const made = await engine.startTopic({ site: workspace.website, networks, text: body['text'], startDate: day, actor: by });
    const listed = await engine.listTopicRequests(by);
    const view = listed.find((r) => r.jobId === made.job.id);
    if (!view) return apiError(503, 'ENGINE_UNAVAILABLE', 'the poster service is not available just now. Try again shortly.');
    return json(made.created ? 202 : 200, { request: shown(view) });
  } catch (error) {
    return errorResponse(error, 'add the topic');
  }
}
