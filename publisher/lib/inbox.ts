/**
 * The inbox: comments that people leave on what we published, kept so a person can answer them.
 *
 * What is kept about other people is only what is needed to answer (their name, their words, when, on which post). It is dropped after RETENTION_DAYS
 * and as soon as the account or the client it belongs to goes away. The words are never written to a log.
 */
import { EditError } from './overrides.js';

export type InboxPlatform = 'instagram' | 'facebook';
export const INBOX_PLATFORMS: readonly InboxPlatform[] = ['instagram', 'facebook'];
export type InboxStatus = 'todo' | 'done';

export const RETENTION_DAYS = 90;
export const MAX_TEXT = 2000;
export const MAX_REPLY = 2000;
export const MAX_NOTE = 1000;
/** The most items kept for one brand, so a viral post cannot fill the file. */
export const MAX_ITEMS_PER_BRAND = 2000;
const DAY_MS = 86_400_000;

export interface InboxReply {
  /** The id the network gave the reply, so it can be found again. */
  remoteId: string | null;
  by: string;
  text: string;
  at: string;
}

export interface InboxNote {
  by: string;
  text: string;
  at: string;
}

export interface InboxItem {
  /** "<channel id>|<comment id on the network>" */
  id: string;
  brand: string;
  channel: string;
  platform: InboxPlatform;
  remoteId: string;
  author: string;
  text: string;
  /** When it was written, ISO. */
  at: string;
  firstSeenAt: string;
  post: { id: string; title: string; permalink: string | null };
  status: InboxStatus;
  assignee: string | null;
  notes: InboxNote[];
  replies: InboxReply[];
  /** Whether someone has opened it; false until they do. */
  read: boolean;
}

export interface ChannelInbox {
  /** The account must be connected again to give the permission to read or answer comments. */
  needs?: 'reconnect';
  checkedAt: string;
}

export interface InboxFile {
  items: Record<string, InboxItem>;
  channels: Record<string, ChannelInbox>;
  /** When each post's comments were last read, by posted-log key, so older posts are read less often. */
  postsChecked: Record<string, string>;
  checkedAt: string | null;
}

export const EMPTY_INBOX: InboxFile = { items: {}, channels: {}, postsChecked: {}, checkedAt: null };

const isIso = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const isPlatform = (v: unknown): v is InboxPlatform => (INBOX_PLATFORMS as readonly unknown[]).includes(v);
const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');

/** Reads the saved file. A malformed entry is an error: it is our own file, so a bad one means a bug. */
export function parseInbox(raw: unknown): InboxFile {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('inbox must be an object');
  const file = raw as Record<string, unknown>;
  const items: Record<string, InboxItem> = {};
  for (const [id, value] of Object.entries((file['items'] ?? {}) as Record<string, unknown>)) {
    const i = value as Record<string, unknown>;
    const post = (i?.['post'] ?? {}) as Record<string, unknown>;
    if (typeof i !== 'object' || i === null || typeof i['brand'] !== 'string' || typeof i['channel'] !== 'string' || !isPlatform(i['platform']) || typeof i['remoteId'] !== 'string' || !isIso(i['at']) || !isIso(i['firstSeenAt'])) {
      throw new Error(`inbox.items["${id}"] is malformed`);
    }
    const list = <T>(v: unknown, keep: (x: Record<string, unknown>) => T | null): T[] => (Array.isArray(v) ? v.flatMap((x) => { const r = keep(x as Record<string, unknown>); return r === null ? [] : [r]; }) : []);
    items[id] = {
      id,
      brand: i['brand'],
      channel: i['channel'],
      platform: i['platform'],
      remoteId: i['remoteId'],
      author: text(i['author'], 120),
      text: text(i['text'], MAX_TEXT),
      at: i['at'],
      firstSeenAt: i['firstSeenAt'],
      post: { id: text(post['id'], 200), title: text(post['title'], 200), permalink: typeof post['permalink'] === 'string' ? post['permalink'] : null },
      status: i['status'] === 'done' ? 'done' : 'todo',
      assignee: typeof i['assignee'] === 'string' && i['assignee'] ? i['assignee'].slice(0, 80) : null,
      notes: list(i['notes'], (n) => (typeof n['by'] === 'string' && isIso(n['at']) ? { by: n['by'].slice(0, 80), text: text(n['text'], MAX_NOTE), at: n['at'] } : null)),
      replies: list(i['replies'], (r) => (typeof r['by'] === 'string' && isIso(r['at']) ? { remoteId: typeof r['remoteId'] === 'string' ? r['remoteId'] : null, by: r['by'].slice(0, 80), text: text(r['text'], MAX_REPLY), at: r['at'] } : null)),
      read: i['read'] === true,
    };
  }
  const channels: Record<string, ChannelInbox> = {};
  for (const [id, value] of Object.entries((file['channels'] ?? {}) as Record<string, unknown>)) {
    const c = value as Record<string, unknown>;
    if (typeof c !== 'object' || c === null || !isIso(c['checkedAt'])) throw new Error(`inbox.channels["${id}"] is malformed`);
    channels[id] = { ...(c['needs'] === 'reconnect' ? { needs: 'reconnect' as const } : {}), checkedAt: c['checkedAt'] };
  }
  const postsChecked = Object.fromEntries(Object.entries((file['postsChecked'] ?? {}) as Record<string, unknown>).filter(([, v]) => isIso(v))) as Record<string, string>;
  return { items, channels, postsChecked, checkedAt: isIso(file['checkedAt']) ? file['checkedAt'] : null };
}

/** A comment as a network gave it, before we know anything else about it. */
export interface IncomingComment {
  remoteId: string;
  author: string;
  text: string;
  at: string;
}

/**
 * Adds the comments a check found. A comment already known keeps its status, assignee, notes and replies and only has its words refreshed (they can be edited
 * on the network); a new one starts as "to answer". Nothing older than the retention limit is added.
 */
export function addComments(file: InboxFile, source: { brand: string; channel: string; platform: InboxPlatform; post: InboxItem['post'] }, comments: readonly IncomingComment[], now: number): InboxFile {
  const items = { ...file.items };
  const oldest = now - RETENTION_DAYS * DAY_MS;
  for (const c of comments) {
    if (!c.remoteId || !isIso(c.at) || Date.parse(c.at) < oldest) continue;
    const id = `${source.channel}|${c.remoteId}`;
    const before = items[id];
    items[id] = before
      ? { ...before, text: c.text.slice(0, MAX_TEXT), author: c.author.slice(0, 120) || before.author }
      : { id, brand: source.brand, channel: source.channel, platform: source.platform, remoteId: c.remoteId, author: c.author.slice(0, 120), text: c.text.slice(0, MAX_TEXT), at: c.at, firstSeenAt: new Date(now).toISOString(), post: source.post, status: 'todo', assignee: null, notes: [], replies: [], read: false };
  }
  return { ...file, items: capPerBrand(items) };
}

/** Keeps the newest MAX_ITEMS_PER_BRAND items of each brand, dropping done ones first. */
function capPerBrand(items: Record<string, InboxItem>): Record<string, InboxItem> {
  const byBrand = new Map<string, InboxItem[]>();
  for (const i of Object.values(items)) byBrand.set(i.brand, [...(byBrand.get(i.brand) ?? []), i]);
  const keep: Record<string, InboxItem> = {};
  for (const list of byBrand.values()) {
    const ranked = [...list].sort((a, b) => Number(a.status === 'done') - Number(b.status === 'done') || b.at.localeCompare(a.at)).slice(0, MAX_ITEMS_PER_BRAND);
    for (const i of ranked) keep[i.id] = i;
  }
  return keep;
}

/** Drops what is past the retention limit, comments of accounts no longer connected, and the check marks of posts that went with them. */
export function tidy(file: InboxFile, channelIds: ReadonlySet<string>, now: number): InboxFile {
  const oldest = now - RETENTION_DAYS * DAY_MS;
  const items = Object.fromEntries(Object.entries(file.items).filter(([, i]) => channelIds.has(i.channel) && Date.parse(i.at) >= oldest));
  const channels = Object.fromEntries(Object.entries(file.channels).filter(([id]) => channelIds.has(id)));
  const postsChecked = Object.fromEntries(Object.entries(file.postsChecked).filter(([key]) => channelIds.has(key.slice(key.lastIndexOf('|') + 1))));
  return { ...file, items, channels, postsChecked };
}

/** Forgets everything kept for a brand (a customer who left, or a workspace that was removed). */
export function forgetBrand(file: InboxFile, brand: string): InboxFile {
  return { ...file, items: Object.fromEntries(Object.entries(file.items).filter(([, i]) => i.brand !== brand)) };
}

export function markChannel(file: InboxFile, channel: string, needs: 'reconnect' | null, now: number): InboxFile {
  return { ...file, channels: { ...file.channels, [channel]: { ...(needs ? { needs } : {}), checkedAt: new Date(now).toISOString() } } };
}

// ---- what a person does with an item --------------------------------------------------------------------------------------------------------

export type InboxAction =
  | { action: 'done' }
  | { action: 'reopen' }
  | { action: 'read' }
  | { action: 'assign'; assignee: string | null }
  | { action: 'note'; by: string; text: string }
  | { action: 'replied'; by: string; text: string; remoteId: string | null };

const person = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !v.trim() || v.length > 80) throw new EditError(`${what} must be a short name`);
  return v.trim();
};

/** Applies one action to one item and returns the new file. An unknown item is a 404, a bad value a 400. */
export function act(file: InboxFile, id: string, a: InboxAction, now: number): InboxFile {
  const item = file.items[id];
  if (!item) throw new EditError('no such message', 404);
  const at = new Date(now).toISOString();
  let next: InboxItem;
  switch (a.action) {
    case 'done': next = { ...item, status: 'done' }; break;
    case 'reopen': next = { ...item, status: 'todo' }; break;
    case 'read': next = { ...item, read: true }; break;
    case 'assign': next = { ...item, assignee: a.assignee === null ? null : person(a.assignee, 'assignee') }; break;
    case 'note': {
      const body = typeof a.text === 'string' ? a.text.trim() : '';
      if (!body || body.length > MAX_NOTE) throw new EditError(`write a note of up to ${MAX_NOTE} characters`);
      next = { ...item, notes: [...item.notes, { by: person(a.by, 'who'), text: body, at }] };
      break;
    }
    case 'replied': {
      const body = a.text.trim();
      next = { ...item, status: 'done', read: true, replies: [...item.replies, { remoteId: a.remoteId, by: person(a.by, 'who'), text: body, at }] };
      break;
    }
  }
  return { ...file, items: { ...file.items, [id]: next } };
}

/** The words of a reply, checked before anything is sent to a network. */
export function validReply(value: unknown): string {
  const body = typeof value === 'string' ? value.trim() : '';
  if (!body) throw new EditError('write a reply first');
  if (body.length > MAX_REPLY) throw new EditError(`a reply can be at most ${MAX_REPLY} characters`);
  return body;
}

// ---- reading --------------------------------------------------------------------------------------------------------------------------------

export interface InboxQuery {
  brand: string;
  status?: InboxStatus | 'all';
  channel?: string;
  platform?: InboxPlatform;
  /** "me:<name>" is not understood here: the caller passes a name. */
  assignee?: string | 'none';
  after?: string;
  limit?: number;
}

export interface InboxView {
  items: InboxItem[];
  counts: { todo: number; done: number; unread: number };
  /** Every account connected for the brand that can have comments, with whether it was checked and whether it must be connected again. */
  channels: Array<{ channel: string; platform: InboxPlatform; label: string; needs?: 'reconnect'; checkedAt: string | null }>;
  checkedAt: string | null;
}

/** One brand's items, newest first, with the counts the filters show. */
export function viewInbox(file: InboxFile, q: InboxQuery, connected: ReadonlyArray<{ id: string; platform: string; label: string }> = []): InboxView {
  const mine = Object.values(file.items).filter((i) => i.brand === q.brand);
  const matches = (i: InboxItem): boolean =>
    (q.status === undefined || q.status === 'all' || i.status === q.status) &&
    (q.channel === undefined || i.channel === q.channel) &&
    (q.platform === undefined || i.platform === q.platform) &&
    (q.assignee === undefined || (q.assignee === 'none' ? i.assignee === null : i.assignee === q.assignee)) &&
    (q.after === undefined || i.at > q.after);
  const items = mine.filter(matches).sort((a, b) => b.at.localeCompare(a.at)).slice(0, q.limit ?? 100);
  return {
    items,
    counts: { todo: mine.filter((i) => i.status === 'todo').length, done: mine.filter((i) => i.status === 'done').length, unread: mine.filter((i) => !i.read).length },
    channels: connected.flatMap((c) => (isPlatform(c.platform) ? [{ channel: c.id, platform: c.platform, label: c.label, ...(file.channels[c.id]?.needs ? { needs: file.channels[c.id]?.needs as 'reconnect' } : {}), checkedAt: file.channels[c.id]?.checkedAt ?? null }] : [])),
    checkedAt: file.checkedAt,
  };
}
