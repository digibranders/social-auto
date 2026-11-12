/** The Inbox page: comments on a client's Instagram and Facebook posts, to answer, close, hand to someone or note. */
import type { InboxData, InboxItem, InboxPlatform } from '../shared/inbox.ts';
import { brandMark, button, h, icon } from './ui.ts';

export interface InboxClient {
  brand: string;
  label: string;
}

export interface InboxContext {
  /** Clients that have an Instagram or Facebook account, for the picker. */
  clients: InboxClient[];
  brand: string | null;
  go(brand: string): void;
  load(brand: string): Promise<InboxData>;
  /** Does something to a message; resolves to an explanation when it could not be done. */
  act(command: { id: string; action: 'reply' | 'done' | 'reopen' | 'read' | 'assign' | 'note'; text?: string; assignee?: string | null }): Promise<string | null>;
  /** Re-draws the whole page (the screen asks again for its data). */
  refresh(): void;
}

const NAMES: Record<InboxPlatform, string> = { instagram: 'Instagram', facebook: 'Facebook' };
const SAVED: ReadonlyArray<[string, string]> = [
  ['Thanks for the kind words', 'Thank you so much, we are glad you liked it. Come visit us again soon!'],
  ['Opening hours', 'We are open every day. See you soon!'],
  ['Sorry about this', 'We are sorry about this and want to put it right. Please message us your order number and we will sort it out today.'],
];

type Status = 'todo' | 'done' | 'all';
interface View {
  status: Status;
  channel: string;
  who: 'all' | 'me' | 'none';
  selected: string | null;
  query: string;
  mode: 'reply' | 'note';
  draft: string;
  data: InboxData | null;
  error: string | null;
  busy: boolean;
  loadedFor: string | null;
  /** A short line saying what just happened, shown for a few seconds. */
  notice: string | null;
}
const view: View = { status: 'todo', channel: 'all', who: 'all', selected: null, query: '', mode: 'reply', draft: '', data: null, error: null, busy: false, loadedFor: null, notice: null };

/** Who is using the dashboard: the name is asked once and kept in this browser, so the team sees who answered or noted. */
export function myName(): string | null {
  try {
    return localStorage.getItem('inbox-name');
  } catch {
    return null;
  }
}
function askName(): string | null {
  const known = myName();
  if (known) return known;
  const given = window.prompt('Your first name, so your team sees who answered or wrote a note:')?.trim().slice(0, 40);
  if (!given) return null;
  try {
    localStorage.setItem('inbox-name', given);
  } catch {
    /* kept for this visit only */
  }
  return given;
}

function ago(iso: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'Yesterday' : `${days} days`;
}

const initials = (name: string): string => name.split(/\s+/).map((p) => p[0] ?? '').join('').slice(0, 2).toUpperCase() || '?';
const avatar = (name: string): HTMLElement => h('span', { class: 'avatar' }, h('span', { class: 'avatar-letter' }, initials(name)));

function matches(i: InboxItem, mine: string | null): boolean {
  return (view.status === 'all' || i.status === view.status) &&
    (view.channel === 'all' || i.channel === view.channel) &&
    (view.who === 'all' || (view.who === 'me' ? mine !== null && i.assignee === mine : i.assignee === null)) &&
    (!view.query || `${i.author} ${i.text}`.toLowerCase().includes(view.query.toLowerCase()));
}

export function inboxPage(ctx: InboxContext): HTMLElement {
  const root = h('div', { class: 'cost-page' });
  const mine = myName();

  const pick = h('select', { 'aria-label': 'Client', class: 'month-pick' }, h('option', { value: '' }, ctx.clients.length === 0 ? 'No client has Instagram or Facebook' : 'Choose a client'), ...ctx.clients.map((c) => h('option', { value: c.brand }, c.label)));
  pick.value = ctx.brand ?? '';
  pick.addEventListener('change', () => { if (pick.value) ctx.go(pick.value); });

  const draw = (): void => {
    const top = h('div', { class: 'inbox-top' }, pick, view.notice ? h('span', { class: 'pill state-published', role: 'status' }, view.notice) : null, view.data ? h('span', { class: 'muted' }, view.data.checkedAt ? `Checked for new comments ${ago(view.data.checkedAt)} ago, then every 15 minutes` : 'Comments are checked every 15 minutes') : null);
    if (!ctx.brand) return void root.replaceChildren(top, h('p', { class: 'empty' }, 'Choose a client to see the comments on its Instagram and Facebook posts.'));
    if (view.error !== null) return void root.replaceChildren(top, h('p', { class: 'banner banner-warn', role: 'alert' }, view.error), button('Try again', 'btn', () => void load()));
    const data = view.data;
    if (data === null) return void root.replaceChildren(top, h('p', { class: 'muted' }, 'Loading the comments…'));
    if (!data.enabled) return void root.replaceChildren(top, h('div', { class: 'panel-card' }, h('p', { class: 'empty' }, 'The inbox is switched off on the server.')));

    const needs = data.channels.filter((c) => c.needs);
    const banners = needs.map((c) => h('p', { class: 'banner banner-warn', role: 'status' }, `${NAMES[c.platform]} (${c.label}): connect this account again to give permission to read and answer comments. It takes a minute and scheduled posts are not affected.`));
    const pool = data.items;
    const count = (f: (i: InboxItem) => boolean): number => pool.filter(f).length;
    const chip = (label: string, on: boolean, fn: () => void, n?: number, mark?: SVGSVGElement): HTMLElement => button([mark ?? null, label, n === undefined ? null : h('span', { class: 'n' }, String(n))], `chip${on ? ' chip-on' : ''}`, fn);
    const filters = h('div', { class: 'inbox-filters' },
      chip('Needs an answer', view.status === 'todo', () => { view.status = 'todo'; draw(); }, count((i) => i.status === 'todo')),
      chip('Done', view.status === 'done', () => { view.status = 'done'; draw(); }, count((i) => i.status === 'done')),
      chip('Everything', view.status === 'all', () => { view.status = 'all'; draw(); }, pool.length),
      h('span', { class: 'sep' }),
      chip('All channels', view.channel === 'all', () => { view.channel = 'all'; draw(); }),
      ...data.channels.map((c) => chip(`${NAMES[c.platform]} ${c.label}`, view.channel === c.channel, () => { view.channel = c.channel; draw(); }, count((i) => i.channel === c.channel), brandMark(c.platform))),
      h('span', { class: 'sep' }),
      chip('Everyone', view.who === 'all', () => { view.who = 'all'; draw(); }),
      ...(mine ? [chip('Assigned to me', view.who === 'me', () => { view.who = 'me'; draw(); })] : []),
      chip('Not assigned', view.who === 'none', () => { view.who = 'none'; draw(); }));

    const visible = pool.filter((i) => matches(i, mine));
    const selected = pool.find((i) => i.id === view.selected) ?? null;

    const search = h('input', { placeholder: 'Search comments', 'aria-label': 'Search', value: view.query });
    search.addEventListener('input', () => { view.query = search.value; const at = search.selectionStart ?? view.query.length; draw(); const again = root.querySelector<HTMLInputElement>('.in-search input'); again?.focus(); again?.setSelectionRange(at, at); });
    const rows = visible.length === 0
      ? [h('p', { class: 'in-skeleton' }, data.channels.length === 0 ? 'This client has no Instagram or Facebook account connected.' : pool.length === 0 ? 'No comments yet. New ones appear here within about 15 minutes of being posted.' : 'Nothing matches these filters.')]
      : visible.map((i) => {
        const row = h('button', { type: 'button', class: `in-item${i.read ? '' : ' unread'}${i.id === view.selected ? ' on' : ''}` },
          avatar(i.author),
          h('span', { style: 'min-width:0;display:grid;gap:1px' }, h('span', { class: 'in-who' }, brandMark(i.platform), i.author || 'Someone'), h('span', { class: 'in-snip' }, i.text), h('span', { class: 'in-post' }, i.post.title || 'A post')),
          h('span', { class: 'in-side' }, ago(i.at), h('span', { class: `pill ${i.status === 'todo' ? 'state-due' : 'state-published'}` }, i.status === 'todo' ? 'To answer' : 'Done')));
        row.addEventListener('click', () => { view.selected = i.id; view.draft = ''; if (!i.read) { i.read = true; void ctx.act({ id: i.id, action: 'read' }); } draw(); });
        return row;
      });

    const thread = selected ? threadCard(selected) : h('div', { class: 'panel-card thread' }, h('p', { class: 'in-skeleton' }, 'Pick a message to see it and answer it.'));
    root.replaceChildren(top, ...banners, filters, h('div', { class: 'inbox-grid' }, h('div', { class: 'panel-card inbox-list' }, h('div', { class: 'in-search' }, search), ...rows), thread));
  };

  const run = async (command: Parameters<InboxContext['act']>[0], done: string): Promise<void> => {
    if (view.busy) return;
    view.busy = true;
    const problem = await ctx.act(command);
    view.busy = false;
    if (problem) window.alert(problem);
    else { view.draft = ''; view.notice = done; window.setTimeout(() => { view.notice = null; draw(); }, 3000); await load(); }
    draw();
  };

  const threadCard = (i: InboxItem): HTMLElement => {
    const names = [...new Set(ctx.brand ? (view.data?.items ?? []).flatMap((x) => (x.assignee ? [x.assignee] : [])) : [])];
    const me = myName();
    const options = [...new Set([...(me ? [me] : []), ...names])];
    const assign = h('select', { 'aria-label': 'Assign to' }, h('option', { value: '' }, 'Not assigned'), ...options.map((n) => { const o = h('option', { value: n }, n === me ? `${n} (you)` : n); if (i.assignee === n) o.selected = true; return o; }), h('option', { value: '__new' }, 'Someone else…'));
    assign.addEventListener('change', () => {
      let who: string | null = assign.value || null;
      if (assign.value === '__new') { who = window.prompt('Name of the person:')?.trim().slice(0, 40) || null; if (!who) { draw(); return; } }
      void run({ id: i.id, action: 'assign', assignee: who }, 'Assigned');
    });
    const text = h('textarea', { placeholder: view.mode === 'reply' ? 'Write a public reply' : 'Only your team sees this note', 'aria-label': 'Message' });
    text.value = view.draft;
    text.addEventListener('input', () => { view.draft = text.value; });
    const menu = h('div', { class: 'menu', hidden: '' }, ...SAVED.map(([title, body]) => { const b = h('button', { type: 'button' }, title, h('small', {}, body.slice(0, 60))); b.addEventListener('click', () => { view.draft = body; text.value = body; menu.hidden = true; text.focus(); }); return b; }));
    const send = button(view.mode === 'reply' ? 'Post reply' : 'Save note', 'btn btn-primary', () => {
      const body = text.value.trim();
      if (!body) { window.alert('Write something first.'); return; }
      const who = askName();
      if (!who) return;
      if (view.mode === 'reply' && !window.confirm(`This posts your reply publicly on ${NAMES[i.platform]} now. Post it?`)) return;
      void run({ id: i.id, action: view.mode === 'reply' ? 'reply' : 'note', text: body }, view.mode === 'reply' ? 'Reply posted' : 'Note saved');
    });
    const tabs = h('div', { class: 'ctabs', role: 'tablist' },
      button('Reply publicly', `ctab${view.mode === 'reply' ? ' ctab-on' : ''}`, () => { view.mode = 'reply'; draw(); }),
      button('Internal note', `ctab${view.mode === 'note' ? ' ctab-on' : ''}`, () => { view.mode = 'note'; draw(); }));
    return h('div', { class: 'panel-card thread' },
      h('div', { class: 'th-head' }, avatar(i.author), h('div', {}, h('h2', {}, i.author || 'Someone'), h('span', { class: 'muted' }, `${NAMES[i.platform]}, ${ago(i.at)} ago`)),
        h('div', { class: 'acts' }, assign, button(i.status === 'done' ? 'Reopen' : 'Mark as done', i.status === 'done' ? 'btn' : 'btn btn-primary', () => void run({ id: i.id, action: i.status === 'done' ? 'reopen' : 'done' }, i.status === 'done' ? 'Reopened' : 'Marked as done')))),
      h('div', { class: 'th-body' },
        h('div', { class: 'on-post' }, h('div', { class: 'pic' }, 'Post'), h('div', {}, h('span', { class: 'muted' }, 'On your post'), h('div', {}, i.post.permalink && /^https?:\/\//.test(i.post.permalink) ? h('a', { href: i.post.permalink, target: '_blank', rel: 'noopener noreferrer' }, i.post.title || 'Open the post') : (i.post.title || 'A post')))),
        h('div', { class: 'msg' }, avatar(i.author), h('div', { class: 'bubble' }, h('div', { class: 'by' }, i.author || 'Someone', h('span', {}, `${ago(i.at)} ago`)), h('p', {}, i.text))),
        ...i.replies.map((r) => h('div', { class: 'msg mine' }, avatar('You'), h('div', { class: 'bubble' }, h('div', { class: 'by' }, r.by, h('span', {}, `${ago(r.at)} ago`)), h('p', {}, r.text)))),
        ...i.notes.map((n) => h('div', { class: 'note' }, h('b', {}, `Note from ${n.by}: `), n.text))),
      h('div', { class: `composer${view.mode === 'note' ? ' note-mode' : ''}` }, tabs, text,
        h('div', { class: 'c-row' }, view.mode === 'reply' ? h('span', { class: 'menu-wrap' }, button('Saved replies', 'btn', () => { menu.hidden = !menu.hidden; }), menu) : null,
          h('span', { class: 'muted' }, view.mode === 'reply' ? `Posted on ${NAMES[i.platform]} as the account.` : 'Not visible to the customer.'), h('span', { class: 'sp' }), send)));
  };

  const load = async (): Promise<void> => {
    if (!ctx.brand) return;
    view.error = null;
    try {
      view.data = await ctx.load(ctx.brand);
      view.loadedFor = ctx.brand;
      if (view.selected && !view.data.items.some((i) => i.id === view.selected)) view.selected = null;
    } catch (error) {
      view.error = error instanceof Error ? error.message : 'The comments could not be loaded.';
    }
    draw();
  };

  if (view.loadedFor !== ctx.brand) { view.data = null; view.selected = null; view.channel = 'all'; }
  draw();
  void load();
  return root;
}

export const inboxIcon = (): SVGSVGElement => {
  const svg = icon('folder');
  svg.replaceChildren();
  for (const d of ['M22 12h-6l-2 3h-4l-2-3H2', 'M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z']) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
};
