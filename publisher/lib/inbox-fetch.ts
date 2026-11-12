/**
 * Reads the comments on our posts and posts our replies. Reading is a GET; replying is the one thing here that writes to a network, and it is done only when
 * a person asks (never by a timer).
 *
 * A refusal for a missing permission is a `needs` for the caller to show ("connect the account again"), not a crash.
 */
import { graph, type Refusal } from './analytics-fetch.js';
import type { IncomingComment } from './inbox.js';

const INSTAGRAM_GRAPH = `${process.env['INSTAGRAM_GRAPH_URL'] ?? 'https://graph.instagram.com'}/v23.0`;
const FACEBOOK_GRAPH = process.env['FACEBOOK_GRAPH_URL'] ?? 'https://graph.facebook.com/v23.0';

type Fetch = typeof fetch;
type Json = Record<string, unknown>;

export interface CommentsReading {
  comments: IncomingComment[];
  /** The account has not given us the permission to read comments. */
  needs: 'reconnect' | null;
}

export class InboxWriteError extends Error {
  /** `permission`: the network refused for a missing permission (the account must be connected again); `failed`: anything else. */
  readonly kind: 'permission' | 'failed';
  constructor(kind: 'permission' | 'failed', detail: string) {
    super(`Posting the reply ${kind === 'permission' ? 'was refused: the account has not given permission to reply' : 'failed'}${kind === 'failed' ? `: ${detail.slice(0, 200)}` : ''}`);
    this.name = 'InboxWriteError';
    this.kind = kind;
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const list = (v: unknown): Json[] => (Array.isArray(v) ? (v as Json[]) : []);

/** The comments on one Instagram post, newest first (one page of 50: a post with more is read again next check, newest first). */
export async function instagramComments(mediaId: string, token: string, fetcher: Fetch = fetch): Promise<CommentsReading> {
  const params = new URLSearchParams({ fields: 'id,text,username,timestamp', limit: '50', access_token: token });
  const { body, refusal } = await graph(fetcher, 'Instagram comments', `${INSTAGRAM_GRAPH}/${mediaId}/comments?${params}`);
  if (refusal) return { comments: [], needs: refusal.permission ? 'reconnect' : null };
  return { needs: null, comments: list(body['data']).flatMap((c) => (str(c['id']) && str(c['timestamp']) ? [{ remoteId: str(c['id']), author: str(c['username']), text: str(c['text']), at: new Date(str(c['timestamp'])).toISOString() }] : [])) };
}

/** The top-level comments on one Facebook Page post, newest first. The Page's own comments are left out: they are our replies. */
export async function facebookComments(postId: string, pageId: string, token: string, fetcher: Fetch = fetch): Promise<CommentsReading> {
  const params = new URLSearchParams({ fields: 'id,message,from{id,name},created_time', filter: 'toplevel', order: 'reverse_chronological', limit: '50', access_token: token });
  const { body, refusal } = await graph(fetcher, 'Facebook comments', `${FACEBOOK_GRAPH}/${postId}/comments?${params}`);
  if (refusal) return { comments: [], needs: refusal.permission ? 'reconnect' : null };
  return {
    needs: null,
    comments: list(body['data']).flatMap((c) => {
      const from = (c['from'] ?? {}) as Json;
      return str(c['id']) && str(c['created_time']) && str(from['id']) !== pageId ? [{ remoteId: str(c['id']), author: str(from['name']), text: str(c['message']), at: new Date(str(c['created_time'])).toISOString() }] : [];
    }),
  };
}

async function post(fetcher: Fetch, url: string, form: Record<string, string>): Promise<Json> {
  const response = await fetcher(url, { method: 'POST', body: new URLSearchParams(form), signal: AbortSignal.timeout(30_000) });
  const body = (await response.json().catch(() => ({}))) as Json;
  if (response.ok && !body['error']) return body;
  const error = (body['error'] ?? {}) as Json;
  const code = typeof error['code'] === 'number' ? error['code'] : 0;
  const message = `${str(error['message'])}`.toLowerCase();
  const permission = code === 10 || (code >= 200 && code <= 299) || /permission|not authorized/.test(message);
  throw new InboxWriteError(permission ? 'permission' : 'failed', JSON.stringify(body['error'] ?? body));
}

/** Answers an Instagram comment. Returns the id of the reply. */
export async function instagramReply(commentId: string, token: string, message: string, fetcher: Fetch = fetch): Promise<string | null> {
  const body = await post(fetcher, `${INSTAGRAM_GRAPH}/${commentId}/replies`, { message, access_token: token });
  return str(body['id']) || null;
}

/** Answers a Facebook comment as the Page. Returns the id of the reply. */
export async function facebookReply(commentId: string, token: string, message: string, fetcher: Fetch = fetch): Promise<string | null> {
  const body = await post(fetcher, `${FACEBOOK_GRAPH}/${commentId}/comments`, { message, access_token: token });
  return str(body['id']) || null;
}

export type { Refusal };
