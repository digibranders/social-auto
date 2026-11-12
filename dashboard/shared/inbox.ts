/** What the publisher's /api/inbox answers, read strictly, so the page never shows something it did not understand. */

export type InboxPlatform = 'instagram' | 'facebook';
export type InboxStatus = 'todo' | 'done';

export interface InboxItem {
  id: string;
  channel: string;
  platform: InboxPlatform;
  author: string;
  text: string;
  at: string;
  post: { title: string; permalink: string | null };
  status: InboxStatus;
  assignee: string | null;
  notes: Array<{ by: string; text: string; at: string }>;
  replies: Array<{ by: string; text: string; at: string }>;
  read: boolean;
}

export interface InboxChannel {
  channel: string;
  platform: InboxPlatform;
  label: string;
  needs: boolean;
  checkedAt: string | null;
}

export interface InboxData {
  enabled: boolean;
  items: InboxItem[];
  counts: { todo: number; done: number; unread: number };
  channels: InboxChannel[];
  checkedAt: string | null;
}

const object = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
const platformOf = (v: unknown): InboxPlatform | null => (v === 'instagram' || v === 'facebook' ? v : null);
const person = (x: unknown): { by: string; text: string; at: string } | null => { const o = object(x); return typeof o['by'] === 'string' && typeof o['at'] === 'string' ? { by: o['by'], text: str(o['text']), at: o['at'] } : null; };

/** A part that cannot be read is left out so the rest still shows; only a wrong shape as a whole is refused. */
export function parseInbox(raw: unknown): InboxData {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('The inbox answer is not an object');
  const body = raw as Record<string, unknown>;
  const items = list(body['items']).flatMap((x): InboxItem[] => {
    const i = object(x);
    const platform = platformOf(i['platform']);
    if (!platform || typeof i['id'] !== 'string' || typeof i['channel'] !== 'string' || typeof i['at'] !== 'string') return [];
    const post = object(i['post']);
    return [{
      id: i['id'], channel: i['channel'], platform, author: str(i['author']), text: str(i['text']), at: i['at'],
      post: { title: str(post['title']), permalink: typeof post['permalink'] === 'string' ? post['permalink'] : null },
      status: i['status'] === 'done' ? 'done' : 'todo',
      assignee: typeof i['assignee'] === 'string' && i['assignee'] ? i['assignee'] : null,
      notes: list(i['notes']).flatMap((n) => { const r = person(n); return r ? [r] : []; }),
      replies: list(i['replies']).flatMap((n) => { const r = person(n); return r ? [r] : []; }),
      read: i['read'] === true,
    }];
  });
  const channels = list(body['channels']).flatMap((x): InboxChannel[] => {
    const c = object(x);
    const platform = platformOf(c['platform']);
    return platform && typeof c['channel'] === 'string' ? [{ channel: c['channel'], platform, label: str(c['label']), needs: c['needs'] === 'reconnect', checkedAt: typeof c['checkedAt'] === 'string' ? c['checkedAt'] : null }] : [];
  });
  const counts = object(body['counts']);
  return { enabled: body['enabled'] === true, items, counts: { todo: num(counts['todo']), done: num(counts['done']), unread: num(counts['unread']) }, channels, checkedAt: typeof body['checkedAt'] === 'string' ? body['checkedAt'] : null };
}
