/**
 * The errors of the product API (/api/v1). Every one answers `{ "error": "<a plain sentence>", "code": "<CODE>" }`: the sentence is for a person, the code is
 * fixed and is what a product matches on to show its own words. The list is documented in docs/product-api.md (a test keeps the two in step).
 *
 * Nothing that would only help a developer is ever sent: an unexpected failure answers INTERNAL with a generic sentence, and the real error is logged here.
 */
import { ActorError } from './actor.js';
import { EngineError } from './engine-client.js';
import { describeError, json } from './http.js';
import { EditError } from './overrides.js';

export const ERROR_CODES = [
  // The call itself
  'UNAUTHORIZED',
  'SERVICE_NOT_CONFIGURED',
  'STORAGE_NOT_SET_UP',
  'CONNECT_LINKS_NOT_SET_UP',
  'SERVICE_UNAVAILABLE',
  'INVALID_REQUEST',
  'REQUEST_TOO_LARGE',
  'INVALID_SITE',
  'SITE_MISMATCH',
  'INVALID_NETWORKS',
  'JOB_NOT_FOUND',
  'JOB_LIMIT_REACHED',
  'FACT_HELD',
  'BATCH_LOCKED',
  'WORDS_NOT_ACCEPTED',
  'NOTHING_KEPT',
  'POSTER_SUPERSEDED',
  'POSTER_BLOCKED',
  'POSTER_ALREADY_DECIDED',
  'INVALID_REASON',
  'DRAW_LIMIT_REACHED',
  'REDRAW_LIMIT_REACHED',
  'PICTURE_LIMIT_REACHED',
  'CAROUSEL_LIMIT_REACHED',
  'TOPIC_LIMIT_REACHED',
  'LINK_NOT_ALLOWED',
  'TEXT_REFUSED',
  'NETWORK_ALREADY_THERE',
  'BRAND_LIMIT_REACHED',
  'GROUP_MISMATCH',
  'INVALID_GROUP',
  'WORKSPACE_ARCHIVED',
  'ACTOR_REQUIRED',
  'INVALID_ACTOR',
  'ENGINE_UNAVAILABLE',
  // The workspace and its channels
  'INVALID_EXTERNAL_ID',
  'WORKSPACE_NOT_FOUND',
  'INVALID_CHANNEL',
  'RETURN_URL_NOT_REGISTERED',
  'INVALID_CHANNELS',
  'CHANNEL_NOT_CONNECTED',
  // Pictures
  'PICTURE_REQUIRED',
  'PICTURE_NOT_FOUND',
  'PICTURE_NOT_JPG',
  'PICTURE_TOO_SMALL',
  'PICTURE_NOT_SQUARE',
  'PICTURE_TOO_LARGE',
  // When a post goes out
  'INVALID_DAY',
  'INVALID_TIME',
  'DAY_PASSED',
  'TIME_PASSED',
  'TOO_FAR_AHEAD',
  // What a post says
  'CAPTION_REQUIRED',
  'CAPTION_TOO_LONG',
  'TOO_MANY_HASHTAGS',
  'INVALID_VARIANTS',
  // A post that exists, and where it stands
  'NOTHING_TO_CHANGE',
  'POST_NOT_FOUND',
  'POST_NOT_EDITABLE',
  'POST_ALREADY_SENT',
  'POST_SKIPPED',
  'PAUSED',
  // Limits and clashes
  'OVER_LIMIT',
  'NOT_FOUND',
  'CONFLICT',
  'INTERNAL',
  // Why a channel did not take a post (in `problems` of a send)
  'CHANNEL_UNREACHABLE',
  'RECONNECT_NEEDED',
  'CHANNEL_REFUSED',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** The code of an error that was raised without one, from its HTTP status. */
export function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case 400:
      return 'INVALID_REQUEST';
    case 401:
      return 'UNAUTHORIZED';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 413:
      return 'REQUEST_TOO_LARGE';
    case 503:
      return 'SERVICE_UNAVAILABLE';
    default:
      return 'INTERNAL';
  }
}

/** An error answer: a plain sentence and its code. */
export const apiError = (status: number, code: ErrorCode, message: string, extra: Record<string, string> = {}): Response => json(status, { error: message, code, ...extra });

/** The answer for something thrown while serving a call: a known error as it is, anything else as INTERNAL with a generic sentence. */
export function errorResponse(error: unknown, what: string): Response {
  if (error instanceof EditError) return apiError(error.status, error.code ?? codeForStatus(error.status), error.message);
  if (error instanceof ActorError) return apiError(error.status, error.code, error.message);
  if (error instanceof EngineError) return apiError(error.status, error.code, error.message, error.pictureLimit ? { channel: error.pictureLimit.channel, restart: error.pictureLimit.restart } : { ...(error.restart ? { restart: error.restart } : {}), ...(error.textReason ? { reason: error.textReason } : {}) });
  console.error(describeError(error));
  return apiError(500, 'INTERNAL', `could not ${what}`);
}

const RECONNECT = /has expired|withdrawn or expired|connect link again|connect \w+ again/i;
const UNREACHABLE = /fetch failed|econn|enotfound|eai_again|etimedout|timed out|timeout|aborted|socket hang up|network/i;

/**
 * Why a channel did not take a post, for a product: a code and a plain sentence about the account. The channel's own error text (which can carry
 * addresses and identifiers) is never passed on.
 */
export function channelProblem(account: string, rawError: string): { account: string; code: ErrorCode; error: string } {
  if (RECONNECT.test(rawError)) return { account, code: 'RECONNECT_NEEDED', error: `${account} needs to be connected again.` };
  if (UNREACHABLE.test(rawError)) return { account, code: 'CHANNEL_UNREACHABLE', error: `${account} could not be reached just now. It will be tried again.` };
  return { account, code: 'CHANNEL_REFUSED', error: `${account} did not accept the post.` };
}
