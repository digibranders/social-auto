/**
 * The facts found on a customer's website, which every written post must agree with. The customer confirms the ones that are right and removes the ones
 * that are wrong (or puts one back).
 *
 * GET  /api/v1/facts?externalId=...   {"builtAt", "profile", "facts": [{"id", "text", "sourceUrl", "sourceQuote", "state", "held"}], "counts"}
 * POST /api/v1/facts   {"externalId", "factId", "action": "confirm" | "remove" | "restore"}   answers the facts as they are now
 *
 * `X-Social-Actor` names the customer's person and is required to decide; a held fact cannot be confirmed (409 FACT_HELD).
 */
import { actorOf, engineActor } from '../../lib/actor.js';
import { apiError, errorResponse } from '../../lib/api-error.js';
import { EngineError } from '../../lib/engine-client.js';
import { json } from '../../lib/http.js';
import { engineFor, workspaceFor } from '../../lib/product-workspace.js';

const MAX_BODY_BYTES = 2 * 1024;
const ACTIONS = ['confirm', 'remove', 'restore'] as const;
type Action = (typeof ACTIONS)[number];
const isAction = (value: unknown): value is Action => typeof value === 'string' && (ACTIONS as readonly string[]).includes(value);

const noFacts = (): Response => apiError(404, 'NOT_FOUND', 'no facts have been read for this customer yet');

export async function GET(request: Request): Promise<Response> {
  const found = await workspaceFor(request, new URL(request.url).searchParams.get('externalId'));
  if (found instanceof Response) return found;
  try {
    const engine = engineFor(found.product.id, found.workspace.brand);
    if (engine instanceof Response) return engine;
    const by = engineActor(found.product.id, request.headers.has('x-social-actor') ? actorOf(request) : null);
    return json(200, { ...(await engine.getFacts(by)) });
  } catch (error) {
    if (error instanceof EngineError && error.status === 404) return noFacts();
    return errorResponse(error, 'read the facts');
  }
}

export async function POST(request: Request): Promise<Response> {
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return apiError(413, 'REQUEST_TOO_LARGE', 'request too large');
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (typeof body !== 'object' || body === null) return apiError(400, 'INVALID_REQUEST', 'send JSON');
  const found = await workspaceFor(request, body['externalId']);
  if (found instanceof Response) return found;
  if (!isAction(body['action'])) return apiError(400, 'INVALID_REQUEST', `action must be one of: ${ACTIONS.join(', ')}`);
  if (typeof body['factId'] !== 'string') return apiError(400, 'INVALID_REQUEST', 'factId is required');
  try {
    const engine = engineFor(found.product.id, found.workspace.brand);
    if (engine instanceof Response) return engine;
    const by = engineActor(found.product.id, actorOf(request));
    return json(200, { ...(await engine.decideFact(body['factId'], body['action'], by)) });
  } catch (error) {
    if (error instanceof EngineError && error.status === 404) return apiError(404, 'NOT_FOUND', 'no such fact for this customer');
    return errorResponse(error, 'change the fact');
  }
}
