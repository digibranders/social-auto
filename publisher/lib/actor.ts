/**
 * Who is behind a call. The product knows the signed-in person on its own server and sends their id in `X-Social-Actor` on every call that decides
 * something (approve, reject, keep, drop, edit, facts). social-auto cannot check who that person is, only record what the product vouches for: the engine
 * keeps `<product id>:<person>` (the X-Actor it is sent) as the name of whoever decided, so every decision can be traced to a product and a person.
 */
import { createHash } from 'node:crypto';
import type { ErrorCode } from './api-error.js';

export const ACTOR_HEADER = 'X-Social-Actor';
const ACTOR = /^[A-Za-z0-9_.:-]{1,64}$/;
/** The longest X-Actor the engine accepts. */
const MAX_REVIEWER_NAME = 80;

export class ActorError extends Error {
  readonly status = 400;
  readonly code: ErrorCode;
  constructor(code: 'ACTOR_REQUIRED' | 'INVALID_ACTOR', message: string) {
    super(message);
    this.name = 'ActorError';
    this.code = code;
  }
}

/** The person named by the call, or an ActorError saying the header is missing or not a plain id of 1 to 64 letters, digits or . _ : - */
export function actorOf(request: Request): string {
  const given = request.headers.get(ACTOR_HEADER)?.trim() ?? '';
  if (given === '') throw new ActorError('ACTOR_REQUIRED', `${ACTOR_HEADER} is required: send the id of the person who is doing this`);
  if (!ACTOR.test(given)) throw new ActorError('INVALID_ACTOR', `${ACTOR_HEADER} must be 1 to 64 letters, digits or . _ : -`);
  return given;
}

/** The X-Actor for a call: the person's, or `<product id>:service` when the product named nobody. */
export function engineActor(productId: string, actor: string | null): string {
  return actor === null ? `${productId}:service` : reviewerName(productId, actor);
}

/**
 * The X-Actor sent to the engine for a decision: `<product id>:<person>`. A long id is shortened with a hash of the whole id (only characters the engine
 * accepts), so two long ids that begin alike stay different and the name never runs over what the engine keeps.
 */
export function reviewerName(productId: string, actor: string): string {
  const prefix = `${productId}:`;
  if (prefix.length + actor.length <= MAX_REVIEWER_NAME) return `${prefix}${actor}`;
  const room = MAX_REVIEWER_NAME - prefix.length - 9;
  return `${prefix}${actor.slice(0, room)}-${createHash('sha256').update(actor).digest('hex').slice(0, 8)}`;
}
